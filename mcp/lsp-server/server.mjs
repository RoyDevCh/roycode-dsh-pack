// server.mjs - RoyCode LSP subset as an MCP stdio server.
// Ported from roycode-studio/server/lsp.ts (TypeScript LanguageService subset):
// diagnostics, definitions, references, implementations, hover, document/workspace
// symbols, rename preview and rename apply. Speaks MCP over stdio (JSON-RPC 2.0).
import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import readline from 'node:readline'
import ts from 'typescript'

const PROTOCOL_VERSION = '2024-11-05'

// ── workspace file helpers (inlined from roycode filesystem.ts) ──────────────
function resolveWorkspacePath(workspaceRoot, filePath) {
  if (path.isAbsolute(filePath)) return path.resolve(filePath)
  return path.resolve(workspaceRoot, filePath)
}
function toWorkspaceRelative(workspaceRoot, absolutePath) {
  return path.relative(workspaceRoot, absolutePath)
}
async function readWorkspaceFile(workspaceRoot, relativeFile) {
  const target = resolveWorkspacePath(workspaceRoot, relativeFile)
  return await readFile(target, 'utf8')
}

// ── LSP subset (ported verbatim from roycode-studio/server/lsp.ts) ───────────
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])

function ensureSupportedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (!TS_EXTENSIONS.has(extension)) {
    throw new Error('LSP subset supports TypeScript and JavaScript files only')
  }
}

function buildLanguageService(workspaceRoot, entryFile) {
  const absolutePath = path.resolve(workspaceRoot, entryFile)
  ensureSupportedFile(absolutePath)

  const configPath =
    ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'jsconfig.json')

  let fileNames = [absolutePath]
  let options = {
    allowJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
  }

  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
    if (configFile.error) {
      throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))
    fileNames = parsed.fileNames.includes(absolutePath) ? parsed.fileNames : [...parsed.fileNames, absolutePath]
    options = parsed.options
  }

  const versions = new Map()
  for (const fileName of fileNames) versions.set(fileName, '0')

  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: fileName => versions.get(fileName) ?? '0',
    getScriptSnapshot: fileName => {
      const content = ts.sys.readFile(fileName)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => workspaceRoot,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }

  return { service: ts.createLanguageService(host, ts.createDocumentRegistry()), absolutePath }
}

function toLineColumn(sourceFile, start, end) {
  const startPos = sourceFile.getLineAndCharacterOfPosition(start)
  const result = { line: startPos.line + 1, column: startPos.character + 1 }
  if (typeof end === 'number') {
    const endPos = sourceFile.getLineAndCharacterOfPosition(end)
    result.endLine = endPos.line + 1
    result.endColumn = endPos.character + 1
  }
  return result
}

function resolveOffset(sourceFile, line, column) {
  return sourceFile.getPositionOfLineAndCharacter(Math.max(0, line - 1), Math.max(0, column - 1))
}

async function getLspDiagnostics(workspaceRoot, filePath) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  if (!program) return []
  const sourceFile = program.getSourceFile(absolutePath)
  if (!sourceFile) throw new Error('Source file not loaded in local LSP service')
  return service.getSemanticDiagnostics(absolutePath).map(diag => {
    const pos = toLineColumn(sourceFile, diag.start ?? 0, (diag.start ?? 0) + (diag.length ?? 0))
    return {
      file: absolutePath,
      line: pos.line,
      column: pos.column,
      category: ts.DiagnosticCategory[diag.category].toLowerCase(),
      code: diag.code,
      message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
    }
  })
}

async function locationTool(workspaceRoot, filePath, line, column, kind) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  const sourceFile = program?.getSourceFile(absolutePath)
  if (!program || !sourceFile) return []
  const offset = resolveOffset(sourceFile, line, column)
  const items =
    kind === 'definitions'
      ? service.getDefinitionAtPosition(absolutePath, offset) ?? []
      : kind === 'references'
        ? service.getReferencesAtPosition(absolutePath, offset) ?? []
        : kind === 'implementations'
          ? service.getImplementationAtPosition(absolutePath, offset) ?? []
          : []
  return items
    .map(item => {
      const file = program.getSourceFile(item.fileName)
      if (!file) return null
      return {
        file: item.fileName,
        ...toLineColumn(file, item.textSpan.start, item.textSpan.start + item.textSpan.length),
      }
    })
    .filter(Boolean)
}

async function getLspHover(workspaceRoot, filePath, line, column) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  const sourceFile = program?.getSourceFile(absolutePath)
  if (!program || !sourceFile) return { display: [], documentation: '' }
  const offset = resolveOffset(sourceFile, line, column)
  const quickInfo = service.getQuickInfoAtPosition(absolutePath, offset)
  if (!quickInfo) return { display: [], documentation: '' }
  return {
    display: ts.displayPartsToString(quickInfo.displayParts).split('\n').filter(Boolean),
    documentation: ts.displayPartsToString(quickInfo.documentation),
  }
}

async function getLspDocumentSymbols(workspaceRoot, filePath) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  const sourceFile = program?.getSourceFile(absolutePath)
  if (!program || !sourceFile) return []
  const navTree = service.getNavigationTree(absolutePath)
  const symbols = []
  function visit(item) {
    for (const span of item.spans ?? []) {
      const pos = toLineColumn(sourceFile, span.start)
      symbols.push({ name: item.text, kind: item.kind, line: pos.line, column: pos.column })
    }
    for (const child of item.childItems ?? []) visit(child)
  }
  for (const child of navTree.childItems ?? []) visit(child)
  return symbols
}

async function getLspWorkspaceSymbols(workspaceRoot, query, filePath) {
  let entryFile = filePath
    ? path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
    : ''
  if (!entryFile) {
    const configPath =
      ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json') ??
      ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'jsconfig.json')
    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath))
        entryFile =
          parsed.fileNames.find(fileName => TS_EXTENSIONS.has(path.extname(fileName).toLowerCase())) ?? ''
      }
    }
  }
  if (!entryFile) {
    for (const candidate of ['index.ts', 'main.ts', 'app.ts', 'index.tsx', 'main.tsx']) {
      if (ts.sys.fileExists(path.join(workspaceRoot, candidate))) {
        entryFile = candidate
        break
      }
    }
  }
  if (!entryFile) throw new Error('Could not determine a TypeScript or JavaScript entry file for workspace symbols')
  const { service } = buildLanguageService(workspaceRoot, entryFile)
  const program = service.getProgram()
  if (!program) return []
  const symbols = service.getNavigateToItems(query) ?? []
  const results = []
  for (const item of symbols) {
    const file = program.getSourceFile(item.fileName)
    if (!file) continue
    results.push({
      name: item.name,
      kind: item.kind,
      file: item.fileName,
      containerName: item.containerName || undefined,
      ...toLineColumn(file, item.textSpan.start),
    })
  }
  return results
}

async function getLspRenamePreview(workspaceRoot, filePath, line, column, newName) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  const sourceFile = program?.getSourceFile(absolutePath)
  if (!program || !sourceFile) {
    return { canRename: false, localizedErrorMessage: 'Source file not loaded in local LSP service', locations: [] }
  }
  const offset = resolveOffset(sourceFile, line, column)
  const renameInfo = service.getRenameInfo(absolutePath, offset, { allowRenameOfImportPath: true })
  if (!renameInfo.canRename) {
    return { canRename: false, localizedErrorMessage: renameInfo.localizedErrorMessage, locations: [] }
  }
  const locations = service.findRenameLocations(absolutePath, offset, false, false, true)
  const previewLocations = []
  for (const location of locations ?? []) {
    const file = program.getSourceFile(location.fileName)
    if (!file) continue
    const start = location.textSpan.start
    const end = start + location.textSpan.length
    previewLocations.push({
      file: location.fileName,
      preview: file.text.slice(start, end),
      newText: newName?.trim() || undefined,
      ...toLineColumn(file, start, end),
    })
  }
  return { canRename: true, displayName: renameInfo.displayName, locations: previewLocations }
}

async function buildLspRenameEditPlan(workspaceRoot, filePath, line, column, newName) {
  const relativePath = path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, filePath))
  const { service, absolutePath } = buildLanguageService(workspaceRoot, relativePath)
  const program = service.getProgram()
  const sourceFile = program?.getSourceFile(absolutePath)
  if (!program || !sourceFile) {
    return { canRename: false, localizedErrorMessage: 'Source file not loaded in local LSP service', files: [] }
  }
  const nextName = newName.trim()
  if (!nextName) return { canRename: false, localizedErrorMessage: 'New name is required', files: [] }
  const offset = resolveOffset(sourceFile, line, column)
  const renameInfo = service.getRenameInfo(absolutePath, offset, { allowRenameOfImportPath: true })
  if (!renameInfo.canRename) {
    return { canRename: false, localizedErrorMessage: renameInfo.localizedErrorMessage, files: [] }
  }
  const locations = service.findRenameLocations(absolutePath, offset, false, false, true)
  const grouped = new Map()
  for (const location of locations ?? []) {
    const list = grouped.get(location.fileName) ?? []
    list.push({ start: location.textSpan.start, end: location.textSpan.start + location.textSpan.length })
    grouped.set(location.fileName, list)
  }
  const files = []
  for (const [fileName, spans] of grouped.entries()) {
    const relativeFile = toWorkspaceRelative(workspaceRoot, fileName)
    const originalContent = await readWorkspaceFile(workspaceRoot, relativeFile)
    let updatedContent = originalContent
    for (const span of [...spans].sort((left, right) => right.start - left.start)) {
      updatedContent = updatedContent.slice(0, span.start) + nextName + updatedContent.slice(span.end)
    }
    files.push({ path: relativeFile, occurrences: spans.length, originalContent, updatedContent })
  }
  return { canRename: true, displayName: renameInfo.displayName, files }
}

// ── MCP tool registry ────────────────────────────────────────────────────────
const POS_DESC = '1-based line and column in the file.'

const TOOLS = [
  { name: 'lsp_diagnostics', description: 'TypeScript/JavaScript semantic diagnostics for one file (works for .ts/.tsx/.js/.jsx/.mts/.cts).', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string', description: 'Absolute workspace root (project directory).' }, filePath: { type: 'string', description: 'File path, absolute or relative to workspaceRoot.' } }, required: ['workspaceRoot', 'filePath'] } },
  { name: 'lsp_definitions', description: 'Jump-to-definition for the symbol at a position. Returns file/line/column locations.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer', description: POS_DESC }, column: { type: 'integer', description: POS_DESC } }, required: ['workspaceRoot', 'filePath', 'line', 'column'] } },
  { name: 'lsp_references', description: 'All references to the symbol at a position across the project.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' } }, required: ['workspaceRoot', 'filePath', 'line', 'column'] } },
  { name: 'lsp_implementations', description: 'Implementations of the symbol at a position (interface/abstract members).', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' } }, required: ['workspaceRoot', 'filePath', 'line', 'column'] } },
  { name: 'lsp_hover', description: 'Type signature and documentation for the symbol at a position.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' } }, required: ['workspaceRoot', 'filePath', 'line', 'column'] } },
  { name: 'lsp_document_symbols', description: 'Outline of a file: top-level functions, classes, interfaces with positions.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' } }, required: ['workspaceRoot', 'filePath'] } },
  { name: 'lsp_workspace_symbols', description: 'Search project symbols by name fragment (getNavigateToItems).', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, query: { type: 'string', description: 'Symbol name fragment to search.' }, filePath: { type: 'string', description: 'Optional entry file to anchor the project.' } }, required: ['workspaceRoot', 'query'] } },
  { name: 'lsp_rename_preview', description: 'Preview a rename: verify the symbol is renamable and list every affected location with current text.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' }, newName: { type: 'string' } }, required: ['workspaceRoot', 'filePath', 'line', 'column'] } },
  { name: 'lsp_rename_apply', description: 'Apply a rename across the project by writing the affected files. DANGEROUS: edits files on disk. Use lsp_rename_preview first.', parameters: { type: 'object', properties: { workspaceRoot: { type: 'string' }, filePath: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' }, newName: { type: 'string' } }, required: ['workspaceRoot', 'filePath', 'line', 'column', 'newName'] } },
]

async function runTool(name, args) {
  const root = args.workspaceRoot ?? process.cwd()
  switch (name) {
    case 'lsp_diagnostics': return await getLspDiagnostics(root, args.filePath)
    case 'lsp_definitions': return await locationTool(root, args.filePath, args.line, args.column, 'definitions')
    case 'lsp_references': return await locationTool(root, args.filePath, args.line, args.column, 'references')
    case 'lsp_implementations': return await locationTool(root, args.filePath, args.line, args.column, 'implementations')
    case 'lsp_hover': return await getLspHover(root, args.filePath, args.line, args.column)
    case 'lsp_document_symbols': return await getLspDocumentSymbols(root, args.filePath)
    case 'lsp_workspace_symbols': return await getLspWorkspaceSymbols(root, args.query, args.filePath)
    case 'lsp_rename_preview': return await getLspRenamePreview(root, args.filePath, args.line, args.column, args.newName)
    case 'lsp_rename_apply': {
      const plan = await buildLspRenameEditPlan(root, args.filePath, args.line, args.column, args.newName)
      if (!plan.canRename) return plan
      const written = []
      for (const file of plan.files) {
        const target = resolveWorkspacePath(root, file.path)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, file.updatedContent, 'utf8')
        written.push({ path: file.path, occurrences: file.occurrences })
      }
      return { canRename: true, displayName: plan.displayName, written }
    }
    default: throw new Error('Unknown tool: ' + name)
  }
}

// ── MCP stdio handler (same wire pattern as computer-use-plugin) ─────────────
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
    respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lsp', version: '0.1.0' } })
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