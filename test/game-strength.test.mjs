// 游戏规则: how a foe stands to the player, what holds the player back, getting up from a lost fight, and what the model is told of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { battleSetup, canRally, fieldFoes, foeSheets, playerOf, replay, refusal, rewardOf, simulate, startBattle, step } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult } from '../web/shared/game/encounter.js'
import { gateOf, replyMarks, withoutGameMarks } from '../web/shared/game/marks.js'
import { rankAt, rankPower, strengthOf } from '../web/shared/game/rank.js'
import { AID_BONUS, aidFor, applyOps, chanceFor, checkLine, cleanCheck, cleanOps, cleanRulebook, keptSheet, modifierFor, nothingToRestore, rankNow, rollCheck, settleReply, sheetOf, startSheet, usableNow } from '../web/shared/game/sheet.js'
import { guessBindings } from '../web/shared/game/bindings.js'
import { gamePrompt, mayAskForFight, parseSuggestion, suggestRequest } from '../server/game.mjs'
import { hudPicks, hudRows } from '../web/shared/hud.js'

const RANKS = ['炼气', '筑基', '金丹', '元婴', '化神']
const foe = (tier, gap) => ({ name: '魔修', count: 1, tier, gap })
const setupOf = (tier, gap, sheet = startSheet({})) => battleSetup(sheet, { foes: fieldFoes([foe(tier, gap)]), seed: 's' })
const ailing = (...conditions) => ({ ...startSheet({}), conditions })
const SPRAIN = { name: '扭伤左脚', stat: 'grace', size: 'medium', days: 3 }
const WEAK = { name: '重伤', stat: '', size: 'medium', days: 3 }

test('a rank is read from how a card writes it, step and all', () => {
  assert.equal(rankPower(RANKS, '金丹中期（DC:52）'), 9)
  assert.equal(rankPower(RANKS, '炼气'), 0)
  assert.equal(rankPower(RANKS, '元婴大圆满'), 15)
  assert.equal(rankPower(['仙', '真仙'], '真仙后期'), 6, 'the longest name it holds')
  assert.equal(rankPower(RANKS, '路人'), null)
  assert.equal(rankAt(RANKS, 1), '炼气')
  assert.equal(rankAt(RANKS, 5), '筑基')
  assert.equal(rankAt(RANKS, 999), '化神', 'the top is the top')
  assert.equal(rankAt([], 3), '')
})

test('how a foe stands to the player: the model\'s word, or the ladder', () => {
  const sheet = { ...startSheet({}), level: 9 }
  assert.deepEqual(strengthOf('远强', sheet, []), { gap: 3 })
  assert.deepEqual(strengthOf('', sheet, RANKS), { gap: 0 })
  assert.deepEqual(strengthOf('不知道', sheet, RANKS), { gap: 0 }, 'a word nobody knows is an even fight')
  assert.deepEqual(strengthOf('元婴', sheet, []), { gap: 0 }, 'no ladder to read it on')
  assert.equal(strengthOf('金丹初期', sheet, RANKS).gap, 0, 'level 9 is the first step of the third rank')
  assert.equal(strengthOf('金丹后期', sheet, RANKS).gap, 1)
  assert.equal(strengthOf('元婴初期', sheet, RANKS).gap, 2)
  assert.equal(strengthOf('化神', sheet, RANKS).gap, 3)
  assert.equal(strengthOf('炼气', sheet, RANKS).gap, -2)
  assert.equal(strengthOf('化神', sheet, RANKS).rank, '化神')
  assert.equal(strengthOf('化神', { ...sheet, rank: '化神后期（DC:103）' }, RANKS).gap, -1, 'a rank in words says where the player stands')
})

test('a stronger foe takes more and deals more, and shows it before a blow is struck', () => {
  const [even, strong, out] = [0, 2, 3].map(gap => foeSheets(setupOf('normal', gap))[0])
  assert.ok(strong.life > even.life && out.life > strong.life)
  assert.ok(strong.attack > even.attack && out.attack > strong.attack)
  assert.ok(strong.level > even.level)
  assert.equal(out.gap, 3)
  assert.ok(foeSheets(setupOf('normal', -2))[0].life < even.life)
})

test('what the gaps come to: an even fight stays as it was, out of reach cannot be won', () => {
  const chance = (tier, gap) => simulate(setupOf(tier, gap), 200).chance
  assert.equal(chance('normal', 0), 100)
  assert.ok(chance('boss', 1) < chance('boss', 0))
  assert.ok(chance('normal', 2) < 90)
  for (const tier of ['minion', 'normal', 'elite', 'boss']) assert.equal(chance(tier, 3), 0, tier)
})

test('getting away from one far above you is harder', () => {
  const got = gap => Array.from({ length: 200 }, (_, i) => step(startBattle({ ...setupOf('normal', gap), seed: `run-${i}` }), { kind: 'flee' }).state.over === 'fled').filter(Boolean).length
  assert.ok(got(3) < got(0))
  assert.ok(got(3) > 0, 'but never out of the question')
})

test('a foe\'s word goes through its mark to the fight', () => {
  assert.deepEqual(gateOf('【战斗|魔修长老:精英:远强】').foes, [{ name: '魔修长老', count: 1, tier: 'elite', power: '远强' }])
  assert.deepEqual(gateOf('【战斗|魔修长老:远强】').foes, [{ name: '魔修长老', count: 1, tier: 'normal', power: '远强' }], 'no tier: the word is still read')
  const book = cleanRulebook({ level: 'full', ranks: RANKS })
  const setup = encounterSetup(startSheet(book), book, { foes: [{ name: '魔修', count: 1, tier: 'elite', power: '元婴' }] }, 'c', 'n')
  assert.equal(setup.foes[0].gap, 3)
  assert.equal(foeSheets(setup)[0].rank, '元婴')
})

test('what holds the player back is read from its marks', () => {
  assert.deepEqual(replyMarks('【异常|扭伤左脚|灵巧|中】'), [{ kind: 'ail', name: '扭伤左脚', stat: '灵巧', size: 'medium' }])
  assert.deepEqual(replyMarks('【异常|中毒】'), [{ kind: 'ail', name: '中毒', stat: '', size: 'light' }])
  assert.deepEqual(replyMarks('【异常|中毒|重】'), [{ kind: 'ail', name: '中毒', stat: '', size: 'heavy' }])
  assert.deepEqual(replyMarks('【异常|解除|中毒】'), [{ kind: 'mend', name: '中毒' }])
  assert.equal(withoutGameMarks('她按住脚踝。【异常|扭伤左脚|灵巧|中】'), '她按住脚踝。')
})

test('a condition comes off the rolls it touches, and is named in them', () => {
  assert.equal(modifierFor(ailing(SPRAIN), '灵巧'), -2)
  assert.equal(modifierFor(ailing(SPRAIN), '体魄'), 0, 'not the other attributes')
  assert.equal(modifierFor(ailing(WEAK), '体魄'), -2, 'one on everything')
  assert.equal(modifierFor(ailing(WEAK), '随便什么'), -2)
  const book = cleanRulebook({})
  assert.ok(chanceFor(ailing(SPRAIN), book, { stat: '灵巧', dc: 12 }) < chanceFor(startSheet({}), book, { stat: '灵巧', dc: 12 }))
  const roll = rollCheck(ailing(SPRAIN), book, { stat: '灵巧', dc: 12 }, 's')
  assert.deepEqual(roll.ails, [{ name: '扭伤左脚', by: 2 }])
  assert.equal('ails' in rollCheck(startSheet({}), book, { stat: '灵巧', dc: 12 }, 's'), false)
})

test('however much piles up, a roll stays worth trying', () => {
  const heavy = name => ({ name, stat: '', size: 'heavy', days: 7 })
  const sheet = ailing(heavy('重伤'), heavy('透支'), { ...SPRAIN, size: 'light' })
  assert.equal(modifierFor(sheet, '灵巧'), -4)
  const roll = rollCheck(sheet, cleanRulebook({}), { stat: '灵巧', dc: 12 }, 's')
  assert.deepEqual(roll.ails, [{ name: '重伤', by: 3 }, { name: '透支', by: 1 }], 'the worst first, as far as it goes: what is shown adds up')
  assert.deepEqual(setupOf('normal', 0, sheet).player.modifiers, { body: -4, grace: -4, mind: -4 })
})

test('getting rid of one of a pile gives back what it really took', () => {
  const sheet = { ...ailing({ name: '甲', stat: '', size: 'heavy', days: 7 }, { name: '乙', stat: '', size: 'heavy', days: 7 }), things: [{ name: '解毒丹', count: 1 }] }
  const setup = battleSetup(sheet, { foes: fieldFoes([foe('boss', 0)]), seed: 's', effects: () => ({ type: 'cure' }) })
  assert.equal(setup.player.modifiers.body, -4)
  assert.equal(playerOf(step(startBattle(setup), { kind: 'item', name: '解毒丹' }).state).modifiers.body, -3, 'the other is still there')
})

test('a condition counts in a fight too', () => {
  assert.deepEqual(setupOf('normal', 0, ailing(WEAK)).player.modifiers, { body: -2, grace: -2, mind: -2 })
  assert.deepEqual(setupOf('normal', 0, ailing(WEAK)).player.ails, [{ name: '重伤', stat: '', size: 'medium' }])
  assert.deepEqual(setupOf('normal', 0, ailing(SPRAIN)).player.modifiers, { body: 0, grace: -2, mind: 0 })
})

test('a condition lasts by how bad it is, and wears off with the days', () => {
  const told = settleReply(startSheet({}), replyMarks('【异常|擦伤|体魄|轻】【异常|断臂|体魄|重】【异常|中毒|中】'))
  assert.deepEqual(told.conditions.map(item => [item.name, item.stat, item.days]), [['擦伤', 'body', 1], ['断臂', 'body', 7], ['中毒', '', 3]])
  const next = settleReply(told, [], { newDay: true })
  assert.deepEqual(next.conditions.map(item => item.name), ['断臂', '中毒'])
  assert.equal(next.conditions[0].days, 6)
  assert.deepEqual(settleReply(startSheet({}), replyMarks('【异常|擦伤|体魄|轻】'), { newDay: true }).conditions.map(item => item.days), [1], 'what the day brought counts from that day')
})

test('the same condition again is the worse of the two, and the model can say it is over', () => {
  const once = settleReply(startSheet({}), replyMarks('【异常|中毒|重】'))
  const again = settleReply(once, replyMarks('【异常|中毒|轻】'))
  assert.deepEqual(again.conditions.map(item => [item.size, item.days]), [['heavy', 7]])
  assert.deepEqual(settleReply(again, replyMarks('【异常|解除|中毒】')).conditions, [])
  assert.deepEqual(settleReply(again, replyMarks('【异常|解除|别的】')).conditions.length, 1)
})

test('the HUD shows what holds the player back, and nothing while nothing does', () => {
  const spec = { fields: [{ path: '$game.life', show: 'meter', min: 0, max: 100 }, { path: '$game.ailing', label: '状态', show: 'text', always: true }] }
  const picks = hudPicks(spec)
  assert.deepEqual(picks.map(pick => pick.path), ['$game.life', '$game.ailing'])
  assert.deepEqual(hudPicks(spec, { paths: ['$game.life'] }).map(pick => pick.path), ['$game.life', '$game.ailing'], 'whatever else the player chose')
  assert.deepEqual(hudRows(spec, picks, { $game: { life: 60, ailing: '' } }).map(row => row.path), ['$game.life'])
  assert.equal(hudRows(spec, picks, { $game: { life: 60, ailing: '重伤' } })[1].text, '重伤')
})

test('a sheet from before conditions still works', () => {
  const { conditions: _gone, ...old } = startSheet({})
  assert.equal(modifierFor(old, '灵巧'), 0)
  assert.deepEqual(sheetOf(cleanRulebook({}), old, {}).conditions, [])
  assert.deepEqual(settleReply(old, [], { newDay: true }).conditions, [])
})

test('the player can clear a condition, or cure the worst of them with what cures', () => {
  const book = cleanRulebook({ items: { 解毒丹: { type: 'cure' } } })
  const sheet = { ...ailing({ ...SPRAIN, size: 'light' }, WEAK), things: [{ name: '解毒丹', count: 1 }] }
  assert.deepEqual(cleanOps([{ op: 'mend', name: '重伤' }, { op: 'mend' }]), [{ op: 'mend', name: '重伤' }])
  assert.deepEqual(applyOps(sheet, book, [{ op: 'mend', name: '重伤' }]).sheet.conditions.map(item => item.name), ['扭伤左脚'])
  assert.deepEqual(applyOps(sheet, book, [{ op: 'mend', name: '没有的' }]).dropped.length, 1)
  const used = applyOps(sheet, book, [{ op: 'use', name: '解毒丹' }])
  assert.deepEqual(used.sheet.conditions.map(item => item.name), ['扭伤左脚'], 'the worst goes')
  assert.deepEqual(used.sheet.things, [])
  assert.match(used.lines[0], /重伤好了/)
  assert.equal(usableNow({ type: 'cure' }), true)
  assert.equal(nothingToRestore({ type: 'cure' }, startSheet({})), true)
  assert.equal(nothingToRestore({ type: 'cure' }, sheet), false)
  assert.equal(applyOps({ ...sheet, conditions: [] }, book, [{ op: 'use', name: '解毒丹' }]).dropped.length, 1, 'nothing to cure, nothing used')
})

const brought = setup => {
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    actions.push({ kind: 'guard' })
    state = step(state, { kind: 'guard' }).state
  }
  return { state, actions }
}

test('a player brought down can get up once, and the foes do not get a blow in for it', () => {
  const setup = setupOf('boss', 3)
  const { state, actions } = brought(setup)
  assert.equal(state.over, 'lost')
  assert.equal(canRally(state), true)
  assert.equal(refusal(state, { kind: 'rally' }), null)
  const { state: up } = step(state, { kind: 'rally' })
  assert.equal(up.over, null)
  assert.equal(playerOf(up).life, 40)
  assert.equal(playerOf(up).energy, playerOf(up).maxEnergy)
  assert.equal(up.rallied, true)
  assert.equal(refusal(up, { kind: 'rally' }), 'over', 'not in the middle of a fight')
  let down = up
  while (!down.over) down = step(down, { kind: 'guard' }).state
  assert.equal(down.over, 'lost')
  assert.equal(canRally(down), false, 'once a fight')
  assert.equal(replay(setup, [...actions, { kind: 'rally' }]).rallied, true, 'it replays like any other action')
})

test('it cannot be done from anything but being brought down', () => {
  const setup = setupOf('minion', 0)
  assert.equal(refusal(startBattle(setup), { kind: 'rally' }), 'over')
  assert.throws(() => step(startBattle(setup), { kind: 'rally' }))
})

test('a lost fight leaves its mark on the sheet, getting up a worse one', () => {
  const setup = setupOf('boss', 3)
  const { actions } = brought(setup)
  const book = cleanRulebook({})
  const lost = fightResult(setup, { over: 'lost', attempt: 0, actions })
  assert.deepEqual(applyOps(startSheet({}), book, [lost.op]).sheet.conditions.map(item => [item.name, item.size, item.days]), [['重伤', 'medium', 3]])
  let state = step(replay(setup, actions), { kind: 'rally' }).state
  const more = [...actions, { kind: 'rally' }]
  while (!state.over) {
    more.push({ kind: 'guard' })
    state = step(state, { kind: 'guard' }).state
  }
  const twice = fightResult(setup, { over: 'lost', attempt: 0, actions: more })
  assert.equal(twice.battle.rallied, true)
  assert.deepEqual(applyOps(startSheet({}), book, [twice.op]).sheet.conditions.map(item => item.name), ['重伤', '透支'])
  const won = fightResult(setupOf('minion', 0), { over: 'story' })
  assert.equal(won.op, null)
})

test('a rank kept in words is the player\'s level, and the card\'s to raise', () => {
  const book = cleanRulebook({ level: 'full', ranks: RANKS, bindings: { rank: '主角.境界' } })
  const sheet = sheetOf(book, null, { 主角: { 境界: '金丹中期（DC:52）' } })
  assert.equal(sheet.rank, '金丹中期（DC:52）')
  assert.equal(sheet.level, 10)
  assert.equal(rankNow(sheet, book), '金丹中期（DC:52）')
  assert.deepEqual(sheet.broken, [])
  assert.deepEqual(sheetOf(book, null, {}).broken, ['rank'], 'nothing there to read')
  assert.equal(applyOps(sheet, book, [{ op: 'grow', experience: 9999 }]).sheet.level, 10)
  assert.equal('bound' in keptSheet(sheet), false)
  assert.equal('rank' in keptSheet(sheet), false, 'read again each time: an old one must not outlive the binding')
})

test('the ladder goes with the rule book, and a story can start up it', () => {
  const book = cleanRulebook({ ranks: [' 炼气 ', '筑基', 3, ''], start: { rank: '筑基' } })
  assert.deepEqual(book.ranks, ['炼气', '筑基'])
  assert.equal(startSheet(book).level, 5)
  assert.equal(rankNow(startSheet(book), book), '筑基')
  assert.equal(startSheet(cleanRulebook({})).level, 1)
  assert.equal(rankNow(startSheet({}), cleanRulebook({})), '')
})

test('a rank in words is bound by its name, a number stays the level', () => {
  assert.deepEqual(guessBindings({ 主角: { 境界: '金丹' } }), { rank: '主角.境界' })
  assert.deepEqual(guessBindings({ 主角: { 等级: 3 } }), { level: '主角.等级' })
  assert.deepEqual(guessBindings({ 主角: { 等级: '黄金' } }), { rank: '主角.等级' })
})

const said = { role: 'user', prompt: '<游戏规则>自己写的行动 战斗选项</游戏规则>' }
const turn = (extra, turns = [said]) => gamePrompt({ sheet: startSheet({}), pausing: true, fights: true, check: null, ...extra }, turns)

test('the rules say what the player\'s own actions can and cannot do', () => {
  const { text } = turn({}, [])
  assert.match(text, /自己写的行动：/)
  assert.match(text, /不要照做/)
  assert.match(text, /不白给/)
  assert.match(text, /角色也不知道玩家的数值和背包/)
  assert.match(text, /【异常\|/)
  assert.match(turn({}, [{ role: 'user', prompt: '<游戏规则>战斗选项</游戏规则>' }]).text, /自己写的行动：/, 'a copy from before says nothing of it')
  assert.doesNotMatch(turn({}).text, /<游戏规则>/)
})

test('a turn the player wrote themselves is weighed, a choice is not', () => {
  assert.match(turn({ own: true }).text, /<本轮要求>这一轮是玩家自己写的行动：他写的是想做什么/)
  assert.doesNotMatch(turn({ own: false }).text, /<本轮要求>/)
})

test('words that may be a blow are put as a question', () => {
  assert.equal(mayAskForFight('我一剑杀了他'), true)
  assert.equal(mayAskForFight('拔剑砍过去'), true)
  assert.equal(mayAskForFight('我向老祖发起挑战'), true)
  assert.equal(mayAskForFight('问问掌柜'), false)
  assert.equal(mayAskForFight('我去砍些柴，生起一堆火'), false, 'firewood is no blow')
  assert.equal(mayAskForFight('我把柴劈开'), false)
  assert.match(turn({ mayFight: true }).text, /如果玩家这一轮是在对人动手/)
  assert.match(turn({ mayFight: true }).text, /不是的话这条作废/)
})

test('how a foe\'s strength is written, by whether the card has ranks', () => {
  assert.match(turn({}, []).text, /远弱、稍弱、相当、稍强、强、远强/)
  const ranked = turn({ ranks: RANKS }, []).text
  assert.match(ranked, /炼气、筑基、金丹、元婴、化神/)
  assert.doesNotMatch(ranked, /远弱/)
  assert.doesNotMatch(gamePrompt({ sheet: startSheet({}), pausing: true, fights: false, check: null }, []).text, /远强/, 'only where there are fights')
})

test('the sheet reads as words too, with what holds the player back and the rank', () => {
  const line = sheet => /<游戏状态>.*<\/游戏状态>/.exec(turn({ sheet, rank: '金丹' }).text)[0]
  assert.match(line(startSheet({})), /生命 100\/100（状态好）/)
  assert.match(line({ ...startSheet({}), life: 60 }), /带伤/)
  assert.match(line({ ...startSheet({}), life: 30 }), /伤得不轻/)
  assert.match(line({ ...startSheet({}), life: 5 }), /快撑不住了/)
  assert.match(line(startSheet({})), /等级：金丹/)
  assert.match(line(ailing(SPRAIN, WEAK)), /异常：扭伤左脚（灵巧，还有 3 天）、重伤（所有行动，还有 3 天）/)
})

test('an overdue fight suits the scene, and brings on a foe drawn for it', () => {
  const quiet = Array.from({ length: 5 }, () => ({ ...said }))
  const { text } = turn({ foes: ['灰狼'], spot: 'a' }, quiet)
  assert.match(text, /敌人可以是灰狼/)
  assert.match(text, /这条作废/)
  const after = [{ ...said, battle: { over: 'won', foes: '灰狼 ×2' } }, ...quiet]
  assert.match(turn({ foes: ['灰狼', '山贼'], spot: 'a' }, after).text, /敌人可以是山贼/, 'not the one just fought')
  assert.match(turn({ foes: ['灰狼'], spot: 'a' }, after).text, /敌人可以是灰狼/, 'unless there is no other')
  assert.doesNotMatch(turn({}, quiet).text, /敌人可以是/)
})

test('the reminder asks only after what the card does not keep itself', () => {
  assert.match(turn({}).reminder, /写完正文看一眼：玩家得到或失去了什么、受伤没有、答应或办成了什么事/)
  assert.match(turn({ bound: ['things'] }).reminder, /写完正文看一眼：受伤没有、答应或办成了什么事/)
  assert.doesNotMatch(turn({ bound: ['things', 'life', 'quests'] }).reminder, /写完正文看一眼/)
  assert.match(turn({}, []).reminder, /写完正文看一眼/, 'the first turn too, with the rules right there')
  assert.doesNotMatch(turn({}).reminder, /异常好了没有/)
  assert.match(turn({ sheet: ailing(SPRAIN) }).reminder, /身上的异常好了没有/, 'only with one to ask about')
})

test('a fight tells of getting up', () => {
  const battle = { over: 'won', rounds: 3, foes: '狼', downed: '狼', life: 5, maxLife: 100, used: {}, skills: [], rallied: true }
  assert.match(turn({ battle }).text, /硬撑着站了起来/)
  assert.doesNotMatch(turn({ battle: { ...battle, rallied: undefined } }).text, /硬撑着/)
})

test('the helper reads where a card says how strong people are, and its ladder is offered', () => {
  const card = { book: { entries: [{ comment: '杂项', content: '甲'.repeat(3000) }, { comment: '境界', content: '炼气、筑基' }] } }
  assert.match(suggestRequest(card, []).messages[0].content, /炼气、筑基/)
  assert.deepEqual(parseSuggestion('{"ranks":["炼气","筑基"]}', []).ranks, ['炼气', '筑基'])
  assert.equal('ranks' in parseSuggestion('{"ranks":[]}', []), false, 'none said leaves the player\'s own')
  const paths = [{ path: '主角.境界', kind: 'words' }, { path: '主角.等级', kind: 'number' }]
  assert.deepEqual(parseSuggestion('{"bindings":{"rank":"主角.境界","level":"主角.境界"}}', paths).bindings, { rank: '主角.境界' })
})

test('what cures works in a fight, on the worst of what holds the player back', () => {
  const sheet = { ...ailing(SPRAIN, { ...WEAK, size: 'heavy' }), things: [{ name: '解毒丹', count: 2 }] }
  const setup = battleSetup(sheet, { foes: fieldFoes([foe('boss', 0)]), seed: 's', effects: () => ({ type: 'cure' }) })
  assert.deepEqual(setup.player.modifiers, { body: -3, grace: -4, mind: -3 })
  const action = { kind: 'item', name: '解毒丹' }
  const { state, events } = step(startBattle(setup), action)
  assert.deepEqual(playerOf(state).modifiers, { body: 0, grace: -2, mind: 0 })
  assert.deepEqual(state.cured, ['重伤'])
  assert.ok(events.some(event => event.type === 'cure' && event.name === '重伤'))
  assert.deepEqual(startBattle(setup).cured, [], 'the fight it came from is as it was')
  assert.deepEqual(playerOf(startBattle(setup)).modifiers, { body: -3, grace: -4, mind: -3 })
  const { state: next } = step(state, action)
  assert.deepEqual(next.cured, ['重伤', '扭伤左脚'])
  assert.equal(refusal(next, action), 'unknown', 'none left')
})

test('with nothing to cure the thing stays in the bag', () => {
  const setup = battleSetup({ ...startSheet({}), things: [{ name: '解毒丹', count: 1 }] }, { foes: fieldFoes([foe('normal', 0)]), seed: 's', effects: () => ({ type: 'cure' }) })
  assert.equal(refusal(startBattle(setup), { kind: 'item', name: '解毒丹' }), 'nothing')
})

test('what was cured in a fight is gone from the sheet afterwards', () => {
  const sheet = { ...ailing(SPRAIN), things: [{ name: '解毒丹', count: 1 }] }
  const setup = battleSetup(sheet, { foes: fieldFoes([foe('minion', -2)]), seed: 's', effects: () => ({ type: 'cure' }) })
  const actions = [{ kind: 'item', name: '解毒丹' }]
  let state = step(startBattle(setup), actions[0]).state
  while (!state.over) {
    const action = { kind: 'attack', target: 'foe-0' }
    actions.push(action)
    state = step(state, action).state
  }
  const { op } = fightResult(setup, { over: 'won', attempt: 0, actions })
  assert.deepEqual(op.cured, ['扭伤左脚'])
  const after = applyOps(sheet, cleanRulebook({}), [op]).sheet
  assert.deepEqual(after.conditions, [])
  assert.deepEqual(after.things, [])
})

test('a condition wears off with the replies too, when the story never says what day it is', () => {
  let sheet = settleReply(startSheet({}), replyMarks('【异常|擦伤|体魄|轻】【异常|断臂|体魄|重】'))
  assert.deepEqual(sheet.conditions.map(item => [item.name, item.turns]), [['擦伤', 6], ['断臂', 30]])
  for (let i = 0; i < 5; i++) sheet = settleReply(sheet, [])
  assert.equal(sheet.conditions[0].turns, 1)
  assert.equal(sheet.conditions[0].days, 1, 'no day went by')
  sheet = settleReply(sheet, [])
  assert.deepEqual(sheet.conditions.map(item => item.name), ['断臂'])
  assert.equal(settleReply({ ...startSheet({}), conditions: [{ name: '旧', stat: '', size: 'heavy', days: 7 }] }, []).conditions[0].turns, 29, 'one kept before turns were counted')
})

test('a foe is worth what it took to beat', () => {
  const worth = gap => fightResult({ ...setupOf('minion', gap), foes: [{ name: '魔修', tier: 'minion', gap }] }, { over: 'won', attempt: 0, actions: winning(setupOf('minion', gap)) }).op.experience
  assert.equal(worth(0), 10)
  assert.ok(worth(-2) < worth(0))
  assert.ok(worth(1) > worth(0))
  assert.equal(rewardOf({ gap: 3 }), 4)
  assert.equal(rewardOf({}), 1)
})

function winning(setup) {
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    const action = { kind: 'attack', target: 'foe-0' }
    actions.push(action)
    state = step(state, action).state
  }
  assert.equal(state.over, 'won')
  return actions
}

test('the story can raise a rank, one at a time, on a card with a ladder it keeps to the rules', () => {
  const start = startSheet(cleanRulebook({ ranks: RANKS }))
  const up = word => settleReply(start, replyMarks(`【晋升|${word}】`), { ranks: RANKS })
  assert.equal(up('筑基').level, 5)
  assert.equal(up('筑基').experience, 0)
  assert.equal(up('筑基').points, 2)
  assert.equal(up('化神').level, 5, 'a rank at a time')
  assert.equal(up('筑基后期').level, 5, 'the most it can go at once')
  assert.equal(up('炼气').level, 1, 'no going down')
  assert.equal(up('不知道').level, 1)
  assert.equal(settleReply(start, replyMarks('【晋升|筑基】')).level, 1, 'no ladder')
  assert.equal(settleReply(start, replyMarks('【晋升|筑基】'), { ranks: RANKS, bound: ['rank'] }).level, 1, 'the card keeps it')
  assert.equal(settleReply(start, replyMarks('【晋升|筑基】'), { ranks: RANKS, bound: ['level'] }).level, 1)
  assert.equal(withoutGameMarks('你突破了。【晋升|筑基】'), '你突破了。')
})

const bag = (...names) => ({ ...startSheet({}), things: names.map(name => ({ name, count: 1 })) })

test('a roll says what helps it and what it cannot do without', () => {
  assert.deepEqual(gateOf('【检定|灵巧|DC12|绳索】'), { kind: 'check', stat: '灵巧', dc: 12, item: '绳索' })
  assert.deepEqual(gateOf('【检定|灵巧|DC12|绳索+2】'), { kind: 'check', stat: '灵巧', dc: 12, item: '绳索' }, 'how much is the rules\' to say')
  assert.deepEqual(gateOf('【检定|心智|DC14|需要:铜钥匙】'), { kind: 'check', stat: '心智', dc: 14, needs: '铜钥匙' })
  assert.deepEqual(gateOf('【检定|心智|DC14|需要：铜钥匙|灯笼】'), { kind: 'check', stat: '心智', dc: 14, item: '灯笼', needs: '铜钥匙' })
  assert.deepEqual(cleanCheck({ stat: '灵巧', dc: 12, item: ' 绳索 ', needs: 3 }), { stat: '灵巧', dc: 12, item: '绳索' })
})

test('a thing in the bag helps a roll, and one that is not does nothing', () => {
  const book = cleanRulebook({})
  const check = { stat: '灵巧', dc: 12, item: '绳索' }
  assert.deepEqual(aidFor(bag('绳索'), check), { aid: '绳索', lacks: '' })
  assert.deepEqual(aidFor(bag('麻绳索'), check), { aid: '麻绳索', lacks: '' }, 'by a name close to it')
  assert.deepEqual(aidFor(bag('干粮'), check), { aid: '', lacks: '' })
  assert.equal(chanceFor(bag('绳索'), book, check), chanceFor(bag(), book, { stat: '灵巧', dc: 12 }) + AID_BONUS * 5)
  const roll = rollCheck(bag('绳索'), book, check, 's')
  assert.deepEqual(roll.aid, { name: '绳索', by: AID_BONUS })
  assert.equal(roll.modifier, AID_BONUS)
  assert.equal(rollCheck(bag('绳索'), book, check, 's').roll, rollCheck(bag(), book, check, 's').roll, 'the same die either way')
  assert.equal('aid' in rollCheck(bag(), book, check, 's'), false)
})

test('without what it cannot do without, a roll fails whatever the die says', () => {
  const book = cleanRulebook({})
  const check = { stat: '心智', dc: 5, needs: '铜钥匙' }
  assert.equal(chanceFor(bag(), book, check), 0)
  const tiers = Array.from({ length: 40 }, (_, i) => rollCheck(bag(), book, check, `s${i}`))
  assert.ok(tiers.every(roll => roll.tier === 'fail' && roll.lacks === '铜钥匙'))
  assert.ok(chanceFor(bag('铜钥匙'), book, check) > 0)
  assert.equal('lacks' in rollCheck(bag('铜钥匙'), book, check, 's'), false)
  assert.match(checkLine(tiers[0]), /缺铜钥匙/)
})

test('the model hears of the bag on a roll, and of raising a rank only where it can', () => {
  assert.match(turn({}, []).text, /需要:铜钥匙/)
  const told = result => turn({ check: { stat: '灵巧', roll: 9, modifier: 2, total: 11, dc: 12, tier: 'close', ...result } }).text
  assert.match(told({ aid: { name: '绳索', by: 2 } }), /用上了绳索/)
  assert.match(told({ lacks: '铜钥匙', tier: 'fail' }), /缺铜钥匙，做不到/)
  assert.match(turn({ ranks: RANKS }, []).text, /【晋升\|等级】/)
  assert.doesNotMatch(turn({}, []).text, /晋升/)
  assert.doesNotMatch(turn({ ranks: RANKS, bound: ['rank'] }, []).text, /晋升/, 'the card keeps it')
})
