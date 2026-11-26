// 养成: creatures raised as ones of their own. With it off (as it always was) one who joins comes at the player's level
// with plain attributes. With it on (book.growth.raise) each kind has 种族值 of its own, a form has more of them than
// the one before, one caught comes at the level it was met at, with a 性格 and a 资质 that are its alone, and how far it
// stands from the player counts in a fight. Nothing here knows of sheets: sheet.js and encounter.js hand it what it
// needs. Runs on old WebViews too.
import { RAISED_LEAST, RAISED_MOST, bonusOf, growsOn, powerOf } from './growth.js'
import { modifierOf, randomFrom, seedOf } from './dice.js'
import { rankPower } from './rank.js'

/** Whether a card raises its creatures. */
export const raisesOn = book => growsOn(book) && book?.growth?.raise === true

const IDS = ['body', 'grace', 'mind', 'charm']
const PLAIN = 10
const within = value => Math.max(RAISED_LEAST, Math.min(RAISED_MOST, Math.round(value)))

// A kind the card gives no 种族值: plain ones, more of them the higher its rank.
const byRank = at => ({ body: PLAIN + 2 * at, grace: PLAIN + at, mind: PLAIN + 2 * at, charm: PLAIN })
// A form the card gives none: what the one before had, and a step more, the most of it where it was best.
const STEP = [3, 3, 2, 1]
const stepped = base => {
  const order = IDS.slice().sort((a, b) => base[b] - base[a])
  return Object.fromEntries(IDS.map(id => [id, within(base[id] + STEP[order.indexOf(id)])]))
}

/** How high in the card's ranks a kind stands in a form of its, by what the card says of it, or null. */
export function rankOf(book, name, at = 0) {
  for (const word of [book?.forms?.[name]?.[at]?.stage, at === 0 ? book?.foes?.[name]?.rank : '']) {
    const power = word ? rankPower(book?.ranks ?? [], word) : null
    if (power !== null) return power
  }
  return null
}

/** 种族值 of a kind in one of its forms (0 the first): the card's own, or worked out from what it says. */
export function speciesOf(book, name, at = 0) {
  const chain = book?.forms?.[name] ?? []
  const power = rankOf(book, name)
  let base = book?.companions?.[name]?.attributes ?? book?.foes?.[name]?.attributes ?? chain[0]?.attributes ?? byRank(power === null ? 0 : Math.floor(power / 4))
  for (let i = 1; i <= at && i < chain.length; i++) base = chain[i].attributes ?? stepped(base)
  return { ...base }
}

/** The level one of a kind is met at when nothing says how strong it is: one into the rank its form stands at, or null. */
export function wildLevel(book, name, at = 0) {
  const power = rankOf(book, name, at)
  return power === null ? null : power + 1 + (power % 4 === 0 ? 1 : 0)
}

// A foe's level within its rank, by its tier.
const IN_RANK = { minion: 0, normal: 0, elite: 1, boss: 2 }
/** The level of a foe the story gave a rank, or null for one it gave only a word. */
export function foeLevel(book, foe) {
  const power = foe.rank ? rankPower(book?.ranks ?? [], foe.rank) : null
  return power === null ? null : power + 1 + Math.min(3 - (power % 4), IN_RANK[foe.tier] ?? 0)
}

// ─── 性格 and 资质 ────────────────────────────────────────────────────────
/** 性格: what one of a kind has more of than its kind, and what less. The page has the names in its own language, by id. */
export const NATURES = [
  ['body', 'grace', '沉稳'], ['body', 'mind', '莽撞'], ['body', 'charm', '孤僻'],
  ['grace', 'body', '轻灵'], ['grace', 'mind', '急躁'], ['grace', 'charm', '机警'],
  ['mind', 'body', '聪慧'], ['mind', 'grace', '沉静'], ['mind', 'charm', '冷傲'],
  ['charm', 'body', '亲人'], ['charm', 'grace', '憨厚'], ['charm', 'mind', '活泼'],
].map(([up, down, name]) => ({ id: `${up}-${down}`, up, down, name }))
export const natureOf = id => NATURES.find(nature => nature.id === id) ?? null
export const NATURE_UP = 2
export const NATURE_DOWN = 1
/** 资质: how much more than its kind one has, shared over what it is best at. `odds` in a hundred. */
export const TALENTS = [
  { id: 'plain', name: '普通', odds: 34, points: 0 },
  { id: 'good', name: '良好', odds: 32, points: 2 },
  { id: 'fine', name: '优秀', odds: 21, points: 4 },
  { id: 'rare', name: '卓越', odds: 10, points: 6 },
  { id: 'peerless', name: '绝世', odds: 3, points: 9 },
]
export const talentOf = id => TALENTS.find(talent => talent.id === id) ?? null

/** What one is born with, the same for the same seed: { nature, talent }. */
export function born(...seed) {
  const random = randomFrom(seedOf('born', ...seed.map(String)))
  const nature = NATURES[Math.floor(random() * NATURES.length)].id
  let roll = random() * 100
  const talent = (TALENTS.find(item => (roll -= item.odds) < 0) ?? TALENTS[0]).id
  return { nature, talent }
}

/** The attributes one of a kind starts from in a form of it, with what it was born with. */
export function bornAttributes(book, name, at = 0, { nature, talent } = {}) {
  const base = speciesOf(book, name, at)
  const out = { ...base }
  const own = natureOf(nature)
  if (own) {
    out[own.up] += NATURE_UP
    out[own.down] -= NATURE_DOWN
  }
  const order = IDS.slice().sort((a, b) => base[b] - base[a])
  for (let i = 0; i < (talentOf(talent)?.points ?? 0); i++) out[order[i % 3]] += 1
  return Object.fromEntries(IDS.map(id => [id, within(out[id])]))
}

/** What coming from one form to another does to the attributes: the difference between the two, what was grown kept. */
export function reshaped(attributes, book, name, from, to) {
  const was = speciesOf(book, name, from)
  const now = speciesOf(book, name, to)
  return Object.fromEntries(IDS.map(id => [id, within((attributes?.[id] ?? PLAIN) + now[id] - was[id])]))
}

// What of a level's points goes where, for one who grows by itself: to what its kind is best at; charm is no use in a fight.
const LEANS = { body: 1, grace: 0.8, mind: 1, charm: 0.25 }
/** Points shared out as one of its kind grows. → { attributes, left } */
export function grownBy(attributes, points, book, name, at = 0) {
  const base = speciesOf(book, name, at)
  const out = { ...attributes }
  let left = points
  const pull = id => (LEANS[id] * Math.max(1, base[id] - 6)) / (1 + Math.max(0, out[id] - base[id]))
  for (; left > 0; left--) {
    const open = IDS.filter(id => out[id] < RAISED_MOST)
    if (!open.length) break
    out[open.reduce((best, id) => (pull(id) > pull(best) + 1e-9 ? id : best))] += 1
  }
  return { attributes: out, left }
}

// ─── levels against levels ────────────────────────────────────────────────
// What standing so many levels from the player makes of what one deals and what one takes, in step with what a foe's
// gap makes of a foe (battle.js GAPS): one caught a rank above hits about as it did. What is below is gentler: a young
// one is to be brought up, not left at home.
const LIFT = [[-4, 0.65, 1.25], [-2, 0.8, 1.12], [0, 1, 1], [2, 1.4, 0.77], [4, 2.1, 0.52], [8, 4, 0.28]]
/** How many levels over the player one heeds them for, with no 羁绊; each step of it is one more. */
export const HEED = 6
/** How far one's level stands from the player's, as much of it as they heed. */
export const liftLevels = (level, player, bond = 0) => Math.max(-4, Math.min(HEED + bond, level - player))
/** What that makes of what they deal and take: { deal, take }, or null for one at the player's level. */
export function liftOf(level, player, bond = 0) {
  const apart = liftLevels(level, player, bond)
  if (!apart) return null
  const i = Math.max(1, LIFT.findIndex(([at]) => at >= apart))
  const [a, dealA, takeA] = LIFT[i - 1]
  const [b, dealB, takeB] = LIFT[i]
  const part = (apart - a) / (b - a)
  const mix = (x, y) => Math.round(Math.exp(Math.log(x) + (Math.log(y) - Math.log(x)) * part) * 1000) / 1000
  return { deal: mix(dealA, dealB), take: mix(takeA, takeB) }
}

// ─── experience ───────────────────────────────────────────────────────────
/** The experience a level takes on a card that raises: a pet is brought up in a story's worth of fights. */
export const raisedNeeds = level => 40 + 25 * level
/** What one who stood by gets of what a fight was worth. */
export const BENCH_SHARE = 0.5
/** What a fight is worth to one at a level, beside what it is to the player: more to the young, less to those far ahead. */
export const catchUp = (level, player) => Math.max(0.3, Math.min(3, Math.round(1.2 ** (player - level) * 100) / 100))

// ─── the foes ─────────────────────────────────────────────────────────────
// What the 种族值 and points of a level are worth to one who has them: a foe of that level has its share of it too. Each
// level is worth a little more than the one before, as a form is over the form before it (worked out by `simulate`).
const FOE_DEAL = [0.09, 0.004]
const FOE_TAKE = [0.06, 0.003]
const FOE_SHARE = { easy: 0.5, normal: 0.75, hard: 1 }
/** What a foe has for its own level, where the card raises: { life, damage } to multiply by, or null. */
export function foeGrown(level, difficulty = 'normal') {
  const levels = Math.max(0, Math.min(24, level - 1))
  if (!levels) return null
  const worth = ([each, more]) => Math.round((1 + (FOE_SHARE[difficulty] ?? FOE_SHARE.normal) * (each * levels + more * levels * levels)) * 1000) / 1000
  return { life: worth(FOE_DEAL), damage: worth(FOE_TAKE) }
}

// What a level is worth beside the one before, as the fights have it, and what acting sooner is worth.
const LEVEL_WORTH = 1.18
const SPEED_WORTH = 0.04
/** 战力 on a card that raises: what one is made of, with how far along they are. */
export function raisedPower(who, book) {
  const speed = modifierOf(who.attributes?.grace ?? PLAIN) + bonusOf(who, book).speed
  return Math.round(powerOf(who, book) * Math.max(0.6, 1 + SPEED_WORTH * speed) * LEVEL_WORTH ** (Math.max(1, who.level ?? 1) - 1))
}
