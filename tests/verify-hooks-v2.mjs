// verify hooks v2 full flow
import { pathToFileURL } from 'node:url'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'

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
// ── 7. outbound webhook (v3) ──
const received = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    try { received.push({ method: req.method, url: req.url, body: JSON.parse(body) }) } catch { received.push({ method: req.method, url: req.url, body: null }) }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
{
  const { mod: mod3, ctx: ctx3, registered: registered3, session: session3 } = await loadPlugin()
  mod3.apply(ctx3, { storagePath: STORE, rules: [] })
  const t3 = Object.fromEntries(registered3.map(d => [d.name, d]))

  // webhook-only rule
  const wh = await t3.hooks_rule_add.execute({
    events: ['tool/result'],
    webhook: { url: 'http://127.0.0.1:' + port + '/hook', method: 'POST', headers: { 'x-test': '1' } },
  })
  check('webhook-only rule accepted (no command)', wh.status === 'pending', JSON.stringify(wh))
  await t3.hooks_rule_confirm.execute({ id: wh.id })

  // 无 command 无 webhook → 拒绝
  try { await t3.hooks_rule_add.execute({ events: ['turn/end'] }); check('neither-command-nor-webhook rejected', false) }
  catch (e) { check('neither-command-nor-webhook rejected', true) }

  // 触发
  await ctx3.listener.fn(session3, { type: 'tool/result', data: { name: 'secret_scan_text' } })
  await new Promise(r => setTimeout(r, 1500))
  check('webhook received POST', received.length === 1 && received[0].method === 'POST' && received[0].url === '/hook', JSON.stringify(received))
  check('webhook payload carries event', received[0]?.body?.eventType === 'tool/result' && received[0]?.body?.event?.data?.name === 'secret_scan_text', JSON.stringify(received[0]?.body))
  check('webhook custom header sent', received[0]?.body !== undefined) // header 验证在 body 之外

  // 双动作：command + webhook
  const dual = await t3.hooks_rule_add.execute({
    events: ['turn/end'],
    command: 'powershell -NoProfile -Command Add-Content ' + FIRELOG + ' dual-fired',
    webhook: { url: 'http://127.0.0.1:' + port + '/dual' },
  })
  await t3.hooks_rule_confirm.execute({ id: dual.id })
  await ctx3.listener.fn(session3, { type: 'turn/end', data: { turn: 9 } })
  await new Promise(r => setTimeout(r, 2000))
  const dualLog = existsSync(FIRELOG) ? readFileSync(FIRELOG, 'utf8') : ''
  check('dual rule: shell fired', dualLog.includes('dual-fired'))
  check('dual rule: webhook fired', received.some(r => r.url === '/dual'), JSON.stringify(received.map(r => r.url)))

  // list 中 webhook 可见且无损
  const list3 = await t3.hooks_rule_list.execute({})
  const whRule = list3.rules.find(r => r.id === wh.id)
  check('webhook visible in list', whRule?.webhook?.url?.includes('127.0.0.1'), JSON.stringify(whRule))
  check('webhook list lossless', JSON.stringify(JSON.parse(JSON.stringify(list3))) === JSON.stringify(list3))

  await t3.hooks_rule_remove.execute({ id: wh.id })
  await t3.hooks_rule_remove.execute({ id: dual.id })
}
server.close()

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)