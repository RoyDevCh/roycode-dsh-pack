// roycode-teams v0.3.0 — teams with growth governance.
// v0.1/0.2: pure JSON storage, unbounded inbox/memory.
// v0.3 adds:
//  - per-member read cursors: team_inbox(markRead, limit, since) + unread counts
//    (read stays member-scoped; messages are team broadcasts, never auto-moved)
//  - team_archive(keep?): move oldest messages to history (idempotent, default 200)
//  - memory cap (default 50; overflow to memoryHistory) + team_memory_clear
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'roycode-teams'
const inject = ['tools']
const Config = z.object({ storagePath: z.string().required() })

const MESSAGE_RETENTION = 200
const MEMORY_CAP = 50
const MEMORY_HISTORY_CAP = 200

let cache = null
let cachePath = null

function load(config) {
  const p = config.storagePath
  if (cache !== null && p === cachePath) return cache
  cachePath = p
  try {
    cache = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    cache = { teams: {} }
  }
  if (!cache.teams) cache.teams = {}
  // normalize legacy records (v0.2 files lack the new fields)
  for (const team of Object.values(cache.teams)) {
    team.members ??= []
    team.messages ??= []
    team.memory ??= []
    team.readCursors ??= {}
    team.history ??= []
    team.memoryHistory ??= []
  }
  return cache
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function save(config, state) {
  const p = config.storagePath
  mkdirSync(path.dirname(p), { recursive: true })
  const data = JSON.stringify(state, null, 2)
  const tmp = p + '.tmp'
  writeFileSync(tmp, data, 'utf8')
  // Windows: renaming over an existing file can hit a transient lock
  // (AV scan etc.) — retry, then fall back to a direct write.
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, p)
      cache = state
      return
    } catch (err) {
      lastErr = err
      sleepSync(60 * (attempt + 1))
    }
  }
  try {
    writeFileSync(p, data, 'utf8')
  } catch (err) {
    throw lastErr ?? err
  }
  rmSync(tmp, { force: true })
  cache = state
}

function getTeam(state, config, teamName) {
  const key = String(teamName ?? '').trim()
  if (!key) throw new Error('team name is required')
  const team = state.teams[key]
  if (!team) throw new Error('team not found: ' + key)
  return team
}

function requireMember(team, memberName) {
  const member = String(memberName ?? '').trim()
  if (!member) throw new Error('member name is required')
  if (!team.members.includes(member)) throw new Error('member not in team: ' + member)
  return member
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function register(ctx, config) {
  const tools = [
    {
      name: 'team_create',
      description: 'Create a named team for grouping subagents/roles with a shared inbox and memory.',
      parameters: {
        team: { type: 'string', required: true, description: 'Team name (kebab-case).' },
        description: { type: 'string', description: 'One-line purpose of the team.' },
      },
      execute: async (args) => {
        const state = load(config)
        const key = String(args.team).trim()
        if (!key) throw new Error('team name is required')
        if (state.teams[key]) throw new Error('team already exists: ' + key)
        state.teams[key] = {
          name: key,
          description: args.description ?? '',
          createdAt: Date.now(),
          members: [],
          messages: [],
          memory: [],
          readCursors: {},
          history: [],
          memoryHistory: [],
        }
        save(config, state)
        return { ok: true, team: key }
      },
    },
    {
      name: 'team_list',
      description: 'List all teams with member counts, message counts, archived history and memory counts.',
      parameters: {},
      execute: async () => {
        const state = load(config)
        return {
          teams: Object.values(state.teams).map(t => ({
            name: t.name,
            description: t.description,
            members: t.members.length,
            messages: t.messages.length,
            archived: t.history.length,
            memoryEntries: t.memory.length,
          })),
        }
      },
    },
    {
      name: 'team_delete',
      description: 'Delete a team and its messages/memory/history.',
      parameters: { team: { type: 'string', required: true } },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        delete state.teams[team.name]
        save(config, state)
        return { ok: true, team: team.name }
      },
    },
    {
      name: 'team_add_member',
      description: 'Add a member (subagent or role name) to a team. New members start with a read cursor at the latest message (they see only messages posted after joining).',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true, description: 'Member name, e.g. reviewer, security.' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const member = String(args.member).trim()
        if (!member) throw new Error('member name is required')
        if (!team.members.includes(member)) {
          team.members.push(member)
          team.readCursors[member] = team.messages.length
        }
        save(config, state)
        return { ok: true, team: team.name, members: team.members }
      },
    },
    {
      name: 'team_remove_member',
      description: 'Remove a member from a team (their read cursor is dropped).',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const member = String(args.member).trim()
        team.members = team.members.filter(m => m !== member)
        delete team.readCursors[member]
        save(config, state)
        return { ok: true, team: team.name, members: team.members }
      },
    },

    {
      name: 'team_message',
      description: 'Post a message from one member to the team inbox (team broadcast; every member can read it).',
      parameters: {
        team: { type: 'string', required: true },
        from: { type: 'string', required: true, description: 'Sender name.' },
        text: { type: 'string', required: true, description: 'Message body.' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const seq = team.messages.length + 1
        team.messages.push({ seq, from: String(args.from), text: String(args.text), ts: new Date().toISOString() })
        save(config, state)
        return { ok: true, seq }
      },
    },
    {
      name: 'team_inbox',
      description: 'Read inbox messages for one member (messages from others). Uses the member read cursor by default; pass since to override. markRead=true advances the cursor to the latest message (read is member-scoped and never moves team messages). limit caps the returned list to the newest N.',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true },
        since: { type: 'integer', description: 'Only messages with seq greater than this (defaults to the member cursor).' },
        markRead: { type: 'boolean', description: 'Advance the member cursor to the latest message (default false).' },
        limit: { type: 'integer', description: 'Return only the newest N matching messages.' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const member = requireMember(team, args.member)
        const cursor = team.readCursors[member] ?? 0
        const since = args.since ?? cursor
        let msgs = team.messages.filter(m => m.from !== member && m.seq > since)
        if (args.limit > 0) msgs = msgs.slice(-args.limit)
        const nextSeq = team.messages.length
        if (args.markRead) team.readCursors[member] = nextSeq
        const unread = team.messages.filter(m => m.from !== member && m.seq > (team.readCursors[member] ?? 0)).length
        if (args.markRead) save(config, state)
        return {
          team: team.name,
          member,
          cursor: team.readCursors[member] ?? 0,
          unread,
          nextSeq,
          messages: msgs.map(m => ({ seq: m.seq, from: m.from, text: m.text, ts: m.ts })),
        }
      },
    },
    {
      name: 'team_archive',
      description: 'Archive a team: move the oldest messages beyond the retention window (default 200) into history. Idempotent: re-running with the same keep archives nothing. History is never returned by team_inbox.',
      parameters: {
        team: { type: 'string', required: true },
        keep: { type: 'integer', description: 'Messages to retain (default 200).' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const keep = Math.max(0, Math.floor(args.keep ?? MESSAGE_RETENTION))
        const excess = team.messages.length - keep
        let archived = 0
        if (excess > 0) {
          const moved = team.messages.splice(0, excess)
          team.history.push(...moved)
          archived = moved.length
        }
        save(config, state)
        return { team: team.name, archived, messages: team.messages.length, history: team.history.length }
      },
    },
    {
      name: 'team_memory_append',
      description: 'Append a durable note to the team shared memory. Memory is capped (default 50 entries); the oldest overflow moves to memoryHistory.',
      parameters: {
        team: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        team.memory.push(String(args.content))
        while (team.memory.length > MEMORY_CAP) team.memoryHistory.push(team.memory.shift())
        while (team.memoryHistory.length > MEMORY_HISTORY_CAP) team.memoryHistory.shift()
        save(config, state)
        return { ok: true, memoryEntries: team.memory.length, memoryHistoryEntries: team.memoryHistory.length }
      },
    },
    {
      name: 'team_memory_read',
      description: 'Read the team shared memory entries (current entries plus the overflow history count).',
      parameters: { team: { type: 'string', required: true } },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        return { team: team.name, memory: team.memory, memoryHistoryCount: team.memoryHistory.length }
      },
    },
    {
      name: 'team_memory_clear',
      description: 'Clear the team shared memory entirely (memoryHistory is kept as overflow audit).',
      parameters: { team: { type: 'string', required: true } },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        team.memory = []
        save(config, state)
        return { ok: true, team: team.name, memoryEntries: 0 }
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

function apply(ctx, config) {
  register(ctx, config)
}

export { Config, apply, inject, name }