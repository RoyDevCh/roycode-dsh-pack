// verify roycode-triggers v2 disables-section logic (same code as the plugin)
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

// 提取插件源码中的两个函数（与生产代码完全一致）
const src = readFileSync('C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-triggers/lib/index.js', 'utf8')
const fnRe = /function (readDisablesSet|writeDisablesSet)[\s\S]*?\n}/g
const fns = []
let m
while ((m = fnRe.exec(src)) !== null) fns.push(m[0])
const evalBody = 'import { readFileSync, writeFileSync, mkdirSync } from "node:fs";\nimport path from "node:path";\nconst BEGIN_MARKER = "# roycode-dsh-pack-disables-begin";\nconst END_MARKER = "# roycode-dsh-pack-disables-end";\n' + fns.join('\n') + '\n' + 'globalThis.__read = readDisablesSet; globalThis.__write = writeDisablesSet;'
const mod = await import('data:text/javascript;base64,' + Buffer.from(evalBody).toString('base64'))
const readDisablesSet = globalThis.__read
const writeDisablesSet = globalThis.__write

const dir = mkdtempSync(path.join(tmpdir(), 'tg-'))
const patch = path.join(dir, 'cordis.patch.yml')
const seed = [
  '# roycode-dsh-pack-begin',
  '    - id: mcp-lsp',
  '      name: X',
  '# roycode-dsh-pack-end',
  '',
  '# roycode-dsh-pack-disables-begin',
  '- id: mcp-browser',
  '  disabled: true',
  '# roycode-dsh-pack-disables-end',
  '',
].join('\r\n')
writeFileSync(patch, seed, 'utf8')

// 读
const initial = readDisablesSet(patch)
check('reads existing disables', JSON.stringify(initial) === '["mcp-browser"]', JSON.stringify(initial))

// 写：新增
writeDisablesSet(patch, ['mcp-browser', 'roycode-hooks'])
const after = readDisablesSet(patch)
check('write adds entries', JSON.stringify(after) === '["mcp-browser","roycode-hooks"]', JSON.stringify(after))
check('section format kept', readFileSync(patch, 'utf8').includes('- id: roycode-hooks\r\n  disabled: true'))

// 幂等：重写相同集合
writeDisablesSet(patch, ['mcp-browser', 'roycode-hooks'])
const idem = readDisablesSet(patch)
check('idempotent write', JSON.stringify(idem) === '["mcp-browser","roycode-hooks"]')

// 清空：移除全部 → 无 section
writeDisablesSet(patch, [])
const cleared = readDisablesSet(patch)
check('clear removes section', cleared.length === 0 && !readFileSync(patch, 'utf8').includes('roycode-dsh-pack-disables-begin'))

// 还原 seed 后 manage.ps1 能识别（格式契约一致）
writeFileSync(patch, seed, 'utf8')
rmSync(dir, { recursive: true })

// 用真实线上 patch 文件做一轮端到端（manage.ps1 与宿主逻辑写同一格式）
const real = 'C:/Users/rjq51/.dsh/profiles/web/cordis.patch.yml'
const before = readDisablesSet(real)
writeDisablesSet(real, [...before, 'roycode-hooks'])
const mid = readDisablesSet(real)
check('live patch: toggle adds roycode-hooks', mid.includes('roycode-hooks'))
const psOut = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/rjq51/Documents/dsh/common/roycode-dsh-pack/manage.ps1" status', { encoding: 'utf8' })
check('manage.ps1 sees the same disables (roycode-hooks DISABLED)', psOut.includes('roycode-hooks') && psOut.includes('DISABLED'))
writeDisablesSet(real, before)
const restored = readDisablesSet(real)
check('live patch restored', JSON.stringify(restored) === JSON.stringify(before))

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)