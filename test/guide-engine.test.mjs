// 剧情向导 through the engine (plans/21): a taken plan rides on each turn's message only, rests on a branch from
// before it, and the guide's talk is kept beside the chat, asked on the helper or on the chat's own model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, forkChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { createGuide } from '../server/guide.mjs'
import { anchorOf, changeGuide } from '../server/guide-text.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const PLAN_REPLY = '她在等你开口。\n\n<剧情方案>\n目标：让林雪主动提起看海之约\n起头：旧车票；广播里的歌\n注意：别一轮演完\n</剧情方案>'

async function fakeModel(t) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const all = request.messages.map(m => textOf(m.content)).join('\n')
    const text = all.includes('剧情向导」') || all.includes('【暂停扮演：剧情向导】') ? PLAN_REPLY : `第${requests.length}次回复。`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-guide-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const fake = await fakeModel(t)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }, { id: 'helper' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', media: { helperModel: `${provider.id}/helper` } })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '林雪是邮局职员。', first_mes: '雪下了一整夜。' } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const guide = createGuide(store, { engine })
  const chat = await createChat(store, card.id)
  const turn = async (input, parentId = null) => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    const { nodeId } = await engine.runTurn(chat.id, { parentId: parentId ?? tip.id, input }, () => {})
    return nodeId
  }
  const act = body => store.withChat(chat.id, async () => {
    const fresh = await store.getChat(chat.id)
    fresh.guide = changeGuide(fresh.guide, body, anchorOf(activePath(fresh)))
    return store.saveChat(fresh)
  })
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const view = await guide.view(chat.id)
      if (!view.job) return view
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('the guide did not finish')
  }
  return { store, engine, guide, chat, turn, act, settle, fake, helper: `${provider.id}/helper` }
}

const lastUser = request => textOf(request.messages.findLast(m => m.role === 'user').content)

test('a taken plan rides on the turn’s message only, after the preset’s words and before the reminder', async t => {
  const { fake, turn, act } = await setup(t)
  await turn('你好')
  await act({ action: 'adopt', plan: { goal: '让林雪主动提起看海之约', start: ['旧车票'] }, strength: 'hint' })
  await turn('今天天气不错')
  const first = fake.requests.at(-1)
  const sent = lastUser(first)
  assert.match(sent, /<剧情向导>\n目标：让林雪主动提起看海之约\n可以从这些地方起头：\n- 旧车票\n节奏：只铺垫/)
  assert.match(sent, /这是这个方向的第 1 轮。/)
  assert.ok(sent.indexOf('<剧情向导>') > sent.indexOf('<玩家输入>'))
  if (sent.includes('<本轮提醒>')) assert.ok(sent.indexOf('<剧情向导>') < sent.indexOf('<本轮提醒>'))
  if (sent.includes('<预设指令>')) assert.ok(sent.indexOf('<剧情向导>') > sent.indexOf('<预设指令>'))

  await turn('去海边吧')
  const second = fake.requests.at(-1)
  assert.match(lastUser(second), /这是这个方向的第 2 轮。/)
  const older = second.messages.slice(0, -1).filter(m => m.role === 'user').map(m => textOf(m.content))
  assert.ok(older.every(text => !text.includes('<剧情向导>')), 'taken out of the older messages')
  assert.ok(older.some(text => text.includes('今天天气不错')))
  assert.equal(textOf(second.messages[0].content), textOf(first.messages[0].content), 'the system prompt stays as it was')

  await act({ action: 'stop' })
  await turn('回家')
  assert.ok(!lastUser(fake.requests.at(-1)).includes('<剧情向导>'))
})

test('a reply written again keeps the turn as sent; a branch from before the plan has none of it', async t => {
  const { store, engine, chat, fake, turn, act } = await setup(t)
  const first = await turn('你好')
  await act({ action: 'adopt', plan: { goal: '去看海' } })
  const guided = await turn('今天天气不错')
  const userNodeId = (await store.getChat(chat.id)).nodes[guided].parent
  await engine.runTurn(chat.id, { userNodeId }, () => {})
  assert.match(lastUser(fake.requests.at(-1)), /<剧情向导>\n目标：去看海/, 'written again from the message as it went')
  // From the opening, before the plan was taken: it rests there.
  await turn('另一条路', 'root')
  assert.ok(!lastUser(fake.requests.at(-1)).includes('<剧情向导>'))
  const view = chatView(await store.getChat(chat.id))
  assert.equal(view.guide.on, false)
  assert.equal(view.guide.plan.goal, '去看海')
  assert.ok(first)
})

test('the talk: kept beside the chat, asked on the helper with the story as material, its plans read back', async t => {
  const { store, guide, chat, fake, turn, settle, helper } = await setup(t)
  await turn('你好')
  const before = (await store.getChat(chat.id)).updatedAt
  await guide.setModel(chat.id, 'helper')
  const asked = await guide.ask(chat.id, { text: '接下来怎么走？' })
  assert.ok(asked.job, 'written in the background')
  const view = await settle()
  const request = fake.requests.at(-1)
  assert.equal(request.model, helper.split('/')[1])
  assert.match(textOf(request.messages[0].content), /你是「剧情向导」/)
  assert.match(lastUser(request), /<故事资料>[\s\S]*林雪是邮局职员[\s\S]*你好[\s\S]*玩家的问题：接下来怎么走？/)
  assert.equal(view.turns.length, 1)
  assert.equal(view.turns[0].assistant.text, '她在等你开口。')
  assert.deepEqual(view.turns[0].assistant.plans, [{ goal: '让林雪主动提起看海之约', start: ['旧车票', '广播里的歌'], notes: ['别一轮演完'] }])
  assert.equal(view.turns[0].user.read, 1)
  assert.equal((await store.getChat(chat.id)).updatedAt, before, 'the chat file is left alone')
  const file = JSON.parse(await readFile(path.join(store.dirs.root, 'guides', `${chat.id}.json`), 'utf8'))
  assert.equal(file.turns.length, 1)

  await guide.note(chat.id, '开始引导：去看海')
  await guide.ask(chat.id, { text: '她会生气吗？' })
  await settle()
  assert.match(lastUser(fake.requests.at(-1)), /<之前的商量>\n玩家：接下来怎么走？\n\n向导：她在等你开口。\n（提了 1 个方案：让林雪主动提起看海之约）\n\n（开始引导：去看海）\n<\/之前的商量>/)
  await guide.clear(chat.id)
  assert.deepEqual((await guide.view(chat.id)).turns, [])
})

test('on the chat’s own model the guide reads the story as the chat sent it, its words last', async t => {
  const { store, guide, chat, fake, turn, settle } = await setup(t)
  await turn('你好')
  await turn('去邮局')
  const story = fake.requests.at(-1)
  await guide.ask(chat.id, { text: '她为什么不说话？' })
  await settle()
  const request = fake.requests.at(-1)
  assert.equal(request.model, 'm1')
  assert.equal(textOf(request.messages[0].content), textOf(story.messages[0].content), 'the same system prompt, read from cache')
  assert.match(lastUser(request), /^【暂停扮演：剧情向导】[\s\S]*<向导说明>[\s\S]*玩家的问题：她为什么不说话？$/)
  assert.ok(request.messages.slice(0, -1).some(m => textOf(m.content).includes('去邮局')), 'the story before it')
  void store
})

test('a chat forked keeps the plan it follows, and the talk stays with the old one', async t => {
  const { store, guide, chat, turn, act, settle } = await setup(t)
  await turn('你好')
  await act({ action: 'adopt', plan: { goal: '去看海' } })
  await guide.ask(chat.id, { text: '怎么样？' })
  await settle()
  const fresh = await store.getChat(chat.id)
  const fork = forkChat(fresh, activePath(fresh).at(-1).id)
  assert.equal(fork.guide.active.plan.goal, '去看海')
  await store.saveChat(fork)
  assert.deepEqual((await guide.view(fork.id)).turns, [])
  await assert.rejects(guide.ask(chat.id, { text: '' }), /先写点什么/)
})
