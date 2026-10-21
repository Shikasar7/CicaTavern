// 世界书条目: a card's own worldbook and an imported one, read and edited entry
// by entry (设置 → 挂载的世界书 → 查看条目). Constant entries live in a chat's
// frozen prefix, so an edit that reaches them is reported for the page to say so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { bookCounts, editBook, normalizeBook } from '../server/worldbook.mjs'

const book = () => normalizeBook({
  entries: [
    { uid: 0, comment: '世界观', content: '王都终年下雪。', constant: true, keys: ['王都'] },
    { uid: 1, comment: '林雪', content: '林雪是王都的守夜人。', keys: ['林雪', '小雪'] },
    { uid: 2, comment: '天气', content: '今天<%= variables.天气 %>。', constant: true },
    { uid: 3, comment: '[initvar]', content: '好感: 0', enabled: false },
  ],
})

test('an edit is reported as reaching the prefix only when a static constant entry changes there', () => {
  const b = book()
  assert.equal(editBook(b, { entries: [{ uid: 1, content: '林雪是守夜人。' }] }).prefix, false, 'keyword entries are read every turn')
  assert.equal(editBook(b, { entries: [{ uid: 0, keys: ['雪'] }] }).prefix, false, 'keys do not reach the prefix')
  assert.equal(editBook(b, { entries: [{ uid: 2, content: '今天<%= variables.天气 %>，风大。' }] }).prefix, false, 'templated entries render every turn')
  assert.equal(editBook(b, { entries: [{ uid: 0, content: '王都终年下雪，夜里无灯。' }] }).prefix, true)
  assert.equal(editBook(b, { entries: [{ uid: 0, content: '王都终年下雪，夜里无灯。' }] }).prefix, false, 'the same text again changes nothing')
  assert.equal(editBook(b, { entries: [{ uid: 0, enabled: false }] }).prefix, true, 'switched off: it leaves the prefix')
  assert.equal(editBook(b, { entries: [{ uid: 0, enabled: true }] }).prefix, true)
  assert.equal(editBook(b, { entries: [{ uid: 1, constant: true }] }).prefix, true, 'a keyword entry made constant joins the prefix')
  assert.equal(editBook(b, { entries: [{ uid: 1, constant: false }] }).prefix, true)
  assert.equal(editBook(b, { entries: [{ uid: 'missing', enabled: false }] }).prefix, false)
})

test('entry fields are cleaned, and an entry\'s flags follow its name and text', () => {
  const b = book()
  editBook(b, { entries: [{ uid: 1, keys: ' 林雪 , 小雪,,守夜人 ', comment: '  林雪（人物）  ', order: '12.7', position: 1 }] })
  const entry = b.entries.find(e => e.uid === '1')
  assert.deepEqual(entry.keys, ['林雪', '小雪', '守夜人'])
  assert.equal(entry.comment, '林雪（人物）')
  assert.equal(entry.order, 12)
  assert.equal(entry.position, 1)
  editBook(b, { entries: [{ uid: 1, order: 'many', position: 9, enabled: 'yes', constant: 1 }] })
  assert.equal(entry.order, 12, 'not a number: kept')
  assert.equal(entry.position, 1, 'not a SillyTavern position: kept')
  assert.equal(entry.enabled, true)
  assert.equal(entry.constant, false)
  editBook(b, { entries: [{ uid: 1, comment: '初始变量', content: '<% if (x) { %>a<% } %>' }] })
  assert.equal(entry.initvar, true)
  assert.equal(entry.hasScript, true)
})

test('entries are added with the next free number and removed by uid', () => {
  const b = book()
  const { added, prefix } = editBook(b, { add: { comment: '新条目' } })
  assert.equal(added, '4')
  assert.equal(prefix, false, 'a new entry waits for keywords')
  const fresh = b.entries.at(-1)
  assert.equal(fresh.comment, '新条目')
  assert.equal(fresh.enabled, true)
  assert.equal(fresh.constant, false)
  assert.deepEqual(fresh.keys, [])
  assert.equal(editBook(b, { add: { comment: '规则', content: '不要替玩家说话。', constant: true } }).prefix, true)
  assert.equal(editBook(b, { remove: ['4'] }).prefix, false)
  assert.equal(editBook(b, { remove: ['0'] }).prefix, true, 'removing a constant entry changes the prefix')
  assert.deepEqual(b.entries.map(e => e.uid), ['1', '2', '3', '5'])
  assert.deepEqual(bookCounts(b), { entries: 4, enabled: 3, constant: 2 })
})

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-books-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  const upload = (filename, json) => ({ filename, data: Buffer.from(JSON.stringify(json)).toString('base64') })
  return { app, call, upload }
}

const CARD = {
  spec: 'chara_card_v2',
  data: {
    name: '林雪',
    description: '王都的守夜人。',
    first_mes: '雪下了一整夜。',
    character_book: {
      entries: [
        { id: 0, comment: '世界观', content: '王都终年下雪。', constant: true, keys: [], enabled: true },
        { id: 1, comment: '守夜人', content: '守夜人提灯巡街。', keys: ['守夜'], enabled: true },
      ],
    },
  },
}

test('a card\'s own book: read, edit, and the card list counts it again', async t => {
  const { call, upload } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: upload('c.json', CARD) })).body
  assert.equal(card.bookConstant, 1)

  const read = await call(`/api/cards/${card.id}/book`)
  assert.equal(read.status, 200)
  assert.equal(read.body.id, `card-${card.id}`, 'named as chats know it')
  assert.deepEqual(read.body.entries.map(e => [e.uid, e.comment, e.dynamic]), [['0', '世界观', false], ['1', '守夜人', false]])

  const toggled = await call(`/api/cards/${card.id}/book`, { method: 'PUT', body: { entries: [{ uid: '1', constant: true }] } })
  assert.equal(toggled.body.prefix, true)
  assert.equal(toggled.body.card.bookConstant, 2)
  const off = await call(`/api/cards/${card.id}/book`, { method: 'PUT', body: { entries: [{ uid: '0', enabled: false }] } })
  assert.equal(off.body.card.bookEnabled, 1)
  const listed = (await call('/api/cards')).body.find(c => c.id === card.id)
  assert.deepEqual([listed.bookEntries, listed.bookEnabled, listed.bookConstant], [2, 1, 1])

  const added = await call(`/api/cards/${card.id}/book`, { method: 'PUT', body: { add: { comment: '灯', keys: ['灯'], content: '灯油是配给的。' } } })
  assert.equal(added.body.added, '2')
  assert.equal(added.body.card.bookEntries, 3)

  const plain = { spec: 'chara_card_v2', data: { name: '无书', first_mes: '你好。' } }
  const bookless = (await call('/api/cards/import', { method: 'POST', body: upload('d.json', plain) })).body
  assert.equal((await call(`/api/cards/${bookless.id}/book`)).status, 404)
  assert.equal((await call(`/api/cards/${bookless.id}/book`, { method: 'PUT', body: { entries: [] } })).status, 404)
})

test('an imported book: counted in the list, read and edited by id', async t => {
  const { call, upload } = await tavern(t)
  const imported = (await call('/api/worldbooks/import', { method: 'POST', body: upload('设定集.json', { entries: { 0: { uid: 0, comment: 'A', content: 'a', constant: true, key: [] }, 1: { uid: 1, comment: 'B', content: 'b', key: ['b'] } } }) })).body
  const [listed] = (await call('/api/worldbooks')).body
  assert.deepEqual([listed.name, listed.entries, listed.enabled, listed.constant], ['设定集', 2, 2, 1])

  const read = await call(`/api/worldbooks/${imported.id}`)
  assert.deepEqual(read.body.entries.map(e => e.comment), ['A', 'B'])
  const edited = await call(`/api/worldbooks/${imported.id}`, { method: 'PUT', body: { entries: [{ uid: '1', content: 'bb', keys: ['b', 'bee'] }], remove: ['0'] } })
  assert.equal(edited.body.prefix, true, 'the constant entry went')
  assert.deepEqual(edited.body.entries.map(e => [e.comment, e.content, e.keys]), [['B', 'bb', ['b', 'bee']]])
  const again = (await call('/api/worldbooks')).body[0]
  assert.deepEqual([again.entries, again.enabled, again.constant], [1, 1, 0])
  assert.equal((await call('/api/worldbooks/nothere')).status, 404)
})

test('an open chat keeps the constant text it started with until its prefix is applied again', async t => {
  const { call, upload } = await tavern(t)
  const card = (await call('/api/cards/import', { method: 'POST', body: upload('c.json', CARD) })).body
  const chat = (await call('/api/chats', { method: 'POST', body: { cardId: card.id } })).body
  assert.match((await call(`/api/chats/${chat.id}/prompt`)).body.systemPrompt, /王都终年下雪。/)

  await call(`/api/cards/${card.id}/book`, { method: 'PUT', body: { entries: [{ uid: '0', content: '王都四季如春。' }] } })
  const before = (await call(`/api/chats/${chat.id}/prompt`)).body.systemPrompt
  assert.match(before, /王都终年下雪。/, 'the frozen prefix is the old one')
  assert.doesNotMatch(before, /四季如春/)

  await call(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
  const after = (await call(`/api/chats/${chat.id}/prompt`)).body.systemPrompt
  assert.match(after, /王都四季如春。/)
  assert.doesNotMatch(after, /终年下雪/)
})
