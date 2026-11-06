// 游戏规则的骰子. A roll comes from a seed, never from the clock: the page (for its animation) and the
// server (for what the model is told) get the same number, and rolling again after a reload, a rollback
// or a load gives what it gave. Runs on old WebViews too: no \p{}, Intl or normalize.

const MIN_DC = 5
const MAX_DC = 25
// What a condition takes off every roll it touches, by how bad it is.
const MARRED = { light: 1, medium: 2, heavy: 3 }
// However much holds a player back, a roll stays worth trying: this much at most.
const MOST_MARRED = 4
const weightOf = item => MARRED[item.size] ?? 1

/** A 32-bit seed from any strings: the chat's id first, since every chat's root is called `root`. */
export function seedOf(...parts) {
  let hash = 2166136261
  const text = parts.join('\u0000')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  hash ^= hash >>> 16
  return Math.imul(hash, 2246822507) >>> 0
}

/** The numbers of a seed, each in [0, 1), the same every time (mulberry32). */
export function randomFrom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), state | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export const rollD20 = seed => 1 + Math.floor(randomFrom(seed)() * 20)

/** 10 is an ordinary person's attribute: 6 → −2, 20 → +5. */
export const modifierOf = attribute => Math.floor((attribute - 10) / 2)

/** What conditions take off a stat: those on it, and those on everything, the worst first and only as far as the most there can be. → [{ name, by }] */
export function ailsOn(conditions, id) {
  let left = MOST_MARRED
  return (conditions ?? []).filter(item => !item.stat || item.stat === id).sort((a, b) => weightOf(b) - weightOf(a)).flatMap(item => {
    const by = Math.min(left, weightOf(item))
    left -= by
    return by ? [{ name: item.name, by }] : []
  })
}

/** The worst of some conditions. */
export const worstAil = conditions => conditions.reduce((most, item) => (weightOf(item) > weightOf(most) ? item : most))

/** The same as one number. */
export const marredBy = (conditions, id) => ailsOn(conditions, id).reduce((sum, ail) => sum + ail.by, 0)

export const clampDc = dc => Math.min(MAX_DC, Math.max(MIN_DC, Math.round(dc)))

/**
 * What a roll came to. A 1 always fails and a 20 is always the best there is; two short of the DC
 * still gets there, at a price.
 * @returns {{ roll: number, modifier: number, total: number, dc: number, tier: 'crit'|'success'|'close'|'fail' }}
 */
export function judge(roll, modifier, dc) {
  const total = roll + modifier
  const margin = total - dc
  const tier = roll === 1 ? 'fail' : roll === 20 || margin >= 10 ? 'crit' : margin >= 0 ? 'success' : margin >= -2 ? 'close' : 'fail'
  return { roll, modifier, total, dc, tier }
}

/** The chance to get there, 险胜 included, in percent. */
export function chanceOf(modifier, dc) {
  let wins = 0
  for (let roll = 1; roll <= 20; roll++) if (judge(roll, modifier, dc).tier !== 'fail') wins++
  return wins * 5
}

export const riskOf = percent => (percent >= 75 ? 'safe' : percent >= 40 ? 'risky' : 'danger')
