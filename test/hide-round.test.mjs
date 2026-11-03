// 隐藏这一轮: a round kept in the chat and shown, but no longer sent to the model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, hideRound } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { recentExchanges, withoutHidden } from '../server/recap.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeBook } from '../server/worldbook.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const sentText = request => request.messages.map(message => textOf(message.content)).join('\n')

/** An OpenAI-compatible model: a story reply in turn, an archive when asked for one; keeps each request. */
async function fakeModel(t) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const last = textOf(request.messages.at(-1).content)
    const text = last.includes('剧情存档') ? `<剧情存档>\n${'林雪在灯下读信，你们约好了明天去看海。'.repeat(12)}\n</剧情存档>` : `第${requests.length}次回复。`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-hide-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const fake = await fakeModel(t)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off' })
  const book = normalizeBook({ name: '雪国', entries: { 0: { uid: 0, key: ['灯笼'], content: '灯笼是祖母留下的。' } } }, 'x', { standalone: true })
  await store.saveBook(book)
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '林雪是邮局职员。', first_mes: '雪下了一整夜。' } })
  card.worldbookIds = [book.id]
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return activePath(await store.getChat(chat.id))
  }
  const hide = async (nodeId, hidden = true) => {
    const saved = await store.getChat(chat.id)
    hideRound(saved, nodeId, hidden)
    await store.saveChat(saved)
    return saved
  }
  return { store, engine, chat, turn, hide, fake }
}

test('a hidden round is not sent, nor does it bring in lore; shown again, it is', async t => {
  const { store, chat, turn, hide, fake } = await setup(t)
  await turn('你好')
  let nodes = await turn('提着灯笼的人是谁？')
  await turn('我们走吧')
  const hidden = nodes[4]
  await hide(hidden.id)
  const view = chatView(await store.getChat(chat.id))
  assert.equal(view.path[4].hidden, true, 'the reply')
  assert.equal(view.path[3].hidden, true, 'and the message before it')
  assert.equal(view.path[2].hidden, undefined)

  await turn('然后呢？')
  let sent = sentText(fake.requests.at(-1))
  assert.ok(!sent.includes('提着灯笼的人是谁'), 'the hidden input is not sent')
  assert.ok(!sent.includes('第2次回复'), 'nor the hidden reply')
  assert.match(sent, /你好[\s\S]*第1次回复[\s\S]*我们走吧[\s\S]*第3次回复[\s\S]*然后呢/, 'the rest goes as it was, in order')
  assert.ok(!sent.includes('灯笼是祖母留下的'), 'its keyword brings no lore in')
  const roles = fake.requests.at(-1).messages.map(message => message.role).filter(role => role !== 'system')
  assert.ok(roles.every((role, i) => role === (i % 2 ? 'assistant' : 'user')), 'user and assistant still take turns')

  await hide(hidden.id, false)
  await turn('再说一遍')
  sent = sentText(fake.requests.at(-1))
  assert.match(sent, /提着灯笼的人是谁[\s\S]*第2次回复/, 'shown again, it is sent again')
})

test('the first round hidden: the opening goes with the first round sent', async t => {
  const { turn, hide, fake } = await setup(t)
  const nodes = await turn('你好')
  assert.match(textOf(fake.requests[0].messages.at(-1).content), /<开场>[\s\S]*雪下了一整夜/)
  await turn('外面冷吗')
  await hide(nodes[2].id)
  await turn('那就进屋')
  const sent = fake.requests.at(-1).messages.filter(message => message.role === 'user').map(message => textOf(message.content))
  assert.ok(!sent.join('\n').includes('你好'))
  assert.match(sent[0], /^<开场>[\s\S]*雪下了一整夜[\s\S]*外面冷吗/, 'the opening comes back with the first message sent')
  assert.equal(sent.join('\n').match(/<开场>/g).length, 1)
})

test('every round hidden: the next turn opens with the opening itself', async t => {
  const { turn, hide, fake } = await setup(t)
  const nodes = await turn('你好')
  await hide(nodes[2].id)
  await turn('重新开始')
  const messages = fake.requests.at(-1).messages.filter(message => message.role !== 'system')
  assert.equal(messages.length, 1, 'no history is left')
  assert.match(textOf(messages[0].content), /<开场>[\s\S]*雪下了一整夜[\s\S]*重新开始/)
})

test('the latest round hidden: the next turn goes on without it; a new version of the reply is sent again', async t => {
  const { store, engine, chat, turn, hide, fake } = await setup(t)
  await turn('你好')
  let nodes = await turn('不该说的话')
  const old = nodes[4]
  await hide(old.id)
  await engine.runTurn(chat.id, { userNodeId: nodes[3].id }, () => {})
  nodes = activePath(await store.getChat(chat.id))
  assert.notEqual(nodes[4].id, old.id)
  assert.equal(nodes[4].hidden, undefined, '重新生成: the new reply is not hidden')
  await turn('继续')
  assert.match(sentText(fake.requests.at(-1)), /不该说的话/, 'that round is sent again')
  assert.equal((await store.getChat(chat.id)).nodes[old.id].hidden, true, 'the old version stays hidden')
})

test('after a compaction: rounds before it cannot be hidden; hiding all after it sends the archive with the next turn', async t => {
  const { store, engine, chat, turn, hide, fake } = await setup(t)
  await turn('一')
  await turn('二')
  await turn('三')
  await engine.compactChat(chat.id)
  let nodes = await turn('四')
  const saved = await store.getChat(chat.id)
  assert.throws(() => hideRound(saved, nodes[2].id), /压缩之前/)
  assert.throws(() => hideRound(saved, nodes[6].id), /压缩点/)
  assert.throws(() => hideRound(saved, 'root'), /开场/)
  assert.match(textOf(fake.requests.at(-1).messages.at(-1).content), /<前情提要>/)
  await hide(nodes[8].id)
  await turn('五')
  const messages = fake.requests.at(-1).messages.filter(message => message.role !== 'system')
  assert.equal(messages.length, 1)
  assert.match(textOf(messages[0].content), /<前情提要>[\s\S]*看海[\s\S]*五/, 'the archive is not lost with the round that carried it')
  assert.ok(!textOf(messages[0].content).includes('【你】\n四'), 'nor is the hidden round in its last turns')
})

test('a subscription session already holds its rounds: they cannot be hidden', () => {
  const chat = {
    nodes: {
      root: { id: 'root', role: 'assistant', text: '开场', parent: null, sel: 'u1' },
      u1: { id: 'u1', role: 'user', text: '一', parent: 'root', sel: 'a1' },
      a1: { id: 'a1', role: 'assistant', text: '甲', parent: 'u1', sdk: { sessionId: 's', uuid: 'm' } },
    },
  }
  assert.throws(() => hideRound(chat, 'a1'), /订阅/)
})

test('recent turns and the path the model reads leave hidden rounds out', () => {
  const node = (id, role, text, extra = {}) => ({ id, role, text, ...extra })
  const path = [node('root', 'assistant', '开场'), node('u1', 'user', '一'), node('a1', 'assistant', '甲'), node('u2', 'user', '二'), node('a2', 'assistant', '乙', { hidden: true }), node('u3', 'user', '三'), node('a3', 'assistant', '丙')]
  assert.deepEqual(withoutHidden(path).map(n => n.id), ['root', 'u1', 'a1', 'u3', 'a3'])
  assert.equal(recentExchanges(path, { user: '你', char: '林雪' }), '【你】\n一\n\n【林雪】\n甲\n\n【你】\n三\n\n【林雪】\n丙')
})
