// 剧本 四期 through the engine (plans/22 十三): 支线 sent and moved on by the reply, the helper judging every few turns,
// the card's plot changed (换成新版 / 不管), and the drafts 从对话整理 and 创作角色卡's (put in the card by itself).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { changePlot, refreshPlot } from '../server/plot.mjs'
import { createPlotDraft } from '../server/plot-draft.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const lastUser = request => textOf(request.messages.findLast(m => m.role === 'user').content)

const PLOTS = [{
  id: 'p1', name: '看海', updatedAt: '2026-11-01T00:00:00.000Z',
  sides: [{ id: 'cat', name: '流浪猫', start: 'c1' }],
  scenes: [
    { id: 'a', title: '初遇', what: '在旧邮局遇见林雪。', minTurns: 1, exits: [{ to: 'b' }] },
    { id: 'b', title: '雨夜', minTurns: 1, exits: [{ to: 'end' }] },
    { id: 'end', title: '看海', minTurns: 1, ending: { kind: 'good' } },
    { id: 'c1', side: 'cat', title: '屋檐下的猫', minTurns: 1, exits: [{ to: 'c2' }] },
    { id: 'c2', side: 'cat', title: '收养', minTurns: 1, ending: { kind: 'good' } },
  ],
}]

async function setup(t) {
  const replies = []
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    const text = replies.shift() ?? `第${requests.length}次回复。\n<剧本进度 要点="无" 完成="否"/>`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plot4-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off' })
  const card = { ...normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '邮局职员。', first_mes: '雨下了一整夜。' } }), plots: PLOTS }
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id, 0, { plotId: 'p1' })
  const fresh = () => store.getChat(chat.id)
  const turn = async (input, reply = null) => {
    if (reply) replies.push(reply)
    const tip = activePath(await fresh()).at(-1)
    const { nodeId } = await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return (await fresh()).nodes[nodeId]
  }
  const act = body => store.withChat(chat.id, async () => {
    const now = await fresh()
    changePlot(now, body, activePath(now).at(-1))
    return store.saveChat(now)
  })
  return { store, engine, chat, card, fresh, turn, act, requests, replies }
}

test('支线 go with the turn; the reply’s mark moves one on; the player can end one', async t => {
  const { turn, act, requests, fresh } = await setup(t)
  const first = await turn('看看屋檐', '一只猫缩在屋檐下。\n<剧本进度 要点="无" 完成="否" 支线1="是"/>')
  assert.match(lastUser(requests.at(-1)), /支线1「流浪猫」，现在是「屋檐下的猫」/)
  assert.equal(first.text, '一只猫缩在屋檐下。')
  assert.deepEqual(first.plot.sides.cat, { at: 'c2', ticks: [], turns: 0, seen: ['c1'], from: 'c1' })
  assert.equal(first.plot.at, 'a')
  await act({ action: 'side', id: 'cat', ended: true })
  const second = await turn('抱起猫')
  assert.equal(second.plot.sides.cat.ended, true)
  assert.doesNotMatch(lastUser(requests.at(-1)), /流浪猫/, 'the turn after: an ended side line is not sent')
  assert.equal(chatView(await fresh()).plot.progress.sides.cat.ended, true)
  assert.throws(() => changePlot({ plot: { copy: PLOTS[0] } }, { action: 'side', id: 'dog', ended: true }, { id: 'x' }), { status: 400 })
})

test('辅助模型判断: no mark asked of the model; every few replies the helper reads the story and its word moves the scene on', async t => {
  const { engine, chat, turn, act, requests, replies, fresh } = await setup(t)
  await act({ action: 'settings', judge: 'helper', every: 2 })
  const first = await turn('推门', '她抬起头。')
  assert.doesNotMatch(lastUser(requests.at(-1)), /每次回复的最后单独一行写进度/)
  assert.equal(first.plot.wait, 1)
  assert.equal(first.plot.silent, undefined)
  replies.push('她笑了。', '```json\n{"points": [], "done": true, "exit": 1, "astray": false}\n```')
  const second = await turn('打招呼')
  assert.equal(second.plot.at, 'a', 'not yet: the helper looks once the reply is in')
  const judged = await engine.plotJudging(chat.id)
  assert.equal(judged.at, 'b')
  const kept = (await fresh()).nodes[second.id].plot
  assert.deepEqual([kept.at, kept.judged, kept.wait], ['b', true, 0])
  assert.match(textOf(requests.at(-1).messages.at(-1).content), /当前这一幕：「初遇」[\s\S]*她笑了。[\s\S]*只回 JSON/)
  assert.equal(chatView(await fresh()).plot.judge.by, 'helper')
})

test('the card’s plot changed: 换成新版 takes it, the progress where it fits; 不管 remembers the version left be', async t => {
  const { turn, act, fresh, store } = await setup(t)
  await turn('答应', '你答应了。\n<剧本进度 要点="无" 完成="是"/>')
  const card = await store.getCard((await fresh()).cardId)
  card.plots = [{ ...card.plots[0], updatedAt: '2026-11-20T00:00:00.000Z', scenes: card.plots[0].scenes.map(scene => (scene.id === 'b' ? { ...scene, title: '大雨' } : scene)) }]
  await act({ action: 'keep', updatedAt: '2026-11-20T00:00:00.000Z' })
  assert.equal(chatView(await fresh()).plot.seenUpdate, '2026-11-20T00:00:00.000Z')
  const chat = await fresh()
  refreshPlot(chat, card.plots)
  const view = chatView(chat).plot
  assert.equal(view.copy.scenes.find(scene => scene.id === 'b').title, '大雨')
  assert.equal(view.progress.at, 'b')
  assert.equal(view.version, 2)
  assert.throws(() => refreshPlot(chat, []), { status: 404 })
})

test('从对话整理 reads the chat (its summary first); 创作角色卡’s draft goes into the card by itself, its default if none', async t => {
  const { store, card, chat, turn } = await setup(t)
  await turn('推门')
  const now = await store.getChat(chat.id)
  activePath(now).at(-1).compaction = { summary: '两人在邮局重逢。', turns: 1 }
  await store.saveChat(now)
  const answer = '```json\n{ "name": "重逢", "scenes": [{ "id": "s1", "title": "邮局", "exits": [{ "to": "s2" }] }, { "id": "s2", "title": "海边", "ending": { "kind": "good" } }] }\n```'
  const asked = []
  const drafts = createPlotDraft(store, { engine: { sideCall: async (_, __, request) => (asked.push(request), { text: answer, model: 'fake/m' }) } })
  const until = async key => {
    for (let i = 0; i < 100; i++) {
      const view = await drafts.view(key)
      if (!view.job) return view
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('never done')
  }
  await drafts.ask(`chat-${chat.id}`, { kind: 'fromChat' })
  assert.equal((await until(`chat-${chat.id}`)).result.plot.name, '重逢')
  assert.match(asked[0].messages[0].content, /<之前的摘要>\n两人在邮局重逢。[\s\S]*推门[\s\S]*整理成一份能重玩的剧本/)
  // 创作角色卡: a card with none gets the one written, as its default.
  const bare = { ...normalizeCard({ spec: 'chara_card_v2', data: { name: '新卡', description: '', first_mes: '你好' } }) }
  await store.saveCard(bare)
  await drafts.ask(`card-${bare.id}`, { kind: 'whole', auto: true, text: '一个夏天' })
  const done = await until(`card-${bare.id}`)
  const saved = await store.getCard(bare.id)
  assert.equal(saved.plots.length, 1)
  assert.equal(saved.defaultPlot, saved.plots[0].id)
  assert.equal(done.result.saved, saved.plots[0].id)
  assert.match(asked[1].messages[0].content, /一个夏天[\s\S]*直接写一份完整的剧本/)
})
