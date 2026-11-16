// 递归触发 (worldbook.mjs triggeredEntries): what keyword entries find finds more, by SillyTavern's switches.
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBook, recursionFlags, triggeredEntries, worldFile } from '../server/worldbook.mjs'
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
  editBook(world, { entries: [{ uid: a, send: 'near', excludeRecursion: true }] })
  assert.deepEqual(world.entries[1].extra, { cicaSend: 'near', excludeRecursion: true })
  editBook(world, { entries: [{ uid: a, send: 'turn', excludeRecursion: false }] })
  assert.equal(world.entries[1].extra, undefined)
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
