// Regex scripts placed on worldbook text (SillyTavern's WORLD_INFO), and the books a card's HTML makes for its chat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { constantEntries, normalizeBook } from '../server/worldbook.mjs'
import { drawnEntries, fixedWorldBooks, renderEntry } from '../server/prompt.mjs'
import { bookNames, chatBooks, createChatBook, withChatChanges, writeChatBook } from '../server/frames.mjs'
import { normalizeScripts, PLACEMENT, worldScripts } from '../web/shared/regex.js'

const script = (findRegex, replaceString, extra = {}) => ({ scriptName: findRegex, findRegex, replaceString, placement: [PLACEMENT.WORLD_INFO], promptOnly: true, ...extra })
const names = { char: '卡', user: '阿明' }
const book = entries => ({ ...normalizeBook({ entries }, '世界', { standalone: true }), id: 'b1' })

test('only an enabled prompt script placed on worldbook text runs there, as in SillyTavern', () => {
  const list = normalizeScripts([
    script('甲', '1'),
    script('乙', '2', { promptOnly: false }),
    script('丙', '3', { disabled: true }),
    script('丁', '4', { placement: [PLACEMENT.AI_OUTPUT] }),
  ])
  assert.deepEqual(worldScripts(list).map(s => s.findRegex), ['甲'])
  const entry = { content: '甲乙丙丁', position: 0 }
  assert.equal(renderEntry(entry, { state: {}, names, session: { render: text => ({ text, error: null }) }, scripts: list }).text, '1乙丙丁')
})

test('a worldbook script runs after the entry\'s macros and fills the macros it writes', () => {
  const list = normalizeScripts([script('\\[谁\\]', '{{user}}和{{random::乙}}')])
  const entry = { content: '{{char}}遇到[谁]', position: 0 }
  assert.equal(renderEntry(entry, { state: {}, names, session: { render: text => ({ text, error: null }) }, scripts: list }).text, '卡遇到阿明和乙')
})

test('a worldbook script\'s depth limits read an @depth entry\'s depth, and no other entry has one', () => {
  const list = normalizeScripts([script('甲', '乙', { minDepth: 3 })])
  const run = entry => renderEntry(entry, { state: {}, names, session: { render: text => ({ text, error: null }) }, scripts: list }).text
  assert.equal(run({ content: '甲', position: 4, extra: { depth: 2 } }), '甲')
  assert.equal(run({ content: '甲', position: 4, extra: { depth: 3 } }), '乙')
  assert.equal(run({ content: '甲', position: 0 }), '乙')
})

test('a drawing script leaves the prefix\'s entries as written and gives each turn the lines it changed', () => {
  const books = [book({
    0: { uid: 0, key: [], content: '规则一\n偶遇[人]\n规则二', constant: true, order: 1, position: 0, comment: '遭遇' },
    1: { uid: 1, key: [], content: '末尾偶遇[人]', constant: true, order: 2, position: 4, depth: 2, comment: '末尾遭遇' },
    2: { uid: 2, key: [], content: '不相干', constant: true, order: 3, position: 0, comment: '规则' },
  })]
  const scripts = normalizeScripts([script('\\[人\\]', '{{random::甲}}')])
  assert.equal(fixedWorldBooks(books, scripts, names), books, 'the prefix does not freeze a draw')
  assert.deepEqual(drawnEntries(books, scripts, names), [{ title: '遭遇', text: '偶遇甲' }, { title: '末尾遭遇', text: '末尾偶遇甲' }])
  assert.deepEqual(drawnEntries(books, [], names), [])
  assert.deepEqual(drawnEntries(books, normalizeScripts([script('没有', '{{random::甲}}')]), names), [], 'one that matches nothing adds nothing')
})

test('a script that always writes the same goes into the prefix, and a draw is read after it', () => {
  const books = [book({ 0: { uid: 0, key: [], content: '{{user}}在旧城遇到[人]', constant: true, order: 1, position: 0, comment: '遭遇' } })]
  const scripts = normalizeScripts([script('旧城', '新城'), script('\\[人\\]', '{{roll:1d1}}号')])
  assert.deepEqual(constantEntries(fixedWorldBooks(books, scripts, names)).map(e => e.content), ['阿明在新城遇到[人]'])
  assert.equal(books[0].entries[0].content, '{{user}}在旧城遇到[人]', 'the book itself is not changed')
  assert.deepEqual(drawnEntries(books, scripts, names), [{ title: '遭遇', text: '阿明在新城遇到1号' }])
})

test('a card makes a book for its chat: empty as stored, in use by name, its entries the chat\'s', () => {
  const chat = {}
  const own = { ...book({ 0: { uid: 0, key: [], content: '设定', constant: true, order: 1, position: 0 } }), id: 'card-c1', name: '卡的书' }
  assert.equal(createChatBook(chat, '开局', [own]), true)
  assert.equal(createChatBook(chat, '开局', [own, ...chatBooks(chat)]), false, 'a name the chat has is not made again')
  assert.equal(createChatBook(chat, '卡的书', [own, ...chatBooks(chat)]), false)
  assert.throws(() => createChatBook(chat, ' ', [own]), /要有名字/)
  const [made] = chatBooks(chat)
  assert.match(made.id, /^chat-/)

  const written = writeChatBook(chat, made, [{ name: '出生地', content: '玄天界', strategy: { type: 'constant' } }])
  assert.equal(written.prefix, true, 'its constant entry goes into the prefix')
  assert.deepEqual(made.entries, [], 'the entries are the chat\'s changes')
  const [seen] = withChatChanges([made], chat)
  assert.deepEqual(seen.entries.map(e => [e.comment, e.content, e.constant]), [['出生地', '玄天界', true]])
  assert.deepEqual(bookNames([own], { id: 'c1' }, [], chat).chat, ['开局'])
})

test('a chat stops at the most books a card may make there', () => {
  const chat = {}
  for (let i = 0; i < 20; i++) assert.equal(createChatBook(chat, `书${i}`, chatBooks(chat)), true)
  assert.throws(() => createChatBook(chat, '再一本', chatBooks(chat)), /太多了/)
})

test('through the app: the draw is new each turn, and a book the card makes reaches the prompt in this chat only', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-worldregex-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  const store = createStore(dataRoot)
  await store.init()
  const pool = Array.from({ length: 40 }, (_, i) => `候选${i}`).join('::')
  const card = normalizeCard({
    spec: 'chara_card_v3',
    data: {
      name: '道',
      first_mes: '开始',
      character_book: { entries: [{ id: 0, keys: [], content: '本轮偶遇【[NPC]】', constant: true, enabled: true, insertion_order: 1, comment: '遭遇', extensions: { position: 4, depth: 2 } }] },
      extensions: { regex_scripts: [script('\\[NPC\\]', `{{random::${pool}}}`)] },
    },
  })
  await store.saveCard(card)
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(() => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json()
    assert.ok(res.ok, JSON.stringify(json))
    return json
  }
  const started = await call('POST', '/api/chats', { cardId: card.id })
  const other = await call('POST', '/api/chats', { cardId: card.id })
  const saved = await store.getChat(started.id)
  assert.match(saved.systemPrompt, /本轮偶遇【\[NPC\]】/, 'the rule stays in the prefix, not frozen at a first draw')

  const draws = new Set()
  for (let i = 0; i < 12; i++) {
    const { prompt } = await call('POST', `/api/chats/${started.id}/preview`, { parentId: 'root', input: '走' })
    const text = JSON.stringify(prompt)
    draws.add(/候选\d+/.exec(text)?.[0])
  }
  assert.ok(draws.size > 1 && !draws.has(undefined), `drawn: ${[...draws]}`)

  assert.deepEqual(await call('PUT', `/api/chats/${started.id}/worldbook`, { action: 'create', name: '开局创建' }), { created: true })
  assert.deepEqual(await call('PUT', `/api/chats/${started.id}/worldbook`, { action: 'create', name: '开局创建' }), { created: false })
  assert.deepEqual((await call('GET', `/api/chats/${started.id}/frame-info`)).books.chat, ['开局创建'])
  assert.deepEqual((await call('POST', `/api/chats/${started.id}/worldbook`, { name: '开局创建' })).entries, [])
  const written = await call('PUT', `/api/chats/${started.id}/worldbook`, { action: 'replace', name: '开局创建', entries: [{ name: '天定道侣', content: '青梅竹马的师姐', strategy: { type: 'constant' } }] })
  assert.equal(written.prefix, true)
  assert.match((await store.getChat(started.id)).systemPrompt, /青梅竹马的师姐/)
  assert.doesNotMatch((await store.getChat(other.id)).systemPrompt, /青梅竹马的师姐/, 'the card\'s other chats do not have it')
  assert.deepEqual((await call('GET', `/api/chats/${other.id}/frame-info`)).books.chat, [])
})
