import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(path.join(tmpdir(), 'vt3-'))
const patch = path.join(dir, 'cordis.patch.yml')
writeFileSync(patch, '[]\n', 'utf8')
const fixture = path.join(dir, 'host.mjs')
writeFileSync(fixture, [
  "import { pathToFileURL } from 'node:url'",
  "const mod = await import(pathToFileURL(process.argv[2]).href)",
  "const ctx = { agents: { roots: () => [], get: () => undefined }, effect: (fn) => { fn(); return () => {} } }",
  "mod.apply(ctx, { port: 8791, host: '127.0.0.1', token: '', target: 'latest', patchPath: process.argv[3] })",
  "console.log('HOST_READY')",
  "setTimeout(() => {}, 120000)",
].join('\n'), 'utf8')
const host = spawn(process.execPath, [fixture, 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-triggers/lib/index.js', patch], { stdio: ['ignore', 'pipe', 'pipe'] })
let hostErr = ''
host.stderr.on('data', (d) => { hostErr += d })
await new Promise((resolve) => setTimeout(resolve, 1500))

const wav = path.join(process.env.TEMP, 'zh-test.wav')
const { readFileSync } = await import('node:fs')
const body = readFileSync(wav)

const times = []
for (let i = 0; i < 3; i++) {
  const t0 = Date.now()
  const res = await fetch('http://127.0.0.1:8791/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body })
  const data = await res.json()
  times.push(Date.now() - t0)
  console.log('req' + (i + 1) + ': ' + (Date.now() - t0) + 'ms ok=' + data.ok + (data.ok ? ' transcript=' + JSON.stringify(data.transcript) : ' err=' + data.error))
}
host.kill()
rmSync(dir, { recursive: true, force: true })
console.log('times:', times.join(', '))
const ok = times[2] < 4000
console.log(ok ? 'PASS: warm requests fast' : 'FAIL: warm requests slow')
if (hostErr.trim()) console.log('host stderr:', hostErr.slice(0, 300))
process.exit(ok ? 0 : 1)
