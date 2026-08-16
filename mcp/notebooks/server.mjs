// server.mjs - .ipynb notebook cell editing as an MCP stdio server.
// Cell listing/reading/editing/insertion/deletion with safe JSON writes.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

async function loadNotebook(filePath) {
  const raw = await readFile(filePath, 'utf8')
  let nb
  try { nb = JSON.parse(raw) } catch (e) { throw new Error('not a valid .ipynb JSON: ' + (e.message ?? e)) }
  if (!Array.isArray(nb.cells)) throw new Error('notebook has no cells array')
  return nb
}

async function saveNotebook(filePath, nb) {
  const data = JSON.stringify(nb, null, 1) + '\n'
  const tmp = filePath + '.tmp'
  await writeFile(tmp, data, 'utf8')
  // Windows transient-lock retry then direct write fallback
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await rename(tmp, filePath); return } catch (e) { if (attempt === 2) { await writeFile(filePath, data, 'utf8'); await rm(tmp, { force: true }); return } await new Promise(r => setTimeout(r, 60 * (attempt + 1))) }
  }
}

function toLines(source) {
  if (Array.isArray(source)) return source
  if (typeof source === 'string') return source.split('\n').map(l => l + '\n')
  return []
}

function fromLines(source) {
  if (Array.isArray(source)) return source.join('')
  return String(source ?? '')
}

const TOOLS = [
  { name: 'notebook_list', description: 'List cells of a .ipynb notebook: index, cell type, line count, first line preview.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute .ipynb path.' } }, required: ['path'] } },
  { name: 'notebook_read_cell', description: 'Read the full source of one notebook cell.', parameters: { type: 'object', properties: { path: { type: 'string' }, cell: { type: 'integer', description: '0-based cell index.' } }, required: ['path', 'cell'] } },
  { name: 'notebook_edit_cell', description: 'Replace the source of one notebook cell.', parameters: { type: 'object', properties: { path: { type: 'string' }, cell: { type: 'integer' }, source: { type: 'string', description: 'New cell source text.' } }, required: ['path', 'cell', 'source'] } },
  { name: 'notebook_insert_cell', description: 'Insert a new cell after the given index (use -1 to prepend).', parameters: { type: 'object', properties: { path: { type: 'string' }, after: { type: 'integer', description: 'Insert after this 0-based index; -1 prepends.' }, source: { type: 'string' }, cell_type: { type: 'string', description: 'code or markdown (default code).' } }, required: ['path', 'after', 'source'] } },
  { name: 'notebook_delete_cell', description: 'Delete one notebook cell by index.', parameters: { type: 'object', properties: { path: { type: 'string' }, cell: { type: 'integer' } }, required: ['path', 'cell'] } },
]

async function runTool(name, args) {
  const filePath = path.resolve(args.path)
  switch (name) {
    case 'notebook_list': {
      const nb = await loadNotebook(filePath)
      return { cells: nb.cells.map((c, i) => {
        const src = fromLines(c.source)
        const first = src.split('\n')[0]?.slice(0, 80) ?? ''
        return { index: i, cell_type: c.cell_type ?? 'unknown', lines: src.split('\n').length - 1, preview: first }
      }) }
    }
    case 'notebook_read_cell': {
      const nb = await loadNotebook(filePath)
      const cell = nb.cells[args.cell]
      if (!cell) throw new Error('cell index out of range: ' + args.cell)
      return { index: args.cell, cell_type: cell.cell_type, source: fromLines(cell.source) }
    }
    case 'notebook_edit_cell': {
      const nb = await loadNotebook(filePath)
      const cell = nb.cells[args.cell]
      if (!cell) throw new Error('cell index out of range: ' + args.cell)
      cell.source = toLines(String(args.source))
      cell.outputs = []
      cell.execution_count = null
      await saveNotebook(filePath, nb)
      return { ok: true, index: args.cell, lines: String(args.source).split('\n').length - 1 }
    }
    case 'notebook_insert_cell': {
      const nb = await loadNotebook(filePath)
      const at = Number(args.after) + 1
      if (at < 0 || at > nb.cells.length) throw new Error('invalid insert position: ' + args.after)
      const cell = { cell_type: args.cell_type === 'markdown' ? 'markdown' : 'code', metadata: {}, source: toLines(String(args.source)) }
      if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null }
      nb.cells.splice(at, 0, cell)
      await saveNotebook(filePath, nb)
      return { ok: true, index: at }
    }
    case 'notebook_delete_cell': {
      const nb = await loadNotebook(filePath)
      if (args.cell < 0 || args.cell >= nb.cells.length) throw new Error('cell index out of range: ' + args.cell)
      nb.cells.splice(args.cell, 1)
      await saveNotebook(filePath, nb)
      return { ok: true, remaining: nb.cells.length }
    }
    default: throw new Error('Unknown tool: ' + name)
  }
}

// ── MCP stdio handler ──
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
  try { msg = JSON.parse(trimmed) } catch { return }
  const respond = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  const respondError = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n')
  if (msg.method === 'initialize') {
    respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'notebooks', version: '0.1.0' } })
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
    if (!tool) { respondError(-32602, 'Unknown tool: ' + name); return }
    enqueue(async () => {
      try {
        const data = await runTool(name, args ?? {})
        respond({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
      } catch (err) { respondError(-32603, String(err?.message ?? err)) }
    })
    return
  }
})
