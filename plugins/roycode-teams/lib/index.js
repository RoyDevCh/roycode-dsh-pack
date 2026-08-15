// roycode-teams — named teams with shared inbox and memory.
// Ported from roycode-studio/server/teams.ts. Pure file-backed storage; the
// model orchestrates members with the subagent tools and this registry.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'roycode-teams'
const inject = ['tools']
const Config = z.object({ storagePath: z.string().required() })

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
  return cache
}

function save(config, state) {
  const p = config.storagePath
  mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, p)
  cache = state
}

function getTeam(state, config, teamName) {
  const key = String(teamName ?? '').trim()
  if (!key) throw new Error('team name is required')
  const team = state.teams[key]
  if (!team) throw new Error('team not found: ' + key)
  return team
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
        state.teams[key] = { name: key, description: args.description ?? '', createdAt: Date.now(), members: [], messages: [], memory: [] }
        save(config, state)
        return { ok: true, team: key }
      },
    },
    {
      name: 'team_list',
      description: 'List all teams with member counts and last message count.',
      parameters: {},
      execute: async () => {
        const state = load(config)
        return {
          teams: Object.values(state.teams).map(t => ({
            name: t.name,
            description: t.description,
            members: t.members.length,
            messages: t.messages.length,
            memoryEntries: t.memory.length,
          })),
        }
      },
    },
    {
      name: 'team_delete',
      description: 'Delete a team and its messages/memory.',
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
      description: 'Add a member (subagent or role name) to a team.',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true, description: 'Member name, e.g. reviewer, security.' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const member = String(args.member).trim()
        if (!member) throw new Error('member name is required')
        if (!team.members.includes(member)) team.members.push(member)
        save(config, state)
        return { ok: true, team: team.name, members: team.members }
      },
    },
    {
      name: 'team_remove_member',
      description: 'Remove a member from a team.',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        team.members = team.members.filter(m => m !== String(args.member).trim())
        save(config, state)
        return { ok: true, team: team.name, members: team.members }
      },
    },
    {
      name: 'team_message',
      description: 'Post a message from one member to the team inbox.',
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
      description: 'Read inbox messages for one member (messages from others, optionally since a seq).',
      parameters: {
        team: { type: 'string', required: true },
        member: { type: 'string', required: true },
        since: { type: 'integer', description: 'Only messages with seq greater than this.' },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        const since = args.since ?? 0
        const messages = team.messages
          .filter(m => m.from !== String(args.member) && m.seq > since)
          .map(m => ({ seq: m.seq, from: m.from, text: m.text, ts: m.ts }))
        return { team: team.name, nextSeq: team.messages.length, messages }
      },
    },
    {
      name: 'team_memory_append',
      description: 'Append a durable note to the team shared memory.',
      parameters: {
        team: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        team.memory.push(String(args.content))
        save(config, state)
        return { ok: true, memoryEntries: team.memory.length }
      },
    },
    {
      name: 'team_memory_read',
      description: 'Read the team shared memory entries.',
      parameters: { team: { type: 'string', required: true } },
      execute: async (args) => {
        const state = load(config)
        const team = getTeam(state, config, args.team)
        return { team: team.name, memory: team.memory }
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