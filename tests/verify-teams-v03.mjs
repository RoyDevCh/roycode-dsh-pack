import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'

const PLUGIN = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-teams/lib/index.js'
const STORE = 'C:/Users/rjq51/.dsh/teams-verify.json'
rmSync(STORE, { force: true }); rmSync(STORE + '.tmp', { force: true })

const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))
const lossless = (n, v) => check(n + ' lossless', JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v))

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const registered = []
mod.apply({ tools: { register: d => registered.push(d) } }, { storagePath: STORE })
const t = Object.fromEntries(registered.map(d => [d.name, d]))
check('tools = 12', registered.length === 12, String(registered.length))

// 时序：先发消息，再加 bob（游标 = 加入时的最新 seq）
await t.team_create.execute({ team: 'core' })
await t.team_add_member.execute({ team: 'core', member: 'alice' })
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm1' })
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm2' })
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm3' })
await t.team_add_member.execute({ team: 'core', member: 'bob' })

// 新成员看不到加入前的消息
const inboxBob1 = await t.team_inbox.execute({ team: 'core', member: 'bob' })
lossless('inbox bob', inboxBob1)
check('new member sees no pre-join messages', inboxBob1.messages.length === 0 && inboxBob1.unread === 0, JSON.stringify(inboxBob1))

// 新消息 → 可见；markRead 推进游标
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm4' })
const inboxBob2 = await t.team_inbox.execute({ team: 'core', member: 'bob' })
check('bob sees new message after join', inboxBob2.messages.length === 1 && inboxBob2.messages[0].text === 'm4' && inboxBob2.unread === 1, JSON.stringify(inboxBob2.messages))
const inboxBob3 = await t.team_inbox.execute({ team: 'core', member: 'bob', markRead: true })
check('markRead advances cursor to 4', inboxBob3.cursor === 4 && inboxBob3.unread === 0, JSON.stringify({ c: inboxBob3.cursor, u: inboxBob3.unread }))
const inboxBob4 = await t.team_inbox.execute({ team: 'core', member: 'bob' })
check('no unread after markRead', inboxBob4.messages.length === 0)

// limit 参数
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm5' })
await t.team_message.execute({ team: 'core', from: 'alice', text: 'm6' })
const inboxLimit = await t.team_inbox.execute({ team: 'core', member: 'bob', limit: 1 })
check('limit returns newest N', inboxLimit.messages.length === 1 && inboxLimit.messages[0].text === 'm6', JSON.stringify(inboxLimit.messages))

// 广播语义：alice 是发件人，自己 inbox 为空；但消息对 bob 可见（m5/m6 未读）
const inboxAlice = await t.team_inbox.execute({ team: 'core', member: 'alice' })
check('sender excluded from own inbox', inboxAlice.messages.length === 0)

// archive：灌到 205 → keep 200 → 归档 5
for (let i = 7; i <= 205; i++) await t.team_message.execute({ team: 'core', from: 'alice', text: 'm' + i })
const arch1 = await t.team_archive.execute({ team: 'core' })
lossless('archive', arch1)
check('archive moves excess (205-200=5)', arch1.archived === 5 && arch1.messages === 200 && arch1.history === 5, JSON.stringify(arch1))
const arch2 = await t.team_archive.execute({ team: 'core' })
check('archive idempotent', arch2.archived === 0, JSON.stringify(arch2))
const inboxAfterArch = await t.team_inbox.execute({ team: 'core', member: 'bob' })
check('archived seqs gone from inbox', !inboxAfterArch.messages.some(m => m.seq <= 5) && inboxAfterArch.messages.length === 200, 'first=' + inboxAfterArch.messages[0]?.seq)


// team_history：归档区可读回（审计闭环）
const hist1 = await t.team_history.execute({ team: 'core' })
lossless('history read', hist1)
check('history returns archived 5', hist1.archived === 5 && hist1.messages.length === 5 && hist1.messages[0].seq === 1, JSON.stringify(hist1.messages.map(m => m.seq)))
const hist2 = await t.team_history.execute({ team: 'core', since: 2 })
check('history since filters', hist2.messages.length === 3 && hist2.messages[0].seq === 3, JSON.stringify(hist2.messages.map(m => m.seq)))
const hist3 = await t.team_history.execute({ team: 'core', limit: 2 })
check('history limit newest N', hist3.messages.length === 2 && hist3.messages[1].seq === 5, JSON.stringify(hist3.messages.map(m => m.seq)))

// 内存上限 + 清空
for (let i = 1; i <= 55; i++) await t.team_memory_append.execute({ team: 'core', content: 'note' + i })
const mem = await t.team_memory_read.execute({ team: 'core' })
check('memory capped at 50', mem.memory.length === 50 && mem.memoryHistoryCount === 5, JSON.stringify({ m: mem.memory.length, h: mem.memoryHistoryCount }))
check('memory keeps newest', mem.memory[0] === 'note6' && mem.memory[49] === 'note55')
const cleared = await t.team_memory_clear.execute({ team: 'core' })
check('memory clear', cleared.memoryEntries === 0)

// 持久化重载
const mod2 = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const registered2 = []
mod2.apply({ tools: { register: d => registered2.push(d) } }, { storagePath: STORE })
const t2 = Object.fromEntries(registered2.map(d => [d.name, d]))
const reload = await t2.team_inbox.execute({ team: 'core', member: 'bob' })
check('reload keeps bob cursor=4', reload.cursor === 4, JSON.stringify(reload.cursor))
const archReload = await t2.team_archive.execute({ team: 'core' })
check('reload keeps archived history', archReload.history === 5 && archReload.archived === 0, JSON.stringify(archReload))

// 成员校验
try { await t.team_inbox.execute({ team: 'core', member: 'eve' }); check('non-member rejected', false) } catch (e) { check('non-member rejected', true) }

rmSync(STORE, { force: true }); rmSync(STORE + '.tmp', { force: true })
for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)