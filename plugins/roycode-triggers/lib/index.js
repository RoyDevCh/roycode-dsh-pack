// roycode-triggers v0.3 — inbound webhooks + plugin toggles + voice transcription.
// POST /trigger {message, session?}       -> agent.followup (wakes a later turn)
// GET  /health                            -> liveness
// GET  /plugins/disabled                  -> disables set
// POST /plugins/toggle {id}               -> flip disables section (restart applies)
// POST /voice/transcribe (raw audio blob) -> ffmpeg decode -> faster-whisper -> {transcript}
// CORS-enabled for the Settings UI and the composer voice button.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const name = 'roycode-triggers'
const inject = ['agents']
const Config = z.object({
  port: z.number().required(),
  host: z.string().required(),
  token: z.string().required(),
  target: z.string().required(),
  patchPath: z.string().required(),
})

const MAX_MESSAGE_CHARS = 4000
const MAX_BODY_BYTES = 65536
const MAX_AUDIO_BYTES = 30 * 1024 * 1024
const BEGIN_MARKER = '# roycode-dsh-pack-disables-begin'
const END_MARKER = '# roycode-dsh-pack-disables-end'
const DEFAULT_TRANSCRIBE_SCRIPT = (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'media-parse/fw-transcribe.py') : null) || 'C:/Users/rjq51/.dsh/media-parse/fw-transcribe.py'

// ── disables section helpers (same contract as manage.ps1) ───────────────────
function readDisablesSet(patchPath) {
  try {
    const content = readFileSync(patchPath, 'utf8')
    const lines = content.split(/\r?\n/)
    const disabled = []
    let inside = false
    for (const line of lines) {
      if (line.includes(BEGIN_MARKER)) { inside = true; continue }
      if (line.includes(END_MARKER)) { inside = false; continue }
      if (inside) {
        const m = line.match(/^-\s*id:\s*(\S+)\s*$/)
        if (m) disabled.push(m[1])
      }
    }
    return disabled
  } catch {
    return []
  }
}

function writeDisablesSet(patchPath, disabled) {
  let content = ''
  try { content = readFileSync(patchPath, 'utf8') } catch {}
  const nl = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const kept = []
  let inside = false
  for (const line of lines) {
    if (line.includes(BEGIN_MARKER)) { inside = true; continue }
    if (line.includes(END_MARKER)) { inside = false; continue }
    if (!inside) kept.push(line)
  }
  let out = kept.join(nl).replace(/\r?\n$/, '')
  if (disabled.length) {
    out += nl + nl + BEGIN_MARKER
    for (const id of disabled) out += nl + '- id: ' + id + nl + '  disabled: true'
    out += nl + END_MARKER
  }
  out += nl
  mkdirSync(path.dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, out, 'utf8')
}

function togglePlugin(patchPath, id) {
  const cleanId = String(id ?? '').trim()
  if (!cleanId || /\s/.test(cleanId)) throw new Error('invalid plugin id')
  const disabled = readDisablesSet(patchPath)
  const nowDisabled = disabled.includes(cleanId)
  const next = nowDisabled ? disabled.filter(x => x !== cleanId) : [...disabled, cleanId]
  writeDisablesSet(patchPath, next)
  return { id: cleanId, disabled: !nowDisabled }
}


// ── streaming ASR (resident vosk worker, strict request/reply pairing) ───────
// Protocol: one stdin line in -> one stdout line out. The browser sends raw
// PCM chunks (16k mono s16le) to /voice/stream/audio; the host forwards them
// to the vosk worker and returns the partial hypothesis. A single round trip
// carries one audio chunk plus live text (low latency, no polling).
let voskWorker = null
let voskReady = null
let voskQueue = Promise.resolve()

function getVosk() {
  if (voskWorker !== null && voskWorker.exitCode === null && voskReady !== null) return voskReady
  if (voskWorker !== null) { try { voskWorker.kill() } catch {} }
  const w = spawn('python', ['-u', 'C:/Users/rjq51/.dsh/media-parse/vosk-stream.py'], { stdio: ['pipe', 'pipe', 'pipe'] })
  voskWorker = w
  w.stderr.on('data', () => {})
  w.on('error', () => { voskWorker = null; voskReady = null })
  w.on('exit', () => { voskWorker = null; voskReady = null })
  voskReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vosk startup timeout')), 30000)
    const onData = (d) => {
      if (d.toString('utf8').trim() === 'READY') {
        clearTimeout(timer)
        w.stdout.off('data', onData)
        resolve(w)
      }
    }
    w.stdout.on('data', onData)
    w.on('error', reject)
  })
  return voskReady
}

function voskRoundTrip(line) {
  const run = (async () => {
    const w = await getVosk()
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('vosk round-trip timeout')), 15000)
      const onData = (d) => {
        clearTimeout(timer)
        w.stdout.off('data', onData)
        const t = d.toString('utf8').trim()
        try { resolve(JSON.parse(t)) } catch { reject(new Error('bad vosk line: ' + t.slice(0, 120))) }
      }
      w.stdout.on('data', onData)
    })
    w.stdin.write(JSON.stringify(line) + '\n')
    return response
  })()
  return run
}

// streaming sessions: sid -> accumulated pcm chunks (kept for final append)
const voskSessions = new Map()

// ── voice transcription (resident faster-whisper worker) ──────────────────────
// The python worker loads the model once and serves JSON-line requests over
// stdin/stdout:  {"wav": path}  ->  {"ok":true,"transcript":...,"segments":[...]}
// A per-request process would reload the model every time (~8s); the resident
// worker turns a 3-8s utterance into ~1.2s wall time.
let worker = null
let workerQueue = Promise.resolve()

function ffmpegToWav(audioPath, wavPath, inputFormat) {
  return new Promise((resolve, reject) => {
    const args = inputFormat ? ['-y', '-f', inputFormat, '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath] : ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wavPath]
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(0, 300)))))
  })
}

function getWorker(scriptPath) {
  if (worker !== null && worker.exitCode === null) return Promise.resolve(worker)
  if (worker !== null) { try { worker.kill() } catch {} }
  const w = spawn('python', ['-u', scriptPath, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
  worker = w
  w.stderr.on('data', () => {})
  w.on('error', () => { worker = null })
  w.on('exit', () => { worker = null })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transcribe worker startup timeout')), 30000)
    const onData = (d) => {
      if (d.toString('utf8').trim() === 'READY') {
        clearTimeout(timer)
        w.stdout.off('data', onData)
        resolve(w)
      }
    }
    w.stdout.on('data', onData)
    w.on('error', reject)
  })
}

function transcribeRequest(scriptPath, wavPath) {
  const request = (async () => {
    const w = await getWorker(scriptPath)
    if (w === null) throw new Error('transcribe worker failed to start')
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('transcribe worker timeout')), 60000)
      const onData = (d) => {
        const line = d.toString('utf8').trim()
        if (!line) return
        clearTimeout(timer)
        w.stdout.off('data', onData)
        try { resolve(JSON.parse(line)) } catch { reject(new Error('bad worker line: ' + line.slice(0, 120))) }
      }
      w.stdout.on('data', onData)
    })
    w.stdin.write(JSON.stringify({ wav: wavPath }) + '\n')
    return response
  })()
  return request
}

async function transcribeAudio(audioPath, scriptPath) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roycode-voice-'))
  const wav = path.join(dir, 'decoded.wav')
  try {
    await ffmpegToWav(audioPath, wav)
    // serialize requests through the single worker (one at a time)
    const run = workerQueue.then(() => transcribeRequest(scriptPath, wav))
    workerQueue = run.catch(() => {})
    const data = await run
    if (data.ok !== true) throw new Error(data.error || 'transcribe failed')
    return { transcript: data.transcript, segments: data.segments }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}


function apply(ctx, config) {
  const transcribeScript = config.transcribeScript ?? DEFAULT_TRANSCRIBE_SCRIPT
  // prewarm the resident worker so the first mic tap is already fast
  getWorker(transcribeScript).catch(() => {})
  const port = config.port
  const host = config.host
  const token = config.token ?? ''
  const targetAll = config.target === 'all'
  const patchPath = config.patchPath

  const makeMessage = (text) =>
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'roycode-triggers' },
    })

  const pickAgents = (sessionId) => {
    if (sessionId) {
      const agent = ctx.agents.get(sessionId)
      return agent ? [agent] : []
    }
    const roots = ctx.agents.roots()
    if (targetAll) return roots
    return roots.length ? [roots[roots.length - 1]] : []
  }

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  }

  const server = createServer((req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        respond(200, { ok: true, service: 'roycode-triggers', agents: ctx.agents.roots().length })
        return
      }
      if (req.method === 'GET' && req.url === '/plugins/disabled') {
        respond(200, { ok: true, disabled: readDisablesSet(patchPath) })
        return
      }
      if (req.method === 'POST' && req.url === '/plugins/toggle') {
        if (token) {
          const auth = req.headers.authorization ?? ''
          if (auth !== 'Bearer ' + token) { respond(401, { ok: false, error: 'unauthorized' }); return }
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk; if (body.length > MAX_BODY_BYTES) req.destroy() })
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}')
            const result = togglePlugin(patchPath, payload?.id)
            respond(200, { ok: true, ...result, restartRequired: true })
          } catch (err) {
            respond(400, { ok: false, error: String(err?.message ?? err) })
          }
        })
        return
      }
      // ── streaming ASR endpoints (low-latency live voice) ──
      if (req.method === 'POST' && req.url === '/voice/stream/open') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          (async () => {
            try {
              const { sid } = JSON.parse(body || '{}')
              if (!sid || typeof sid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(sid)) { respond(400, { ok: false, error: 'bad sid' }); return }
              if (voskSessions.has(sid)) { respond(200, { ok: true, sid, alreadyOpen: true }); return }
              voskSessions.set(sid, { pcm: [] })
              await voskRoundTrip({ type: 'open', id: sid })
              respond(200, { ok: true, sid })
            } catch (e) { respond(500, { ok: false, error: String((e && e.message) || e) }) }
          })()
        })
        return
      }
      if (req.method === 'POST' && req.url === '/voice/stream/audio') {
        const sid = (req.headers['x-stream-id'] || '').toString()
        if (!voskSessions.has(sid)) { respond(404, { ok: false, error: 'unknown stream' }); return }
        const chunks = []
        let size = 0
        req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { req.destroy(); return } chunks.push(c) })
        req.on('end', () => {
          (async () => {
            try {
              const pcm = Buffer.concat(chunks)
              const session = voskSessions.get(sid)
              session.pcm.push(pcm)
              const reply = await voskRoundTrip({ type: 'audio', id: sid, base64: pcm.toString('base64') })
              respond(200, { ok: reply.type === 'partial', partial: reply.text || '', sid })
            } catch (e) { respond(500, { ok: false, error: String((e && e.message) || e) }) }
          })()
        })
        return
      }
      if (req.method === 'POST' && req.url === '/voice/stream/finalize') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          (async () => {
            try {
              const { sid } = JSON.parse(body || '{}')
              const session = voskSessions.get(sid)
              if (!session) { respond(404, { ok: false, error: 'unknown stream' }); return }
              const reply = await voskRoundTrip({ type: 'finalize', id: sid })
              voskSessions.delete(sid)
              const voskText = (reply.text || '').trim()
              let final = voskText
              // whisper refine (better accuracy) using the accumulated pcm
              try {
                if (session.pcm.length) {
                  const dir = mkdtempSync(path.join(tmpdir(), 'roycode-pcm-'))
                  const raw = path.join(dir, 'in.pcm')
                  const wav = path.join(dir, 'refine.wav')
                  writeFileSync(raw, Buffer.concat(session.pcm))
                  await ffmpegToWav(raw, wav, 's16le')
                  const refined = await transcribeAudio(wav, transcribeScript)
                  if (refined.transcript) final = refined.transcript
                  rmSync(dir, { recursive: true, force: true })
                }
              } catch { /* keep vosk result on refine failure */ }
              respond(200, { ok: true, final, sid })
            } catch (e) { respond(500, { ok: false, error: String((e && e.message) || e) }) }
          })()
        })
        return
      }
      if (req.method === 'POST' && req.url === '/voice/stream/abort') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          (async () => {
            try {
              const { sid } = JSON.parse(body || '{}')
              if (voskSessions.has(sid)) {
                voskSessions.delete(sid)
                await voskRoundTrip({ type: 'abort', id: sid }).catch(() => {})
              }
              respond(200, { ok: true })
            } catch (e) { respond(500, { ok: false, error: String((e && e.message) || e) }) }
          })()
        })
        return
      }
      if (req.method === 'POST' && req.url === '/voice/transcribe') {
        if (token) {
          const auth = req.headers.authorization ?? ''
          if (auth !== 'Bearer ' + token) { respond(401, { ok: false, error: 'unauthorized' }); return }
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_AUDIO_BYTES) { req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', () => {
          (async () => {
            const dir = mkdtempSync(path.join(tmpdir(), 'roycode-audio-'))
            const audio = path.join(dir, 'input.webm')
            try {
              writeFileSync(audio, Buffer.concat(chunks))
              const result = await transcribeAudio(audio, transcribeScript)
              respond(200, { ok: true, transcript: result.transcript, segments: result.segments })
            } catch (err) {
              respond(500, { ok: false, error: String(err?.message ?? err) })
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
          })()
        })
        return
      }
      if (req.method !== 'POST' || req.url !== '/trigger') {
        respond(404, { ok: false, error: 'not found; POST /trigger, POST /plugins/toggle, POST /voice/transcribe, GET /plugins/disabled' })
        return
      }
      if (token) {
        const auth = req.headers.authorization ?? ''
        if (auth !== 'Bearer ' + token) { respond(401, { ok: false, error: 'unauthorized' }); return }
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > MAX_BODY_BYTES) req.destroy()
      })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}')
          const text = String(payload?.message ?? '').trim()
          if (!text) { respond(400, { ok: false, error: 'message is required' }); return }
          if (text.length > MAX_MESSAGE_CHARS) { respond(413, { ok: false, error: 'message too long' }); return }
          const agents = pickAgents(payload?.session)
          if (!agents.length) { respond(404, { ok: false, error: 'no live target agent' }); return }
          const delivered = []
          for (const agent of agents) {
            try {
              agent.followup(makeMessage(text))
              delivered.push(agent.id)
            } catch (err) {
              console.error('[roycode-triggers] followup failed:', err)
            }
          }
          respond(200, { ok: delivered.length > 0, delivered, targets: agents.map(a => a.id) })
        } catch (err) {
          respond(400, { ok: false, error: String(err?.message ?? err) })
        }
      })
    } catch (err) {
      respond(500, { ok: false, error: String(err?.message ?? err) })
    }
  })

  ctx.effect(() => {
    server.on('error', (err) => {
      console.error('[roycode-triggers] http server error:', err?.message ?? err)
    })
    server.listen(port, host, () => {
      console.log('[roycode-triggers] listening on http://' + host + ':' + port)
    })
    return () => {
      try { server.close() } catch {}
    }
  }, 'roycode-triggers.http()')
}

export { Config, apply, inject, name }
