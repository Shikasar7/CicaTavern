import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cardSummary, exportCard, importOwnCard, normalizeCard, parseCardFile, readPngText } from '../server/cards.mjs'
import { normalizeBook, triggeredEntries, initialState, constantEntries } from '../server/worldbook.mjs'
import { applyStateUpdates, displayText, parseArgs } from '../server/state.mjs'
import { buildSystemPrompt, buildTurnPrompt, renderEntry, replaceMacros } from '../server/prompt.mjs'
import { initTemplates } from '../server/template.mjs'
import { createStore } from '../server/store.mjs'
import { createChat, activePath, selectNode, chatView, foldedTurns, restoreFolded, rollbackTo, forkChat } from '../server/chats.mjs'
import { createApp } from '../server/http.mjs'

before(() => initTemplates())

// ─── PNG fixture ────────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}
function pngWith(textChunks) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const idat = deflateSync(Buffer.from([0, 255, 255, 255]))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...textChunks,
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const SAMPLE_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '小雨',
    description: '{{char}}是街角咖啡店的店员，说话软糯，喜欢给{{user}}推荐新品。',
    personality: '温柔、有点迷糊',
    scenario: '清晨的咖啡店',
    first_mes: '（{{char}}抬起头）欢迎光临～{{user}}，今天也是拿铁吗？',
    alternate_greetings: ['（打烊前）啊，{{user}}，差点就关门了呢。'],
    mes_example: '<START>\n{{user}}: 有什么推荐？\n{{char}}: 桂花拿铁！',
    system_prompt: '{{original}}保持轻松治愈的基调。',
    post_history_instructions: '',
    creator: 'tester',
    tags: ['日常'],
    character_book: {
      entries: [
        { keys: [], content: '咖啡店名叫「雨停」。', constant: true, enabled: true, insertion_order: 1, comment: '店名' },
        { keys: ['桂花'], content: '桂花拿铁是秋季限定。', constant: false, enabled: true, insertion_order: 5, comment: '桂花拿铁' },
        { keys: ['/老板/'], secondary_keys: ['生气'], selective: true, extensions: { selectiveLogic: 3 }, content: '老板其实很好说话。', enabled: true, insertion_order: 6, comment: '老板' },
        { keys: [], content: '好感度: 10\n位置: 咖啡店', constant: true, enabled: true, comment: '[initvar]初始变量' },
      ],
    },
  },
}

test('reads a V2 card out of PNG tEXt and prefers ccv3 when both exist', () => {
  const v2 = Buffer.from(JSON.stringify(SAMPLE_CARD)).toString('base64')
  const v3 = Buffer.from(JSON.stringify({ ...SAMPLE_CARD, spec: 'chara_card_v3', data: { ...SAMPLE_CARD.data, name: '小雨v3' } })).toString('base64')
  const png = pngWith([chunk('tEXt', Buffer.from(`chara\0${v2}`, 'latin1')), chunk('tEXt', Buffer.from(`ccv3\0${v3}`, 'latin1'))])
  assert.deepEqual(Object.keys(readPngText(png)).sort(), ['ccv3', 'chara'])
  const { raw, avatar } = parseCardFile('a.png', png)
  assert.equal(raw.data.name, '小雨v3')
  assert.ok(avatar)
  const card = normalizeCard(raw)
  assert.equal(card.alternateGreetings.length, 1)
  assert.equal(card.book.entries.length, 4)
})

test('rejects a PNG without card data', () => {
  assert.throws(() => parseCardFile('x.png', pngWith([])), /没有角色卡数据/)
})

test('worldbook: constants, keyword, regex + AND_ALL secondary, dedupe, initvar', () => {
  const card = normalizeCard(SAMPLE_CARD)
  const books = [{ ...card.book, id: 'b' }]
  assert.deepEqual(constantEntries(books).map(e => e.comment), ['店名'])
  assert.deepEqual(initialState(books), { 好感度: 10, 位置: '咖啡店' })
  const hit = triggeredEntries(books, '我想喝桂花的', new Set())
  assert.deepEqual(hit.map(h => h.entry.comment), ['桂花拿铁'])
  assert.equal(triggeredEntries(books, '桂花', new Set(['b:1'])).length, 0, 'recently injected entries are skipped')
  assert.equal(triggeredEntries(books, '老板来了', new Set()).length, 0, 'AND_ALL needs the secondary key')
  assert.equal(triggeredEntries(books, '老板生气了', new Set()).length, 1)
})

test('card summary counts its own book: entries, enabled, always-on among the enabled', () => {
  const raw = structuredClone(SAMPLE_CARD)
  raw.data.character_book.entries.push({ keys: [], content: '旧设定', constant: true, enabled: false, comment: '停用' })
  const summary = cardSummary(normalizeCard(raw))
  assert.deepEqual([summary.bookEntries, summary.bookEnabled, summary.bookConstant], [5, 4, 2])
  delete raw.data.character_book
  const bare = cardSummary(normalizeCard(raw))
  assert.deepEqual([bare.bookEntries, bare.bookEnabled, bare.bookConstant], [0, 0, 0])
})

test('standalone SillyTavern world file shape', () => {
  const book = normalizeBook({ entries: { 0: { uid: 0, key: ['龙'], content: '龙会喷火', disable: false, order: 10 }, 1: { uid: 1, key: ['x'], content: 'off', disable: true } } }, 'w')
  assert.equal(book.entries.length, 2)
  assert.equal(book.entries[1].enabled, false)
  assert.equal(triggeredEntries([book], '一条龙', new Set()).length, 1)
})

test('state: JSON patch and MVU _.set / _.add are parsed as data, never evaluated', () => {
  const reply = '正文。\n<state>{"好感度": 12, "位置": null, "物品": {"钥匙": 1}}</state>'
  const a = applyStateUpdates({ 好感度: 10, 位置: '店里' }, reply)
  assert.deepEqual(a.state, { 好感度: 12, 物品: { 钥匙: 1 } })
  const mvu = "<UpdateVariable>\n_.set('角色.小雨.好感', 10, 15);//变高了\n_.add('金钱', -5);\n_.set('标记', process.exit(1));\n</UpdateVariable>"
  const b = applyStateUpdates({ 角色: { 小雨: { 好感: [10, '好感度'] } }, 金钱: 20 }, mvu)
  assert.deepEqual(b.state, { 角色: { 小雨: { 好感: [15, '好感度'] } }, 金钱: 15 })
  assert.deepEqual(parseArgs(`'a', [1, "b"], {k: true}`), ['a', [1, 'b'], { k: true }])
  assert.equal(displayText(`你好<think>想</think>\n\n\n<state>{}</state>`), '你好')
})

test('prompt: stable prefix holds card + constants; tail holds per-turn material', () => {
  const card = normalizeCard(SAMPLE_CARD)
  const books = [{ ...card.book, id: 'b' }]
  const system = buildSystemPrompt({ card, persona: { name: '阿明', description: '常客' }, settings: { language: '简体中文', writingRules: '白描' }, books, hasState: true })
  assert.match(system, /小雨是街角咖啡店的店员/)
  assert.match(system, /阿明/)
  assert.match(system, /咖啡店名叫「雨停」/)
  assert.match(system, /<state>/, 'state protocol is included for non-MVU cards with state')
  assert.doesNotMatch(system, /桂花拿铁是秋季限定/, 'keyword entries stay out of the prefix')
  assert.doesNotMatch(system, /好感度: 10/, 'initvar entries stay out of the prompt')
  const names = { char: '小雨', user: '阿明' }
  const entries = triggeredEntries(books, '桂花', new Set()).map(hit => ({ title: hit.entry.comment, ...renderEntry(hit.entry, { state: {}, names }) }))
  const turn = buildTurnPrompt({ names, opening: '欢迎', entries, stateText: '{}', input: '来杯{{char}}推荐的' })
  assert.match(turn, /^<开场>/)
  assert.match(turn, /<世界书>[\s\S]*秋季限定[\s\S]*<当前状态>[\s\S]*<玩家输入>\n来杯小雨推荐的/)
  assert.equal(replaceMacros('{{//注释}}a{{random::x}}', { char: 'c', user: 'u' }), 'ax')
})

test('chat tree: create, branch selection and view', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard(SAMPLE_CARD)
  await store.saveCard(card)
  const chat = await createChat(store, card.id, 1)
  assert.match(chat.nodes.root.text, /打烊前/)
  assert.deepEqual(chat.nodes.root.state, { 好感度: 10, 位置: '咖啡店' })
  // Fake two alternative turns under the root.
  const at = iso => new Date(Date.UTC(2026, 0, 1, 0, 0, iso)).toISOString()
  chat.nodes.u1 = { id: 'u1', parent: 'root', role: 'user', text: 'A', createdAt: at(1) }
  chat.nodes.a1 = { id: 'a1', parent: 'u1', role: 'assistant', text: 'a', display: 'a', state: {}, createdAt: at(2) }
  chat.nodes.u2 = { id: 'u2', parent: 'root', role: 'user', text: 'B', createdAt: at(3) }
  chat.nodes.a2 = { id: 'a2', parent: 'u2', role: 'assistant', text: 'b', display: 'b', state: { x: 1 }, createdAt: at(4) }
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u2', 'a2'], 'newest child by default')
  selectNode(chat, 'a1')
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u1', 'a1'])
  const view = chatView(chat)
  assert.equal(view.path[1].siblingCount, 2)
  assert.equal(view.path[1].siblingIndex, 0)
})

test('chat tree: rollback folds later turns, restore and a new turn lift it', () => {
  const at = s => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const node = (id, parent, role, s, state) => ({ id, parent, role, text: id, display: id, state, createdAt: at(s) })
  const chat = {
    nodes: {
      root: node('root', null, 'assistant', 0, { hp: 10 }),
      u1: node('u1', 'root', 'user', 1),
      a1: node('a1', 'u1', 'assistant', 2, { hp: 8 }),
      u2: node('u2', 'a1', 'user', 3),
      a2: node('a2', 'u2', 'assistant', 4, { hp: 5 }),
      u3: node('u3', 'a2', 'user', 5),
      a3: node('a3', 'u3', 'assistant', 6, { hp: 1 }),
    },
    names: {}, systemPrompt: '',
  }
  rollbackTo(chat, 'a1')
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u1', 'a1'])
  assert.equal(foldedTurns(chat), 2)
  assert.deepEqual(chatView(chat).state, { hp: 8 }, 'state goes back with the turn')
  assert.throws(() => rollbackTo(chat, 'u2'), /叙述/)
  restoreFolded(chat)
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  assert.equal(foldedTurns(chat), 0)
  assert.throws(() => rollbackTo(chat, 'a3'), /最后一轮/)
  // Rolling back to the opening, then a new turn there: the old branch stays a sibling.
  rollbackTo(chat, 'root')
  assert.equal(foldedTurns(chat), 3)
  chat.nodes.u9 = node('u9', 'root', 'user', 9)
  chat.nodes.a9 = node('a9', 'u9', 'assistant', 10, { hp: 9 })
  selectNode(chat, 'a9')
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u9', 'a9'])
  assert.equal(chatView(chat).path[1].siblingCount, 2)
  selectNode(chat, 'u1')
  assert.deepEqual(activePath(chat).map(n => n.id), ['root', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3'], 'old branch comes back whole')
})

test('chat tree: forking keeps only the path to the reply, without later turns, swipes or SDK tips', () => {
  const at = s => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
  const node = (id, parent, role, s, extra = {}) => ({ id, parent, role, text: id, display: id, createdAt: at(s), ...extra })
  const chat = {
    id: 'orig',
    title: '林雪 · 10-04 12:00',
    names: { char: '林雪', user: '我' },
    systemPrompt: 'frozen',
    tips: { s1: 'm9' },
    nodes: {
      root: node('root', null, 'assistant', 0, { state: { hp: 10 } }),
      u1: node('u1', 'root', 'user', 1),
      a1: node('a1', 'u1', 'assistant', 2, { state: { hp: 8 }, sdk: { sessionId: 's1', uuid: 'm2' }, media: { images: [{ file: 'x.png' }] } }),
      a1b: node('a1b', 'u1', 'assistant', 3, { state: { hp: 7 } }),
      u2: node('u2', 'a1', 'user', 4),
      a2: node('a2', 'u2', 'assistant', 5, { state: { hp: 5 } }),
    },
  }
  selectNode(chat, 'a2')
  rollbackTo(chat, 'a1')
  const fork = forkChat(chat, 'a1')
  assert.notEqual(fork.id, 'orig')
  assert.deepEqual(Object.keys(fork.nodes).sort(), ['a1', 'root', 'u1'], 'later turns and the other swipe stay behind')
  assert.deepEqual(activePath(fork).map(n => n.id), ['root', 'u1', 'a1'])
  assert.equal(fork.nodes.a1.cut, undefined)
  assert.deepEqual(fork.tips, {}, 'the first turn forks the Claude session instead of writing into the original one')
  assert.equal(fork.systemPrompt, 'frozen')
  assert.equal(fork.title, '林雪 · 10-04 12:00（分支·第 1 轮）')
  assert.deepEqual(chatView(fork).state, { hp: 8 })
  assert.deepEqual(fork.forkedFrom.chatId, 'orig')
  fork.nodes.a1.text = 'changed'
  assert.equal(chat.nodes.a1.text, 'a1', 'the original is not shared')
  assert.equal(Object.keys(chat.nodes).length, 6)
  assert.equal(forkChat(fork, 'a1').title, '林雪 · 10-04 12:00（分支·第 1 轮）', 'no stacked suffixes')
  assert.throws(() => forkChat(chat, 'u1'), /叙述/)
})

test('http: import, list, create chat; guards reject foreign requests', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-http-'))
  const app = createApp({ dataRoot: root, proxy: 'off' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  const data = Buffer.from(JSON.stringify(SAMPLE_CARD)).toString('base64')

  const blocked = await fetch(`${base}/api/cards/import`, { method: 'POST', body: JSON.stringify({ filename: 'c.json', data }) })
  assert.equal(blocked.status, 403, 'mutations need the custom header')

  const imported = await (await fetch(`${base}/api/cards/import`, { method: 'POST', headers, body: JSON.stringify({ filename: 'c.json', data }) })).json()
  assert.equal(imported.name, '小雨')
  const cards = await (await fetch(`${base}/api/cards`)).json()
  assert.equal(cards.length, 1)
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST', headers, body: JSON.stringify({ cardId: imported.id }) })).json()
  assert.equal(chat.path.length, 1)
  assert.match(chat.path[0].text, /欢迎光临～你/)
  const html = await fetch(`${base}/`)
  assert.equal(html.status, 200)

  // A newer version: found by name, then updated in place (same id, chats and settings kept).
  const post = async (url, body) => (await fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) })).json()
  await fetch(`${base}/api/cards/${imported.id}/media`, { method: 'PUT', headers, body: JSON.stringify({ style: 'anime coloring' }) })
  const v2 = structuredClone(SAMPLE_CARD)
  ;(v2.data ?? v2).name = '小雨-v2'
  const data2 = Buffer.from(JSON.stringify(v2)).toString('base64')
  assert.deepEqual((await post('/api/cards/inspect', { filename: 'c.json', data: data2 })).previous, { id: imported.id, name: '小雨' })
  const updated = await post('/api/cards/import', { filename: 'c.json', data: data2, replace: imported.id })
  assert.deepEqual([updated.id, updated.name, updated.updated], [imported.id, '小雨-v2', '小雨'])
  assert.equal((await (await fetch(`${base}/api/cards`)).json()).length, 1)
  assert.equal((await (await fetch(`${base}/api/cards/${imported.id}/media`)).json()).style, 'anime coloring')
  assert.equal((await (await fetch(`${base}/api/chats?cardId=${imported.id}`)).json()).length, 1)
  // Kept as a separate card instead: it still takes over the settings.
  const copy = await post('/api/cards/import', { filename: 'c.json', data: data2 })
  assert.notEqual(copy.id, imported.id)
  assert.equal(copy.inherited, '小雨-v2')
  assert.equal((await (await fetch(`${base}/api/cards/${copy.id}/media`)).json()).style, 'anime coloring')
})

test('greeting <initvar> replaces the card initial state, then its update block applies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const raw = structuredClone(SAMPLE_CARD)
  const data = raw.data ?? raw
  data.alternate_greetings = [
    '第二幕\n<UpdateVariable>\n<initvar>\n好感度: 40\n位置: 码头\n</initvar>\n</UpdateVariable>',
    '第三幕\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感度","value":20}]</JSONPatch></UpdateVariable>',
  ]
  const card = normalizeCard(raw)
  await store.saveCard(card)
  assert.deepEqual((await createChat(store, card.id, 0)).nodes.root.state, { 好感度: 10, 位置: '咖啡店' })
  assert.deepEqual((await createChat(store, card.id, 1)).nodes.root.state, { 好感度: 40, 位置: '码头' })
  assert.deepEqual((await createChat(store, card.id, 2)).nodes.root.state, { 好感度: 20, 位置: '咖啡店' })
})

test('card export and import: edits to its data travel with its picture, settings stay behind', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '你好', character_book: { entries: [{ keys: ['a'], content: '旧规则', comment: '扮演准则' }] } } })
  card.book.entries[0].content = '新规则'
  card.media = { style: 'anime', roster: [] }
  card.worldbookIds = ['wb1']
  const file = Buffer.from(JSON.stringify(exportCard(card, Buffer.from('PNGDATA'))))
  const { card: copy, avatar } = importOwnCard(parseCardFile('林雪.json', file).raw)
  assert.notEqual(copy.id, card.id)
  assert.equal(copy.book.entries[0].content, '新规则')
  assert.equal(avatar.toString(), 'PNGDATA')
  assert.equal(copy.hasAvatar, true)
  assert.equal(copy.media, undefined, 'picture settings are applied by the importing side')
  assert.deepEqual(copy.worldbookIds, [], 'worldbooks of the other device are not here')
  assert.equal(importOwnCard({ spec: 'chara_card_v2', data: { name: 'x' } }), null)
  assert.throws(() => importOwnCard({ format: 'agent-tavern-card', card: { name: ' ' } }), /不完整/)
})

test('视觉小说格式: asked for in the turn\'s message only, after the preset\'s block and before the reminder', () => {
  const names = { char: '小雨', user: '阿明' }
  const turn = buildTurnPrompt({ names, input: '你好', presetText: '写短一点', reminder: '照规则', marks: true })
  assert.match(turn, /<\/预设指令>\n\n<对白格式>\n[\s\S]*【名字\|表情】「台词」[\s\S]*平静、微笑、开心、害羞、生气、难过、惊讶、思考[\s\S]*震屏、闪白、跳动、发抖[\s\S]*<\/对白格式>\n\n<本轮提醒>/)
  assert.doesNotMatch(buildTurnPrompt({ names, input: '你好' }), /对白格式/)
})
