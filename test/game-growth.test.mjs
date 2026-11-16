// 成长 (plans/16): one table of effects, and the sources that give them: a level, a skill's use, a 天赋. What a card
// that does not count growth does is what it did before: the other game tests hold that, with growth off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alliesOf, battleSetup, fieldFoes, foeSheets, playerOf, simulate, skillCost, skillsOf, startBattle, step } from '../web/shared/game/battle.js'
import { beneath, encounterSetup, fightResult, playedOut, worthOf } from '../web/shared/game/encounter.js'
import { foesFollow, usualGrowth } from '../web/shared/game/growth.js'
import { BUILTIN_PERKS, EFFECTS, EFFECT_IDS, MAX_PERKS, PERK_BUDGET, SKIP_POINTS, bonusOf, canTake, checkBonus, cleanEffects, cleanGrowth, cleanPerks, fightBonus, growsOn, growthOf, nextStageAt, perkFor, perkOf, perkOffer, perksAsk, perksOn, perksOwed, skillGrowth, stageOf } from '../web/shared/game/growth.js'
import { applyOps, chanceFor, cleanKit, cleanOps, cleanRulebook, grownSheet, keptSheet, kitBook, levelNeeds, playerGrowth, rollCheck, settleReply, sheetOf, startSheet } from '../web/shared/game/sheet.js'
import { replyMarks } from '../web/shared/game/marks.js'
import { gamePrompt, parseSuggestion, suggestRequest } from '../server/game.mjs'

const OWN = [
  { name: '踏雪无痕', note: '身法轻', effects: [{ id: 'speed', size: 'medium' }, { id: 'flee', size: 'small' }] },
  { name: '金钟罩', note: '护体', effects: [{ id: 'guard', size: 'medium' }, { id: 'life', size: 'small' }] },
  { name: '舍身剑意', note: '以伤换伤', effects: [{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small', minus: true }] },
]
const book = (level, more = {}) => cleanRulebook({ level: 'full', ...(level ? { growth: { level } } : {}), start: { skills: ['破风斩'], party: ['苏挽霜'] }, companions: { 苏挽霜: { attributes: { grace: 16 }, skills: { 霜落: 'strike' } } }, ...more })
const OFF = book(null)
const STANDARD = book('standard')
const RICH = book('rich', { perks: OWN })
const at = (sheet, level) => ({ ...sheet, level })
const reread = (rules, sheet) => sheetOf(rules, keptSheet(sheet), {})

test('how far a card takes growth: only the full rules have it, and one that says nothing has none', () => {
  assert.equal(growthOf(OFF), 'off')
  assert.equal(growthOf(STANDARD), 'standard')
  assert.equal(growthOf(RICH), 'rich')
  assert.equal(growthOf({ level: 'light', growth: { level: 'rich' } }), 'off', 'no levels, nothing to grow by')
  assert.ok(growsOn(STANDARD) && !perksOn(STANDARD) && perksOn(RICH))
  assert.equal(cleanGrowth({ level: 'off' }), null)
  assert.equal(cleanGrowth({ level: 'much' }), null)
  assert.deepEqual(cleanGrowth({ level: 'rich', companions: 'manual', more: 1 }), { level: 'rich', companions: 'manual' })
  assert.equal(OFF.growth, undefined)
  assert.equal(OFF.perks, undefined, 'a book without them is as it was')
  assert.equal(cleanRulebook({ ...RICH, growth: { level: 'off' } }).growth, undefined, 'turned off, it is gone')
})

test('effects are kept only as the table has them, within the budget', () => {
  assert.deepEqual(cleanEffects([{ id: 'attack', size: 'medium' }]), [{ id: 'attack', size: 'medium' }])
  assert.deepEqual(cleanEffects([{ id: 'teleport', size: 'huge' }]), [], 'one the rules do not know')
  assert.deepEqual(cleanEffects([{ id: 'attack' }]), [{ id: 'attack', size: 'medium' }], 'a size not said is medium')
  assert.deepEqual(cleanEffects([{ id: 'first', size: 'large', minus: true }]), [{ id: 'first' }], 'had or not: no size, no drawback')
  assert.deepEqual(cleanEffects([{ id: 'check', size: 'small' }]), [], 'a check must say which attribute')
  assert.deepEqual(cleanEffects([{ id: 'check', size: 'small', on: 'mind' }]), [{ id: 'check', size: 'small', on: 'mind' }])
  assert.deepEqual(cleanEffects([{ id: 'hone', size: 'small', on: '破风斩' }]), [{ id: 'hone', size: 'small', on: '破风斩' }])
  // Over the budget: the last becomes smaller, then goes.
  assert.deepEqual(cleanEffects([{ id: 'attack', size: 'large' }, { id: 'life', size: 'large' }]), [{ id: 'attack', size: 'large' }])
  assert.deepEqual(cleanEffects([{ id: 'attack', size: 'medium' }, { id: 'life', size: 'large' }]), [{ id: 'attack', size: 'medium' }, { id: 'life', size: 'small' }])
  // A drawback gives half of its own back, and alone it is nothing.
  assert.deepEqual(cleanEffects([{ id: 'attack', size: 'large' }, { id: 'guard', size: 'small', minus: true }, { id: 'crit', size: 'small' }]).length, 2)
  assert.deepEqual(cleanEffects([{ id: 'guard', size: 'small', minus: true }]), [])
  assert.deepEqual(cleanEffects([{ id: 'attack', size: 'small' }, { id: 'attack', size: 'small' }]), [{ id: 'attack', size: 'small' }], 'no two of a kind')
  assert.deepEqual(cleanEffects('nonsense'), [])
})

test('a card\'s own 天赋 survive whatever a model wrote', () => {
  const perks = cleanPerks([...OWN, { name: '写坏了的', effects: [{ id: 'teleport' }] }, { name: '铁布衫', effects: 'x' }, { name: '踏雪无痕', effects: [] }, { name: '', effects: [] }, { name: '#iron', effects: [{ id: 'attack' }] }, 'x', { name: '后招', needs: '舍身剑意', effects: [{ id: 'crit', size: 'small' }] }, { name: '空想', needs: '没有的', effects: [{ id: 'crit', size: 'small' }] }])
  assert.deepEqual(perks.map(perk => perk.name), ['踏雪无痕', '金钟罩', '舍身剑意', '铁布衫', '后招', '空想'])
  assert.deepEqual(perks[3].effects, [{ id: 'guard', size: 'small' }], 'effects that cannot be read: a small one its name suggests')
  assert.equal(perks[4].needs, '舍身剑意')
  assert.equal(perks[5].needs, undefined, 'one that asks for another the card has not')
  assert.equal(cleanPerks(Array.from({ length: 30 }, (_, i) => ({ name: `招${i}`, effects: [{ id: 'attack' }] }))).length, MAX_PERKS)
  assert.deepEqual(cleanPerks(null), [])
  assert.deepEqual(RICH.perks, OWN)
})

test('every 天赋 the rules bring is within the budget, and a model is told of every effect there is', () => {
  for (const perk of BUILTIN_PERKS) assert.deepEqual(cleanEffects(perk.effects, perk.big ? 4 : PERK_BUDGET), perk.effects, perk.id)
  assert.equal(new Set(BUILTIN_PERKS.map(perk => perk.id)).size, BUILTIN_PERKS.length)
  const ask = perksAsk()
  for (const id of EFFECT_IDS) assert.ok(ask.includes(`${id}（`), id)
  assert.ok(ask.includes(String(PERK_BUDGET)))
  assert.ok(suggestRequest({ description: '一个剑客' }, []).messages[0].content.includes(ask))
  for (const [id, rule] of Object.entries(EFFECTS)) assert.ok(rule.sizes ? rule.sizes.length === 3 && rule.most > 0 : rule.cost > 0, id)
})

test('what one has from growing: a level by itself, and the 天赋 on top, each up to its most', () => {
  const none = bonusOf({ level: 9, perks: ['#iron'] }, OFF)
  assert.ok(Object.values(none).every(value => (typeof value === 'object' ? !Object.keys(value).length : !value)), 'a card that does not count growth')
  const level = bonusOf({ level: 6 }, STANDARD)
  assert.ok(Math.abs(level.life - 0.1) < 1e-9)
  assert.equal(level.energy, 2)
  assert.equal(bonusOf({ level: 6, perks: ['#iron'] }, STANDARD).guard, 0, '天赋 are the rich level\'s')
  const rich = bonusOf({ level: 1, perks: ['#iron', '金钟罩', '舍身剑意', '#swift', '#undying', '#insight', '#adept'] }, RICH)
  assert.ok(Math.abs(rich.guard - (EFFECTS.guard.sizes[1] * 2 - EFFECTS.guard.sizes[0])) < 1e-9, 'a drawback takes away')
  assert.equal(rich.attack, EFFECTS.attack.sizes[2])
  assert.ok(rich.first && rich.stand)
  assert.deepEqual(rich.check, { mind: 2 })
  assert.deepEqual(rich.hone, { '': EFFECTS.hone.sizes[0] })
  const many = bonusOf({ level: 1, perks: ['a', 'b', 'c', 'd', 'e', 'f'] }, cleanRulebook({ level: 'full', growth: { level: 'rich' }, perks: 'abcdef'.split('').map(name => ({ name, effects: [{ id: 'crit', size: 'large' }] })) }))
  assert.equal(many.crit, EFFECTS.crit.most, 'no more than the most, however many give it')
  assert.equal(bonusOf({ level: 1, perks: ['gone'] }, RICH).attack, 0, 'one the card no longer has gives nothing')
  assert.equal(checkBonus({ level: 1, perks: ['#insight'] }, RICH, 'mind'), 2)
  assert.equal(checkBonus({ level: 1, perks: ['#insight'] }, RICH, 'body'), 0)
  assert.equal(checkBonus({ level: 1, perks: ['#insight'] }, RICH, null), 0)
})

test('a level makes more life and energy, at once, and the same however often it is read', () => {
  const start = sheetOf(STANDARD, null, {})
  assert.equal(start.maxLife, 100)
  assert.deepEqual(start.grew, { life: 100, energy: 30 })
  const hurt = { ...start, life: 60 }
  const up = reread(STANDARD, at(hurt, 6))
  assert.equal(up.maxLife, 110)
  assert.equal(up.life, 70, 'what was added is theirs at once')
  assert.equal(up.maxEnergy, 32)
  assert.deepEqual(reread(STANDARD, up), up, 'read again, the same')
  assert.equal(up.party[0].maxLife, 100, 'a companion grows by their own level')
  assert.equal(reread(STANDARD, { ...up, party: [{ ...up.party[0], level: 11 }] }).party[0].maxLife, 120)
  // Turned off again, the numbers are the card's own once more.
  const back = reread(OFF, up)
  assert.equal(back.maxLife, 100)
  assert.equal(back.life, 70)
  assert.equal(back.maxEnergy, 30)
  assert.equal(back.grew, undefined)
  assert.equal(back.party[0].grew, undefined)
  assert.deepEqual(sheetOf(OFF, null, {}).grew, undefined, 'never on, nothing kept')
})

test('life the card keeps itself is the card\'s to say, and what growth would have added is taken off a foe\'s blows', () => {
  const bound = cleanRulebook({ ...STANDARD, bindings: { life: 'hp', maxLife: 'maxHp' } })
  const sheet = sheetOf(bound, { ...keptSheet(sheetOf(bound, null, { hp: 4000, maxHp: 5000 })), level: 11 }, { hp: 4000, maxHp: 5000 })
  assert.equal(sheet.maxLife, 5000)
  assert.equal(sheet.life, 4000)
  assert.equal(sheet.maxEnergy, 35, 'energy is still the rules\'')
  assert.ok(Math.abs(playerGrowth(sheet, bound).bonus.tough - 1.2) < 1e-9)
})

test('天赋: one every three levels, three to choose from that stay the same, taken or passed over', () => {
  const sheet = sheetOf(RICH, null, {})
  assert.equal(perksOwed(sheet, RICH), 0)
  assert.equal(perksOwed(at(sheet, 7), STANDARD), 0, 'the standard level has none')
  const six = at(sheet, 7)
  assert.equal(perksOwed(six, RICH), 2)
  const offer = perkOffer(six, RICH, 'chat')
  assert.equal(offer.length, 3)
  assert.deepEqual(perkOffer(six, RICH, 'chat'), offer, 'the same three again')
  assert.notDeepEqual(perkOffer(six, RICH, 'other').map(perk => perk.key), offer.map(perk => perk.key))
  assert.equal(offer.filter(perk => perk.own).length, 2, 'the card\'s own first, one of every card\'s among them')
  assert.ok(canTake(six, RICH, '踏雪无痕') && canTake(six, RICH, '#iron'))
  assert.ok(!canTake(six, RICH, '没有的') && !canTake(sheet, RICH, '#iron'))
  const took = applyOps(six, RICH, cleanOps([{ op: 'perk', key: '踏雪无痕', label: 'x' }]))
  assert.deepEqual(took.sheet.perks, ['踏雪无痕'])
  assert.deepEqual(took.lines, ['玩家有了新的天赋「踏雪无痕」'])
  assert.equal(perksOwed(took.sheet, RICH), 1)
  assert.equal(applyOps(took.sheet, RICH, cleanOps([{ op: 'perk', key: '踏雪无痕' }])).dropped.length, 1, 'not twice')
  assert.notDeepEqual(perkOffer(took.sheet, RICH, 'chat').map(perk => perk.key), offer.map(perk => perk.key), 'the next three are new')
  const passed = applyOps(took.sheet, RICH, cleanOps([{ op: 'perk', skip: true }]))
  assert.equal(passed.sheet.points, (took.sheet.points ?? 0) + SKIP_POINTS)
  assert.equal(perksOwed(passed.sheet, RICH), 0)
  assert.equal(applyOps(passed.sheet, RICH, cleanOps([{ op: 'perk', skip: true }])).dropped.length, 1, 'none owed, none passed over')
  assert.deepEqual(cleanOps([{ op: 'perk' }, { op: 'perk', key: ' ' }]), [])
  assert.equal(perkOf(RICH, '#iron').name, '铁骨')
  assert.equal(perkOf(RICH, '金钟罩').own, true)
  assert.equal(perkOf(RICH, '#nope'), null)
  // One that asks for another is not offered until that one is had.
  const tree = cleanRulebook({ ...RICH, perks: [...OWN, { name: '后招', needs: '舍身剑意', effects: [{ id: 'crit', size: 'small' }] }] })
  assert.ok(!canTake(six, tree, '后招'))
  assert.ok(canTake({ ...six, perks: ['舍身剑意'] }, tree, '后招'))
})

test('a companion\'s 天赋 are chosen for them, by what they are best at, unless the card leaves it to the player', () => {
  const sheet = sheetOf(RICH, null, {})
  const grown = reread(RICH, { ...sheet, party: [{ ...sheet.party[0], level: 6 }] })
  assert.deepEqual(grown.party[0].perks, ['踏雪无痕', '#swift'], 'grace is what she has: the card\'s own first')
  assert.equal(perksOwed(grown.party[0], RICH), 0)
  assert.equal(perkFor({ level: 3, attributes: { body: 16, grace: 10, mind: 10, charm: 10 } }, RICH), '金钟罩')
  const manual = cleanRulebook({ ...RICH, growth: { level: 'rich', companions: 'manual' } })
  const left = reread(manual, { ...sheet, party: [{ ...sheet.party[0], level: 6 }] })
  assert.equal(left.party[0].perks, undefined)
  assert.equal(perksOwed(left.party[0], manual), 2)
  const chosen = applyOps(left, manual, cleanOps([{ op: 'perk', key: '金钟罩', who: '苏挽霜' }]))
  assert.deepEqual(chosen.sheet.party[0].perks, ['金钟罩'])
  assert.deepEqual(chosen.lines, ['苏挽霜有了新的天赋「金钟罩」'])
  assert.equal(chosen.sheet.party[0].maxLife, Math.round(100 * (1 + 0.02 * 5 + EFFECTS.life.sizes[0])), 'felt at once')
  assert.equal(applyOps(left, manual, cleanOps([{ op: 'perk', key: '金钟罩', who: '路人' }])).dropped.length, 1)
})

test('熟练: a skill used often enough comes further, hits harder and then costs less', () => {
  assert.deepEqual([0, 4, 5, 14, 15, 30, 50, 999].map(stageOf), [1, 1, 2, 2, 3, 4, 5, 5])
  assert.equal(stageOf(undefined), 1)
  assert.equal(nextStageAt(7), 15)
  assert.equal(nextStageAt(50), null)
  assert.deepEqual(skillGrowth({ mastery: { 破风斩: 99 } }, OFF, ['破风斩']), {})
  assert.deepEqual(skillGrowth({ mastery: {} }, STANDARD, ['破风斩']), {}, 'not yet used: as it was')
  const grown = skillGrowth({ level: 1, mastery: { 破风斩: 15 } }, STANDARD, ['破风斩', '横扫'])
  assert.deepEqual(grown, { 破风斩: { power: 1.06, cost: 0.9, stage: 3 } })
  const honed = skillGrowth({ level: 1, perks: ['#adept'], mastery: {} }, RICH, ['破风斩'], { 破风斩: 'strike' })
  assert.deepEqual(honed, { 破风斩: { power: 1.1, cost: 0.9 } })
  const byKind = cleanRulebook({ ...RICH, perks: [{ name: '剑心', effects: [{ id: 'hone', size: 'large', on: 'strike' }] }] })
  assert.equal(skillGrowth({ perks: ['剑心'] }, byKind, ['破风斩', '回风'], { 破风斩: 'strike', 回风: 'sweep' }).回风, undefined)
  assert.equal(skillGrowth({ perks: ['剑心'] }, byKind, ['破风斩'], { 破风斩: 'strike' }).破风斩.power, 1.3)
})

test('a fight is set up as it always was with growth off, and with what growth gives when it is on', () => {
  const gate = { foes: [{ name: '狼', count: 1, tier: 'elite' }] }
  const plain = encounterSetup(sheetOf(OFF, null, {}), OFF, gate, 'c', 'n')
  assert.equal(plain.grows, undefined)
  assert.equal(plain.player.bonus, undefined)
  assert.deepEqual(plain.player.skills, [{ name: '破风斩', kind: 'strike' }])
  assert.equal(plain.allies[0].bonus, undefined)
  const first = encounterSetup(sheetOf(RICH, null, {}), RICH, gate, 'c', 'n')
  assert.equal(first.grows, true)
  const { grows, met, ...same } = first
  assert.deepEqual(same, plain, 'at the first level there is nothing yet: the same fight')
  const sheet = reread(RICH, { ...sheetOf(RICH, null, {}), level: 6, perks: ['金钟罩', '#swift'], mastery: { 破风斩: 5 } })
  const setup = encounterSetup(sheet, RICH, gate, 'c', 'n')
  assert.ok(Math.abs(setup.player.bonus.tough - (1.1 + EFFECTS.life.sizes[0])) < 1e-9)
  assert.equal(setup.player.bonus.guard, EFFECTS.guard.sizes[1])
  assert.equal(setup.player.bonus.spare, 2)
  assert.ok(setup.player.bonus.first)
  assert.deepEqual(setup.player.skills, [{ name: '破风斩', kind: 'strike', power: 1.03, stage: 2 }])
  assert.deepEqual(fightBonus(bonusOf({ level: 1 }, RICH)), null)
  // A foe's blow is a share of the life before growth: more life is more blows taken, not bigger ones.
  // The foe had only a word for its strength, so it has followed half of what growing is worth at that level.
  const up = foesFollow(6, RICH)
  assert.deepEqual(setup.foes[0].up, up)
  assert.equal(foeSheets(setup)[0].attack, Math.round(100 * 0.16 * up.damage * (1 - EFFECTS.guard.sizes[1])))
  assert.ok(Math.abs(foeSheets(setup)[0].life - foeSheets(plain)[0].life * up.life) <= 1)
})

const unit = (more = {}) => ({ life: 100, maxLife: 100, energy: 30, maxEnergy: 30, modifiers: { body: 0, grace: 0, mind: 0 }, skills: [{ name: '强击', kind: 'strike' }], things: [], ...more })
const fight = (player = {}, allies = [], foes = [{ name: '狼', count: 1, tier: 'normal' }], seed = 'g') => ({ seed, difficulty: 'normal', foes: fieldFoes(foes, { members: 1 + allies.length }), player: unit(player), ...(allies.length ? { allies: allies.map(ally => ({ name: '同伴', ...unit(ally) })) } : {}) })
const struck = events => events.filter(event => event.type === 'struck')
const hits = events => events.filter(event => event.type === 'hit')

test('in a fight: harder blows, lighter ones taken, and the life a level added is more to take', () => {
  const attack = { kind: 'attack', target: 'foe-0' }
  const base = step(startBattle(fight()), attack)
  const strong = step(startBattle(fight({ bonus: { attack: 0.5 } })), attack)
  assert.ok(Math.abs(hits(strong.events)[0].amount - hits(base.events)[0].amount * 1.5) <= 1, 'the same dice, half as much again')
  const guarded = step(startBattle(fight({ bonus: { guard: 0.5 } })), attack)
  assert.ok(Math.abs(struck(guarded.events)[0].amount - struck(base.events)[0].amount / 2) <= 1)
  // Twice the life from growing: the same blow, half the share.
  const tough = step(startBattle(fight({ life: 200, maxLife: 200, bonus: { tough: 2 } })), attack)
  assert.equal(struck(tough.events)[0].amount, struck(base.events)[0].amount)
  const big = step(startBattle(fight({ life: 200, maxLife: 200 })), attack)
  assert.ok(Math.abs(struck(big.events)[0].amount - struck(base.events)[0].amount * 2) <= 1, 'life the card says is just bigger numbers')
  // Cornered, one with 背水 hits harder.
  const low = step(startBattle(fight({ life: 20, bonus: { fury: 0.5 } })), attack)
  assert.ok(Math.abs(hits(low.events)[0].amount - hits(base.events)[0].amount * 1.5) <= 1)
  assert.equal(hits(step(startBattle(fight({ life: 90, bonus: { fury: 0.5 } })), attack).events)[0].amount, hits(base.events)[0].amount)
})

test('in a fight: a skill come further does more for less, and energy growth added is more skills, not dearer ones', () => {
  const plain = startBattle(fight())
  assert.equal(skillCost(plain, skillsOf(plain)[0]), 10)
  const more = startBattle(fight({ energy: 36, maxEnergy: 36, bonus: { spare: 6 } }))
  assert.equal(skillCost(more, skillsOf(more)[0]), 10)
  assert.equal(skillCost(startBattle(fight({ energy: 36, maxEnergy: 36 })), skillsOf(plain)[0]), 12, 'energy the card says is just bigger numbers')
  const grown = startBattle(fight({ skills: [{ name: '强击', kind: 'strike', power: 1.5, cost: 0.8, stage: 3 }] }))
  assert.equal(skillCost(grown, skillsOf(grown)[0]), 8)
  const use = { kind: 'skill', name: '强击', target: 'foe-0' }
  assert.ok(Math.abs(hits(step(grown, use).events)[0].amount - hits(step(plain, use).events)[0].amount * 1.5) <= 1)
})

test('in a fight: 不屈 holds once, 回复 mends each round, 先手 goes first, 护卫 steps in', () => {
  const boss = [{ name: '王', count: 1, tier: 'boss' }]
  // 不屈: the blow that would end it leaves one point, once.
  let state = startBattle(fight({ life: 1, bonus: { stand: true } }, [], boss))
  let events = []
  for (let round = 0; round < 6 && !state.over && !events.some(event => event.type === 'stand'); round++) ({ state, events } = step(state, { kind: 'guard' }))
  assert.ok(events.some(event => event.type === 'stand'))
  assert.equal(playerOf(state).life, 1)
  for (let round = 0; round < 12 && !state.over; round++) ({ state, events } = step(state, { kind: 'guard' }))
  assert.equal(state.over, 'lost', 'only once')
  // 回复: a share of the most life at the end of a round.
  const mended = step(startBattle(fight({ life: 50, bonus: { regen: 0.1 } }, [], [{ name: '桩', count: 1, tier: 'minion' }])), { kind: 'guard' })
  assert.ok(mended.events.some(event => event.type === 'heal' && event.amount === 10))
  // 先手: before foes that would always be quicker.
  const slow = { modifiers: { body: 0, grace: -5, mind: 0 } }
  const order = (bonus, seed) => step(startBattle(fight({ ...slow, ...(bonus ? { bonus } : {}) }, [slow], boss, seed)), [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'guard' }]).events.filter(event => event.type === 'turn').map(event => event.who)
  for (const seed of ['a', 'b', 'c', 'd']) {
    assert.equal(order({ first: true }, seed)[0], 'player', seed)
    assert.equal(order(null, seed)[0], 'foe-0', seed)
  }
  // 护卫: with a certain cover, every blow meant for the other lands on the one who covers.
  let covered = startBattle(fight({}, [{ bonus: { cover: 1 } }], boss))
  let blows = []
  for (let round = 0; round < 3 && !covered.over; round++) {
    const done = step(covered, [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'guard' }])
    covered = done.state
    blows.push(...done.events)
  }
  assert.ok(struck(blows).length > 0)
  assert.ok(struck(blows).every(event => event.target === 'ally-0'))
  assert.ok(blows.filter(event => event.type === 'cover').every(event => event.by === 'ally-0' && event.target === 'player'))
  assert.equal(playerOf(covered).life, 100)
  assert.ok(alliesOf(covered)[0].life < 100)
})

test('a fight won counts each skill\'s use for the player and for those who fought beside them, and what was learned from it', () => {
  const gate = { foes: [{ name: '狼', count: 2, tier: 'normal' }] }
  const run = rules => {
    const sheet = sheetOf(rules, null, {})
    const setup = encounterSetup(sheet, rules, gate, 'c', 'n')
    let state = startBattle(setup)
    const actions = []
    while (!state.over) {
      const round = [{ who: 'player', kind: state.units[0].energy >= 10 ? 'skill' : 'attack', ...(state.units[0].energy >= 10 ? { name: '破风斩' } : {}), target: state.units.find(one => one.side === 'foe' && one.life > 0).id }, ...(state.units[1].life > 0 ? [{ who: 'ally-0', kind: state.units[1].energy >= 10 ? 'skill' : 'attack', ...(state.units[1].energy >= 10 ? { name: '霜落' } : {}), target: state.units.find(one => one.side === 'foe' && one.life > 0).id }] : [])]
      actions.push(round)
      state = step(state, round).state
    }
    return { sheet, result: fightResult(setup, { over: state.over, attempt: 0, actions }) }
  }
  const off = run(OFF)
  assert.equal(off.result.op.uses, undefined)
  assert.equal(off.result.op.party[0].uses, undefined)
  const on = run(STANDARD)
  assert.equal(on.result.battle.over, 'won')
  assert.ok(on.result.op.uses.破风斩 >= 1)
  assert.ok(on.result.op.party[0].uses.霜落 >= 1)
  assert.equal(on.result.battle.party[0].uses, undefined, 'what the transcript keeps is as it was')
  const after = applyOps(on.sheet, STANDARD, [on.result.op]).sheet
  assert.equal(after.mastery.破风斩, on.result.op.uses.破风斩)
  assert.equal(after.party[0].mastery.霜落, on.result.op.party[0].uses.霜落)
  assert.equal(applyOps(off.sheet, OFF, [off.result.op]).sheet.mastery, undefined)
  // 举一反三: more from the same fight; 调息: mended once it is won.
  const keen = { ...on.sheet, level: 3, perks: ['#study', '#kindred'], life: 50 }
  const op = { ...on.result.op, life: 50, experience: 100 }
  const gained = applyOps(reread(book('rich'), keen), book('rich'), [op]).sheet
  const plain = applyOps(reread(book('rich'), { ...keen, perks: [] }), book('rich'), [op]).sheet
  assert.ok(gained.experience + gained.level * 1000 > plain.experience + plain.level * 1000)
  assert.equal(gained.life - plain.life, Math.round(gained.maxLife * EFFECTS.mend.sizes[1]))
})

test('a 天赋 that helps a roll is in the roll and in the chance shown for it', () => {
  const rules = book('rich')
  const sheet = reread(rules, { ...sheetOf(rules, null, {}), level: 3, perks: ['#silver'] })
  const check = { stat: '魅力', dc: 12 }
  const plain = reread(rules, { ...sheet, perks: [] })
  assert.equal(chanceFor(sheet, rules, check) - chanceFor(plain, rules, check), 15)
  assert.equal(rollCheck(sheet, rules, check, 'c', 'n', '').modifier - rollCheck(plain, rules, check, 'c', 'n', '').modifier, 3)
  assert.equal(chanceFor(sheet, rules, { stat: '体魄', dc: 12 }), chanceFor(plain, rules, { stat: '体魄', dc: 12 }))
})

test('a rank the story gives is a level like any other: its life at once, its 天赋 to choose', () => {
  const rules = cleanRulebook({ ...RICH, ranks: ['炼气', '筑基', '金丹'] })
  const sheet = sheetOf(rules, null, {})
  const risen = settleReply(sheet, replyMarks('【晋升|筑基】'), { ranks: rules.ranks, book: rules })
  assert.equal(risen.level, 5)
  assert.equal(risen.maxLife, 108)
  assert.equal(risen.life, 108)
  assert.equal(perksOwed(risen, rules), 1)
})

test('a kit carries a world\'s own 天赋, and a card made from one grows', () => {
  const kit = cleanKit({ perks: [...OWN, { name: '坏的', effects: [{ id: 'nope' }] }], skills: [{ name: '御剑术', kind: 'strike' }] })
  assert.deepEqual(kit.perks, OWN)
  assert.deepEqual(kitBook(kit).growth, { level: 'rich' })
  assert.deepEqual(kitBook(kit).perks, OWN)
  assert.deepEqual(kitBook(cleanKit({})).growth, { level: 'standard' })
  assert.equal(kitBook(cleanKit({})).perks, undefined)
  const found = parseSuggestion(JSON.stringify({ theme: 'xianxia', words: { perk: '神通' }, perks: OWN }), [])
  assert.deepEqual(found.perks, OWN)
  assert.equal(found.words.perk, '神通')
  assert.equal(cleanRulebook({ level: 'full', ...found }).growth.level, 'rich')
})

test('the model is told the 天赋 by name, in the card\'s word for them', () => {
  const sheet = sheetOf(RICH, null, {})
  const told = perks => gamePrompt({ sheet, pausing: true, fights: true, words: { perk: '神通' }, perks }, []).text
  assert.ok(told(['踏雪无痕', '铁骨']).includes('神通：踏雪无痕、铁骨'))
  assert.ok(!told([]).includes('神通：'))
})

test('how the fights go: growth is worth about two levels against a boss a notch above, and a wall is still a wall', () => {
  const chance = (rules, level, { perks = [], uses = 0 } = {}, gap = 1) => {
    const spare = (level - 1) * 2
    const sheet = grownSheet({ ...startSheet(rules), level, skills: ['强击', '横扫'], attributes: { body: Math.min(20, 10 + spare), grace: 10, mind: Math.min(20, 10 + Math.max(0, spare - 10)), charm: 10 }, mastery: { 强击: uses, 横扫: uses }, perks }, rules, [])
    const full = { ...sheet, life: sheet.maxLife, energy: sheet.maxEnergy }
    return simulate(battleSetup(full, { foes: fieldFoes([{ name: '王', count: 1, tier: 'boss', gap }]), seed: 's', ...playerGrowth(full, rules) }), 200).chance
  }
  const off = cleanRulebook({ level: 'full' })
  const standard = cleanRulebook({ level: 'full', growth: { level: 'standard' } })
  const rich = cleanRulebook({ level: 'full', growth: { level: 'rich' } })
  assert.equal(chance(off, 1), chance(rich, 1), 'at the first level nothing has grown')
  const [plain, grown, built] = [chance(off, 7), chance(standard, 7, { uses: 28 }), chance(rich, 7, { uses: 28, perks: ['#iron', '#heavy'] })]
  assert.ok(grown > plain + 15 && grown < 80, `standard at 7: ${plain} → ${grown}`)
  assert.ok(built > grown + 15, `rich at 7: ${grown} → ${built}`)
  assert.ok(chance(standard, 5, { uses: 20 }) < 40, 'not at once')
  assert.ok(chance(standard, 10, { uses: 40 }, 2) < 10, 'two notches above is out of reach for a long while yet')
})

test('难度跟上: a foe with only a word follows part of what growing is worth, one with a rank does not', () => {
  assert.deepEqual(usualGrowth(10, OFF), { deal: 0, take: 0 })
  assert.equal(foesFollow(10, OFF), null)
  assert.equal(foesFollow(1, STANDARD), null, 'nothing to follow at the first level')
  const usual = usualGrowth(10, STANDARD)
  assert.ok(usual.deal > 0.1 && usual.take > 0.1)
  assert.ok(usualGrowth(10, RICH).deal > usual.deal, '天赋 are worth something too')
  const half = foesFollow(10, STANDARD)
  assert.ok(Math.abs(half.life - (1 + usual.deal / 2)) < 1e-3 && Math.abs(half.damage - (1 + usual.take / 2)) < 1e-3)
  assert.ok(foesFollow(10, STANDARD, 'easy').life < half.life && foesFollow(10, STANDARD, 'hard').life > half.life)
  // A card with ranks: the foe that has one is as strong as its rank, the one with a word follows.
  const ranked = book('standard', { ranks: ['炼气', '筑基', '金丹'] })
  const sheet = at(sheetOf(ranked, null, {}), 6)
  const setup = encounterSetup(sheet, ranked, { foes: [{ name: '散修', count: 1, tier: 'normal', power: '筑基中期' }, { name: '山贼', count: 1, tier: 'normal', power: '相当' }] }, 'c', 'n')
  assert.equal(setup.foes[0].up, undefined)
  assert.deepEqual(setup.foes[1].up, foesFollow(6, ranked))
  assert.deepEqual(Object.keys(setup.met), ['山贼'], 'and only that one is remembered')
  // With growth off nothing follows and nothing is remembered.
  const off = encounterSetup(at(sheetOf(OFF, null, {}), 6), OFF, { foes: [{ name: '山贼', count: 1, tier: 'normal', power: '相当' }] }, 'c', 'n')
  assert.equal(off.met, undefined)
  assert.equal(off.foes[0].up, undefined)
})

test('a foe met again is as strong as it was the first time, unless the story says it has grown', () => {
  const gate = power => ({ foes: [{ name: '狼王', count: 1, tier: 'elite', power }] })
  let sheet = at(sheetOf(STANDARD, null, {}), 3)
  const first = encounterSetup(sheet, STANDARD, gate('稍强'), 'c', 'a')
  assert.equal(first.foes[0].gap, 1)
  assert.deepEqual(first.met, { 狼王: { at: 4, gap: 1, level: 3 } })
  const fight = playedOut(first)
  const { op } = fightResult(first, fight)
  assert.deepEqual(op.met, first.met)
  sheet = applyOps(sheet, STANDARD, [op]).sheet
  assert.deepEqual(sheet.met, first.met)
  assert.deepEqual(reread(STANDARD, sheet).met, first.met, 'kept with the sheet')
  // The same level: as it was, and nothing new to remember.
  const same = encounterSetup(at(sheet, 3), STANDARD, gate('稍强'), 'c', 'b')
  assert.equal(same.foes[0].gap, 1)
  assert.equal(same.met, undefined)
  assert.equal(same.foes[0].since, undefined)
  // Four levels on, the story still calls it 稍强: it stands where it stood, which is now below the player.
  const later = encounterSetup(at(sheet, 7), STANDARD, gate('稍强'), 'c', 'd')
  assert.equal(later.foes[0].gap, -1)
  assert.equal(later.foes[0].since, 3)
  assert.deepEqual(later.foes[0].up, foesFollow(3, STANDARD), 'what it followed is what there was then')
  assert.equal(foeSheets(later)[0].since, 3)
  assert.equal(encounterSetup(at(sheet, 9), STANDARD, gate('稍强'), 'c', 'e').foes[0].gap, -2)
  // A weaker word is taken at its word.
  assert.equal(encounterSetup(at(sheet, 4), STANDARD, gate('远弱'), 'c', 'f').foes[0].gap, -2)
  // A stronger word than the first time: it has grown, and that is what is remembered from now on.
  const grown = encounterSetup(at(sheet, 7), STANDARD, gate('强'), 'c', 'g')
  assert.equal(grown.foes[0].gap, 2)
  assert.deepEqual(grown.met, { 狼王: { at: 10, gap: 2, level: 7 } })
  // Only so many are kept: the oldest are let go.
  const many = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`怪${i}`, { at: 1, gap: 0, level: 1 }]))
  const crowded = applyOps(sheet, STANDARD, [{ ...op, met: many }]).sheet.met
  assert.equal(Object.keys(crowded).length, 80)
  assert.ok(crowded.怪89 && !crowded.狼王)
  assert.equal(applyOps(sheet, STANDARD, [{ ...op, met: { 坏: { at: 'x', gap: 0, level: 1 } } }]).sheet.met.坏, undefined)
})

test('直接了结: a fight against those far below is played through without the screen', () => {
  const sheet = at(sheetOf(STANDARD, null, {}), 5)
  const weak = encounterSetup(sheet, STANDARD, { foes: [{ name: '野狗', count: 2, tier: 'minion', power: '远弱' }, { name: '山贼', count: 1, tier: 'normal', power: '远弱' }] }, 'c', 'n')
  assert.ok(beneath(weak))
  assert.ok(!beneath(encounterSetup(sheet, STANDARD, { foes: [{ name: '野狗', count: 1, tier: 'minion', power: '稍弱' }] }, 'c', 'n')))
  assert.ok(!beneath(encounterSetup(sheet, STANDARD, { foes: [{ name: '头目', count: 1, tier: 'elite', power: '远弱' }] }, 'c', 'n')), 'an elite is still a fight')
  const fight = playedOut(weak)
  assert.equal(fight.over, 'won')
  const { battle, op } = fightResult(weak, fight)
  assert.equal(battle.over, 'won')
  assert.equal(op.experience, Math.round(10 * 0.25) * 2 + Math.round(20 * 0.25), 'what those far below are worth')
})

test('the model is told to bring a foe back under its name on a card that counts growth', () => {
  const told = grows => gamePrompt({ sheet: sheetOf(STANDARD, null, {}), pausing: true, fights: true, grows }, []).text
  assert.match(told(true), /再次出现时用原来的名字/)
  assert.doesNotMatch(told(false), /再次出现时用原来的名字/)
})

test('a fight that was won is worth to the story what it took, and the model is told so', () => {
  assert.equal(worthOf([{ tier: 'minion' }, { tier: 'normal', gap: 0 }]), 'small')
  assert.equal(worthOf([{ tier: 'normal', gap: 1 }]), 'fair')
  assert.equal(worthOf([{ tier: 'elite' }]), 'fair')
  assert.equal(worthOf([{ tier: 'elite', gap: 1 }]), 'great')
  assert.equal(worthOf([{ tier: 'boss', gap: -1 }]), 'great')
  assert.equal(worthOf([{ tier: 'boss', gap: -2 }]), 'small', 'what is far below is worth little, whatever it is called')
  assert.equal(worthOf([]), 'small')
  const sheet = at(sheetOf(STANDARD, null, {}), 5)
  const weak = encounterSetup(sheet, STANDARD, { foes: [{ name: '野狗', count: 2, tier: 'minion', power: '远弱' }] }, 'c', 'n')
  const { battle } = fightResult(weak, playedOut(weak))
  assert.equal(battle.worth, 'small')
  const told = fight => gamePrompt({ sheet, pausing: true, fights: true, battle: fight }, []).text
  assert.match(told(battle), /不要小题大做/)
  assert.doesNotMatch(told(battle), /照常记下/)
  assert.match(told({ ...battle, worth: 'fair' }), /至少一样.*照常记下/s)
  assert.match(told({ ...battle, worth: 'great' }), /大胜.*在场的同伴和旁人要有反应.*照常记下/s)
  const { worth, ...old } = battle
  assert.match(told(old), /不要小题大做/, 'a fight kept before this was counted')
  assert.match(told({ ...old, over: 'fled' }), /麻烦找上门/)
  assert.doesNotMatch(told({ ...old, over: 'fled' }), /战利品/)
  assert.doesNotMatch(told({ ...old, over: 'lost' }), /战利品/)
})

test('成长节奏: a level takes less or more experience, and nothing else changes', () => {
  assert.equal(cleanRulebook({ level: 'full' }).pace, undefined)
  assert.equal(cleanRulebook({ level: 'full', pace: 'normal' }).pace, undefined, 'the usual pace is not kept: a book is as it was')
  assert.equal(cleanRulebook({ level: 'full', pace: 'quick' }).pace, undefined)
  const fast = book(null, { pace: 'fast' })
  const slow = book(null, { pace: 'slow' })
  assert.equal(fast.pace, 'fast')
  assert.deepEqual([levelNeeds(1), levelNeeds(3, OFF), levelNeeds(1, fast), levelNeeds(3, fast), levelNeeds(1, slow), levelNeeds(3, slow)], [100, 300, 60, 180, 150, 450])
  const after = rules => applyOps(sheetOf(rules, null, {}), rules, [{ op: 'grow', experience: 100 }]).sheet
  assert.deepEqual([after(OFF).level, after(OFF).experience], [2, 0])
  assert.deepEqual([after(fast).level, after(fast).experience], [2, 40])
  assert.deepEqual([after(slow).level, after(slow).experience], [1, 100])
  // A fight is worth what it was, to the player and to those beside them.
  const setup = encounterSetup(sheetOf(fast, null, {}), fast, { foes: [{ name: '野狗', count: 1, tier: 'minion' }] }, 'c', 'n')
  const { op } = fightResult(setup, playedOut(setup))
  assert.equal(op.experience, 10)
  const won = applyOps({ ...sheetOf(fast, null, {}), experience: 55 }, fast, [op]).sheet
  assert.deepEqual([won.level, won.experience, won.party[0].level], [2, 5, 1])
})
