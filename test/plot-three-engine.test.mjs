// 剧本 三期 through the engine (plans/22 十二): an exit that compares a variable opens with the story and 满足就走 takes
// it, an ending goes in the card's 结局收集 the first time, 拉回来 goes with one turn, 就这样走 puts a scene in, a way
// picked at a fork passed is sent from the reply back there, and a story archive carries its plot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, exportStory, importStory } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { changePlot } from '../server/plot.mjs'
import { readEndings } from '../server/plot-endings.mjs'
import { plotProblems } from '../web/shared/plot.js'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const lastUser = request => textOf(request.messages.findLast(m => m.role === 'user').content)

const PLOTS = [{
  id: 'p1', name: '看海',
  scenes: [
    { id: 'a', title: '初遇', what: '在旧邮局遇见林雪。', minTurns: 1, exits: [{ to: 'b', when: '玩家答应' }, { to: 'fond', when: '好感够了', needs: { vars: [{ path: '好感度', op: '>=', value: 60 }] }, auto: true }] },
    { id: 'b', title: '雨夜', what: '大雨困住两人。', minTurns: 1, exits: [{ to: 'sea', when: '答应同行' }, { to: 'stay', when: '留下寄信' }] },
    { id: 'fond', title: '心动', minTurns: 1, ending: { kind: 'hidden' } },
    { id: 'sea', title: '看海', minTurns: 1, ending: { kind: 'good', text: '把话说开' } },
    { id: 'stay', title: '寄信', minTurns: 1, ending: { kind: 'sad' } },
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
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plot3-'))
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
  const turn = async (input, reply = null, parentId = null) => {
    if (reply) replies.push(reply)
    const tip = activePath(await fresh()).at(-1)
    const { nodeId } = await engine.runTurn(chat.id, { parentId: parentId ?? tip.id, input }, () => {})
    return (await fresh()).nodes[nodeId]
  }
  const act = (body, tipId = null) => store.withChat(chat.id, async () => {
    const now = await fresh()
    const active = activePath(now)
    changePlot(now, body, tipId ? active.find(node => node.id === tipId) : active.at(-1))
    return store.saveChat(now)
  })
  // The story's variables on the latest reply, as a card's update would leave them.
  const setVars = vars => store.withChat(chat.id, async () => {
    const now = await fresh()
    const tip = activePath(now).at(-1)
    tip.state = { ...(tip.state ?? {}), ...vars }
    return store.saveChat(now)
  })
  const progress = async () => chatView(await fresh()).plot.progress
  return { store, engine, chat, card, fresh, turn, act, setVars, progress, requests, replies }
}

test('an exit that compares a variable is offered once it holds, and 满足就走 takes it whatever the model wrote', async t => {
  const { turn, setVars, requests, progress } = await setup(t)
  await setVars({ 好感度: 30 })
  const low = await turn('打招呼', '她点点头。\n<剧本进度 要点="无" 完成="否"/>')
  assert.doesNotMatch(lastUser(requests.at(-1)), /去「心动」/)
  assert.equal(low.plot.at, 'a')
  await setVars({ 好感度: 75 })
  const high = await turn('送她一把伞', '她红了脸。\n<剧本进度 要点="无" 完成="否"/>')
  assert.match(lastUser(requests.at(-1)), /去「心动」/)
  assert.equal(high.plot.at, 'fond')
  assert.equal(high.plot.from, 'a')
  assert.equal((await progress()).at, 'fond')
})

test('an ending reached goes in the card’s 结局收集 the first time, said on the reply; a second time it is not new', async t => {
  const { store, card, turn, act, engine, chat, replies } = await setup(t)
  await act({ action: 'jump', at: 'sea' })
  const end = await turn('去海边', '海风吹来。\n<剧本进度 要点="无" 完成="是"/>')
  assert.equal(end.plot.ended, true)
  assert.equal(end.plot.first, true)
  const endings = await readEndings(store, card.id)
  assert.equal(endings.p1.sea.title, '看海')
  assert.equal(endings.p1.sea.kind, 'good')
  const at = endings.p1.sea.at
  const again = async reply => {
    replies.push(reply)
    const { nodeId } = await engine.runTurn(chat.id, { userNodeId: end.parent }, () => {})
    return (await store.getChat(chat.id)).nodes[nodeId]
  }
  assert.equal((await again('海很蓝。\n<剧本进度 要点="无" 完成="否"/>')).plot.ended, undefined, 'not done this time')
  // Written again, done again: ended, not new, the first date kept.
  const second = await again('浪花拍岸。\n<剧本进度 要点="无" 完成="是"/>')
  assert.equal(second.plot.ended, true)
  assert.equal(second.plot.first, undefined)
  assert.equal((await readEndings(store, card.id)).p1.sea.at, at)
  assert.equal(chatView(await store.getChat(chat.id)).plot.progress.ended, true)
})

test('拉回来 goes with one turn; 不用管 quiets the scene', async t => {
  const { turn, act, requests, progress } = await setup(t)
  await turn('走开', '你走了。\n<剧本进度 要点="无" 完成="否" 偏离="是"/>')
  assert.equal((await progress()).astray, 1)
  await act({ action: 'pull' })
  await turn('继续走')
  assert.match(lastUser(requests.at(-1)), /把场面带回这一幕/)
  await turn('再走')
  assert.doesNotMatch(lastUser(requests.at(-1)), /把场面带回这一幕/)
  await act({ action: 'quiet' })
  const quiet = await turn('还走', '你还在走。\n<剧本进度 要点="无" 完成="否" 偏离="是"/>')
  assert.equal(quiet.plot.quiet, true)
})

test('就这样走: the scene the story went into is put in after the one now, gone to, and leads back', async t => {
  const { turn, act, fresh, requests } = await setup(t)
  await turn('去码头')
  await act({ action: 'detour', scene: { title: '码头', what: '两人在码头吵了一架。', points: [{ text: '船票' }] }, back: 'b' })
  const chat = await fresh()
  const ids = chat.plot.copy.scenes.map(scene => scene.id)
  const added = chat.plot.copy.scenes[1]
  assert.equal(ids.length, 6)
  assert.equal(added.title, '码头')
  assert.deepEqual(added.exits.map(exit => exit.to), ['b'])
  // The scene it left leads into it until it has been played: no scene the start cannot reach.
  assert.deepEqual(chat.plot.copy.scenes[0].exits.at(-1), { to: added.id, when: '', hint: '', needs: { unseen: added.id } })
  assert.equal(plotProblems(chat.plot.copy).blocking.length, 0)
  assert.equal(chat.plot.version, 2)
  assert.equal(chat.plot.pending.set.at, added.id)
  const next = await turn('道歉')
  assert.match(lastUser(requests.at(-1)), /当前这一幕：「码头」/)
  assert.equal(next.plot.at, added.id)
})

test('回到岔路口: a way picked at a fork passed goes with the reply back there, and the turn sent from it takes it', async t => {
  const { turn, act, fresh, requests } = await setup(t)
  await turn('答应', '你答应了。\n<剧本进度 要点="无" 完成="是" 出口="1"/>')
  const atFork = await turn('进屋躲雨', '雨很大。\n<剧本进度 要点="无" 完成="否"/>')
  const left = await turn('一起去海边', '你们出发了。\n<剧本进度 要点="无" 完成="是" 出口="1"/>')
  assert.equal(left.plot.at, 'sea')
  await act({ action: 'exit', to: 'stay', after: atFork.id }, atFork.id)
  const view = chatView(await fresh()).plot
  assert.equal(view.pending, null, 'not for the latest reply')
  assert.deepEqual(view.pendingAfter, { after: atFork.id, set: { at: 'stay', picked: true } })
  const other = await turn('留下来寄信', '你留了下来。\n<剧本进度 要点="无" 完成="否"/>', atFork.id)
  assert.match(lastUser(requests.at(-1)), /当前这一幕：「寄信」/)
  assert.equal(other.plot.at, 'stay')
  // The way taken before is still there.
  assert.equal((await fresh()).nodes[left.id].plot.at, 'sea')
})

test('a story archive carries its plot: the copy, its settings and where the story was', async t => {
  const { store, card, turn, act, fresh } = await setup(t)
  await turn('答应', '你答应了。\n<剧本进度 要点="无" 完成="是" 出口="1"/>')
  await act({ action: 'settings', spoiler: 'blind' })
  const chat = await fresh()
  activePath(chat).at(-1).compaction = { summary: '两人在邮局相遇，林雪答应同行。', turns: 1, model: null }
  await store.saveChat(chat)
  const archive = JSON.parse(JSON.stringify(exportStory(await fresh())))
  assert.equal(archive.plot.copy.id, 'p1')
  assert.equal(archive.plot.progress.at, 'b')
  const imported = await importStory(store, card.id, archive)
  const view = chatView(imported).plot
  assert.equal(view.copy.name, '看海')
  assert.equal(view.spoiler, 'blind')
  assert.equal(view.progress.at, 'b')
  assert.deepEqual(view.progress.seen, ['a'])
})
