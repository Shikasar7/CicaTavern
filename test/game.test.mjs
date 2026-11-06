// 游戏规则: the dice, the marks, the sheet, a card's rule book, and what a turn keeps when the rules are on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { chanceOf, clampDc, judge, modifierOf, randomFrom, riskOf, rollD20, seedOf } from '../web/shared/game/dice.js'
import { changeWords, choiceChecks, choiceFights, cutAtGate, gateOf, parseChoice, replyMarks, withoutGameMarks } from '../web/shared/game/marks.js'
import { applyOps, attributeOf, chanceFor, checkLine, cleanCheck, cleanOps, cleanRulebook, dcFor, gateKinds, modifierFor, pausesOn, rollCheck, rulesOn, settleReply, sheetOf, sheetOnPath, startSheet, turnSheet } from '../web/shared/game/sheet.js'
import { attemptSetup, autoAction, battleSetup, fieldFoes, foeSheets, startBattle, step } from '../web/shared/game/battle.js'
import { chanceToWin, cleanFight, encounterSetup, foesLine } from '../web/shared/game/encounter.js'
import { gamePrompt, parseFoes } from '../server/game.mjs'
import { splitLines } from '../web/shared/vn.js'

test('a seed gives the same numbers every time, different seeds different ones', () => {
  assert.equal(seedOf('chat', 'node', '翻墙'), seedOf('chat', 'node', '翻墙'))
  assert.notEqual(seedOf('chat-1', 'root', '翻墙'), seedOf('chat-2', 'root', '翻墙'), 'every chat has a root: its id tells them apart')
  assert.notEqual(seedOf('ab', 'c'), seedOf('a', 'bc'), 'the parts stay apart')
  const first = randomFrom(7)
  const again = randomFrom(7)
  assert.deepEqual([first(), first(), first()], [again(), again(), again()])
  const counts = Array(21).fill(0)
  for (let i = 0; i < 20000; i++) counts[rollD20(seedOf('roll', String(i)))]++
  assert.equal(counts[0], 0)
  for (let face = 1; face <= 20; face++) assert.ok(counts[face] > 850 && counts[face] < 1150, `face ${face} came up ${counts[face]} times`)
})

test('a roll against a DC: four outcomes, a 1 and a 20 settle it whatever the sum', () => {
  assert.deepEqual(judge(11, 2, 12), { roll: 11, modifier: 2, total: 13, dc: 12, tier: 'success' })
  assert.equal(judge(10, 0, 12).tier, 'close', 'two short gets there, at a price')
  assert.equal(judge(9, 0, 12).tier, 'fail')
  assert.equal(judge(19, 3, 12).tier, 'crit', 'ten over')
  assert.equal(judge(20, -2, 25).tier, 'crit')
  assert.equal(judge(1, 5, 5).tier, 'fail', 'a 1 fails even past the DC')
  assert.equal(modifierOf(10), 0)
  assert.equal(modifierOf(6), -2)
  assert.equal(modifierOf(11), 0)
  assert.equal(modifierOf(20), 5)
  assert.equal(clampDc(3), 5)
  assert.equal(clampDc(40), 25)
})

test('the chance shown counts 险胜 and the two dice that settle it', () => {
  assert.equal(chanceOf(2, 12), 65)
  assert.equal(chanceOf(0, 12), 55)
  assert.equal(chanceOf(5, 5), 95, 'a 1 still fails')
  assert.equal(chanceOf(-2, 25), 5, 'a 20 still gets there')
  assert.equal(riskOf(75), 'safe')
  assert.equal(riskOf(65), 'risky')
  assert.equal(riskOf(40), 'risky')
  assert.equal(riskOf(35), 'danger')
})

test('marks are read forgivingly, and what makes no sense stays in the text', () => {
  assert.deepEqual(gateOf('她笑了。\n【检定|灵巧|DC12】'), { kind: 'check', stat: '灵巧', dc: 12 })
  assert.deepEqual(gateOf('【检定｜轻功】'), { kind: 'check', stat: '轻功', dc: 12 }, 'no DC: 12')
  assert.deepEqual(gateOf('【检定|DC16】'), { kind: 'check', stat: '', dc: 16 }, 'no attribute')
  assert.deepEqual(gateOf('**【检定|力量|难度 18】**'), { kind: 'check', stat: '力量', dc: 18 })
  assert.deepEqual(gateOf('【检定|力量|99】'), { kind: 'check', stat: '力量', dc: 25 })
  assert.deepEqual(gateOf('【战斗|灰狼×2:杂兵|狼王:精英】').foes, [{ name: '灰狼', count: 2, tier: 'minion' }, { name: '狼王', count: 1, tier: 'elite' }])
  assert.deepEqual(gateOf('【战斗|山贼x9】').foes, [{ name: '山贼', count: 4, tier: 'normal' }], 'four at most')
  assert.deepEqual(gateOf('【战斗|甲:首领，乙：不知道】').foes, [{ name: '甲', count: 1, tier: 'boss' }, { name: '乙', count: 1, tier: 'normal', power: '不知道' }])
  assert.equal(gateOf('【战斗|】'), null)
  assert.deepEqual(replyMarks('捡到【获得|铜钥匙×2】，丢了【失去|伞】。'), [{ kind: 'gain', name: '铜钥匙', count: 2 }, { kind: 'lose', name: '伞', count: 1 }])
  assert.deepEqual(replyMarks('【获得|绳×0】【获得|绳×abc】').map(mark => [mark.name, mark.count]), [['绳', 1], ['绳×abc', 1]])
  assert.deepEqual(replyMarks('【任务|新|寻找铜钥匙|掌柜托的】【任务|完成|寻找铜钥匙】【任务|失败|送信】'), [
    { kind: 'quest', status: 'new', title: '寻找铜钥匙', note: '掌柜托的' },
    { kind: 'quest', status: 'done', title: '寻找铜钥匙', note: '' },
    { kind: 'quest', status: 'failed', title: '送信', note: '' },
  ])
  assert.deepEqual(replyMarks('【受伤|重】【恢复|不知道】【学会|旋风斩】'), [{ kind: 'hurt', size: 'heavy' }, { kind: 'heal', size: 'light' }, { kind: 'learn', name: '旋风斩' }])
  assert.deepEqual(replyMarks('【任务|随便】【好感|+5】【系统】'), [])
  assert.equal(withoutGameMarks('【任务|随便】【好感|+5】'), '【任务|随便】【好感|+5】')
})

test('a mark in the wrong brackets is still the mark', () => {
  for (const mark of ['<检定|灵巧|DC12>', '[检定|灵巧|DC12]', '〖检定|灵巧|DC12〗', '［检定｜灵巧｜DC12］']) {
    assert.deepEqual(gateOf(`她伸手。\n\n${mark}`), { kind: 'check', stat: '灵巧', dc: 12 }, mark)
    assert.equal(withoutGameMarks(`她伸手。\n\n${mark}`), '她伸手。\n', mark)
  }
  assert.equal(cutAtGate('她伸手。\n<检定|灵巧|DC12>\n多写的话。').text, '她伸手。\n<检定|灵巧|DC12>')
  assert.deepEqual(parseChoice('翻过断崖<检定|灵巧|DC12>').check, { kind: 'check', stat: '灵巧', dc: 12 })
  assert.equal(gateOf('<b>粗体</b> [注释|说明] <div class="a|b">'), null, 'other brackets are other things')
})

test('a mark in the thinking, an update block or the action choices is no stop', () => {
  const lettered = '她看着你。\n\nA. 翻过断崖【检定|灵巧|DC12】\nB. 绕路走\nC. 等天亮\nD. 回头'
  assert.equal(gateOf(lettered), null, 'lettered lines are choices: cutting there would lose the rest')
  assert.equal(cutAtGate(lettered).text, lettered)
  assert.equal(gateOf('<think>也许【检定|灵巧|DC12】</think>她看着你。'), null)
  assert.equal(gateOf('<think>没写完【检定|灵巧|DC12】'), null)
  assert.equal(gateOf('她看着你。\n<choices>\nA. 翻过断崖【检定|灵巧|DC12】\nB. 绕路\n</choices>'), null)
  assert.equal(gateOf('<UpdateVariable>【战斗|灰狼】</UpdateVariable>'), null)
  assert.equal(gateOf('她看着你。\n1️⃣ 翻过断崖【检定|灵巧|DC12】\n2️⃣ 绕路'), null)
  assert.equal(gateOf('<选项>\nA. 翻过【检定|灵巧|DC12】\nB. 绕路\n</选项>'), null)
  assert.deepEqual(replyMarks('<think>【获得|金币×9】</think>【获得|铜钥匙】'), [{ kind: 'gain', name: '铜钥匙', count: 1 }])
})

test('a reply stops at its first stop, and what came after it is gone', () => {
  const { text, gate } = cutAtGate('她伸手。\n【检定|灵巧|DC12】\n你成功了！\n【检定|力量|DC8】\n<UpdateVariable>_.set(\'好感\', 9);</UpdateVariable>')
  assert.equal(text, '她伸手。\n【检定|灵巧|DC12】')
  assert.deepEqual(gate, { kind: 'check', stat: '灵巧', dc: 12 })
  assert.deepEqual(cutAtGate('什么也没发生。'), { text: '什么也没发生。', gate: null })
  assert.equal(gateOf('狼来了【战斗|灰狼】然后【检定|灵巧|DC12】').kind, 'battle', 'the first one counts')
  assert.equal(cutAtGate('【获得|绳】前文【检定|灵巧】【获得|刀】').text, '【获得|绳】前文【检定|灵巧】', 'what came before it stays')
})

test('an action choice: the text as sent, and the roll or the fight it asks for', () => {
  assert.deepEqual(parseChoice('翻过断崖抄近路【检定|灵巧|DC12】'), { text: '翻过断崖抄近路', check: { kind: 'check', stat: '灵巧', dc: 12 } })
  assert.deepEqual(parseChoice('绕路走'), { text: '绕路走', check: null })
  assert.deepEqual(parseChoice('拔剑【战斗|灰狼×2:杂兵】'), { text: '拔剑', check: null, fight: { kind: 'battle', foes: [{ name: '灰狼', count: 2, tier: 'minion' }] } })
  const reply = '她看着你。\n<choices>\nA. 拔刀迎战【战斗|灰狼:杂兵】\nB. 绕路走\n</choices>'
  assert.deepEqual([...choiceFights(reply).keys()], ['拔刀迎战'])
  assert.equal(gateOf(reply), null, 'on a choice it stops nothing')
})

test('where a reply\'s first change comes: the line before its mark', () => {
  assert.equal(changeWords('你踏空了。\n\n手摸到一把钥匙。【获得|钥匙】\n她笑了。【受伤|轻】'), '手摸到一把钥匙。')
  assert.equal(changeWords('你踏空了。\n\n【受伤|轻】\n她笑了。'), '你踏空了。', 'on a line of its own')
  assert.equal(changeWords('【受伤|轻】她笑了。'), '', 'first thing in the reply')
  assert.equal(changeWords('她笑了。'), null)
  assert.equal(changeWords('她伸手。\n【检定|灵巧|DC12】'), null, 'a stop changes nothing')
  assert.equal(changeWords('她看着你。\n<choices>\nA. 拿走【获得|绳】\n</choices>'), null, 'nor do the choices')
})

test('the marks leave what is shown; a line that held nothing else goes too', () => {
  assert.equal(withoutGameMarks('她笑了。\n【检定|灵巧|DC12】\n【获得|绳】'), '她笑了。')
  assert.equal(withoutGameMarks('你捡起它。【获得|绳】她点头。'), '你捡起它。她点头。')
  assert.equal(withoutGameMarks('第一段\n\n第二段'), '第一段\n\n第二段')
})

test('a rule book: anything stored or sent comes out clean, and off by default', () => {
  const plain = cleanRulebook(null)
  assert.equal(plain.level, 'off')
  assert.equal(plain.difficulty, 'normal')
  assert.equal(rulesOn(plain), false)
  assert.equal(rulesOn(null), false)
  assert.equal(rulesOn(cleanRulebook({ level: 'light' })), true)
  const odd = cleanRulebook({ level: 'god', difficulty: 9, attributes: { body: 99, grace: 1, mind: 'x' }, start: { things: [{ name: ' 绳 ', count: 2 }, { name: '', count: 1 }, 'x', { name: '刀', count: -1 }], skills: ['斩', 3, ''] }, extra: true })
  assert.equal(odd.level, 'off')
  assert.equal(odd.difficulty, 'normal')
  assert.deepEqual(odd.attributes, { body: 20, grace: 6, mind: 10, charm: 10 })
  assert.deepEqual(odd.start, { things: [{ name: '绳', count: 2 }, { name: '刀', count: 1 }], skills: ['斩'] })
  assert.equal('extra' in odd, false)
  assert.deepEqual(cleanRulebook(odd), odd)
})

test('what a word adds to a roll, and the DC by difficulty', () => {
  const sheet = startSheet({ attributes: { grace: 14, body: 7 } })
  assert.equal(attributeOf('轻功'), 'grace')
  assert.equal(attributeOf('灵巧'), 'grace')
  assert.equal(attributeOf('厨艺'), null)
  assert.equal(modifierFor(sheet, '轻功'), 2)
  assert.equal(modifierFor(sheet, '力量'), -2)
  assert.equal(modifierFor(sheet, '厨艺'), 0, 'a word that is no attribute adds nothing')
  assert.equal(dcFor(12, 'easy'), 10)
  assert.equal(dcFor(12, 'normal'), 12)
  assert.equal(dcFor(12, 'hard'), 14)
  assert.equal(dcFor(25, 'hard'), 25)
})

test('the sheet follows the marks, and never changes the one it was given', () => {
  const start = startSheet({ start: { things: [{ name: '绳', count: 1 }], skills: ['斩'] } })
  const frozen = JSON.stringify(start)
  const after = settleReply(start, replyMarks('【获得|绳×2】【获得|刀】【失去|绳】【学会|旋风斩】【学会|斩】【任务|新|送信|给掌柜】【任务|完成|送信】'))
  assert.deepEqual(after.things, [{ name: '绳', count: 2 }, { name: '刀', count: 1 }])
  assert.deepEqual(after.skills, ['斩', '旋风斩'])
  assert.deepEqual(after.quests, [{ title: '送信', note: '给掌柜', status: 'done' }])
  assert.equal(JSON.stringify(start), frozen)
  assert.deepEqual(settleReply(start, replyMarks('【失去|绳×9】【失去|没有的东西】')).things, [])
  assert.equal(settleReply(start, replyMarks('【受伤|中】')).life, 75)
  assert.equal(settleReply(start, replyMarks('【受伤|重】【受伤|重】【受伤|重】')).life, 1, 'only a fight brings the player down')
  assert.equal(settleReply(start, replyMarks('【恢复|重】')).life, 100)
  assert.equal(settleReply({ ...start, life: 40 }, replyMarks('【恢复|轻】')).life, 50)
  assert.equal(sheetOnPath([{ game: start }, {}, {}]), start, 'a reply without one: the story carries on from the last')
  assert.equal(sheetOnPath([{}, {}]), null)
})

const FAIL = Symbol.for('fail').description

async function tavern(t, replies) {
  const sent = []
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    sent.push(JSON.parse(body))
    const content = replies.shift() ?? '……'
    res.writeHead(content === FAIL ? 400 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-game-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    model.closeAllConnections()
    model.close()
    app.network?.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + pathname, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, body: text }
    }
  }
  const provider = (await call('/api/providers', { name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'x', models: ['writer'] })).body
  await call('/api/settings', { model: `${provider.id}/writer` }, 'PUT')
  const file = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '林青禾', description: '茶馆掌柜', first_mes: '欢迎光临。' } })).toString('base64')
  const card = (await call('/api/cards/import', { filename: 'c.json', data: file })).body
  const newChat = async () => (await call('/api/chats', { cardId: card.id })).body
  const take = async (chat, input) => {
    const view = (await call(`/api/chats/${chat.id}`)).body
    const answer = await call(`/api/chats/${chat.id}/turn`, { parentId: view.path.at(-1).id, input })
    assert.match(String(answer.body), /"type":"done"/)
    return (await call(`/api/chats/${chat.id}`)).body
  }
  return { base, call, card, newChat, sent, take }
}

test('a card has a rule book: off until asked, kept per card, an unknown card has none', async t => {
  const { call, card } = await tavern(t, [])
  assert.equal((await call(`/api/cards/${card.id}/game`)).body.level, 'off')
  const saved = await call(`/api/cards/${card.id}/game`, { level: 'light', attributes: { grace: 14 } }, 'PUT')
  assert.equal(saved.status, 200)
  assert.equal(saved.body.level, 'light')
  assert.equal((await call(`/api/cards/${card.id}/game`, { difficulty: 'hard' }, 'PUT')).body.level, 'light', 'a change keeps the rest')
  const read = (await call(`/api/cards/${card.id}/game`)).body
  assert.equal(read.difficulty, 'hard')
  assert.equal(read.attributes.grace, 14)
  assert.equal((await call('/api/cards/nope/game')).status, 404)
})

test('rules off: a turn is what it always was, word for word', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['她笑了。【获得|绳】', '她笑了。【获得|绳】', '她笑了。【获得|绳】'])
  const plain = await take(await newChat(), '你好')
  await call(`/api/cards/${card.id}/game`, { level: 'off', difficulty: 'hard' }, 'PUT')
  const asOff = await take(await newChat(), '你好')
  const words = request => request.messages.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
  assert.deepEqual(words(sent[1]), words(sent[0]), 'a stored rule book that is off sends what no rule book sends')
  for (const view of [plain, asOff]) {
    assert.equal(view.path.at(-1).game, undefined)
    assert.equal(view.path.at(-1).raw, '她笑了。【获得|绳】', 'a mark in a card without rules is the card\'s own')
  }
})

test('rules on: each reply keeps the sheet, carried on from the one before', async t => {
  const { call, card, newChat, take } = await tavern(t, ['【获得|绳×2】', '【失去|绳】【学会|斩】', '没写标记。', '重写：【获得|刀】'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', start: { things: [{ name: '干粮', count: 1 }] } }, 'PUT')
  const chat = await newChat()
  assert.equal((await take(chat, '一')).path.at(-1).game.things.length, 2, 'the first reply starts from the rule book')
  const second = await take(chat, '二')
  assert.deepEqual(second.path.at(-1).game.things, [{ name: '干粮', count: 1 }, { name: '绳', count: 1 }])
  assert.deepEqual(second.path.at(-1).game.skills, ['斩'])
  const third = await take(chat, '三')
  assert.deepEqual(third.path.at(-1).game, second.path.at(-1).game, 'a reply without marks changes nothing')
  const again = await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: third.path.at(-2).id })
  assert.match(String(again.body), /"type":"done"/)
  const redone = (await call(`/api/chats/${chat.id}`)).body
  assert.deepEqual(redone.path.at(-1).game.things, [{ name: '干粮', count: 1 }, { name: '绳', count: 1 }, { name: '刀', count: 1 }], 'a new version starts from the same reply before')
})

test('rules switched off and on: the story picks its sheet up where it left it', async t => {
  const { call, card, newChat, take } = await tavern(t, ['【获得|绳】', '【获得|刀】', '【获得|药】'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await take(chat, '一')
  await call(`/api/cards/${card.id}/game`, { level: 'off' }, 'PUT')
  assert.equal((await take(chat, '二')).path.at(-1).game, undefined)
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  assert.deepEqual((await take(chat, '三')).path.at(-1).game.things.map(thing => thing.name), ['绳', '药'])
})

const lastPrompt = request => request.messages.at(-1).content
const allWords = request => JSON.stringify(request.messages)

test('the rules reach the model in the turn\'s message: once, then again when the turns read no longer hold them', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, Array(12).fill('她点头。'))
  await call(`/api/cards/${card.id}/game`, { level: 'light', attributes: { grace: 14 } }, 'PUT')
  const chat = await newChat()
  for (let i = 0; i < 10; i++) await take(chat, `第${i}轮`)
  assert.match(lastPrompt(sent[0]), /<游戏规则>/)
  assert.match(lastPrompt(sent[0]), /<游戏状态>生命 100\/100（状态好）；体魄 10、灵巧 14、心智 10、魅力 10<\/游戏状态>/)
  assert.doesNotMatch(lastPrompt(sent[1]), /<游戏规则>/)
  assert.match(lastPrompt(sent[1]), /见之前的游戏规则/, 'a line stands in for it')
  assert.doesNotMatch(lastPrompt(sent[1]), /<游戏状态>/, 'the sheet has not changed')
  assert.doesNotMatch(lastPrompt(sent[8]), /<游戏规则>/, 'still among the last eight')
  assert.match(lastPrompt(sent[9]), /<游戏规则>/, 'gone from them')
  assert.equal(sent[0].messages[0].content, sent[9].messages[0].content, 'the frozen prefix stays as it was')
})

test('the sheet line goes again when the sheet has changed', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['【获得|绳×2】', '她点头。', '她点头。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await take(chat, '一')
  await take(chat, '二')
  await take(chat, '三')
  assert.match(lastPrompt(sent[1]), /物品：绳×2<\/游戏状态>/)
  assert.doesNotMatch(lastPrompt(sent[2]), /<游戏状态>/)
})

test('a reply stops at its mark: what was written past it is not kept, shown or sent back', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['她伸手。\n【检定|灵巧|DC12】\n你成功了！<UpdateVariable>_.set(\'好感\', 9);</UpdateVariable>', '她握住了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  const view = await take(chat, '伸手')
  const stop = view.path.at(-1)
  assert.equal(stop.raw, '她伸手。\n【检定|灵巧|DC12】')
  assert.equal(stop.text, '她伸手。', 'the mark is not shown')
  assert.deepEqual(stop.gate, { kind: 'check', stat: '灵巧', dc: 12 })
  assert.equal(stop.state['好感'], undefined, 'an update past the mark counts for nothing')
  const answer = await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  assert.match(String(answer.body), /"type":"done"/)
  const settled = (await call(`/api/chats/${chat.id}`)).body
  const turn = settled.path.at(-2)
  assert.equal(turn.auto, true)
  assert.equal(turn.check.stat, '灵巧')
  assert.equal(turn.check.dc, 12)
  assert.match(turn.text, /^掷骰：灵巧 \d+，需要 12，(大成功|成功|险胜|失败)$/)
  assert.match(lastPrompt(sent[1]), /<检定结果>\n灵巧检定（DC12）：掷出 \d+，修正 \+0，合计 \d+/)
  assert.doesNotMatch(allWords(sent[1]), /你成功了/, 'the model never reads back what was cut')
  assert.equal(settled.path.at(-1).gate, undefined)
})

test('a settled roll stays what it was: a new version of the reply, and the same spot rolled again', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['【检定|灵巧|DC12】', '写法一。', '写法二。', '写法三。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '伸手')).path.at(-1)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  const first = (await call(`/api/chats/${chat.id}`)).body.path.at(-2)
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: first.id })
  assert.equal(lastPrompt(sent[2]), lastPrompt(sent[1]), 'a new version is asked for with the same words')
  await call(`/api/chats/${chat.id}/rollback`, { nodeId: stop.id })
  const back = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(back.path.at(-1).id, stop.id)
  assert.deepEqual(back.path.at(-1).gate, stop.gate, 'back at the stop, it is waiting again')
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  const again = (await call(`/api/chats/${chat.id}`)).body.path.at(-2)
  assert.deepEqual(again.check, first.check)
})

test('a choice with a roll: rolled with the turn, one roll a turn, a stop only where there is one', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['她点头。【检定|力量|DC8】\n后面的话留着。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', attributes: { grace: 14 } }, 'PUT')
  const chat = await newChat()
  const answer = await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '翻过断崖', game: { check: { stat: '灵巧', dc: 12 } } })
  assert.match(String(answer.body), /"type":"done"/)
  const view = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(view.path.at(-2).text, '翻过断崖')
  assert.equal(view.path.at(-2).auto, undefined)
  assert.equal(view.path.at(-2).check.modifier, 2)
  assert.match(lastPrompt(sent[0]), /<玩家输入>\n翻过断崖\n<\/玩家输入>/)
  assert.match(lastPrompt(sent[0]), /<检定结果>/)
  assert.equal(view.path.at(-1).gate, undefined, 'this turn has rolled')
  assert.match(view.path.at(-1).raw, /后面的话留着/, 'the reply is kept whole')
  assert.equal(view.path.at(-1).text, '她点头。\n后面的话留着。')
})

test('a roll on the page and on the server is the same roll, with the difficulty counted', async t => {
  const { call, card, newChat } = await tavern(t, ['她点头。'])
  const book = (await call(`/api/cards/${card.id}/game`, { level: 'light', difficulty: 'hard', attributes: { grace: 14 } }, 'PUT')).body
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '翻过断崖', game: { check: { stat: '灵巧', dc: 12 } } })
  const turn = (await call(`/api/chats/${chat.id}`)).body.path.at(-2)
  assert.deepEqual(turn.check, rollCheck(startSheet(book), book, { stat: '灵巧', dc: 12 }, chat.id, 'root', '翻过断崖'))
  assert.equal(turn.check.dc, 14)
})

test('a stop written out of the reply is gone; one that is not there cannot be settled', async t => {
  const { call, card, newChat, take } = await tavern(t, ['她伸手。【检定|灵巧|DC12】', '她点头。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '伸手')).path.at(-1)
  assert.ok(stop.gate)
  const edited = await call(`/api/chats/${chat.id}/messages/${stop.id}`, { text: '她伸手。' }, 'PUT')
  assert.equal(edited.status, 200)
  const view = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(view.path.at(-1).gate, undefined)
  const refused = await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  assert.match(String(refused.body), /这条回复没有待掷的检定/)
})

test('rules off: nothing the page sends for a roll changes a turn', async t => {
  const { newChat, call, sent } = await tavern(t, ['她伸手。【检定|灵巧|DC12】还有话。'])
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '你好', game: { check: { stat: '灵巧', dc: 12 } } })
  const view = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(view.path.at(-2).check, undefined)
  assert.equal(view.path.at(-1).gate, undefined)
  assert.equal(view.path.at(-1).raw, '她伸手。【检定|灵巧|DC12】还有话。')
  assert.doesNotMatch(lastPrompt(sent[0]), /<游戏规则>|<游戏状态>|<检定结果>/)
})

test('whether a reply may stop: an imported preset waits to be asked, and the rules then say so', () => {
  const light = cleanRulebook({ level: 'light' })
  assert.equal(pausesOn(light, true), true)
  assert.equal(pausesOn(light, false), false)
  assert.equal(pausesOn(cleanRulebook({ level: 'light', pause: true }), false), true)
  assert.equal(pausesOn(cleanRulebook({ level: 'light', pause: false }), true), false)
  assert.equal(pausesOn(cleanRulebook({ level: 'full', pause: false }), false), true, 'a fight has no other way in')
  assert.deepEqual(gateKinds(light), ['check'])
  assert.deepEqual(gateKinds(cleanRulebook({ level: 'full' })), ['check', 'battle'])
  const stopping = gamePrompt({ sheet: startSheet(light), pausing: true, check: null }, [])
  const staying = gamePrompt({ sheet: startSheet(light), pausing: false, check: null }, [])
  assert.match(stopping.text, /写到 【检定\|属性\|DC数字】 就结束回复/)
  assert.doesNotMatch(staying.text, /就结束回复，标记/)
  assert.match(staying.text, /有风险的，在那一行末尾/)
})

test('a compacted or hidden stretch: the rules go again, since the turns read no longer hold them', () => {
  const sheet = startSheet({})
  const said = { role: 'user', prompt: `<游戏规则>x</游戏规则>\n${gamePrompt({ sheet, pausing: true, check: null }, []).text}` }
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, check: null }, [said]).text, /<游戏规则>/)
  assert.match(gamePrompt({ sheet, pausing: true, check: null }, [{ role: 'user', prompt: '普通的一轮' }]).text, /<游戏规则>/)
  assert.match(gamePrompt({ sheet, pausing: true, check: null }, []).text, /<游戏状态>/)
})

test('a card\'s own 1️⃣ options: a roll is found by the text the visual novel shows', () => {
  const raw = '她看着你。\n<small>\n请选择：\n1️⃣ 🛖 推门进去\n2️⃣ 🚶 绕开驿站继续赶路 【检定|体魄|12】\n</small>'
  const checks = choiceChecks(raw)
  const options = splitLines(withoutGameMarks(raw), { names: [] }).filter(line => line.kind === 'option').map(line => line.plain)
  assert.equal(options.length, 2)
  assert.deepEqual(checks.get(options[1]), { kind: 'check', stat: '体魄', dc: 12 })
  assert.equal(checks.get(options[0]), undefined)
})

test('the rolls an action list asks for, by the choice as shown', () => {
  const checks = choiceChecks('正文。\n<choices>\nA. 翻过断崖【检定|灵巧|DC12】\nB. 绕路走\nC. 说服他【检定|魅力|DC14】\n</choices>')
  assert.deepEqual([...checks.keys()], ['翻过断崖', '说服他'])
  assert.deepEqual(checks.get('说服他'), { kind: 'check', stat: '魅力', dc: 14 })
  assert.deepEqual([...choiceChecks('1️⃣ 翻过断崖【检定|灵巧|DC12】\n2️⃣ 绕路').keys()], ['翻过断崖'])
  assert.equal(choiceChecks('没有选项。').size, 0)
  assert.equal(cutAtGate('一【战斗|灰狼】二', ['check']).gate, null, 'a stop this level does not have')
  assert.equal(cutAtGate('一【检定|灵巧】二', []).text, '一【检定|灵巧】二')
})

test('a roll in a line, with and without an attribute', () => {
  assert.equal(checkLine({ stat: '灵巧', total: 13, dc: 12, tier: 'success' }), '掷骰：灵巧 13，需要 12，成功')
  assert.equal(checkLine({ stat: '', total: 3, dc: 12, tier: 'fail' }), '掷骰：3，需要 12，失败')
  assert.deepEqual(cleanCheck({ stat: ' 灵巧 ', dc: 99, kind: 'x' }), { stat: '灵巧', dc: 25 })
  assert.deepEqual(cleanCheck({ dc: 'x' }), { stat: '', dc: 12 })
  assert.equal(cleanCheck(null), null)
  assert.equal(chanceFor(startSheet({ attributes: { grace: 14 } }), cleanRulebook({}), { stat: '灵巧', dc: 12 }), 65)
  assert.equal(chanceFor(startSheet({ attributes: { grace: 14 } }), cleanRulebook({ difficulty: 'hard' }), { stat: '灵巧', dc: 12 }), 55)
})

test('at a stop the player may do something else: the stop is over, and the model reads the mark and the new action', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['她伸手。【检定|灵巧|DC12】', '你转身走了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await take(chat, '伸手')
  const view = await take(chat, '算了，我走')
  assert.equal(view.path.at(-2).check, undefined)
  assert.equal(view.path.at(-2).auto, undefined)
  assert.equal(view.path.at(-1).gate, undefined)
  assert.match(allWords(sent[1]), /【检定\|灵巧\|DC12】/)
  assert.doesNotMatch(lastPrompt(sent[1]), /<检定结果>/)
})

test('a new version of a stopped reply: a stop of its own, or none', async t => {
  const { call, card, newChat, take } = await tavern(t, ['她伸手。【检定|灵巧|DC12】', '她笑了。', '她看你。【检定|魅力|DC8】'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  const first = await take(chat, '伸手')
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: first.path.at(-2).id })
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).gate, undefined)
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: first.path.at(-2).id })
  assert.deepEqual((await call(`/api/chats/${chat.id}`)).body.path.at(-1).gate, { kind: 'check', stat: '魅力', dc: 8 })
})

test('a choice\'s roll stays with a new version of the reply', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['写法一。', '写法二。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '翻过断崖', game: { check: { stat: '灵巧', dc: 12 } } })
  const turn = (await call(`/api/chats/${chat.id}`)).body.path.at(-2)
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: turn.id })
  assert.equal(lastPrompt(sent[1]), lastPrompt(sent[0]))
  assert.deepEqual((await call(`/api/chats/${chat.id}`)).body.path.at(-2).check, turn.check)
})

test('a settling turn that fails leaves the stop where it was, and the same roll waiting', async t => {
  const { call, card, newChat, take } = await tavern(t, ['【检定|灵巧|DC12】', FAIL, '她接住了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '伸手')).path.at(-1)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  const after = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(after.path.at(-1).id, stop.id)
  assert.ok(after.path.at(-1).gate)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  const done = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(done.path.at(-1).raw, '她接住了。')
  assert.equal(done.path.at(-2).auto, true)
})

test('rules turned on in the middle of a story: from the next turn, and the prefix never moves', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['一。', '二。'])
  const chat = await newChat()
  await take(chat, '一')
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  await take(chat, '二')
  assert.doesNotMatch(lastPrompt(sent[0]), /<游戏规则>/)
  assert.match(lastPrompt(sent[1]), /<游戏规则>/)
  assert.equal(sent[0].messages[0].content, sent[1].messages[0].content)
  assert.equal(sent[1].messages[1].content, sent[0].messages[1].content, 'what was sent before stays as sent')
})

const opening = (call, chat, state) => call(`/api/chats/${chat.id}/state`, { state }, 'PUT')
const held = view => view.path.at(-1).game.things.map(thing => `${thing.name}×${thing.count}`)

test('an operation goes with the turn: used up once, told to the model, and a new version does not take it again', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['她点头。【受伤|中】', '你喝下药。', '写法二。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', start: { things: [{ name: '回春丹', count: 2 }] } }, 'PUT')
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '一' })
  const hurt = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(hurt.path.at(-1).game.life, 75)
  await call(`/api/chats/${chat.id}/turn`, { parentId: hurt.path.at(-1).id, input: '喝药', game: { ops: [{ op: 'use', name: '回春丹' }] } })
  const healed = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(healed.path.at(-1).game.life, 100)
  assert.deepEqual(held(healed), ['回春丹×1'])
  assert.match(lastPrompt(sent[1]), /<本轮操作>玩家使用了回春丹，已扣除，生命 \+25<\/本轮操作>/)
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: healed.path.at(-2).id })
  const again = (await call(`/api/chats/${chat.id}`)).body
  assert.deepEqual(held(again), ['回春丹×1'], 'a new version starts from the same reply before')
  assert.equal(again.path.at(-1).game.life, 100)
  await call(`/api/chats/${chat.id}/rollback`, { nodeId: hurt.path.at(-1).id })
  const back = (await call(`/api/chats/${chat.id}`)).body
  assert.deepEqual(held(back), ['回春丹×2'], 'rolled back, the pill is there again')
  assert.equal(back.path.at(-1).game.life, 75)
})

test('used, and the model says so too: it goes once', async t => {
  const { call, card, newChat } = await tavern(t, ['你喝下药。【失去|回春丹】'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', start: { things: [{ name: '回春丹', count: 2 }] } }, 'PUT')
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '喝药', game: { ops: [{ op: 'use', name: '回春丹' }] } })
  assert.deepEqual(held((await call(`/api/chats/${chat.id}`)).body), ['回春丹×1'])
})

test('what cannot be done is left out: nothing is told, nothing is taken', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['她点头。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '喝药', game: { ops: [{ op: 'use', name: '没有的药' }] } })
  const view = (await call(`/api/chats/${chat.id}`)).body
  assert.doesNotMatch(lastPrompt(sent[0]), /<本轮操作>玩家/)
  assert.equal(view.path.at(-1).game.life, 100)
})

test('a roll is made on the sheet as the turn\'s operations leave it, and goes with a stop\'s turn too', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['她伸手。【检定|灵巧|DC12】', '她接住了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', start: { things: [{ name: '回春丹', count: 1 }] } }, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '伸手')).path.at(-1)
  assert.ok(stop.gate)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true, ops: [{ op: 'use', name: '回春丹' }] } })
  const view = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(view.path.at(-2).auto, true)
  assert.deepEqual(held(view), [])
  assert.match(lastPrompt(sent[1]), /<本轮操作>[\s\S]*<检定结果>/)
})

test('a variable the card keeps: the story moves it, the rules settle what they settle, and the rules win that turn', async t => {
  const { call, card, newChat, sent } = await tavern(t, [
    '你摔了一跤。<UpdateVariable>_.add(\'主角.体力\', -30);</UpdateVariable>',
    '你喝下药。<UpdateVariable>_.add(\'主角.体力\', 5);\n_.set(\'主角.背包.狼牙\', 2);</UpdateVariable>',
  ])
  await call(`/api/cards/${card.id}/game`, { level: 'light', bindings: { life: '主角.体力', maxLife: '主角.上限', things: '主角.背包' } }, 'PUT')
  const chat = await newChat()
  await opening(call, chat, { 主角: { 体力: 80, 上限: 100, 背包: { 回春丹: 2 } } })
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '一' })
  const fell = (await call(`/api/chats/${chat.id}`)).body.path.at(-1)
  assert.equal(fell.game.life, 50, 'the story moved it, and the sheet reads it')
  await call(`/api/chats/${chat.id}/turn`, { parentId: fell.id, input: '喝药', game: { ops: [{ op: 'use', name: '回春丹' }] } })
  const view = (await call(`/api/chats/${chat.id}`)).body
  const drank = view.path.at(-1)
  assert.equal(drank.state.主角.体力, 100, 'what the model did to it this turn counts for nothing')
  assert.deepEqual(drank.state.主角.背包, { 回春丹: 1, 狼牙: 2 }, 'what it put in the bag stays')
  assert.deepEqual(held(view), ['回春丹×1', '狼牙×2'])
  assert.doesNotMatch(lastPrompt(sent[0]), /【受伤\|轻】|【获得\|物品/, 'a field the card keeps asks for no marks')
})

test('a variable that stops making sense: the sheet keeps the last good value', async t => {
  const { call, card, newChat } = await tavern(t, ['你受了伤。<UpdateVariable>_.set(\'体力\', \'重伤\');</UpdateVariable>'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', bindings: { life: '体力' } }, 'PUT')
  const chat = await newChat()
  await opening(call, chat, { 体力: 80 })
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '一' })
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).game.life, 80)
})

test('a new day: a night\'s rest for what the card does not keep itself', async t => {
  const { call, card, newChat } = await tavern(t, ['你受了伤。【受伤|重】', '她守了一夜。\n\n次日清晨，雾散了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const chat = await newChat()
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '一' })
  const hurt = (await call(`/api/chats/${chat.id}`)).body.path.at(-1)
  assert.equal(hurt.game.life, 50)
  await call(`/api/chats/${chat.id}/turn`, { parentId: hurt.id, input: '二' })
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).game.life, 100)
})

test('what things do, asked of the helper once: what the player set stays, an answer it cannot read changes nothing', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['[{"name":"回春丹","type":"heal","size":"large"},{"name":"铜钥匙","type":"none"},{"name":"别的","type":"heal"}]', '听不懂'])
  await call(`/api/cards/${card.id}/game`, { level: 'light', items: { 雷符: { type: 'boost' } } }, 'PUT')
  const chat = await newChat()
  const things = [{ name: '回春丹', note: '回血' }, { name: '铜钥匙' }, { name: '雷符' }]
  const book = (await call(`/api/chats/${chat.id}/game/things`, { things })).body
  assert.deepEqual(book.items, { 回春丹: { type: 'heal', size: 'large' }, 铜钥匙: { type: 'none' }, 雷符: { type: 'boost' } })
  assert.match(JSON.stringify(sent[0].messages), /回春丹（回血）/)
  const after = (await call(`/api/chats/${chat.id}/game/things`, { things: [{ name: '石头' }] })).body
  assert.equal(after.items.石头, undefined)
  assert.equal(Object.keys(after.items).length, 3)
  assert.equal(sent.length, 2)
  assert.deepEqual((await call(`/api/chats/${chat.id}/game/things`, { things: [] })).body.items, after.items, 'nothing to ask: nothing asked')
  assert.equal(sent.length, 2)
})

test('补写变量 after a turn the rules settled: it cannot take back what they settled, or count it twice', async t => {
  const { call, sent } = await tavern(t, ['你喝下药。', '<UpdateVariable>_.add(\'主角.体力\', -40);\n_.set(\'好感\', 7);</UpdateVariable>'])
  // By hand here: a turn would fill it in by itself.
  await call('/api/settings', { autoFillUpdate: false }, 'PUT')
  const file = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '阿岚', description: '向导', first_mes: '开场。', system_prompt: '每轮结尾写 <UpdateVariable> 变量更新块。' } })).toString('base64')
  const card = (await call('/api/cards/import', { filename: 'm.json', data: file })).body
  await call(`/api/cards/${card.id}/game`, { level: 'light', bindings: { life: '主角.体力', things: '主角.背包' } }, 'PUT')
  const chat = (await call('/api/chats', { cardId: card.id })).body
  await opening(call, chat, { 主角: { 体力: 40, 背包: ['回春丹', '回春丹'] }, 好感: 1 })
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '喝药', game: { ops: [{ op: 'use', name: '回春丹' }] } })
  const reply = (await call(`/api/chats/${chat.id}`)).body.path.at(-1)
  assert.equal(reply.state.主角.体力, 90)
  const filled = await call(`/api/chats/${chat.id}/nodes/${reply.id}/fill-update`, {})
  assert.equal(filled.status, 200, JSON.stringify(filled.body))
  const after = (await call(`/api/chats/${chat.id}`)).body.path.at(-1)
  assert.equal(after.state.主角.体力, 90, 'what the rules settled stands')
  assert.equal(after.state.好感, 7, 'the rest of the update counts')
  assert.deepEqual(after.state.主角.背包, ['回春丹'], 'the pill went once')
  assert.equal(sent.length, 2)
})

// A fight played by 自动 from a reply that stopped on it, as the page would report it.
function fought(view, book, chatId, { attempt = 0, want = null, choose = null } = {}) {
  const stop = view.path.at(-1)
  const setup = encounterSetup(sheetOf(book, sheetOnPath(view.path), stop.state), book, stop.gate, chatId, stop.id)
  let state = startBattle(attemptSetup(setup, attempt))
  const actions = []
  while (!state.over) {
    const action = (choose ?? autoAction)(state)
    actions.push(action)
    state = step(state, action).state
  }
  if (want) assert.equal(state.over, want)
  return { over: state.over, attempt, actions, state }
}
const settle = (call, chat, stop, fight, ops) => call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true, ops, battle: { over: fight.over, attempt: fight.attempt, actions: fight.actions } } })
const FULL = { level: 'full', start: { things: [{ name: '回春丹', count: 2 }], skills: ['强击'] } }
const bookOf = async (call, card) => (await call(`/api/cards/${card.id}/game`)).body

test('a fight in the story: the reply stops on it, the model is told what came of it, the sheet shows it', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['林子里窜出一只灰狼。\n【战斗|灰狼:普通】\n你赢了！', '你收起刀。【获得|狼牙】【受伤|重】'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const view = await take(chat, '走')
  const stop = view.path.at(-1)
  assert.deepEqual(stop.gate, { kind: 'battle', foes: [{ name: '灰狼', count: 1, tier: 'normal' }] })
  assert.equal(stop.raw, '林子里窜出一只灰狼。\n【战斗|灰狼:普通】', 'what the model wrote past it goes')
  assert.equal(stop.text, '林子里窜出一只灰狼。')
  assert.match(lastPrompt(sent[0]), /强制：敌人先动手/)
  assert.match(lastPrompt(sent[0]), /选项：有敌人、对峙/)
  const book = await bookOf(call, card)
  const fight = fought(view, book, chat.id, { want: 'won' })
  const answer = await settle(call, chat, stop, fight)
  assert.match(String(answer.body), /"type":"done"/)
  const after = (await call(`/api/chats/${chat.id}`)).body
  const turn = after.path.at(-2)
  assert.equal(turn.auto, true)
  assert.equal(turn.battle.over, 'won')
  assert.match(turn.text, /^战斗：胜利，\d+ 回合$/)
  assert.match(lastPrompt(sent[1]), /<战斗结果>\n胜利，\d+ 回合。敌人：灰狼，击败了 灰狼。\n玩家：生命 \d+\/100/)
  assert.match(lastPrompt(sent[1]), /不要改写胜负/)
  const sheet = after.path.at(-1).game
  assert.equal(sheet.life, fight.state.units[0].life, '【受伤】 in the reply to a fight counts for nothing')
  assert.equal(sheet.experience, 20)
  assert.deepEqual(held(after).includes('狼牙×1'), true, 'the spoils are the model\'s to write')
})

// A fight from a reply's choices, played by 自动, as the page would report it.
function foughtChoice(view, book, chatId, choice) {
  const tip = view.path.at(-1)
  const gate = choiceFights(tip.raw ?? tip.text).get(choice)
  const setup = encounterSetup(sheetOf(book, sheetOnPath(view.path), tip.state), book, gate, chatId, `${tip.id}:${choice}`)
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    const action = autoAction(state)
    actions.push(action)
    state = step(state, action).state
  }
  return { over: state.over, attempt: 0, actions }
}

const OFFER = '一只灰狼拦在路上。\n<choices>\nA. 拔刀迎战【战斗|灰狼:杂兵】\nB. 绕路走\n</choices>'

test('a fight among the choices: nothing stops, and picked, the choice is the player\'s words and the fight is played through', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, [OFFER, '你收起刀。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const view = await take(chat, '走')
  const tip = view.path.at(-1)
  assert.equal(tip.gate, undefined)
  const fight = foughtChoice(view, await bookOf(call, card), chat.id, '拔刀迎战')
  await call(`/api/chats/${chat.id}/turn`, { parentId: tip.id, input: '拔刀迎战', game: { settle: true, choice: '拔刀迎战', ops: [], battle: fight } })
  const after = (await call(`/api/chats/${chat.id}`)).body
  const turn = after.path.at(-2)
  assert.equal(turn.text, '拔刀迎战')
  assert.equal(turn.auto, undefined, 'it was the player\'s own action')
  assert.equal(turn.battle.over, fight.over)
  assert.match(lastPrompt(sent[1]), /<战斗结果>/)
  assert.equal(after.path.at(-1).game.experience, 10)
})

test('a fight among the choices can be left to the story; one that is not there is refused', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, [OFFER, '你们绕了过去。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const tip = (await take(chat, '走')).path.at(-1)
  const made = await call(`/api/chats/${chat.id}/turn`, { parentId: tip.id, input: '飞上天', game: { settle: true, choice: '飞上天', ops: [], battle: { over: 'story' } } })
  assert.doesNotMatch(String(made.body), /"type":"done"/)
  await call(`/api/chats/${chat.id}/turn`, { parentId: tip.id, input: '拔刀迎战', game: { settle: true, choice: '拔刀迎战', ops: [], battle: { over: 'story' } } })
  const after = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(after.path.at(-2).battle.over, 'story')
  assert.match(lastPrompt(sent[1]), /玩家不走战斗/)
})

test('what a rolled choice brings: experience at the full level, nothing the page can send, once however often it is written', async t => {
  const { call, card, newChat, take } = await tavern(t, ['她看着你。', '写法一。', '写法二。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const tip = (await take(chat, '走')).path.at(-1)
  const check = { stat: '灵巧', dc: 5 }
  await call(`/api/chats/${chat.id}/turn`, { parentId: tip.id, input: '翻过去', game: { check, ops: [{ op: 'grow', experience: 500 }] } })
  const first = (await call(`/api/chats/${chat.id}`)).body
  const { tier } = first.path.at(-2).check
  const earned = { crit: 20, success: 10, close: 5, fail: 0 }[tier]
  assert.equal(first.path.at(-1).game.experience, earned)
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: first.path.at(-2).id })
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).game.experience, earned)
})

test('what a turn settled is known before its reply: said at its start, and worked out again from the story', async t => {
  const { call, card, newChat, take } = await tavern(t, ['她看着你。', '她点头。【受伤|轻】'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const tip = (await take(chat, '走')).path.at(-1)
  const answer = await call(`/api/chats/${chat.id}/turn`, { parentId: tip.id, input: '吃药', game: { ops: [{ op: 'use', name: '回春丹' }] } })
  const start = String(answer.body).split('\n\n').map(line => line.replace(/^data: /, '')).filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(event => event.type === 'start')
  assert.deepEqual(start.sheet.things, [{ name: '回春丹', count: 1 }], 'one gone, before a word is written')
  const after = (await call(`/api/chats/${chat.id}`)).body
  const book = await bookOf(call, card)
  const sheet = turnSheet(book, after.path.slice(0, -1))
  assert.deepEqual(sheet.things, [{ name: '回春丹', count: 1 }])
  assert.equal(sheet.life, 100, 'the wound is the reply\'s')
  assert.equal(after.path.at(-1).game.life, 90)
})

test('what one turn asks of the model: a fight the player wants, one that is overdue, a safe way taken', () => {
  const sheet = startSheet({})
  const said = { role: 'user', prompt: '<游戏规则>自己写的行动 战斗选项</游戏规则>' }
  const turn = (extra, turns = [said]) => gamePrompt({ sheet, pausing: true, fights: true, check: null, ...extra }, turns).text
  assert.match(turn({ wantsFight: true }), /<本轮要求>玩家这一轮要动手/)
  assert.doesNotMatch(turn({}), /<本轮要求>/)
  const quiet = Array.from({ length: 5 }, () => ({ ...said }))
  assert.match(turn({}, quiet), /好几轮没有打斗/)
  assert.doesNotMatch(turn({}, [{ ...said, battle: { over: 'won' } }, ...quiet.slice(1)].reverse()), /好几轮没有打斗/, 'a fight just now')
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: false, check: null }, quiet).text, /好几轮没有打斗/)
  assert.match(turn({ safe: true }), /稳妥做法/)
})

test('a fight\'s own settings: how hard follows 难度 until it is set, how often sets when a fight is asked for', () => {
  assert.equal(cleanRulebook({ difficulty: 'hard' }).fightDifficulty, 'hard', 'a book from before them')
  assert.equal(cleanRulebook({ difficulty: 'hard', fightDifficulty: 'easy' }).fightDifficulty, 'easy')
  assert.equal(cleanRulebook({}).fightRate, 'normal')
  assert.equal(cleanRulebook({ fightRate: 'always' }).fightRate, 'normal')
  const foe = difficulty => foeSheets(battleSetup(startSheet({}), { foes: fieldFoes([{ name: '灰狼', count: 1, tier: 'normal' }]), seed: 's', difficulty }))[0]
  assert.ok(foe('easy').life < foe('normal').life && foe('normal').life < foe('hard').life)
  assert.ok(foe('easy').attack < foe('normal').attack && foe('normal').attack < foe('hard').attack)
  const book = cleanRulebook({ level: 'full', difficulty: 'easy', fightDifficulty: 'hard' })
  assert.equal(encounterSetup(startSheet(book), book, { foes: [{ name: '灰狼', count: 1, tier: 'normal' }] }, 'c', 'n').difficulty, 'hard', 'the rolls\' 难度 is not the fight\'s')
  const sheet = startSheet({})
  const said = { role: 'user', prompt: '<游戏规则>自己写的行动 战斗选项</游戏规则>' }
  const quiet = count => Array.from({ length: count }, () => ({ ...said }))
  const asks = (fightRate, count) => gamePrompt({ sheet, pausing: true, fights: true, fightRate, check: null }, quiet(count)).text.includes('好几轮没有打斗')
  assert.equal(asks('often', 2), true)
  assert.equal(asks('normal', 3), false)
  assert.equal(asks('normal', 4), true)
  assert.equal(asks('rare', 7), false)
  assert.equal(asks('rare', 8), true)
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, fightRate: 'rare', check: null }, [said]).reminder, /只在剧情确实需要时/)
})

test('the panel in front of a fight: a foe\'s level follows the player, its numbers the rules', () => {
  const setup = battleSetup({ ...startSheet({}), level: 3 }, { foes: fieldFoes([{ name: '灰狼', count: 1, tier: 'minion' }, { name: '狼王', count: 1, tier: 'boss' }]), seed: 's', difficulty: 'normal' })
  const [wolf, king] = foeSheets(setup)
  assert.equal(wolf.level, 2)
  assert.equal(king.level, 8)
  assert.equal(king.noEscape, true)
  assert.equal(wolf.noEscape, false)
  assert.ok(wolf.life > 0 && wolf.attack > 0)
  assert.equal(foeSheets(battleSetup(startSheet({}), { foes: fieldFoes([{ name: '灰狼', count: 1, tier: 'minion' }]), seed: 's' }))[0].level, 1, 'never under 1')
})

test('a report that does not play through is refused, and the stop stays', async t => {
  const { call, card, newChat, take } = await tavern(t, ['【战斗|灰狼:普通】'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '走')).path.at(-1)
  for (const battle of [{ over: 'won', actions: [] }, { over: 'won', actions: [{ kind: 'attack', target: 'nobody' }] }, { over: 'nonsense' }, undefined]) {
    const answer = await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true, battle } })
    assert.match(String(answer.body), /这场战斗的记录对不上/, JSON.stringify(battle))
  }
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).id, stop.id)
})

test('after a fight: a new version keeps what it took, a rollback gives it back, and the bag took it once', async t => {
  const { call, card, newChat, take } = await tavern(t, ['【战斗|头目:首领】', '写法一。【失去|回春丹】', '写法二。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const view = await take(chat, '走')
  const stop = view.path.at(-1)
  const book = await bookOf(call, card)
  const pill = state => (state.round === 1 ? { kind: 'item', name: '回春丹' } : autoAction(state))
  const fight = fought(view, book, chat.id, { choose: pill })
  await settle(call, chat, stop, fight)
  const first = (await call(`/api/chats/${chat.id}`)).body
  const left = 2 - (fight.state.used.回春丹 ?? 0)
  assert.ok(fight.state.used.回春丹 >= 1)
  const counted = list => list.filter(item => item.startsWith('回春丹')).join()
  assert.equal(counted(held(first)), left ? `回春丹×${left}` : '', '【失去】 of what the fight used says the same again')
  await call(`/api/chats/${chat.id}/regenerate`, { userNodeId: first.path.at(-2).id })
  const again = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(counted(held(again)), counted(held(first)))
  assert.equal(again.path.at(-1).game.life, first.path.at(-1).game.life)
  await call(`/api/chats/${chat.id}/rollback`, { nodeId: stop.id })
  const back = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(back.path.at(-1).id, stop.id)
  assert.equal(back.path.at(-1).gate.kind, 'battle', 'the fight is waiting again')
  assert.deepEqual(held(back), ['回春丹×2'])
  assert.equal(back.path.at(-1).game.life, 100)
})

test('a fight lost: left with a little life, no experience; fought again, the dice are new and nothing was taken', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['【战斗|头目:首领|打手×2:普通】', '你被丢在路边。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const view = await take(chat, '走')
  const stop = view.path.at(-1)
  const book = await bookOf(call, card)
  const guard = () => ({ kind: 'guard' })
  const lost = fought(view, book, chat.id, { want: 'lost', choose: guard })
  const retried = fought(view, book, chat.id, { attempt: 1, want: 'lost', choose: guard })
  assert.notDeepEqual(retried.state.units[0], lost.state.units[0].rng, 'the same fight with new dice')
  await settle(call, chat, stop, retried)
  const after = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(after.path.at(-1).game.life, 30)
  assert.equal(after.path.at(-1).game.experience, 0)
  assert.deepEqual(held(after), ['回春丹×2'])
  assert.match(lastPrompt(sent[1]), /战败，玩家没有死/)
  assert.match(lastPrompt(sent[1]), /写战败的后果/)
})

test('left to the story: nothing is settled, the model writes it, and a mark in that reply stops nothing', async t => {
  const { call, card, newChat, sent, take } = await tavern(t, ['【战斗|灰狼:普通】', '你绕开了狼。【战斗|灰狼:普通】后面的话。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '走')).path.at(-1)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true, battle: { over: 'story' } } })
  const after = (await call(`/api/chats/${chat.id}`)).body
  assert.equal(after.path.at(-2).battle.over, 'story')
  assert.equal(after.path.at(-2).text, '不走战斗：灰狼')
  assert.match(lastPrompt(sent[1]), /玩家不走战斗（灰狼）/)
  assert.equal(after.path.at(-1).gate, undefined, 'no fight straight after a fight')
  assert.match(after.path.at(-1).raw, /后面的话/)
  assert.equal(after.path.at(-1).game.life, 100)
})

test('a roll, then a fight: a settled roll can lead into one; at the light level a fight mark stops nothing', async t => {
  const { call, card, newChat, take } = await tavern(t, ['她伸手。【检定|灵巧|DC12】', '狼来了。【战斗|灰狼:普通】', '她点头。【战斗|灰狼】后面的话。'])
  await call(`/api/cards/${card.id}/game`, FULL, 'PUT')
  const chat = await newChat()
  const stop = (await take(chat, '伸手')).path.at(-1)
  await call(`/api/chats/${chat.id}/turn`, { parentId: stop.id, game: { settle: true } })
  assert.equal((await call(`/api/chats/${chat.id}`)).body.path.at(-1).gate.kind, 'battle')
  await call(`/api/cards/${card.id}/game`, { level: 'light' }, 'PUT')
  const light = await take(await newChat(), '走')
  assert.equal(light.path.at(-1).gate, undefined)
  assert.match(light.path.at(-1).raw, /后面的话/)
  assert.equal(light.path.at(-1).text, '她点头。后面的话。')
})

test('a fight and the card\'s own variables: what it settled stands, what the model puts in the bag stays, the lists show it at once', async t => {
  const { call, card, newChat, sent } = await tavern(t, ['【战斗|灰狼:杂兵】', '<UpdateVariable>_.add(\'主角.体力\', -30);\n_.set(\'主角.背包.狼牙\', 2);</UpdateVariable>打完了。'])
  await call(`/api/cards/${card.id}/game`, { level: 'full', bindings: { life: '主角.体力', maxLife: '主角.上限', energy: '主角.内力', things: '主角.背包' } }, 'PUT')
  const chat = await newChat()
  await opening(call, chat, { 主角: { 体力: 80, 上限: 100, 内力: [30, '说明'], 背包: { 回春丹: 2 } } })
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '走' })
  const view = (await call(`/api/chats/${chat.id}`)).body
  const stop = view.path.at(-1)
  const book = await bookOf(call, card)
  const setup = encounterSetup(sheetOf(book, sheetOnPath(view.path), stop.state), book, stop.gate, chat.id, stop.id)
  let state = startBattle(setup)
  const actions = [{ kind: 'item', name: '回春丹' }]
  state = step(state, actions[0]).state
  while (!state.over) {
    const action = autoAction(state)
    actions.push(action)
    state = step(state, action).state
  }
  await settle(call, chat, stop, { over: state.over, attempt: 0, actions })
  const reply = (await call(`/api/chats/${chat.id}`)).body.path.at(-1)
  assert.equal(reply.state.主角.体力, state.units[0].life, 'the model\'s −30 counts for nothing')
  assert.deepEqual(reply.state.主角.内力, [state.units[0].energy, '说明'], 'the words stay')
  assert.deepEqual(reply.state.主角.背包, { 回春丹: 1, 狼牙: 2 }, 'the pill went, the spoils stayed')
  assert.ok(lastPrompt(sent[1]).length > 0)
})

test('what the rules settled is what the card\'s own entries show in that turn', async t => {
  const { call, sent } = await tavern(t, ['【战斗|灰狼:普通】', '打完了。'])
  const book = { entries: [{ keys: [], content: '当前体力：{{getvar::stat_data.体力}}', constant: true, enabled: true, comment: '状态', depth: 0 }] }
  const file = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '阿岚', description: '向导', first_mes: '开场。', character_book: book } })).toString('base64')
  const card = (await call('/api/cards/import', { filename: 'd.json', data: file })).body
  await call(`/api/cards/${card.id}/game`, { level: 'full', bindings: { life: '体力' } }, 'PUT')
  const chat = (await call('/api/chats', { cardId: card.id })).body
  await opening(call, chat, { 体力: 80 })
  await call(`/api/chats/${chat.id}/turn`, { parentId: 'root', input: '走' })
  const view = (await call(`/api/chats/${chat.id}`)).body
  const fight = fought(view, await bookOf(call, card), chat.id, { want: 'won' })
  await settle(call, chat, view.path.at(-1), fight)
  const life = fight.state.units[0].life
  assert.ok(life < 80, 'the fight cost something')
  assert.match(lastPrompt(sent[1]), new RegExp(`当前体力：${life}`), 'not the number from before the fight')
})

test('levels: experience by tier, points to share out, and a level the card keeps stays the card\'s', () => {
  const book = cleanRulebook({ level: 'full' })
  const win = experience => ({ op: 'battle', over: 'won', life: 50, energy: 10, used: {}, experience })
  const grown = applyOps(startSheet(book), book, [win(350)]).sheet
  assert.equal(grown.level, 3, '100 to level 2, 200 to level 3')
  assert.equal(grown.experience, 50)
  assert.equal(grown.points, 4)
  const bound = cleanRulebook({ level: 'full', bindings: { level: '等级' } })
  const kept = applyOps(sheetOf(bound, null, { 等级: 7 }), bound, [win(500)]).sheet
  assert.equal(kept.level, 7)
  assert.equal(kept.points, 0)
  assert.equal(kept.experience, 500)
})

test('a point goes on an attribute, and a roll sees it at once', () => {
  const book = cleanRulebook({ level: 'full', attributes: { grace: 13 } })
  const sheet = { ...startSheet(book), points: 1 }
  const before = chanceFor(sheet, book, { stat: '灵巧', dc: 12 })
  const { sheet: after, lines } = applyOps(sheet, book, cleanOps([{ op: 'point', id: 'grace' }]))
  assert.equal(after.attributes.grace, 14)
  assert.equal(after.points, 0)
  assert.equal(lines[0], '玩家把 1 点加到灵巧')
  assert.equal(chanceFor(after, book, { stat: '灵巧', dc: 12 }), before + 5)
  assert.equal(applyOps(after, book, [{ op: 'point', id: 'grace' }]).dropped.length, 1, 'none left')
  assert.deepEqual(cleanOps([{ op: 'point', id: 'nope' }, { op: 'battle', life: 9999 }]), [], 'a fight\'s outcome is never the page\'s to send')
})

test('a fight\'s foes and chance, and a skill set for the card', () => {
  assert.equal(foesLine([{ name: '灰狼' }, { name: '灰狼' }, { name: '狼王' }]), '灰狼 ×2、狼王')
  const book = cleanRulebook({ level: 'full', skills: { 破山掌: 'sweep', 怪: 'nope' } })
  assert.deepEqual(book.skills, { 破山掌: 'sweep' })
  const sheet = { ...startSheet(book), skills: ['破山掌'] }
  const setup = encounterSetup(sheet, book, { foes: [{ name: '灰狼', count: 1, tier: 'minion' }] }, 'c', 'n')
  assert.deepEqual(setup.player.skills, [{ name: '破山掌', kind: 'sweep' }])
  assert.equal(chanceToWin(setup), 100)
  assert.deepEqual(encounterSetup(startSheet(book), book, { foes: [{ name: '狼', count: 1, tier: 'minion' }] }, 'c', 'n').player.skills.map(skill => skill.name), ['强击', '横扫'], 'nobody starts with nothing to do')
  assert.equal(cleanFight(null), null)
  assert.deepEqual(cleanFight({ over: 'won', attempt: -1, actions: [{ kind: 'attack', target: 'foe-0', extra: 1 }] }), { over: 'won', attempt: 0, actions: [{ kind: 'attack', target: 'foe-0' }] })
})

test('a card\'s music: uploaded, listed, played in pieces, and gone with the delete', async t => {
  const { call, card, base } = await tavern(t, [])
  assert.deepEqual((await call(`/api/cards/${card.id}/music`)).body, { tracks: [] })
  const bytes = Buffer.from('ID3 not really a song, but bytes all the same')
  const refused = await call(`/api/cards/${card.id}/music`, { name: '歌', data: 'data:text/plain;base64,aGk=' })
  assert.equal(refused.status, 400)
  const track = (await call(`/api/cards/${card.id}/music`, { name: ' 雨夜 ', use: 'battle', data: `data:audio/mpeg;base64,${bytes.toString('base64')}` })).body
  assert.equal(track.name, '雨夜')
  assert.equal(track.use, 'battle')
  assert.match(track.file, /\.mp3$/)
  assert.deepEqual((await call(`/api/cards/${card.id}/music`)).body.tracks, [track])
  const whole = await fetch(`${base}/api/music/${card.id}/${track.file}`)
  assert.equal(whole.headers.get('content-type'), 'audio/mpeg')
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes)
  const piece = await fetch(`${base}/api/music/${card.id}/${track.file}`, { headers: { range: 'bytes=4-6' } })
  assert.equal(piece.status, 206)
  assert.equal(piece.headers.get('content-range'), `bytes 4-6/${bytes.length}`)
  assert.equal(await piece.text(), 'not')
  assert.equal((await fetch(`${base}/api/music/${card.id}/..%2Fcard.json`)).status, 404)
  assert.equal((await call(`/api/cards/${card.id}/music/${track.id}`, { use: '茶馆' }, 'PUT')).body.use, '茶馆')
  assert.equal((await call(`/api/cards/${card.id}/music/nope`, { use: '茶馆' }, 'PUT')).status, 404)
  assert.equal((await call(`/api/cards/${card.id}/music/${track.id}`, {}, 'DELETE')).status, 200)
  assert.deepEqual((await call(`/api/cards/${card.id}/music`)).body, { tracks: [] })
  assert.equal((await fetch(`${base}/api/music/${card.id}/${track.file}`)).status, 404)
})

test('the bestiary: the helper says what a foe is, once; what is known stays, a picture above all', async t => {
  const { base, call, card, newChat, sent, take } = await tavern(t, ['狼来了。【战斗|灰狼:普通】', '[{"name":"灰狼","looks":"grey wolf, snarling","moves":["撕咬","猛扑"]},{"name":"别的","looks":"x","moves":[]}]', '听不懂', '[{"name":"灰狼","looks":"改了","moves":[]}]'])
  await call(`/api/cards/${card.id}/game`, { level: 'full' }, 'PUT')
  const chat = await newChat()
  await take(chat, '走')
  const book = (await call(`/api/chats/${chat.id}/game/foes`, { names: ['灰狼'] })).body
  assert.deepEqual(book.foes, { 灰狼: { looks: 'grey wolf, snarling', moves: ['撕咬', '猛扑'] } })
  assert.match(JSON.stringify(sent[1].messages), /狼来了/, 'with the reply that brought it on')
  const lost = (await call(`/api/chats/${chat.id}/game/foes`, { names: ['山贼'] })).body
  assert.equal(lost.foes.山贼, undefined, 'an answer it cannot read changes nothing')
  assert.equal(Object.keys(lost.foes).length, 1)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const drawn = (await call(`/api/cards/${card.id}/foes/image`, { name: '灰狼', image: `data:image/png;base64,${png.toString('base64')}` }, 'PUT')).body
  const { file } = drawn.foes.灰狼
  assert.match(file, /^foe-.+\.png$/)
  const served = await fetch(`${base}/api/foes/${card.id}/${file}`)
  assert.equal(served.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png)
  assert.equal((await fetch(`${base}/api/foes/${card.id}/nope.png`)).status, 404)
  const again = (await call(`/api/chats/${chat.id}/game/foes`, { names: ['灰狼'] })).body
  assert.equal(again.foes.灰狼.looks, 'grey wolf, snarling', 'what is known stays')
  assert.equal(again.foes.灰狼.file, file)
  const bare = (await call(`/api/cards/${card.id}/foes/image`, { name: '灰狼', image: null }, 'PUT')).body
  assert.equal(bare.foes.灰狼.file, undefined)
  assert.equal(bare.foes.灰狼.looks, 'grey wolf, snarling')
  assert.equal((await fetch(`${base}/api/foes/${card.id}/${file}`)).status, 404, 'the file goes too')
  assert.equal((await call(`/api/cards/${card.id}/foes/image`, { name: '灰狼', image: 'data:text/plain;base64,aGk=' }, 'PUT')).status, 400)
})

test('a foe nobody has described cannot be drawn, and a card without rules sends nothing', async t => {
  const { call, card, sent, newChat } = await tavern(t, [])
  assert.equal((await call(`/api/cards/${card.id}/foes/draw`, { name: '灰狼' })).status, 404)
  const chat = await newChat()
  assert.deepEqual((await call(`/api/chats/${chat.id}/game/foes`, { names: [] })).body.foes, {})
  assert.equal(sent.length, 0, 'nothing to ask: nothing asked')
})

test('the bestiary as kept: what makes no sense goes', () => {
  const book = cleanRulebook({ foes: { 灰狼: { looks: ' wolf ', moves: ['撕咬', 3, ''], file: '../x.png' }, 怪: 'x', 狼王: { file: 'foe-a1.png' } } })
  assert.deepEqual(book.foes, { 灰狼: { looks: 'wolf', moves: ['撕咬'] }, 狼王: { looks: '', moves: [], file: 'foe-a1.png' } })
  assert.deepEqual(parseFoes('<think>想想</think>好的 [{"name":"灰狼","looks":"wolf","moves":["咬"]}] 完', ['灰狼']), { 灰狼: { looks: 'wolf', moves: ['咬'] } })
  assert.deepEqual(parseFoes('不是 JSON', ['灰狼']), {})
  assert.deepEqual(parseFoes('[{"name":"别的","looks":"x"}]', ['灰狼']), {})
})


test('the rule book goes with the card: out in each file, back with it, the bestiary\'s pictures left behind', async t => {
  const { call, card } = await tavern(t, [])
  const none = (await call(`/api/cards/${card.id}/sillytavern`)).body
  assert.equal(none.data.extensions.cicatavern, undefined, 'a card that never had rules stays as it was')
  await call(`/api/cards/${card.id}/game`, { level: 'full', attributes: { grace: 14 }, start: { things: [{ name: '回春丹', count: 2 }], skills: ['裂石'] }, items: { 回春丹: { type: 'heal', size: 'large' } }, skills: { 裂石: 'strike' }, foes: { 灰狼: { looks: 'wolf', moves: ['撕咬'] } } }, 'PUT')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await call(`/api/cards/${card.id}/foes/image`, { name: '灰狼', image: `data:image/png;base64,${png.toString('base64')}` }, 'PUT')

  const raw = (await call(`/api/cards/${card.id}/sillytavern`)).body
  assert.equal(raw.data.extensions.cicatavern.game.level, 'full')
  assert.equal(raw.data.extensions.cicatavern.game.foes.灰狼.file, undefined, 'no picture to point at')
  const own = (await call(`/api/cards/${card.id}/export`)).body
  assert.equal(own.card.game.attributes.grace, 14)

  const upload = json => ({ filename: 'back.json', data: Buffer.from(JSON.stringify(json)).toString('base64') })
  for (const file of [{ ...raw, data: { ...raw.data, name: '从酒馆回来' } }, { ...own, card: { ...own.card, name: '从存档回来' } }]) {
    const back = (await call('/api/cards/import', upload(file))).body
    const book = (await call(`/api/cards/${back.id}/game`)).body
    assert.equal(book.level, 'full')
    assert.equal(book.attributes.grace, 14)
    assert.deepEqual(book.start.things, [{ name: '回春丹', count: 2 }])
    assert.deepEqual(book.skills, { 裂石: 'strike' })
    assert.deepEqual(book.items, { 回春丹: { type: 'heal', size: 'large' } })
    assert.deepEqual(book.foes, { 灰狼: { looks: 'wolf', moves: ['撕咬'] } })
    assert.equal((await call(`/api/cards/${back.id}`)).body.game, undefined, 'kept beside the card, not in it')
  }
})

test('a file\'s rule book does not push out the one a card already has', async t => {
  const { call, card } = await tavern(t, [])
  await call(`/api/cards/${card.id}/game`, { level: 'light', difficulty: 'hard' }, 'PUT')
  const file = { spec: 'chara_card_v2', data: { name: '林青禾', description: '新版', first_mes: '你好。', extensions: { cicatavern: { game: { level: 'full', difficulty: 'easy' } } } } }
  const data = Buffer.from(JSON.stringify(file)).toString('base64')
  await call('/api/cards/import', { filename: 'new.json', data, replace: card.id })
  const book = (await call(`/api/cards/${card.id}/game`)).body
  assert.deepEqual([book.level, book.difficulty], ['light', 'hard'])
})

test('foes the card knows are named to the model, only where they can be fought', () => {
  const sheet = startSheet(cleanRulebook({}))
  const full = gamePrompt({ sheet, pausing: true, fights: true, foes: ['灰狼', '狼王'] }, []).text
  assert.match(full, /常见的敌人：灰狼、狼王/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, foes: ['灰狼'] }, []).text, /常见的敌人/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: true }, []).text, /常见的敌人/)
})

test('a fight starts rested, whatever the last one took; a card that counts it itself goes by its own number', () => {
  const book = cleanRulebook({ level: 'full' })
  const gate = { kind: 'battle', foes: [{ name: '灰狼', count: 1, tier: 'normal' }] }
  const tired = { ...startSheet(book), energy: 0 }
  assert.equal(encounterSetup(tired, book, gate, 'chat', 'node').player.energy, 30)
  const after = applyOps(startSheet(book), book, [{ op: 'battle', over: 'won', life: 80, energy: 3, used: {}, experience: 0 }]).sheet
  assert.equal(after.energy, 30, 'what a fight took is back when it is over')
  const bound = cleanRulebook({ level: 'full', bindings: { energy: '内力' } })
  const own = sheetOf(bound, null, { 内力: 12 })
  assert.equal(encounterSetup(own, bound, gate, 'chat', 'node').player.energy, 12)
  assert.equal(applyOps(own, bound, [{ op: 'battle', over: 'won', life: 80, energy: 3, used: {}, experience: 0 }]).sheet.energy, 3)
})


test('the helper lays out a card\'s rules: a proposal, with only the variables that are there', async t => {
  const answer = JSON.stringify({
    theme: 'wuxia', energy: '内力', attributes: { body: 13, grace: 13, mind: 13 },
    skills: [{ name: '裂石掌', kind: 'strike' }], things: [{ name: '金创药', count: 2, type: 'heal', size: 'small' }],
    foes: [{ name: '山贼', looks: 'bandit', moves: ['劈砍'] }],
    bindings: { life: '主角.体力', energy: '没有这个', things: '主角.体力', quests: '主角.行囊', nonsense: '主角.体力' },
  })
  const { call, card, newChat, sent, take } = await tavern(t, [`<UpdateVariable>_.set('主角.体力', 80);</UpdateVariable>走吧。`, `<think>想想</think>好的：${answer}`, '听不懂'])
  const chat = await newChat()
  await take(chat, '开始')
  const found = await call(`/api/cards/${card.id}/game/suggest`, { chatId: chat.id })
  assert.equal(found.status, 200)
  assert.equal(found.body.theme, 'wuxia')
  assert.equal(found.body.energyName, '内力')
  assert.deepEqual(found.body.attributes, { body: 13, grace: 13, mind: 12, charm: 10 }, 'the points run out')
  assert.deepEqual(found.body.start, { things: [{ name: '金创药', count: 2 }], skills: ['裂石掌'] })
  assert.deepEqual(found.body.skills, { 裂石掌: 'strike' })
  assert.deepEqual(found.body.foes, { 山贼: { looks: 'bandit', moves: ['劈砍'] } })
  assert.deepEqual(found.body.bindings, { life: '主角.体力' }, 'a number for a number, and nothing made up')
  assert.match(JSON.stringify(sent.at(-1).messages), /茶馆掌柜/, 'it reads the card')
  assert.equal((await call(`/api/cards/${card.id}/game`)).body.level, 'off', 'nothing is kept until it is taken')
  assert.equal((await call(`/api/cards/${card.id}/game/suggest`, {})).status, 502, 'an answer it cannot read says so')
})

test('a genre goes on the book: what energy is called, shown in a fight of the card', () => {
  const book = cleanRulebook({ theme: 'wuxia', energyName: ' 内力真气太长了也截 ' })
  assert.equal(book.theme, 'wuxia')
  assert.equal(book.energyName, '内力真气太长')
  assert.equal(cleanRulebook({ energyName: 3 }).energyName, '')
})
