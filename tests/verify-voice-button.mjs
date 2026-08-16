import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

// ── 1. 客户端插件注册 mock ──
const CLIENT = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-voice/lib/client.js'
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => { loaded = factory.call(null, (name) => name === 'react' ? { useState: (v) => [v, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, createElement: (t, p, ...c) => ({ type: t, props: p, children: c }) } : (() => { throw new Error('unexpected require ' + name) })()) },
  },
}
await import('file:///' + CLIENT.replace(/\\/g, '/') + '?v=' + Date.now())
check('voice client loaded', loaded !== null && typeof loaded.apply === 'function')

const sent = []
const drafts = []
const registrations = []
const scope = {
  locale: { bind: (ns) => (key) => ns + ':' + key },
  slots: {
    inject: (slot, fn) => { const entry = { slot }; registrations.push(entry); fn() },
    register: (meta, Component) => { registrations[registrations.length - 1].meta = meta; registrations[registrations.length - 1].Component = Component },
  },
  sessions: { scope: (id) => ({ get: (name) => name === 'conversation' ? {
    send: (text) => { sent.push(text); return Promise.resolve() },
    input: {
      for: (actx) => ({
        actions: { setDraft: (text) => { drafts.push(text) } },
        get snapshot() { return { draft: drafts.length ? drafts[drafts.length - 1] : '' } },
      }),
    },
  } : undefined }) },
  conversation: {},
}
const ctx = { effect: (fn) => { try { fn() } catch {} }, locale: scope.locale, inject: (deps, cb) => cb(scope) }
loaded.apply(ctx)
check('registered into conversation.input.right', registrations.length === 1 && registrations[0].slot === 'conversation.input.right')
const reg = registrations[0]
check('block id roycode-voice', reg.meta.id === 'roycode-voice')
const injected = reg.meta.inject('session-1')
const injected2 = reg.meta.inject('session-1')
injected2.setDraft('你好，这是语音转写')
check('setDraft fills input draft (not direct send)', drafts.length === 1 && drafts[0] === '你好，这是语音转写' && sent.length === 0)
check('currentDraft reads back', injected2.currentDraft() === '你好，这是语音转写')
const node = reg.Component({ setDraft: injected2.setDraft, currentDraft: injected2.currentDraft, t: (k) => k })
check('button renders', node?.type === 'div' && node?.children?.[0]?.props?.['aria-label'] === 'mic')

// ── 2. 宿主 /voice/transcribe 端点（独立端口 8790）──
const dir = mkdtempSync(path.join(tmpdir(), 'vt-'))
const patch = path.join(dir, 'cordis.patch.yml')
writeFileSync(patch, '[]\n', 'utf8')
const fixture = path.join(dir, 'host-fixture.mjs')
writeFileSync(fixture, "import { pathToFileURL } from 'node:url'\n// argv: [2]=triggers lib path, [3]=port, [4]=patchPath\nconst mod = await import(pathToFileURL(process.argv[2]).href)\nconst ctx = { agents: { roots: () => [], get: () => undefined }, effect: (fn) => { fn(); return () => {} } }\nmod.apply(ctx, { port: Number(process.argv[3]), host: '127.0.0.1', token: '', target: 'latest', patchPath: process.argv[4] })\nconsole.log('HOST_READY')\nsetTimeout(() => {}, 60000)", 'utf8')
const lib = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-triggers/lib/index.js'
const host = spawn(process.execPath, [fixture, lib, '8790', patch], { stdio: ['ignore', 'pipe', 'pipe'] })
let hostErr = ''
host.stderr.on('data', (d) => { hostErr += d })

// 等待 HOST_READY
let ready = false
await new Promise((resolve) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    if (hostErr.includes('Error') || hostErr.includes('throw')) { clearInterval(iv); resolve() }
    else if (Date.now() - t0 > 8000) { clearInterval(iv); resolve() }
  }, 150)
})

// 生成 1 秒正弦波 wav 作为'音频输入'
const wav = path.join(dir, 'tone.wav')
await new Promise((resolve, reject) => {
  const c = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', wav])
  c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code))))
  c.on('error', reject)
})

let transcribeOk = false, badRejected = false, shapeOk = false
try {
  const body = readFileSync(wav)
  const res = await fetch('http://127.0.0.1:8790/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body })
  const data = await res.json()
  transcribeOk = res.status === 200 && data.ok === true
  shapeOk = typeof data.transcript === 'string' && Array.isArray(data.segments)
  console.log('  transcribe response:', JSON.stringify(data).slice(0, 160))
} catch (e) { console.log('  transcribe fetch error:', e.message) }
check('voice/transcribe 200 ok', transcribeOk)
check('transcript shape present', shapeOk)

try {
  const bad = await fetch('http://127.0.0.1:8790/voice/transcribe', { method: 'POST', body: Buffer.from('not audio') })
  const bj = await bad.json()
  badRejected = bad.status === 500 && bj.ok === false
} catch (e) { console.log('  bad-audio error:', e.message) }
check('bad audio rejected with error', badRejected)

host.kill()
if (hostErr.trim()) console.log('  host stderr:', hostErr.slice(0, 300))
rmSync(dir, { recursive: true, force: true })

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
