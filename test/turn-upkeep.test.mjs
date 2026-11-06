// What a turn does around the story: naming the blocks a card asks for, filling in a left-out
// update block on its own, and keeping the state to the card's schema.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { everyTurnReminder, replyBlocks } from '../server/prompt.mjs'
import { closeSchema } from '../server/schema.mjs'

const rule = (uid, comment, content, extra = {}) => ({ uid, comment, content, keys: [], constant: true, enabled: true, order: uid, position: 4, ...extra })
const script = findRegex => ({ findRegex, replaceString: '', placement: [2], disabled: false })

test('a block a rule asks for and a regex handles is named; a wrapper, markup and the update block are not', () => {
  const entries = [
    rule(0, '审查', '思考放进 <audit>…</audit> 标签。'),
    rule(1, '判定', '战斗时在正文后输出：\n<judge>\n[胜者|名字]\n</judge>'),
    rule(2, '规则', '<update_rules>\n写法见下\n</update_rules>'),
    rule(3, '样式', '<div>标题</div>'),
    rule(4, '变量', '结尾写 <UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>'),
    rule(5, '只提一半', '可以写 <note> 开头。'),
  ]
  const scripts = [script('<audit>[\\s\\S]*?</audit>'), script('/<judge>([\\s\\S]*?)<\\/judge>/g'), script('<div>'), script('<note>'), script('<UpdateVariable>')]
  assert.deepEqual(replyBlocks(entries, scripts), ['audit', 'judge'])
  assert.deepEqual(replyBlocks(entries, []), [], 'a tag no script handles may be the rule\'s own wrapper')
  assert.deepEqual(replyBlocks(entries, [{ ...script('<audit>'), disabled: true }]), [])
})

test('the turn\'s reminder names those blocks, and the update block after the choices', () => {
  const books = [{ id: 'b', entries: [rule(0, '审查', '思考放进 <audit>…</audit> 标签。')] }]
  const prefix = '## 每轮回复都要遵守\n【审查】\n…'
  const reminder = everyTurnReminder(prefix, books, { mvu: true, choices: true, scripts: [script('<audit>')] })
  assert.match(reminder, /规则要求写出来的块 <audit>…<\/audit>/)
  assert.match(reminder, /写完选项也要接着写/)
  assert.doesNotMatch(everyTurnReminder(prefix, books, { mvu: true }), /规则要求写出来的块|写完选项/, 'without them it reads as before')
})

const UPDATE = '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/体力","value":180}]</JSONPatch>\n</UpdateVariable>'
const SCHEMA = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\nexport const Schema = z.object({ 体力: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(50) });\n$(() => { registerMvuSchema(Schema); });"

/** A provider that leaves the block out of the story; `fills` says what it answers when asked for it. */
async function provider(t, { story = '她点点头。', fills = true } = {}) {
  const asked = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    asked.push(body)
    const filling = /漏写/.test(body)
    const text = filling ? (fills ? `好的。\n${UPDATE}` : '我不写。') : story
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  return { asked, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

async function app(t, fake, { settings = {}, helper = null, rules = null } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-upkeep-'))
  t.after(() => rm(dataRoot, { recursive: true, force: true }))
  t.after(closeSchema)
  const store = createStore(dataRoot)
  await store.init()
  const made = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test-1234567890abcd', models: [{ id: 'm1' }] })
  await store.saveProviders([made])
  await store.saveSettings({ model: `${made.id}/m1`, subscription: 'off', ...settings })
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
      name: '小雨',
      first_mes: '你好',
      character_book: { entries: [
        { id: 0, comment: '[InitVar]初始变量', content: '体力: 50', keys: [], constant: true, enabled: false },
        { id: 1, comment: '[mvu_update]变量输出格式', content: '每次回复结尾输出 <UpdateVariable><JSONPatch>…</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true },
      ] },
      extensions: helper ? { tavern_helper: { scripts: [helper] } } : {},
    },
  })
  await store.saveCard(card)
  const server = await createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const listening = await server.listen({ port: 0 })
  t.after(() => {
    server.network.stop()
    listening.closeAllConnections?.()
    listening.close()
  })
  const base = `http://127.0.0.1:${listening.address().port}`
  const headers = { 'content-type': 'application/json', 'x-agent-tavern': '1' }
  if (rules) await fetch(`${base}/api/cards/${card.id}/game`, { method: 'PUT', headers, body: JSON.stringify({ level: rules }) })
  const chat = await (await fetch(`${base}/api/chats`, { method: 'POST', headers, body: JSON.stringify({ cardId: card.id }) })).json()
  const turn = async () => {
    const text = await (await fetch(`${base}/api/chats/${chat.id}/turn`, { method: 'POST', headers, body: JSON.stringify({ parentId: 'root', input: '走吧' }) })).text()
    return text.split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  }
  const putState = async state => (await fetch(`${base}/api/chats/${chat.id}/state`, { method: 'PUT', headers, body: JSON.stringify({ state }) })).json()
  return { turn, putState }
}

const tipOf = events => events.find(e => e.type === 'done').chat.path.at(-1)

test('a reply without its update block gets one before the turn is done', async t => {
  const fake = await provider(t)
  const { turn } = await app(t, fake)
  const events = await turn()
  assert.ok(events.some(e => e.type === 'filling'))
  const tip = tipOf(events)
  assert.equal(tip.state.体力, 180)
  assert.equal(fake.asked.length, 2)
})

test('自动补写 off: the reply stays as it came', async t => {
  const fake = await provider(t)
  const { turn } = await app(t, fake, { settings: { autoFillUpdate: false } })
  const events = await turn()
  assert.ok(!events.some(e => e.type === 'filling'))
  assert.equal(tipOf(events).state.体力, 50)
  assert.equal(fake.asked.length, 1)
})

test('a reply that wrote its block is not asked again', async t => {
  const fake = await provider(t, { story: `她点点头。\n${UPDATE}` })
  const { turn } = await app(t, fake)
  assert.ok(!(await turn()).some(e => e.type === 'filling'))
  assert.equal(fake.asked.length, 1)
})

test('a fill that fails costs the turn nothing', async t => {
  const fake = await provider(t, { fills: false })
  const { turn } = await app(t, fake)
  const events = await turn()
  assert.ok(events.some(e => e.type === 'filling'))
  assert.ok(!events.some(e => e.type === 'error'))
  assert.equal(tipOf(events).text ?? tipOf(events).display, '她点点头。')
})

test('the card\'s schema holds the update, in a turn and in a fill', async t => {
  const helper = { name: 'Zod', content: SCHEMA, enabled: true }
  const wrote = await provider(t, { story: `她点点头。\n${UPDATE}` })
  assert.equal(tipOf(await (await app(t, wrote, { helper })).turn()).state.体力, 100)
  closeSchema()
  const filled = await provider(t)
  assert.equal(tipOf(await (await app(t, filled, { helper })).turn()).state.体力, 100)
})

test('with the game rules on, the card\'s schema still has the last word on the state', async t => {
  const fake = await provider(t, { story: `她点点头。\n${UPDATE}` })
  const tip = tipOf(await (await app(t, fake, { helper: { name: 'Zod', content: SCHEMA, enabled: true }, rules: 'full' })).turn())
  assert.equal(tip.state.体力, 100, 'held to the schema, as without the rules')
  assert.ok(tip.game, 'and the sheet is kept beside it')
})

test('with the game rules on, a state the schema rejects is marked, and the reply still stops at its mark', async t => {
  const content = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\nexport const Schema = z.object({ 体力: z.coerce.number().prefault(50), 背包: z.record(z.string(), z.object({ 数量: z.number() })).prefault({}) });\n$(() => { registerMvuSchema(Schema); });"
  const wrong = '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/背包","value":{"药水":1}}]</JSONPatch>\n</UpdateVariable>'
  const fake = await provider(t, { story: `她伸手。\n${wrong}\n【检定|灵巧|DC12】` })
  const tip = tipOf(await (await app(t, fake, { helper: { name: 'Zod', content, enabled: true }, rules: 'full' })).turn())
  assert.match(tip.schemaProblem, /背包\.药水/)
  assert.deepEqual(tip.gate, { kind: 'check', stat: '灵巧', dc: 12 })
  assert.ok(tip.game)
})

test('a reply stopped at its mark left the update for the next one: nothing is filled in', async t => {
  const fake = await provider(t, { story: '她伸手。\n【检定|灵巧|DC12】' })
  const events = await (await app(t, fake, { rules: 'full' })).turn()
  assert.ok(!events.some(e => e.type === 'filling'))
  assert.equal(fake.asked.length, 1)
})

test('a state the schema rejects is marked on the reply until it is put right', async t => {
  const content = "import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';\nexport const Schema = z.object({ 体力: z.coerce.number().transform(v => _.clamp(v, 0, 100)).prefault(50), 背包: z.record(z.string(), z.object({ 数量: z.coerce.number() })).prefault({}) });\n$(() => { registerMvuSchema(Schema); });"
  const wrong = '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/体力","value":180},{"op":"replace","path":"/背包","value":{"药水":1}}]</JSONPatch>\n</UpdateVariable>'
  const { turn, putState } = await app(t, await provider(t, { story: `她点点头。\n${wrong}` }), { helper: { name: 'Zod', content, enabled: true } })
  const tip = tipOf(await turn())
  assert.match(tip.schemaProblem, /背包\.药水/)
  assert.equal(tip.state.体力, 180, 'one wrong field and none of the rules ran')

  const still = await putState({ 体力: 80, 背包: { 药水: 1 } })
  assert.match(still.path.at(-1).schemaProblem, /背包\.药水/)
  const fixed = await putState({ 体力: 80, 背包: { 药水: { 数量: 1 } } })
  assert.equal(fixed.path.at(-1).schemaProblem, undefined)
})
