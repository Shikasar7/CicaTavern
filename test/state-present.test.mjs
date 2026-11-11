// 只发在场角色的变量 (server/present.mjs): a long state goes to the model without the groups of characters who are
// not around, and the turn one of them shows up their group goes on its own. What counts as a character's group,
// what is never left out, and the turns of a chat that send it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { PRESENT_MIN, backNote, castNames, leftNote, presentState, returnedState } from '../server/present.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const sheet = (liking, mood) => ({ 好感: liking, 心情: mood, 近况: '在山上住了三年，每天清晨去后山寒潭边打坐，傍晚回来抄经，很少下山。'.repeat(12), 随身: ['木剑', '旧伞', '半块玉佩'] })
const STATE = {
  世界: { 天气: '小雪', 第几天: 3 },
  主角: { 体力: 80, 背包: { 老周: { 数量: 1 }, 干粮: { 数量: 3 } } },
  角色: { 林雪: sheet(40, '平静'), 老周: sheet(20, '烦躁'), 阿梅: sheet(65, '高兴') },
  掌门: sheet(10, '冷淡'),
  药铺: { 存货: { $meta: { extensible: true }, 阿梅: { 数量: 2 }, 止血散: { 数量: 5 } } },
}
const BOOKS = [{ entries: [
  { keys: ['林雪', '雪儿'], content: '林雪是大师姐。', constant: false, enabled: true },
  { keys: ['老周'], content: '老周是守山人。', constant: false, enabled: true },
  { keys: ['阿梅', '/梅(花|子)/'], content: '阿梅是药铺学徒。', constant: false, enabled: true },
  { keys: ['世界'], content: '常驻的不算。', constant: true, enabled: true },
  { keys: ['主角'], content: '玩家自己的不算。', constant: false, enabled: true },
  { keys: ['天气'], content: '停用的不算。', constant: false, enabled: false },
] }]
const ROSTER = [{ id: 'a', name: '掌门', aliases: '师父， 老头子' }, { id: 'b', name: '江砚', player: true }]

test('who a state can be about: the cast, and the keywords of entries sent on keywords', () => {
  const cast = castNames({ roster: ROSTER, books: BOOKS, player: ['江砚'] })
  assert.deepEqual([...cast.groups.keys()].sort(), ['掌门', '林雪', '老周', '阿梅', '雪儿'].sort())
  assert.deepEqual(cast.groups.get('林雪'), ['林雪', '雪儿'], 'an entry\'s keywords are the names of one thing')
  assert.deepEqual(cast.groups.get('阿梅'), ['阿梅'], 'a pattern is no name')
  assert.deepEqual(cast.groups.get('掌门'), ['掌门', '师父', '老头子'], 'the cast\'s 别称')
  assert.ok(cast.own.has('主角') && cast.own.has('江砚'))
  // The player's own name as a keyword or in the cast is still the player.
  assert.equal(castNames({ roster: [{ name: '江砚' }], player: ['江砚'] }).groups.size, 0)
  assert.equal(castNames().groups.size, 0)
})

test('a long state goes without the groups of those not around; the rest is never touched', () => {
  const cast = castNames({ roster: ROSTER, books: BOOKS, player: ['江砚'] })
  assert.ok(JSON.stringify(STATE, null, 1).length > PRESENT_MIN)
  const { state, left } = presentState(STATE, { cast, text: '雪儿在廊下扫雪。\n你走了过去。' })
  assert.deepEqual(left.sort(), ['掌门', '老周', '阿梅'].sort())
  assert.deepEqual(Object.keys(state.角色), ['林雪'], 'around by another of her names')
  assert.deepEqual(state.角色.林雪, STATE.角色.林雪, 'a group is sent whole')
  assert.equal('掌门' in state, false, 'a group at the top')
  // Not groups, whatever their rows are called: the player's bag, a list that grows, the world's own values.
  assert.deepEqual(state.主角, STATE.主角)
  assert.deepEqual(state.药铺, STATE.药铺)
  assert.deepEqual(state.世界, STATE.世界)
  assert.equal(STATE.角色.老周.好感, 20, 'the state itself is not changed')

  // Everyone around, nothing to go by, nothing said, or a short state: as it is.
  assert.equal(presentState(STATE, { cast, text: '林雪、老周、阿梅和掌门都在。' }).state, STATE)
  assert.equal(presentState(STATE, { cast: castNames(), text: '林雪' }).state, STATE)
  assert.equal(presentState(STATE, { cast, text: '  ' }).state, STATE)
  const small = { 角色: { 林雪: { 好感: 1 }, 老周: { 好感: 2 } } }
  assert.deepEqual(presentState(small, { cast, text: '林雪' }), { state: small, left: [] })
  assert.deepEqual(presentState(small, { cast, text: '林雪', min: 0 }).left, ['老周'])
  // A group deeper than three keys down is not looked for.
  const deep = { a: { b: { c: { 老周: sheet(1, 'x') } } }, 角色: { 阿梅: sheet(1, 'x'), 林雪: sheet(2, 'y') } }
  assert.deepEqual(presentState(deep, { cast, text: '林雪', min: 0 }).left, ['阿梅'])
})

test('those left out come back on their own the turn they are around', () => {
  const cast = castNames({ roster: ROSTER, books: BOOKS, player: ['江砚'] })
  const left = ['掌门', '老周', '阿梅']
  const { state, back } = returnedState(STATE, { cast, text: '老周推门进来，林雪抬起头。', left })
  assert.deepEqual(back, ['老周'], 'one who was never left out is not sent again')
  assert.deepEqual(state, { 角色: { 老周: STATE.角色.老周 } }, 'only their group, where it sits')
  assert.deepEqual(returnedState(STATE, { cast, text: '没有人来。', left }), { state: {}, back: [] })
  assert.deepEqual(returnedState(STATE, { cast, text: '老周', left: [] }).back, [])
  assert.match(leftNote(['老周', '阿梅']), /这一轮不在场[\s\S]*老周、阿梅[\s\S]*出场后会补发/)
  assert.match(backNote(), /刚出场/)
})

// ─── In a chat ────────────────────────────────────────────────────────────

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))

async function setup(t, settings = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-present-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `第${requests.length}次回复。` }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', autoFillUpdate: false, ...settings })
  const entries = [
    { keys: [], content: JSON.stringify(STATE), constant: true, enabled: false, comment: '[initvar]初始变量' },
    ...BOOKS[0].entries.slice(0, 3).map((entry, i) => ({ ...entry, comment: `人物${i}` })),
  ]
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '青梧山', description: '山上的日子。', first_mes: '雪儿在廊下扫雪，看见你，点了点头。', character_book: { entries } } })
  card.media = { roster: [{ id: 'a', name: '掌门' }] }
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return { sent: textOf(requests.at(-1).messages.at(-1).content), node: activePath(await store.getChat(chat.id)).at(-2) }
  }
  return { turn }
}

const stateOf = sent => /<当前状态>\n([\s\S]*?)\n<\/当前状态>/.exec(sent)?.[1] ?? null

test('a chat: the first turn sends who is around, a later turn sends who has come, and no one twice', async t => {
  const { turn } = await setup(t)
  const first = await turn('你好。')
  const shown = stateOf(first.sent)
  assert.match(shown, /"林雪"/)
  assert.match(shown, /"天气": "小雪"/)
  assert.doesNotMatch(shown, /"心情": "烦躁"|"心情": "冷淡"/)
  assert.match(shown, /（这些角色这一轮不在场，他们的变量这次没有列出，值没有变：老周、阿梅、掌门。/)
  assert.deepEqual(first.node.stateLeft, ['老周', '阿梅', '掌门'])

  // Not a turn the whole state goes on: the one who walked in is sent alone.
  const second = await turn('老周，你怎么来了？')
  const back = stateOf(second.sent)
  assert.match(back, /"老周"[\s\S]*"心情": "烦躁"/)
  assert.doesNotMatch(back, /"林雪"|"天气"|"阿梅"/)
  assert.match(back, /刚出场的角色的变量/)
  assert.deepEqual(second.node.stateLeft, ['阿梅', '掌门'])

  // Still around, already sent: nothing more.
  const third = await turn('老周，坐。')
  assert.equal(stateOf(third.sent), null)
  assert.equal(third.node.stateLeft, undefined)
})

test('turned off in settings, the state goes whole as before', async t => {
  const { turn } = await setup(t, { statePresent: false })
  const first = await turn('你好。')
  assert.match(stateOf(first.sent), /"心情": "烦躁"[\s\S]*"心情": "高兴"/)
  assert.doesNotMatch(first.sent, /不在场/)
  assert.equal(first.node.stateLeft, undefined)
  assert.equal(stateOf((await turn('老周，你怎么来了？')).sent), null)
})
