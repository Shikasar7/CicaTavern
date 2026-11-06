// 游戏规则 in play: what the page shows of them. Loaded only for a chat whose card has rules, or that
// has used them. The sums are in shared/game/, the same the server makes, so the die lands on what the
// model is told.
import { t } from '/i18n.js'
import { reachedWith } from '/shared/game/achievements.js'
import { foeSheets } from '/shared/game/battle.js'
import { changeWords, choiceChecks, choiceFights, cutAtGate, parseChoice, replyMarks, withoutGameMarks } from '/shared/game/marks.js'
import { AID_BONUS, ATTRIBUTES, aidFor, applyOps, chanceFor, checkExperience, checkLine, dcFor, effectOf, gateKinds, levelNeeds, nothingToRestore, rankNow, rollCheck, sheetOf, sheetOnPath, startSheet, turnSheet, usableNow } from '/shared/game/sheet.js'
import { chanceToWin, encounterSetup, foesLine } from '/shared/game/encounter.js'
import { ailsOn, modifierOf, riskOf } from '/shared/game/dice.js'
import { latestPlace, matchScene, normalizePlace, visitedPlaces } from '/shared/vn.js'
import { turnBare, turnDie, turnPan } from '/game-dice.js'
import { ailName, banner, countWord, currentLook, fitFigure, heroNow, letters } from '/game-look.js'
import { noteChips } from '/vn-hud.js'

export { createSound } from '/game-sound.js'
export { ACHIEVEMENTS, tallyOf, reachedBy } from '/shared/game/achievements.js'
export { noteChips, latestPlace, matchScene, normalizePlace, visitedPlaces, applyOps, changeWords, checkExperience, choiceChecks, choiceFights, checkLine, chanceToWin, cutAtGate, effectOf, encounterSetup, gateKinds, nothingToRestore, parseChoice, rankNow, rollCheck, turnSheet, usableNow, withoutGameMarks }

const TIER_WORDS = () => ({ crit: t`大成功`, success: t`成功`, close: t`险胜`, fail: t`失败` })
const TIER_HINTS = () => ({ crit: t`超出预期`, success: '', close: t`差一点，做到了但有代价`, fail: t`没做到` })
const RISK_WORDS = () => ({ safe: t`把握大`, risky: t`有风险`, danger: t`危险` })
const FOE_TIERS = () => ({ minion: t`杂兵`, normal: t`普通`, elite: t`精英`, boss: t`首领` })
const FIGHT_TIERS = { won: 'success', lost: 'fail', fled: 'close', story: 'close' }
const GAP_NOTES = () => ({ [-2]: t`远弱于你`, [-1]: t`稍弱于你`, 1: t`稍强于你`, 2: t`强于你`, 3: t`远强于你` })
// From here on a foe is shown as a danger.
const STRONG = 2
const OUT_OF_REACH = 3
const UNKNOWN = '？' // i18n-ignore: a sign, the same in any language
// The die of each look with a frame of its own, in the page's colours.
const pageColour = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number)
const DIE_LOOKS = {
  console: () => ({ shaded: [24, 42, 140], lit: [120, 150, 255], edge: [255, 255, 255], number: [255, 255, 255], face: [255, 207, 74], onFace: [13, 21, 71], weight: 800, alpha: 1 }),
  bold: () => {
    const [hot, gold, ink, cream] = ['--look-hot-c', '--gold-c', '--deep-c', '--bone-c'].map(pageColour)
    return { shaded: ink.map((value, i) => Math.round(value + (hot[i] - value) * 0.34)), lit: hot, edge: gold, number: cream, face: gold, onFace: ink, weight: 400, alpha: 1 }
  },
}
const SPIN_MS = 1500
// From the die at rest to the word: the stat's bonus is added on the ring first.
const SETTLE_MS = { plain: 460, console: 900, bold: 640 }
const HOLD_MS = 1500
const FADE_MS = 300

/** The sheet the story stands at (or would start with), the card's variables read, with the turn's operations done. */
export function sheetFor(chat, book, ops = []) {
  const reply = chat.path.findLast(node => node.role === 'assistant')
  return applyOps(sheetOf(book, sheetOnPath(chat.path), reply?.state), book, ops).sheet
}

/** The attributes as the 行囊 shows them. */
export const attributesOf = sheet => ATTRIBUTES.map(item => ({ id: item.id, name: item.name, value: sheet.attributes[item.id], modifier: modifierOf(sheet.attributes[item.id]) }))
export { levelNeeds }

/** What holds the player back, as the 行囊 shows it. */
export const ailsOf = sheet => (sheet.conditions ?? []).map(item => ({
  name: item.name,
  shown: ailName(item.name),
  effect: `${ATTRIBUTES.find(attribute => attribute.id === item.stat)?.name ?? t`所有属性`} −${ailsOn([item], item.stat)[0].by}`,
  days: item.days,
  turns: item.turns,
}))

/** What low sanity does, as the 行囊 shows it. */
export const strainOf = sheet => (sheet.strain ?? []).map(item => t`${ailName(item.name)}：${ATTRIBUTES.find(attribute => attribute.id === item.stat).name} −${ailsOn([item], item.stat)[0].by}`)

/** The same in a line, for the HUD. */
export const ailLine = sheet => (sheet.conditions ?? []).map(item => ailName(item.name)).join(t`、`)

/** A turn's operation as its tag by the input box. */
export function opLabel(op) {
  if (op.op === 'use') return t`使用 ${op.name}`
  if (op.op === 'gain') return t`添加 ${op.name}`
  if (op.op === 'lose') return t`减少 ${op.name}`
  if (op.op === 'life') return t`生命改为 ${op.value}`
  if (op.op === 'energy') return t`气力改为 ${op.value}`
  if (op.op === 'sanity') return t`理智改为 ${op.value}`
  if (op.op === 'point') return t`加点 ${ATTRIBUTES.find(item => item.id === op.id)?.name ?? ''}`
  if (op.op === 'mend') return t`解除 ${ailName(op.name)}`
  return op.status === 'new' ? t`新任务 ${op.name}` : op.status === 'done' ? t`完成 ${op.name}` : t`失败 ${op.name}`
}

const counts = sheet => new Map((sheet?.things ?? []).map(thing => [thing.name, thing.count]))

/** All the experience a sheet has come by, levels included: what is left over goes down at a new level. */
function earnedBy(sheet) {
  let total = sheet.experience ?? 0
  for (let level = 1; level < (sheet.level ?? 1); level++) total += levelNeeds(level)
  return total
}

/** 成就, in the player's words: a name and what it takes. */
export const achievementWords = () => ({
  'first-win': [t`初战告捷`, t`打赢第一场战斗`],
  veteran: [t`身经百战`, t`打赢 10 场战斗`],
  boss: [t`擒贼擒王`, t`打败一个首领`],
  narrow: [t`死里逃生`, t`生命不到两成时打赢`],
  untouched: [t`毫发无伤`, t`一点伤没受就打赢`],
  escape: [t`走为上策`, t`从战斗里成功逃脱`],
  'first-crit': [t`天赐良机`, t`第一次掷出大成功`],
  lucky: [t`鸿运当头`, t`掷出 5 次大成功`],
  'first-quest': [t`言出必行`, t`完成第一个任务`],
  quests: [t`有始有终`, t`完成 5 个任务`],
  level: [t`小有所成`, t`升到 5 级`],
  places: [t`行遍四方`, t`去过 5 个地方`],
})

/** 成就 the reply at this node brought, as the HUD's notes. */
export function achievementNotes(path, nodeId) {
  const words = achievementWords()
  return reachedWith(path, nodeId).map(item => ({ kind: 'achievement', icon: '🏆', text: t`成就：${words[item.id][0]}` }))
}

/** What a reply changed on the sheet, as the HUD's notes (web/vn-hud.js): life, growth, things, quests, what was learned, what holds the player back. */
export function sheetNotes(sheetBefore, after, book, replyText = '') {
  if (!after) return []
  const notes = []
  // The first reply has only the rule book's opening sheet to go by.
  const before = sheetBefore ?? startSheet(book)
  const bindings = book.bindings ?? {}
  // A field the card keeps itself says so through its own variable.
  const moved = (field, label) => {
    const delta = (after[field] ?? 0) - (before[field] ?? 0)
    if (delta && !bindings[field]) notes.push({ kind: delta > 0 ? 'up' : 'down', field, label, delta })
  }
  moved('life', t`生命`)
  if (after.sanity !== undefined && before.sanity !== undefined) {
    // Broken by a shock it comes back up a little: no gain to report.
    const broke = after.sanity > before.sanity && replyMarks(replyText).some(mark => mark.kind === 'sanity' && !mark.back)
    if (broke && !bindings.sanity) notes.push({ kind: 'lose', icon: '🧠', text: t`理智崩溃` })
    else moved('sanity', t`理智`)
  }
  if (book.level === 'full') {
    moved('energy', book.energyName || t`气力`)
    // A rank the story raised is no experience earned, whatever the levels add up to.
    const earned = replyMarks(replyText).some(mark => mark.kind === 'promote') ? 0 : earnedBy(after) - earnedBy(before)
    if (earned > 0) notes.push({ kind: 'up', field: 'experience', label: t`经验`, delta: earned })
    if ((after.level ?? 1) > (before.level ?? 1) && !bindings.level && !bindings.rank) notes.push({ kind: 'level', icon: '⭐', text: t`升到 ${after.level} 级，有属性点可以加` })
    const rank = rankNow(after, book)
    if (rank !== rankNow(before, book) && !bindings.level && !bindings.rank) notes.push({ kind: 'level', icon: '⭐', text: t`晋升：${rank}` })
  }
  const [had, has] = [counts(before), counts(after)]
  for (const [item, count] of has) if (count > (had.get(item) ?? 0)) notes.push({ kind: 'gain', item, count: count - (had.get(item) ?? 0) })
  for (const [item, count] of had) if (count > (has.get(item) ?? 0)) notes.push({ kind: 'lose', item, count: count - (has.get(item) ?? 0) })
  for (const quest of after.quests) {
    const was = before.quests.find(item => item.title === quest.title)
    if (was?.status === quest.status) continue
    const text = quest.status === 'new' ? t`新任务：${quest.title}` : quest.status === 'done' ? t`任务完成：${quest.title}` : t`任务失败：${quest.title}`
    notes.push({ kind: quest.status === 'failed' ? 'lose' : 'gain', icon: '📜', text })
  }
  for (const skill of after.skills) if (!before.skills.includes(skill)) notes.push({ kind: 'gain', icon: '✨', text: t`学会：${skill}` })
  const named = (list, item) => (list ?? []).some(other => other.name === item.name)
  for (const item of after.conditions ?? []) if (!named(before.conditions, item)) notes.push({ kind: 'lose', icon: '🩹', text: t`状态：${ailName(item.name)}` })
  for (const item of before.conditions ?? []) if (!named(after.conditions, item)) notes.push({ kind: 'gain', icon: '🌿', text: t`恢复：${ailName(item.name)}` })
  // The story spent something that was never in the bag: the player should know the two have parted.
  if (!bindings.things) {
    const marks = replyMarks(replyText)
    const gained = new Set(marks.filter(mark => mark.kind === 'gain').map(mark => mark.name))
    for (const mark of marks) if (mark.kind === 'lose' && !had.has(mark.name) && !gained.has(mark.name)) notes.push({ kind: 'lose', icon: '⚠', text: t`背包里没有${mark.name}` })
  }
  return notes
}

/** A choice's label: 灵巧 · 成功率 65% · 有风险, `short` for one line on a phone. → { text, short, risk } */
export function checkNote(sheet, book, check) {
  const percent = chanceFor(sheet, book, check)
  const risk = riskOf(percent)
  const { lacks } = aidFor(sheet, check)
  return { text: [check.stat, bagWords(sheet, check), t`成功率 ${percent}%`, RISK_WORDS()[risk]].filter(Boolean).join(' · '), short: lacks ? t`缺${lacks}` : `${percent}%`, risk }
}

/** What the bag does for a check, in words: 绳索 +2, 缺铜钥匙. */
function bagWords(sheet, check) {
  const { aid, lacks } = aidFor(sheet, check)
  return [lacks ? t`缺${lacks}` : check.needs ? t`有${check.needs}` : '', aid ? `${aid} +${AID_BONUS}` : ''].filter(Boolean).join(' · ')
}

/** A choice with no roll, beside those with one: it will work, and go only so far. */
export const safeNote = () => ({ text: t`稳妥`, risk: 'safe' })

/** How strong a fight's foes are in a word: the strongest of them, a 首领 not known. */
function foesLevel(setup) {
  const foes = foeSheets(setup)
  return foes.some(foe => foe.tier === 'boss') ? UNKNOWN : Math.max(...foes.map(foe => foe.level))
}

/** A fight among the choices: ⚔ 战斗：灰狼 ×2 · 等级 1 · 胜算约 85%. → { text, short, risk }, `risk` as the note's classes. */
export const fightNote = (setup, chance) => ({ text: t`⚔ 战斗：${foesLine(setup.foes)} · 等级 ${foesLevel(setup)} · 胜算约 ${chance}%`, short: t`战斗 ${chance}%`, risk: `${riskOf(chance)} fight` })

/** What is waiting at a fight: 灰狼 ×2、狼王 · 胜算约 95%. */
export const encounterLine = (setup, chance) => t`${foesLine(setup.foes)} · 胜算约 ${chance}%`

/** The panel in front of a fight: each kind of foe, its level and what it is made of. A 首领's numbers are found out by fighting it. */
/** A foe's picture, its white taken off as soon as that is done. */
function cutOutImage(el, picture) {
  const image = el('img', { src: picture, alt: '' })
  import('/game-battle.js').then(({ cutPicture }) => cutPicture(picture)).then(cut => { if (cut) image.src = cut })
  return image
}

/** What the player should know before going in: how far out of reach this is. */
function encounterWarning(foes) {
  const worst = Math.max(...foes.map(foe => foe.gap))
  if (worst < STRONG) return ''
  if (worst < OUT_OF_REACH) return t`对手比你强得多，打起来很危险。`
  return foes.some(foe => foe.noEscape) ? t`差距太大，硬打赢不了，也逃不掉。想想别的办法。` : t`差距太大，硬打赢不了。打不过就逃，或者想想别的办法。`
}

export function encounterCards(el, setup, shown = () => ({ picture: '' })) {
  const kinds = new Map()
  const foes = foeSheets(setup)
  for (const foe of foes) {
    const key = `${foe.name}:${foe.tier}`
    if (kinds.has(key)) kinds.get(key).count += 1
    else kinds.set(key, { ...foe, count: 1 })
  }
  const stat = (label, value) => el('span', { class: 'encounter-stat' }, [el('small', { text: label }), el('b', { text: String(value) })])
  const warning = encounterWarning(foes)
  return el('div', { class: 'encounter' }, [...[...kinds.values()].map(foe => {
    const known = foe.tier !== 'boss'
    const { picture } = shown(foe.name)
    const traits = [foe.charges ? t`会蓄力` : '', foe.noEscape ? t`逃不掉` : ''].filter(Boolean).join(t`、`)
    return el('div', { class: `encounter-foe tier-${foe.tier}${foe.gap >= STRONG ? ' strong' : ''}` }, [
      el('span', { class: 'encounter-face', 'aria-hidden': 'true' }, picture ? cutOutImage(el, picture) : foe.name.slice(0, 1)),
      el('span', { class: 'encounter-who' }, [
        el('b', { text: foe.count > 1 ? `${foe.name} ×${foe.count}` : foe.name }),
        el('small', { text: [FOE_TIERS()[foe.tier], foe.rank, GAP_NOTES()[foe.gap], traits].filter(Boolean).join(' · ') }),
      ]),
      stat(t`等级`, known ? foe.level : UNKNOWN),
      stat(t`生命`, known ? foe.life : UNKNOWN),
      stat(t`攻击`, known ? foe.attack : UNKNOWN),
    ])
  }), warning ? el('p', { class: 'encounter-warn', text: warning }) : null].filter(Boolean))
}

const FIGHT_ENDS = () => ({ won: t`胜利`, lost: t`战败`, fled: t`逃脱` })

/** A fight as the transcript shows it. */
export function battleLine(battle) {
  if (battle.over === 'story') return t`没有开打，交给了剧情：${battle.foes}`
  const gained = battle.experience ? t` · 经验 +${battle.experience}` : ''
  return t`战斗 · ${FIGHT_ENDS()[battle.over]} · ${battle.rounds} 回合 · 生命 ${battle.life}/${battle.maxLife}${gained}`
}

/** A roll in words: 掷出 14，灵巧 +2，共 16，需要 12. */
function rollSum(result) {
  const added = addedTo(result).map(([label, value]) => `${label} ${value}`)
  return [t`掷出 ${result.roll}`, ...added, ...(added.length ? [t`共 ${result.total}`] : []), t`需要 ${result.dc}`, ...(result.lacks ? [t`缺${result.lacks}`] : [])].join(t`，`)
}

const signed = number => `${number < 0 ? '−' : '+'}${Math.abs(number)}`

/** What went on top of the die: the attribute, the thing that helped, then what held the player back. → [[label, value]] */
function addedTo(result) {
  const ails = result.ails ?? []
  const own = result.modifier + ails.reduce((sum, ail) => sum + ail.by, 0) - (result.aid?.by ?? 0)
  return [...(own ? [[result.stat || t`加成`, signed(own)]] : []), ...(result.aid ? [[result.aid.name, signed(result.aid.by)]] : []), ...ails.map(ail => [ailName(ail.name), signed(-ail.by)])]
}

/** A roll as the transcript shows it. */
export function rollLine(result) {
  const stat = result.stat ? t`${result.stat}检定` : t`检定`
  return `${stat} · ${rollSum(result)} · ${TIER_WORDS()[result.tier]}`
}

/** What kept showing while the model writes on from a roll. → { tier, text } */
export function rollOutcome(result, book) {
  const earned = checkExperience(book, result)
  return { tier: result.tier, text: `${rollLine(result)}${earned ? ` · ${t`经验 +${earned}`}` : ''}` }
}

/** The same for a fight. `over` is how it ended. → { tier, text } */
export const fightOutcome = over => ({ tier: FIGHT_TIERS[over], text: over === 'story' ? t`没有开打，交给了剧情` : t`战斗 · ${FIGHT_ENDS()[over]}` })

/** How hard a roll is, in a word. */
function difficultyWord(dc) {
  return dc <= 9 ? t`容易` : dc <= 13 ? t`一般` : dc <= 17 ? t`困难` : t`极难`
}

/** What is waiting at a stop: 灵巧检定 · 难度一般 · 成功率 65%. */
export function gateLine(sheet, book, check) {
  const stat = check.stat ? t`${check.stat}检定` : t`检定`
  const what = [stat, bagWords(sheet, check)].filter(Boolean).join(' · ')
  return t`${what} · 难度${difficultyWord(dcFor(check.dc, book.difficulty))} · 成功率 ${chanceFor(sheet, book, check)}%`
}

/** What is thrown, as the look has it. */
function dieFor(look, canvas, result, { duration, still, font, told }) {
  if (look === 'ink') return turnPan(canvas, result, { duration, still, font, word: countWord, told })
  if (look === 'plain') return turnDie(canvas, result, { duration, still, font })
  return turnBare(canvas, result, { duration, still, steps: look === 'console' ? 34 : 0, look: { font, ...DIE_LOOKS[look]() } })
}

/**
 * The die across the picture, landing on the roll. A click skips what is left. Timers, not animation frames: a
 * window out of sight still has to finish. `el` is the page's element maker; `book` says what the roll is worth.
 * → a promise, when it has gone.
 */
export function showRoll(el, result, sound = null, book = null) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const { look } = currentLook()
  sound?.play('dice')
  const sum = el('div', { class: 'roll-sum', text: rollSum(result) })
  const tier = el('div', { class: 'roll-tier' }, letters(el, TIER_WORDS()[result.tier]))
  const earned = book ? checkExperience(book, result) : 0
  const hint = [result.lacks ? t`缺${result.lacks}，做不到` : TIER_HINTS()[result.tier], earned ? t`经验 +${earned}` : ''].filter(Boolean).join(' · ')
  const dial = el('canvas', { class: 'roll-dial', 'aria-hidden': 'true' })
  const big = el('div', { class: 'roll-big', 'aria-hidden': 'true' })
  const line = (i, label, value) => el('div', { class: 'roll-line', style: `--i: ${i}` }, [el('span', { text: label }), el('b', { text: String(value) })])
  const added = addedTo(result).map(([label, value]) => line(1, label, value))
  const calc = el('div', { class: 'roll-calc', 'aria-hidden': 'true' }, [line(0, t`掷出`, result.roll), ...added, el('hr', { style: '--i: 2' }), line(2, t`合计`, result.total), line(3, t`需要`, result.dc)])
  const figure = look === 'bold' && heroNow() ? el('img', { class: 'look-figure roll-hero', src: heroNow(), alt: '' }) : null
  if (figure) fitFigure(figure, heroNow())
  const layer = el('div', { class: `roll-layer ${result.tier}`, role: 'status' }, [
    figure,
    el('div', { class: 'roll-stage' }, [el('div', { class: 'roll-title' }, letters(el, result.stat ? t`${result.stat}检定` : t`检定`)), el('div', { class: 'roll-dial-box' }, [dial, big]), calc, tier]),
    sum,
    hint ? el('div', { class: 'roll-hint', text: hint }) : null,
  ])
  // Full screen shows only what is inside it.
  ;(document.fullscreenElement ?? document.body).append(layer)
  const font = getComputedStyle(layer).fontFamily
  const die = dieFor(look, dial, result, { duration: SPIN_MS, still, font, told: n => { big.textContent = countWord(n) } })
  return new Promise(resolve => {
    const timers = []
    const later = (ms, fn) => timers.push(setTimeout(fn, ms))
    const clear = () => timers.splice(0).forEach(clearTimeout)
    const leave = () => {
      clear()
      layer.classList.add('leaving')
      later(FADE_MS, () => {
        die.stop()
        layer.remove()
        resolve()
      })
    }
    const land = () => {
      clear()
      die.rest()
      layer.classList.add('landed')
      later(still ? 0 : SETTLE_MS[look] ?? SETTLE_MS.plain, () => {
        layer.classList.add('settled')
        if (look === 'bold' && !still) banner(el, layer, { text: TIER_WORDS()[result.tier], small: rollSum(result), picture: heroNow(), ms: 1350 })
        later(look === 'bold' && !still ? 1350 + 200 : HOLD_MS, leave)
      })
    }
    layer.addEventListener('click', event => {
      event.stopPropagation()
      return layer.classList.contains('landed') ? leave() : land()
    })
    if (still) return land()
    later(SPIN_MS, land)
  })
}
