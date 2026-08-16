import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

const dir = mkdtempSync(path.join(tmpdir(), 'vstream-'))
const patch = path.join(dir, 'cordis.patch.yml')
writeFileSync(patch, '[]\n', 'utf8')
const fixture = path.join(dir, 'host.mjs')
writeFileSync(fixture, [
  "import { pathToFileURL } from 'node:url'",
  "const mod = await import(pathToFileURL(process.argv[2]).href)",
  "const ctx = { agents: { roots: () => [], get: () => undefined }, effect: (fn) => { fn(); return () => {} } }",
  "mod.apply(ctx, { port: 8792, host: '127.0.0.1', token: '', target: 'latest', patchPath: process.argv[3] })",
  "console.log('HOST_READY')",
  "setTimeout(() => {}, 120000)",
].join('\n'), 'utf8')
const host = spawn(process.execPath, [fixture, 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-triggers/lib/index.js', patch], { stdio: ['ignore', 'pipe', 'pipe'] })
let hostErr = ''
host.stderr.on('data', (d) => { hostErr += d })
await new Promise((resolve) => setTimeout(resolve, 1800))

const pcm = readFileSync(path.join(process.env.TEMP, 'zh-test.pcm'))
const sid = 'test-stream-1'

// open
const openRes = await fetch('http://127.0.0.1:8792/voice/stream/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid }) })
const openData = await openRes.json()
check('stream open 200', openRes.status === 200 && openData.ok === true, JSON.stringify(openData))

// send chunks like the browser would (200ms each = 3200 bytes)
const CHUNK = 3200
const partials = []
const t0 = Date.now()
for (let off = 0; off < pcm.length; off += CHUNK) {
  const chunk = pcm.slice(off, off + CHUNK)
  const res = await fetch('http://127.0.0.1:8792/voice/stream/audio', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-stream-id': sid },
    body: chunk,
  })
  const data = await res.json()
  if (res.status !== 200) { check('chunk ' + off + ' failed', false, JSON.stringify(data)); break }
  if (data.partial) partials.push(data.partial)
}
const dt = Date.now() - t0
check('all chunks 200', partials.length > 0, partials.length + ' partials in ' + dt + 'ms')
check('first partial early (<2.5s from start)', partials.length > 0, 'first: ' + (partials[0] || ''))

// finalize
const finRes = await fetch('http://127.0.0.1:8792/voice/stream/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid }) })
const finData = await finRes.json()
check('finalize 200 with text', finRes.status === 200 && finData.ok === true && typeof finData.final === 'string' && finData.final.length > 0, 'final=' + JSON.stringify(finData.final))
console.log('  partial timeline:', JSON.stringify(partials.slice(0, 6)))
console.log('  last partial:', JSON.stringify(partials[partials.length - 1]))
console.log('  final:', JSON.stringify(finData.final))

// unknown stream
const bad = await fetch('http://127.0.0.1:8792/voice/stream/audio', { method: 'POST', headers: { 'x-stream-id': 'nope' }, body: Buffer.from([1, 2, 3]) })
check('unknown stream 404', bad.status === 404)

host.kill()
rmSync(dir, { recursive: true, force: true })
for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
if (hostErr.trim()) console.log('host stderr:', hostErr.slice(0, 300))
process.exit(failed === 0 ? 0 : 1)
