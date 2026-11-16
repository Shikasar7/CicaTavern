// 战斗: the rules of a fight, with no screen and no model. A fight is its setup and the actions taken, played through
// `step`: the same setup and actions always come to the same thing, so nothing but those needs keeping. Numbers are
// relative: a foe's life is so many of the player's blows, its damage a share of the most life of whoever it strikes,
// so a card that counts life in hundreds and one that counts in thousands fight the same. Runs on old WebViews too.
//
// 队伍: the player may stand with up to three others (setup.allies), each with their own attributes, life, energy and
// skills. A round is then as in RPG Maker: every one of the party who can still act is given a command, and then all,
// foes too, act in the order of their speed. A fight of the player alone keeps the order it always had (the player,
// then the foes in turn) and rolls nothing more, so its dice, and so its outcomes, are what they were.
import { chanceOf, judge, marredBy, modifierOf, randomFrom, seedOf, worstAil } from './dice.js'

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
  // 技能效果 (plans/17): more of what a skill can be. None of these is guessed from a name: a card sets them.
  finish: { power: 1.3, cost: 0.25, target: 'one', finish: 2 },
  mend: { heal: 0.18, cost: 0.4, target: 'party' },
  ward: { ward: 0.3, cost: 0.2, target: 'self' },
  rally: { cost: 0.25, target: 'party', status: 'rally' },
  taunt: { cost: 0.25, target: 'self', status: 'taunt' },
}

/**
 * 附加: what a skill does on top of what its kind does, each in three sizes. `on`: what kind of skill can carry it
 * ('blow' one that strikes, 'care' one that mends or wards, 'any'). `minus`: a price paid, which gives points back.
 * A skill's adds come to `ADD_BUDGET` points at most, and each point takes a little from what the skill itself does:
 * one that does more things does each of them less.
 */
export const ADD_SIZES = ['small', 'medium', 'large']
export const SKILL_ADDS = {
  poison: { sizes: [0.12, 0.22, 0.32], on: 'blow' },
  stun: { sizes: [0.3, 0.5, 0.7], on: 'blow' },
  weaken: { sizes: [0.06, 0.12, 0.18], on: 'blow' },
  expose: { sizes: [0.06, 0.12, 0.18], on: 'blow' },
  slow: { sizes: [0.12, 0.2, 0.28], on: 'blow' },
  leech: { sizes: [0.2, 0.35, 0.5], on: 'blow' },
  surge: { sizes: [0.07, 0.12, 0.18], on: 'blow' },
  cleanse: { cost: 1, on: 'care' },
  recoil: { sizes: [0.03, 0.05, 0.08], on: 'any', minus: true },
}
export const SKILL_ADD_IDS = Object.keys(SKILL_ADDS)
export const MAX_ADDS = 2
export const ADD_BUDGET = 3
// What each point of adds takes from what the skill itself does (its blow, its heal, its ward).
const ADD_WEIGHT = 0.05
// How long what a skill leaves on someone lasts, in rounds.
const STATUS_ROUNDS = 3
// 斩杀 does its more to a foe below this share of its life.
const FINISH_AT = 0.4
// 鼓舞 is 蓄势 for everyone, and less of it.
const RALLY = 1.2
// 挑衅: so much likelier to be the one struck, and so much less of each blow taken.
const TAUNT_DRAW = 4
const TAUNT_GUARD = 0.25
// A 首领 is harder to stop: an add's chance to stun it is this much of what it is.
const BOSS_STUN = 0.5

const addSize = add => SKILL_ADDS[add.id].sizes?.[ADD_SIZES.indexOf(add.size)] ?? 0
/** What is left of a skill's own doing for the adds it carries. */
const addWeight = adds => 1 - ADD_WEIGHT * Math.max(0, addPoints(adds))
const addCost = add => {
  const rule = SKILL_ADDS[add.id]
  const own = rule.sizes ? ADD_SIZES.indexOf(add.size) + 1 : rule.cost
  return rule.minus ? -own / 2 : own
}

/** What a skill's adds come to, in points: what they give less half of what they cost. */
export const addPoints = adds => (adds ?? []).reduce((sum, add) => sum + addCost(add), 0)

/** Whether a skill of a kind can carry an add. */
export function addFits(kind, id) {
  const rule = SKILLS[kind]
  const add = SKILL_ADDS[id]
  if (!rule || !add) return false
  if (add.on === 'blow') return Boolean(rule.power) && rule.status !== id
  if (add.on === 'care') return Boolean(rule.heal || rule.ward)
  return true
}

/**
 * A skill's adds as kept: [{ id, size? }], those the rules know and its kind can carry, no two the same, two at most,
 * the last made smaller and then dropped while they come to more than the budget. A price alone is no add.
 */
export function cleanAdds(value, kind) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || !addFits(kind, item.id) || out.some(other => other.id === item.id)) continue
    out.push({ id: item.id, ...(SKILL_ADDS[item.id].sizes ? { size: ADD_SIZES.includes(item.size) ? item.size : 'medium' } : {}) })
    if (out.length === MAX_ADDS) break
  }
  while (out.length && addPoints(out) > ADD_BUDGET) {
    const last = out.findLast(add => !SKILL_ADDS[add.id].minus)
    const at = ADD_SIZES.indexOf(last.size)
    if (at > 0) last.size = ADD_SIZES[at - 1]
    else out.splice(out.indexOf(last), 1)
  }
  return out.some(add => !SKILL_ADDS[add.id].minus) ? out : []
}

/**
 * 敌人的招式效果: what the blows of a foe leave behind, for a 精英 (one of them) or a 首领 (two). A card's bestiary
 * says which (sheet.js cleanFoes); how much each is worth is set here, as with a skill's adds. They land on whom the
 * foe strikes: 持续伤害 (a share of their life each round), 削弱 (they deal less), 破绽 (they take more), 眩晕 (a
 * chance they lose their next action), 吸取 (the foe mends by a share of what it dealt). A foe that does more with
 * its blows strikes a little less hard, a point at a time, as a skill does.
 */
export const FOE_ADDS = {
  poison: { sizes: [0.02, 0.035, 0.05] },
  weaken: { sizes: [0.05, 0.1, 0.15] },
  expose: { sizes: [0.08, 0.15, 0.22] },
  stun: { sizes: [0.06, 0.11, 0.16] },
  leech: { sizes: [0.04, 0.07, 0.1] },
}
export const FOE_ADD_IDS = Object.keys(FOE_ADDS)
/** How many a foe of a tier may have, and what they may come to in points; the lesser tiers have none. */
export const FOE_ADD_ROOM = { elite: { count: 1, points: 2 }, boss: { count: 2, points: 3 } }
const FOE_ADD_WEIGHT = 0.03
// One just stunned cannot be stunned again for this many rounds: nobody stands there for a whole fight.
const DAZED_ROUNDS = 2
const foeAddSize = add => FOE_ADDS[add.id].sizes[ADD_SIZES.indexOf(add.size)] ?? 0
const foeAddPoints = adds => adds.reduce((sum, add) => sum + ADD_SIZES.indexOf(add.size) + 1, 0)

/**
 * A foe's adds as kept: [{ id, size }], those the rules know, no two the same, the last made smaller and then dropped
 * while they come to more than there is room for. `tier`: whose they are; none said is the most any foe may have.
 */
export function cleanFoeAdds(value, tier = 'boss') {
  const room = FOE_ADD_ROOM[tier]
  if (!room) return []
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || !Object.hasOwn(FOE_ADDS, item.id) || out.some(other => other.id === item.id)) continue
    out.push({ id: item.id, size: ADD_SIZES.includes(item.size) ? item.size : 'medium' })
    if (out.length === room.count) break
  }
  while (out.length && foeAddPoints(out) > room.points) {
    const last = out[out.length - 1]
    const at = ADD_SIZES.indexOf(last.size)
    if (at > 0) last.size = ADD_SIZES[at - 1]
    else out.pop()
  }
  return out
}

/** What one with no skills of their own fights with. */
export const DEFAULT_SKILLS = ['强击', '横扫']
// 临时进化: taking the next 形态 for one fight costs this share of the most energy, and comes with this share of life
// back, a few rounds of hitting harder and a blow struck at once. Without the blow it cost more than it gave: one alone
// against a 首领 won 75 times in a hundred with it and 85 without (测试卡/题材/成长测试/平衡模拟/sim_forms).
export const SHIFT_COST = 0.6
const SHIFT_HEAL = 0.25
// 能量耗尽: a form that feeds on energy takes this share of the most each round after the one it was taken in; with
// less than that left, whoever took it is back as they were.
export const SHIFT_UPKEEP = 0.1
// 类型克制: a blow of a type that beats its target's lands this much harder, one that is beaten by it this much
// lighter; what a foe's blow does to one of the party is moved less either way. The design had 0.75 and no word of
// the foe's side: with a whole party of the type a 首领 beats, that and 1.25 taken won 25 fights in a hundred where
// it had won 97 (测试卡/题材/成长测试/平衡模拟/sim_command).
export const EDGE = { strong: 1.5, weak: 0.8 }
const EDGE_TAKEN = { strong: 1.1, weak: 0.9 }
// 指挥: one who leads from behind and does not fight can hearten one of those who do, a little less than a skill would.
const CHEER = 1.2
// 收服: what a roll on 魅力 has to come to, by the foe's tier; a 首领 is nobody's to tame.
export const TAME_DC = { minion: 8, normal: 11, elite: 14 }
// 成长 (growth.js): from here down, one who fights harder when cornered is cornered.
const CORNERED = 0.3
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
    for (let i = 0; i < group.count && foes.length < MAX_FOES; i++) foes.push({ name: group.name, tier: group.tier, ...(group.gap ? { gap: group.gap } : {}), ...(group.rank ? { rank: group.rank } : {}), ...(group.up ? { up: group.up } : {}), ...(group.since ? { since: group.since } : {}), ...(group.adds?.length ? { adds: group.adds } : {}), ...(group.type ? { type: group.type } : {}) })
  }
  const points = () => foes.reduce((sum, foe) => sum + TIERS[foe.tier].points, 0)
  for (let at = foes.length - 1; at >= 0 && points() > budget; at--) {
    while (foes[at].tier !== 'minion' && points() > budget) foes[at].tier = TIER_ORDER[TIER_ORDER.indexOf(foes[at].tier) - 1]
  }
  return foes
}

const skillsFrom = (names, kinds, grown = {}, adds = {}, types = {}) => (names.length ? names : DEFAULT_SKILLS).map(name => {
  const kind = kinds[name] ?? skillKindOf(name)
  const own = adds[name] ? cleanAdds(adds[name], kind) : []
  return { name, kind, ...(grown[name] ?? {}), ...(own.length ? { adds: own } : {}), ...(types[name] ? { type: types[name] } : {}) }
})

/**
 * What a fight needs from the sheet, plain data that a fight can be replayed from.
 * @param effects - name → what a thing does (sheet.js effectOf).
 * @param kinds - name → a skill's kind, for those set on the card.
 * @param allies - who stands with the player, at most three: { name, level, attributes, life, maxLife, energy, maxEnergy, skills: [names], kinds, bonus?, grown? }.
 * @param bonus - what the player has from growing (growth.js fightBonus), or null; an ally's own is on the ally.
 * @param grown - what growth did to the player's skills (growth.js skillGrowth): { name: { power?, cost?, stage? } }.
 * @param grows - the card counts growth: the fight says how often each skill was used.
 * @param adds - name → what a skill does on top of its kind ([{ id, size }]), for those the card has set.
 * @param types - 类型克制, on a card that has it: { beats: { type: [those it beats] }, skills: { name: type }, player? (the player's own) }.
 * @param lead - 'command': the player leads from behind and does not fight, where someone stands with them.
 * @param tame - 收服, on a card that has it: { charm (the player's modifier) }.
 */
export function battleSetup(sheet, { foes, seed, difficulty = 'normal', effects = () => null, kinds = {}, allies = [], bonus = null, grown = {}, grows = false, adds = {}, shift = null, types = null, lead = '', tame = null }) {
  const strain = sheet.strain ?? []
  const typed = types?.skills ?? {}
  // 形态: what one of the party becomes if they take their next form in this fight ({ name, names, bonus?, grown? }).
  const shiftOf = (to, known) => ({ name: String(to.name), ...(to.bonus ? { bonus: to.bonus } : {}), skills: skillsFrom(to.names ?? [], known, to.grown ?? {}, adds, typed), ...(to.type ? { type: String(to.type) } : {}), ...(to.drain ? { drain: true } : {}), ...(to.then ? { then: shiftOf(to.then, known) } : {}) })
  const of = id => modifierOf(sheet.attributes[id]) - marredBy([...(sheet.conditions ?? []), ...strain], id)
  const others = allies.slice(0, MAX_PARTY - 1).map(member => ({
    name: String(member.name),
    level: member.level ?? sheet.level ?? 1,
    life: member.life,
    maxLife: member.maxLife,
    energy: member.energy ?? member.maxEnergy,
    maxEnergy: member.maxEnergy,
    modifiers: { body: modifierOf(member.attributes?.body), grace: modifierOf(member.attributes?.grace), mind: modifierOf(member.attributes?.mind) },
    skills: skillsFrom(member.skills ?? [], { ...kinds, ...(member.kinds ?? {}) }, member.grown ?? {}, adds, typed),
    ...(types && member.type ? { type: String(member.type) } : {}),
    // 形态: what they go by in the form they are in; who they are stays their name.
    ...(member.shown ? { shown: String(member.shown) } : {}),
    ...(member.bonus ? { bonus: member.bonus } : {}),
    ...(member.shift ? { shift: shiftOf(member.shift, { ...kinds, ...(member.kinds ?? {}) }) } : {}),
  }))
  return {
    seed,
    difficulty,
    foes,
    ...(grows ? { grows: true } : {}),
    ...(types ? { types: types.beats ?? {} } : {}),
    ...(lead === 'command' && others.length ? { lead: 'command' } : {}),
    ...(tame ? { tame } : {}),
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
      skills: skillsFrom(sheet.skills, kinds, grown, adds, typed),
      ...(types?.player ? { type: String(types.player) } : {}),
      ...(bonus ? { bonus } : {}),
      ...(shift ? { shift: shiftOf(shift, kinds) } : {}),
      things: sheet.things.map(thing => ({ name: thing.name, count: thing.count, effect: effects(thing.name) })).filter(thing => thing.effect && thing.effect.type !== 'none' && thing.effect.type !== 'calm' && thing.effect.type !== 'gear'),
    },
    ...(others.length ? { allies: others } : {}),
  }
}

// 开局: what the way a fight was gone into gives or costs before the first blow. Never more than two of what helps, so
// that a fight is still a fight; a foe is never brought in at less than a quarter of its life.
export const OPENING_MOST = 2
const OPENING_LIFE_LEAST = 0.25
const OPENING_OPEN = 0.12
const lifeShare = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(1, Math.max(OPENING_LIFE_LEAST, Number(value))) : 1)

/**
 * A fight's 开局 as the rules keep it, or null: { first?, open?, boost?, caught?, life?, lives? }.
 * `first`: the foes lose their first turn. `open`: they start with a 破绽. `boost`: the party starts 强化.
 * `caught`: the party loses its first turn, and only gets its guard up. `life`: every foe starts at this share of its life; `lives`: the named ones.
 */
export function cleanOpening(value) {
  if (!value || typeof value !== 'object') return null
  const lives = Object.fromEntries(Object.entries(value.lives && typeof value.lives === 'object' ? value.lives : {}).map(([name, share]) => [String(name).slice(0, 40), lifeShare(share)]).filter(([name, share]) => name && share < 1).slice(0, 4))
  const life = lifeShare(value.life)
  // Taken by surprise and striking first at once is neither.
  const caught = value.caught === true && value.first !== true
  const helps = [value.first === true && value.caught !== true ? 'first' : '', value.open === true ? 'open' : '', value.boost === true ? 'boost' : '', life < 1 || Object.keys(lives).length ? 'life' : ''].filter(Boolean).slice(0, OPENING_MOST)
  const out = { ...Object.fromEntries(helps.filter(id => id !== 'life').map(id => [id, true])), ...(caught ? { caught: true } : {}), ...(helps.includes('life') && life < 1 ? { life } : {}), ...(helps.includes('life') && Object.keys(lives).length ? { lives } : {}) }
  return Object.keys(out).length ? out : null
}

/** The same fight begun again: the dice are new. */
export const attemptSetup = (setup, attempt) => (attempt ? { ...setup, seed: `${setup.seed}:${attempt}` } : setup)

/** How many stand on the player's side in a fight's setup. */
export const partySize = setup => (setup.lead === 'command' ? 0 : 1) + Math.min(MAX_PARTY - 1, setup.allies?.length ?? 0)

/** A fight at its first round. */
export function startBattle(setup) {
  const many = setup.foes.length > 1
  const share = 1 / (1 + MANY_SHARE * (setup.foes.length - 1))
  const members = partySize(setup)
  const foes = setup.foes.map((foe, i) => {
    const tier = TIERS[foe.tier]
    const gap = gapOf(foe)
    const life = Math.round(tier.hits * BLOW * (many ? MANY_TOUGH : 1) * (TOUGHNESS[setup.difficulty] ?? 1) * gap.life * PARTY_LIFE[members] * (foe.up?.life ?? 1))
    // 招式效果: only what its tier has room for (a foe brought down a tier to fit the field loses what it had).
    const adds = foe.adds ? cleanFoeAdds(foe.adds, foe.tier) : []
    return { id: `foe-${i}`, side: 'foe', name: foe.name, tier: foe.tier, gap: foe.gap ?? 0, life, maxLife: life, damage: (tier.damage / 100) * share * gap.damage * (foe.up?.damage ?? 1) * (adds.length ? 1 - FOE_ADD_WEIGHT * foeAddPoints(adds) : 1), pace: 1 + (PARTY_PACE[members] - 1) * (many ? 1 : LONE_PACE), tempo: 0, charging: false, poison: 0, stun: 0, ...(adds.length ? { adds } : {}), ...(foe.type ? { type: foe.type } : {}) }
  })
  // 开局: what was won or lost before the first blow.
  const opening = cleanOpening(setup.opening)
  if (opening) {
    for (const foe of foes) {
      const share = Math.min(opening.life ?? 1, opening.lives?.[foe.name] ?? 1)
      if (share < 1) foe.life = Math.max(1, Math.round(foe.maxLife * share))
      if (opening.first) Object.assign(foe, { stun: 1, late: true })
      if (opening.open) Object.assign(foe, { open: STATUS_ROUNDS, openBy: OPENING_OPEN })
    }
  }
  const opened = unit => (unit.commander || !opening ? unit : { ...unit, ...(opening.boost ? { boost: BOOST_ROUNDS } : {}), ...(opening.caught ? { stun: 1, late: true, guarding: true } : {}) })
  const { player } = setup
  const allies = (setup.allies ?? []).slice(0, MAX_PARTY - 1).map((ally, i) => ({ id: `ally-${i}`, side: 'player', ally: true, name: ally.name, life: ally.life, maxLife: ally.maxLife, energy: ally.energy, maxEnergy: ally.maxEnergy, modifiers: ally.modifiers, skills: ally.skills, guarding: false, boost: 0, ...(ally.type ? { type: ally.type } : {}), ...(ally.shown ? { shown: ally.shown } : {}), ...(ally.bonus ? { bonus: ally.bonus } : {}), ...(ally.shift ? { shift: ally.shift } : {}) }))
  return {
    round: 1,
    rng: seedOf('battle', String(setup.seed)),
    difficulty: setup.difficulty,
    units: [opened({ id: 'player', side: 'player', life: player.life, maxLife: player.maxLife, energy: player.energy, maxEnergy: player.maxEnergy, modifiers: player.modifiers, guarding: false, boost: 0, ...(setup.lead === 'command' && allies.length ? { commander: true } : {}), ...(player.type ? { type: player.type } : {}), ...(player.bonus ? { bonus: player.bonus } : {}), ...(player.shift ? { shift: player.shift } : {}) }), ...allies.map(opened), ...foes],
    ...(setup.types ? { types: setup.types } : {}),
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
  const { level = 1 } = setup.player
  return foesOf(startBattle(setup)).map((foe, i) => ({
    name: foe.name,
    tier: foe.tier,
    gap: foe.gap,
    rank: setup.foes[i].rank ?? '',
    since: setup.foes[i].since ?? 0,
    level: Math.max(1, level + LEVEL_OFFSET[foe.tier] + gapOf(foe).level),
    life: foe.maxLife,
    attack: Math.round(lifeBefore(setup.player) * foe.damage * DIFFICULTY[setup.difficulty] * (1 - (setup.player.bonus?.guard ?? 0))),
    charges: Boolean(TIERS[foe.tier].charges),
    noEscape: TIERS[foe.tier].flee === null,
    ...(foe.adds ? { adds: foe.adds } : {}),
    ...(foe.type ? { type: foe.type } : {}),
  }))
}

/** 类型克制: how a blow of one type stands to a target of another: 'strong', 'weak' or ''. */
export const edgeOf = (state, from, to) => (!state.types || !from || !to ? '' : state.types[from]?.includes(to) ? 'strong' : state.types[to]?.includes(from) ? 'weak' : '')

/**
 * 收服: the roll for a foe brought down in a fight that was won, the same however often it is asked for.
 * → { dc, modifier, roll, total, tier, ok, chance (percent) }, or null for one that cannot be tamed.
 */
export function tameTry(setup, foe) {
  if (!setup.tame || !Object.hasOwn(TAME_DC, foe?.tier) || (setup.tame.have ?? []).includes(foe.name)) return null
  const dc = TAME_DC[foe.tier] + 2 * (foe.gap ?? 0)
  const modifier = setup.tame.charm ?? 0
  const roll = 1 + Math.floor(randomFrom(seedOf('tame', String(setup.seed), String(foe.name)))() * 20)
  const result = judge(roll, modifier, dc)
  return { dc, modifier, ...result, ok: result.tier !== 'fail', chance: chanceOf(modifier, dc) }
}

/**
 * The life a foe's blow is a share of: what one of the party would have had without growing. What growth added is
 * theirs to keep, so more life is more blows taken, not bigger blows.
 */
const lifeBefore = unit => unit.maxLife / (unit.bonus?.tough ?? 1)
/** The energy a skill's cost is a share of, the same way: what growth added is more skills used, not dearer ones. */
const energyBefore = unit => Math.max(1, unit.maxEnergy - (unit.bonus?.spare ?? 0))

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
/** Those of the party a foe can reach: all who stand, but one who leads from behind. */
const fightersOf = state => alivePartyOf(state).filter(unit => !unit.commander)
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
export const skillCost = (state, skill, unit = playerOf(state)) => Math.ceil(energyBefore(unit) * SKILLS[skill.kind].cost * (skill.cost ?? 1) - 1e-9)

/** What taking their next 形态 for this fight costs one of the party. */
export const shiftCost = unit => Math.ceil(energyBefore(unit) * SHIFT_COST)

/** Whether the player can still get up from this: once a fight, and only from being brought down. */
export const canRally = state => state.over === 'lost' && !state.rallied && playerOf(state).life === 0 && !playerOf(state).commander

const foeAt = (state, id) => { const unit = id ? unitOf(state, id) : null; return unit?.side === 'foe' && unit.life > 0 ? unit : null }

/** Why an action cannot be done now, or null when it can. The words are the screen's. */
export function refusal(state, action) {
  if (action.kind === 'rally') return (action.who ?? 'player') === 'player' && canRally(state) ? null : 'over'
  if (state.over) return 'over'
  const actor = actorOf(state, action)
  if (!actor || actor.side !== 'player') return 'who'
  if (actor.life <= 0) return 'down'
  const foe = foeAt(state, action.target)
  // 指挥: one who leads from behind hands things out, heartens, waits or calls the retreat.
  if (actor.commander && !['item', 'cheer', 'guard', 'flee'].includes(action.kind)) return 'who'
  if (action.kind === 'cheer') return !actor.commander ? 'unknown' : fightersOf(state).some(unit => unit.id === action.target) ? null : 'target'
  if (action.kind === 'attack') return foe ? null : 'target'
  if (action.kind === 'guard') return null
  if (action.kind === 'shift') return !actor.shift ? 'unknown' : actor.energy < shiftCost(actor) ? 'energy' : null
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
    if (forOne(rule) && action.target && !solo(state) && !partyMember(state, action.target)) return 'target'
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

/** Whether a skill is given to one of the party: a heal or a ward, not one for all of them. */
const forOne = rule => Boolean(rule && (rule.heal || rule.ward) && rule.target !== 'party')

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
  if (action.kind === 'cheer') return true
  if (action.kind === 'skill') return forOne(SKILLS[skillsOf(state, actor).find(item => item.name === action.name)?.kind])
  if (action.kind === 'item') return FOR_ANOTHER.has(state.things.find(item => item.name === action.name)?.effect.type)
  return false
}

// In a fight of the party, what an event says of who did it; a fight of the player alone says it as it always did.
const byOf = (state, unit) => (solo(state) ? {} : { by: unit.id })

function blow(state, unit, foe, power, events, stat = 'body') {
  const crit = random(state) < CRIT_CHANCE + (unit.bonus?.crit ?? 0)
  const swing = 0.9 + random(state) * 0.2
  const cornered = unit.bonus?.fury && unit.life < unit.maxLife * CORNERED ? 1 + unit.bonus.fury : 1
  // 类型克制: the skill's own type, or that of whoever strikes. No dice are rolled for it.
  const edge = edgeOf(state, unit.hitsAs ?? unit.type, foe.type)
  const amount = Math.max(1, Math.round(BLOW * (1 + 0.1 * unit.modifiers[stat]) * (1 + (unit.bonus?.attack ?? 0)) * cornered * (unit.boost > 0 ? unit.boostBy ?? BOOST : 1) * power * swing * (crit ? CRIT : 1) * (1 + (foe.open > 0 ? foe.openBy : 0)) * (unit.weak > 0 ? 1 - unit.weakBy : 1) * (edge ? EDGE[edge] : 1)))
  foe.life = Math.max(0, foe.life - amount)
  events.push({ type: 'hit', ...byOf(state, unit), target: foe.id, amount, crit, life: foe.life, ...(edge ? { edge } : {}) })
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
  if (unit.boostBy) delete unit.boostBy
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
  else {
    if (!(unit.usedSkills ?? []).includes(skill.name)) unit.usedSkills = [...(unit.usedSkills ?? []), skill.name]
    unit.uses = { ...(unit.uses ?? {}), [skill.name]: (unit.uses?.[skill.name] ?? 0) + 1 }
  }
  // What use has made of it (growth.js): a skill come further does more.
  const adds = skill.adds ?? []
  const sized = id => { const add = adds.find(item => item.id === id); return add ? addSize(add) : 0 }
  const has = id => adds.some(item => item.id === id)
  const grown = (skill.power ?? 1) * addWeight(adds)
  // 反噬: paid before anything comes of it, and never the last of one's life.
  if (has('recoil')) {
    const amount = Math.min(unit.life - 1, Math.max(1, Math.round(unit.maxLife * sized('recoil'))))
    if (amount > 0) {
      unit.life -= amount
      events.push({ type: 'recoil', target: unit.id, amount, life: unit.life })
    }
  }
  const whom = friend ?? unit
  if (rule.heal) for (const one of rule.target === 'party' ? alivePartyOf(state) : [whom]) giveLife(state, one, rule.heal * grown, events, unit)
  if (rule.ward) {
    whom.ward = Math.max(1, Math.round(lifeBefore(whom) * rule.ward * grown))
    whom.wardFor = STATUS_ROUNDS
    events.push({ type: 'status', ...(solo(state) ? {} : { by: unit.id }), target: whom.id, status: 'ward', amount: whom.ward })
  }
  // 净化: the worst of what ails the player goes, when what was given reaches them.
  if (has('cleanse') && state.ails.length && (rule.target === 'party' || whom.id === 'player')) cure(state, events)
  // And what a foe's blows left on those it reaches.
  if (has('cleanse')) for (const one of rule.target === 'party' ? alivePartyOf(state) : [whom]) shake(one, events)
  if (rule.status === 'boost') giveBoost(state, unit, events)
  if (rule.status === 'rally') {
    for (const one of alivePartyOf(state)) {
      // One who has 蓄势 of their own keeps the more of the two.
      if (!(one.boost > 0 && !one.boostBy)) one.boostBy = RALLY
      one.boost = BOOST_ROUNDS
    }
    events.push({ type: 'status', ...(solo(state) ? {} : { by: unit.id }), target: unit.id, status: 'rally' })
  }
  if (rule.status === 'taunt') {
    unit.taunt = STATUS_ROUNDS
    events.push({ type: 'status', ...(solo(state) ? {} : { by: unit.id }), target: unit.id, status: 'taunt' })
  }
  if (!rule.power) return
  let dealt = 0
  for (const foe of rule.target === 'all' ? aliveFoes(state) : [target]) {
    const before = foe.life
    const finishing = rule.finish && foe.life < foe.maxLife * FINISH_AT ? rule.finish : 1
    for (let i = 0; i < (rule.hits ?? 1) && foe.life > 0; i++) blow(state, unit, foe, rule.power * grown * finishing, events, 'mind')
    dealt += before - foe.life
    if (foe.life > 0 && rule.status === 'poison') {
      foe.poison = POISON_ROUNDS
      if (foe.poisonBy) delete foe.poisonBy
      events.push({ type: 'status', target: foe.id, status: 'poison' })
    }
    if (foe.life > 0 && rule.status === 'stun' && random(state) < STUN_CHANCE) {
      foe.stun = 1
      foe.charging = false
      events.push({ type: 'status', target: foe.id, status: 'stun' })
    }
    if (foe.life === 0 || !adds.length) continue
    if (has('poison')) {
      foe.poison = POISON_ROUNDS
      foe.poisonBy = sized('poison')
      events.push({ type: 'status', target: foe.id, status: 'poison' })
    }
    if (has('stun') && random(state) < sized('stun') * (foe.tier === 'boss' ? BOSS_STUN : 1)) {
      foe.stun = 1
      foe.charging = false
      events.push({ type: 'status', target: foe.id, status: 'stun' })
    }
    for (const [id, held] of [['weaken', 'weak'], ['expose', 'open'], ['slow', 'slow']]) {
      if (!has(id)) continue
      foe[held] = STATUS_ROUNDS
      foe[`${held}By`] = sized(id)
      events.push({ type: 'status', target: foe.id, status: id })
    }
  }
  if (!dealt) return
  if (has('leech') && unit.life < unit.maxLife) {
    const amount = Math.min(unit.maxLife - unit.life, Math.max(1, Math.round(dealt * sized('leech'))))
    unit.life += amount
    events.push({ type: 'heal', ...(solo(state) ? {} : { by: unit.id, target: unit.id }), amount, life: unit.life })
  }
  if (has('surge') && unit.energy < unit.maxEnergy) giveEnergy(state, unit, sized('surge'), events)
}

/** What a foe's blows left on one of the party goes: said only when there was something. */
function shake(unit, events) {
  if (!(unit.poison > 0 || unit.weak > 0 || unit.open > 0 || unit.stun > 0)) return
  for (const held of ['poison', 'weak', 'open', 'stun']) if (unit[held] > 0) unit[held] = 0
  events.push({ type: 'cleansed', target: unit.id })
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
  const result = judge(roll, player.modifiers.grace + (player.bonus?.flee ?? 0), dc)
  events.push({ type: 'flee', ...result })
  if (result.tier !== 'fail') state.over = 'fled'
}

/** Whom a foe strikes: the player, when they stand alone; else one of the party, a guard more likely than the rest. */
function victimOf(state) {
  if (solo(state)) return playerOf(state)
  const alive = fightersOf(state)
  const weights = alive.map(unit => (unit.guarding ? GUARD_DRAW : 1) * (unit.taunt > 0 ? TAUNT_DRAW : 1))
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
    events.push({ type: 'stunned', by: foe.id, ...(foe.late ? { late: true } : {}) })
    delete foe.late
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
  let victim = victimOf(state)
  // 护卫: one of the others may step in front. Rolled only where someone can, so a fight with none rolls what it did.
  const shield = solo(state) ? null : fightersOf(state).find(unit => unit !== victim && unit.bonus?.cover && random(state) < unit.bonus.cover)
  if (shield) {
    events.push({ type: 'cover', by: shield.id, target: victim.id })
    victim = shield
  }
  const crit = random(state) < CRIT_CHANCE
  const swing = 0.75 + random(state) * 0.5
  const rage = tier.rages && !charged && foe.life < foe.maxLife / 2 ? RAGE : 1
  const armour = (1 - ARMOUR * victim.modifiers.body) * (1 - (victim.bonus?.guard ?? 0)) * (victim.taunt > 0 ? 1 - TAUNT_GUARD : 1)
  // 类型克制: the foe's type against that of whom it strikes.
  const edge = edgeOf(state, foe.type, victim.type)
  let amount = Math.max(1, Math.round(lifeBefore(victim) * foe.damage * DIFFICULTY[state.difficulty] * armour * swing * rage * (charged ? 2 : 1) * (crit ? CRIT : 1) * (victim.guarding ? GUARD : 1) * (foe.weak > 0 ? 1 - foe.weakBy : 1) * (victim.open > 0 ? 1 + victim.openBy : 1) * (edge ? EDGE_TAKEN[edge] : 1)))
  // 护盾: what it can still take comes off the blow first.
  if (victim.ward > 0) {
    const held = Math.min(victim.ward, amount)
    victim.ward -= held
    amount -= held
    events.push({ type: 'warded', target: victim.id, amount: held, left: victim.ward })
  }
  // 不屈: the first blow that would bring them down in a fight leaves them standing.
  const stands = victim.bonus?.stand && !victim.stood && amount >= victim.life
  if (stands) victim.stood = true
  victim.life = stands ? 1 : Math.max(0, victim.life - amount)
  events.push({ type: 'struck', by: foe.id, ...(solo(state) ? {} : { target: victim.id }), amount, crit, charged, life: victim.life, ...(edge ? { edge } : {}) })
  if (stands) events.push({ type: 'stand', target: victim.id })
  // 招式效果: what a blow that got through leaves on one still standing.
  if (foe.adds && amount > 0) afflict(state, foe, victim, amount, events)
  if (charged) state.moments.push({ round: state.round, kind: 'charged', foe: foe.name })
  if (victim.life === 0 && !solo(state)) {
    victim.fell = true
    events.push({ type: 'fallen', target: victim.id })
    if (victim.id !== 'player') state.moments.push({ round: state.round, kind: 'fallen', who: victim.name })
  }
}

/** What a foe's blow leaves behind, on whom it struck and on itself. Rolled only for a foe that may stun. */
function afflict(state, foe, victim, amount, events) {
  const sized = id => { const add = foe.adds.find(item => item.id === id); return add ? foeAddSize(add) : 0 }
  if (sized('leech') && foe.life < foe.maxLife) {
    const back = Math.min(foe.maxLife - foe.life, Math.max(1, Math.round(amount * sized('leech'))))
    foe.life += back
    events.push({ type: 'drain', by: foe.id, amount: back, life: foe.life })
  }
  if (victim.life <= 0) return
  if (sized('poison')) {
    victim.poison = POISON_ROUNDS
    victim.poisonBy = sized('poison')
    events.push({ type: 'afflict', by: foe.id, target: victim.id, status: 'poison' })
  }
  // One round more than a foe bears them: these are counted down at the end of the round they came in.
  for (const [id, held] of [['weaken', 'weak'], ['expose', 'open']]) {
    if (!sized(id)) continue
    victim[held] = STATUS_ROUNDS + 1
    victim[`${held}By`] = sized(id)
    events.push({ type: 'afflict', by: foe.id, target: victim.id, status: id })
  }
  if (sized('stun') && !(victim.stun > 0) && !(victim.dazed > 0) && random(state) < sized('stun')) {
    victim.stun = 1
    victim.dazed = DAZED_ROUNDS + 1
    events.push({ type: 'afflict', by: foe.id, target: victim.id, status: 'stun' })
  }
}

function endRound(state, events) {
  for (const foe of aliveFoes(state)) for (const held of ['weak', 'open', 'slow']) if (foe[held] > 0) foe[held] -= 1
  for (const foe of aliveFoes(state)) {
    if (foe.poison <= 0) continue
    foe.poison -= 1
    // Not made more for a party, though its foes have more life: it is one member's doing, as their blows are, and
    // those are not made more either (made 3.7 times as much for four, one who poisons did the work of the party).
    const amount = Math.max(1, Math.round(BLOW * (foe.poisonBy ?? POISON)))
    foe.life = Math.max(0, foe.life - amount)
    events.push({ type: 'poison', target: foe.id, amount, life: foe.life })
    if (foe.life === 0) events.push({ type: 'down', target: foe.id })
  }
  for (const unit of partyOf(state)) {
    // What a foe's blows left: it wears off, and the 持续伤害 takes its share, never the last of one's life.
    for (const held of ['weak', 'open', 'dazed']) if (unit[held] > 0) unit[held] -= 1
    if (unit.poison > 0) {
      unit.poison -= 1
      const amount = Math.min(unit.life - 1, Math.max(1, Math.round(lifeBefore(unit) * unit.poisonBy)))
      if (unit.life > 0 && amount > 0) {
        unit.life -= amount
        events.push({ type: 'sap', target: unit.id, amount, life: unit.life })
      }
    }
    unit.guarding = false
    if (unit.boost > 0) unit.boost -= 1
    if (unit.boostBy && !unit.boost) delete unit.boostBy
    if (unit.taunt > 0) unit.taunt -= 1
    if (unit.wardFor > 0 && --unit.wardFor === 0) unit.ward = 0
    // 回复: a little back each round, while there are foes left to need it against.
    if (unit.bonus?.regen && unit.life > 0 && unit.life < unit.maxLife && aliveFoes(state).length) giveLife(state, unit, unit.bonus.regen, events)
    // 能量耗尽: a form that feeds on energy takes its share, from the round after it was taken; with none to take it is lost.
    if (unit.back && unit.life > 0 && aliveFoes(state).length) {
      const cost = Math.ceil(energyBefore(unit) * SHIFT_UPKEEP)
      if (unit.back.fresh) delete unit.back.fresh
      else if (unit.energy >= cost) {
        unit.energy -= cost
        events.push({ type: 'upkeep', target: unit.id, amount: cost, energy: unit.energy })
      } else {
        const { bonus, skills, type } = unit.back
        if (bonus) unit.bonus = bonus
        else delete unit.bonus
        if (unit.id === 'player') state.skills = skills
        else unit.skills = skills
        if (type) unit.type = type
        else delete unit.type
        events.push({ type: 'revert', by: unit.id, name: unit.shifted })
        unit.reverted = unit.shifted
        delete unit.shifted
        delete unit.shift
        delete unit.back
      }
    }
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
  else if (kind === 'cheer') {
    if (!friend || friend.life <= 0) return
    // One who is already hitting as hard as a skill makes them goes on doing so.
    const full = friend.boost > 0 && !friend.boostBy
    friend.boost = BOOST_ROUNDS
    if (!full) friend.boostBy = CHEER
    events.push({ type: 'status', by: unit.id, target: friend.id, status: 'cheer' })
  } else if (kind === 'shift') {
    const to = unit.shift
    if (!to || unit.energy < shiftCost(unit)) return events.push({ type: 'fizzle', by: unit.id, reason: 'energy' })
    unit.energy -= shiftCost(unit)
    // What the form gives takes the place of what they had: the most life and energy stay, so more of either is
    // felt as blows that take less and skills that cost less.
    // 能量耗尽: what they were is kept, to come back to when the form can no longer be fed.
    if (to.drain && !unit.back) unit.back = { ...(unit.bonus ? { bonus: unit.bonus } : {}), skills: unit.id === 'player' ? state.skills : unit.skills, ...(unit.type ? { type: unit.type } : {}), fresh: true }
    if (to.bonus) unit.bonus = to.bonus
    else delete unit.bonus
    if (unit.id === 'player') state.skills = to.skills
    else unit.skills = to.skills
    if (to.type) unit.type = to.type
    unit.shifted = to.name
    // A form for a fight only that follows this one can be taken next, at the same cost.
    if (to.then) unit.shift = to.then
    else delete unit.shift
    const healed = Math.min(unit.maxLife - unit.life, Math.round(unit.maxLife * SHIFT_HEAL))
    unit.life += healed
    events.push({ type: 'shift', by: unit.id, name: to.name, heal: healed, life: unit.life, energy: unit.energy })
    state.moments.push({ round: state.round, kind: 'shift', form: to.name, ...(unit.id === 'player' ? {} : { who: unit.name }) })
    giveBoost(state, unit, events)
    // And a blow with it: one who changes does not stand idle for it.
    const prey = target?.side === 'foe' && target.life > 0 ? target : aliveFoes(state).length ? weakest(state) : null
    if (prey) blow(state, unit, prey, 1, events)
  } else if (kind === 'skill') {
    const skill = skillsOf(state, unit).find(item => item.name === command.name)
    if (unit.energy < skillCost(state, skill, unit)) return events.push({ type: 'fizzle', by: unit.id, reason: 'energy' })
    // 类型克制: what it strikes as, while it is being used.
    if (skill.type) unit.hitsAs = skill.type
    useSkill(state, unit, skill, target, events, friend)
    delete unit.hitsAs
  } else {
    const thing = state.things.find(item => item.name === command.name && item.count > 0)
    // Two of the party reached for the last of it.
    if (!thing) return events.push({ type: 'fizzle', by: unit.id, reason: 'item' })
    useThing(state, unit, thing, target, events, friend)
  }
}

const speedOf = unit => (unit.side === 'foe' ? TIERS[unit.tier].speed + (unit.gap ?? 0) : unit.modifiers.grace + (unit.bonus?.speed ?? 0))
// 先手: in the first round, before anyone that has not got it.
const FIRST = 100

/**
 * Who acts in what order this round. The player alone acts first and the foes after in turn, as it always was;
 * a party and its foes go by speed, rolled anew each round, the party first where it is even.
 */
function turnOrder(state, commands) {
  const party = partyOf(state).filter(unit => unit.life > 0 && commands.has(unit.id))
  if (solo(state)) return [...party, ...aliveFoes(state)]
  const all = [...party, ...aliveFoes(state)].map((unit, i) => ({ unit, i, speed: speedOf(unit) + random(state) * SPEED_SPREAD + (state.round === 1 && unit.bonus?.first ? FIRST : 0) }))
  all.sort((a, b) => b.speed - a.speed || (a.unit.side === b.unit.side ? a.i - b.i : a.unit.side === 'player' ? -1 : 1))
  return all.map(entry => entry.unit)
}

const lostAll = state => fightersOf(state).length === 0

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
    if (unit.stun > 0) continue
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
      // 迟缓: what it holds back adds up, round by round, until it is a whole action lost.
      if (unit.slow > 0) unit.lag = (unit.lag ?? 0) + unit.slowBy
      for (; unit.tempo >= 1 - 1e-9; unit.tempo -= 1) {
        if (unit.life <= 0 || lostAll(state)) continue
        if (unit.lag >= 1 - 1e-9) {
          unit.lag -= 1
          events.push({ type: 'slowed', by: unit.id })
        } else foeActs(state, unit, events)
      }
    }
    else if (unit.stun > 0) {
      // 眩晕: whatever they were told, the action is lost.
      unit.stun -= 1
      events.push({ type: 'stunned', by: unit.id, ...(unit.late ? { late: true } : {}) })
      delete unit.late
    } else act(state, unit, told.get(unit.id), events)
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
  const armour = (1 - ARMOUR * unit.modifiers.body) * (1 - (unit.bonus?.guard ?? 0))
  const incoming = foes.reduce((sum, foe) => sum + lifeBefore(unit) * foe.damage * (foe.charging ? 2 : 1), 0) * armour * DIFFICULTY[state.difficulty]
  const has = thing => thing.count - (left?.[thing.name] ?? 0) > 0
  const healing = state.things.find(thing => has(thing) && thing.effect.type === 'heal')
  // 指挥: a draught to whoever is worst off, else heart to one who has none.
  if (unit.commander) {
    const worst = fightersOf(state).sort((a, b) => a.life / a.maxLife - b.life / b.maxLife)[0]
    if (healing && worst.life < worst.maxLife * 0.45) return { who, kind: 'item', name: healing.name, target: worst.id }
    const plain = fightersOf(state).find(one => !(one.boost > 0))
    return plain ? { who, kind: 'cheer', target: plain.id } : { who, kind: 'guard' }
  }
  const skills = skillsOf(state, unit).filter(skill => unit.energy >= skillCost(state, skill, unit))
  if (!solo(state)) {
    const mend = skills.find(skill => SKILLS[skill.kind].heal)
    const hurt = alivePartyOf(state).concat(partyOf(state).filter(item => item.life === 0)).sort((a, b) => a.life / a.maxLife - b.life / b.maxLife)[0]
    if (mend && hurt && (hurt.life === 0 || hurt.life < hurt.maxLife * 0.45)) return { ...tag, kind: 'skill', name: mend.name, ...(hurt.id === unit.id ? {} : { target: hurt.id }) }
  }
  // Alone, what may come at you is everything; in a party, about a share of it, with some to spare.
  const threat = solo(state) ? incoming : (incoming / Math.max(1, fightersOf(state).length)) * 1.6
  if (unit.life <= threat * 1.1 && healing) return { ...tag, kind: 'item', name: healing.name }
  const charging = foes.find(foe => foe.charging)
  const big = charging && charging.life > BLOW * SKILLS.strike.power * 1.2
  // 护盾: before a blow that is coming, or when the next ones could end it and there is nothing to drink.
  const ward = skills.find(skill => SKILLS[skill.kind].ward)
  if (ward && !(unit.ward > 0) && big) return { ...tag, kind: 'skill', name: ward.name }
  // 挑衅: alone it is a lighter guard that lasts; in a party it is for one who can take what another cannot.
  const taunt = skills.find(skill => SKILLS[skill.kind].status === 'taunt')
  if (taunt && !(unit.taunt > 0) && !solo(state) && (unit.life > unit.maxLife * 0.6 && alivePartyOf(state).some(other => other !== unit && other.life < other.maxLife * 0.5))) return { ...tag, kind: 'skill', name: taunt.name }
  if (big && (solo(state) || unit.life < unit.maxLife * 0.6)) return { ...tag, kind: 'guard' }
  // 临时进化: for a fight worth it, as soon as it can be afforded.
  if (unit.shift && unit.energy >= shiftCost(unit) && foes.some(foe => foe.tier === 'elite' || foe.tier === 'boss')) return { ...tag, kind: 'shift' }
  // 鼓舞: once, while there is a fight left to be had of it.
  const rally = alivePartyOf(state).length < 3 ? null : skills.find(skill => SKILLS[skill.kind].status === 'rally')
  if (rally && !alivePartyOf(state).some(other => other.boost > 0) && foes.reduce((sum, foe) => sum + foe.life, 0) > BLOW * 12) return { ...tag, kind: 'skill', name: rally.name }
  const blows = skills.filter(skill => SKILLS[skill.kind].power)
  const sweep = foes.length > 1 ? blows.find(skill => skill.kind === 'sweep') : null
  if (sweep) return { ...tag, kind: 'skill', name: sweep.name }
  const prey = weakest(state)
  const might = skill => {
    const rule = SKILLS[skill.kind]
    const sized = id => { const add = skill.adds?.find(item => item.id === id); return add ? addSize(add) : 0 }
    const edge = edgeOf(state, skill.type ?? unit.type, prey.type)
    const plain = rule.power * (rule.hits ?? 1) * (skill.power ?? 1) * addWeight(skill.adds) * (rule.finish && prey.life < prey.maxLife * FINISH_AT ? rule.finish : 1) * (edge ? EDGE[edge] : 1)
    if (!skill.adds) return plain
    // What it would leave on a foe is worth something while the foe will be there to bear it, and does not bear it already.
    const lasting = prey.life > BLOW * rule.power * 1.5
    const fresh = [['poison', prey.poison > 0], ['weaken', prey.weak > 0], ['expose', prey.open > 0], ['slow', prey.slow > 0], ['stun', false]].reduce((sum, [id, held]) => sum + (lasting && !held && sized(id) ? addCost(skill.adds.find(item => item.id === id)) : 0), 0)
    const back = (unit.life < unit.maxLife * 0.7 && sized('leech') ? 0.2 : 0) + (sized('surge') ? 0.1 : 0)
    return plain + 0.25 * fresh + back
  }
  const hardest = blows.filter(skill => SKILLS[skill.kind].target === 'one').sort((a, b) => might(b) - might(a))[0]
  if (hardest) return { ...tag, kind: 'skill', name: hardest.name, target: prey.id }
  return { ...tag, kind: 'attack', target: prey.id }
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
