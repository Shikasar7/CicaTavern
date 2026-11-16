// 成长的收尾 (plans/16): 大天赋 at a 突破, what a card calls its gear, and 持续伤害 against the foes of a party.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { battleSetup, fieldFoes, foesOf, startBattle, step } from '../web/shared/game/battle.js'
import { BIG_BUDGET, BUILTIN_COUNT, BUILTIN_PERKS, bigsOwed, canTake, cleanPerks, perkFor, perkOffer, perksAsk, perksOwed } from '../web/shared/game/growth.js'
import { DEFAULT_WORDS, WORD_KEYS, applyOps, cleanOps, cleanRulebook, grownSheet, keptSheet, levelNeeds, sheetOf, wordFor } from '../web/shared/game/sheet.js'
import { suggestRequest } from '../server/game.mjs'

const OWN = [
  { name: '踏雪无痕', note: '身法轻', effects: [{ id: 'speed', size: 'medium' }, { id: 'flee', size: 'small' }] },
  { name: '太虚剑意', note: '突破时悟出的剑意', big: true, effects: [{ id: 'attack', size: 'large' }, { id: 'crit', size: 'small' }] },
  { name: '贪多', note: '写多了', big: true, effects: [{ id: 'attack', size: 'large' }, { id: 'life', size: 'large' }] },
]
const book = (level = 'rich', more = {}) => cleanRulebook({ level: 'full', growth: { level }, ranks: ['炼气', '筑基', '金丹'], perks: OWN, ...more })
const RICH = book()
const at = (rules, level, more = {}) => ({ ...sheetOf(rules, null, {}), level, ...more })
const expTo = (rules, from, to) => Array.from({ length: to - from }, (_, i) => levelNeeds(from + i, rules)).reduce((sum, need) => sum + need, 0)

test('a card\'s own 大天赋 keep their mark and a point more; the rules bring six of their own', () => {
  const perks = cleanPerks(OWN)
  assert.equal(perks[0].big, undefined)
  assert.equal(perks[1].big, true)
  assert.deepEqual(perks[1].effects, OWN[1].effects, 'four points fit')
  assert.deepEqual(perks[2].effects, [{ id: 'attack', size: 'large' }, { id: 'life', size: 'small' }], 'cut back to four')
  assert.equal(cleanPerks([{ name: '平常', big: false, effects: [{ id: 'attack', size: 'large' }, { id: 'crit', size: 'small' }] }])[0].effects.length, 1, 'three for the rest')
  assert.equal(BUILTIN_PERKS.filter(perk => perk.big).length, 6)
  assert.equal(BUILTIN_COUNT, 24)
  assert.equal(BIG_BUDGET, 4)
  assert.match(perksAsk(), /"big": true/)
  assert.ok(suggestRequest({ description: '修仙', book: { entries: [] } }, []).messages[0].content.includes('"big": true'))
})

test('a 突破 owes one 大天赋, by experience or by the story; a story from before owes none for ranks already crossed', () => {
  const start = at(RICH, 4)
  assert.equal(bigsOwed(start, RICH), 0)
  const grown = applyOps(start, RICH, [{ op: 'grow', experience: expTo(RICH, 4, 5) }]).sheet
  assert.equal(grown.level, 5)
  assert.equal(grown.bigs, 1)
  assert.equal(bigsOwed(grown, RICH), 1)
  assert.equal(sheetOf(RICH, keptSheet(grown), {}).bigs, 1, 'kept with the sheet')
  // Two ranks at once: two.
  const far = applyOps(at(RICH, 4), RICH, [{ op: 'grow', experience: expTo(RICH, 4, 9) }]).sheet
  assert.equal(far.bigs, 2)
  // A level within a rank: none.
  assert.equal(applyOps(at(RICH, 5), RICH, [{ op: 'grow', experience: expTo(RICH, 5, 6) }]).sheet.bigs, undefined)
  // Without 天赋, or without ranks: none.
  const standard = book('standard')
  assert.equal(applyOps(at(standard, 4), standard, [{ op: 'grow', experience: expTo(standard, 4, 5) }]).sheet.bigs, undefined)
  const flat = cleanRulebook({ level: 'full', growth: { level: 'rich' } })
  assert.equal(applyOps(at(flat, 4), flat, [{ op: 'grow', experience: expTo(flat, 4, 5) }]).sheet.bigs, undefined)
  // One already at a high rank when this came: nothing owed for it.
  assert.equal(bigsOwed(at(RICH, 9), RICH), 0)
})

test('大天赋 are offered and counted apart from the rest', () => {
  const sheet = at(RICH, 6, { bigs: 1 })
  assert.equal(perksOwed(sheet, RICH), 2)
  const plain = perkOffer(sheet, RICH, 'chat')
  assert.equal(plain.length, 3)
  assert.ok(plain.every(perk => !perk.big), 'no 大天赋 among the ordinary three')
  const offer = perkOffer(sheet, RICH, 'chat', true)
  assert.equal(offer.length, 3)
  assert.ok(offer.every(perk => perk.big))
  assert.ok(offer.some(perk => perk.own), 'the card\'s own first')
  assert.deepEqual(perkOffer(sheet, RICH, 'chat', true), offer, 'the same three however often it is asked')
  assert.deepEqual(perkOffer(at(RICH, 6), RICH, 'chat', true), [], 'none owed, none offered')
  assert.ok(!perkFor(sheet, RICH).startsWith('#titan') && !['太虚剑意', '贪多'].includes(perkFor(sheet, RICH)), 'one chosen for a companion is never a 大天赋')
  // Taking one.
  assert.ok(canTake(sheet, RICH, '太虚剑意'))
  assert.ok(!canTake(at(RICH, 6), RICH, '太虚剑意'), 'not without a 突破')
  const taken = applyOps(sheet, RICH, cleanOps([{ op: 'perk', key: '太虚剑意' }])).sheet
  assert.deepEqual(taken.perks, ['太虚剑意'])
  assert.equal(bigsOwed(taken, RICH), 0)
  assert.equal(perksOwed(taken, RICH), 2, 'it does not use up one of the ordinary ones')
  assert.deepEqual(perkOffer(taken, RICH, 'chat'), plain, 'nor shuffle the three they are choosing from')
  assert.ok(!canTake(taken, RICH, '#titan'))
  // And one of the ordinary ones does not use up the 大天赋.
  const other = applyOps(sheet, RICH, cleanOps([{ op: 'perk', key: '踏雪无痕' }])).sheet
  assert.equal(perksOwed(other, RICH), 1)
  assert.equal(bigsOwed(other, RICH), 1)
  // Skipped for points.
  const skipped = applyOps(sheet, RICH, cleanOps([{ op: 'perk', skip: true, big: true }])).sheet
  assert.equal(skipped.bigSkips, 1)
  assert.equal(skipped.points, (sheet.points ?? 0) + 2)
  assert.equal(bigsOwed(skipped, RICH), 0)
  assert.equal(perksOwed(skipped, RICH), 2)
  // What it gives is in the fight like any other.
  assert.ok(grownSheet(taken, RICH, []).perks.includes('太虚剑意'))
})

test('a card may call its gear and its rarities its own way', () => {
  for (const key of ['weapon', 'armour', 'trinket', 'common', 'fine', 'rare', 'epic']) assert.ok(WORD_KEYS.includes(key), key)
  const named = cleanRulebook({ level: 'full', words: { weapon: '兵刃', trinket: '佩饰', epic: '神兵', fine: '精良', nope: 'x' } })
  assert.deepEqual(named.words, { weapon: '兵刃', trinket: '佩饰', epic: '神兵' }, 'what is the default is not kept')
  assert.equal(wordFor(named, 'weapon'), '兵刃')
  assert.equal(wordFor(named, 'armour'), DEFAULT_WORDS.armour)
  const ask = suggestRequest({ description: '武侠', book: { entries: [] } }, []).messages[0].content
  assert.ok(ask.includes('weapon（默认武器）') && ask.includes('epic（默认传说）'))
})

test('持续伤害 on a foe is one member\'s doing, as their blows are: the same for a party as for one alone', () => {
  const sheet = { level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10, charm: 10 }, skills: ['毒'], things: [], conditions: [] }
  const friend = name => ({ name, level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10 }, skills: ['强击'] })
  const tick = allies => {
    const state = startBattle(battleSetup(sheet, { foes: fieldFoes([{ name: '敌', count: 1, tier: 'boss' }], { members: 1 + allies.length }), seed: 'p', kinds: { 毒: 'poison', 强击: 'strike' }, allies }))
    const commands = allies.length ? [{ who: 'player', kind: 'skill', name: '毒', target: 'foe-0' }, ...allies.map((_, i) => ({ who: `ally-${i}`, kind: 'guard' }))] : { kind: 'skill', name: '毒', target: 'foe-0' }
    const { state: after, events } = step(state, commands)
    return { amount: events.find(event => event.type === 'poison').amount, life: foesOf(after)[0].maxLife }
  }
  // Made as much more as the foe has more life, one who poisons did the work of the whole party (plans/16).
  assert.equal(tick([]).amount, 4)
  assert.equal(tick([friend('甲'), friend('乙'), friend('丙')]).amount, 4)
})
