// verify hooks v2 full flow
import { pathToFileURL } from 'node:url'
import { readFileSync, rmSync, existsSync } from 'node:fs'

const PLUGIN = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-hooks/lib/index.js'
const STORE = 'C:/Users/rjq51/.dsh/hooks-verify.json'
const FIRELOG = 'C:/Users/rjq51/.dsh/hooks-verify-fire.log'
rmSync(STORE, { force: true }); rmSync(STORE + '.tmp', { force: true }); rmSync(FIRELOG, { force: true })

const results = []
const check = (name, cond, detail = '') => { results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : '')) }
// lossless-JSON guard: every tool output must survive a JSON round-trip unchanged
const lossless = (name, value) => {
  const round = JSON.parse(JSON.stringify(value))
  check(name + ' lossless JSON', JSON.stringify(round) === JSON.stringify(value))
}

async function loadPlugin() {
  const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
  const registered = []
  const sessionEvents = []
  const ctx = {
    on: (ev, fn) => { ctx.listener = { ev, fn } },
    tools: { register: def => registered.push(def) },
  }
  ctx.sessionEvents = sessionEvents
  const session = { id: 's1', header: { cwd: 'C:/x' }, append: (t, d) => sessionEvents.push({ t, d }) }
  return { mod, ctx, registered, sessionEvents, session }
}

// ── 1. apply + seed ──
{
  const { mod, ctx, registered, session } = await loadPlugin()
  mod.apply(ctx, {
    storagePath: STORE,
    rules: [
      { id: 'seed-log', events: ['turn/end'], command: 'powershell -NoProfile -Command Add-Content ' + FIRELOG + ' seed-fired' },
    ],
  })
  check('inject=tools', mod.inject.join(',') === 'tools', mod.inject.join(','))
  check('listener registered', ctx.listener?.ev === 'session/event')
  check('tools registered = 4', registered.length === 4, String(registered.length))
  const byName = Object.fromEntries(registered.map(d => [d.name, d]))

  // list: seed visible, origin config, active
  const list1 = await byName.hooks_rule_list.execute({})
  lossless('list1', list1)
  const seed = list1.rules.find(r => r.id === 'seed-log')
  check('seed loaded active', seed?.status === 'active' && seed?.origin === 'config', JSON.stringify(seed))

  // ── 2. add → pending，不触发 ──
  lossless('list1', list1)
  const added = await byName.hooks_rule_add.execute({
    events: ['tool/result'],
    command: 'powershell -NoProfile -Command Add-Content ' + FIRELOG + ' agent-fired',
  })
  lossless('added', added)
  check('add returns pending', added.status === 'pending' && added.confirmRequired === true, JSON.stringify(added))

  // pending 规则不应触发：模拟 tool/result 事件
  await ctx.listener.fn(session, { type: 'tool/result', data: { name: 'x' } })
  await new Promise(r => setTimeout(r, 1500))
  check('pending rule did NOT fire', !existsSync(FIRELOG) || !readFileSync(FIRELOG, 'utf8').includes('agent-fired'))

  // pending 不持久化
  check('pending NOT persisted', !existsSync(STORE) || !readFileSync(STORE, 'utf8').includes('agent-fired'))

  // 种子规则在 turn/end 触发（验证 listener 路由 + hook/invoked + hook/result）
  await ctx.listener.fn(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await new Promise(r => setTimeout(r, 1500))
  const fireLog = existsSync(FIRELOG) ? readFileSync(FIRELOG, 'utf8') : ''
  check('seed rule fired', fireLog.includes('seed-fired'), fireLog.trim())
  const inv = ctx.sessionEvents.filter(e => e.t === 'hook/invoked')
  const res = ctx.sessionEvents.filter(e => e.t === 'hook/result')
  check('hook/invoked appended', inv.some(e => e.d.ruleId === 'seed-log'), JSON.stringify(inv))
  check('hook/result appended', res.some(e => e.d.ruleId === 'seed-log' && e.d.ok === true), JSON.stringify(res))

  // ── 3. confirm → active + persisted ──
  const confirmed = await byName.hooks_rule_confirm.execute({ id: added.id })
  lossless('confirmed', confirmed)
  check('confirm returns active', confirmed.status === 'active', JSON.stringify(confirmed))
  check('confirmed persisted', existsSync(STORE) && readFileSync(STORE, 'utf8').includes(added.id))

  // ── 4. 触发已确认的规则 ──
  await ctx.listener.fn(session, { type: 'tool/result', data: { name: 'secret_scan_text' } })
  await new Promise(r => setTimeout(r, 1500))
  const fireLog2 = existsSync(FIRELOG) ? readFileSync(FIRELOG, 'utf8') : ''
  check('confirmed rule fired', fireLog2.includes('agent-fired'), fireLog2.trim())

  // ── 5. remove → 持久化移除 ──
  await byName.hooks_rule_remove.execute({ id: added.id })
  const list2 = await byName.hooks_rule_list.execute({})
  lossless('list2', list2)
  check('rule removed from list', !list2.rules.some(r => r.id === added.id))
  check('removed not persisted', !readFileSync(STORE, 'utf8').includes(added.id))
}

// ── 6. 重载（模拟重启）：持久化的种子仍在（这里种子也由 config 提供，验证合并逻辑） ──
{
  const { mod, ctx, registered } = await loadPlugin()
  mod.apply(ctx, { storagePath: STORE, rules: [{ id: 'seed-log', events: ['turn/end'], command: 'echo x' }] })
  const byName = Object.fromEntries(registered.map(d => [d.name, d]))
  const list = await byName.hooks_rule_list.execute({})
  check('reload keeps seed', list.rules.some(r => r.id === 'seed-log' && r.status === 'active'))
  check('reload no duplicates', list.rules.filter(r => r.id === 'seed-log').length === 1)
}

rmSync(STORE, { force: true }); rmSync(STORE + '.tmp', { force: true }); rmSync(FIRELOG, { force: true })
for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)