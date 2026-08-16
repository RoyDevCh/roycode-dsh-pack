import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

function handshake(serverPath, toolName, toolArgs, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, timeoutMs)
    const done = (v) => { clearTimeout(timer); child.kill(); resolve(v) }
    child.stdout.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: toolArgs } }) + '\n')
        } else if (m.id === 2) {
          done(m)
        }
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n')
  })
}
const val = (m) => m?.result?.content?.[0]?.text ? JSON.parse(m.result.content[0].text) : null

// ── notebooks ──
{
  const dir = mkdtempSync(path.join(tmpdir(), 'nb-'))
  const nbPath = path.join(dir, 'test.ipynb')
  writeFileSync(nbPath, JSON.stringify({
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Title\n'] },
      { cell_type: 'code', metadata: {}, source: ['print(1)\n'], outputs: [], execution_count: 1 },
    ],
  }, null, 1), 'utf8')

  const S = 'C:/Users/rjq51/.dsh/mcp-servers/notebooks/server.mjs'
  const list = await handshake(S, 'notebook_list', { path: nbPath })
  const lv = val(list)
  check('notebook_list returns 2 cells', lv?.cells?.length === 2 && lv.cells[0].cell_type === 'markdown', JSON.stringify(lv?.cells))

  const read = await handshake(S, 'notebook_read_cell', { path: nbPath, cell: 1 })
  const rv = val(read)
  check('notebook_read_cell returns source', rv?.source === 'print(1)\n', JSON.stringify(rv))

  const edit = await handshake(S, 'notebook_edit_cell', { path: nbPath, cell: 1, source: 'print("edited")\nprint(2)\n' })
  check('notebook_edit_cell ok', val(edit)?.ok === true)
  const re = await handshake(S, 'notebook_read_cell', { path: nbPath, cell: 1 })
  check('edit persisted', val(re)?.source?.includes('edited'))

  const ins = await handshake(S, 'notebook_insert_cell', { path: nbPath, after: 1, source: 'print(3)\n' })
  check('notebook_insert_cell ok', val(ins)?.ok === true && val(ins)?.index === 2)
  const list2 = await handshake(S, 'notebook_list', { path: nbPath })
  check('insert -> 3 cells', val(list2)?.cells?.length === 3)

  const del = await handshake(S, 'notebook_delete_cell', { path: nbPath, cell: 0 })
  check('notebook_delete_cell ok', val(del)?.ok === true && val(del)?.remaining === 2)

  const bad = await handshake(S, 'notebook_read_cell', { path: nbPath, cell: 9 })
  check('out-of-range rejected', bad?.error !== undefined || val(bad) === null)
  rmSync(dir, { recursive: true })
}

// ── voice 管线（设备检测 + 合成音转写，不依赖真实麦克风）──
{
  const S = 'C:/Users/rjq51/.dsh/mcp-servers/voice/server.mjs'
  const dev = await handshake(S, 'voice_devices', {}, 30000)
  const dv = val(dev)
  check('voice_devices detects mics', Array.isArray(dv?.devices) && dv.devices.length > 0, JSON.stringify(dv?.devices))

  // 生成 1 秒正弦波 -> 走完整转写管线（whisper 应返回空转写但不报错）
  const dir = mkdtempSync(path.join(tmpdir(), 'vox-'))
  const wav = path.join(dir, 'tone.wav')
  await new Promise((resolve, reject) => {
    const c = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '16000', '-ac', '1', wav])
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code))))
    c.on('error', reject)
  })
  // 直接调 transcribe 路径（通过 voice_record 会依赖麦克风；这里用临时脚本验证 whisper 调用）
  const { spawn: sp } = await import('node:child_process')
  const transcript = await new Promise((resolve, reject) => {
    const c = sp('python', ['C:/Users/rjq51/.dsh/media-parse/fw-transcribe.py', wav], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 200)))))
  })
  check('whisper pipeline runs (sine -> empty transcript)', transcript.includes('[language:'), transcript.slice(0, 80))
  rmSync(dir, { recursive: true })
}

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
