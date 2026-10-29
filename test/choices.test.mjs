// The built-in presets' four choices: kept in what the model reads again (it stopped writing them when
// every earlier reply came back without), older chats' history left as it was sent, and 重写选项.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { asksChoices, basicPreset, choicesInstruction, choicesRequest, extractChoices, keepsChoices, replyScripts, withChoices } from '../server/basic.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, chatView, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { everyTurnReminder } from '../server/prompt.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { applyScripts, PLACEMENT } from '../web/shared/regex.js'
import { choicesOf } from '../web/shared/basic.js'
import { testSubscription } from './support/subscription.mjs'

const KEY = 'sk-test-1234567890abcd'
const block = tag => `<choices>\nA. 甲${tag}\nB. 乙${tag}\nC. 丙${tag}\nD. 丁${tag}\n</choices>`

test('which replies keep their choices in the history', () => {
  const reply = '她笑了。\n\n<choices>\nA. 问她\nB. 走开\n</choices>'
  const scripts = basicPreset({}).regexScripts
  const sent = (chat, node) => applyScripts(reply, replyScripts(scripts, chat, node), { placement: PLACEMENT.AI_OUTPUT, target: 'prompt', depth: 3, macros: t => t })
  const at = createdAt => ({ createdAt })
  // A chat from before: none, until its first new reply.
  assert.equal(keepsChoices({}, at('2026-10-29T10:00:00.000Z')), false)
  assert.equal(sent({}, at('2026-10-29T10:00:00.000Z')), '她笑了。\n\n')
  // Then that reply and the later ones; the older ones as they were sent.
  const older = { choicesKept: '2026-10-29T10:00:00.000Z' }
  assert.equal(sent(older, at('2026-10-29T09:59:59.999Z')), '她笑了。\n\n')
  assert.equal(sent(older, at('2026-10-29T10:00:00.000Z')), reply)
  // A chat started since: all of them.
  assert.equal(sent({ choicesKept: '' }, at('2020-01-01T00:00:00.000Z')), reply)
})

test('a chat asks for choices when its built-in preset wrote the rule into its prefix', () => {
  assert.equal(asksChoices({ presetId: '', systemPrompt: '…<choices>…' }), true)
  assert.equal(asksChoices({ presetId: 'vn', systemPrompt: '…<choices>…' }), true)
  assert.equal(asksChoices({ presetId: 'basic', systemPrompt: '选项关了' }), false)
  assert.equal(asksChoices({ presetId: 'imported', systemPrompt: '…<choices>…' }), false)
  assert.equal(asksChoices({ presetId: null, systemPrompt: '…<choices>…' }), false)
  const prefix = '## 每轮回复都要遵守\n…'
  assert.match(everyTurnReminder(prefix, [], { presetRules: true, choices: true }), /<choices>…<\/choices> 里的四个行动选项（之前的回复里没有也照写）/)
  assert.doesNotMatch(everyTurnReminder(prefix, [], { presetRules: true }), /choices/)
})

test('重写选项: the answer read however it is written, and put where the old ones were', () => {
  assert.equal(extractChoices('好的。\n<choices>\nA. 一\nB) 二\nC：三\nD. 四\n</choices>'), '<choices>\nA. 一\nB. 二\nC. 三\nD. 四\n</choices>')
  assert.equal(extractChoices('A. 一\nB. 二\n（说明）'), '<choices>\nA. 一\nB. 二\n</choices>', 'no tags: the lettered lines')
  assert.equal(extractChoices('<choices>\nA. 只有一个\n</choices>'), '')
  assert.equal(extractChoices('我不知道'), '')
  const fresh = block('新')
  // In place (the model may put them before its update block), an unfinished one replaced to the end, else added.
  assert.equal(withChoices(`正文\n\n${block('旧')}\n\n<UpdateVariable>u</UpdateVariable>`, fresh), `正文\n\n${fresh}\n\n<UpdateVariable>u</UpdateVariable>`)
  assert.equal(withChoices('正文\n<choices>\nA. 写到一半', fresh), `正文\n${fresh}`)
  assert.equal(withChoices('正文  \n', fresh), `正文\n\n${fresh}`)
  assert.match(choicesInstruction('阿青', ['问她', '走开']), /暂停扮演[\s\S]*四个「阿青」[\s\S]*原来的选项是：问她；走开。这次换一组不一样的。/)
  const request = choicesRequest({ names: { user: '阿青', char: '小雨' }, story: [{ role: 'user', text: '进门' }, { role: 'assistant', text: '她抬头。' }], language: 'English' })
  assert.match(request.system, /玩家扮演「阿青」[\s\S]*使用English写作/)
  assert.match(request.messages[0].content, /【阿青】\n进门\n\n【小雨】\n她抬头。/)
})

async function fakeProvider(t) {
  const requests = []
  const state = { count: 0, choices: true }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    requests.push(json)
    let text
    // A request for choices (in the conversation, or of the helper model) gets them; story turns get a reply.
    if (/重新写行动选项|为这一轮的结尾写四个/.test(body)) text = `好的。\n${block('新')}`
    else {
      state.count++
      text = state.choices ? `第 ${state.count} 次回复。\n\n${block(state.count)}` : `第 ${state.count} 次回复。`
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, state, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

async function setup(t) {
  const fake = await fakeProvider(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-choices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '小雨', description: '咖啡店店员。', first_mes: '欢迎光临～' } })
  await store.saveCard(card)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off' })
  const engine = createEngine(store, { proxy: null }, null, { subscription: testSubscription(store, root, () => { throw new Error('no SDK here') }) })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    return (await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})).chat
  }
  return { fake, store, engine, chat, provider, turn }
}

const replies = request => request.messages.filter(m => m.role === 'assistant').map(m => m.content)
/** The earlier request's messages are where the later one starts, byte for byte (the cache hits). */
function continues(later, earlier) {
  assert.equal(later.messages[0].content, earlier.messages[0].content, 'the same prefix')
  assert.deepEqual(later.messages.slice(0, earlier.messages.length), earlier.messages)
}

test('a new chat sends its replies back with their choices, the same every turn', async t => {
  const { fake, chat, turn } = await setup(t)
  assert.equal(chat.choicesKept, '')
  assert.equal(chatView(chat).asksChoices, true)
  await turn('点一杯拿铁')
  await turn('坐下')
  await turn('看窗外')
  const [, second, third] = fake.requests
  assert.deepEqual(replies(third), [`第 1 次回复。\n\n${block(1)}`, `第 2 次回复。\n\n${block(2)}`])
  continues(third, second)
  // The turn's reminder names them, in the turn's own message.
  assert.match(third.messages.at(-1).content, /<本轮提醒>[\s\S]*<choices>…<\/choices> 里的四个行动选项/)
})

test('a chat from before: its old replies stay as they were sent, the new ones keep their choices', async t => {
  const { fake, store, chat, turn } = await setup(t)
  await turn('点一杯拿铁')
  await turn('坐下')
  const old = await store.getChat(chat.id)
  delete old.choicesKept
  await store.saveChat(old)
  const before = fake.requests.length
  await turn('看窗外')
  const first = fake.requests[before]
  assert.deepEqual(replies(first), ['第 1 次回复。', '第 2 次回复。'], 'as 2.1.0 sent them')
  const marked = await store.getChat(chat.id)
  const latest = activePath(marked).at(-1)
  assert.equal(marked.choicesKept, latest.createdAt)
  await turn('喝一口')
  const next = fake.requests.at(-1)
  continues(next, first)
  assert.deepEqual(replies(next), ['第 1 次回复。', '第 2 次回复。', `第 3 次回复。\n\n${block(3)}`])
})

test('重写选项: asked with the next turn’s context, swapped in, and sent back with the reply', async t => {
  const { fake, store, engine, chat, turn } = await setup(t)
  await turn('点一杯拿铁')
  const tip = activePath(await turn('坐下')).at(-1)
  const story = fake.requests.at(-1)
  const rewritten = await engine.rewriteChoices(chat.id, tip.id)
  const node = rewritten.nodes[tip.id]
  assert.equal(node.text, `第 2 次回复。\n\n${block('新')}`, 'the story as it was, the new choices in place of the old')
  assert.deepEqual(choicesOf(node.text), ['甲新', '乙新', '丙新', '丁新'])
  assert.ok(node.rewroteChoices?.at)
  // The side question: the chat's prefix and history up to the reply (as the next turn sends them), then the ask.
  const side = fake.requests.at(-1)
  continues(side, story)
  assert.match(side.messages.at(-1).content, /暂停扮演[\s\S]*原来的选项是：甲2；乙2；丙2；丁2/)
  // The next turn: everything before the reply as before, the reply with its new choices.
  await turn('看窗外')
  const next = fake.requests.at(-1)
  continues(next, story)
  assert.equal(replies(next).at(-1), `第 2 次回复。\n\n${block('新')}`)

  // A reply without any gets them added at its end.
  fake.state.choices = false
  const bare = activePath(await turn('喝一口')).at(-1)
  assert.deepEqual(choicesOf(bare.text), [])
  const added = await engine.rewriteChoices(chat.id, bare.id)
  assert.equal(added.nodes[bare.id].text, `第 4 次回复。\n\n${block('新')}`)
  assert.doesNotMatch(fake.requests.at(-1).messages.at(-1).content, /原来的选项/)

  // Only the latest reply; only in a chat that asks for them.
  await assert.rejects(engine.rewriteChoices(chat.id, tip.id), /最新一条/)
  const off = await store.getChat(chat.id)
  off.systemPrompt = off.systemPrompt.replaceAll('<choices>', '<options>')
  await store.saveChat(off)
  await assert.rejects(engine.rewriteChoices(chat.id, bare.id), /不写行动选项/)
})

test('重写选项 in a chat from before: the reply keeps its new choices, the older ones stay as sent', async t => {
  const { fake, store, engine, chat, turn } = await setup(t)
  await turn('点一杯拿铁')
  const tip = activePath(await turn('坐下')).at(-1)
  const old = await store.getChat(chat.id)
  delete old.choicesKept
  await store.saveChat(old)
  const rewritten = await engine.rewriteChoices(chat.id, tip.id)
  assert.equal(rewritten.choicesKept, tip.createdAt)
  const side = fake.requests.at(-1)
  assert.deepEqual(replies(side), ['第 1 次回复。', '第 2 次回复。'], 'asked as the history stood')
  await turn('看窗外')
  const next = fake.requests.at(-1)
  assert.deepEqual(replies(next), ['第 1 次回复。', `第 2 次回复。\n\n${block('新')}`])
  assert.deepEqual(next.messages.slice(0, 4), side.messages.slice(0, 4), 'up to the player’s message before the reply, as before')
})

test('重写选项 for a subscription reply: the helper model reads the last turns', async t => {
  const { fake, store, engine, chat, provider, turn } = await setup(t)
  const tip = activePath(await turn('点一杯拿铁')).at(-1)
  const saved = await store.getChat(chat.id)
  saved.model = 'claude-sonnet-5-5'
  saved.nodes[tip.id] = { ...saved.nodes[tip.id], api: null, model: 'claude-sonnet-5-5' }
  await store.saveChat(saved)
  await store.saveSettings({ media: { helperModel: `${provider.id}/m1` } })
  const rewritten = await engine.rewriteChoices(chat.id, tip.id)
  assert.deepEqual(choicesOf(rewritten.nodes[tip.id].text), ['甲新', '乙新', '丙新', '丁新'])
  const asked = fake.requests.at(-1)
  assert.match(JSON.stringify(asked.messages), /为这一轮的结尾写四个[\s\S]*最近剧情[\s\S]*点一杯拿铁[\s\S]*第 1 次回复/)
})
