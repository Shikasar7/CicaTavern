// 技能效果 (plans/17): what a skill does on top of its kind, the kinds added with it, and that a card with none of
// it fights as it always did.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADD_BUDGET, SKILLS, SKILL_ADDS, SKILL_ADD_IDS, addFits, addPoints, alliesOf, autoCommands, battleSetup, cleanAdds, fieldFoes, foesOf, needsFriend, needsTarget, playerOf, simulate, skillCost, skillsOf, startBattle, step } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult, playedOut } from '../web/shared/game/encounter.js'
import { skillsAsk } from '../web/shared/game/growth.js'
import { cleanKit, cleanRulebook, kitBook, sheetOf, skillKindIn } from '../web/shared/game/sheet.js'
import { parseSuggestion, suggestRequest } from '../server/game.mjs'

const sheet = (more = {}) => ({ level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10, charm: 10 }, skills: ['甲'], things: [], conditions: [], ...more })
const friend = (name, skills) => ({ name, level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10 }, skills })
const fight = (kind, adds, { foes = [{ name: '敌', count: 1, tier: 'boss' }], allies = [], kinds = {}, seed = 's', more = {}, bonus = null } = {}) =>
  startBattle(battleSetup(sheet(more), { foes: fieldFoes(foes, { members: 1 + allies.length }), seed, kinds: { 甲: kind, ...kinds }, adds: adds ? { 甲: adds } : {}, allies, bonus }))
const use = (state, more = {}) => step(state, { kind: 'skill', name: '甲', ...(SKILLS[skillsOf(state)[0].kind].target === 'one' ? { target: 'foe-0' } : {}), ...more })
const of = (events, type) => events.filter(event => event.type === type)

test('adds are kept only as the rules know them: what the kind can carry, two at most, within the budget', () => {
  assert.deepEqual(cleanAdds([{ id: 'slow', size: 'large' }], 'strike'), [{ id: 'slow', size: 'large' }])
  assert.deepEqual(cleanAdds([{ id: 'slow' }], 'strike'), [{ id: 'slow', size: 'medium' }], 'a size not said is medium')
  assert.deepEqual(cleanAdds([{ id: 'burn', size: 'small' }, null, 'slow', { id: 'slow', size: 'huge' }], 'strike'), [{ id: 'slow', size: 'medium' }])
  assert.deepEqual(cleanAdds([{ id: 'slow', size: 'small' }, { id: 'slow', size: 'large' }], 'strike'), [{ id: 'slow', size: 'small' }], 'no two the same')
  assert.deepEqual(cleanAdds([{ id: 'slow', size: 'small' }, { id: 'leech', size: 'small' }, { id: 'surge', size: 'small' }], 'strike').length, 2)
  // What strikes can leave something on a foe; what mends or wards can cleanse; nothing else can.
  assert.deepEqual(cleanAdds([{ id: 'slow' }, { id: 'cleanse' }], 'heal'), [{ id: 'cleanse' }])
  assert.deepEqual(cleanAdds([{ id: 'cleanse' }, { id: 'leech' }], 'ward'), [{ id: 'cleanse' }])
  assert.deepEqual(cleanAdds([{ id: 'cleanse' }], 'strike'), [])
  assert.deepEqual(cleanAdds([{ id: 'expose' }], 'boost'), [])
  assert.ok(!addFits('poison', 'poison') && addFits('poison', 'slow'), 'a kind does not carry what it already does')
  assert.ok(!addFits('nothing', 'slow') && !addFits('strike', 'nothing'))
  // Over the budget the last is made smaller, then dropped.
  assert.deepEqual(cleanAdds([{ id: 'slow', size: 'large' }, { id: 'expose', size: 'large' }], 'strike'), [{ id: 'slow', size: 'large' }])
  assert.deepEqual(cleanAdds([{ id: 'slow', size: 'medium' }, { id: 'expose', size: 'large' }], 'strike'), [{ id: 'slow', size: 'medium' }, { id: 'expose', size: 'small' }])
  // A price gives half back, and is no add by itself.
  assert.equal(addPoints([{ id: 'slow', size: 'large' }, { id: 'recoil', size: 'medium' }]), 2)
  assert.deepEqual(cleanAdds([{ id: 'expose', size: 'large' }, { id: 'recoil', size: 'large' }], 'strike').length, 2)
  assert.deepEqual(cleanAdds([{ id: 'recoil', size: 'large' }], 'strike'), [])
  for (const id of SKILL_ADD_IDS) assert.ok(SKILL_ADDS[id].sizes?.length === 3 || SKILL_ADDS[id].cost > 0, id)
  assert.ok(ADD_BUDGET >= 3)
})

test('a card with no adds fights as it always did', () => {
  const plain = battleSetup(sheet(), { foes: fieldFoes([{ name: '敌', count: 1, tier: 'elite' }]), seed: 's', kinds: { 甲: 'strike' } })
  const same = battleSetup(sheet(), { foes: fieldFoes([{ name: '敌', count: 1, tier: 'elite' }]), seed: 's', kinds: { 甲: 'strike' }, adds: { 乙: [{ id: 'slow', size: 'small' }], 甲: [{ id: 'cleanse' }] } })
  assert.deepEqual(same, plain, 'adds for another skill, or ones this kind cannot carry, are not there')
  assert.deepEqual(plain.player.skills, [{ name: '甲', kind: 'strike' }])
  const added = fight('strike', [{ id: 'slow', size: 'large' }])
  assert.equal(skillCost(added, skillsOf(added)[0]), skillCost(startBattle(plain), { name: '甲', kind: 'strike' }), 'an add does not make a skill dearer')
})

test('what an add takes from the skill itself, and what it leaves on the foe', () => {
  const plain = use(fight('strike'))
  const hit = events => of(events, 'hit')[0].amount
  // Three points: fifteen parts in a hundred less of the blow, on the same dice.
  const heavy = use(fight('strike', [{ id: 'weaken', size: 'large' }]))
  assert.ok(Math.abs(hit(heavy.events) - hit(plain.events) * 0.85) <= 1, `${hit(plain.events)} → ${hit(heavy.events)}`)
  const foe = foesOf(heavy.state)[0]
  assert.equal(foe.weak, 2, 'three rounds, this one counted')
  assert.equal(foe.weakBy, SKILL_ADDS.weaken.sizes[2])
  assert.deepEqual(of(heavy.events, 'status').map(event => event.status), ['weaken'])
  // 削弱: its blow this round is that much lighter.
  const struck = events => of(events, 'struck')[0]?.amount
  if (struck(plain.events) && struck(heavy.events)) assert.ok(struck(heavy.events) < struck(plain.events))
  // 破绽: the next blow lands harder.
  const open = use(fight('strike', [{ id: 'expose', size: 'large' }]))
  assert.equal(foesOf(open.state)[0].openBy, SKILL_ADDS.expose.sizes[2])
  const second = step(open.state, { kind: 'attack', target: 'foe-0' })
  const bare = step(use(fight('strike')).state, { kind: 'attack', target: 'foe-0' })
  assert.ok(hit(second.events) > hit(bare.events))
  // It wears off.
  let state = open.state
  for (let i = 0; i < 3 && !state.over; i++) state = step(state, { kind: 'guard' }).state
  assert.equal(foesOf(state)[0].open, 0)
  // 持续伤害: its own size, each round.
  const burnt = use(fight('strike', [{ id: 'poison', size: 'large' }]))
  assert.equal(of(burnt.events, 'poison')[0].amount, Math.round(10 * SKILL_ADDS.poison.sizes[2]))
  assert.equal(of(use(fight('poison')).events, 'poison')[0].amount, 4, 'the kind of that name is as it was')
})

test('迟缓 adds up to an action lost; 眩晕 by an add is harder on a 首领', () => {
  // Energy to spare (as growth gives it), so the skill can be used every round.
  let state = fight('strike', [{ id: 'slow', size: 'large' }], { foes: [{ name: '敌', count: 1, tier: 'boss', gap: 2 }], more: { maxEnergy: 300, energy: 300, maxLife: 5000, life: 5000 }, bonus: { spare: 270, tough: 50 } })
  let lost = 0
  let acted = 0
  for (let i = 0; i < 8 && !state.over; i++) {
    const { state: next, events } = use(state)
    lost += of(events, 'slowed').length
    acted += of(events, 'struck').length + of(events, 'charge').length
    state = next
  }
  assert.ok(lost >= 1, 'a foe kept slowed misses a turn sooner or later')
  assert.ok(lost < acted, 'but not most of them')
  // Stun: over many fights a 首领 is stopped about half as often as an elite.
  const stuns = tier => {
    let count = 0
    for (let seed = 0; seed < 300; seed++) count += of(use(fight('strike', [{ id: 'stun', size: 'large' }], { foes: [{ name: '敌', count: 1, tier }], seed: `s${seed}` })).events, 'status').filter(event => event.status === 'stun').length
    return count
  }
  const elite = stuns('elite')
  const boss = stuns('boss')
  assert.ok(elite > 170 && elite < 250, `elite ${elite}`)
  assert.ok(boss > 70 && boss < 140, `boss ${boss}`)
})

test('吸取、回气、反噬: what comes back to the one who struck, and what it cost them', () => {
  const hurt = { life: 50, energy: 20 }
  const leech = use(fight('strike', [{ id: 'leech', size: 'large' }], { more: hurt }))
  const dealt = of(leech.events, 'hit')[0].amount
  assert.equal(of(leech.events, 'heal')[0].amount, Math.round(dealt * SKILL_ADDS.leech.sizes[2]))
  const surge = use(fight('strike', [{ id: 'surge', size: 'large' }], { more: hurt }))
  assert.equal(of(surge.events, 'energy')[0].amount, Math.round(30 * SKILL_ADDS.surge.sizes[2]))
  const recoil = use(fight('strike', [{ id: 'expose', size: 'large' }, { id: 'recoil', size: 'large' }]))
  assert.equal(of(recoil.events, 'recoil')[0].amount, 8)
  // Never the last of one's life.
  const last = use(fight('strike', [{ id: 'expose', size: 'large' }, { id: 'recoil', size: 'large' }], { more: { life: 3 } }))
  assert.equal(of(last.events, 'recoil')[0].amount, 2)
})

test('斩杀 does its more to a foe near its end', () => {
  const fresh = use(fight('finish'))
  const state = fight('finish')
  foesOf(state)[0].life = Math.floor(foesOf(state)[0].maxLife * 0.39)
  const ending = use(state)
  assert.ok(Math.abs(of(ending.events, 'hit')[0].amount - of(fresh.events, 'hit')[0].amount * 2) <= 1)
  assert.ok(needsTarget(state, { kind: 'skill', name: '甲' }))
})

test('护盾 takes the blow first and wears off; 净化 on it cures what ails the player', () => {
  const state = fight('ward')
  const { state: warded, events } = use(state)
  const given = of(events, 'status').find(event => event.status === 'ward')
  assert.equal(given.amount, 30)
  const held = of(events, 'warded')[0]
  const blow = of(events, 'struck')[0]
  if (held) {
    assert.equal(held.amount + blow.amount > 0, true)
    assert.equal(playerOf(warded).life, 100 - blow.amount, 'only what the ward could not hold comes off')
    assert.equal(playerOf(warded).ward, 30 - held.amount)
    // What the page shows of it while the round plays out: the shield's size when it goes up, what is left after a
    // blow, and a blow of nothing when the shield took it all (the player alone has no row to read these from).
    assert.equal(held.left, 30 - held.amount)
    if (held.left > 0) assert.equal(blow.amount, 0, 'a shield with some left took the whole blow')
  }
  let later = warded
  for (let i = 0; i < 3 && !later.over; i++) later = step(later, { kind: 'guard' }).state
  assert.ok(!(playerOf(later).ward > 0), 'gone after three rounds')
  // In a party it can be given to another.
  const party = fight('ward', null, { allies: [friend('友', ['乙'])], kinds: { 乙: 'strike' } })
  assert.ok(needsFriend(party, { kind: 'skill', name: '甲' }))
  const given2 = step(party, [{ who: 'player', kind: 'skill', name: '甲', target: 'ally-0' }, { who: 'ally-0', kind: 'guard' }])
  assert.equal(of(given2.events, 'status').find(event => event.status === 'ward').target, 'ally-0')
  // 净化.
  const ailing = fight('ward', [{ id: 'cleanse' }], { more: { conditions: [{ name: '中毒', stat: 'body', size: 2, days: 3 }] } })
  const cured = use(ailing)
  assert.deepEqual(of(cured.events, 'cure').map(event => event.name), ['中毒'])
  assert.deepEqual(cured.state.cured, ['中毒'])
  assert.equal(of(cured.events, 'status').find(event => event.status === 'ward').amount, Math.round(30 * 0.95), 'and the ward is a little less for it')
})

test('群疗、鼓舞、挑衅: for the whole party', () => {
  const allies = [friend('友', ['乙']), friend('伴', ['乙'])]
  const kinds = { 乙: 'strike' }
  const others = [{ who: 'ally-0', kind: 'guard' }, { who: 'ally-1', kind: 'guard' }]
  const mend = fight('mend', null, { allies: allies.map(ally => ({ ...ally, life: 40 })), kinds, more: { life: 40 } })
  assert.ok(!needsFriend(mend, { kind: 'skill', name: '甲' }))
  const mended = step(mend, [{ who: 'player', kind: 'skill', name: '甲' }, ...others])
  assert.deepEqual(of(mended.events, 'heal').map(event => event.amount), [18, 18, 18])
  const rally = step(fight('rally', null, { allies, kinds }), [{ who: 'player', kind: 'skill', name: '甲' }, ...others])
  assert.ok([playerOf(rally.state), ...alliesOf(rally.state)].every(unit => unit.boostBy === 1.2 && unit.boost > 0))
  // 蓄势 of one's own is the more of the two, and stays.
  const both = fight('rally', null, { allies: [friend('友', ['乙'])], kinds: { 乙: 'boost' } })
  const first = step(both, [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'skill', name: '乙' }])
  const second = step(first.state, [{ who: 'player', kind: 'skill', name: '甲' }, { who: 'ally-0', kind: 'guard' }])
  assert.equal(alliesOf(second.state)[0].boostBy, undefined)
  // 挑衅: the foes come for the one who asked for it, far more often than not.
  let drawn = 0
  let all = 0
  for (let seed = 0; seed < 200; seed++) {
    const blows = [{ who: 'ally-0', kind: 'attack', target: 'foe-0' }, { who: 'ally-1', kind: 'attack', target: 'foe-0' }]
    const begun = step(fight('taunt', null, { allies, kinds, seed: `t${seed}`, foes: [{ name: '敌', count: 1, tier: 'boss', gap: 1 }] }), [{ who: 'player', kind: 'skill', name: '甲' }, ...blows])
    assert.equal(playerOf(begun.state).taunt, 2)
    if (begun.state.over || playerOf(begun.state).life === 0 || alliesOf(begun.state).some(ally => ally.life === 0)) continue
    // The round after: it holds from the first blow to the last.
    const { events } = step(begun.state, [{ who: 'player', kind: 'attack', target: 'foe-0' }, ...blows])
    for (const event of of(events, 'struck')) {
      all += 1
      if (event.target === 'player') drawn += 1
    }
  }
  assert.ok(drawn / all > 0.55, `${drawn}/${all}`)
})

test('a fight with adds plays through by itself and settles as any other', () => {
  const book = cleanRulebook({ level: 'full', start: { skills: ['寒霜剑气', '回春'] }, skills: { 寒霜剑气: 'strike', 回春: 'heal' }, skillAdds: { 寒霜剑气: [{ id: 'slow', size: 'medium' }, { id: 'leech', size: 'small' }], 回春: [{ id: 'cleanse' }, { id: 'slow' }], 无名: [{ id: 'burn' }] } })
  assert.deepEqual(book.skillAdds, { 寒霜剑气: [{ id: 'slow', size: 'medium' }, { id: 'leech', size: 'small' }], 回春: [{ id: 'cleanse' }] })
  assert.equal(cleanRulebook({ level: 'full', skillAdds: { 强击: [{ id: 'cleanse' }] } }).skillAdds, undefined, 'none that fit: not kept')
  const setup = encounterSetup(sheetOf(book, null, {}), book, { foes: [{ name: '狼', count: 2, tier: 'normal' }] }, 'c', 'n')
  assert.deepEqual(setup.player.skills[0], { name: '寒霜剑气', kind: 'strike', adds: [{ id: 'slow', size: 'medium' }, { id: 'leech', size: 'small' }] })
  const played = playedOut(setup)
  const { battle } = fightResult(setup, played)
  assert.equal(battle.over, played.over)
  assert.ok(simulate(setup, 50).chance >= 0)
  // A companion's skill of the same name has them too; its kind may be the companion's own.
  const withFriend = cleanRulebook({ level: 'full', start: { party: ['阿青'] }, companions: { 阿青: { skills: { 霜落: 'strike' } } }, skillAdds: { 霜落: [{ id: 'expose', size: 'small' }] } })
  assert.equal(skillKindIn(withFriend, '霜落'), 'strike')
  assert.deepEqual(withFriend.skillAdds, { 霜落: [{ id: 'expose', size: 'small' }] })
  const together = encounterSetup(sheetOf(withFriend, null, {}), withFriend, { foes: [{ name: '狼', count: 1, tier: 'normal' }] }, 'c', 'n')
  assert.deepEqual(together.allies[0].skills, [{ name: '霜落', kind: 'strike', adds: [{ id: 'expose', size: 'small' }] }])
  // 自动 with every new kind at once does not trip.
  const kinds = { 甲: 'finish', 乙: 'ward', 丙: 'taunt', 丁: 'rally', 戊: 'mend' }
  const everything = battleSetup(sheet({ skills: ['甲', '乙', '丙'] }), { foes: fieldFoes([{ name: '敌', count: 1, tier: 'boss' }, { name: '兵', count: 2, tier: 'normal' }], { members: 3 }), seed: 'x', kinds, allies: [friend('友', ['丁', '戊', '甲']), friend('伴', ['丙', '乙'])] })
  assert.ok(simulate(everything, 60).rounds > 0)
  let state = startBattle(everything)
  for (let i = 0; i < 40 && !state.over; i++) state = step(state, autoCommands(state)).state
})

test('a kit carries the adds a model wrote, and the model is asked for every kind and every add there is', () => {
  const kit = cleanKit({ skills: [{ name: '寒霜剑气', kind: 'strike', adds: [{ id: 'slow', size: 'medium' }, { id: 'nonsense' }] }, { name: '强击', kind: 'strike' }, { name: '回春', kind: 'heal', adds: [{ id: 'leech' }] }], companions: [{ name: '阿青', skills: [{ name: '霜落', kind: 'strike', adds: [{ id: 'expose', size: 'large' }] }] }] })
  assert.deepEqual(kit.skills, [{ name: '寒霜剑气', kind: 'strike', adds: [{ id: 'slow', size: 'medium' }] }, { name: '强击', kind: 'strike' }, { name: '回春', kind: 'heal' }])
  assert.deepEqual(kitBook(kit).skillAdds, { 寒霜剑气: [{ id: 'slow', size: 'medium' }], 霜落: [{ id: 'expose', size: 'large' }] })
  assert.equal(kitBook(cleanKit({ skills: [{ name: '强击', kind: 'strike' }] })).skillAdds, undefined)
  const ask = skillsAsk()
  for (const kind of Object.keys(SKILLS)) assert.match(ask, new RegExp(`${kind}（[^undefined）]+）`), kind)
  for (const id of SKILL_ADD_IDS) assert.match(ask, new RegExp(`${id}（[^）]+）`), id)
  assert.doesNotMatch(ask, /undefined/)
  const request = suggestRequest({ name: '测试', description: '一个世界' }, [])
  assert.match(JSON.stringify(request), /adds/)
  const found = parseSuggestion('{"theme":"wuxia","attributes":{"body":12,"grace":10,"mind":11,"charm":10},"skills":[{"name":"寒霜剑气","kind":"strike","adds":[{"id":"slow","size":"medium"}]}],"things":[],"foes":[]}', [])
  assert.deepEqual(found.skillAdds, { 寒霜剑气: [{ id: 'slow', size: 'medium' }] })
})
