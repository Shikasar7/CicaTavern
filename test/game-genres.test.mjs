// 游戏规则 in stories other than 武侠 and 修仙: their words, their ladders, and the 理智 of a story of horror.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { battleSetup, fieldFoes, playerOf, skillKindOf, startBattle, step } from '../web/shared/game/battle.js'
import { fightResult } from '../web/shared/game/encounter.js'
import { replyMarks, withoutGameMarks } from '../web/shared/game/marks.js'
import { rankPower, strengthOf } from '../web/shared/game/rank.js'
import { applyOps, attributeOf, chanceFor, cleanOps, cleanRulebook, effectOf, keptSheet, modifierFor, nothingToRestore, opWrites, rollCheck, sanityWord, settleReply, sheetOf, startSheet, usableNow } from '../web/shared/game/sheet.js'
import { guessBindings } from '../web/shared/game/bindings.js'
import { headerPlace, storyDay, timesIn } from '../web/shared/vn.js'
import { gamePrompt, mayAskForFight, parseSuggestion } from '../server/game.mjs'

const plain = cleanRulebook({})
const horror = cleanRulebook({ sanity: true, attributes: { mind: 10 } })
const typeOf = name => effectOf(plain, name)?.type ?? null

test('a thing is told by its name, whatever the story', () => {
  for (const name of ['急救包', '绷带', '医疗针', '纳米修复剂', '治疗药水', '吗啡', '止血膏', '回春丹']) assert.equal(typeOf(name), 'heal', name)
  for (const name of ['能量电池', '魔力药水', '灵泉水', '回气散']) assert.equal(typeOf(name), 'energy', name)
  for (const name of ['炸药', '毒药', '手雷', '手榴弹', '电磁脉冲弹', '雷符']) assert.equal(typeOf(name), 'damage', name)
  for (const name of ['解毒剂', '圣水']) assert.equal(typeOf(name), 'cure', name)
  assert.equal(typeOf('镇静剂'), 'calm')
  assert.equal(typeOf('子弹'), 'none', 'no blow by itself')
  for (const name of ['死灵之书', '灵魂宝石', '空气元素瓶', '左轮手枪']) assert.equal(typeOf(name), null, name)
})

test('a skill is told by its name too', () => {
  assert.equal(skillKindOf('电磁脉冲'), 'stun')
  assert.equal(skillKindOf('纳米修复'), 'heal')
  assert.equal(skillKindOf('急救'), 'heal')
  assert.equal(skillKindOf('祝福'), 'boost')
  assert.equal(skillKindOf('全弹发射'), 'sweep')
  assert.equal(skillKindOf('冰霜新星'), 'sweep')
  assert.equal(skillKindOf('等离子射击'), 'strike')
})

test('the words of other stories come to the four attributes', () => {
  for (const word of ['体质', '运动']) assert.equal(attributeOf(word), 'body', word)
  for (const word of ['射击', '驾驶', '隐匿']) assert.equal(attributeOf(word), 'grace', word)
  for (const word of ['侦查', '聆听', '图书馆', '神秘学', '理智', '黑客', '工程', '奥术', '信仰']) assert.equal(attributeOf(word), 'mind', word)
  assert.equal(attributeOf('话术'), 'charm')
})

test('a blow is a blow with a gun or a spell', () => {
  for (const words of ['我开火', '我举枪瞄准它扣动扳机', '我用等离子枪轰它', '我驾驶机甲冲上去', '我向它开了一枪', '我一枪打爆它的头', '我施放火球术', '我咏唱咒语轰向哥布林', '我挥动战斧冲上去', '我举盾撞向它', '我放箭']) assert.equal(mayAskForFight(words), true, words)
  assert.equal(mayAskForFight('我看了看星图'), false)
})

test('a stardate is a calendar: later is another day, the same or earlier is not', () => {
  const at = (...texts) => storyDay(texts.map(text => ({ text: `<time_box>${text}｜舰桥｜无</time_box>` }))).day
  assert.equal(at('星历2387.104 22:00', '星历2387.105 07:00'), 2)
  assert.equal(at('星历2387.104 22:00', '星历2387.104 23:00'), 1)
  assert.equal(at('星历2387.105', '星历2387.104'), 1, 'a memory')
  assert.equal(at('Stardate 41153.7', 'Stardate 41154.2'), 2)
})

const stands = (ranks, own, foe, span) => strengthOf(foe, { ...startSheet({}), rank: own }, ranks, span).gap

test('on a ladder of small steps it takes more ranks to be out of reach', () => {
  const army = ['列兵', '下士', '中士', '上士', '少尉', '中尉', '上尉']
  assert.equal(stands(army, '下士', '中士'), 2, 'the walls of a wide ladder')
  assert.equal(stands(army, '下士', '上士'), 3)
  assert.equal(stands(army, '下士', '中士', 'narrow'), 1)
  assert.equal(stands(army, '下士', '上士', 'narrow'), 2)
  assert.equal(stands(army, '下士', '中尉', 'narrow'), 3)
  assert.equal(stands(army, '中士', '下士', 'narrow'), -1)
  assert.equal(stands(army, '上士', '下士', 'narrow'), -2)
  assert.equal(cleanRulebook({}).rankSpan, 'wide')
  assert.equal(cleanRulebook({ rankSpan: 'narrow' }).rankSpan, 'narrow')
  assert.equal(cleanRulebook({ rankSpan: 'x' }).rankSpan, 'wide')
})

test('a rank in letters stands alone', () => {
  const guild = ['F', 'E', 'D', 'C', 'B', 'A', 'S']
  assert.equal(rankPower(guild, 'S级'), 24)
  assert.equal(rankPower(guild, 'D级冒险者'), 8)
  assert.equal(rankPower(guild, 'BOSS'), null)
  assert.equal(rankPower(guild, 'A'), 20)
})

const rulesFor = (extra = {}) => gamePrompt({ sheet: startSheet({}), pausing: true, fights: true, check: null, ...extra }, []).text

test('the rules name nothing of one kind of story', () => {
  const text = `${rulesFor()}${rulesFor({ ranks: ['铜牌', '银牌'] })}`
  for (const word of ['魔修', '法宝', '功法', '火折子']) assert.equal(text.includes(word), false, word)
  assert.match(text, /例子只是格式/)
})

test('理智 is there only on a card that counts it', () => {
  const sheet = startSheet(horror)
  assert.equal(sheet.sanity, 80)
  assert.equal(sheet.maxSanity, 100)
  assert.equal(startSheet(cleanRulebook({ sanity: true, attributes: { mind: 16 } })).sanity, 92, 'a steady mind')
  assert.equal('sanity' in startSheet({}), false)
  assert.equal(sheetOf(plain, sheet, {}).sanity, undefined, 'turned off')
  assert.equal(sheetOf(horror, startSheet({}), {}).sanity, 80, 'turned on in a story under way')
  assert.equal(settleReply(startSheet({}), replyMarks('【理智|重】')).sanity, undefined)
})

test('a shock takes what it takes, a steady mind a little less', () => {
  assert.deepEqual(replyMarks('【理智|中】'), [{ kind: 'sanity', back: false, size: 'medium' }])
  assert.deepEqual(replyMarks('【理智|回复|轻】'), [{ kind: 'sanity', back: true, size: 'light' }])
  assert.equal(withoutGameMarks('他看见了。【理智|重】'), '他看见了。')
  const sheet = startSheet(horror)
  assert.equal(settleReply(sheet, replyMarks('【理智|轻】')).sanity, 77)
  assert.equal(settleReply(sheet, replyMarks('【理智|中】')).sanity, 72)
  assert.equal(settleReply(sheet, replyMarks('【理智|重】')).sanity, 65)
  assert.equal(settleReply({ ...sheet, attributes: { ...sheet.attributes, mind: 16 } }, replyMarks('【理智|重】')).sanity, 68)
  assert.equal(settleReply({ ...sheet, attributes: { ...sheet.attributes, mind: 20 } }, replyMarks('【理智|轻】')).sanity, 79, 'never nothing')
  assert.equal(settleReply({ ...sheet, sanity: 50 }, replyMarks('【理智|回复|中】')).sanity, 58)
  assert.equal(settleReply({ ...sheet, sanity: 99 }, replyMarks('【理智|回复|重】')).sanity, 100)
})

test('at nothing the player goes mad, and comes to', () => {
  const after = settleReply({ ...startSheet(horror), sanity: 5 }, replyMarks('【理智|重】'))
  assert.equal(after.sanity, 20)
  assert.deepEqual(after.conditions.map(item => [item.name, item.size]), [['疯狂', 'heavy']])
})

test('a line of dialogue is no date, however many years it talks of', () => {
  const box = '<time_box>1925年10月19日 周一 傍晚6:24｜图书馆｜大雨</time_box>'
  const spoken = '【玛丽|思考】「这是他的字。可《运河年鉴》三年前就从目录里撤掉了。」'
  assert.deepEqual([...new Set(timesIn(`${box}\n${spoken}`))], ['1925年10月19日 周一 傍晚6:24'])
  assert.equal(storyDay([{ text: `${box}\n${spoken}` }, { text: `${box}\n【管理员|平静】「我在这座图书馆干了二十六年。」` }]).day, 1)
  assert.equal(headerPlace(spoken), null)
  assert.notEqual(headerPlace('【10月19日 周一 ｜ 傍晚 ｜ 旧城茶馆 ｜ 小雨】'), null, 'a header in those brackets still is one')
})

test('it comes back slowly, and only a little with a night', () => {
  assert.equal(settleReply({ ...startSheet(horror), sanity: 50 }, [], { newDay: true }).sanity, 51)
  assert.equal(settleReply({ ...startSheet(horror), sanity: 50 }, [], { newDay: true, bound: ['sanity'] }).sanity, 50, 'the card keeps it')
})

test('low, it marks the mind for as long as it stays low', () => {
  const at = sanity => sheetOf(horror, { ...startSheet(horror), sanity }, {})
  assert.deepEqual(at(51).strain, [])
  assert.equal(sanityWord(at(51)), '清醒')
  assert.equal(sanityWord(at(50)), '动摇')
  assert.equal(modifierFor(at(50), '心智'), -1)
  assert.equal(modifierFor(at(50), '灵巧'), 0, 'only the mind')
  assert.equal(sanityWord(at(25)), '濒临崩溃')
  assert.equal(modifierFor(at(25), '心智'), -2)
  assert.deepEqual(rollCheck(at(25), horror, { stat: '心智', dc: 12 }, 's').ails, [{ name: '濒临崩溃', by: 2 }])
  assert.ok(chanceFor(at(25), horror, { stat: '心智', dc: 12 }) < chanceFor(at(90), horror, { stat: '心智', dc: 12 }))
  assert.equal('strain' in keptSheet(at(25)), false, 'worked out each time')
  assert.deepEqual(battleSetup(at(25), { foes: [], seed: 's' }).player.modifiers, { body: 0, grace: 0, mind: -2 })
})

const foe = (tier, gap) => ({ name: '深潜者', count: 1, tier, gap })

test('facing what is far beyond the player costs sanity, on a card that counts it', () => {
  const setupOf = (sheet, gap) => battleSetup(sheet, { foes: fieldFoes([foe('minion', gap)]), seed: 's' })
  const worth = (sheet, gap) => fightResult(setupOf(sheet, gap), { over: 'story' }).op
  assert.equal(worth(startSheet(horror), 3), null, 'left to the story, nothing was faced')
  const bout = (sheet, gap) => {
    const setup = setupOf(sheet, gap)
    let state = startBattle(setup)
    const actions = []
    while (!state.over) {
      actions.push({ kind: 'guard' })
      state = step(state, { kind: 'guard' }).state
    }
    return fightResult(setup, { over: state.over, attempt: 0, actions })
  }
  const sheet = sheetOf(horror, null, {})
  assert.equal(bout(sheet, 3).op.shock, 12)
  assert.equal(bout(sheet, 2).op.shock, 5)
  assert.equal('shock' in bout(sheet, 1).op, false)
  assert.equal('shock' in bout(sheetOf(plain, null, {}), 3).op, false, 'a card that does not count it')
  assert.equal(applyOps(sheet, horror, [bout(sheet, 3).op]).sheet.sanity, 68)
})

test('what calms is used out of a fight, and stays out of one', () => {
  const book = cleanRulebook({ sanity: true, items: { 镇静剂: { type: 'calm', size: 'medium' } } })
  const sheet = { ...startSheet(book), sanity: 50, things: [{ name: '镇静剂', count: 1 }] }
  assert.equal(usableNow({ type: 'calm' }), true)
  assert.equal(nothingToRestore({ type: 'calm' }, sheet), false)
  assert.equal(nothingToRestore({ type: 'calm' }, { ...sheet, sanity: 100 }), true)
  assert.equal(nothingToRestore({ type: 'calm' }, startSheet({})), true, 'a card that does not count it')
  const used = applyOps(sheet, book, [{ op: 'use', name: '镇静剂' }])
  assert.equal(used.sheet.sanity, 70)
  assert.deepEqual(used.sheet.things, [])
  assert.match(used.lines[0], /理智 \+20/)
  assert.equal(applyOps({ ...sheet, sanity: 100 }, book, [{ op: 'use', name: '镇静剂' }]).dropped.length, 1)
  assert.deepEqual(battleSetup(sheet, { foes: [], seed: 's', effects: name => book.items[name] }).player.things, [])
})

test('the player can set it by hand, and a card can keep it', () => {
  assert.deepEqual(cleanOps([{ op: 'sanity', value: 40 }]), [{ op: 'sanity', value: 40 }])
  assert.equal(applyOps(startSheet(horror), horror, [{ op: 'sanity', value: 40 }]).sheet.sanity, 40)
  assert.equal(applyOps(startSheet({}), plain, [{ op: 'sanity', value: 40 }]).dropped.length, 1)
  const book = cleanRulebook({ sanity: true, bindings: { sanity: '调查员.理智' } })
  const sheet = sheetOf(book, null, { 调查员: { 理智: 42 } })
  assert.equal(sheet.sanity, 42)
  assert.equal(sheetOf(book, null, {}).broken.includes('sanity'), true)
  assert.equal(settleReply(sheet, replyMarks('【理智|重】'), { bound: ['sanity'] }).sanity, 42, 'the card says what it comes to')
  assert.deepEqual(opWrites(book, { 调查员: { 理智: 42 } }, sheet, { ...sheet, sanity: 30 }, []), [{ op: 'replace', path: '调查员.理智', value: 30 }])
  assert.deepEqual(guessBindings({ 调查员: { 理智: 42 } }), { sanity: '调查员.理智' })
  assert.deepEqual(guessBindings({ 主角: { SAN: 42 } }), { sanity: '主角.SAN' })
})

test('the model hears of it only where it counts', () => {
  const sheet = sheetOf(horror, { ...startSheet(horror), sanity: 40 }, {})
  const told = rulesFor({ sheet })
  assert.match(told, /这个故事有理智/)
  assert.match(told, /【理智\|轻】/)
  assert.match(told, /理智 40\/100（动摇）/)
  assert.doesNotMatch(rulesFor(), /理智/)
  assert.doesNotMatch(rulesFor({ sheet, bound: ['sanity'] }), /【理智\|轻】/, 'the card keeps it')
  const said = { role: 'user', prompt: '<游戏规则>自己写的行动 战斗选项</游戏规则>' }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, check: null }, [said]).reminder, /理智受到冲击没有/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: true, check: null, bound: ['sanity'] }, [said]).reminder, /理智受到冲击/)
})

test('the helper can say a card is one of horror, and how its ladder runs', () => {
  assert.equal(parseSuggestion('{"theme":"horror"}', []).sanity, true)
  assert.equal(parseSuggestion('{"theme":"horror"}', []).theme, 'horror')
  assert.equal('sanity' in parseSuggestion('{"theme":"scifi"}', []), false)
  assert.equal(parseSuggestion('{"ranks":["下士","中士"],"rankSpan":"narrow"}', []).rankSpan, 'narrow')
  assert.equal(parseSuggestion('{"ranks":["炼气","筑基"]}', []).rankSpan, 'wide')
  assert.equal(playerOf(startBattle(battleSetup(startSheet({}), { foes: fieldFoes([foe('minion', 0)]), seed: 's' }))).life, 100)
})
