// 战斗: the rules of a fight, with no screen and no model. A fight is its setup and the actions taken, played through
// `step`: the same setup and actions always come to the same thing, so nothing but those needs keeping. Numbers are
// relative: a foe's life is so many of the player's blows, its damage a share of the most life of whoever it strikes,
// so a card that counts life in hundreds and one that counts in thousands fight the same. Runs on old WebViews too.
//
// 队伍: the player may stand with up to three others (setup.allies), each with their own attributes, life, energy and
// skills. A round is then as in RPG Maker: every one of the party who can still act is given a command, and then all,
// foes too, act in the order of their speed. A fight of the player alone keeps the order it always had (the player,
// then the foes in turn) and rolls nothing more, so its dice, and so its outcomes, are what they were.
import { judge, marredBy, modifierOf, seedOf, worstAil } from './dice.js'

/** How tough a foe is. `hits`: plain blows to bring it down. `damage`: percent of the most life of whom it strikes. */
export const TIERS = {
  minion: { hits: 2, damage: 7, points: 1, flee: 8, speed: 0 },
  normal: { hits: 3, damage: 12, points: 2, flee: 10, speed: 1 },
  elite: { hits: 5, damage: 16, points: 4, flee: 14, speed: 2, charges: true },
  boss: { hits: 8, damage: 18, points: 8, flee: null, speed: 3, charges: true, rages: true },
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
/** The most who stand on the player's side: the player and three. */
export const MAX_PARTY = 4
const BUDGET = 10
// More foes, or tougher ones, for each one more who stands with the player.
const BUDGET_PER_MEMBER = 5
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
// What a party of so many does to the foes (index: how many stand on the player's side), worked out by `simulate`
// so that a fight is about as hard with four as with one: see plans/13.
const PARTY_LIFE = [1, 1, 1.85, 2.75, 3.7]
// How many times a foe acts in a round, on average: its blows stay the size they are, there are more of them.
const PARTY_PACE = [1, 1, 1.75, 2.5, 3.25]
// A foe that stands alone gets this share of the more: a party falls on it from every side, but each of its blows is bigger.
const LONE_PACE = 0.75
// How far speed is rolled about a unit's own: a d4.
const SPEED_SPREAD = 4
// A guard draws blows: twice as likely to be the one struck.
const GUARD_DRAW = 2
// What one brought back up in a fight gets: a share of the most life.
const REVIVE_LIFE = 0.25

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
// What may be given to one of the party other than the one who uses it.
const FOR_ANOTHER = new Set(['heal', 'energy', 'boost'])

/** A skill's kind by its name, for one nobody has set. */
export const skillKindOf = name => SKILL_WORDS.find(([word]) => word.test(name))?.[1] ?? 'strike'

/**
 * The foes of a fight from what a mark asks for: four at most, and if they add up to more than the party
 * can face, the last of them come down a tier at a time until they do not.
 * @param members - how many stand on the player's side, the player too.
 */
export function fieldFoes(groups, { members = 1 } = {}) {
  const budget = BUDGET + BUDGET_PER_MEMBER * (Math.min(MAX_PARTY, Math.max(1, members)) - 1)
  const foes = []
  for (const group of groups) {
    for (let i = 0; i < group.count && foes.length < MAX_FOES; i++) foes.push({ name: group.name, tier: group.tier, ...(group.gap ? { gap: group.gap } : {}), ...(group.rank ? { rank: group.rank } : {}) })
  }
  const points = () => foes.reduce((sum, foe) => sum + TIERS[foe.tier].points, 0)
  for (let at = foes.length - 1; at >= 0 && points() > budget; at--) {
    while (foes[at].tier !== 'minion' && points() > budget) foes[at].tier = TIER_ORDER[TIER_ORDER.indexOf(foes[at].tier) - 1]
  }
  return foes
}

const skillsFrom = (names, kinds) => (names.length ? names : DEFAULT_SKILLS).map(name => ({ name, kind: kinds[name] ?? skillKindOf(name) }))

/**
 * What a fight needs from the sheet, plain data that a fight can be replayed from.
 * @param effects - name → what a thing does (sheet.js effectOf).
 * @param kinds - name → a skill's kind, for those set on the card.
 * @param allies - who stands with the player, at most three: { name, level, attributes, life, maxLife, energy, maxEnergy, skills: [names], kinds }.
 */
export function battleSetup(sheet, { foes, seed, difficulty = 'normal', effects = () => null, kinds = {}, allies = [] }) {
  const strain = sheet.strain ?? []
  const of = id => modifierOf(sheet.attributes[id]) - marredBy([...(sheet.conditions ?? []), ...strain], id)
  const others = allies.slice(0, MAX_PARTY - 1).map(member => ({
    name: String(member.name),
    level: member.level ?? sheet.level ?? 1,
    life: member.life,
    maxLife: member.maxLife,
    energy: member.energy ?? member.maxEnergy,
    maxEnergy: member.maxEnergy,
    modifiers: { body: modifierOf(member.attributes?.body), grace: modifierOf(member.attributes?.grace), mind: modifierOf(member.attributes?.mind) },
    skills: skillsFrom(member.skills ?? [], { ...kinds, ...(member.kinds ?? {}) }),
  }))
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
      skills: skillsFrom(sheet.skills, kinds),
      things: sheet.things.map(thing => ({ name: thing.name, count: thing.count, effect: effects(thing.name) })).filter(thing => thing.effect && thing.effect.type !== 'none' && thing.effect.type !== 'calm'),
    },
    ...(others.length ? { allies: others } : {}),
  }
}

/** The same fight begun again: the dice are new. */
export const attemptSetup = (setup, attempt) => (attempt ? { ...setup, seed: `${setup.seed}:${attempt}` } : setup)

/** How many stand on the player's side in a fight's setup. */
export const partySize = setup => 1 + Math.min(MAX_PARTY - 1, setup.allies?.length ?? 0)

/** A fight at its first round. */
export function startBattle(setup) {
  const many = setup.foes.length > 1
  const share = 1 / (1 + MANY_SHARE * (setup.foes.length - 1))
  const members = partySize(setup)
  const foes = setup.foes.map((foe, i) => {
    const tier = TIERS[foe.tier]
    const gap = gapOf(foe)
    const life = Math.round(tier.hits * BLOW * (many ? MANY_TOUGH : 1) * (TOUGHNESS[setup.difficulty] ?? 1) * gap.life * PARTY_LIFE[members])
    return { id: `foe-${i}`, side: 'foe', name: foe.name, tier: foe.tier, gap: foe.gap ?? 0, life, maxLife: life, damage: (tier.damage / 100) * share * gap.damage, pace: 1 + (PARTY_PACE[members] - 1) * (many ? 1 : LONE_PACE), tempo: 0, charging: false, poison: 0, stun: 0 }
  })
  const { player } = setup
  const allies = (setup.allies ?? []).slice(0, MAX_PARTY - 1).map((ally, i) => ({ id: `ally-${i}`, side: 'player', ally: true, name: ally.name, life: ally.life, maxLife: ally.maxLife, energy: ally.energy, maxEnergy: ally.maxEnergy, modifiers: ally.modifiers, skills: ally.skills, guarding: false, boost: 0 }))
  return {
    round: 1,
    rng: seedOf('battle', String(setup.seed)),
    difficulty: setup.difficulty,
    units: [{ id: 'player', side: 'player', life: player.life, maxLife: player.maxLife, energy: player.energy, maxEnergy: player.maxEnergy, modifiers: player.modifiers, guarding: false, boost: 0 }, ...allies, ...foes],
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
  return foesOf(startBattle(setup)).map((foe, i) => ({
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
/** The player's side: the player first, then whoever stands with them. */
export const partyOf = state => state.units.filter(unit => unit.side === 'player')
export const alivePartyOf = state => partyOf(state).filter(unit => unit.life > 0)
export const alliesOf = state => partyOf(state).slice(1)
export const foesOf = state => state.units.filter(unit => unit.side === 'foe')
export const aliveFoes = state => foesOf(state).filter(foe => foe.life > 0)
const unitOf = (state, id) => state.units.find(unit => unit.id === id) ?? null
/** Whose turn an action is: the player unless it says. */
const actorOf = (state, action) => unitOf(state, action?.who ?? 'player')
const partyMember = (state, id) => { const unit = unitOf(state, id); return unit?.side === 'player' ? unit : null }
/** What one of the party can do: the player's skills are the fight's, the others bring their own. */
export const skillsOf = (state, unit = playerOf(state)) => (unit.id === 'player' ? state.skills : unit.skills ?? [])
const solo = state => partyOf(state).length === 1

/** The next number of the fight's own dice: the same fight rolls the same (mulberry32). */
function random(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0
  let mixed = Math.imul(state.rng ^ (state.rng >>> 15), state.rng | 1)
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
}

/** What a skill costs here, for whom uses it. */
export const skillCost = (state, skill, unit = playerOf(state)) => Math.ceil(unit.maxEnergy * SKILLS[skill.kind].cost - 1e-9)

/** Whether the player can still get up from this: once a fight, and only from being brought down. */
export const canRally = state => state.over === 'lost' && !state.rallied && playerOf(state).life === 0

const foeAt = (state, id) => { const unit = id ? unitOf(state, id) : null; return unit?.side === 'foe' && unit.life > 0 ? unit : null }

/** Why an action cannot be done now, or null when it can. The words are the screen's. */
export function refusal(state, action) {
  if (action.kind === 'rally') return (action.who ?? 'player') === 'player' && canRally(state) ? null : 'over'
  if (state.over) return 'over'
  const actor = actorOf(state, action)
  if (!actor || actor.side !== 'player') return 'who'
  if (actor.life <= 0) return 'down'
  const foe = foeAt(state, action.target)
  if (action.kind === 'attack') return foe ? null : 'target'
  if (action.kind === 'guard') return null
  if (action.kind === 'flee') {
    if (actor.id !== 'player') return 'who'
    return aliveFoes(state).some(item => TIERS[item.tier].flee === null) ? 'boss' : null
  }
  if (action.kind === 'skill') {
    const skill = skillsOf(state, actor).find(item => item.name === action.name)
    if (!skill) return 'unknown'
    if (actor.energy < skillCost(state, skill, actor)) return 'energy'
    const rule = SKILLS[skill.kind]
    if (rule.target === 'one') return foe ? null : 'target'
    if (rule.heal && action.target && !solo(state) && !partyMember(state, action.target)) return 'target'
    return null
  }
  if (action.kind === 'item') {
    const thing = state.things.find(item => item.name === action.name && item.count > 0)
    if (!thing) return 'unknown'
    if (thing.effect.type === 'cure' && !state.ails.length) return 'nothing'
    if (thing.effect.type === 'damage') return foe ? null : 'target'
    if (action.target && !solo(state) && (!FOR_ANOTHER.has(thing.effect.type) || !partyMember(state, action.target))) return 'target'
    return null
  }
  return 'unknown'
}

/**
 * Why a round's commands cannot be given, or null: one each for those of the party who can still act, none for others,
 * each one possible now. A fight of the player alone may be given its one action as it is.
 */
export function roundRefusal(state, commands) {
  const list = Array.isArray(commands) ? commands : [commands]
  if (list.length === 1 && list[0]?.kind === 'rally') return refusal(state, list[0])
  if (state.over) return 'over'
  const want = alivePartyOf(state).map(unit => unit.id)
  const given = list.map(command => command?.who ?? 'player')
  if (given.length !== want.length || want.some(id => !given.includes(id))) return 'commands'
  for (const command of list) {
    if (command.kind === 'rally') return 'over'
    const reason = refusal(state, command)
    if (reason) return reason
  }
  return null
}

/** Whether an action needs a foe picked. */
export function needsTarget(state, action) {
  const actor = actorOf(state, action) ?? playerOf(state)
  if (action.kind === 'attack') return true
  if (action.kind === 'skill') return SKILLS[skillsOf(state, actor).find(item => item.name === action.name)?.kind]?.target === 'one'
  if (action.kind === 'item') return state.things.find(item => item.name === action.name)?.effect.type === 'damage'
  return false
}

/** Whether an action may be given to one of the party (a heal, a draught): then the page asks for whom. */
export function needsFriend(state, action) {
  if (solo(state)) return false
  const actor = actorOf(state, action) ?? playerOf(state)
  if (action.kind === 'skill') return Boolean(SKILLS[skillsOf(state, actor).find(item => item.name === action.name)?.kind]?.heal)
  if (action.kind === 'item') return FOR_ANOTHER.has(state.things.find(item => item.name === action.name)?.effect.type)
  return false
}

// In a fight of the party, what an event says of who did it; a fight of the player alone says it as it always did.
const byOf = (state, unit) => (solo(state) ? {} : { by: unit.id })

function blow(state, unit, foe, power, events, stat = 'body') {
  const crit = random(state) < CRIT_CHANCE
  const swing = 0.9 + random(state) * 0.2
  const amount = Math.max(1, Math.round(BLOW * (1 + 0.1 * unit.modifiers[stat]) * (unit.boost > 0 ? BOOST : 1) * power * swing * (crit ? CRIT : 1)))
  foe.life = Math.max(0, foe.life - amount)
  events.push({ type: 'hit', ...byOf(state, unit), target: foe.id, amount, crit, life: foe.life })
  if (crit) state.moments.push({ round: state.round, kind: 'crit', foe: foe.name, ...(unit.id === 'player' ? {} : { who: unit.name }) })
  if (foe.life === 0) events.push({ type: 'down', target: foe.id })
}

const giveLife = (state, unit, share, events, from = unit) => {
  if (unit.life === 0) {
    unit.life = Math.max(1, Math.round(unit.maxLife * Math.min(share, REVIVE_LIFE)))
    events.push({ type: 'revive', ...byOf(state, from), target: unit.id, life: unit.life })
    return
  }
  const amount = Math.min(unit.maxLife - unit.life, Math.round(unit.maxLife * share))
  unit.life += amount
  events.push({ type: 'heal', ...(solo(state) ? {} : { by: from.id, target: unit.id }), amount, life: unit.life })
}

const giveEnergy = (state, unit, share, events, from = unit) => {
  const amount = Math.min(unit.maxEnergy - unit.energy, Math.round(unit.maxEnergy * share))
  unit.energy += amount
  events.push({ type: 'energy', ...(solo(state) ? {} : { by: from.id, target: unit.id }), amount, energy: unit.energy })
}

const giveBoost = (state, unit, events, from = unit) => {
  unit.boost = BOOST_ROUNDS
  events.push({ type: 'status', ...(solo(state) ? {} : { by: from.id }), target: unit.id, status: 'boost' })
}

/** Who a heal, a draught or a blessing is for: the one named, if they stand with the party, or the one who gives it. */
const friendOf = (state, unit, target) => partyMember(state, target) ?? unit

function useSkill(state, unit, skill, target, events, friend) {
  const rule = SKILLS[skill.kind]
  unit.energy -= skillCost(state, skill, unit)
  events.push({ type: 'skill', ...byOf(state, unit), name: skill.name, energy: unit.energy })
  // The player's are the fight's to tell; the others keep their own.
  if (unit.id === 'player') state.used[`skill:${skill.name}`] = (state.used[`skill:${skill.name}`] ?? 0) + 1
  else if (!(unit.usedSkills ?? []).includes(skill.name)) unit.usedSkills = [...(unit.usedSkills ?? []), skill.name]
  if (rule.heal) giveLife(state, friend ?? unit, rule.heal, events, unit)
  if (rule.status === 'boost') giveBoost(state, unit, events)
  if (!rule.power) return
  for (const foe of rule.target === 'all' ? aliveFoes(state) : [target]) {
    for (let i = 0; i < (rule.hits ?? 1) && foe.life > 0; i++) blow(state, unit, foe, rule.power, events, 'mind')
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

function useThing(state, unit, thing, target, events, friend) {
  thing.count -= 1
  state.used[thing.name] = (state.used[thing.name] ?? 0) + 1
  events.push({ type: 'item', ...byOf(state, unit), name: thing.name })
  const { type, size } = thing.effect
  const whom = friend ?? unit
  if (type === 'heal') giveLife(state, whom, ITEM_HEAL[size], events, unit)
  else if (type === 'energy') giveEnergy(state, whom, ITEM_ENERGY[size], events, unit)
  else if (type === 'cure') cure(state, events)
  else if (type === 'boost') giveBoost(state, whom, events, unit)
  else if (type === 'damage') {
    target.life = Math.max(0, target.life - BLOW * ITEM_DAMAGE[size])
    events.push({ type: 'hit', ...byOf(state, unit), target: target.id, amount: BLOW * ITEM_DAMAGE[size], crit: false, life: target.life })
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

/** Whom a foe strikes: the player, when they stand alone; else one of the party, a guard more likely than the rest. */
function victimOf(state) {
  if (solo(state)) return playerOf(state)
  const alive = alivePartyOf(state)
  const weights = alive.map(unit => (unit.guarding ? GUARD_DRAW : 1))
  let roll = random(state) * weights.reduce((sum, weight) => sum + weight, 0)
  for (let i = 0; i < alive.length; i++) {
    roll -= weights[i]
    if (roll < 0) return alive[i]
  }
  return alive[alive.length - 1]
}

function foeActs(state, foe, events) {
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
  const victim = victimOf(state)
  const crit = random(state) < CRIT_CHANCE
  const swing = 0.75 + random(state) * 0.5
  const rage = tier.rages && !charged && foe.life < foe.maxLife / 2 ? RAGE : 1
  const armour = 1 - ARMOUR * victim.modifiers.body
  const amount = Math.max(1, Math.round(victim.maxLife * foe.damage * DIFFICULTY[state.difficulty] * armour * swing * rage * (charged ? 2 : 1) * (crit ? CRIT : 1) * (victim.guarding ? GUARD : 1)))
  victim.life = Math.max(0, victim.life - amount)
  events.push({ type: 'struck', by: foe.id, ...(solo(state) ? {} : { target: victim.id }), amount, crit, charged, life: victim.life })
  if (charged) state.moments.push({ round: state.round, kind: 'charged', foe: foe.name })
  if (victim.life === 0 && !solo(state)) {
    victim.fell = true
    events.push({ type: 'fallen', target: victim.id })
    if (victim.id !== 'player') state.moments.push({ round: state.round, kind: 'fallen', who: victim.name })
  }
}

function endRound(state, events) {
  for (const foe of aliveFoes(state)) {
    if (foe.poison <= 0) continue
    foe.poison -= 1
    const amount = Math.max(1, Math.round(BLOW * POISON))
    foe.life = Math.max(0, foe.life - amount)
    events.push({ type: 'poison', target: foe.id, amount, life: foe.life })
    if (foe.life === 0) events.push({ type: 'down', target: foe.id })
  }
  for (const unit of partyOf(state)) {
    unit.guarding = false
    if (unit.boost > 0) unit.boost -= 1
  }
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

/** One of the party does what they were told. A foe gone down by now is passed over for the next one standing. */
function act(state, unit, command, events) {
  const kind = command.kind
  let target = command.target ? unitOf(state, command.target) : null
  if (target?.side === 'foe' && target.life === 0) target = aliveFoes(state)[0] ?? null
  const friend = command.target ? partyMember(state, command.target) : null
  if (kind === 'attack') blow(state, unit, target, 1, events)
  else if (kind === 'guard') {
    // Already braced at the start of the round: only the breath it gives back is left.
  } else if (kind === 'flee') tryToFlee(state, events)
  else if (kind === 'skill') {
    const skill = skillsOf(state, unit).find(item => item.name === command.name)
    if (unit.energy < skillCost(state, skill, unit)) return events.push({ type: 'fizzle', by: unit.id, reason: 'energy' })
    useSkill(state, unit, skill, target, events, friend)
  } else {
    const thing = state.things.find(item => item.name === command.name && item.count > 0)
    // Two of the party reached for the last of it.
    if (!thing) return events.push({ type: 'fizzle', by: unit.id, reason: 'item' })
    useThing(state, unit, thing, target, events, friend)
  }
}

const speedOf = unit => (unit.side === 'foe' ? TIERS[unit.tier].speed + (unit.gap ?? 0) : unit.modifiers.grace)

/**
 * Who acts in what order this round. The player alone acts first and the foes after in turn, as it always was;
 * a party and its foes go by speed, rolled anew each round, the party first where it is even.
 */
function turnOrder(state, commands) {
  const party = partyOf(state).filter(unit => unit.life > 0 && commands.has(unit.id))
  if (solo(state)) return [...party, ...aliveFoes(state)]
  const all = [...party, ...aliveFoes(state)].map((unit, i) => ({ unit, i, speed: speedOf(unit) + random(state) * SPEED_SPREAD }))
  all.sort((a, b) => b.speed - a.speed || (a.unit.side === b.unit.side ? a.i - b.i : a.unit.side === 'player' ? -1 : 1))
  return all.map(entry => entry.unit)
}

const lostAll = state => alivePartyOf(state).length === 0

/**
 * A round: what each of the party was told and all that follows from it, to the next choice. → { state, events }
 * `commands` is one action per one of the party who can act ({ who, kind, name?, target? }); a fight of the player alone
 * may be given its action as it is. A round of the party opens with a `turn` event for each that acts, in the order they do.
 */
export function step(before, commands) {
  const reason = roundRefusal(before, commands)
  if (reason) throw new Error(`battle: ${reason}`)
  const list = Array.isArray(commands) ? commands : [commands]
  const state = copy(before)
  const events = []
  const rallying = list.length === 1 && list[0].kind === 'rally'
  if (rallying) rally(state, events)
  // Getting up is the whole round: the foes do not get a blow in for it.
  const told = new Map(rallying ? [] : list.map(command => [command.who ?? 'player', command]))
  // A guard holds from the start of the round, whoever is quicker.
  for (const [id, command] of told) {
    if (command.kind !== 'guard') continue
    const unit = unitOf(state, id)
    unit.guarding = true
    events.push({ type: 'guard', ...byOf(state, unit) })
    giveEnergy(state, unit, GUARD_ENERGY, events)
  }
  for (const unit of rallying ? [] : turnOrder(state, told)) {
    if (state.over || lostAll(state)) break
    if (unit.life <= 0) continue
    if (!aliveFoes(state).length) break
    if (!solo(state)) events.push({ type: 'turn', who: unit.id })
    if (unit.side === 'foe') {
      // A foe of a party acts more than once some rounds: what is over carries to the next.
      unit.tempo += unit.pace ?? 1
      for (; unit.tempo >= 1 - 1e-9; unit.tempo -= 1) if (unit.life > 0 && !lostAll(state)) foeActs(state, unit, events)
    }
    else act(state, unit, told.get(unit.id), events)
  }
  if (!state.over && !lostAll(state)) endRound(state, events)
  if (!state.over && !aliveFoes(state).length) state.over = 'won'
  else if (!state.over && lostAll(state)) state.over = 'lost'
  else if (!state.over && state.round >= MAX_ROUNDS) state.over = 'lost'
  // Those who fell in a fight that was won get up when it is over, hurt.
  if (state.over === 'won') for (const unit of partyOf(state)) if (unit.life === 0) unit.life = 1
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

/**
 * What 自动 does for one of the party, and what a chance is worked out with: drink when the next blows could end it,
 * brace for a charge, mend the worst hurt of the party, hit hardest. `who`: the player unless said; `left` the things
 * still to be had this round, when others of the party have reached for some already.
 */
export function autoAction(state, who = 'player', left = null) {
  const unit = unitOf(state, who)
  const tag = who === 'player' && solo(state) ? {} : { who }
  const foes = aliveFoes(state)
  const armour = 1 - ARMOUR * unit.modifiers.body
  const incoming = foes.reduce((sum, foe) => sum + unit.maxLife * foe.damage * (foe.charging ? 2 : 1), 0) * armour * DIFFICULTY[state.difficulty]
  const has = thing => thing.count - (left?.[thing.name] ?? 0) > 0
  const healing = state.things.find(thing => has(thing) && thing.effect.type === 'heal')
  const skills = skillsOf(state, unit).filter(skill => unit.energy >= skillCost(state, skill, unit))
  if (!solo(state)) {
    const mend = skills.find(skill => SKILLS[skill.kind].heal)
    const hurt = alivePartyOf(state).concat(partyOf(state).filter(item => item.life === 0)).sort((a, b) => a.life / a.maxLife - b.life / b.maxLife)[0]
    if (mend && hurt && (hurt.life === 0 || hurt.life < hurt.maxLife * 0.45)) return { ...tag, kind: 'skill', name: mend.name, ...(hurt.id === unit.id ? {} : { target: hurt.id }) }
  }
  // Alone, what may come at you is everything; in a party, about a share of it, with some to spare.
  const threat = solo(state) ? incoming : (incoming / alivePartyOf(state).length) * 1.6
  if (unit.life <= threat * 1.1 && healing) return { ...tag, kind: 'item', name: healing.name }
  const charging = foes.find(foe => foe.charging)
  if (charging && charging.life > BLOW * SKILLS.strike.power * 1.2 && (solo(state) || unit.life < unit.maxLife * 0.6)) return { ...tag, kind: 'guard' }
  const blows = skills.filter(skill => SKILLS[skill.kind].power)
  const sweep = foes.length > 1 ? blows.find(skill => skill.kind === 'sweep') : null
  if (sweep) return { ...tag, kind: 'skill', name: sweep.name }
  const hardest = blows.filter(skill => SKILLS[skill.kind].target === 'one').sort((a, b) => SKILLS[b.kind].power * (SKILLS[b.kind].hits ?? 1) - SKILLS[a.kind].power * (SKILLS[a.kind].hits ?? 1))[0]
  if (hardest) return { ...tag, kind: 'skill', name: hardest.name, target: weakest(state).id }
  return { ...tag, kind: 'attack', target: weakest(state).id }
}

/** What 自动 tells the whole party this round: one action each, not two reaching for the last draught. */
export function autoCommands(state) {
  if (solo(state)) return autoAction(state)
  const taken = {}
  return alivePartyOf(state).map(unit => {
    const action = autoAction(state, unit.id, taken)
    if (action.kind === 'item') taken[action.name] = (taken[action.name] ?? 0) + 1
    return action
  })
}

/**
 * Fights played through with 自动, each on its own dice.
 * → { chance (percent won), rounds, left (percent of the player's most life, after a win), fallen (share of the others who fell) }
 */
export function simulate(setup, runs) {
  let wins = 0
  let rounds = 0
  let left = 0
  let fallen = 0
  for (let i = 0; i < runs; i++) {
    let state = startBattle({ ...setup, seed: `${setup.seed}:${i}` })
    let downs = new Set()
    while (!state.over) {
      state = step(state, autoCommands(state)).state
      for (const ally of alliesOf(state)) if (ally.life === 0) downs.add(ally.id)
    }
    rounds += state.round
    if (state.over === 'won') {
      wins += 1
      left += (playerOf(state).life / playerOf(state).maxLife) * 100
      if (alliesOf(state).length) fallen += downs.size / alliesOf(state).length
    }
  }
  return { chance: (wins / runs) * 100, rounds: rounds / runs, left: wins ? left / wins : 0, fallen: wins ? fallen / wins : 0 }
}
