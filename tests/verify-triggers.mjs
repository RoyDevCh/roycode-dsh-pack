import { pathToFileURL } from 'node:url'

const PLUGIN = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-triggers/lib/index.js'
const PORT = 18787

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

// fake agents
const followups = []
const mkAgent = (id) => ({ id, followup: (m) => followups.push({ agent: id, message: m }) })
const agentA = mkAgent('session-a')
const agentB = mkAgent('session-b')

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
check('inject = agents', mod.inject.join(',') === 'agents', mod.inject.join(','))

// 无 token 模式：latest 目标
{
  const ctx = {
    agents: { roots: () => [agentA, agentB], get: (id) => ({ 'session-a': agentA, 'session-b': agentB })[id] },
    effect: (fn) => fn(),
  }
  mod.apply(ctx, { port: PORT, host: '127.0.0.1', token: '', target: 'latest' })
  await new Promise(r => setTimeout(r, 300))

  // health
  const health = await fetch('http://127.0.0.1:' + PORT + '/health')
  check('health 200', health.status === 200, JSON.stringify(await health.json()))

  // 缺 message
  const bad = await fetch('http://127.0.0.1:' + PORT + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('missing message -> 400', bad.status === 400)

  // latest 目标（agentB）
  const ok = await fetch('http://127.0.0.1:' + PORT + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello from webhook' }) })
  const okBody = await ok.json()
  check('trigger 200 + delivered to latest', ok.status === 200 && okBody.delivered.includes('session-b'), JSON.stringify(okBody))
  check('followup called with plugin source', followups.length === 1 && followups[0].message.role === 'user' && followups[0].message.content[0]?.text === 'hello from webhook', JSON.stringify(followups[0].message.source))
  check('followup source = plugin', followups[0].message.source?.kind === 'plugin' && followups[0].message.source?.plugin === 'roycode-triggers')

  // session 定向
  const targeted = await fetch('http://127.0.0.1:' + PORT + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'for a only', session: 'session-a' }) })
  const tBody = await targeted.json()
  check('session targeting', targeted.status === 200 && tBody.delivered.includes('session-a'), JSON.stringify(tBody))

  // 不存在的 session
  const missing = await fetch('http://127.0.0.1:' + PORT + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x', session: 'nope' }) })
  check('unknown session -> 404', missing.status === 404)

  // 未知路由
  const nf = await fetch('http://127.0.0.1:' + PORT + '/other')
  check('unknown route -> 404', nf.status === 404)
}

// token 模式：all 目标
{
  const followups2 = []
  const agentC = { id: 'session-c', followup: (m) => followups2.push(m) }
  const agentD = { id: 'session-d', followup: (m) => followups2.push(m) }
  const ctx2 = {
    agents: { roots: () => [agentC, agentD], get: () => undefined },
    effect: (fn) => fn(),
  }
  const mod2 = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now() + 'b')
  mod2.apply(ctx2, { port: PORT + 1, host: '127.0.0.1', token: 'secret-123', target: 'all' })
  await new Promise(r => setTimeout(r, 300))

  const noAuth = await fetch('http://127.0.0.1:' + (PORT + 1) + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x' }) })
  check('no token -> 401', noAuth.status === 401)

  const withAuth = await fetch('http://127.0.0.1:' + (PORT + 1) + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-123' }, body: JSON.stringify({ message: 'broadcast' }) })
  const aBody = await withAuth.json()
  check('token ok + all targets', withAuth.status === 200 && aBody.delivered.length === 2, JSON.stringify(aBody))
  check('all agents followed up', followups2.length === 2)
}

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
