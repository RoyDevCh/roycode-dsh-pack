// roycode-triggers v0.2 — inbound HTTP webhooks + plugin toggle endpoints.
// POST /trigger {message, session?} -> agent.followup(createUserMessage(...))
// wakes the target agent's driver; the message becomes a normal later turn.
// GET  /health                  -> { ok, service, agents }
// GET  /plugins/disabled        -> { ok, disabled: [entryId] }
// POST /plugins/toggle {id}     -> flips the disables section of cordis.patch.yml
//                                  (same format manage.ps1 uses); needs a restart.
// CORS-enabled so the Settings UI (roycode-inventory) can call it.
// Auth: when config.token is set, require "Authorization: Bearer <token>".
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
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
const BEGIN_MARKER = '# roycode-dsh-pack-disables-begin'
const END_MARKER = '# roycode-dsh-pack-disables-end'

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


function apply(ctx, config) {
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
          if (auth !== 'Bearer ' + token) {
            respond(401, { ok: false, error: 'unauthorized' })
            return
          }
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
      if (req.method !== 'POST' || req.url !== '/trigger') {
        respond(404, { ok: false, error: 'not found; POST /trigger, POST /plugins/toggle, GET /plugins/disabled' })
        return
      }
      if (token) {
        const auth = req.headers.authorization ?? ''
        if (auth !== 'Bearer ' + token) {
          respond(401, { ok: false, error: 'unauthorized' })
          return
        }
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
          if (!text) {
            respond(400, { ok: false, error: 'message is required' })
            return
          }
          if (text.length > MAX_MESSAGE_CHARS) {
            respond(413, { ok: false, error: 'message too long' })
            return
          }
          const agents = pickAgents(payload?.session)
          if (!agents.length) {
            respond(404, { ok: false, error: 'no live target agent' })
            return
          }
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
      console.log('[roycode-triggers] listening on http://' + host + ':' + port + '/trigger')
    })
    return () => {
      try { server.close() } catch {}
    }
  }, 'roycode-triggers.http()')
}

export { Config, apply, inject, name }
