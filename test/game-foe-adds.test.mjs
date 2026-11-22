// 敌人的招式效果 (plans/17, after S4): what the blows of a 精英 or a 首领 leave on whom they strike, where a card's
// bestiary says so; and 装备 followed by the foes as a level is (plans/16). A foe with none of it fights as it did:
// the other game tests hold that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOE_ADDS, FOE_ADD_IDS, FOE_ADD_ROOM, battleSetup, cleanFoeAdds, fieldFoes, foeSheets, foesOf, playerOf, simulate, startBattle, step } from '../web/shared/game/battle.js'
import { encounterSetup, fightResult, playedOut } from '../web/shared/game/encounter.js'
import { foeAddsAsk, foesFollow, wornWorth } from '../web/shared/game/growth.js'
import { applyOps, bestiaryName, cleanKit, cleanRulebook, keptSheet, kitBook, sheetOf } from '../web/shared/game/sheet.js'
import { foesRequest, parseFoes, suggestRequest } from '../server/game.mjs'

const sheet = (more = {}) => ({ level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10, charm: 10 }, skills: ['甲'], things: [], conditions: [], ...more })
const friend = name => ({ name, level: 1, life: 100, maxLife: 100, energy: 30, maxEnergy: 30, attributes: { body: 10, grace: 10, mind: 10 }, skills: ['乙'] })
const fight = (adds, { tier = 'boss', allies = [], kinds = { 甲: 'strike', 乙: 'strike' }, skillAdds = {}, seed = 's', more = {} } = {}) =>
  startBattle(battleSetup(sheet(more), { foes: fieldFoes([{ name: '敌', count: 1, tier, ...(adds ? { adds } : {}) }], { members: 1 + allies.length }), seed, kinds, adds: skillAdds, allies }))
const of = (events, type) => events.filter(event => event.type === type)
/** Rounds of guarding until something of a type has happened, or the fight is over: → { state, events (of all the rounds) }. */
function until(state, type, action = { kind: 'guard' }, most = 30) {
  const all = []
  for (let i = 0; i < most && !state.over; i++) {
    const { state: next, events } = step(state, action)
    state = next
    all.push(...events)
    if (of(events, type).length) break
  }
  return { state, events: all }
}

test('a foe\'s adds are kept only as the rules know them, and only as many as its tier has room for', () => {
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'large' }]), [{ id: 'poison', size: 'large' }])
  assert.deepEqual(cleanFoeAdds([{ id: 'leech' }]), [{ id: 'leech', size: 'medium' }], 'a size not said is medium')
  assert.deepEqual(cleanFoeAdds([{ id: 'burn', size: 'small' }, null, 'poison', { id: 'stun', size: 'huge' }]), [{ id: 'stun', size: 'medium' }])
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'small' }, { id: 'poison', size: 'large' }]), [{ id: 'poison', size: 'small' }], 'no two the same')
  // 首领: two, three points; the last is made smaller, then dropped.
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'medium' }, { id: 'leech', size: 'large' }, { id: 'stun', size: 'small' }]), [{ id: 'poison', size: 'medium' }, { id: 'leech', size: 'small' }])
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'large' }, { id: 'leech', size: 'large' }]), [{ id: 'poison', size: 'large' }])
  // 精英: the first of them, medium at most. The lesser tiers: none.
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'large' }, { id: 'leech', size: 'small' }], 'elite'), [{ id: 'poison', size: 'medium' }])
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'small' }], 'normal'), [])
  assert.deepEqual(cleanFoeAdds([{ id: 'poison', size: 'small' }], 'minion'), [])
  assert.deepEqual(Object.keys(FOE_ADD_ROOM), ['elite', 'boss'])
  // In a fight: what the tier it comes as has room for, and a little off its own blows for it.
  const plain = foesOf(fight(null))[0]
  const boss = foesOf(fight([{ id: 'poison', size: 'medium' }, { id: 'leech', size: 'small' }]))[0]
  assert.equal(plain.adds, undefined)
  assert.deepEqual(boss.adds, [{ id: 'poison', size: 'medium' }, { id: 'leech', size: 'small' }])
  assert.ok(boss.damage < plain.damage && boss.damage > plain.damage * 0.85)
  assert.equal(boss.maxLife, plain.maxLife)
  assert.deepEqual(foesOf(fight([{ id: 'poison', size: 'large' }, { id: 'leech', size: 'small' }], { tier: 'elite' }))[0].adds, [{ id: 'poison', size: 'medium' }])
  assert.equal(foesOf(fight([{ id: 'poison', size: 'large' }], { tier: 'normal' }))[0].adds, undefined)
})

test('持续伤害: whom it strikes loses a share of their life each round for three, never the last of it', () => {
  const { state, events } = until(fight([{ id: 'poison', size: 'large' }]), 'afflict')
  const given = of(events, 'afflict')[0]
  assert.deepEqual({ status: given.status, target: given.target, by: given.by }, { status: 'poison', target: 'player', by: 'foe-0' })
  const first = of(events, 'sap')[0]
  assert.equal(first.amount, Math.round(100 * FOE_ADDS.poison.sizes[2]))
  assert.equal(first.life, playerOf(state).life)
  // At the last of one's life it takes nothing.
  const low = fight([{ id: 'poison', size: 'large' }])
  const poisoned = until(low, 'afflict').state
  if (!poisoned.over) {
    playerOf(poisoned).life = 1
    playerOf(poisoned).poison = 3
    foesOf(poisoned)[0].stun = 5
    const after = step(poisoned, { kind: 'guard' })
    assert.equal(of(after.events, 'sap').length, 0)
    assert.equal(playerOf(after.state).life, 1)
  }
})

test('削弱 and 破绽: whom it strikes deals less, or takes more, for the rounds that follow', () => {
  const weak = until(fight([{ id: 'weaken', size: 'large' }]), 'afflict').state
  assert.ok(playerOf(weak).weak > 0)
  assert.equal(playerOf(weak).weakBy, FOE_ADDS.weaken.sizes[2])
  // The same blow on the same dice, with and without it.
  const blowOf = state => of(step(state, { kind: 'attack', target: 'foe-0' }).events, 'hit')[0].amount
  const clear = { ...weak, units: weak.units.map(unit => (unit.id === 'player' ? { ...unit, weak: 0 } : unit)) }
  assert.ok(blowOf(weak) < blowOf(clear))
  const open = until(fight([{ id: 'expose', size: 'large' }]), 'afflict').state
  assert.ok(playerOf(open).open > 0)
  const takenOf = state => of(step({ ...state, units: state.units.map(unit => (unit.side === 'foe' ? { ...unit, charging: false, stun: 0 } : unit)) }, { kind: 'attack', target: 'foe-0' }).events, 'struck')[0]?.amount ?? 0
  const shut = { ...open, units: open.units.map(unit => (unit.id === 'player' ? { ...unit, open: 0 } : unit)) }
  if (!open.over) assert.ok(takenOf(open) >= takenOf(shut))
  // They wear off.
  let later = open
  for (let i = 0; i < 6 && !later.over; i++) later = step({ ...later, units: later.units.map(unit => (unit.side === 'foe' ? { ...unit, stun: 2, charging: false } : unit)) }, { kind: 'guard' }).state
  if (!later.over) assert.ok(!(playerOf(later).open > 0), 'gone when no blow renews it')
})

test('眩晕: the action is lost, whatever was chosen, and not twice running', () => {
  let found = null
  for (let seed = 0; seed < 40 && !found; seed++) {
    const out = until(fight([{ id: 'stun', size: 'large' }], { seed: `stun${seed}` }), 'afflict')
    if (!out.state.over && playerOf(out.state).stun > 0) found = out.state
  }
  assert.ok(found, 'a foe that stuns does, within a few fights')
  const life = foesOf(found)[0].life
  const { state, events } = step(found, { kind: 'attack', target: 'foe-0' })
  assert.deepEqual(of(events, 'stunned').map(event => event.by), ['player'])
  assert.equal(of(events, 'hit').length, 0)
  assert.ok(foesOf(state)[0].life >= life, 'no blow was struck')
  assert.ok(!(playerOf(state).stun > 0 && of(events, 'afflict').some(event => event.status === 'stun')), 'not stunned again in the round it was lost')
  // One stunned does not brace either.
  const braced = step(found, { kind: 'guard' })
  assert.equal(of(braced.events, 'guard').length, 0)
})

test('吸取: the foe mends by a share of what its blow dealt', () => {
  const state = fight([{ id: 'leech', size: 'large' }])
  foesOf(state)[0].life -= 30
  const { state: after, events } = until(state, 'drain')
  const drained = of(events, 'drain')[0]
  const blow = of(events, 'struck').at(-1)
  assert.equal(drained.amount, Math.max(1, Math.round(blow.amount * FOE_ADDS.leech.sizes[2])))
  assert.equal(drained.life, foesOf(after)[0].life)
  // Whole, it has nothing to mend.
  assert.equal(of(until(fight([{ id: 'leech', size: 'large' }]), 'struck').events, 'drain').length, 0)
})

test('净化 takes what a foe\'s blows left, from whom the skill reaches; in a party these land on whoever was struck', () => {
  const state = until(fight([{ id: 'poison', size: 'medium' }, { id: 'expose', size: 'small' }], { kinds: { 甲: 'ward' }, skillAdds: { 甲: [{ id: 'cleanse' }] } }), 'afflict').state
  assert.ok(playerOf(state).poison > 0 && playerOf(state).open > 0)
  const still = { ...state, units: state.units.map(unit => (unit.side === 'foe' ? { ...unit, stun: 3, charging: false } : unit)) }
  const { state: clean, events } = step(still, { kind: 'skill', name: '甲' })
  assert.deepEqual(of(events, 'cleansed').map(event => event.target), ['player'])
  assert.ok(!(playerOf(clean).poison > 0) && !(playerOf(clean).open > 0))
  assert.equal(of(events, 'sap').length, 0)
  // A party.
  const party = fight([{ id: 'poison', size: 'medium' }], { allies: [friend('友')] })
  const out = until(party, 'afflict', [{ who: 'player', kind: 'guard' }, { who: 'ally-0', kind: 'guard' }])
  const hit = of(out.events, 'afflict')[0]
  assert.ok(['player', 'ally-0'].includes(hit.target))
  assert.equal(of(out.events, 'sap')[0].target, hit.target)
})

test('a fight with such a foe plays through by itself, and is a little harder than one without', () => {
  const setup = adds => battleSetup(sheet({ things: [] }), { foes: fieldFoes([{ name: '敌', count: 1, tier: 'boss', ...(adds ? { adds } : {}) }]), seed: 'sim', kinds: { 甲: 'strike' } })
  const plain = simulate(setup(null), 400).chance
  for (const id of FOE_ADD_IDS) {
    const chance = simulate(setup([{ id, size: 'large' }]), 400).chance
    assert.ok(chance <= plain + 6 && chance >= plain - 30, `${id}: ${chance} beside ${plain}`)
  }
  const both = simulate(setup([{ id: 'poison', size: 'medium' }, { id: 'leech', size: 'small' }]), 400).chance
  assert.ok(both < plain && both > plain - 35, `two: ${both} beside ${plain}`)
})

test('the bestiary keeps them, a kit brings them, and the fight a reply stops on has them', () => {
  const book = cleanRulebook({ level: 'full', foes: { 狼王: { looks: 'wolf', moves: ['撕咬'], adds: [{ id: 'poison', size: 'large' }, { id: 'nope' }, { id: 'leech', size: 'large' }] }, 灰狼: { looks: 'wolf', moves: [] } } })
  assert.deepEqual(book.foes.狼王.adds, [{ id: 'poison', size: 'large' }])
  assert.equal(book.foes.灰狼.adds, undefined)
  const kit = cleanKit({ foes: [{ name: '尸王', looks: 'x', moves: ['爪'], adds: [{ id: 'leech', size: 'small' }, { id: 'expose', size: 'medium' }] }, { name: '行尸', looks: 'y', moves: [] }] })
  assert.deepEqual(kitBook(kit).foes, { 尸王: { looks: 'x', moves: ['爪'], adds: [{ id: 'leech', size: 'small' }, { id: 'expose', size: 'medium' }] }, 行尸: { looks: 'y', moves: [] } })
  const player = sheetOf(book, null, {})
  const setup = encounterSetup(player, book, { foes: [{ name: '狼王', count: 1, tier: 'elite' }, { name: '灰狼', count: 2, tier: 'minion' }] }, 'c', 'n')
  assert.deepEqual(setup.foes[0].adds, [{ id: 'poison', size: 'large' }], 'as the bestiary has them')
  assert.equal(setup.foes[1].adds, undefined)
  const shown = foeSheets(setup)
  assert.deepEqual(shown[0].adds, [{ id: 'poison', size: 'medium' }], 'the panel shows what an elite keeps of them')
  assert.equal(shown[1].adds, undefined)
  // As an ordinary foe the same kind has none.
  assert.equal(foeSheets(encounterSetup(player, book, { foes: [{ name: '狼王', count: 1, tier: 'normal' }] }, 'c', 'n'))[0].adds, undefined)
  // And it settles as any other fight.
  const result = fightResult(setup, playedOut(setup))
  assert.ok(['won', 'lost'].includes(result.battle.over))
})

test('the models that write foes are asked for every add there is, and what they write is read', () => {
  const ask = foeAddsAsk()
  for (const id of FOE_ADD_IDS) assert.ok(ask.includes(`${id}（`), id)
  assert.ok(suggestRequest({ description: '末日废土' , book: { entries: [] } }, []).messages[0].content.includes(ask))
  assert.ok(foesRequest(['尸王'], '废土').messages[0].content.includes('"adds"'))
  const read = parseFoes('[{"name":"尸王","looks":"zombie king","moves":["撕咬"],"adds":[{"id":"leech","size":"medium"},{"id":"fly"}]},{"name":"行尸","looks":"zombie","moves":[]}]', ['尸王', '行尸'])
  assert.deepEqual(read.尸王.adds, [{ id: 'leech', size: 'medium' }])
  assert.equal(read.行尸.adds, undefined)
})

test('装备: what the party has on is followed by the foes as a level is, and remembered with a foe first met', () => {
  const gear = { 铁剑: { type: 'gear', slot: 'weapon', rarity: 'common', effects: [{ id: 'attack', size: 'medium' }] }, 皮甲: { type: 'gear', slot: 'armour', rarity: 'common', effects: [{ id: 'guard', size: 'small' }, { id: 'life', size: 'small' }] } }
  const book = cleanRulebook({ level: 'full', growth: { level: 'standard' }, items: gear })
  const off = cleanRulebook({ level: 'full', items: gear })
  const bare = { ...sheetOf(book, null, {}), level: 4, things: [{ name: '铁剑', count: 1 }, { name: '皮甲', count: 1 }] }
  const worn = { ...bare, gear: { weapon: '铁剑', armour: '皮甲' } }
  assert.equal(wornWorth([bare], book), null, 'nothing on, nothing to follow')
  assert.equal(wornWorth([worn], off), null, 'nor on a card that does not count growth')
  const worth = wornWorth([worn], book)
  assert.ok(worth.deal > 0.05 && worth.deal < 0.1 && worth.take > 0.05 && worth.take < 0.12, JSON.stringify(worth))
  // Shared out over those who fight: one of two wearing it is half of it.
  assert.equal(wornWorth([worn, { name: '友', level: 4 }], book).deal, Math.round((worth.deal / 2) * 1000) / 1000)
  const plain = foesFollow(4, book)
  const more = foesFollow(4, book, 'normal', undefined, worth)
  assert.ok(more.life > plain.life && more.damage > plain.damage)
  assert.deepEqual(foesFollow(1, book, 'normal', undefined, worth), { life: 1 + 0.5 * worth.deal, damage: 1 + 0.5 * worth.take }, 'at the first level it is all there is to follow')
  // In the story: followed when met, remembered, and the same when met again with more on.
  const gate = { foes: [{ name: '山贼', count: 1, tier: 'normal', power: '相当' }] }
  const first = encounterSetup(worn, book, gate, 'c', 'a')
  assert.deepEqual(first.foes[0].up, more)
  assert.deepEqual(first.met.山贼.worn, worth)
  assert.equal(encounterSetup(bare, book, gate, 'c', 'a').met.山贼.worn, undefined)
  const { op } = fightResult(first, playedOut(first))
  const after = applyOps(worn, book, [op]).sheet
  assert.deepEqual(after.met.山贼.worn, worth)
  assert.deepEqual(sheetOf(book, keptSheet(after), {}).met.山贼.worn, worth, 'kept with the sheet')
  const again = encounterSetup({ ...after, gear: {} }, book, gate, 'c', 'b')
  assert.deepEqual(again.foes[0].up, more, 'as strong as when first met, whatever is worn now')
  // A foe with a rank of its own follows nothing, gear or no.
  const ranked = cleanRulebook({ level: 'full', growth: { level: 'standard' }, items: gear, ranks: ['炼气', '筑基'] })
  assert.equal(encounterSetup({ ...worn }, ranked, { foes: [{ name: '散修', count: 1, tier: 'normal', power: '筑基' }] }, 'c', 'n').foes[0].up, undefined)
})

test('a numbered one is the bestiary\'s kind (its picture and blows); a kind of its own is not; a full bestiary keeps its pictures', () => {
  const foes = { 异化流浪犬: { looks: 'dog', moves: [], file: 'foe-aaaaaa.png', adds: [{ id: 'poison', size: 'large' }] }, 狼: { looks: 'wolf', moves: [] } }
  for (const name of ['异化流浪犬', '异化流浪犬A', '异化流浪犬2号', '异化流浪犬 3', '异化流浪犬甲', '异化流浪犬（一）', '异化流浪犬(2)']) assert.equal(bestiaryName(foes, name), '异化流浪犬', name)
  assert.equal(bestiaryName(foes, '狼A'), '狼')
  for (const name of ['异化流浪犬头领', '狼王', '变异流浪犬', '异化流浪犬Z', '']) assert.equal(bestiaryName(foes, name), null, name)
  const book = cleanRulebook({ level: 'full', foes })
  const setup = encounterSetup(sheetOf(book, null, {}), book, { foes: [{ name: '异化流浪犬A', count: 1, tier: 'elite' }] }, 'c', 'n')
  assert.deepEqual(setup.foes[0].adds, [{ id: 'poison', size: 'large' }], 'what the bestiary says of its kind')
  // Past the limit the first ones without a picture go, not the ones drawn or uploaded.
  const many = Object.fromEntries([['有图', { looks: '', moves: [], file: 'foe-bbbbbb.png' }], ...Array.from({ length: 200 }, (_, i) => [`敌人${i}`, { looks: '', moves: [] }])])
  const kept = Object.keys(cleanRulebook({ level: 'full', foes: many }).foes)
  assert.equal(kept.length, 200)
  assert.ok(kept.includes('有图') && !kept.includes('敌人0') && kept.includes('敌人199'))
})

test('a card with a large bestiary keeps every chain of 形态 and every skill\'s 属性 (NPC pets: dozens of each)', () => {
  const owners = Array.from({ length: 30 }, (_, i) => `魔宠${i}`)
  const forms = Object.fromEntries(owners.map(name => [name, [{ name, stage: '统领级', effects: [] }, { name: `${name}·进化`, stage: '君王级', effects: [], at: { level: 13 } }]]))
  const skillTypes = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`招式${i}`, '暗影']))
  const book = cleanRulebook({ level: 'full', growth: { level: 'rich' }, types: { 暗影: ['精神'], 精神: ['暗影'] }, forms, skillTypes })
  assert.equal(Object.keys(book.forms).length, 30)
  assert.equal(Object.keys(book.skillTypes).length, 150)
})
