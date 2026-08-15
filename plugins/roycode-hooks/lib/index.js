// roycode-hooks v2 — programmable event engine.
// v1: static rules from config, one-way shell side effects.
// v2: mutable rule registry (Map<ruleId, Rule>) + one permanent
//     session/event listener that routes against the current snapshot;
//     4 management tools (add/confirm/remove/list); JSON persistence
//     (active rules only); hook/invoked + hook/result session events.
// Security: rules added at runtime start as 'pending' — the agent must
//     obtain explicit user confirmation before hooks_rule_confirm arms
//     them. Config seeds are user-written and always active.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'roycode-hooks'
const inject = ['tools']
const Config = z.object({
  rules: z.array(z.any()).required(),
  storagePath: z.string().required(),
})

// ── mutable rule registry (single-threaded; no locking needed) ───────────────
const rules = new Map()
let storagePath = null

function loadRules(config) {
  storagePath = config.storagePath
  // 1. persisted runtime rules (active only)
  try {
    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'))
    for (const r of persisted.rules ?? []) {
      if (r && r.id && r.command && Array.isArray(r.events) && r.events.length && r.status === 'active') {
        rules.set(r.id, { ...r, status: 'active' })
      }
    }
  } catch {}
  // 2. config seeds (user-trusted, always active); runtime rules win on id clash
  for (const seed of config.rules ?? []) {
    if (!seed || !seed.id || !seed.command || !Array.isArray(seed.events) || !seed.events.length) continue
    if (rules.has(seed.id)) continue
    rules.set(seed.id, {
      id: seed.id,
      events: seed.events,
      match: seed.match ?? undefined,
      command: seed.command,
      cwd: seed.cwd ?? undefined,
      timeoutMs: seed.timeoutMs ?? 30000,
      origin: 'config',
      status: 'active',
      addedAt: new Date().toISOString(),
    })
  }
}

function persist() {
  if (!storagePath) return
  try {
    mkdirSync(path.dirname(storagePath), { recursive: true })
    const active = [...rules.values()]
      .filter(r => r.status === 'active')
      .map(({ lastFiredAt, lastResult, ...rest }) => rest)
    const tmp = storagePath + '.tmp'
    writeFileSync(tmp, JSON.stringify({ rules: active }, null, 2), 'utf8')
    renameSync(tmp, storagePath)
  } catch (err) {
    console.error('[roycode-hooks] persist failed:', err)
  }
}

function fire(rule, event) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(rule.command, {
        shell: true,
        cwd: rule.cwd || undefined,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, error: String(err?.message ?? err) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, error: 'timeout' })
    }, rule.timeoutMs ?? 30000)
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err?.message ?? err) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }) })
    child.on('spawn', () => {
      try {
        child.stdin.write(JSON.stringify({ sessionId: null, eventType: event?.type ?? null, event }))
      } catch {}
      try { child.stdin.end() } catch {}
    })
    child.stdin?.on('error', () => {})
  })
}

function publicRule(rule) {
  // lossless-JSON only: undefined properties are dropped by stringify and
  // fail the harness tool-output validation, so add fields conditionally.
  const out = {
    id: rule.id,
    events: rule.events,
    command: rule.command,
    timeoutMs: rule.timeoutMs ?? 30000,
    origin: rule.origin,
    status: rule.status,
  }
  if (rule.match) out.match = rule.match
  if (rule.cwd) out.cwd = rule.cwd
  if (rule.addedAt) out.addedAt = rule.addedAt
  if (rule.lastFiredAt) out.lastFiredAt = rule.lastFiredAt
  return out
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function apply(ctx, config) {
  loadRules(config)

  // permanent listener — rules are read from the live registry each event
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (!type) return
    const snapshot = [...rules.values()]
    for (const rule of snapshot) {
      try {
        if (rule.status !== 'active') continue
        if (!rule.events.includes(type)) continue
        if (rule.match) {
          const re = new RegExp(rule.match)
          if (!re.test(JSON.stringify(event))) continue
        }
        rule.lastFiredAt = Date.now()
        try { session?.append?.('hook/invoked', { ruleId: rule.id, eventType: type, ts: new Date().toISOString() }) } catch {}
        fire(rule, event).then((result) => {
          try { session?.append?.('hook/result', { ruleId: rule.id, eventType: type, ok: result.ok, code: result.code ?? null, error: result.error ?? null, ts: new Date().toISOString() }) } catch {}
        }).catch(() => {})
      } catch (err) {
        console.error('[roycode-hooks] listener error:', err)
      }
    }
  })

  const tools = [
    {
      name: 'hooks_rule_add',
      description: 'Add a new hook rule at runtime. The rule starts as "pending" and does NOT fire until the user explicitly confirms it: after calling this tool you MUST ask the user for confirmation (use ask_user_question) and only then call hooks_rule_confirm. A rule fires a shell command with a JSON payload on stdin when a session event of one of `events` occurs.',
      parameters: {
        id: { type: 'string', description: 'Optional stable rule id (kebab-case). Generated when omitted.' },
        events: { type: 'array', required: true, description: 'Session event types to trigger on, e.g. ["turn/end","tool/result","user/message"].' },
        match: { type: 'string', description: 'Optional regex tested against the JSON-serialized event.' },
        command: { type: 'string', required: true, description: 'Shell command to run (spawned via cmd on Windows). Receives the event JSON on stdin.' },
        cwd: { type: 'string', description: 'Working directory for the command.' },
        timeoutMs: { type: 'integer', description: 'Kill the command after this many ms (default 30000).' },
      },
      execute: async (args) => {
        const id = String(args.id ?? '').trim() || ('rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7))
        if (rules.has(id)) throw new Error('rule already exists: ' + id)
        const events = Array.isArray(args.events) ? args.events.map(String).filter(Boolean) : []
        if (!events.length) throw new Error('events must be a non-empty array of event type strings')
        const command = String(args.command ?? '').trim()
        if (!command) throw new Error('command is required')
        const rule = {
          id,
          events,
          match: args.match ? String(args.match) : undefined,
          command,
          cwd: args.cwd ? String(args.cwd) : undefined,
          timeoutMs: args.timeoutMs > 0 ? args.timeoutMs : 30000,
          origin: 'agent',
          status: 'pending',
          addedAt: new Date().toISOString(),
        }
        rules.set(id, rule)
        return { id, status: 'pending', confirmRequired: true, note: 'Rule is pending. Ask the user for confirmation, then call hooks_rule_confirm.' }
      },
    },
    {
      name: 'hooks_rule_confirm',
      description: 'Arm a pending hook rule (created by hooks_rule_add) after the user has explicitly confirmed it. Only call this after the user agrees; never confirm without user consent.',
      parameters: { id: { type: 'string', required: true, description: 'Rule id.' } },
      execute: async (args) => {
        const rule = rules.get(String(args.id))
        if (!rule) throw new Error('rule not found: ' + args.id)
        if (rule.status === 'active') return { id: rule.id, status: 'active' }
        rule.status = 'active'
        persist()
        return { id: rule.id, status: 'active', confirmed: true }
      },
    },
    {
      name: 'hooks_rule_remove',
      description: 'Remove a hook rule permanently (persisted).',
      parameters: { id: { type: 'string', required: true } },
      execute: async (args) => {
        const id = String(args.id)
        if (!rules.has(id)) throw new Error('rule not found: ' + id)
        rules.delete(id)
        persist()
        return { ok: true, id }
      },
    },
    {
      name: 'hooks_rule_list',
      description: 'List all hook rules with status (active/pending), origin (config/agent), trigger events, command, and last fired time.',
      parameters: {},
      execute: async () => {
        return { rules: [...rules.values()].map(publicRule) }
      },
    },
  ]

  for (const tool of tools) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => textResult(JSON.stringify(value, null, 2)),
      },
      execute: tool.execute,
    }))
  }
}

export { Config, apply, inject, name }