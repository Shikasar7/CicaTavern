// 递归触发 (worldbook.mjs triggeredEntries): what keyword entries find finds more, by SillyTavern's switches.
import assert from 'node:assert/strict'
import test from 'node:test'
import { depthOf, editBook, normalizeBook, recursionFlags, triggeredEntries, worldFile } from '../server/worldbook.mjs'
import { normalizeCard } from '../server/cards.mjs'

const book = entries => normalizeBook({ name: '书', entries: Object.fromEntries(entries.map((entry, uid) => [uid, { uid, ...entry }])) }, 'x', { standalone: true })
// Recursion is off unless asked for (设置 → 扫描与状态): these ask for it, but where they say otherwise.
const found = (books, text, options = { recursion: 'keyword' }) => triggeredEntries(books, text, new Set(), options).map(hit => hit.entry.comment)

test('entries found by keyword find the entries their text names, level by level', () => {
  const world = book([
    { comment: '城', key: ['青石城'], content: '青石城有一座钟楼。' },
    { comment: '钟楼', key: ['钟楼'], content: '钟楼里住着守钟人。' },
    { comment: '守钟人', key: ['守钟人'], content: '一个老人。' },
    { comment: '无关', key: ['海港'], content: '海港很远。' },
  ])
  assert.deepEqual(found([world], '我们到了青石城。'), ['城', '钟楼', '守钟人'])
  assert.deepEqual(found([world], '我们到了青石城。', { recursion: 'off' }), ['城'])
  const levels = triggeredEntries([world], '我们到了青石城。', new Set(), { recursion: 'keyword' }).map(hit => hit.level ?? 0)
  assert.deepEqual(triggeredEntries([world], '我们到了青石城。', new Set()).map(hit => hit.entry.comment), ['城'], 'off unless asked for')
  assert.deepEqual(levels, [0, 1, 2])
})

test('the three switches: not found through others, finds none, found only through others', () => {
  const world = book([
    { comment: '城', key: ['青石城'], content: '青石城有钟楼和密道。' },
    { comment: '钟楼', key: ['钟楼'], content: '钟楼。', excludeRecursion: true },
    { comment: '密道', key: ['密道'], content: '密道通向地牢。', preventRecursion: true },
    { comment: '地牢', key: ['地牢'], content: '地牢。' },
    { comment: '暗号', key: ['暗号'], content: '暗号是三长两短。', delayUntilRecursion: true },
    { comment: '信', key: ['信'], content: '信里写着暗号。' },
  ])
  // 钟楼 is not found through 城; 密道 is, but finds nothing; 地牢 so stays out.
  assert.deepEqual(found([world], '青石城'), ['城', '密道'])
  // Said by the player, 钟楼 comes; 暗号 does not (only through another entry).
  assert.deepEqual(found([world], '钟楼 暗号'), ['钟楼'])
  // Through 信, 暗号 comes.
  assert.deepEqual(found([world], '一封信'), ['信', '暗号'])
  assert.deepEqual(recursionFlags(world.entries[4]), { exclude: false, prevent: false, delay: 1 })
})

test('a book that names itself in a ring stops; one still in recent turns is not sent again and finds nothing new', () => {
  const ring = book([
    { comment: '甲', key: ['甲'], content: '甲认识乙。' },
    { comment: '乙', key: ['乙'], content: '乙认识丙。' },
    { comment: '丙', key: ['丙'], content: '丙认识甲。' },
  ])
  assert.deepEqual(found([ring], '甲来了'), ['甲', '乙', '丙'])
  const recent = new Set([`${ring.id}:0`])
  assert.deepEqual(triggeredEntries([ring], '甲来了', recent, { recursion: 'keyword' }).map(hit => hit.entry.comment), [])
})

test('recursion adds at most ten entries and 8000 characters a turn, nearer levels and smaller 顺序 first', async () => {
  const { RECURSION_BUDGET } = await import('../server/worldbook.mjs')
  // One entry naming thirty others: one name would bring all of them.
  const town = book([
    { comment: '镇', key: ['小镇'], content: Array.from({ length: 30 }, (_, i) => `人${i}号`).join('、'), order: 500 },
    ...Array.from({ length: 30 }, (_, i) => ({ comment: `人${i}`, key: [`人${i}号`], content: '镇上的人。', order: 200 - i })),
  ])
  const hits = found([town], '到了小镇')
  assert.equal(hits.length, 1 + RECURSION_BUDGET.entries)
  // The smallest 顺序 first: 人29 (171) … 人20 (180).
  assert.deepEqual(hits.slice(0, 2), ['人29', '人28'])
  assert.equal(hits.at(-1), '镇')
  // Long ones: the characters run out first.
  const long = book([
    { comment: '城', key: ['城'], content: '城里有甲乙。' },
    { comment: '甲', key: ['甲'], content: '甲'.repeat(5000), order: 1 },
    { comment: '乙', key: ['乙'], content: '乙'.repeat(5000), order: 2 },
  ])
  assert.deepEqual(found([long], '进城'), ['甲', '城'], 'the first within 8000 characters, by 顺序; the second waits')
})

test('a novel\'s book does not set off the rest of itself', async () => {
  const { novelBook } = await import('../server/forge/novel.mjs')
  const novel = novelBook('雨宿', [
    { type: '人物', name: '林小雨', aliases: [], content: '在便利店躲雨，认识王店长。' },
    { type: '人物', name: '王店长', aliases: [], content: '晴空便利店的店长。' },
  ])
  assert.ok(novel.entries.every(entry => recursionFlags(entry).prevent))
  assert.deepEqual(found([novel], '林小雨来了'), ['人物：林小雨'])
})

test('the always-on entries\' text finds more only when asked for (as SillyTavern does)', () => {
  const world = book([
    { comment: '设定', key: [], constant: true, content: '故事发生在青石城。' },
    { comment: '城', key: ['青石城'], content: '青石城。' },
  ])
  assert.deepEqual(found([world], '你好'), [])
  assert.deepEqual(found([world], '你好', { recursion: 'all' }), ['城'])
  // 不触发别的条目, on an always-on entry: set on the page, it brings nothing along, and the prefix stays as it was.
  const set = editBook(world, { entries: [{ uid: world.entries[0].uid, preventRecursion: true }] })
  assert.equal(set.prefix, false)
  assert.deepEqual(found([world], '你好', { recursion: 'all' }), [])
  assert.deepEqual(found([world], '进了青石城', { recursion: 'all' }), ['城'])
})

test('the switches come from a card\'s book too, and go back out with it', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', character_book: { entries: [{ id: 1, keys: ['暗号'], content: 'x', extensions: { delay_until_recursion: true, exclude_recursion: true } }] } } })
  assert.deepEqual(recursionFlags(card.book.entries[0]), { exclude: true, prevent: false, delay: 1 })
  const world = book([{ comment: 'a', key: ['a'], content: 'a', preventRecursion: true }])
  assert.equal(Object.values(worldFile(world).entries)[0].preventRecursion, true)
})

test('拖动调整顺序 moves an entry in the list; 发送位置 and the switches are set from the editor', async () => {
  const { editBook } = await import('../server/worldbook.mjs')
  const world = book([
    { comment: '甲', key: ['甲'], content: 'a' },
    { comment: '乙', key: ['乙'], content: 'b' },
    { comment: '丙', key: [], constant: true, content: 'c' },
    { comment: '丁', key: [], constant: true, content: 'd' },
  ])
  const [a, b, c, d] = world.entries.map(entry => entry.uid)
  // Keyword entries only: the prefix is as it was.
  assert.equal(editBook(world, { arrange: [b, a] }).prefix, false)
  assert.deepEqual(world.entries.map(entry => entry.comment), ['乙', '甲', '丙', '丁'])
  // Two constant ones of the same 顺序 swapped: the prefix changes.
  assert.equal(editBook(world, { arrange: [b, a, d, c] }).prefix, true)
  assert.deepEqual(world.entries.map(entry => entry.comment), ['乙', '甲', '丁', '丙'])
  // 位置 聊天中 @深度 and its depth, with the switches.
  editBook(world, { entries: [{ uid: a, position: 4, depth: 0, excludeRecursion: true }] })
  assert.equal(world.entries[1].position, 4)
  assert.deepEqual(world.entries[1].extra, { depth: 0, excludeRecursion: true })
  assert.equal(depthOf(world.entries[1]), 0)
  editBook(world, { entries: [{ uid: a, depth: 99999 }] })
  assert.equal(depthOf(world.entries[1]), 9999)
  editBook(world, { entries: [{ uid: a, position: 0, excludeRecursion: false }] })
  assert.equal(depthOf(world.entries[1]), null)
  // An entry set 紧挨着回复 before there was @深度 is @深度 0; set somewhere again, it is that.
  const old = book([{ comment: '灯', key: ['灯'], content: 'x', cicaSend: 'near' }])
  assert.equal(depthOf(old.entries[0]), 0)
  editBook(old, { entries: [{ uid: old.entries[0].uid, position: 4 }] })
  assert.deepEqual(old.entries[0].extra, { depth: 0 })
  editBook(old, { entries: [{ uid: old.entries[0].uid, depth: 3 }] })
  assert.equal(depthOf(old.entries[0]), 3)
})

test('聊天中 @深度 comes from a card\'s book and a world file, and goes back out with them', () => {
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', character_book: { entries: [
    { id: 1, keys: ['暗号'], content: 'x', extensions: { position: 4, depth: 2 } },
    { id: 2, keys: ['口令'], content: 'y', extensions: { position: 0, depth: 4 } },
  ] } } })
  assert.equal(depthOf(card.book.entries[0]), 2)
  assert.equal(depthOf(card.book.entries[1]), null)
  // A depth not said: SillyTavern's 4.
  const world = book([{ comment: 'a', key: ['a'], content: 'a', position: 4 }, { comment: 'b', key: ['b'], content: 'b', position: 4, depth: 7 }])
  assert.deepEqual(world.entries.map(depthOf), [4, 7])
  assert.equal(Object.values(worldFile(world).entries)[1].depth, 7)
})

test('lore sent 紧挨着回复 goes after the input, again each turn it is found, and only on the newest message', async t => {
  const { createServer } = await import('node:http')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { activePath, createChat } = await import('../server/chats.mjs')
  const { createEngine } = await import('../server/engine.mjs')
  const { normalizeProvider } = await import('../server/providers.mjs')
  const { createStore } = await import('../server/store.mjs')
  const bodies = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '灯笼晃了晃。' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-near-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', scanDepth: 4 })
  const lore = book([
    { comment: '灯笼', key: ['灯笼'], content: '灯笼是红的。', cicaSend: 'near' },
    { comment: '街', key: ['长街'], content: '长街很长。' },
  ])
  await store.saveBook(lore)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '雪下了一整夜。' } })
  card.worldbookIds = [lore.id]
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return bodies.at(-1).messages.filter(message => message.role === 'user').map(message => String(message.content))
  }
  const first = await turn('灯笼和长街')
  assert.match(first.at(-1), /<世界书>[\s\S]*长街很长[\s\S]*<玩家输入>[\s\S]*<世界书·紧挨回复>\n【灯笼】\n灯笼是红的。/)
  // Next turn: the lamp again (the story still says it), the street not (still in the history); the older message
  // goes without its lamp.
  const second = await turn('往前走')
  assert.match(second.at(-1), /<世界书·紧挨回复>[\s\S]*灯笼是红的/)
  assert.doesNotMatch(second.at(-1), /长街很长/)
  assert.ok(second.slice(0, -1).every(message => !message.includes('世界书·紧挨回复')))
  assert.ok(second.slice(0, -1).some(message => message.includes('长街很长')), 'the street stays where it was sent')
})

test('聊天中 @深度 goes that many messages before the end, as text in a user message, and says where the cache stops', async () => {
  const { placeDeep, takeDeep } = await import('../server/prompt.mjs')
  const messages = ['u0', 'a1', 'u2', 'a3', 'u4'].map(content => ({ role: content[0] === 'u' ? 'user' : 'assistant', content }))
  const { messages: out, moved } = placeDeep(messages, [{ depth: 9999, text: 'X' }, { depth: 2, text: 'Y' }, { depth: 3, text: 'Z' }, { depth: 1, text: 'W' }])
  assert.deepEqual(out.map(message => message.content), ['X\n\nu0', 'a1', 'Z\n\nu2\n\nY', 'a3', 'W\n\nu4'])
  // The top stays the top next turn; the message at depth 3 is the first that reads differently then.
  assert.equal(moved, 2)
  assert.equal(messages[0].content, 'u0', 'the messages given are left as they were')
  // Deeper than the story now, but not next turn: it moves.
  assert.equal(placeDeep(messages, [{ depth: 6, text: 'V' }]).moved, 0)
  const taken = takeDeep('<世界书 深度="3">\n【钟】\n钟声。\n</世界书>\n\n<预设指令 深度="2">\n慢一点。\n</预设指令>\n\n<玩家输入>\n走\n</玩家输入>')
  assert.equal(taken.text, '<玩家输入>\n走\n</玩家输入>')
  assert.deepEqual(taken.deep.map(item => item.depth), [3, 2])
  assert.match(taken.deep[0].text, /^<世界书 深度="3">\n【钟】\n钟声。\n<\/世界书>$/)
})

test('lore at @深度 goes there each turn it is sent, out of the older messages; constant ones each turn', async t => {
  const { createServer } = await import('node:http')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { activePath, createChat } = await import('../server/chats.mjs')
  const { createEngine } = await import('../server/engine.mjs')
  const { normalizeProvider } = await import('../server/providers.mjs')
  const { createStore } = await import('../server/store.mjs')
  const bodies = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    bodies.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '风过长街。' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-depth-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', scanDepth: 4 })
  const lore = book([
    { comment: '钟', key: ['钟楼'], content: '钟声悠长。', position: 4, depth: 2 },
    { comment: '规矩', key: [], constant: true, content: '每轮写满三段。', position: 4, depth: 1 },
    { comment: '街', key: ['长街'], content: '长街很长。' },
  ])
  await store.saveBook(lore)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', first_mes: '雪下了一整夜。' } })
  card.worldbookIds = [lore.id]
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  assert.doesNotMatch((await store.getChat(chat.id)).systemPrompt, /每轮写满三段/, 'not in the prefix')
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return bodies.at(-1).messages.filter(message => message.role !== 'system').map(message => String(message.content))
  }
  // The first turn: the story is that one message, both at its top, deeper first.
  const first = await turn('钟楼和长街')
  assert.match(first.at(-1), /^<世界书 深度="2">\n【钟】\n钟声悠长。\n<\/世界书>\n\n<世界书 深度="1">\n【规矩】\n每轮写满三段。\n<\/世界书>[\s\S]*<世界书>\n【街】\n长街很长。/)
  // Kept with the turn as written (the subscription sends it so).
  assert.match(activePath(await store.getChat(chat.id)).at(-2).prompt, /^<世界书 深度="2">/)
  const second = await turn('往前走')
  assert.equal(second.length, 3)
  // @深度 2: before the reply before the newest, so at the end of the message before it; @深度 1: before the newest.
  assert.match(second[0], /<玩家输入>\n钟楼和长街\n<\/玩家输入>[\s\S]*\n\n<世界书 深度="2">\n【钟】\n钟声悠长。\n<\/世界书>$/)
  assert.doesNotMatch(second[0], /每轮写满三段/)
  assert.match(second[2], /^<世界书 深度="1">\n【规矩】\n每轮写满三段。/)
  assert.equal((second[2].match(/钟声悠长/g) ?? []).length, 0)
})
