// server.mjs - Secret scanner as an MCP stdio server.
// Ported from roycode-studio/server/secretScanner.ts.
import { readFile } from 'node:fs/promises'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

const SECRET_RULES = [
  { id: 'anthropic-api-key', label: 'Anthropic API key', pattern: /\bsk-ant-(?:api|admin)[a-z0-9_-]{20,}\b/i },
  { id: 'openai-api-key', label: 'OpenAI API key', pattern: /\bsk-(?:proj|svcacct|admin)-[a-z0-9_-]{20,}\b/i },
  { id: 'github-pat', label: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9a-z]{24,}\b/i },
  { id: 'aws-access-key', label: 'AWS access key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { id: 'npm-token', label: 'NPM token', pattern: /\bnpm_[a-z0-9]{20,}\b/i },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox(?:b|p|e|s|a)-[0-9a-z-]{20,}\b/i },
  { id: 'private-key', label: 'Private key material', pattern: /-----BEGIN(?:[ A-Z0-9_-]+)?PRIVATE KEY-----[\s\S]{40,}-----END(?:[ A-Z0-9_-]+)?PRIVATE KEY-----/i },
]

function scanTextForSecrets(content) {
  const matches = []
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(content)) matches.push({ id: rule.id, label: rule.label })
  }
  return matches
}

const TOOLS = [
  { name: 'secret_scan_text', description: 'Scan a text blob for high-confidence secrets (API keys, tokens, private keys). Returns matching rule ids and labels.', parameters: { type: 'object', properties: { content: { type: 'string', description: 'Text to scan (e.g. pasted output, diff, env file content).' } }, required: ['content'] } },
  { name: 'secret_scan_file', description: 'Scan a local text file for secrets. Returns matches or an empty list.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path.' } }, required: ['path'] } },
]

async function runTool(name, args) {
  if (name === 'secret_scan_text') {
    const matches = scanTextForSecrets(args.content ?? '')
    return { clean: matches.length === 0, matches }
  }
  if (name === 'secret_scan_file') {
    const content = await readFile(args.path, 'utf8')
    const matches = scanTextForSecrets(content)
    return { clean: matches.length === 0, matches }
  }
  throw new Error('Unknown tool: ' + name)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
let busy = Promise.resolve()
function enqueue(fn) {
  const next = busy.then(fn, fn)
  busy = next.catch(() => {})
  return next
}

rl.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  const respond = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  const respondError = (code, message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n')

  if (msg.method === 'initialize') {
    respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'secret-scan', version: '0.1.0' } })
    return
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
    if (msg.id !== undefined && msg.id !== null) respond({})
    return
  }
  if (msg.method === 'tools/list') {
    respond({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    const tool = TOOLS.find(t => t.name === name)
    if (!tool) {
      respondError(-32602, 'Unknown tool: ' + name)
      return
    }
    enqueue(async () => {
      try {
        const data = await runTool(name, args ?? {})
        respond({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
      } catch (err) {
        respondError(-32603, String(err?.message ?? err))
      }
    })
    return
  }
})
