// server.mjs - Minimal browser helper as an MCP stdio server.
// Ported from roycode-studio/server/chrome.ts: open URLs in the default browser.
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

function buildBrowserSearchUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(query)
}

function openUrlInBrowser(url) {
  const resolvedUrl = new URL(url).toString()
  return new Promise((resolve, reject) => {
    let command
    let args
    if (process.platform === 'win32') {
      command = 'cmd.exe'
      args = ['/c', 'start', '', resolvedUrl]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = [resolvedUrl]
    } else {
      command = 'xdg-open'
      args = [resolvedUrl]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      resolve({ opened: resolvedUrl })
    })
  })
}

const TOOLS = [
  { name: 'browser_open', description: 'Open a URL in the user\'s default browser. The agent cannot see the page; pair with web_fetch/web_search when content is needed.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute URL to open.' } }, required: ['url'] } },
  { name: 'browser_search', description: 'Open a Google search for the query in the default browser.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
]

async function runTool(name, args) {
  if (name === 'browser_open') return await openUrlInBrowser(args.url)
  if (name === 'browser_search') return await openUrlInBrowser(buildBrowserSearchUrl(args.query))
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
    respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'browser', version: '0.1.0' } })
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
