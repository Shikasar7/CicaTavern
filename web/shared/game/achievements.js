// 成就: what a story line has done, counted from its own turns. Nothing of it is kept anywhere: a rollback or a
// branch takes it back with the turns, and no other data changes.
import { visitedPlaces } from '../vn.js'
import { sheetOnPath } from './sheet.js'

// A win this close to the end, of the most life there is.
const NARROW = 0.2

/** Each with what it counts and how many it takes (the page has the words). */
export const ACHIEVEMENTS = [
  { id: 'first-win', counts: 'wins', need: 1 },
  { id: 'veteran', counts: 'wins', need: 10 },
  { id: 'boss', counts: 'bosses', need: 1 },
  { id: 'narrow', counts: 'narrow', need: 1 },
  { id: 'untouched', counts: 'untouched', need: 1 },
  { id: 'escape', counts: 'escapes', need: 1 },
  { id: 'first-crit', counts: 'crits', need: 1 },
  { id: 'lucky', counts: 'crits', need: 5 },
  { id: 'first-quest', counts: 'quests', need: 1 },
  { id: 'quests', counts: 'quests', need: 5 },
  { id: 'level', counts: 'level', need: 5 },
  { id: 'places', counts: 'places', need: 5 },
]

/** What a story line adds up to. */
export function tallyOf(path) {
  const tally = { wins: 0, bosses: 0, narrow: 0, untouched: 0, escapes: 0, crits: 0 }
  path.forEach((node, i) => {
    if (node.check?.tier === 'crit') tally.crits++
    const { battle } = node
    if (battle?.over === 'fled') tally.escapes++
    if (battle?.over !== 'won') return
    tally.wins++
    if (path[i - 1]?.gate?.foes?.some(foe => foe.tier === 'boss')) tally.bosses++
    if (battle.life <= battle.maxLife * NARROW) tally.narrow++
    if (battle.life >= battle.before) tally.untouched++
  })
  const sheet = sheetOnPath(path)
  return {
    ...tally,
    quests: (sheet?.quests ?? []).filter(quest => quest.status === 'done').length,
    level: sheet?.level ?? 1,
    places: visitedPlaces(path).places.length,
  }
}

export const reachedBy = tally => ACHIEVEMENTS.filter(item => tally[item.counts] >= item.need)

/** What the reply at `nodeId` brought: those reached with it, and not with the reply before it. */
export function reachedWith(path, nodeId) {
  const at = path.findIndex(node => node.id === nodeId)
  if (at < 0) return []
  const before = path.slice(0, at).findLastIndex(node => node.role === 'assistant')
  const had = new Set(reachedBy(tallyOf(path.slice(0, before + 1))).map(item => item.id))
  return reachedBy(tallyOf(path.slice(0, at + 1))).filter(item => !had.has(item.id))
}
