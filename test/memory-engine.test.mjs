// 长期记忆（Beta） through the engine: the 记忆簿 written with a compaction and by 边玩边整理, recalled
// into a later turn's <往事>, kept per branch, carried by an exported story.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat, exportStory, importStory, memoryView, saveMemory } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { memoryOf } from '../server/memory.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const textOf = content => (typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
const lastText = request => textOf(request.messages.at(-1).content)

const ARCHIVE = `<剧情存档>\n${'你在旧邮局遇见了林雪，她把祖母的怀表交给你保管。'.repeat(10)}\n</剧情存档>`
const ENTRIES = `<记忆条目>
[人物] 林雪 | 林雪, 雪儿
邮局职员，话少，信任你。
[物品与地点] 祖母的怀表 | 怀表
银色，停在三点十七分，林雪交给你保管。
</记忆条目>`

/** An OpenAI-compatible model: `answer(request)` says what to reply (else a numbered story reply). */
async function fakeModel(t, answer = () => null) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const text = (await answer(request)) ?? `第${requests.length}次回复。`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests }
}

async function setup(t, { memory = { enabled: true }, answer } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-memory-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const store = createStore(root)
  await store.init()
  const fake = await fakeModel(t, answer)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: 'sk-test', models: [{ id: 'm1' }, { id: 'helper' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', memory, media: { helperModel: `${provider.id}/helper` } })
  const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '林雪', description: '林雪是邮局职员。', first_mes: '雪下了一整夜。' } })
  await store.saveCard(card)
  const engine = createEngine(store, { proxy: null })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    const { nodeId } = await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})
    return { nodes: activePath(await store.getChat(chat.id)), nodeId }
  }
  return { store, engine, chat, turn, fake, helper: `${provider.id}/helper` }
}

const compactionAnswer = ({ withEntries = true } = {}) => request => {
  const last = lastText(request)
  if (last.includes('【暂停扮演：剧情存档】')) return withEntries ? `${ARCHIVE}\n\n${ENTRIES}` : ARCHIVE
  if (last.includes('【暂停扮演：整理记忆】') || request.messages.some(m => textOf(m.content).includes('<原文>'))) return ENTRIES
  return null
}

test('a compaction writes the book; a later turn that talks of it recalls it once, in its own message', async t => {
  const { store, engine, chat, turn, fake } = await setup(t, { answer: compactionAnswer() })
  await turn('收下怀表')
  await turn('出门散步')
  await turn('回家睡觉')
  await engine.compactChat(chat.id)
  const request = fake.requests.at(-1)
  assert.match(lastText(request), /<记忆条目>[\s\S]*人物、事件、物品与地点、约定与伏笔/, 'the archive request asks for the entries too')
  let saved = await store.getChat(chat.id)
  const tip = activePath(saved).at(-1)
  assert.equal(tip.compaction.summary.includes('记忆条目'), false, 'the archive is kept without them')
  assert.deepEqual(tip.compaction.memory.entries.map(e => e.title), ['林雪', '祖母的怀表'])
  assert.deepEqual([tip.compaction.memory.entries[1].from, tip.compaction.memory.entries[1].to], [1, 1], 'placed where it was named')
  assert.deepEqual([tip.compaction.memory.entries[0].from, tip.compaction.memory.entries[0].to], [1, 3], 'named nowhere: the turns the archive read')

  const first = await turn('天气真冷')
  assert.ok(!lastText(fake.requests.at(-1)).includes('<往事>'), 'nothing named, nothing recalled')
  await turn('那块怀表还在走吗')
  const sent = lastText(fake.requests.at(-1))
  assert.match(sent, /<往事>[\s\S]*【物品与地点｜祖母的怀表】银色，停在三点十七分[\s\S]*<\/往事>[\s\S]*<玩家输入>\n那块怀表还在走吗/)
  assert.ok(!fake.requests.at(-1).system?.includes?.('往事'), 'not in the frozen prefix')
  saved = await store.getChat(chat.id)
  const asked = activePath(saved).at(-2)
  assert.deepEqual(asked.recalledTitles, ['祖母的怀表'])
  assert.deepEqual(chatView(saved).path.at(-2).recalled, ['祖母的怀表'])
  await turn('怀表停了')
  assert.ok(!lastText(fake.requests.at(-1)).includes('<往事>'), 'still in the context: not again')
  assert.equal(first.nodes.length > 0, true)
})

test('switched off: the archive request and the turns are as they were', async t => {
  const { store, engine, chat, turn, fake } = await setup(t, { memory: { enabled: false }, answer: compactionAnswer() })
  await turn('去邮局')
  await turn('收下怀表')
  await engine.compactChat(chat.id)
  assert.ok(!lastText(fake.requests.at(-1)).includes('<记忆条目>'))
  assert.equal(activePath(await store.getChat(chat.id)).at(-1).compaction.memory, undefined)
  await turn('那块怀表还在走吗')
  assert.ok(!lastText(fake.requests.at(-1)).includes('<往事>'))
})

test('an archive written without its entries: they are asked for once on their own', async t => {
  const { store, engine, chat, turn, fake } = await setup(t, { answer: compactionAnswer({ withEntries: false }) })
  await turn('去邮局')
  await turn('收下怀表')
  const before = fake.requests.length
  await engine.compactChat(chat.id)
  assert.equal(fake.requests.length - before, 2, 'the archive, then the entries')
  assert.match(lastText(fake.requests.at(-1)), /【暂停扮演：整理记忆】/)
  assert.equal(activePath(await store.getChat(chat.id)).at(-1).compaction.memory.entries.length, 2)
})

test('边玩边整理: every N turns the helper notes them down on the reply; a new version of that reply has no snapshot', async t => {
  const { store, engine, chat, turn, fake, helper } = await setup(t, { memory: { enabled: true, tidy: { enabled: true, every: 5 } }, answer: compactionAnswer() })
  let last
  for (const input of ['一', '二', '三', '四']) last = await turn(input)
  assert.equal(await engine.tidyMemory(chat.id, last.nodeId), false, 'not yet: four turns')
  last = await turn('林雪把怀表给了你')
  assert.equal(await engine.tidyMemory(chat.id, last.nodeId), true)
  const request = fake.requests.at(-1)
  assert.equal(request.model, helper.slice(helper.indexOf('/') + 1), 'the helper model')
  assert.match(textOf(request.messages.at(-1).content), /<原文>[\s\S]*〔第 1 轮〕[\s\S]*〔第 5 轮〕\n【你】林雪把怀表给了你/)
  let saved = await store.getChat(chat.id)
  assert.equal(saved.nodes[last.nodeId].memory.by, 'tidy')
  assert.equal(saved.nodes[last.nodeId].memory.turns, 5)
  assert.equal(memoryView(saved).entries.length, 2)
  assert.equal(await engine.tidyMemory(chat.id, last.nodeId), false, 'nothing new since')

  const user = activePath(saved).at(-2)
  await engine.runTurn(chat.id, { userNodeId: user.id }, () => {})
  saved = await store.getChat(chat.id)
  assert.equal(memoryOf(activePath(saved)), null, 'the regenerated reply is a branch without that snapshot')
})

test('a tidy whose reply is gone by the time it is done writes nothing', async t => {
  let drop = null
  const answer = async request => {
    if (!request.messages.some(m => textOf(m.content).includes('<原文>'))) return null
    await drop?.()
    return ENTRIES
  }
  const { store, engine, chat, turn } = await setup(t, { memory: { enabled: true, tidy: { enabled: true, every: 5 } }, answer })
  let last
  for (const input of ['一', '二', '三', '四', '五']) last = await turn(input)
  drop = () =>
    store.withChat(chat.id, async () => {
      const saved = await store.getChat(chat.id)
      delete saved.nodes[last.nodeId]
      await store.saveChat(saved)
    })
  assert.equal(await engine.tidyMemory(chat.id, last.nodeId), false)
  assert.equal(engine.tidyError(chat.id), null, 'not a failure')
})

test('the player’s edits go to the snapshot in force; an exported story carries the book to the new chat, which recalls it', async t => {
  const { store, engine, chat, turn, fake } = await setup(t, { answer: compactionAnswer() })
  await turn('去邮局')
  await turn('收下怀表')
  await engine.compactChat(chat.id)
  let saved = await store.getChat(chat.id)
  const view = memoryView(saved)
  assert.equal(view.compactedTurns, 2)
  assert.ok(view.entries.every(entry => entry.sourceId), 'each entry knows the message to jump to')
  saveMemory(saved, [...view.entries, { kind: 'promise', title: '看海之约', keys: ['看海'], text: '说好了去看海。', edited: true, pinned: true }])
  await store.saveChat(saved)
  saved = await store.getChat(chat.id)
  assert.equal(activePath(saved).at(-1).compaction.memory.entries.length, 3, 'written where the book was')

  const archive = exportStory(saved)
  assert.equal(archive.memory.length, 3)
  const imported = await importStory(store, chat.cardId, JSON.parse(JSON.stringify(archive)))
  assert.equal(memoryView(imported).entries.length, 3)
  const tip = activePath(imported).at(-1)
  await engine.runTurn(imported.id, { parentId: tip.id, input: '怀表呢' }, () => {})
  const sent = lastText(fake.requests.at(-1))
  assert.match(sent, /<往事>[\s\S]*看海之约[\s\S]*祖母的怀表/, 'the pinned one first, then the one named')
})

test('a recalled entry reaches the model with the names in place of {{user}} and {{char}}', async () => {
  const { buildTurnPrompt } = await import('../server/prompt.mjs')
  const prompt = buildTurnPrompt({ names: { user: '阿遥', char: '青禾' }, opening: '', memory: '【约定与伏笔｜看灯】{{user}}和{{char}}约好雨停去看灯。', input: '走吧', stateText: '' })
  assert.match(prompt, /<往事>\n【约定与伏笔｜看灯】阿遥和青禾约好雨停去看灯。\n<\/往事>/)
})
