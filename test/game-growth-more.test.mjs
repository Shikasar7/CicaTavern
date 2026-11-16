// 成长 (plans/16 M3, M5 and the 羁绊 of M6): 属性历练, 突破, 装备 and what fighting beside the player comes to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beyond, encounterSetup, fightResult, playedOut } from '../web/shared/game/encounter.js'
import { BOND_AT, EFFECTS, GEAR_BUDGET, bondOf, bonusOf, cleanGear, cleanGrowth, gearAsk, gearOf, gearSortAsk, nextBondAt, practiceNeeds, slotByName } from '../web/shared/game/growth.js'
import { applyOps, checkPractice, cleanKit, cleanOps, cleanRulebook, keptSheet, kitBook, settleReply, sheetOf } from '../web/shared/game/sheet.js'
import { replyMarks } from '../web/shared/game/marks.js'
import { gamePrompt, parseThings, thingsRequest } from '../server/game.mjs'

const book = (more = {}, growth = { level: 'standard' }) => cleanRulebook({ level: 'full', ...(growth ? { growth } : {}), ...more })
const ON = book()
const OFF = book({}, null)
const at = (sheet, level) => ({ ...sheet, level })
const check = (stat, dc = 12) => ({ stat, dc })
const result = (tier, dc = 12, more = {}) => ({ tier, dc, total: 15, ...more })

test('历练: a roll that came off against a number worth the name leaves a mark, and enough of them is a point', () => {
  const sheet = sheetOf(ON, null, {})
  assert.deepEqual(checkPractice(sheet, ON, check('体魄'), result('success')), { practice: 'body', by: 1 })
  assert.deepEqual(checkPractice(sheet, ON, check('心智'), result('crit')), { practice: 'mind', by: 2 })
  assert.equal(checkPractice(sheet, ON, check('体魄'), result('close')), null)
  assert.equal(checkPractice(sheet, ON, check('体魄'), result('fail')), null)
  assert.equal(checkPractice(sheet, ON, check('体魄', 10), result('success', 10)), null, 'an easy roll teaches nothing')
  assert.equal(checkPractice(sheet, ON, check('体魄'), result('success', 12, { lacks: '绳索' })), null)
  assert.equal(checkPractice(sheet, ON, check(''), result('success')), null, 'a roll on no attribute')
  assert.equal(checkPractice(sheet, OFF, check('体魄'), result('success')), null, 'only on a card that counts growth')
  assert.equal(checkPractice({ ...sheet, attributes: { ...sheet.attributes, body: 20 } }, ON, check('体魄'), result('success')), null)
  assert.deepEqual([practiceNeeds(10), practiceNeeds(11), practiceNeeds(12), practiceNeeds(15)], [6, 6, 12, 30])
  // Six marks at 10 are a point; what is over is kept.
  let now = sheet
  for (let i = 0; i < 5; i++) now = applyOps(now, ON, [{ op: 'grow', experience: 0, practice: 'body', by: 1 }]).sheet
  assert.deepEqual([now.attributes.body, now.practice.body], [10, 5])
  now = applyOps(now, ON, [{ op: 'grow', experience: 0, practice: 'body', by: 2 }]).sheet
  assert.deepEqual([now.attributes.body, now.practice.body], [11, 1])
  assert.deepEqual(sheetOf(ON, keptSheet(now), {}).practice, { body: 1 }, 'kept with the sheet')
  // With growth off the mark is not counted, and a mark on nothing is nothing.
  assert.equal(applyOps(sheetOf(OFF, null, {}), OFF, [{ op: 'grow', experience: 10, practice: 'body', by: 1 }]).sheet.practice, undefined)
  assert.equal(applyOps(sheet, ON, [{ op: 'grow', experience: 10, practice: 'luck', by: 1 }]).sheet.practice, undefined)
})

test('a card may leave attribute points to 历练 alone, and say whether 战力 is shown', () => {
  assert.deepEqual(cleanGrowth({ level: 'standard', points: false, power: true }), { level: 'standard', points: false, power: true })
  assert.deepEqual(cleanGrowth({ level: 'standard', points: true, power: false }), { level: 'standard' })
  const bare = book({}, { level: 'standard', points: false })
  const up = rules => applyOps(sheetOf(rules, null, {}), rules, [{ op: 'grow', experience: 100 }]).sheet
  assert.deepEqual([up(ON).level, up(ON).points], [2, 2])
  assert.deepEqual([up(bare).level, up(bare).points], [2, 0])
  assert.deepEqual([up(book({}, null)).level, up(book({}, null)).points], [2, 2])
})

test('突破: crossing into a new rank makes one whole, and the model is told', () => {
  const ranked = book({ ranks: ['炼气', '筑基', '金丹'] })
  const hurt = { ...at(sheetOf(ranked, null, {}), 4), life: 20, energy: 3, experience: 390 }
  const grown = applyOps(hurt, ranked, [{ op: 'grow', experience: 20 }])
  assert.equal(grown.sheet.level, 5)
  assert.equal(grown.sheet.life, grown.sheet.maxLife)
  assert.equal(grown.sheet.energy, grown.sheet.maxEnergy)
  assert.match(grown.lines.join('；'), /突破到了筑基/)
  // A level within a rank is only a level.
  const small = applyOps({ ...at(sheetOf(ranked, null, {}), 2), life: 20, experience: 190 }, ranked, [{ op: 'grow', experience: 20 }])
  assert.equal(small.sheet.level, 3)
  assert.ok(small.sheet.life < small.sheet.maxLife)
  assert.match(small.lines.join('；'), /升到了 3 级/)
  // With growth off nothing is restored and nothing is said, as it always was.
  const plain = cleanRulebook({ level: 'full', ranks: ['炼气', '筑基'] })
  const old = applyOps({ ...at(sheetOf(plain, null, {}), 4), life: 20, experience: 390 }, plain, [{ op: 'grow', experience: 20 }])
  assert.deepEqual([old.sheet.level, old.sheet.life, old.lines], [5, 20, []])
  // A rank the story gives is a 突破 too.
  const told = settleReply({ ...at(sheetOf(ranked, null, {}), 2), life: 20 }, replyMarks('【晋升|筑基】'), { ranks: ranked.ranks, book: ranked })
  assert.equal(told.level, 5)
  assert.equal(told.life, told.maxLife)
})

const GEARED = book({
  start: { things: [{ name: '青锋剑', count: 1 }, { name: '铁甲', count: 1 }, { name: '回春丹', count: 2 }, { name: '护身符', count: 2 }], party: ['阿青'] },
  companions: { 阿青: {} },
  items: {
    青锋剑: { type: 'gear', slot: 'weapon', rarity: 'fine', effects: [{ id: 'attack', size: 'medium' }, { id: 'crit', size: 'small' }] },
    铁甲: { type: 'gear', slot: 'armour', rarity: 'common', effects: [{ id: 'guard', size: 'large' }, { id: 'life', size: 'large' }] },
    护身符: { type: 'gear', rarity: 'common' },
    回春丹: { type: 'heal', size: 'medium' },
  },
})

test('装备 as a card keeps it: a slot, a rarity, effects within what it is rare enough for', () => {
  assert.deepEqual(GEARED.items.青锋剑, { type: 'gear', slot: 'weapon', rarity: 'fine', effects: [{ id: 'attack', size: 'medium' }, { id: 'crit', size: 'small' }] })
  assert.deepEqual(GEARED.items.铁甲.effects, [{ id: 'guard', size: 'medium' }], 'over what a common thing may have: made smaller, then dropped')
  assert.deepEqual(GEARED.items.护身符, { type: 'gear', slot: 'charm', rarity: 'common', effects: [{ id: 'life', size: 'small' }] }, 'one that says nothing is something small, by where it is worn')
  assert.deepEqual(GEARED.items.回春丹, { type: 'heal', size: 'medium' })
  assert.equal(cleanGear({ type: 'heal' }), null)
  assert.deepEqual([slotByName('青锋剑'), slotByName('玄铁甲'), slotByName('玉佩')], ['weapon', 'armour', 'charm'])
  assert.deepEqual(GEAR_BUDGET, { common: 2, fine: 3, rare: 4, epic: 6 })
  assert.equal(gearOf(GEARED, '回春丹'), null)
  assert.deepEqual(cleanOps([{ op: 'equip', name: '青锋剑' }, { op: 'equip', name: '铁甲', who: '阿青' }, { op: 'unequip', slot: 'weapon' }, { op: 'unequip', slot: 'hat' }, { op: 'equip' }]), [{ op: 'equip', name: '青锋剑' }, { op: 'equip', name: '铁甲', who: '阿青' }, { op: 'unequip', slot: 'weapon' }])
})

test('装备 put on and taken off: what it does is theirs while it is on', () => {
  const sheet = sheetOf(GEARED, null, {})
  const worn = applyOps(sheet, GEARED, [{ op: 'equip', name: '青锋剑' }, { op: 'equip', name: '铁甲', who: '阿青' }, { op: 'equip', name: '护身符' }, { op: 'equip', name: '护身符', who: '阿青' }])
  assert.equal(worn.ops.length, 4)
  assert.deepEqual(worn.sheet.gear, { weapon: '青锋剑', charm: '护身符' })
  assert.deepEqual(worn.sheet.party[0].gear, { armour: '铁甲', charm: '护身符' })
  assert.match(worn.lines.join('；'), /玩家装备了「青锋剑」.*阿青装备了「铁甲」/)
  assert.equal(bonusOf(worn.sheet, GEARED).attack, EFFECTS.attack.sizes[1])
  assert.equal(bonusOf(worn.sheet.party[0], GEARED).guard, EFFECTS.guard.sizes[1])
  assert.equal(worn.sheet.maxLife, 105, 'a charm that adds life is life at once')
  // There is only one sword: nobody else can have it on, and a thing that is not gear cannot be put on.
  const more = applyOps(worn.sheet, GEARED, [{ op: 'equip', name: '青锋剑', who: '阿青' }, { op: 'equip', name: '回春丹' }, { op: 'equip', name: '青锋剑' }, { op: 'equip', name: '没有的' }])
  assert.equal(more.ops.length, 0)
  // In a fight it is in the numbers, and is not a thing to be used.
  const setup = encounterSetup(worn.sheet, GEARED, { foes: [{ name: '狼', count: 1, tier: 'normal' }] }, 'c', 'n')
  assert.equal(setup.player.bonus.attack, EFFECTS.attack.sizes[1])
  assert.deepEqual(setup.player.things.map(thing => thing.name), ['回春丹'])
  assert.equal(setup.allies[0].bonus.guard, EFFECTS.guard.sizes[1])
  // Taken off.
  const off = applyOps(worn.sheet, GEARED, [{ op: 'unequip', slot: 'weapon' }, { op: 'unequip', slot: 'weapon' }, { op: 'unequip', slot: 'charm', who: '阿青' }])
  assert.equal(off.ops.length, 2)
  assert.deepEqual(off.sheet.gear, { charm: '护身符' })
  assert.equal(bonusOf(off.sheet, GEARED).attack, 0)
  // A thing lost comes off: the player's first, then whoever is left without.
  const lost = applyOps(worn.sheet, GEARED, [{ op: 'lose', name: '青锋剑', count: 1 }, { op: 'lose', name: '护身符', count: 1 }])
  assert.deepEqual(lost.sheet.gear, { charm: '护身符' })
  assert.deepEqual(lost.sheet.party[0].gear, { armour: '铁甲' })
  assert.equal(lost.sheet.maxLife, 105)
  // Kept with the sheet; and with growth off it is there but does nothing.
  assert.deepEqual(sheetOf(GEARED, keptSheet(worn.sheet), {}).gear, worn.sheet.gear)
  const quiet = cleanRulebook({ ...GEARED, growth: undefined })
  assert.equal(applyOps(sheetOf(quiet, null, {}), quiet, [{ op: 'equip', name: '青锋剑' }]).ops.length, 0)
  assert.equal(bonusOf({ gear: { weapon: '青锋剑' } }, quiet).attack, 0)
})

test('the model is told what is worn, a kit carries gear, and a helper may sort a thing as gear', () => {
  const sheet = applyOps(sheetOf(GEARED, null, {}), GEARED, [{ op: 'equip', name: '青锋剑' }]).sheet
  assert.match(gamePrompt({ sheet, pausing: true, gear: ['青锋剑'] }, []).text, /装备着：青锋剑/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true }, []).text, /装备着/)
  const kit = cleanKit({ things: [{ name: '流云剑', count: 1, type: 'gear', slot: 'weapon', rarity: 'rare', effects: [{ id: 'attack', size: 'large' }, { id: 'speed', size: 'small' }] }, { name: '伤药', count: 2, type: 'heal', size: 'small' }, { name: '怪东西', type: 'gear', effects: 'x' }] })
  const made = kitBook(kit)
  assert.deepEqual(made.items.流云剑, { type: 'gear', slot: 'weapon', rarity: 'rare', effects: [{ id: 'attack', size: 'large' }, { id: 'speed', size: 'small' }] })
  assert.deepEqual(made.items.伤药, { type: 'heal', size: 'small' })
  assert.equal(made.items.怪东西.type, 'gear')
  assert.deepEqual(made.start.things.map(thing => thing.name), ['流云剑', '伤药', '怪东西'])
  assert.deepEqual(cleanRulebook({ level: 'full', ...made }).items.流云剑, made.items.流云剑)
  const things = [{ name: '寒铁匕首' }, { name: '钥匙' }]
  assert.match(JSON.stringify(thingsRequest(things)), /gear/)
  assert.deepEqual(parseThings('[{"name":"寒铁匕首","type":"gear","slot":"weapon","rarity":"fine","effects":[{"id":"crit","size":"medium"}]},{"name":"钥匙","type":"none"}]', things), { 寒铁匕首: { type: 'gear', slot: 'weapon', rarity: 'fine', effects: [{ id: 'crit', size: 'medium' }] }, 钥匙: { type: 'none' } })
  assert.doesNotMatch(gearAsk() + gearSortAsk(), /undefined/)
})

test('羁绊: a companion who has won beside the player is the better for it, a step at a time', () => {
  assert.deepEqual(BOND_AT, [3, 8, 15])
  assert.deepEqual([bondOf({}), bondOf({ bond: 3 }), bondOf({ bond: 9 }), bondOf({ bond: 99 })], [0, 1, 2, 3])
  assert.deepEqual([nextBondAt({}), nextBondAt({ bond: 3 }), nextBondAt({ bond: 20 })], [3, 8, null])
  const rules = book({ start: { party: ['阿青'] }, companions: { 阿青: {} } })
  let sheet = sheetOf(rules, null, {})
  for (let i = 0; i < 3; i++) {
    const setup = encounterSetup({ ...sheet, life: sheet.maxLife }, rules, { foes: [{ name: '野狗', count: 1, tier: 'minion', power: '远弱' }] }, 'c', `n${i}`)
    const { op } = fightResult(setup, playedOut(setup))
    assert.equal(op.over, 'won')
    sheet = applyOps(sheet, rules, [op]).sheet
  }
  assert.equal(sheet.party[0].bond, 3)
  assert.equal(bonusOf(sheet.party[0], rules).guard, EFFECTS.guard.sizes[0])
  assert.equal(bonusOf({ ...sheet.party[0], bond: 8 }, rules).attack, EFFECTS.attack.sizes[0])
  assert.equal(bonusOf({ ...sheet.party[0], bond: 15 }, rules).cover, EFFECTS.cover.sizes[1])
  // A fight lost is not one more between them, and with growth off nothing is counted.
  const plain = cleanRulebook({ level: 'full', start: { party: ['阿青'] }, companions: { 阿青: {} } })
  const before = sheetOf(plain, null, {})
  const setup = encounterSetup(before, plain, { foes: [{ name: '野狗', count: 1, tier: 'minion' }] }, 'c', 'n')
  assert.equal(applyOps(before, plain, [fightResult(setup, playedOut(setup)).op]).sheet.party[0].bond, undefined)
  assert.equal(bonusOf({ bond: 15 }, plain).guard, 0)
})

test('a helper that gives a name back with its note on it is still read', () => {
  const things = [{ name: '寒铁匕首', note: '刃口泛蓝' }, { name: '寒铁', note: '一块' }, { name: '旧钥匙', note: '柴房的' }]
  const sorted = parseThings('[{"name":"寒铁匕首（刃口泛蓝）","type":"gear","slot":"weapon"},{"name":"寒铁(一块)","type":"none"},{"name":"旧钥匙：柴房的","type":"none"},{"name":"寒铁匕首","type":"heal","size":"small"},{"name":"别的东西（没问过）","type":"heal"},{"name":"旧钥匙扣","type":"heal"}]', things)
  assert.deepEqual(Object.keys(sorted), ['寒铁匕首', '寒铁', '旧钥匙'])
  assert.equal(sorted.寒铁匕首.type, 'gear', 'the first answer for a thing is the one kept')
  assert.deepEqual(sorted.旧钥匙, { type: 'none' })
})

test('one who got away from a fight is not given a new ailment for it', () => {
  const sheet = sheetOf(ON, null, {})
  const told = gamePrompt({ sheet, pausing: true, fights: true, battle: { over: 'fled', foes: '妖兽', downed: '', rounds: 3, before: 100, life: 40, maxLife: 100, used: {}, skills: [], moments: [], experience: 0 } }, []).text
  assert.match(told, /不要再给玩家加新的异常/)
  assert.doesNotMatch(told, /战利品/)
})

test('what was cured in a fight is told to the model, so the story does not go on limping', () => {
  const sheet = sheetOf(ON, null, {})
  const battle = { over: 'won', foes: '蛇妖', downed: '蛇妖', rounds: 3, before: 100, life: 70, maxLife: 100, used: {}, skills: ['灵息吐纳'], moments: [], experience: 20, worth: 'small' }
  assert.match(gamePrompt({ sheet, pausing: true, fights: true, battle: { ...battle, cured: ['扭伤右脚踝'] } }, []).text, /战斗里玩家解除了：扭伤右脚踝。它已经好了/)
  assert.doesNotMatch(gamePrompt({ sheet, pausing: true, fights: true, battle }, []).text, /战斗里玩家解除了/)
})

test('a fight beyond the player can be left to the story, and the story is told it could not have been won', () => {
  const sheet = sheetOf(ON, null, {})
  const strong = encounterSetup(sheet, ON, { foes: [{ name: '妖王', count: 1, tier: 'boss', power: '强' }, { name: '小妖', count: 2, tier: 'minion' }] }, 'c', 'n')
  const even = encounterSetup(sheet, ON, { foes: [{ name: '妖王', count: 1, tier: 'boss', power: '稍强' }] }, 'c', 'n')
  assert.ok(beyond(strong))
  assert.ok(!beyond(even))
  const left = fightResult(strong, { over: 'story', attempt: 0, actions: [] })
  assert.deepEqual(left, { battle: { over: 'story', foes: '妖王、小妖 ×2', beyond: true }, op: null })
  assert.equal(fightResult(even, { over: 'story', attempt: 0, actions: [] }).battle.beyond, undefined)
  const told = battle => gamePrompt({ sheet, pausing: true, fights: true, battle }, []).text
  assert.match(told(left.battle), /硬打赢不了.*不要写成玩家打赢了/)
  assert.doesNotMatch(told({ over: 'story', foes: '妖王' }), /硬打赢不了/)
})
