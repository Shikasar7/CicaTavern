// What was left of 成长 and 玩法模块: 里程碑 → 奖励 (what each kind of step brings), the player's own type, a chain of
// 形态 for a foe that is tamed, a form lost when its energy runs out, and what the models are asked for of 形态.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHIFT_UPKEEP, autoCommands, playerOf, skillsOf, startBattle, step } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult } from '../web/shared/game/encounter.js'
import { bondPointsOf, cleanForms, cleanGrowth, everyGives, formOf, formReady, formsAsk, levelPointsOf, modulesAsk, rankRestores } from '../web/shared/game/growth.js'
import { alliesFor, applyOps, cleanKit, cleanRulebook, grownSheet, kitBook, levelNeeds, sheetOf, typesFor } from '../web/shared/game/sheet.js'
import { suggestRequest } from '../server/game.mjs'

const TYPES = { 火: ['草'], 草: ['水'], 水: ['火'] }
const book = (more = {}) => cleanRulebook({
  level: 'full',
  growth: { level: 'standard' },
  skills: { 强击: 'strike', 水枪: 'strike' },
  start: { skills: ['强击', '水枪'], things: [], party: ['小焰'] },
  companions: { 小焰: { attributes: { body: 14 }, skills: { 火花: 'strike' }, type: '火' } },
  foes: { 藤蔓怪: { looks: 'vine monster', moves: ['缠绕', '鞭打'], type: '草' } },
  ...more,
})
const at = (rules, more = {}) => ({ ...sheetOf(rules, null, {}), ...more })
const won = (experience, more = {}) => ({ op: 'battle', over: 'won', life: 50, energy: 5, used: {}, experience, ...more })
/** The experience that takes one from level 1 to `level`, and no further. */
const upTo = (level, rules) => Array.from({ length: level - 1 }, (_, i) => levelNeeds(i + 1, rules)).reduce((sum, need) => sum + need, 0)

// ── 里程碑 → 奖励 ─────────────────────────────────────────────────────
test('a card says what each step of growing brings; said nothing, or the usual, nothing is kept', () => {
  assert.deepEqual(cleanGrowth({ level: 'standard' }), { level: 'standard' })
  assert.deepEqual(cleanGrowth({ level: 'standard', levelPoints: 2, everyPoints: 0, everyRestore: false, rankRestore: true, bondPoints: 0 }), { level: 'standard' })
  assert.deepEqual(cleanGrowth({ level: 'standard', levelPoints: 9, everyPoints: 9, everyRestore: true, rankRestore: false, bondPoints: 9 }), { level: 'standard', levelPoints: 4, everyPoints: 4, everyRestore: true, rankRestore: false, bondPoints: 2 })
  // None a level is what `points: false` always was, whichever way it is said.
  assert.deepEqual(cleanGrowth({ level: 'standard', levelPoints: 0 }), { level: 'standard', points: false })
  assert.deepEqual(cleanGrowth({ level: 'standard', points: false, levelPoints: 3 }), { level: 'standard', points: false })
  const usual = book()
  assert.equal(levelPointsOf(usual), 2)
  assert.deepEqual(everyGives(usual), { points: 0, restore: false })
  assert.equal(rankRestores(usual), true)
  assert.equal(bondPointsOf(usual), 0)
  assert.equal(levelPointsOf(book({ growth: { level: 'standard', points: false } })), 0)
  assert.equal(levelPointsOf({ level: 'full', growth: { level: 'off', levelPoints: 4 } }), 2, 'a card that does not count growth is as it was')
})

test('a level brings the points the card says, every few levels theirs on top, and makes whole where the card says so', () => {
  const plain = book()
  const rich = book({ growth: { level: 'standard', levelPoints: 3, everyPoints: 2, everyRestore: true } })
  const hurt = rules => at(rules, { life: 10, energy: 1 })
  // To level 3: two levels, and the third is one of the "every 3".
  const usual = applyOps(hurt(plain), plain, [won(upTo(3, plain), { life: 10 })]).sheet
  assert.equal(usual.level, 3)
  assert.equal(usual.points, 4)
  assert.ok(usual.life < usual.maxLife)
  const more = applyOps(hurt(rich), rich, [won(upTo(3, rich), { life: 10 })]).sheet
  assert.equal(more.level, 3)
  assert.equal(more.points, 2 * 3 + 2)
  assert.equal(more.life, more.maxLife, 'whole again at the third level')
  // To level 2 only: the points of one level, and not whole.
  const one = applyOps(hurt(rich), rich, [won(upTo(2, rich), { life: 10 })]).sheet
  assert.equal(one.points, 3)
  assert.ok(one.life < one.maxLife)
})

test('a 突破 need not make whole, and a step of 羁绊 may bring a companion points', () => {
  const ranks = ['凡人', '觉醒者']
  const keeps = book({ ranks, growth: { level: 'standard', rankRestore: false } })
  const fills = book({ ranks })
  const cross = rules => applyOps(at(rules, { life: 10 }), rules, [won(upTo(5, rules) + 1, { life: 10 })]).sheet
  assert.ok(cross(fills).level > 4)
  assert.equal(cross(fills).life, cross(fills).maxLife)
  assert.ok(cross(keeps).life < cross(keeps).maxLife)
  // 羁绊: the third fight won together is the first step.
  const bonds = book({ growth: { level: 'standard', bondPoints: 2 } })
  let sheet = at(bonds)
  const beside = { party: [{ name: '小焰', life: 40 }] }
  for (let i = 0; i < 2; i++) sheet = applyOps(sheet, bonds, [won(0, beside)]).sheet
  assert.equal(sheet.party[0].points ?? 0, 0)
  sheet = applyOps(sheet, bonds, [won(0, beside)]).sheet
  assert.equal(sheet.party[0].bond, 3)
  assert.equal(sheet.party[0].points, 2)
  let plain = at(book())
  for (let i = 0; i < 3; i++) plain = applyOps(plain, book(), [won(0, beside)]).sheet
  assert.equal(plain.party[0].points ?? 0, 0)
})

// ── 玩家自己的类型 ────────────────────────────────────────────────────
test('the player may be of a type of the card\'s: their blows and what they take are moved by it, and a form come to for good may change it', () => {
  assert.equal(book({ types: TYPES, selfType: '水' }).selfType, '水')
  assert.equal(book({ types: TYPES, selfType: '风' }).selfType, undefined)
  assert.equal(book({ selfType: '水' }).selfType, undefined, 'no types, no type')
  const rules = book({ types: TYPES, selfType: '水', forms: { 玩家: [{ name: '人' }, { name: '炎魔', type: '火', at: { level: 2 }, effects: [] }] } })
  assert.equal(typesFor(rules, at(rules)).player, '水')
  assert.equal(typesFor(rules, at(rules, { form: '炎魔' })).player, '火')
  assert.equal(typesFor(book({ types: TYPES }), at(book())).player, undefined)
  const setup = encounterSetup(at(rules), rules, { foes: [{ name: '藤蔓怪', count: 1, tier: 'normal' }] }, 'c', 'n')
  assert.equal(setup.player.type, '水')
  // Water against grass is the weaker: the blow says so.
  const { events } = step(startBattle(setup), [{ who: 'player', kind: 'attack', target: 'foe-0' }, { who: 'ally-0', kind: 'guard' }])
  assert.equal(events.find(event => event.type === 'hit' && event.by === 'player')?.edge, 'weak')
  // A card's layout by a model carries it.
  const made = kitBook(cleanKit({ types: TYPES, selfType: '火', skills: [{ name: '强击', kind: 'strike' }] }))
  assert.equal(made.selfType, '火')
  assert.match(modulesAsk(), /"selfType"/)
})

// ── 收服来的同伴的形态 ────────────────────────────────────────────────
test('a foe that is tamed grows along the chain the card has under its name', () => {
  const rules = book({ tame: true, types: TYPES, forms: { 藤蔓怪: [{ name: '藤蔓怪' }, { name: '荆棘王', type: '火', at: { level: 2 }, effects: [{ id: 'attack', size: 'medium' }], skills: { 荆棘风暴: 'sweep' } }] } })
  assert.deepEqual(Object.keys(rules.forms), ['藤蔓怪'])
  const joined = applyOps(at(rules), rules, [won(0, { tamed: '藤蔓怪' })]).sheet
  const vine = joined.party.find(member => member.name === '藤蔓怪')
  assert.equal(vine.tamed, true)
  assert.equal(formOf(vine, rules).name, '藤蔓怪')
  assert.equal(formReady({ ...vine, level: 1 }, rules), null)
  assert.equal(formReady({ ...vine, level: 2 }, rules)?.name, '荆棘王')
  // Come to it: its skills are theirs, and its type takes the place of the one they were caught with.
  const grown = grownSheet({ ...joined, party: joined.party.map(member => (member.name === '藤蔓怪' ? { ...member, level: 2, form: '荆棘王', bench: false } : { ...member, bench: true })) }, rules)
  const ally = alliesFor(grown, rules).find(member => member.name === '藤蔓怪')
  assert.ok(ally.skills.includes('荆棘风暴'))
  assert.equal(ally.type, '火')
  assert.equal(ally.shown, '荆棘王')
})

// ── 能量耗尽 ──────────────────────────────────────────────────────────
test('a form that feeds on energy takes its share each round after the first, and is lost in the fight when there is none left', () => {
  assert.equal(cleanForms({ 玩家: [{ name: '人' }, { name: '甲', temp: true, drain: true }] })['@player'][1].drain, true)
  assert.equal(cleanForms({ 玩家: [{ name: '人' }, { name: '甲', at: { level: 3 }, drain: true }] })['@player'][1].drain, undefined, 'only one taken for a fight')
  const rules = book({ start: { skills: ['强击'], things: [] }, forms: { 玩家: [{ name: '人' }, { name: '装甲形态', temp: true, drain: true, effects: [{ id: 'attack', size: 'large' }], skills: { 光束炮: 'strike' } }] } })
  const setup = encounterSetup(at(rules), rules, { foes: [{ name: '铁傀儡', count: 1, tier: 'boss' }] }, 'c', 'drain')
  assert.equal(setup.player.shift.drain, true)
  let state = startBattle(setup)
  const before = skillsOf(state, playerOf(state)).map(skill => skill.name)
  let done = step(state, [{ who: 'player', kind: 'shift' }])
  state = done.state
  assert.equal(playerOf(state).shifted, '装甲形态')
  assert.ok(skillsOf(state, playerOf(state)).some(skill => skill.name === '光束炮'))
  assert.equal(done.events.some(event => event.type === 'upkeep'), false, 'not in the round it was taken')
  const left = playerOf(state).energy
  const cost = Math.ceil(playerOf(state).maxEnergy * SHIFT_UPKEEP)
  done = step(state, [{ who: 'player', kind: 'attack', target: 'foe-0' }])
  state = done.state
  assert.equal(done.events.find(event => event.type === 'upkeep')?.amount, cost)
  assert.equal(playerOf(state).energy, left - cost)
  // With nothing left to feed it, they are back as they were, and the story still hears of the form.
  const actions = [[{ who: 'player', kind: 'shift' }], [{ who: 'player', kind: 'attack', target: 'foe-0' }]]
  let reverted = null
  for (let i = 0; i < 20 && !state.over && !reverted; i++) {
    const command = [{ who: 'player', kind: 'attack', target: 'foe-0' }]
    actions.push(command)
    done = step(state, command)
    state = done.state
    reverted = done.events.find(event => event.type === 'revert') ?? null
  }
  if (!state.over) {
    assert.equal(reverted?.name, '装甲形态')
    assert.equal(playerOf(state).shifted, undefined)
    assert.deepEqual(skillsOf(state, playerOf(state)).map(skill => skill.name), before)
    assert.equal(playerOf(state).bonus?.attack ?? 0, setup.player.bonus?.attack ?? 0)
  }
  // Played out by 自动 to its end, the result names the form whether or not it lasted.
  while (!state.over && actions.length < 80) {
    const commands = autoCommands(state)
    actions.push(commands)
    state = step(state, commands).state
  }
  assert.deepEqual(fightResult(setup, { over: state.over, actions }).battle.shifted, [{ form: '装甲形态' }])
  // A form that does not feed on energy is kept to the end, as before.
  const steady = book({ start: { skills: ['强击'], things: [] }, forms: { 玩家: [{ name: '人' }, { name: '装甲形态', temp: true, effects: [] }] } })
  let other = step(startBattle(encounterSetup(at(steady), steady, { foes: [{ name: '铁傀儡', count: 1, tier: 'boss' }] }, 'c', 'steady')), [{ who: 'player', kind: 'shift' }]).state
  for (let i = 0; i < 6 && !other.over; i++) {
    const turn = step(other, [{ who: 'player', kind: 'attack', target: 'foe-0' }])
    assert.equal(turn.events.some(event => event.type === 'upkeep' || event.type === 'revert'), false)
    other = turn.state
  }
})

// ── 给模型的话 ────────────────────────────────────────────────────────
test('who lays out a card\'s rules is told what a form is and is not, and of the kind of story where one changes for a fight', () => {
  const asked = formsAsk()
  assert.match(asked, /只升不降[\s\S]*不是形态[\s\S]*ranks/)
  assert.match(asked, /"temp": true 并且不写 at/)
  assert.match(asked, /"drain": true/)
  assert.match(asked, /能收服的敌人/)
  // 进化 is no longer the first word a model reads of them.
  assert.ok(asked.indexOf('变身') < asked.indexOf('进化'))
  const request = suggestRequest({ description: '一个故事' }, []).messages[0].content
  assert.match(request, /hero/)
  assert.match(request, /变身或机甲/)
})

// ── 连着两个战斗形态 ──────────────────────────────────────────────────
test('a second form for a fight only, right after the first, is taken from it in the same fight, and not from where they began', () => {
  const rules = book({ start: { skills: ['强击'], things: [] }, forms: { 玩家: [{ name: '人' }, { name: '苍刃', temp: true, effects: [{ id: 'attack', size: 'small' }], skills: { 苍刃斩: 'strike' } }, { name: '苍刃·解放', temp: true, drain: true, effects: [{ id: 'attack', size: 'large' }], skills: { 终式: 'finish' } }] } })
  const setup = encounterSetup(at(rules), rules, { foes: [{ name: '铁傀儡', count: 1, tier: 'boss' }] }, 'c', 'two')
  assert.equal(setup.player.shift.name, '苍刃')
  assert.equal(setup.player.shift.then.name, '苍刃·解放')
  assert.deepEqual(setup.player.shift.then.skills.map(skill => skill.name), ['强击', '终式'], 'the first form\'s own skill goes with it')
  let state = step(startBattle(setup), [{ who: 'player', kind: 'shift' }]).state
  assert.equal(playerOf(state).shifted, '苍刃')
  assert.equal(playerOf(state).shift.name, '苍刃·解放')
  // With the energy for it, the second is theirs to take; it feeds on energy, and what they come back to is how they began.
  state = { ...state, units: undefined, ...JSON.parse(JSON.stringify(state)) }
  playerOf(state).energy = playerOf(state).maxEnergy
  const done = step(state, [{ who: 'player', kind: 'shift' }])
  assert.equal(playerOf(done.state).shifted, '苍刃·解放')
  assert.equal(playerOf(done.state).shift, undefined)
  assert.ok(skillsOf(done.state, playerOf(done.state)).some(skill => skill.name === '终式'))
  assert.deepEqual(playerOf(done.state).back.skills.map(skill => skill.name), ['强击', '苍刃斩'])
})

// ── 创作角色卡写出来的 ────────────────────────────────────────────────
test('a card laid out by a model keeps its 形态, types, the player\'s own type, who fights and 收服 all the way into its rule book', () => {
  const kit = cleanKit({
    skills: [{ name: '重拳', kind: 'strike' }],
    foes: [{ name: '蚀影', looks: 'shadow', moves: ['撕咬'], type: '暗' }],
    companions: [{ name: '小焰', skills: [{ name: '火花', kind: 'strike' }], start: true }],
    types: { 光: ['暗'], 暗: ['光'] },
    selfType: '光',
    lead: 'command',
    tame: true,
    forms: { 玩家: [{ name: '学生' }, { name: '苍刃', temp: true, drain: true, type: '光', effects: [{ id: 'attack', size: 'medium' }] }], 蚀影: [{ name: '蚀影' }, { name: '蚀影王', at: { level: 5 } }] },
  })
  // What server/forge/write.mjs makes of a plan's `game` (planRulebook).
  const made = cleanRulebook({ level: 'full', ...kitBook(kit) })
  assert.deepEqual(Object.keys(made.forms), ['@player', '蚀影'])
  assert.equal(made.forms['@player'][1].drain, true)
  assert.equal(made.selfType, '光')
  assert.equal(made.lead, 'command')
  assert.equal(made.tame, true)
  assert.equal(made.foes.蚀影.type, '暗')
})
