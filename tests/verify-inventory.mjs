// verify roycode-inventory client plugin in node (stub window + require + ctx)
import { readFileSync } from 'node:fs'

const CLIENT = 'C:/Users/rjq51/.dsh/profiles/web/node_modules/roycode-inventory/lib/client.js'
const results = []
const check = (n, c, d = '') => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (d ? ' | ' + d : ''))

// stub react
const reactStub = {
  useState: (init) => [init, () => {}],
  useEffect: (fn) => { try { fn() } catch {} },
  createElement: (type, props, ...children) => ({ type, props, children }),
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      // the shipped bundle creates its own module var and RETURNS module.exports;
      // capture the return value like the real loader does
      loaded = factory.call(null, (name) => {
        if (name === 'react') return reactStub
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

// 加载（动态 import + cache bust）
const url = 'file:///' + CLIENT.replace(/\\/g, '/') + '?v=' + Date.now()
await import(url)
check('module loaded via __ModuleLoader__', loaded !== null)

// fake ctx
// loader entry ids from patch inserts carry an "include:" prefix (observed live)
const sampleEntries = [
  { entryId: 'include:dsh-agent', moduleName: '@deepseek-ai/dsh-agent', fiberPhase: 'active' },
  { entryId: 'include:mcp-lsp', moduleName: '@deepseek-ai/dsh-mcp-client', fiberPhase: 'active' },
  { entryId: 'include:mcp-secret-scan', moduleName: '@deepseek-ai/dsh-mcp-client', fiberPhase: 'active' },
  { entryId: 'include:mcp-browser', moduleName: '@deepseek-ai/dsh-mcp-client', fiberPhase: 'active' },
  { entryId: 'include:roycode-hooks', moduleName: 'roycode-hooks', fiberPhase: 'active' },
  { entryId: 'include:roycode-teams', moduleName: 'roycode-teams', fiberPhase: 'active' },
  { entryId: 'include:roycode-triggers', moduleName: 'roycode-triggers', fiberPhase: 'active' },
  { entryId: 'include:roycode-inventory', moduleName: 'roycode-inventory', fiberPhase: 'active' },
  { entryId: 'include:schedule', moduleName: '@deepseek-ai/dsh-schedule', fiberPhase: 'active' },
  { entryId: 'include:dsh-llm-retry', moduleName: '@deepseek-ai/dsh-llm-retry', fiberPhase: 'failed' },
  { entryId: 'include:dsh-compaction', moduleName: '@deepseek-ai/dsh-compaction', fiberPhase: 'active' },
]
const registrations = []
const ctx = {
  effect: (fn) => { try { fn() } catch {} },
  locale: {
    register: () => {},
    bind: (ns) => (key) => ns + ':' + key,
  },
  slots: {
    inject: (slot, fn) => {
      const entry = { slot }
      registrations.push(entry)
      fn() // calls ctx.slots.register, which fills entry.meta/Component
    },
    register: (meta, Component) => {
      const entry = registrations[registrations.length - 1]
      entry.meta = meta
      entry.Component = Component
    },
  },
  remote: {
    pluginInventory: { list: async () => ({ ok: true, value: { entries: sampleEntries, total: sampleEntries.length } }) },
  },
}

check('exports apply/inject', typeof loaded.apply === 'function' && Array.isArray(loaded.inject))

loaded.apply(ctx)
check('tab registered on settings.plugins.tab', registrations.length === 1 && registrations[0].slot === 'settings.plugins.tab')
const reg = registrations[0]
check('tab id = custom, order 20', reg.meta.id === 'custom' && reg.meta.order === 20, JSON.stringify(reg.meta.id))
check('label bound to NS', reg.meta.label() === 'settings.roycodeInventory:tab', reg.meta.label())

// setRawIds 被注入
const injected0 = reg.meta.inject()
check('injected exposes setRawIds', typeof injected0.setRawIds === 'function')

// injected list 过滤
const injected = reg.meta.inject()
const filtered = await injected.list()
const ids = filtered.map(e => e.entryId)
check('custom list filters to 8 (entryId keeps include: prefix)', JSON.stringify(ids) === JSON.stringify(['include:mcp-lsp', 'include:mcp-secret-scan', 'include:mcp-browser', 'include:roycode-hooks', 'include:roycode-teams', 'include:roycode-triggers', 'include:roycode-inventory', 'include:schedule']), ids.join(','))

// Component 初始渲染（loading 态，stub react 不驱动异步 setState）
const node = reg.Component({ list: injected.list })
check('component renders loading state without crash', node?.type === 'p')

for (const line of results) console.log(line)
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)