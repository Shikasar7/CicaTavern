// 世界书 as whole books (web/books.js): an imported book's name, description and
// scan depth, its export back to SillyTavern, copies, the cards that use it, and
// entries copied or moved between books.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { addEntries, editBook, editBookInfo, normalizeBook, scanDepthOf, triggeredEntries, worldFile } from '../server/worldbook.mjs'

// A SillyTavern world file, with fields this app does not read.
const WORLD = {
  entries: {
    0: { uid: 0, key: ['王都'], keysecondary: [], comment: '王都', content: '王都终年下雪。', constant: true, selective: true, selectiveLogic: 0, order: 100, position: 0, disable: false, depth: 4, group: '城', sticky: 2, displayIndex: 5, caseSensitive: null, matchWholeWords: null },
    7: { uid: 7, key: ['Lamp'], keysecondary: [], comment: '灯', content: '灯油是配给的。', constant: false, selective: true, selectiveLogic: 0, order: 20, position: 4, depth: 0, disable: true, caseSensitive: true, matchWholeWords: false, cooldown: 3 },
  },
}

test('an imported world file keeps the fields this app does not read, and its export gives them back under the edits', () => {
  const book = normalizeBook(WORLD, '雪国', { standalone: true })
  assert.equal(book.extras, true)
  assert.deepEqual(book.entries[0].extra, { depth: 4, group: '城', sticky: 2, displayIndex: 5, caseSensitive: null, matchWholeWords: null })
  editBook(book, { entries: [{ uid: '0', content: '王都四季如春。', keys: ['王都', '京城'] }, { uid: '7', enabled: true, wholeWords: true }] })
  editBook(book, { add: { comment: '新的', content: '新条目。' } })

  const file = worldFile(book)
  assert.equal(file.name, '雪国')
  assert.deepEqual(Object.keys(file.entries), ['0', '7', '8'])
  const snow = file.entries[0]
  assert.equal(snow.content, '王都四季如春。')
  assert.deepEqual(snow.key, ['王都', '京城'])
  assert.deepEqual([snow.depth, snow.group, snow.sticky, snow.displayIndex], [4, '城', 2, 5], 'kept from the file')
  assert.deepEqual([snow.caseSensitive, snow.matchWholeWords], [null, null], '"as the setting says" stays so')
  const lamp = file.entries[7]
  assert.deepEqual([lamp.disable, lamp.caseSensitive, lamp.matchWholeWords, lamp.position, lamp.depth, lamp.cooldown], [false, true, true, 4, 0, 3])
  const fresh = file.entries[8]
  assert.deepEqual([fresh.uid, fresh.depth, fresh.addMemo, fresh.disable, fresh.displayIndex], [8, 4, true, false, 2], 'SillyTavern\'s defaults for a new one')

  // Read back, it is the same book.
  const again = normalizeBook(file, 'x', { standalone: true })
  assert.deepEqual(again.entries.map(e => [e.uid, e.content, e.enabled, e.wholeWords]), book.entries.map(e => [e.uid, e.content, e.enabled, e.wholeWords]))
})

test('a card\'s own book keeps only what it reads, and character_book\'s scan_depth is not taken up', () => {
  const card = normalizeBook({ scan_depth: 9, entries: [{ id: 0, keys: ['a'], content: 'a', extensions: { depth: 2, group: 'g' } }] })
  assert.equal(card.entries[0].extra, undefined)
  assert.equal(card.scanDepth, undefined)
  const standalone = normalizeBook({ scan_depth: 9, description: '雪国的设定', entries: [{ id: 0, keys: ['a'], content: 'a', extensions: { depth: 2, display_index: 3, case_sensitive: true } }] }, 'x', { standalone: true })
  assert.equal(standalone.scanDepth, null, 'SillyTavern does not use it, so neither does this app')
  assert.equal(standalone.description, '雪国的设定')
  assert.deepEqual(standalone.entries[0].extra, { depth: 2, displayIndex: 3 }, 'character_book\'s extensions in world-file names')
  assert.equal(normalizeBook({ scanDepth: 2, entries: [] }, 'x', { standalone: true }).scanDepth, 2, 'this app\'s own export')
})

test('a book\'s name, description and scan depth are cleaned', () => {
  const book = normalizeBook({ entries: [] }, '旧名', { standalone: true })
  editBookInfo(book, { name: '  新\n名  ', description: '只给自己看', scanDepth: '12.8' })
  assert.deepEqual([book.name, book.description, book.scanDepth], ['新 名', '只给自己看', 12])
  assert.throws(() => editBookInfo(book, { name: '  ' }), /名字不能空着/)
  assert.deepEqual([scanDepthOf(''), scanDepthOf(0), scanDepthOf(-3), scanDepthOf('x'), scanDepthOf(500), scanDepthOf(1)], [null, null, null, null, 100, 1])
})

test('entries copied into a book keep their numbers unless taken, and say when a constant one arrives', () => {
  const target = normalizeBook({ entries: [{ uid: 0, content: 'a' }, { uid: 1, content: 'b' }] })
  const source = normalizeBook(WORLD, 'x', { standalone: true })
  const { added, prefix } = addEntries(target, source.entries)
  assert.deepEqual(added, ['2', '7'], 'uid 0 was taken; 7 was free')
  assert.equal(prefix, true)
  assert.equal(target.entries.at(-1).extra.cooldown, 3, 'its SillyTavern fields come along')
  target.entries.at(-1).content = 'changed'
  assert.equal(source.entries[1].content, '灯油是配给的。', 'a copy, not the same entry')
  assert.equal(addEntries(target, [source.entries[1]]).prefix, false, 'a keyword entry')
})

test('keywords are looked for in each book\'s own window', () => {
  const near = { id: 'near', scanDepth: 1, entries: normalizeBook({ entries: [{ uid: 0, key: ['灯'], content: '近' }] }).entries }
  const far = { id: 'far', entries: normalizeBook({ entries: [{ uid: 0, key: ['灯'], content: '远' }] }).entries }
  const windows = { near: '雪', far: '灯\n雪' }
  assert.deepEqual(triggeredEntries([near, far], book => windows[book.id], new Set()).map(hit => hit.ref), ['far:0'])
  assert.equal(triggeredEntries([near, far], '灯', new Set()).length, 2, 'one text for all books as before')
  const cased = normalizeBook({ entries: [{ uid: 0, key: ['Lamp'], content: 'x' }] })
  editBook(cased, { entries: [{ uid: '0', caseSensitive: true }] })
  assert.equal(triggeredEntries([{ id: 'c', entries: cased.entries }], 'a lamp', new Set()).length, 0)
  editBook(cased, { entries: [{ uid: '0', caseSensitive: false, wholeWords: true }] })
  assert.equal(triggeredEntries([{ id: 'c', entries: cased.entries }], 'lamps', new Set()).length, 0)
  assert.equal(triggeredEntries([{ id: 'c', entries: cased.entries }], 'a lamp', new Set()).length, 1)
})

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-worldbooks-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 3 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const upload = (filename, json) => ({ filename, data: Buffer.from(JSON.stringify(json)).toString('base64') })
  const importCard = async (name, book) => (await call('/api/cards/import', { method: 'POST', body: upload(`${name}.json`, { spec: 'chara_card_v2', data: { name, first_mes: '你好。', ...(book ? { character_book: book } : {}) } }) })).body
  return { call, upload, importCard }
}

test('a book\'s own fields, its export and a copy', async t => {
  const { call, upload } = await tavern(t)
  const book = (await call('/api/worldbooks/import', { method: 'POST', body: upload('雪国.json', WORLD) })).body
  const edited = await call(`/api/worldbooks/${book.id}`, { method: 'PUT', body: { name: '雪国设定', description: '给王都用的', scanDepth: 2 } })
  assert.equal(edited.status, 200)
  assert.deepEqual([edited.body.name, edited.body.description, edited.body.scanDepth, edited.body.prefix, edited.body.complete], ['雪国设定', '给王都用的', 2, false, true])
  assert.equal(edited.body.entries[0].extra, undefined, 'the page does not get the kept fields')
  assert.equal((await call(`/api/worldbooks/${book.id}`, { method: 'PUT', body: { name: '' } })).status, 400)
  const [listed] = (await call('/api/worldbooks')).body
  assert.deepEqual([listed.name, listed.description, listed.scanDepth, listed.entries], ['雪国设定', '给王都用的', 2, 2])

  const exported = (await call(`/api/worldbooks/${book.id}/export`)).body
  assert.deepEqual([exported.name, exported.scanDepth, exported.entries[0].group, exported.entries[7].cooldown], ['雪国设定', 2, '城', 3])

  const copy = (await call(`/api/worldbooks/${book.id}/copy`, { method: 'POST', body: {} })).body
  assert.notEqual(copy.id, book.id)
  assert.equal(copy.name, '雪国设定（副本）')
  await call(`/api/worldbooks/${copy.id}`, { method: 'PUT', body: { remove: ['0'] } })
  assert.equal((await call(`/api/worldbooks/${book.id}`)).body.entries.length, 2, 'the original is untouched')
  assert.equal((await call(`/api/worldbooks/${copy.id}/export`)).body.entries[7].cooldown, 3)

  const fresh = (await call('/api/worldbooks', { method: 'POST', body: { name: '  空的 ' } })).body
  assert.deepEqual([fresh.name, fresh.entries], ['空的', 0])
  assert.equal((await call('/api/worldbooks', { method: 'POST', body: {} })).body.name, '新世界书')
  assert.equal((await call('/api/worldbooks/nothere/export')).status, 404)
})

test('the cards that use a book are ticked at once, and deleting it lets go of them', async t => {
  const { call, upload, importCard } = await tavern(t)
  const [a, b, c] = [await importCard('甲'), await importCard('乙'), await importCard('丙')]
  const book = (await call('/api/worldbooks/import', { method: 'POST', body: upload('雪国.json', WORLD) })).body
  const other = (await call('/api/worldbooks', { method: 'POST', body: { name: '别的' } })).body
  await call(`/api/cards/${a.id}/worldbooks`, { method: 'PUT', body: { ids: [other.id] } })

  const ticked = await call(`/api/worldbooks/${book.id}/cards`, { method: 'PUT', body: { ids: [a.id, b.id] } })
  assert.deepEqual(ticked.body.changed.sort(), [a.id, b.id].sort())
  const cards = async () => Object.fromEntries((await call('/api/cards')).body.map(card => [card.name, card.worldbookIds]))
  assert.deepEqual(await cards(), { 甲: [other.id, book.id], 乙: [book.id], 丙: [] }, 'added after what a card had')

  assert.deepEqual((await call(`/api/worldbooks/${book.id}/cards`, { method: 'PUT', body: { ids: [b.id, c.id] } })).body.changed.sort(), [a.id, c.id].sort())
  assert.deepEqual(await cards(), { 甲: [other.id], 乙: [book.id], 丙: [book.id] })
  assert.equal((await call('/api/worldbooks/nothere/cards', { method: 'PUT', body: { ids: [a.id] } })).status, 404)

  const removed = await call(`/api/worldbooks/${book.id}`, { method: 'DELETE' })
  assert.deepEqual(removed.body.detached.sort(), ['丙', '乙'])
  assert.deepEqual(await cards(), { 甲: [other.id], 乙: [], 丙: [] })
  assert.deepEqual((await call('/api/worldbooks')).body.map(x => x.name), ['别的'])
})

test('entries are copied or moved between books, out of a card\'s own one too', async t => {
  const { call, upload, importCard } = await tavern(t)
  const book = (await call('/api/worldbooks/import', { method: 'POST', body: upload('雪国.json', WORLD) })).body
  const target = (await call('/api/worldbooks/import', { method: 'POST', body: upload('目标.json', { entries: { 0: { uid: 0, key: ['x'], content: 'x' } } }) })).body

  const copied = await call('/api/worldbooks/transfer', { method: 'POST', body: { from: book.id, to: target.id, uids: ['0', '7'] } })
  assert.equal(copied.status, 200)
  assert.deepEqual([copied.body.to.added, copied.body.to.prefix, copied.body.to.entries, copied.body.from.prefix], [['1', '7'], true, 3, false])
  assert.equal((await call(`/api/worldbooks/${book.id}`)).body.entries.length, 2, 'a copy leaves them')
  assert.equal((await call(`/api/worldbooks/${target.id}/export`)).body.entries[1].group, '城')

  const moved = await call('/api/worldbooks/transfer', { method: 'POST', body: { from: book.id, uids: ['0'], move: true, name: '只有王都' } })
  assert.deepEqual([moved.body.to.name, moved.body.to.entries, moved.body.from.prefix], ['只有王都', 1, true], 'the constant entry left the source')
  assert.deepEqual(moved.body.from.entries.map(e => e.uid), ['7'])
  assert.deepEqual((await call(`/api/worldbooks/${book.id}`)).body.entries.map(e => e.uid), ['7'])

  const card = await importCard('林雪', { entries: [{ id: 0, keys: ['夜'], content: '守夜人提灯巡街。', enabled: true }, { id: 1, keys: [], content: '王都终年下雪。', constant: true, enabled: true }] })
  const out = await call('/api/worldbooks/transfer', { method: 'POST', body: { from: `card-${card.id}`, to: target.id, uids: ['1'], move: true } })
  assert.equal(out.body.from.id, `card-${card.id}`)
  assert.equal(out.body.from.card.bookEntries, 1)
  assert.equal((await call(`/api/cards/${card.id}/book`)).body.entries.length, 1)

  assert.equal((await call('/api/worldbooks/transfer', { method: 'POST', body: { from: book.id, to: target.id, uids: [] } })).status, 400)
  assert.equal((await call('/api/worldbooks/transfer', { method: 'POST', body: { from: book.id, to: book.id, uids: ['7'] } })).status, 400)
  assert.equal((await call('/api/worldbooks/transfer', { method: 'POST', body: { from: book.id, to: 'nothere', uids: ['7'] } })).status, 404)
  assert.equal((await call(`/api/worldbooks/${book.id}`)).body.entries.length, 1, 'nothing moved when the target is missing')
})

/** An OpenAI-compatible model that answers every turn with the same line. */
async function fakeModel(t) {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '夜深了。' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}/v1`
}

test('a turn looks for a book\'s keywords as far back as the book says', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-scan-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: await fakeModel(t), apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', scanDepth: 4 })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '雪下了一整夜。' } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return activePath(await store.getChat(chat.id)).filter(node => node.role === 'user').at(-1)
  }

  // Mentioned a turn ago, before either book was attached.
  await turn('灯笼亮了')
  const lamp = { entries: { 0: { uid: 0, key: ['灯笼'], content: '灯笼是红的。' } } }
  const near = { ...normalizeBook({ name: '近', ...lamp }, 'x', { standalone: true }), scanDepth: 1 }
  const far = normalizeBook({ name: '远', ...lamp }, 'x', { standalone: true })
  await store.saveBook(near)
  await store.saveBook(far)
  card.worldbookIds = [near.id, far.id]
  await store.saveCard(card)

  const user = await turn('嗯')
  assert.deepEqual(user.injected, [`${far.id}:0`], 'the near book sees only the last reply')
  assert.equal(activePath(await store.getChat(chat.id)).at(-1).text, '夜深了。', 'the turn went through')
})
