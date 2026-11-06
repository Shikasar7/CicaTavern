// 战斗: the rules of a fight, with no screen and no model. A fight is its setup and the actions taken, played through
// `step`: the same setup and actions always come to the same thing, so nothing but those needs keeping. Numbers are
// relative: a foe's life is so many of the player's blows, its damage a share of the player's most life, so a card
// that counts life in hundreds and one that counts in thousands fight the same. Runs on old WebViews too.
import { judge, marredBy, modifierOf, seedOf, worstAil } from './dice.js'

/** How tough a foe is. `hits`: plain blows to bring it down. `damage`: percent of the player's most life. */
export const TIERS = {
  minion: { hits: 2, damage: 7, points: 1, flee: 8 },
  normal: { hits: 3, damage: 12, points: 2, flee: 10 },
  elite: { hits: 5, damage: 16, points: 4, flee: 14, charges: true },
  boss: { hits: 8, damage: 18, points: 8, flee: null, charges: true, rages: true },
}
const TIER_ORDER = ['minion', 'normal', 'elite', 'boss']
// A foe's level, from the player's: only words, as a fight's numbers are relative anyway.
const LEVEL_OFFSET = { minion: -1, normal: 0, elite: 2, boss: 5 }
// How a foe stands to the player (rank.js): what it can take and deals, how much harder it is to get away from, the level shown for it, what it is worth.
const GAPS = {
  [-2]: { life: 0.6, damage: 0.5, flee: -2, level: -4, reward: 0.25 },
  [-1]: { life: 0.8, damage: 0.75, flee: 0, level: -2, reward: 0.5 },
  0: { life: 1, damage: 1, flee: 0, level: 0, reward: 1 },
  1: { life: 1.4, damage: 1.3, flee: 1, level: 2, reward: 1.5 },
  2: { life: 2.4, damage: 2.1, flee: 4, level: 5, reward: 2.5, shock: 5 },
  3: { life: 6, damage: 4, flee: 8, level: 12, reward: 4, shock: 12 },
}
const gapOf = foe => GAPS[foe.gap ?? 0] ?? GAPS[0]

/** What beating a foe is worth, for how it stands to the player: there is nothing to be had from those far below. */
export const rewardOf = foe => gapOf(foe).reward

/** What facing a foe does to the mind, on a card that counts it: what is far beyond the player is more than a fight. */
export const shockOf = foe => gapOf(foe).shock ?? 0
// Getting up from a lost fight, once: this much of the most life.
const RALLY_LIFE = 0.4
const MAX_FOES = 4
const BUDGET = 10
const BLOW = 10
const CRIT_CHANCE = 0.1
const CRIT = 1.5
const CHARGE_CHANCE = 0.3
const RAGE = 1.3
const GUARD = 0.5
const GUARD_ENERGY = 0.05
const BOOST = 1.3
const BOOST_ROUNDS = 3
const POISON_ROUNDS = 3
const POISON = 0.4
const STUN_CHANCE = 0.5
const ARMOUR = 0.04
const MANY_TOUGH = 0.75
const MANY_SHARE = 0.35
const DIFFICULTY = { easy: 0.8, normal: 1, hard: 1.2 }
// How much a foe can take, on top of how hard it hits.
const TOUGHNESS = { easy: 0.85, normal: 1, hard: 1.2 }
const MAX_ROUNDS = 60

/** What a skill does: how hard, at whom, and how much of the most energy it takes. */
export const SKILLS = {
  strike: { power: 1.8, cost: 0.33, target: 'one' },
  sweep: { power: 0.9, cost: 0.33, target: 'all' },
  flurry: { power: 0.9, hits: 2, cost: 0.25, target: 'one' },
  poison: { power: 0.8, cost: 0.25, target: 'one', status: 'poison' },
  stun: { power: 0.8, cost: 0.33, target: 'one', status: 'stun' },
  heal: { heal: 0.3, cost: 0.33, target: 'self' },
  boost: { cost: 0.25, target: 'self', status: 'boost' },
}
const DEFAULT_SKILLS = ['强击', '横扫']
const SKILL_WORDS = [[/[扫群旋]|全弹|新星/, 'sweep'], [/连/, 'flurry'], [/毒/, 'poison'], [/[晕震定]|脉冲|麻痹|冰封/, 'stun'], [/[疗愈回]|修复|急救/, 'heal'], [/[护势气]|祝福|强化|增幅|过载/, 'boost']]
const ITEM_HEAL = { small: 0.25, medium: 0.5, large: 1 }
const ITEM_ENERGY = { small: 0.33, medium: 0.66, large: 1 }
const ITEM_DAMAGE = { small: 2, medium: 3, large: 5 }

/** A skill's kind by its name, for one nobody has set. */
export const skillKindOf = name => SKILL_WORDS.find(([word]) => word.test(name))?.[1] ?? 'strike'

/**
 * The foes of a fight from what a mark asks for: four at most, and if they add up to more than a player
 * can face, the last of them come down a tier at a time until they do not.
 */
export function fieldFoes(groups) {
  const foes = []
  for (const group of groups) {
    for (let i = 0; i < group.count && foes.length < MAX_FOES; i++) foes.push({ name: group.name, tier: group.tier, ...(group.gap ? { gap: group.gap } : {}), ...(group.rank ? { rank: group.rank } : {}) })
  }
  const points = () => foes.reduce((sum, foe) => sum + TIERS[foe.tier].points, 0)
  for (let at = foes.length - 1; at >= 0 && points() > BUDGET; at--) {
    while (foes[at].tier !== 'minion' && points() > BUDGET) foes[at].tier = TIER_ORDER[TIER_ORDER.indexOf(foes[at].tier) - 1]
  }
  return foes
}

/**
 * What a fight needs from the sheet, plain data that a fight can be replayed from.
 * @param effects - name → what a thing does (sheet.js effectOf).
 * @param kinds - name → a skill's kind, for those set on the card.
 */
export function battleSetup(sheet, { foes, seed, difficulty = 'normal', effects = () => null, kinds = {} }) {
  const strain = sheet.strain ?? []
  const of = id => modifierOf(sheet.attributes[id]) - marredBy([...(sheet.conditions ?? []), ...strain], id)
  return {
    seed,
    difficulty,
    foes,
    player: {
      level: sheet.level ?? 1,
      life: sheet.life,
      maxLife: sheet.maxLife,
      // Every fight starts rested, unless the card counts it itself.
      energy: sheet.bound?.includes('energy') ? sheet.energy : sheet.maxEnergy,
      maxEnergy: sheet.maxEnergy,
      modifiers: { body: of('body'), grace: of('grace'), mind: of('mind') },
      ails: (sheet.conditions ?? []).map(({ name, stat, size }) => ({ name, stat, size })),
      strain,
      ...(sheet.sanity === undefined ? {} : { counts: { sanity: true } }),
      skills: (sheet.skills.length ? sheet.skills : DEFAULT_SKILLS).map(name => ({ name, kind: kinds[name] ?? skillKindOf(name) })),
      things: sheet.things.map(thing => ({ name: thing.name, count: thing.count, effect: effects(thing.name) })).filter(thing => thing.effect && thing.effect.type !== 'none' && thing.effect.type !== 'calm'),
    },
  }
}

/** The same fight begun again: the dice are new. */
export const attemptSetup = (setup, attempt) => (attempt ? { ...setup, seed: `${setup.seed}:${attempt}` } : setup)

/** A fight at its first round. */
export function startBattle(setup) {
  const many = setup.foes.length > 1
  const share = 1 / (1 + MANY_SHARE * (setup.foes.length - 1))
  const foes = setup.foes.map((foe, i) => {
    const tier = TIERS[foe.tier]
    const gap = gapOf(foe)
    const life = Math.round(tier.hits * BLOW * (many ? MANY_TOUGH : 1) * (TOUGHNESS[setup.difficulty] ?? 1) * gap.life)
    return { id: `foe-${i}`, side: 'foe', name: foe.name, tier: foe.tier, gap: foe.gap ?? 0, life, maxLife: life, damage: (tier.damage / 100) * share * gap.damage, charging: false, poison: 0, stun: 0 }
  })
  const { player } = setup
  return {
    round: 1,
    rng: seedOf('battle', String(setup.seed)),
    difficulty: setup.difficulty,
    units: [{ id: 'player', side: 'player', life: player.life, maxLife: player.maxLife, energy: player.energy, maxEnergy: player.maxEnergy, modifiers: player.modifiers, guarding: false, boost: 0 }, ...foes],
    skills: player.skills,
    things: player.things.map(thing => ({ ...thing })),
    used: {},
    ails: player.ails ?? [],
    strain: player.strain ?? [],
    cured: [],
    over: null,
    rallied: false,
    moments: [],
  }
}

/** What a fight's foes are before a blow is struck, for the panel in front of it. */
export function foeSheets(setup) {
  const { level = 1, maxLife } = setup.player
  return startBattle(setup).units.slice(1).map((foe, i) => ({
    name: foe.name,
    tier: foe.tier,
    gap: foe.gap,
    rank: setup.foes[i].rank ?? '',
    level: Math.max(1, level + LEVEL_OFFSET[foe.tier] + gapOf(foe).level),
    life: foe.maxLife,
    attack: Math.round(maxLife * foe.damage * DIFFICULTY[setup.difficulty]),
    charges: Boolean(TIERS[foe.tier].charges),
    noEscape: TIERS[foe.tier].flee === null,
  }))
}

const copy = state => ({
  ...state,
  units: state.units.map(unit => ({ ...unit })),
  things: state.things.map(thing => ({ ...thing })),
  used: { ...state.used },
  cured: state.cured.slice(),
  moments: state.moments.slice(),
})

export const playerOf = state => state.units[0]
export const foesOf = state => state.units.slice(1)
export const aliveFoes = state => foesOf(state).filter(foe => foe.life > 0)

/** The next number of the fight's own dice: the same fight rolls the same (mulberry32). */
function random(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0
  let mixed = Math.imul(state.rng ^ (state.rng >>> 15), state.rng | 1)
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
}

/** What a skill costs here. */
export const skillCost = (state, skill) => Math.ceil(playerOf(state).maxEnergy * SKILLS[skill.kind].cost - 1e-9)

/** Whether the player can still get up from this: once a fight, and only from being brought down. */
export const canRally = state => state.over === 'lost' && !state.rallied && playerOf(state).life === 0

/** Why an action cannot be done now, or null when it can. The words are the screen's. */
export function refusal(state, action) {
  if (action.kind === 'rally') return canRally(state) ? null : 'over'
  if (state.over) return 'over'
  const foe = action.target ? state.units.find(unit => unit.id === action.target && unit.side === 'foe' && unit.life > 0) : null
  if (action.kind === 'attack') return foe ? null : 'target'
  if (action.kind === 'guard') return null
  if (action.kind === 'flee') return aliveFoes(state).some(item => TIERS[item.tier].flee === null) ? 'boss' : null
  if (action.kind === 'skill') {
    const skill = state.skills.find(item => item.name === action.name)
    if (!skill) return 'unknown'
    if (playerOf(state).energy < skillCost(state, skill)) return 'energy'
    return SKILLS[skill.kind].target === 'one' && !foe ? 'target' : null
  }
  if (action.kind === 'item') {
    const thing = state.things.find(item => item.name === action.name && item.count > 0)
    if (!thing) return 'unknown'
    if (thing.effect.type === 'cure' && !state.ails.length) return 'nothing'
    return thing.effect.type === 'damage' && !foe ? 'target' : null
  }
  return 'unknown'
}

/** Whether an action needs a foe picked. */
export function needsTarget(state, action) {
  if (action.kind === 'attack') return true
  if (action.kind === 'skill') return SKILLS[state.skills.find(item => item.name === action.name)?.kind]?.target === 'one'
  if (action.kind === 'item') return state.things.find(item => item.name === action.name)?.effect.type === 'damage'
  return false
}

function blow(state, foe, power, events, stat = 'body') {
  const player = playerOf(state)
  const crit = random(state) < CRIT_CHANCE
  const swing = 0.9 + random(state) * 0.2
  const amount = Math.max(1, Math.round(BLOW * (1 + 0.1 * player.modifiers[stat]) * (player.boost > 0 ? BOOST : 1) * power * swing * (crit ? CRIT : 1)))
  foe.life = Math.max(0, foe.life - amount)
  events.push({ type: 'hit', target: foe.id, amount, crit, life: foe.life })
  if (crit) state.moments.push({ round: state.round, kind: 'crit', foe: foe.name })
  if (foe.life === 0) events.push({ type: 'down', target: foe.id })
}

const giveLife = (state, share, events) => {
  const player = playerOf(state)
  const amount = Math.min(player.maxLife - player.life, Math.round(player.maxLife * share))
  player.life += amount
  events.push({ type: 'heal', amount, life: player.life })
}

const giveEnergy = (state, share, events) => {
  const player = playerOf(state)
  const amount = Math.min(player.maxEnergy - player.energy, Math.round(player.maxEnergy * share))
  player.energy += amount
  events.push({ type: 'energy', amount, energy: player.energy })
}

function useSkill(state, skill, target, events) {
  const rule = SKILLS[skill.kind]
  const player = playerOf(state)
  player.energy -= skillCost(state, skill)
  events.push({ type: 'skill', name: skill.name, energy: player.energy })
  state.used[`skill:${skill.name}`] = (state.used[`skill:${skill.name}`] ?? 0) + 1
  if (rule.heal) giveLife(state, rule.heal, events)
  if (rule.status === 'boost') {
    player.boost = BOOST_ROUNDS
    events.push({ type: 'status', target: 'player', status: 'boost' })
  }
  if (!rule.power) return
  for (const foe of rule.target === 'all' ? aliveFoes(state) : [target]) {
    for (let i = 0; i < (rule.hits ?? 1) && foe.life > 0; i++) blow(state, foe, rule.power, events, 'mind')
    if (foe.life > 0 && rule.status === 'poison') {
      foe.poison = POISON_ROUNDS
      events.push({ type: 'status', target: foe.id, status: 'poison' })
    }
    if (foe.life > 0 && rule.status === 'stun' && random(state) < STUN_CHANCE) {
      foe.stun = 1
      foe.charging = false
      events.push({ type: 'status', target: foe.id, status: 'stun' })
    }
  }
}

/** The worst of what holds the player back goes, here and on the sheet afterwards. */
function cure(state, events) {
  const player = playerOf(state)
  const ail = worstAil(state.ails)
  const left = state.ails.filter(item => item !== ail)
  player.modifiers = Object.fromEntries(Object.entries(player.modifiers).map(([stat, value]) => [stat, value + marredBy([...state.ails, ...state.strain], stat) - marredBy([...left, ...state.strain], stat)]))
  state.ails = left
  state.cured.push(ail.name)
  events.push({ type: 'cure', name: ail.name })
}

function useThing(state, thing, target, events) {
  thing.count -= 1
  state.used[thing.name] = (state.used[thing.name] ?? 0) + 1
  events.push({ type: 'item', name: thing.name })
  const { type, size } = thing.effect
  if (type === 'heal') giveLife(state, ITEM_HEAL[size], events)
  else if (type === 'energy') giveEnergy(state, ITEM_ENERGY[size], events)
  else if (type === 'cure') cure(state, events)
  else if (type === 'boost') {
    playerOf(state).boost = BOOST_ROUNDS
    events.push({ type: 'status', target: 'player', status: 'boost' })
  } else if (type === 'damage') {
    target.life = Math.max(0, target.life - BLOW * ITEM_DAMAGE[size])
    events.push({ type: 'hit', target: target.id, amount: BLOW * ITEM_DAMAGE[size], crit: false, life: target.life })
    if (target.life === 0) events.push({ type: 'down', target: target.id })
  }
}

function tryToFlee(state, events) {
  const player = playerOf(state)
  const dc = Math.max(...aliveFoes(state).map(foe => TIERS[foe.tier].flee + gapOf(foe).flee))
  const roll = 1 + Math.floor(random(state) * 20)
  const result = judge(roll, player.modifiers.grace, dc)
  events.push({ type: 'flee', ...result })
  if (result.tier !== 'fail') state.over = 'fled'
}

function foeActs(state, foe, events) {
  const player = playerOf(state)
  if (foe.stun > 0) {
    foe.stun -= 1
    events.push({ type: 'stunned', by: foe.id })
    return
  }
  const tier = TIERS[foe.tier]
  const charged = foe.charging
  if (!charged && tier.charges && random(state) < CHARGE_CHANCE) {
    foe.charging = true
    events.push({ type: 'charge', by: foe.id })
    return
  }
  foe.charging = false
  const crit = random(state) < CRIT_CHANCE
  const swing = 0.75 + random(state) * 0.5
  const rage = tier.rages && !charged && foe.life < foe.maxLife / 2 ? RAGE : 1
  const armour = 1 - ARMOUR * player.modifiers.body
  const amount = Math.max(1, Math.round(player.maxLife * foe.damage * DIFFICULTY[state.difficulty] * armour * swing * rage * (charged ? 2 : 1) * (crit ? CRIT : 1) * (player.guarding ? GUARD : 1)))
  player.life = Math.max(0, player.life - amount)
  events.push({ type: 'struck', by: foe.id, amount, crit, charged, life: player.life })
  if (charged) state.moments.push({ round: state.round, kind: 'charged', foe: foe.name })
}

function endRound(state, events) {
  const player = playerOf(state)
  for (const foe of aliveFoes(state)) {
    if (foe.poison <= 0) continue
    foe.poison -= 1
    const amount = Math.max(1, Math.round(BLOW * POISON))
    foe.life = Math.max(0, foe.life - amount)
    events.push({ type: 'poison', target: foe.id, amount, life: foe.life })
    if (foe.life === 0) events.push({ type: 'down', target: foe.id })
  }
  player.guarding = false
  if (player.boost > 0) player.boost -= 1
}

/** Up again with what is left, at a price the sheet settles afterwards. The foes do not get a blow in for it. */
function rally(state, events) {
  const player = playerOf(state)
  state.over = null
  state.rallied = true
  player.life = Math.round(player.maxLife * RALLY_LIFE)
  player.energy = player.maxEnergy
  events.push({ type: 'rally', life: player.life, energy: player.energy })
}

/** One action and all that follows from it, to the next choice. → { state, events } */
export function step(before, action) {
  const reason = refusal(before, action)
  if (reason) throw new Error(`battle: ${reason}`)
  const state = copy(before)
  const events = []
  const player = playerOf(state)
  const target = action.target ? state.units.find(unit => unit.id === action.target) : null
  if (action.kind === 'rally') rally(state, events)
  else if (action.kind === 'attack') blow(state, target, 1, events)
  else if (action.kind === 'guard') {
    player.guarding = true
    events.push({ type: 'guard' })
    giveEnergy(state, GUARD_ENERGY, events)
  } else if (action.kind === 'flee') tryToFlee(state, events)
  else if (action.kind === 'skill') useSkill(state, state.skills.find(item => item.name === action.name), target, events)
  else useThing(state, state.things.find(item => item.name === action.name && item.count > 0), target, events)
  if (!state.over && aliveFoes(state).length && action.kind !== 'rally') {
    for (const foe of aliveFoes(state)) {
      foeActs(state, foe, events)
      if (player.life === 0) break
    }
  }
  if (!state.over && player.life > 0) endRound(state, events)
  if (!state.over && !aliveFoes(state).length) state.over = 'won'
  else if (!state.over && player.life === 0) state.over = 'lost'
  else if (!state.over && state.round >= MAX_ROUNDS) state.over = 'lost'
  if (state.over) events.push({ type: 'over', result: state.over })
  else {
    state.round += 1
    events.push({ type: 'round', round: state.round })
  }
  return { state, events }
}

/** A fight replayed from what was done: all a page needs to keep to come back to it. */
export function replay(setup, actions) {
  let state = startBattle(setup)
  for (const action of actions) state = step(state, action).state
  return state
}

const weakest = state => aliveFoes(state).reduce((least, foe) => (foe.life < least.life ? foe : least))

/** What 自动 does, and what a chance is worked out with: drink when the next blows could end it, brace for a charge, hit hardest. */
export function autoAction(state) {
  const player = playerOf(state)
  const foes = aliveFoes(state)
  const armour = 1 - ARMOUR * player.modifiers.body
  const incoming = foes.reduce((sum, foe) => sum + player.maxLife * foe.damage * (foe.charging ? 2 : 1), 0) * armour * DIFFICULTY[state.difficulty]
  const healing = state.things.find(thing => thing.count > 0 && thing.effect.type === 'heal')
  if (player.life <= incoming * 1.1 && healing) return { kind: 'item', name: healing.name }
  const charging = foes.find(foe => foe.charging)
  if (charging && charging.life > BLOW * SKILLS.strike.power * 1.2) return { kind: 'guard' }
  const skills = state.skills.filter(skill => SKILLS[skill.kind].power && player.energy >= skillCost(state, skill))
  const sweep = foes.length > 1 ? skills.find(skill => skill.kind === 'sweep') : null
  if (sweep) return { kind: 'skill', name: sweep.name }
  const hardest = skills.filter(skill => SKILLS[skill.kind].target === 'one').sort((a, b) => SKILLS[b.kind].power * (SKILLS[b.kind].hits ?? 1) - SKILLS[a.kind].power * (SKILLS[a.kind].hits ?? 1))[0]
  if (hardest) return { kind: 'skill', name: hardest.name, target: weakest(state).id }
  return { kind: 'attack', target: weakest(state).id }
}

/**
 * Fights played through with 自动, each on its own dice.
 * → { chance (percent won), rounds, left (percent of the most life, after a win) }
 */
export function simulate(setup, runs) {
  let wins = 0
  let rounds = 0
  let left = 0
  for (let i = 0; i < runs; i++) {
    let state = startBattle({ ...setup, seed: `${setup.seed}:${i}` })
    while (!state.over) state = step(state, autoAction(state)).state
    rounds += state.round
    if (state.over === 'won') {
      wins += 1
      left += (playerOf(state).life / playerOf(state).maxLife) * 100
    }
  }
  return { chance: (wins / runs) * 100, rounds: rounds / runs, left: wins ? left / wins : 0 }
}
