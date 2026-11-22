// 剧本 through the engine (plans/22): the turn sends the scene it plays, the reply's mark comes out of what is kept and
// moves the story on, the progress follows branches, versions and hidden rounds, the player's own changes go with the
// next turn, and a card carries its plots out and back in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard, sillyTavernCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, forkChat, hideRound, selectNode } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { changePlot } from '../server/plot.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const lastUser = request => textOf(request.messages.findLast(m => m.role === 'user').content)

const PLOTS = [{
  id: 'p1', name: '看海', summary: '一个夏天',
  scenes: [
    { id: 'a', title: '初遇', what: '在旧邮局遇见林雪。', points: [{ id: 'pa', text: '旧车票' }], minTurns: 1, exits: [{ to: 'b' }] },
    { id: 'b', title: '雨夜', chapter: '第一章', what: '大雨困住两人。', minTurns: 1, exits: [{ to: 'sea', when: '答应同行' }, { to: 'stay', when: '留下寄信' }] },
    { id: 'sea', title: '看海', what: '去海边。', minTurns: 1, ending: { kind: 'good', text: '把话说开' } },
    { id: 'stay', title: '寄信', what: '留下寄信。', minTurns: 1, ending: { kind: 'sad' } },
  ],
}]

async function setup(t) {
  const replies = []
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const text = replies.shift() ?? `第${requests.length}次回复。\n<剧本进度 要点="无" 完成="否"/>`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-plot-'))
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
  const act = body => store.withChat(chat.id, async () => {
    const now = await fresh()
    changePlot(now, body, activePath(now).at(-1))
    return store.saveChat(now)
  })
  const progress = async () => chatView(await fresh()).plot.progress
  return { store, engine, chat, card, fresh, turn, act, progress, requests, replies }
}

test('the scene goes with the turn; the mark comes out of what is kept and moves the story on', async t => {
  const { turn, requests, progress, fresh } = await setup(t)
  assert.equal((await progress()).at, 'a')
  const first = await turn('推门进去', '你看见她。\n<剧本进度 要点="1" 完成="否"/>')
  assert.match(lastUser(requests.at(-1)), /<剧本>[\s\S]*当前这一幕：「初遇」[\s\S]*1\. 旧车票[\s\S]*<\/剧本>/)
  assert.equal(first.text, '你看见她。')
  assert.equal(first.display, '你看见她。')
  assert.deepEqual(first.plot.ticks, ['pa'])
  const second = await turn('打招呼', '她抬起头。\n<剧本进度 要点="无" 完成="是"/>')
  assert.equal(second.plot.at, 'b')
  assert.equal(second.plot.from, 'a')
  await turn('雨更大了')
  const sent = requests.at(-1)
  assert.match(lastUser(sent), /当前这一幕：「雨夜」（第一章）[\s\S]*这一轮刚从「初遇」进入这一幕/)
  assert.match(lastUser(sent), /1\. 当答应同行 → 去「看海」/)
  const older = sent.messages.slice(0, -1).map(m => textOf(m.content))
  assert.ok(older.every(text => !text.includes('<剧本>') && !text.includes('剧本进度')), 'neither the older blocks nor any mark go back')
  const view = chatView(await fresh())
  assert.equal(view.plot.progress.at, 'b')
  assert.equal(view.plot.copy.name, '看海')
})

test('a reply written again, a version switched, a branch from earlier: each has its own progress', async t => {
  const { engine, store, chat, turn, progress, fresh } = await setup(t)
  await turn('推门进去')
  const entered = await turn('打招呼', '她抬起头。\n<剧本进度 完成="是"/>')
  assert.equal((await progress()).at, 'b')
  // Written again, and this time the model does not finish the scene.
  const { nodeId } = await engine.runTurn(chat.id, { userNodeId: entered.parent }, () => {})
  assert.equal((await fresh()).nodes[nodeId].plot.at, 'a')
  assert.equal((await progress()).at, 'a')
  await store.withChat(chat.id, async () => {
    const now = await fresh()
    selectNode(now, entered.id)
    return store.saveChat(now)
  })
  assert.equal((await progress()).at, 'b', 'back on the first version')
  // From the opening: a story that never left 初遇.
  const root = (await fresh()).nodes.root
  await turn('另一条路', null, root.id)
  assert.equal((await progress()).at, 'a')
  assert.equal((await progress()).turns, 1)
})

test('the player picks the way: sent with the next turn, kept on its message, a reply written again keeps it', async t => {
  const { engine, chat, turn, act, progress, requests, fresh } = await setup(t)
  await turn('推门进去')
  await turn('打招呼', '她抬起头。\n<剧本进度 完成="是"/>')
  await act({ action: 'exit', to: 'stay' })
  assert.equal((await progress()).at, 'stay', 'shown at once, before it is sent')
  const reply = await turn('我留下来')
  const user = (await fresh()).nodes[reply.parent]
  assert.deepEqual({ of: user.plotSet.of, at: user.plotSet.at }, { of: 'p1', at: 'stay' })
  assert.match(lastUser(requests.at(-1)), /当前这一幕：「寄信」[\s\S]*这一幕是结局/)
  assert.equal((await fresh()).plot.pending, null, 'sent: no longer waiting')
  const { nodeId } = await engine.runTurn(chat.id, { userNodeId: reply.parent }, () => {})
  assert.equal((await fresh()).nodes[nodeId].plot.at, 'stay')
  // An ending played to its end: nothing more is sent.
  await turn('寄出去', '信寄出去了。\n<剧本进度 完成="是"/>')
  assert.equal((await progress()).ended, true)
  await turn('然后呢')
  assert.ok(!lastUser(requests.at(-1)).includes('<剧本>'))
})

test('a change waiting on one reply is not sent from another; paused, nothing is sent or kept; a hidden round counts no more', async t => {
  const { store, chat, turn, act, progress, requests, fresh } = await setup(t)
  await turn('推门进去')
  const second = await turn('打招呼')
  await act({ action: 'jump', at: 'sea' })
  // The player sends from the first reply instead.
  const firstReply = activePath(await fresh())[2]
  await turn('换个说法', null, firstReply.id)
  assert.match(lastUser(requests.at(-1)), /当前这一幕：「初遇」/)
  void second
  await act({ action: 'pause' })
  const paused = await turn('随便走走')
  assert.ok(!lastUser(requests.at(-1)).includes('<剧本>'))
  assert.equal(paused.plot, undefined)
  await act({ action: 'resume' })
  const entered = await turn('打招呼', '她抬起头。\n<剧本进度 完成="是"/>')
  assert.equal((await progress()).at, 'b')
  await store.withChat(chat.id, async () => {
    const now = await fresh()
    hideRound(now, entered.id, true)
    return store.saveChat(now)
  })
  assert.equal((await progress()).at, 'a', 'the round that moved it on is hidden')
})

test('a chat forked keeps its plot and progress, not a change waiting to be sent; a broken plot is refused', async t => {
  const { store, card, turn, act, fresh } = await setup(t)
  await turn('推门进去')
  await act({ action: 'tick', ticks: ['pa'] })
  const now = await fresh()
  const fork = forkChat(now, activePath(now).at(-1).id)
  assert.equal(fork.plot.copy.id, 'p1')
  assert.equal(fork.plot.pending, null)
  await store.saveCard({ ...card, plots: [{ id: 'bad', scenes: [{ id: 'x', exits: [{ to: 'y' }] }, { id: 'y' }] }] })
  await assert.rejects(createChat(store, card.id, 0, { plotId: 'bad' }), /还不能用/)
  await assert.rejects(createChat(store, card.id, 0, { plotId: 'gone' }), /不在了/)
})

test('a card carries its plots out to a SillyTavern file and back, played blind when they come from elsewhere', () => {
  const card = { ...normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪' } }), plots: PLOTS.map(plot => ({ ...plot, source: 'own' })), defaultPlot: 'p1' }
  const file = sillyTavernCard(card)
  assert.equal(file.data.extensions.cicatavern.plots[0].name, '看海')
  assert.equal(file.data.extensions.cicatavern.plots[0].source, undefined)
  assert.equal(file.data.extensions.cicatavern.default_plot, 'p1')
  const back = normalizeCard(file)
  assert.equal(back.plots[0].scenes.length, 4)
  assert.equal(back.plots[0].source, 'imported')
  assert.equal(back.defaultPlot, 'p1')
})
