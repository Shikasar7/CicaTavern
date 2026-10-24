// The turn reminder of long cards, a card's own options as buttons, mounting
// books in an open chat, and 补写变量 for an MVU reply without its update block.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat, mountChange } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { extractUpdate, usesMvu } from '../server/mvu.mjs'
import { everyTurnReminder } from '../server/prompt.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { normalizeBook } from '../server/worldbook.mjs'
import { otherChoices } from '../web/shared/basic.js'
import { testSubscription } from './support/subscription.mjs'

const KEY = 'sk-test-1234567890abcd'
const UPDATE = '<UpdateVariable>\n<JSONPatch>[{"op":"replace","path":"/好感","value":12}]</JSONPatch>\n</UpdateVariable>'

const entry = (uid, comment, content, extra = {}) => ({ uid, comment, content, keys: [], constant: true, enabled: true, order: uid, position: 4, ...extra })

test('a long card’s reminder names what the reply must contain and counts the rest', () => {
  const lore = Array.from({ length: 6 }, (_, i) => entry(i, `第${i + 1}层守层者`, `她住在第${i + 1}层。`))
  const rules = [entry(10, '[mvu_update]变量输出格式', '正文后输出 <UpdateVariable>。'), entry(11, '0【焊死状态栏】', '在对话的末尾插入状态栏')]
  const books = [{ id: 'b', entries: [...lore, ...rules] }]
  const prefix = '## 每轮回复都要遵守\n【第1层守层者】\n…'
  const reminder = everyTurnReminder(prefix, books, { mvu: true })
  assert.match(reminder, /尤其|包括/)
  assert.match(reminder, /结尾完整闭合的 <UpdateVariable> 变量更新块/)
  assert.match(reminder, /【\[mvu_update\]变量输出格式】、【0【焊死状态栏】】，以及其余 6 条常驻设定。$/)
  assert.doesNotMatch(reminder, /第3层守层者/)
  // A short list is still named in full, as before.
  assert.equal(everyTurnReminder('## 每轮回复都要遵守\n【甲】', [{ id: 'b', entries: [entry(0, '甲', '设定'), entry(1, '乙', '设定')] }]), '本轮回复同样要遵守系统提示末尾「每轮回复都要遵守」一节的全部要求，包括【甲】、【乙】。')
})

test('MVU cards are told apart; an answer’s update block is found', () => {
  assert.equal(usesMvu({ systemPrompt: '' }, [{ entries: [entry(0, '规则', '结尾写 <UpdateVariable>')] }]), true)
  assert.equal(usesMvu({ systemPrompt: '' }, [{ entries: [entry(0, '规则', '结尾写 <UpdateVariable>', { enabled: false })] }]), false)
  assert.equal(extractUpdate(`好的。\n${UPDATE}\n`), UPDATE)
  assert.equal(extractUpdate('<JSONPatch>[]</JSONPatch>'), '<UpdateVariable>\n<JSONPatch>[]</JSONPatch>\n</UpdateVariable>')
  assert.equal(extractUpdate('没有'), '')
})

test('a card’s own options become choices; a story ending stays a story', () => {
  const labelled = otherChoices('她笑了。\n\n🩶堕落选项🩶：任由她继续\n🩵白给选项🩵：主动凑上去\n🔪探索选项🔪：直接进入第二层')
  assert.deepEqual(labelled.choices, ['堕落：任由她继续', '白给：主动凑上去', '探索：直接进入第二层'])
  assert.equal(labelled.text, '她笑了。')
  const headed = otherChoices('店里很安静。\n\n---\n\n请选择你的下一步行动：\n🛠️ **询问炼化服务** —— 了解炼化\n⛓️ **询问签契服务** —— 了解签契')
  assert.deepEqual(headed.choices, ['询问炼化服务 —— 了解炼化', '询问签契服务 —— 了解签契'])
  assert.equal(headed.text, '店里很安静。')
  const block = otherChoices('夜深了。\n<w2g>\nA：回客栈休息\nB：去乱葬岗\n</w2g>')
  assert.deepEqual(block.choices, ['回客栈休息', '去乱葬岗'])
  assert.equal(block.text, '夜深了。')
  const letters = otherChoices('她问你。\nA. 答应\nB. 拒绝\nC. 沉默')
  assert.deepEqual(letters.choices, ['答应', '拒绝', '沉默'])
  // Prose that happens to end in a list, or a single item, is left alone.
  for (const story of ['他列了清单：\n- 面包\n- 牛奶', '她想了想。\nA. 只有一条', '1. 第一步\n2. 第二步\n3. 第三步']) {
    assert.deepEqual(otherChoices(story), { choices: [], text: story })
  }
})

async function fakeProvider(t) {
  const requests = []
  let count = 0
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    requests.push(json)
    const asked = JSON.stringify(json.messages.at(-1))
    // Story turns forget the block; a request to write it gets one.
    const text = /UpdateVariable/.test(asked) && /漏写/.test(body) ? `好的。\n${UPDATE}` : `第 ${++count} 次回复，好感涨了。`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ model: json.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}

async function setup(t) {
  const fake = await fakeProvider(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-mvu-fill-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '小雨', description: '咖啡店店员。', first_mes: '欢迎光临～',
      character_book: { entries: [
        { id: 0, comment: '[InitVar]初始变量', content: '好感: 10\n金钱: 5', keys: [], constant: true, enabled: false },
        { id: 1, comment: '[mvu_update]变量输出格式', content: '每次回复结尾输出 <UpdateVariable><JSONPatch>…</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true, position: 4 },
      ] },
    },
  })
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
  return { fake, store, engine, chat, card, provider, turn }
}

test('补写变量: asked inside the conversation, appended, and the state follows', async t => {
  const { fake, store, engine, chat, card, turn } = await setup(t)
  const after = await turn('点一杯拿铁')
  const tip = activePath(after).at(-1)
  assert.equal(tip.state.好感, 10, 'the reply forgot its block')
  // The turn's reminder now names the block outright.
  assert.match(JSON.stringify(fake.requests.at(-1).messages.at(-1)), /结尾完整闭合的 <UpdateVariable> 变量更新块/)

  const filled = await engine.fillUpdate(chat.id, tip.id)
  const node = filled.nodes[tip.id]
  assert.equal(node.state.好感, 12)
  assert.equal(node.state.金钱, 5, 'the other variables stay')
  assert.deepEqual(node.stateChanges, ['好感'])
  assert.ok(node.text.endsWith(UPDATE), 'the block is appended to the reply')
  assert.match(node.text, /^第 1 次回复，好感涨了。/)
  const side = fake.requests.at(-1)
  assert.equal(side.system ?? side.messages[0].role, 'system', 'the chat’s own prefix')
  assert.match(JSON.stringify(side.messages.at(-1)), /暂停扮演[\s\S]*漏写/)
  await assert.rejects(engine.fillUpdate(chat.id, tip.id), /已经有变量更新/)

  // Only the latest reply, and only for MVU cards.
  const next = activePath(await turn('再来块蛋糕')).at(-1)
  await assert.rejects(engine.fillUpdate(chat.id, tip.id), /最新一条/)
  const plain = await store.getCard(card.id)
  plain.book.entries = plain.book.entries.filter(e => e.uid === '0')
  await store.saveCard(plain)
  await assert.rejects(engine.fillUpdate(chat.id, next.id), /不用 MVU/)
})

test('补写变量 for a subscription reply: the helper model gets the rules, the variables and the reply', async t => {
  const { fake, store, engine, chat, provider, turn } = await setup(t)
  const tip = activePath(await turn('点一杯拿铁')).at(-1)
  const saved = await store.getChat(chat.id)
  saved.model = 'claude-sonnet-5-5'
  saved.nodes[tip.id] = { ...saved.nodes[tip.id], api: null, model: 'claude-sonnet-5-5' }
  await store.saveChat(saved)
  await store.saveSettings({ media: { helperModel: `${provider.id}/m1` } })
  const filled = await engine.fillUpdate(chat.id, tip.id)
  assert.equal(filled.nodes[tip.id].state.好感, 12)
  assert.equal(filled.nodes[tip.id].state.金钱, 5)
  const asked = JSON.stringify(fake.requests.at(-1).messages)
  assert.match(asked, /变量规则[\s\S]*每次回复结尾输出[\s\S]*本轮之前的变量[\s\S]*好感[\s\S]*本轮剧情[\s\S]*第 1 次回复/)
})

test('mounting books in an open chat: which ones change its prefix', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-mount-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const rules = await store.saveBook(normalizeBook({ id: 'rules', name: '规则书', entries: [entry(0, '规则', '每轮都要写状态栏', { position: 0 })] }))
  const keyword = await store.saveBook(normalizeBook({ id: 'lore', name: '资料书', entries: [entry(0, '城镇', '一座小镇', { constant: false, keys: ['小镇'] })] }))
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '小雨', description: '店员', first_mes: '你好' } })
  card.worldbookIds = [rules.id]
  await store.saveCard(card)
  const chat = await createChat(store, card.id)
  assert.equal(await mountChange(store, chat, card), null, 'nothing changed yet')
  card.worldbookIds = [keyword.id]
  await store.saveCard(card)
  // The keyword book follows by itself; taking off the constant one is what the prefix keeps.
  assert.deepEqual(await mountChange(store, chat, card), { added: [], removed: [{ id: rules.id, name: '规则书', entries: 1 }] })
  card.worldbookIds = [keyword.id, rules.id]
  await store.saveCard(card)
  assert.equal(await mountChange(store, chat, card), null)
})

test('a card’s options: a line opening on a long run of ** and symbols is turned down at once', () => {
  // (**·**·… could be split two ways at every ** and took seconds, then minutes, as it grew.)
  for (const line of [`${'**·'.repeat(40)}x`, `${'**✦'.repeat(40)}探索选项：去码头`, `${'*'.repeat(80)}选项`]) {
    const started = performance.now()
    otherChoices(`正文。\n\n${line}`)
    assert.ok(performance.now() - started < 200, line.slice(0, 20))
  }
  assert.deepEqual(otherChoices(`她笑了。\n\n${'**✦'.repeat(3)}**探索选项**：去码头\n**堕落选项**：留下`).choices, ['探索：去码头', '堕落：留下'])
})
