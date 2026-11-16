// 遭遇: a fight in the story. Where it comes from (the mark a reply stopped on) and what it comes to (the numbers the
// turn after it settles). The page and the server both work these out from what was done: what the page reports is
// played through again, so what the model is told is what the rules say happened.
import { MAX_PARTY, alliesOf, attemptSetup, autoCommands, battleSetup, fieldFoes, foesOf, playerOf, replay, rewardOf, shockOf, simulate, startBattle, step, tameTry } from './battle.js'
import { modifierOf } from './dice.js'
import { alliesFor, effectOf, fieldedOf, playerGrowth, typesFor } from './sheet.js'
import { foesFollow, growsOn, wornWorth } from './growth.js'
import { gapBetween, standingAt, standingOf, strengthOf } from './rank.js'

const EXPERIENCE = { minion: 10, normal: 20, elite: 50, boss: 150 }
const CHANCE_RUNS = 200
const ENDS = ['won', 'lost', 'fled', 'story']
const MAX_ACTIONS = 300
const OVER_WORDS = { won: '胜利', lost: '战败', fled: '逃脱' }

/**
 * A foe as the player faces it now. → { foe, met? }. On a card that counts growth, one the story gave only a word
 * for (相当、稍强) follows part of what growing is worth, and is as strong as when the player first met it: a word
 * is how it stood to the player then, not now. `met`: what to remember of it, the first time or when the story says
 * it has grown stronger since. One with a rank of its own is as strong as its rank, always.
 */
function facing(group, sheet, book, difficulty) {
  // 招式效果: what the card's bestiary says this kind does with its blows; the fight keeps what its tier has room for.
  const adds = book.foes?.[group.name]?.adds
  // 类型克制: its type, on a card that has types.
  const type = book.types ? book.foes?.[group.name]?.type : ''
  const known = adds?.length || type ? { ...group, ...(adds?.length ? { adds } : {}), ...(type ? { type } : {}) } : group
  const strength = strengthOf(group.power, sheet, book.ranks, book.rankSpan)
  if (!growsOn(book) || strength.rank) return { foe: { ...known, ...strength } }
  const level = sheet.level ?? 1
  const ours = standingOf(sheet, book.ranks)
  const before = sheet.met?.[group.name]
  // 装备: what those who fight have on is followed too, as it was when the foe was first met.
  const worn = wornWorth([sheet, ...fieldedOf(sheet)], book)
  if (!before || strength.gap > before.gap) return { foe: { ...known, ...strength, up: foesFollow(level, book, difficulty, undefined, worn) }, met: { at: standingAt(strength.gap, ours, book.rankSpan), gap: strength.gap, level, ...(worn ? { worn } : {}) } }
  const gap = Math.min(strength.gap, gapBetween(before.at, ours, book.rankSpan))
  return { foe: { ...known, gap, up: foesFollow(before.level, book, difficulty, undefined, before.worn ?? null), ...(before.level < level ? { since: before.level } : {}) } }
}

/** The fight a reply stopped on, for the sheet as it stands. */
export function encounterSetup(sheet, book, gate, chatId, nodeId) {
  const allies = alliesFor(sheet, book).slice(0, MAX_PARTY - 1)
  const difficulty = book.fightDifficulty ?? book.difficulty
  const faced = gate.foes.map(foe => facing(foe, sheet, book, difficulty))
  const met = Object.fromEntries(faced.filter(one => one.met).map(one => [one.foe.name, one.met]))
  // 指挥: the player leads from behind where someone stands with them; alone, they fight as ever.
  const lead = book.lead === 'command' && allies.length ? 'command' : ''
  const foes = fieldFoes(faced.map(one => one.foe), { members: (lead ? 0 : 1) + allies.length })
  const types = typesFor(book, sheet)
  // 收服: a roll on the player's 魅力, where there is room for one more.
  const tame = book.tame && (sheet.party ?? []).length < 8 ? { charm: modifierOf(sheet.attributes?.charm ?? 10), have: [...new Set([...(sheet.party ?? []).map(member => member.name), ...Object.keys(book.companions ?? {})])] } : null
  return { ...battleSetup(sheet, { foes, seed: `${chatId}:${nodeId}`, difficulty, effects: name => effectOf(book, name), kinds: book.skills, allies, ...(book.skillAdds ? { adds: book.skillAdds } : {}), ...playerGrowth(sheet, book), ...(types ? { types } : {}), ...(lead ? { lead } : {}), ...(tame ? { tame } : {}) }), ...(Object.keys(met).length ? { met } : {}) }
}

/** Whether a fight is beyond the player: a foe in it stands well above them. Such a one can be left to the story even when the story forced it. */
export const beyond = setup => setup.foes.some(foe => (foe.gap ?? 0) >= 2)

/** Whether a fight is one not worth the playing: every foe far below the player, none of them more than an ordinary one. */
export const beneath = setup => setup.foes.length > 0 && setup.foes.every(foe => (foe.gap ?? 0) <= -2 && (foe.tier === 'minion' || foe.tier === 'normal'))

/** A fight played through as 自动 would, for one settled without the screen: what the page would have reported. */
export function playedOut(setup) {
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    const action = autoCommands(state)
    actions.push(action)
    state = step(state, action).state
  }
  return { over: state.over, attempt: 0, actions }
}

/** The foes in a line: 灰狼 ×2、狼王. */
export function foesLine(foes) {
  const counts = new Map()
  for (const foe of foes) counts.set(foe.name, (counts.get(foe.name) ?? 0) + 1)
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join('、') // i18n-ignore: names from the story
}

/** The chance of winning as 自动 would play it, in percent. */
export const chanceToWin = setup => Math.round(simulate(setup, CHANCE_RUNS).chance)

/**
 * How much a fight that was won is worth to the story: 'small' for one against the ordinary, 'fair' for one that took
 * some winning (an elite, or anything above the player), 'great' for a 首领 or what stood well above the player.
 */
export function worthOf(downed) {
  const weight = foe => ({ minion: 0, normal: 0, elite: 1, boss: 2 })[foe.tier] + Math.max(0, foe.gap ?? 0)
  const most = Math.max(0, ...downed.filter(foe => (foe.gap ?? 0) > -2).map(weight))
  return most >= 2 ? 'great' : most >= 1 ? 'fair' : 'small'
}

/** What the page reports of a fight, cleaned: { over, attempt, actions }, or null. */
export function cleanFight(value) {
  if (!value || !ENDS.includes(value.over)) return null
  const one = action => ({ ...(action?.who ? { who: String(action.who) } : {}), kind: String(action?.kind ?? ''), ...(action?.name ? { name: String(action.name) } : {}), ...(action?.target ? { target: String(action.target) } : {}) })
  // A party's round is a command for each of them.
  const actions = Array.isArray(value.actions) ? value.actions.slice(0, MAX_ACTIONS).map(action => (Array.isArray(action) ? action.slice(0, MAX_PARTY).map(one) : one(action))) : []
  return { over: value.over, attempt: Number.isInteger(value.attempt) && value.attempt >= 0 ? value.attempt : 0, actions, ...(typeof value.tame === 'string' && value.tame.trim() ? { tame: value.tame.trim().slice(0, 40) } : {}) }
}

/**
 * What a fight came to. → { battle (kept with the turn, for the model and the transcript), op (the sheet's change, or
 * null for one left to the story) }. Throws when what was reported does not play through to that end.
 */
export function fightResult(setup, fight) {
  const foesAll = foesLine(setup.foes)
  if (fight.over === 'story') return { battle: { over: 'story', foes: foesAll, ...(beyond(setup) ? { beyond: true } : {}) }, op: null }
  const state = replay(attemptSetup(setup, fight.attempt), fight.actions)
  if (state.over !== fight.over) throw new Error('battle: the report does not match')
  const player = playerOf(state)
  const downed = foesOf(state).filter(foe => foe.life === 0)
  const experience = fight.over === 'lost' ? 0 : downed.reduce((sum, foe) => sum + Math.round(EXPERIENCE[foe.tier] * rewardOf(foe)), 0)
  const shock = setup.player.counts?.sanity ? Math.max(0, ...setup.foes.map(shockOf)) : 0
  const party = alliesOf(state).map(ally => ({ name: ally.name, life: ally.life, maxLife: ally.maxLife, ...(ally.fell ? { fell: true } : {}), skills: ally.usedSkills ?? [], ...(setup.grows && ally.uses ? { uses: ally.uses } : {}) }))
  // 临时进化: who took another form for this fight, for the story to show.
  const shifted = [player, ...alliesOf(state)].filter(unit => unit.shifted ?? unit.reverted).map(unit => ({ ...(unit.id === 'player' ? {} : { who: unit.name }), form: unit.shifted ?? unit.reverted }))
  // 收服: one of those brought down, tried for once the fight was won. The roll is the rules', not the page's.
  const wanted = fight.over === 'won' && fight.tame ? downed.find(foe => foe.name === fight.tame && !(setup.allies ?? []).some(ally => ally.name === foe.name)) : null
  const tried = wanted ? tameTry(setup, wanted) : null
  const tame = tried ? { name: wanted.name, ok: tried.ok, roll: tried.roll, total: tried.total, dc: tried.dc } : null
  const used = {}
  const skills = []
  // How often each skill was used: what 熟练 grows from, on a card that counts growth.
  const uses = {}
  for (const [name, count] of Object.entries(state.used)) {
    if (name.startsWith('skill:')) {
      skills.push(name.slice(6))
      uses[name.slice(6)] = count
    } else used[name] = count
  }
  return {
    battle: { over: fight.over, foes: foesAll, downed: foesLine(downed), rounds: state.round, before: setup.player.life, life: player.life, maxLife: player.maxLife, used, skills, moments: state.moments.slice(0, 3), experience, ...(shifted.length ? { shifted } : {}), ...(tame ? { tame } : {}), ...(player.commander ? { commanded: true } : {}), ...(fight.over === 'won' ? { worth: worthOf(downed) } : {}), ...(state.cured.length ? { cured: state.cured.slice() } : {}), ...(state.rallied ? { rallied: true } : {}), ...(shock ? { shock } : {}), ...(party.length ? { party: party.map(({ uses: counted, ...member }) => member) } : {}) },
    op: { op: 'battle', over: fight.over, life: player.life, energy: player.energy, used, experience, ...(tame?.ok ? { tamed: tame.name } : {}), ...(player.commander ? { commanded: true } : {}), ...(state.rallied ? { rallied: true } : {}), ...(state.cured.length ? { cured: state.cured } : {}), ...(shock ? { shock } : {}), ...(setup.grows && Object.keys(uses).length ? { uses } : {}), ...(setup.met ? { met: setup.met } : {}), ...(party.length ? { party: party.map(({ name, life, fell, uses: used }) => ({ name, life, ...(fell ? { fell } : {}), ...(used ? { uses: used } : {}) })) } : {}) },
  }
}

/** A fight in a line: what a settling turn says it was. */
export function fightLine(battle) {
  return battle.over === 'story' ? `不走战斗：${battle.foes}` : `战斗：${OVER_WORDS[battle.over]}，${battle.rounds} 回合`
}
