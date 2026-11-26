// 这轮变量没更新上: what the program finds wrong with one reply's variables, 修好这轮变量 (the model writes the update
// block again, in place of the old one) and 撤销修复.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { activePath, createChat } from '../server/chats.mjs'
import { createEngine } from '../server/engine.mjs'
import { fixInstruction, fixRequest, updateBlocks, withoutUpdateBlocks } from '../server/mvu.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { keepToSchema } from '../server/schema.mjs'
import { applyStateUpdates, updateSteps } from '../server/state.mjs'
import { initTemplates } from '../server/template.mjs'
import { createStore } from '../server/store.mjs'
import { issueLines, stateDiff, turnVarIssues } from '../server/turn-vars.mjs'
import { testSubscription } from './support/subscription.mjs'

// The card's variable rules run in the same sandbox as templates.
before(() => initTemplates())

const block = ops => `<UpdateVariable>\n<JSONPatch>${ops}</JSONPatch>\n</UpdateVariable>`
const SCHEMA = `import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';
export const Schema = z.object({ 好感: z.number(), 金钱: z.number(), 地点: z.string() });
$(() => { registerMvuSchema(Schema); });`

test('updateSteps: each command of a reply’s update, and what it did', () => {
  const state = { 林雪: { 好感度: 10 }, 金钱: 5, 称号: '新人', 背包: ['刀'], 人物: { 甲: { 好感: 1 }, 乙: { 好感: 2 } } }
  const text = `正文。\n${block('[{"op":"replace","path":"/林雪/好感","value":3},{"op":"delta","path":"/金钱","value":2},{"op":"remove","path":"/背包/9"},{"op":"delta","path":"/称号","value":1},{"op":"add","path":"/背包/-","value":"绳"},{"op":"replace","path":"/人物/丙","value":{"好感":0}},{"op":"replace","path":"/stat_data/林雪/好感度","value":12,},{"op":"replace" "path":"/x"}]')}`
  const { lost, steps } = updateSteps(state, text)
  assert.deepEqual(lost, [''], 'the broken operation is counted, though it cannot be cut out')
  assert.deepEqual(steps.map(({ path, did, why, added, group }) => ({ path, did, ...(why ? { why } : {}), ...(added ? { added, group } : {}) })), [
    { path: '林雪.好感', did: 'new', added: '林雪.好感', group: false },
    { path: '金钱', did: 'set' },
    { path: '背包.9', did: 'idle', why: 'missing' },
    { path: '称号', did: 'idle', why: 'notNumber' },
    { path: '背包.-', did: 'set' },
    { path: '人物.丙', did: 'new', added: '人物.丙', group: true },
    { path: '林雪.好感度', did: 'set' },
  ])
  // Classic MVU calls: one that cannot be read is kept as it was written.
  const calls = updateSteps({ 好感: 1 }, '<UpdateVariable>_.set(\'好感\', 1, 2);\n_.set(\'心情\', [1, );</UpdateVariable>')
  assert.deepEqual(calls.lost, ["_.set('心情', [1, );"])
  assert.equal(calls.steps.length, 1)
  assert.equal(calls.steps[0].did, 'set')
})

test('a card without rules: a slip of a name is told, a new character is not', async () => {
  const before = { 林雪: { 好感度: 10 }, 人物: { 甲: { 好感: 1 }, 乙: { 好感: 2 } } }
  const text = block('[{"op":"replace","path":"/林雪/好感","value":3},{"op":"replace","path":"/人物/丙","value":{"好感":0}},{"op":"replace","path":"/天气","value":"晴"},{"op":"remove","path":"/林雪/心情"}]')
  const items = await turnVarIssues({ before, text, written: {}, kept: { state: {} } })
  assert.deepEqual(items, [
    { kind: 'idle', path: '林雪.心情', why: 'missing', text: '{"op":"remove","path":"/林雪/心情"}' },
    { kind: 'unknown', path: '林雪.好感', near: '林雪.好感度', text: '{"op":"replace","path":"/林雪/好感","value":3}' },
  ])
  // A name in the card's starting variables is the card's own, close to another or not.
  const known = await turnVarIssues({ before, text, written: {}, kept: { state: {} }, initial: { 林雪: { 好感: 0, 好感度: 0 } } })
  assert.equal(known.some(item => item.kind === 'unknown'), false)
  // What the card's scripts made of the commands is theirs.
  assert.deepEqual(await turnVarIssues({ before, text, written: {}, kept: { state: {} }, scripted: true }), [])
})

test('a card with rules: what they dropped, and the command they rejected', async () => {
  const before = { 好感: 10, 金钱: 5, 地点: '茶馆' }
  const check = async state => keepToSchema(SCHEMA, state, []).problem
  const run = async text => {
    const written = applyStateUpdates(before, text).state
    return turnVarIssues({ before, text, written, kept: keepToSchema(SCHEMA, written, []), check })
  }
  // 好感度 is not the card's: the rules drop it, and 好感 is the name it has.
  assert.deepEqual(await run(block('[{"op":"replace","path":"/好感度","value":12}]')), [
    { kind: 'unknown', path: '好感度', near: '好感', text: '{"op":"replace","path":"/好感度","value":12}' },
  ])
  // A string where a number goes: the rules fail the whole turn; the command that did it is found, the rest pass.
  const rejected = await run(block('[{"op":"replace","path":"/地点","value":"码头"},{"op":"replace","path":"/金钱","value":"三百"}]'))
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].kind, 'rule')
  assert.equal(rejected[0].path, '金钱')
  assert.match(rejected[0].why, /金钱/)
  // Variables that failed the rules before the reply (an earlier turn left 金钱 as words): the command that writes
  // 金钱 again is told; with none, that they were wrong before this turn.
  const broken = { ...before, 金钱: 'x' }
  const again = block('[{"op":"replace","path":"/地点","value":"码头"},{"op":"replace","path":"/金钱","value":"还是没钱"}]')
  const written = applyStateUpdates(broken, again).state
  assert.deepEqual((await turnVarIssues({ before: broken, text: again, written, kept: keepToSchema(SCHEMA, written, []), check })).map(item => [item.kind, item.path, item.why]), [['rule', '金钱', '金钱: 要是 number']])
  const elsewhere = block('[{"op":"replace","path":"/地点","value":"码头"}]')
  const earlier = await turnVarIssues({ before: broken, text: elsewhere, written: broken, kept: keepToSchema(SCHEMA, broken, []), check })
  assert.deepEqual(earlier.map(item => [item.kind, item.path, item.earlier]), [['rule', undefined, true]])
  assert.match(issueLines(earlier)[0], /本轮之前的变量就不符合/)
})

test('the model is told each problem in words, and the old block goes', () => {
  const lines = issueLines([
    { kind: 'unread', text: '' },
    { kind: 'idle', path: '背包.绳子', why: 'missing', text: 'x' },
    { kind: 'unknown', path: '好感度', near: '好感' },
    { kind: 'rule', path: '金钱', why: '金钱: 要是 number' },
    { kind: 'rule', why: '整体出错' },
  ])
  assert.equal(lines.length, 5)
  assert.match(lines[1], /「背包\.绳子」这条没有生效：要删的这一项本来就没有（原文：x）/)
  assert.match(lines[2], /应该是「好感」/)
  const asked = fixInstruction({ lines, state: { 好感: 1 } })
  assert.match(asked, /暂停扮演[\s\S]*程序检查出[\s\S]*「金钱」[\s\S]*本轮更新之前的变量[\s\S]*"好感": 1[\s\S]*整个替换原来那个/)
  assert.match(fixInstruction({ lines: [], state: {} }), /玩家觉得这一轮的变量不对/)
  const text = `她笑了。\n<UpdateVariable>旧的</UpdateVariable>\n<state>{"a":1}</state>`
  assert.deepEqual(updateBlocks(text), ['<UpdateVariable>旧的</UpdateVariable>'])
  assert.equal(withoutUpdateBlocks(text), '她笑了。\n\n<state>{"a":1}</state>')
  const request = fixRequest({ books: [], render: () => '', state: { 好感: 1 }, reply: '她笑了。', blocks: updateBlocks(text), lines })
  assert.match(request.messages[0].content, /<原来的变量更新块>\n<UpdateVariable>旧的<\/UpdateVariable>[\s\S]*<程序查出的问题>[\s\S]*只输出 <UpdateVariable>…<\/UpdateVariable> 这一个块。$/)
  assert.equal(request.messages[0].content.match(/只输出/g).length, 1)
})

test('stateDiff: the values 修好 changed, a list as one', () => {
  assert.deepEqual(stateDiff({ a: { b: 1, c: [2, '说明'] }, 名: '甲', 包: [1] }, { a: { b: 2, c: [3, '说明'] }, 包: [1, 2], 新: true }), [
    { path: 'a.b', from: '1', to: '2' },
    { path: 'a.c', from: '2', to: '3' },
    { path: '名', from: '甲', to: '' },
    { path: '包', from: '[1]', to: '[1,2]' },
    { path: '新', from: '', to: 'true' },
  ])
})

async function fakeProvider(t) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const json = JSON.parse(body)
    requests.push(json)
    // A story turn writes 金钱 as words and the wrong name for 好感; the request to put it right gets a good block.
    const text = /程序检查出|玩家觉得/.test(body) && /整个替换/.test(body)
      ? `好的。\n${block('[{"op":"replace","path":"/好感","value":12},{"op":"replace","path":"/金钱","value":300}]')}`
      : `她把找零递给你。\n${block('[{"op":"replace","path":"/好感度","value":12},{"op":"replace","path":"/金钱","value":"三百"}]')}`
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
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-turn-vars-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '小雨', description: '咖啡店店员。', first_mes: '欢迎光临～',
      character_book: { entries: [
        { id: 0, comment: '[InitVar]初始变量', content: '好感: 10\n金钱: 5\n地点: 咖啡店', keys: [], constant: true, enabled: false },
        { id: 1, comment: '[mvu_update]变量输出格式', content: '每次回复结尾输出 <UpdateVariable><JSONPatch>…</JSONPatch></UpdateVariable>。', keys: [], constant: true, enabled: true, position: 4 },
      ] },
    },
  })
  card.mvuSchema = SCHEMA
  await store.saveCard(card)
  const provider = normalizeProvider({ name: 'Fake', api: 'openai-completions', baseURL: fake.baseURL, apiKey: KEY, models: [{ id: 'm1' }] })
  await store.saveProviders([provider])
  await store.saveSettings({ model: `${provider.id}/m1`, subscription: 'off', autoFillUpdate: false })
  const engine = createEngine(store, { proxy: null }, null, { subscription: testSubscription(store, root, () => { throw new Error('no SDK here') }) })
  const chat = await createChat(store, card.id)
  const turn = async input => {
    const tip = activePath(await store.getChat(chat.id)).at(-1)
    return (await engine.runTurn(chat.id, { parentId: tip.id, input }, () => {})).chat
  }
  return { fake, store, engine, chat, turn }
}

const KEY = 'sk-test-1234567890abcd'

test('修好这轮变量: the turn tells what did not take, the model rewrites the block, 撤销 puts it back', async t => {
  const { fake, store, engine, chat, turn } = await setup(t)
  const tip = activePath(await turn('买一杯拿铁')).at(-1)
  assert.equal(tip.state.好感, 10)
  assert.equal(tip.state.金钱, '三百', 'the rules failed, so the reply’s values stay as written')
  assert.ok(tip.schemaProblem)
  // The rules failed, so what they would drop is not known: a name a slip from the card's own is told all the same.
  assert.deepEqual(tip.varIssues.map(item => [item.kind, item.path, item.near]), [['unknown', '好感度', '好感'], ['rule', '金钱', undefined]])

  const fixed = await engine.fixUpdate(chat.id, tip.id)
  const node = fixed.nodes[tip.id]
  assert.equal(node.state.好感, 12)
  assert.equal(node.state.金钱, 300)
  assert.equal(node.schemaProblem, undefined)
  assert.equal(node.varIssues, undefined)
  assert.equal(updateBlocks(node.text).length, 1, 'the new block takes the old one’s place')
  assert.match(node.text, /^她把找零递给你。/)
  assert.deepEqual(node.varFix.changed.map(item => [item.path, item.from, item.to]), [['好感', '10', '12'], ['金钱', '三百', '300'], ['好感度', '12', '']], 'the wrong name the failed rules left is gone')
  const asked = JSON.stringify(fake.requests.at(-1).messages.at(-1))
  assert.match(asked, /程序检查出[\s\S]*「金钱」不符合卡的变量规则/)

  const undone = await engine.undoFix(chat.id, tip.id)
  const back = undone.nodes[tip.id]
  assert.equal(back.text, tip.text)
  assert.equal(back.state.金钱, '三百')
  assert.deepEqual(back.varIssues, tip.varIssues)
  assert.equal(back.varFix, undefined)
  await assert.rejects(engine.undoFix(chat.id, tip.id), /只能撤销/)

  // Fixed twice: each 撤销 steps back one.
  await engine.fixUpdate(chat.id, tip.id)
  const twice = await engine.fixUpdate(chat.id, tip.id)
  assert.equal(twice.nodes[tip.id].varFix.count, 0, 'the second rewrite changed nothing')
  const once = (await engine.undoFix(chat.id, tip.id)).nodes[tip.id]
  assert.equal(once.state.金钱, 300)
  assert.equal(once.varFix.count, 3, 'the first fix, still to be taken back')
  assert.equal((await engine.undoFix(chat.id, tip.id)).nodes[tip.id].state.金钱, '三百')

  // Fixed again and played on: the reply before keeps that it was fixed, not what it was.
  await engine.fixUpdate(chat.id, tip.id)
  const next = activePath(await turn('再来块蛋糕')).at(-1)
  const saved = await store.getChat(chat.id)
  assert.equal(saved.nodes[tip.id].varFix.before, undefined)
  await assert.rejects(engine.fixUpdate(chat.id, tip.id), /最新一条/)
  assert.ok(next.varIssues?.length)
})

test('修好: a reply with nothing found is checked against the story (核对这轮变量); one without a block is for 补写', async t => {
  const { fake, store, engine, chat, turn } = await setup(t)
  const tip = activePath(await turn('买一杯拿铁')).at(-1)
  const saved = await store.getChat(chat.id)
  delete saved.nodes[tip.id].varIssues
  await store.saveChat(saved)
  await engine.fixUpdate(chat.id, tip.id)
  assert.match(JSON.stringify(fake.requests.at(-1).messages.at(-1)), /玩家觉得这一轮的变量不对/)

  const plain = await store.getChat(chat.id)
  plain.nodes[tip.id].text = '她把找零递给你。'
  await store.saveChat(plain)
  await assert.rejects(engine.fixUpdate(chat.id, tip.id), /补写变量/)
})
