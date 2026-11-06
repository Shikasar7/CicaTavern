// 遭遇: a fight in the story. Where it comes from (the mark a reply stopped on) and what it comes to (the numbers the
// turn after it settles). The page and the server both work these out from what was done: what the page reports is
// played through again, so what the model is told is what the rules say happened.
import { attemptSetup, battleSetup, fieldFoes, foesOf, playerOf, replay, rewardOf, shockOf, simulate } from './battle.js'
import { effectOf } from './sheet.js'
import { strengthOf } from './rank.js'

const EXPERIENCE = { minion: 10, normal: 20, elite: 50, boss: 150 }
const CHANCE_RUNS = 200
const ENDS = ['won', 'lost', 'fled', 'story']
const MAX_ACTIONS = 300
const OVER_WORDS = { won: '胜利', lost: '战败', fled: '逃脱' }

/** The fight a reply stopped on, for the sheet as it stands. */
export function encounterSetup(sheet, book, gate, chatId, nodeId) {
  const foes = fieldFoes(gate.foes.map(foe => ({ ...foe, ...strengthOf(foe.power, sheet, book.ranks, book.rankSpan) })))
  return battleSetup(sheet, { foes, seed: `${chatId}:${nodeId}`, difficulty: book.fightDifficulty ?? book.difficulty, effects: name => effectOf(book, name), kinds: book.skills })
}

/** The foes in a line: 灰狼 ×2、狼王. */
export function foesLine(foes) {
  const counts = new Map()
  for (const foe of foes) counts.set(foe.name, (counts.get(foe.name) ?? 0) + 1)
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join('、') // i18n-ignore: names from the story
}

/** The chance of winning as 自动 would play it, in percent. */
export const chanceToWin = setup => Math.round(simulate(setup, CHANCE_RUNS).chance)

/** What the page reports of a fight, cleaned: { over, attempt, actions }, or null. */
export function cleanFight(value) {
  if (!value || !ENDS.includes(value.over)) return null
  const actions = Array.isArray(value.actions) ? value.actions.slice(0, MAX_ACTIONS).map(action => ({ kind: String(action?.kind ?? ''), ...(action?.name ? { name: String(action.name) } : {}), ...(action?.target ? { target: String(action.target) } : {}) })) : []
  return { over: value.over, attempt: Number.isInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0, actions }
}

/**
 * What a fight came to. → { battle (kept with the turn, for the model and the transcript), op (the sheet's change, or
 * null for one left to the story) }. Throws when what was reported does not play through to that end.
 */
export function fightResult(setup, fight) {
  const foesAll = foesLine(setup.foes)
  if (fight.over === 'story') return { battle: { over: 'story', foes: foesAll }, op: null }
  const state = replay(attemptSetup(setup, fight.attempt), fight.actions)
  if (state.over !== fight.over) throw new Error('battle: the report does not match')
  const player = playerOf(state)
  const downed = foesOf(state).filter(foe => foe.life === 0)
  const experience = fight.over === 'lost' ? 0 : downed.reduce((sum, foe) => sum + Math.round(EXPERIENCE[foe.tier] * rewardOf(foe)), 0)
  const shock = setup.player.counts?.sanity ? Math.max(0, ...setup.foes.map(shockOf)) : 0
  const used = {}
  const skills = []
  for (const [name, count] of Object.entries(state.used)) {
    if (name.startsWith('skill:')) skills.push(name.slice(6))
    else used[name] = count
  }
  return {
    battle: { over: fight.over, foes: foesAll, downed: foesLine(downed), rounds: state.round, before: setup.player.life, life: player.life, maxLife: player.maxLife, used, skills, moments: state.moments.slice(0, 3), experience, ...(state.rallied ? { rallied: true } : {}), ...(shock ? { shock } : {}) },
    op: { op: 'battle', over: fight.over, life: player.life, energy: player.energy, used, experience, ...(state.rallied ? { rallied: true } : {}), ...(state.cured.length ? { cured: state.cured } : {}), ...(shock ? { shock } : {}) },
  }
}

/** A fight in a line: what a settling turn says it was. */
export function fightLine(battle) {
  return battle.over === 'story' ? `不走战斗：${battle.foes}` : `战斗：${OVER_WORDS[battle.over]}，${battle.rounds} 回合`
}
