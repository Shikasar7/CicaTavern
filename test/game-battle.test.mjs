// 战斗: the rules of a fight, and what they come to over many fights: the table in the design.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliveFoes, autoAction, battleSetup, fieldFoes, foesOf, needsTarget, playerOf, refusal, replay, simulate, skillCost, skillKindOf, startBattle, step } from '../web/shared/game/battle.js'
import { startSheet } from '../web/shared/game/sheet.js'

const POTION = { name: '回春丹', count: 1, effect: { type: 'heal', size: 'medium' } }
const setupFor = (groups, { mod = 0, potions = 1, skills = [{ name: '强击', kind: 'strike' }], seed = 'test', life = 100, difficulty = 'normal', things } = {}) => ({
  seed,
  difficulty,
  foes: fieldFoes(groups),
  player: {
    life,
    maxLife: 100,
    energy: 30,
    maxEnergy: 30,
    modifiers: { body: mod, grace: mod, mind: mod },
    skills,
    things: things ?? (potions ? [{ ...POTION, count: potions }] : []),
  },
})
const G = (name, count = 1) => ({ name, count, tier: name })

test('foes: four at most, and more than a player can face come down a tier, the last first', () => {
  assert.equal(fieldFoes([{ name: '狼', count: 9, tier: 'minion' }]).length, 4)
  assert.deepEqual(fieldFoes([{ name: '狼', count: 2, tier: 'minion' }, { name: '王', count: 1, tier: 'elite' }]).map(foe => foe.tier), ['minion', 'minion', 'elite'])
  assert.deepEqual(fieldFoes([G('boss'), G('normal')]).map(foe => foe.tier), ['boss', 'normal'], 'ten is what a fight can hold')
  assert.deepEqual(fieldFoes([G('boss', 2)]).map(foe => foe.tier), ['boss', 'normal'])
  assert.deepEqual(fieldFoes([G('elite', 4)]).map(foe => foe.tier), ['elite', 'elite', 'minion', 'minion'])
  const points = { minion: 1, normal: 2, elite: 4, boss: 8 }
  for (const groups of [[G('boss', 4)], [G('elite', 4)], [G('boss', 2), G('elite', 2)]]) {
    assert.ok(fieldFoes(groups).reduce((sum, foe) => sum + points[foe.tier], 0) <= 10, JSON.stringify(groups))
  }
})

test('a foe\'s life is so many blows, and many foes are each a little less', () => {
  const one = startBattle(setupFor([G('normal')]))
  assert.equal(foesOf(one)[0].life, 30)
  assert.equal(foesOf(one)[0].damage, 0.12)
  const two = startBattle(setupFor([G('normal', 2)]))
  assert.equal(foesOf(two)[0].life, 23)
  assert.ok(Math.abs(foesOf(two)[0].damage - 0.12 / 1.35) < 1e-9)
})

test('the same setup and actions come to the same fight; another seed to another', () => {
  const setup = setupFor([G('elite'), G('minion')])
  const play = seed => {
    let state = startBattle({ ...setup, seed })
    const actions = []
    while (!state.over) {
      const action = autoAction(state)
      actions.push(action)
      state = step(state, action).state
    }
    return { state, actions }
  }
  const { state, actions } = play('a')
  assert.deepEqual(replay({ ...setup, seed: 'a' }, actions), state, 'all a fight needs keeping is what was done')
  assert.deepEqual(play('a').state, state)
  assert.notDeepEqual(play('b').state.units, state.units)
})

test('a step never changes the state it was given', () => {
  const before = startBattle(setupFor([G('normal')]))
  const frozen = JSON.stringify(before)
  step(before, { kind: 'attack', target: 'foe-0' })
  assert.equal(JSON.stringify(before), frozen)
})

test('what cannot be done is refused, with the reason', () => {
  const state = startBattle(setupFor([G('boss')], { potions: 0, things: [] }))
  assert.equal(refusal(state, { kind: 'attack' }), 'target')
  assert.equal(refusal(state, { kind: 'attack', target: 'player' }), 'target')
  assert.equal(refusal(state, { kind: 'attack', target: 'foe-0' }), null)
  assert.equal(refusal(state, { kind: 'flee' }), 'boss', 'there is no running from a boss')
  assert.equal(refusal(state, { kind: 'item', name: '回春丹' }), 'unknown')
  assert.equal(refusal(state, { kind: 'skill', name: '没有的' }), 'unknown')
  const spent = { ...state, units: [{ ...playerOf(state), energy: 1 }, ...foesOf(state)] }
  assert.equal(refusal(spent, { kind: 'skill', name: '强击', target: 'foe-0' }), 'energy')
  assert.throws(() => step(state, { kind: 'attack' }), /target/)
  assert.equal(needsTarget(state, { kind: 'attack' }), true)
  assert.equal(needsTarget(state, { kind: 'guard' }), false)
  assert.equal(needsTarget(state, { kind: 'skill', name: '强击' }), true)
})

test('skills cost a share of the most energy, whatever the card counts it in', () => {
  const small = startBattle(setupFor([G('normal')]))
  assert.equal(skillCost(small, { kind: 'strike' }), 10)
  const big = startBattle({ ...setupFor([G('normal')]), player: { ...setupFor([G('normal')]).player, energy: 5000, maxEnergy: 5000 } })
  assert.equal(skillCost(big, { kind: 'strike' }), 1650)
  assert.equal(skillKindOf('旋风斩'), 'sweep')
  assert.equal(skillKindOf('连环踢'), 'flurry')
  assert.equal(skillKindOf('毒针'), 'poison')
  assert.equal(skillKindOf('回春术'), 'heal')
  assert.equal(skillKindOf('破山掌'), 'strike')
})

test('a guard halves what lands and gives a little energy back; a charge doubles it and can be seen coming', () => {
  // The same dice in both: only the guard differs.
  let state = startBattle(setupFor([G('elite')], { seed: 'charge-5' }))
  for (let seed = 0; seed < 200 && !state.units[1].charging; seed++) {
    state = startBattle(setupFor([G('elite')], { seed: `charge-${seed}` }))
    state = step(state, { kind: 'attack', target: 'foe-0' }).state
  }
  assert.equal(foesOf(state)[0].charging, true, 'one of these seeds charges on the first round')
  const guarded = step(state, { kind: 'guard' })
  const struck = guarded.events.find(event => event.type === 'struck')
  assert.equal(struck.charged, true)
  assert.equal(foesOf(guarded.state)[0].charging, false)
  assert.equal(guarded.state.units[0].guarding, false, 'for the one round')
  assert.ok(guarded.events.some(event => event.type === 'guard'))
})

test('items and skills do what they say', () => {
  const things = [{ name: '回春丹', count: 2, effect: { type: 'heal', size: 'medium' } }, { name: '雷符', count: 1, effect: { type: 'damage', size: 'small' } }, { name: '灵泉', count: 1, effect: { type: 'energy', size: 'medium' } }, { name: '战鼓', count: 1, effect: { type: 'boost' } }]
  const skills = [{ name: '横扫', kind: 'sweep' }, { name: '毒针', kind: 'poison' }, { name: '回春术', kind: 'heal' }, { name: '蓄势', kind: 'boost' }, { name: '连击', kind: 'flurry' }]
  const setup = setupFor([G('minion', 3)], { skills, things, life: 40 })
  let state = startBattle(setup)
  let result = step(state, { kind: 'item', name: '回春丹' })
  assert.equal(result.events.find(event => event.type === 'heal').amount, 50)
  assert.equal(result.state.things[0].count, 1)
  assert.equal(result.state.used.回春丹, 1)
  result = step(state, { kind: 'item', name: '雷符', target: 'foe-1' })
  assert.equal(result.events.find(event => event.type === 'hit').amount, 20)
  assert.equal(foesOf(result.state)[1].life, 0, 'two blows\' worth brings a small foe down')
  assert.ok(result.events.some(event => event.type === 'down'))
  result = step(state, { kind: 'skill', name: '横扫' })
  assert.equal(result.events.filter(event => event.type === 'hit').length, 3)
  assert.equal(playerOf(result.state).energy, 20)
  result = step(state, { kind: 'skill', name: '连击', target: 'foe-0' })
  assert.equal(result.events.filter(event => event.type === 'hit').length, 2)
  result = step(state, { kind: 'skill', name: '回春术' })
  assert.equal(result.events.find(event => event.type === 'heal').amount, 30)
  result = step(state, { kind: 'skill', name: '毒针', target: 'foe-0' })
  assert.equal(foesOf(result.state)[0].poison, 2, 'and the first round of it has gone')
  assert.ok(result.events.some(event => event.type === 'poison'))
  result = step(state, { kind: 'item', name: '战鼓' })
  assert.equal(playerOf(result.state).boost, 2)
  const spent = { ...state, units: [{ ...playerOf(state), energy: 0 }, ...foesOf(state)] }
  assert.equal(playerOf(step(spent, { kind: 'item', name: '灵泉' }).state).energy, 20)
})

test('a fight ends: won, lost, or got away from', () => {
  const won = step(startBattle(setupFor([G('minion')], { things: [{ name: '雷符', count: 1, effect: { type: 'damage', size: 'large' } }] })), { kind: 'item', name: '雷符', target: 'foe-0' })
  assert.equal(won.state.over, 'won')
  assert.deepEqual(won.events.at(-1), { type: 'over', result: 'won' })
  assert.equal(aliveFoes(won.state).length, 0)
  assert.throws(() => step(won.state, { kind: 'guard' }), /over/)
  let lost = startBattle(setupFor([G('boss')], { life: 1, potions: 0, things: [] }))
  while (!lost.over) lost = step(lost, { kind: 'guard' }).state
  assert.equal(lost.over, 'lost')
  assert.equal(playerOf(lost).life, 0)
  const got = []
  for (let i = 0; i < 40; i++) got.push(step(startBattle(setupFor([G('minion')], { seed: `run-${i}` })), { kind: 'flee' }).state.over)
  assert.ok(got.includes('fled') && got.includes(null), 'a roll: some get away, some do not')
})

test('a sheet makes a fight: what can be used in one, and nothing else', () => {
  const sheet = { ...startSheet({ attributes: { body: 14, grace: 12 }, start: { things: [{ name: '回春丹', count: 2 }, { name: '铜钥匙', count: 1 }, { name: '石头', count: 1 }], skills: ['旋风斩'] } }), life: 60 }
  const effects = name => ({ 回春丹: { type: 'heal', size: 'medium' }, 铜钥匙: { type: 'none' } })[name] ?? null
  const setup = battleSetup(sheet, { foes: fieldFoes([G('normal')]), seed: 's', effects })
  assert.deepEqual(setup.player.modifiers, { body: 2, grace: 1, mind: 0 })
  assert.equal(setup.player.life, 60)
  assert.deepEqual(setup.player.things.map(thing => thing.name), ['回春丹'])
  assert.deepEqual(setup.player.skills, [{ name: '旋风斩', kind: 'sweep' }])
  assert.deepEqual(battleSetup(sheet, { foes: [], seed: 's', kinds: { 旋风斩: 'stun' } }).player.skills, [{ name: '旋风斩', kind: 'stun' }])
})

test('the numbers are relative: life in thousands fights as life in tens', () => {
  const scaled = max => {
    const setup = setupFor([G('normal')])
    return simulate({ ...setup, player: { ...setup.player, life: max, maxLife: max, energy: max, maxEnergy: max } }, 400)
  }
  const [small, big] = [scaled(100), scaled(5000)]
  assert.ok(Math.abs(small.left - big.left) < 2, `${small.left} ${big.left}`)
  assert.ok(Math.abs(small.rounds - big.rounds) < 0.3)
})

// The table in plans/8 5.9: 1 pill, 3 strikes, no modifier, full life, played by 自动.
const TABLE = [
  ['1 杂兵', [G('minion')], 100, 2, 93],
  ['3 杂兵', [G('minion', 3)], 100, 3, 87],
  ['1 普通', [G('normal')], 100, 2, 87],
  ['2 普通', [G('normal', 2)], 100, 4, 65],
  ['1 精英', [G('elite')], 100, 3, 71],
  ['精英 + 2 杂兵', [G('elite'), G('minion', 2)], 100, 6, 58],
  ['1 首领', [G('boss')], 86, 7, 32],
  ['首领 + 1 普通', [G('boss'), G('normal')], 85, 9, 31],
  ['4 普通', [G('normal', 4)], 96, 10, 25],
]

for (const [name, groups, chance, rounds, left] of TABLE) {
  test(`what a fight comes to: ${name}`, () => {
    const result = simulate(setupFor(groups), 3000)
    assert.ok(Math.abs(result.chance - chance) <= 3, `won ${result.chance.toFixed(1)}%, the table says ${chance}%`)
    assert.ok(Math.abs(result.rounds - rounds) <= 1, `${result.rounds.toFixed(1)} rounds, the table says ${rounds}`)
    assert.ok(Math.abs(result.left - left) <= 5, `${result.left.toFixed(0)} left, the table says ${left}`)
  })
}

test('being ready counts: no pill, and two pills with better attributes', () => {
  const bare = simulate(setupFor([G('boss')], { potions: 0 }), 3000)
  assert.ok(Math.abs(bare.chance - 59) <= 4, `${bare.chance.toFixed(1)}%`)
  const ready = simulate(setupFor([G('boss')], { potions: 2, mod: 2 }), 3000)
  assert.ok(ready.chance >= 94, `${ready.chance.toFixed(1)}%`)
  const grown = simulate(setupFor([G('boss')], { mod: 4 }), 3000)
  assert.ok(grown.chance >= 98 && grown.rounds < 5.5, `${grown.chance.toFixed(1)}% in ${grown.rounds.toFixed(1)}`)
})
