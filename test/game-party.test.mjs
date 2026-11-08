// 队伍战斗: the player and up to three others, each with their own numbers and skills, a round of commands played in
// the order of speed. A fight of the player alone is what it always was: battle.test's table holds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PARTY, alivePartyOf, alliesOf, autoAction, autoCommands, battleSetup, fieldFoes, foesOf, needsFriend, partyOf, partySize, playerOf, replay, roundRefusal, simulate, skillsOf, startBattle, step } from '../web/shared/game/battle.js'
import { startSheet } from '../web/shared/game/sheet.js'

const POTION = { name: '回春丹', count: 1, effect: { type: 'heal', size: 'medium' } }
const m0 = { body: 0, grace: 0, mind: 0 }
const ALLY = (name, skills, more = {}) => ({ name, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, modifiers: m0, skills, ...more })
const SU = ALLY('苏挽霜', [{ name: '霜落无声', kind: 'strike' }])
const SHEN = ALLY('沈知微', [{ name: '回春针', kind: 'heal' }, { name: '强击', kind: 'strike' }])
const CHU = ALLY('楚怀瑾', [{ name: '回风扫叶', kind: 'sweep' }])
const setupFor = (groups, allies = [SU], { seed = 'party', potions = 1 } = {}) => ({
  seed,
  difficulty: 'normal',
  foes: fieldFoes(groups, { members: 1 + allies.length }),
  player: { life: 100, maxLife: 100, energy: 30, maxEnergy: 30, modifiers: m0, skills: [{ name: '强击', kind: 'strike' }], things: potions ? [{ ...POTION, count: potions }] : [] },
  ...(allies.length ? { allies } : {}),
})
const G = (name, count = 1) => ({ name, count, tier: name })
const attackAll = (state, target = foesOf(state).find(foe => foe.life > 0).id) => alivePartyOf(state).map(unit => ({ who: unit.id, kind: 'attack', target }))

test('a party stands on the player\'s side: the player first, then the others, each with their own skills', () => {
  const state = startBattle(setupFor([G('normal')], [SU, SHEN]))
  assert.deepEqual(partyOf(state).map(unit => unit.id), ['player', 'ally-0', 'ally-1'])
  assert.deepEqual(alliesOf(state).map(unit => unit.name), ['苏挽霜', '沈知微'])
  assert.deepEqual(skillsOf(state, alliesOf(state)[0]).map(skill => skill.name), ['霜落无声'])
  assert.deepEqual(skillsOf(state).map(skill => skill.name), ['强击'])
  assert.equal(foesOf(state).length, 1)
})

test('no more than four on the player\'s side', () => {
  const setup = setupFor([G('normal')], [SU, SHEN, CHU, ALLY('温小棠', [])])
  assert.equal(partySize(setup), MAX_PARTY)
  assert.equal(partyOf(startBattle(setup)).length, MAX_PARTY)
})

test('a party faces more: tougher foes, who act more often, and a bigger budget before they come down a tier', () => {
  const alone = startBattle(setupFor([G('boss')], []))
  const four = startBattle(setupFor([G('boss')], [SU, SHEN, CHU]))
  assert.ok(foesOf(four)[0].maxLife > foesOf(alone)[0].maxLife * 3)
  assert.ok(foesOf(four)[0].pace > 2)
  assert.equal(foesOf(alone)[0].pace, 1)
  // 首领 + 2 普通 is 12 points: too many for one, not for two.
  assert.deepEqual(fieldFoes([G('boss'), G('normal', 2)]).map(foe => foe.tier), ['boss', 'minion', 'minion'])
  assert.deepEqual(fieldFoes([G('boss'), G('normal', 2)], { members: 2 }).map(foe => foe.tier), ['boss', 'normal', 'normal'])
})

test('a round wants one command for each of the party who can act, and only those', () => {
  const state = startBattle(setupFor([G('normal')], [SU]))
  const foe = foesOf(state)[0].id
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'attack', target: foe }]), 'commands')
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'attack', target: foe }, { who: 'ally-0', kind: 'attack', target: foe }]), null)
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'attack', target: foe }, { who: 'ally-0', kind: 'flee' }]), 'who')
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'attack', target: foe }, { who: 'ally-0', kind: 'skill', name: '强击', target: foe }]), 'unknown')
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'attack', target: foe }, { who: 'ally-0', kind: 'skill', name: '霜落无声', target: foe }]), null)
  assert.throws(() => step(state, { kind: 'attack', target: foe }), /commands/)
})

test('everyone acts once a round, by speed: the quick first, and every act is said with who did it', () => {
  const quick = ALLY('温小棠', [], { modifiers: { body: 0, grace: 6, mind: 0 } })
  let firsts = 0
  for (let i = 0; i < 40; i++) {
    const state = startBattle(setupFor([G('normal', 2)], [quick], { seed: `order:${i}` }))
    const { events } = step(state, attackAll(state))
    const turns = events.filter(event => event.type === 'turn').map(event => event.who)
    const party = turns.filter(id => !id.startsWith('foe'))
    assert.equal(new Set(party).size, party.length)
    assert.ok(turns.includes('player') && turns.includes('ally-0'))
    if (turns[0] === 'ally-0') firsts++
    for (const hit of events.filter(event => event.type === 'hit')) assert.ok(['player', 'ally-0'].includes(hit.by))
    for (const blow of events.filter(event => event.type === 'struck')) assert.ok(['player', 'ally-0'].includes(blow.target))
  }
  assert.ok(firsts >= 30, `the quick one went first ${firsts} times of 40`)
})

test('a foe gone down before one\'s turn: the blow goes to the next one standing', () => {
  const state = startBattle(setupFor([G('minion', 2)], [SU, SHEN, CHU]))
  const [a, b] = foesOf(state)
  a.life = 1
  const { state: after, events } = step(state, alivePartyOf(state).map(unit => ({ who: unit.id, kind: 'attack', target: a.id })))
  const hits = events.filter(event => event.type === 'hit')
  assert.equal(hits[0].target, a.id)
  assert.ok(hits.length > 1 && hits.slice(1).every(hit => hit.target === b.id))
  assert.equal(after.units.find(unit => unit.id === a.id).life, 0)
})

test('one of the party falls and the fight goes on; all of them, and it is lost; won, the fallen get up hurt', () => {
  let state = startBattle(setupFor([G('elite')], [SU]))
  state.units[1].life = 1
  state.units[2].life = 1
  let fell = null
  for (let i = 0; i < 20 && !fell; i++) {
    const { state: next, events } = step(state, alivePartyOf(state).map(unit => ({ who: unit.id, kind: 'guard' })))
    state = next
    fell = events.find(event => event.type === 'fallen')
  }
  assert.ok(fell, 'someone fell')
  if (!state.over) {
    assert.deepEqual(roundRefusal(state, alivePartyOf(state).map(unit => ({ who: unit.id, kind: 'guard' }))), null)
    assert.equal(alivePartyOf(state).length, 1)
  }
  const lost = startBattle(setupFor([G('elite')], [SU]))
  for (const unit of partyOf(lost)) unit.life = 1
  let end = lost
  for (let i = 0; i < 30 && !end.over; i++) end = step(end, alivePartyOf(end).map(unit => ({ who: unit.id, kind: 'guard' }))).state
  assert.equal(end.over, 'lost')
  assert.deepEqual(partyOf(end).map(unit => unit.life), [0, 0])
  const won = startBattle(setupFor([G('minion')], [SU]))
  won.units[1].life = 0
  foesOf(won)[0].life = 1
  const { state: done } = step(won, [{ who: 'player', kind: 'attack', target: foesOf(won)[0].id }])
  assert.equal(done.over, 'won')
  assert.equal(alliesOf(done)[0].life, 1)
})

test('a heal is for whom it is given to, and brings back one who fell', () => {
  const state = startBattle(setupFor([G('normal')], [SHEN, SU]))
  const su = state.units.find(unit => unit.name === '苏挽霜')
  su.life = 0
  assert.equal(needsFriend(state, { who: 'ally-0', kind: 'skill', name: '回春针' }), true)
  assert.equal(needsFriend(state, { who: 'player', kind: 'item', name: '回春丹' }), true)
  assert.equal(needsFriend(state, { who: 'ally-0', kind: 'skill', name: '强击' }), false)
  const foe = foesOf(state)[0].id
  const commands = [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'skill', name: '回春针', target: su.id }]
  assert.equal(roundRefusal(state, commands), null)
  const { state: after, events } = step(state, commands)
  const back = events.find(event => event.type === 'revive')
  assert.equal(back.target, su.id)
  assert.equal(back.by, 'ally-0')
  assert.ok(after.units.find(unit => unit.id === su.id).life > 0 || events.some(event => event.type === 'fallen' && event.target === su.id))
  assert.equal(roundRefusal(state, [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'skill', name: '回春针', target: foe }]), 'target')
  const potion = [{ who: 'player', kind: 'item', name: '回春丹', target: su.id }, { who: 'ally-0', kind: 'guard' }]
  assert.equal(step(state, potion).events.find(event => event.type === 'revive').target, su.id)
})

test('two reaching for the last draught: the slower one gets nothing, and the round goes on', () => {
  const state = startBattle(setupFor([G('normal')], [SU]))
  const both = [{ who: 'player', kind: 'item', name: '回春丹' }, { who: 'ally-0', kind: 'item', name: '回春丹' }]
  assert.equal(roundRefusal(state, both), null)
  const { state: after, events } = step(state, both)
  assert.equal(events.filter(event => event.type === 'item').length, 1)
  assert.equal(events.filter(event => event.type === 'fizzle').length, 1)
  assert.equal(after.things[0].count, 0)
})

test('a guard holds from the start of the round and draws the blows', () => {
  let guardHit = 0
  let otherHit = 0
  for (let i = 0; i < 200; i++) {
    const state = startBattle(setupFor([G('normal')], [SU], { seed: `guard:${i}` }))
    const { events } = step(state, [{ who: 'player', kind: 'attack', target: foesOf(state)[0].id }, { who: 'ally-0', kind: 'guard' }])
    assert.ok(events.findIndex(event => event.type === 'guard') < events.findIndex(event => event.type === 'turn'))
    for (const blow of events.filter(event => event.type === 'struck')) blow.target === 'ally-0' ? guardHit++ : otherHit++
  }
  assert.ok(guardHit > otherHit * 1.5, `the guard took ${guardHit}, the other ${otherHit}`)
})

test('getting up is the player\'s, once, when all have fallen', () => {
  const state = startBattle(setupFor([G('boss')], [SU]))
  for (const unit of partyOf(state)) unit.life = 1
  let end = state
  for (let i = 0; i < 30 && !end.over; i++) end = step(end, alivePartyOf(end).map(unit => ({ who: unit.id, kind: 'guard' }))).state
  assert.equal(end.over, 'lost')
  assert.throws(() => step(end, { who: 'ally-0', kind: 'rally' }), /over/)
  const up = step(end, { kind: 'rally' }).state
  assert.equal(up.over, null)
  assert.ok(playerOf(up).life > 0)
  assert.equal(alliesOf(up)[0].life, 0)
  assert.deepEqual(roundRefusal(up, [{ who: 'player', kind: 'guard' }]), null)
})

test('the same setup and commands come to the same party fight', () => {
  const setup = setupFor([G('elite'), G('minion', 2)], [SU, SHEN, CHU])
  const played = []
  let state = startBattle(setup)
  while (!state.over) {
    const commands = autoCommands(state)
    played.push(commands)
    state = step(state, commands).state
  }
  const again = replay(setup, played)
  assert.deepEqual(again, state)
  assert.notDeepEqual(replay({ ...setup, seed: 'other' }, played.slice(0, 1)).units, replay(setup, played.slice(0, 1)).units)
})

test('自动 gives each of the party a command, and mends the worst hurt first', () => {
  const state = startBattle(setupFor([G('normal', 2)], [SHEN, SU]))
  state.units.find(unit => unit.name === '苏挽霜').life = 20
  const commands = autoCommands(state)
  assert.deepEqual(commands.map(command => command.who), ['player', 'ally-0', 'ally-1'])
  assert.deepEqual(commands[1], { who: 'ally-0', kind: 'skill', name: '回春针', target: 'ally-1' })
  assert.equal(roundRefusal(state, commands), null)
  // Alone, 自动 is as it was: one action, with nobody named.
  const alone = startBattle(setupFor([G('normal')], []))
  assert.equal(autoAction(alone).who, undefined)
  assert.equal(Array.isArray(autoCommands(alone)), false)
})

test('a fight of the player alone may be given one action or a round of one: the same', () => {
  const setup = setupFor([G('normal', 2)], [])
  const state = startBattle(setup)
  const action = { kind: 'skill', name: '强击', target: foesOf(state)[0].id }
  assert.deepEqual(step(state, action), step(state, [action]))
  assert.deepEqual(step(state, action), step(state, [{ ...action, who: 'player' }]))
})

test('a sheet and its companions make a party fight', () => {
  const sheet = { ...startSheet({ start: { things: [], skills: ['强击'] }, attributes: { body: 10, grace: 10, mind: 10 } }), things: [] }
  const setup = battleSetup(sheet, { foes: fieldFoes([G('normal')], { members: 2 }), seed: 's', allies: [{ name: '苏挽霜', attributes: { body: 10, grace: 16, mind: 12 }, life: 80, maxLife: 80, maxEnergy: 24, skills: ['霜落无声', '回风扫叶'] }] })
  assert.equal(setup.allies.length, 1)
  assert.deepEqual(setup.allies[0].skills, [{ name: '霜落无声', kind: 'strike' }, { name: '回风扫叶', kind: 'sweep' }])
  assert.equal(setup.allies[0].energy, 24)
  assert.ok(setup.allies[0].modifiers.grace > setup.player.modifiers.grace)
  assert.equal(battleSetup(sheet, { foes: [], seed: 's' }).allies, undefined)
})

// The table in plans/13: with more of the party a fight is about as hard, a little easier where there are many foes.
const PARTY_TABLE = [
  ['1 首领', [G('boss')], [89, 96, 90]],
  ['首领 + 1 普通', [G('boss'), G('normal')], [79, 89, 83]],
  ['4 普通', [G('normal', 4)], [92, 100, 100]],
  ['精英 + 2 杂兵', [G('elite'), G('minion', 2)], [100, 100, 100]],
]
for (const [name, groups, chances] of PARTY_TABLE) {
  test(`what a party fight comes to: ${name}`, () => {
    chances.forEach((chance, i) => {
      const result = simulate(setupFor(groups, [SU, SHEN, CHU].slice(0, i + 1), { seed: 'sim' }), 2000)
      assert.ok(Math.abs(result.chance - chance) <= 5, `${i + 2} of the party won ${result.chance.toFixed(1)}%, the table says ${chance}%`)
    })
  })
}
