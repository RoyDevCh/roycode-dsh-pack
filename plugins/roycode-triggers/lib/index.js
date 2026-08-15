// roycode-triggers v1 — inbound HTTP webhooks (remote triggers).
// POST /trigger {message, session?} -> agent.followup(createUserMessage(...))
// wakes the target agent's driver; the message becomes a normal later turn in
// that session's transcript (same channel dsh-schedule uses for reminders).
// GET /health -> { ok, agents } for liveness checks.
// Auth: when config.token is set, require "Authorization: Bearer <token>".
// Bound to config.host (default 127.0.0.1) so an empty token is acceptable
// for local-only use; set a token before binding a LAN address.
import { createServer } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const name = 'roycode-triggers'
const inject = ['agents']
const Config = z.object({
  port: z.number().required(),
  host: z.string().required(),
  token: z.string().required(),
  target: z.string().required(),
})

const MAX_MESSAGE_CHARS = 4000
const MAX_BODY_BYTES = 65536

function apply(ctx, config) {
  const port = config.port
  const host = config.host
  const token = config.token ?? ''
  const targetAll = config.target === 'all'

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

  const server = createServer((req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        respond(200, { ok: true, service: 'roycode-triggers', agents: ctx.agents.roots().length })
        return
      }
      if (req.method !== 'POST' || req.url !== '/trigger') {
        respond(404, { ok: false, error: 'not found; POST /trigger with {message, session?}' })
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
