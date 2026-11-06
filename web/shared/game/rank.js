// 等级阶梯: a card's ranks from low to high (炼气、筑基、金丹…), and how far a foe stands from the player. A rank has four
// steps (初期 to 圆满), and a level of the rules is one step: level 1 is the first step of the first rank. A card with no
// ranks has the words alone: the model says how a foe stands to the player, and the rules work out what that means.
export const STEPS_PER_RANK = 4
const STEPS = [/^[\s·]*(初|前|低|下)/, /^[\s·]*中/, /^[\s·]*(后|高|上)/, /^[\s·]*(大?圆满|巅峰|极)/]

/** How a foe stands to the player, in the words a model writes. 0 is an even fight. */
export const GAP_WORDS = { 远弱: -2, 稍弱: -1, 相当: 0, 稍强: 1, 强: 2, 远强: 3 }

/** Where a rank stands in a text. A rank in letters stands alone: the S of S级, not of BOSS. */
function placeIn(words, rank) {
  if (!/^[A-Za-z0-9]+$/.test(rank)) return words.indexOf(rank)
  const found = new RegExp(`(^|[^A-Za-z0-9])${rank}(?![A-Za-z0-9])`).exec(words)
  return found ? found.index + found[1].length : -1
}

/** How far along the ranks a text stands: the longest rank it names, and the step after that. Null for a text that names none. */
export function rankPower(ranks, text) {
  const words = String(text ?? '')
  const named = ranks.map((rank, at) => ({ rank, at, place: placeIn(words, rank) })).filter(item => item.rank && item.place >= 0)
  if (!named.length) return null
  const best = named.reduce((held, item) => (item.rank.length >= held.rank.length ? item : held))
  const step = STEPS.findIndex(word => word.test(words.slice(best.place + best.rank.length)))
  return best.at * STEPS_PER_RANK + Math.max(0, step)
}

/** The rank a level of the rules comes to. */
export const rankAt = (ranks, level) => ranks[Math.min(ranks.length - 1, Math.max(0, Math.floor((level - 1) / STEPS_PER_RANK)))] ?? ''

/** The level a story starts at to stand at a rank. */
export const levelOfRank = (ranks, rank) => Math.max(0, ranks.indexOf(rank)) * STEPS_PER_RANK + 1

/** Two steps apart is a real difference, a rank is a wall, two ranks are out of reach. On a ladder of small steps it takes twice that. */
function gapBetween(theirs, ours, span) {
  const apart = (theirs - ours) * (span === 'narrow' ? 0.5 : 1)
  if (apart >= STEPS_PER_RANK * 2) return 3
  if (apart >= STEPS_PER_RANK) return 2
  if (apart >= 2) return 1
  if (apart <= -STEPS_PER_RANK) return -2
  return apart <= -2 ? -1 : 0
}

/**
 * How strong a foe is beside the player, from the word its mark has: { gap, rank? }. A word the rules do not know is an
 * even fight: the mark still works.
 */
export function strengthOf(word, sheet, ranks = [], span = 'wide') {
  const said = String(word ?? '').trim()
  if (Object.hasOwn(GAP_WORDS, said)) return { gap: GAP_WORDS[said] }
  const theirs = rankPower(ranks, said)
  const ours = sheet.rank ? rankPower(ranks, sheet.rank) : (sheet.level ?? 1) - 1
  return theirs === null || ours === null ? { gap: 0 } : { gap: gapBetween(theirs, ours, span), rank: said.slice(0, 12) }
}
