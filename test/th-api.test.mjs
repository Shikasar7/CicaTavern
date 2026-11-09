// What Tavern Helper functions the stand-ins lack (web/shared/th-api.js MISSING), checked against what they define:
// a card frame's (web/compat.js shimMain, run here in a vm with a stand-in window) and the server sandbox's
// (server/card-scripts.mjs, through a card whose script lists what it finds).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { frameShim } from '../web/compat.js'
import { MISSING, TH_FUNCTIONS, missingCalls } from '../web/shared/th-api.js'

const ALL = Object.values(TH_FUNCTIONS).flat()
// A stub that says the function is not here (compat.js `unsupported`, card-scripts.mjs `refuse`).
const STUB = /unsupported|refuse|不支持|不可用|不运行/

/** A window that takes any use: what shimMain touches beyond defining its functions. */
function frameWindow() {
  const anything = () => {
    const proxy = new Proxy(function () {}, {
      get: (_, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : proxy),
      apply: () => proxy,
      construct: () => proxy,
    })
    return proxy
  }
  const box = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, URL, URLSearchParams, structuredClone, TextEncoder, TextDecoder,
    parent: anything(),
    document: anything(),
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    location: { href: 'about:srcdoc' },
    navigator: { userAgent: 'node' },
    fetch: async () => ({}),
    Headers: class {},
    Response: class {},
    Request: class {},
    screen: { height: 800, width: 1200 },
    innerHeight: 800,
    innerWidth: 1200,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: fn => setTimeout(fn, 16),
  }
  box.window = box
  box.self = box
  box.top = box.parent
  return vm.createContext(box)
}

test('a card frame lacks just what th-api says it lacks', () => {
  const tag = frameShim({ names: { user: '你', char: 'x' }, frame: 'f1', vars: { latest: {} }, viewport: { height: 800, width: 1200 }, events: {}, messages: [], lastId: 0 })
  const context = frameWindow()
  vm.runInContext(tag.replace(/^<script>/, '').replace(/<\\?\/script>$/, ''), context, { timeout: 5000 })
  const lacking = ALL.filter(name => typeof context[name] !== 'function' || STUB.test(String(context[name])))
  assert.deepEqual(lacking, [...MISSING.page])
})

test('the server sandbox lacks just what th-api says it lacks', async t => {
  const model = createServer((req, res) => res.end('{}'))
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-th-api-'))
  const { createApp } = await import('../server/http.mjs')
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: JSON.stringify(body) }).then(res => res.json())
  const LIST = `eventOn(Mvu.events.VARIABLE_INITIALIZED, async variables => {
    const stub = ${STUB}
    variables.stat_data.lacking = ${JSON.stringify(ALL)}.filter(name => typeof globalThis[name] !== 'function' || stub.test(String(globalThis[name])))
    // The older lorebook names work on the same books: a new entry comes back with its uid.
    const primary = getCharLorebooks().primary
    variables.stat_data.uid = await createLorebookEntry(primary, { comment: '新', keys: ['雪'], content: '下雪了' })
    variables.stat_data.entries = (await getLorebookEntries(primary)).map(entry => entry.comment)
  })`
  const book = { name: '书', entries: [{ keys: ['雨'], content: '雨', comment: '旧' }] }
  const raw = { spec: 'chara_card_v2', data: { name: 'list', first_mes: '你好\n<initvar>\n回合: 0\n</initvar>', character_book: book, extensions: { tavern_helper: { scripts: [{ type: 'script', enabled: true, name: 'list', id: 'list', content: LIST }] } } } }
  const card = await send('/api/cards/import', { filename: 'c.json', data: Buffer.from(JSON.stringify(raw)).toString('base64') })
  const chat = await send('/api/chats', { cardId: card.id })
  if (process.env.SHOW_LACKING) console.log('LACKING', chat.path[0].state.lacking.join(' '))
  assert.deepEqual(chat.path[0].state.lacking, [...MISSING.server])
  assert.deepEqual([chat.path[0].state.uid, chat.path[0].state.entries], [1, ['旧', '新']])
})

test('a script\'s calls the stand-in lacks, by where it runs', () => {
  const code = 'const v = getTavernHelperVersion(); await loadPreset("x"); getVariables({ type: "chat" }); TavernHelper.loadPreset("y")'
  assert.deepEqual(missingCalls(code, 'page'), ['getTavernHelperVersion', 'loadPreset'])
  assert.deepEqual(missingCalls('getVariables()', 'page'), [])
})
