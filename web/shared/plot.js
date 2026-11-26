// 剧本 (plans/22): a card's route for a story, its 幕 joined by 出口, some of them 结局. Shared by the server (what the
// model is told, the progress kept on the replies) and the page (the bar, the route map, the editor). In code a
// 剧本 is a plot and a 幕 a scene: "scripts" are the regex and Tavern Helper ones. No \p{} here (old WebViews).
import { getPath, unwrap } from './vars.js'

export const MAX_PLOTS = 12
export const MAX_SCENES = 60
export const MAX_EXITS = 4
export const MAX_POINTS = 5
/** 支线: small stories beside the main one, each with its own scene now (plans/22 十三·6). */
export const MAX_SIDES = 3
export const TIGHTNESS = Object.freeze(['loose', 'steady', 'tight'])
/**
 * 推进速度: a chat's own, −3 (slowest) to 3, over what the plot's scenes ask. `times`: the turns a scene takes; `rule` and
 * `points`: what the turn tells the model (nothing for 0, the plot as written).
 */
const PACES = Object.freeze({
  '-3': { times: 3, rule: '推进极慢：这一轮只写眼前这一会儿的事，不主动引出要点，玩家自己碰到了才写，晚些出现没关系；慢慢铺陈人、对话和细节。', points: '要点（不急，玩家碰到了再写）：' }, // i18n-ignore: the model reads it in Chinese
  '-2': { times: 2, rule: '推进很慢：要点几轮演到一条就够了，多写眼前的人、对话和细节，给玩家来回的余地，不要催着往下走。', points: '要点（一轮最多演到一条，不必每轮都演）：' }, // i18n-ignore: the model reads it in Chinese
  '-1': { times: 1.5, rule: '推进稍慢：一轮最多演到一条要点，演到之后多留些来回，不要催着往下走。', points: '要点（一轮最多演到一条）：' }, // i18n-ignore: the model reads it in Chinese
  1: { times: 0.75, rule: '推进稍快：每一轮都要有实际进展，能演到一条要点就演到。' }, // i18n-ignore: the model reads it in Chinese
  2: { times: 0.5, rule: '推进要快：每一轮至少演到一条要点，可以演到几条；该发生的发生了就自然收尾，不拖。', points: '要点（一轮可以演到几条）：' }, // i18n-ignore: the model reads it in Chinese
  3: { times: 1 / 3, rule: '推进极快：过渡和枝节略写，可以跳过不要紧的时间；一两轮里把剩下的要点演完，这一幕马上收尾。', points: '要点（一轮可以全部演完）：' }, // i18n-ignore: the model reads it in Chinese
})
export const MAX_PACE = 3
/** A 推进速度 as kept: a whole number from −3 to 3, 0 for anything else. */
export const cleanPace = value => (typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_PACE, Math.max(-MAX_PACE, Math.round(value))) : 0)
export const ENDINGS = Object.freeze(['good', 'normal', 'sad', 'hidden'])
export const SPOILERS = Object.freeze(['blind', 'outline', 'all'])
/** How an exit's 变量 condition compares (needs.vars). */
export const OPS = Object.freeze(['>=', '>', '<=', '<', '=', '!='])
export const MAX_VARS = 2
const LIMITS = { sideName: 20, name: 40, intro: 200, summary: 300, title: 40, chapter: 30, what: 400, point: 80, done: 120, style: 200, when: 120, hint: 40, ending: 200 }
const ID = /^[\w-]{1,40}$/

const str = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}
const int = (value, min, max, fallback) => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** A fresh id for a scene or a point, unlike any in `taken`. */
export function newPlotId(prefix = 's', taken = new Set()) {
  for (;;) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
}

function cleanScene(raw, index, taken) {
  let id = typeof raw?.id === 'string' && ID.test(raw.id) && !taken.has(raw.id) ? raw.id : newPlotId('s', taken)
  taken.add(id)
  const points = []
  const pointIds = new Set()
  for (const point of Array.isArray(raw?.points) ? raw.points : []) {
    const text = str(typeof point === 'string' ? point : point?.text, LIMITS.point)
    if (!text || points.length >= MAX_POINTS) continue
    const pid = typeof point?.id === 'string' && ID.test(point.id) && !pointIds.has(point.id) ? point.id : newPlotId('p', pointIds)
    pointIds.add(pid)
    points.push({ id: pid, text })
  }
  const ending = raw?.ending && typeof raw.ending === 'object'
    ? { kind: ENDINGS.includes(raw.ending.kind) ? raw.ending.kind : 'normal', text: str(raw.ending.text, LIMITS.ending) }
    : null
  const minTurns = int(raw?.minTurns, 0, 50, 2)
  const maxTurns = raw?.maxTurns == null || raw.maxTurns === '' ? null : int(raw.maxTurns, Math.max(1, minTurns), 99, null)
  return {
    id,
    title: str(raw?.title, LIMITS.title) || `第 ${index + 1} 幕`, // i18n-ignore: the model reads it in Chinese
    chapter: str(raw?.chapter, LIMITS.chapter),
    what: str(raw?.what, LIMITS.what),
    points,
    done: str(raw?.done, LIMITS.done),
    style: str(raw?.style, LIMITS.style),
    minTurns,
    maxTurns,
    // Exits are cleaned once every scene has its id (cleanPlot).
    exits: ending ? [] : (Array.isArray(raw?.exits) ? raw.exits : []),
    ending,
    // 支线: the side line it is on (cleanPlot keeps it only for one there is); the main line has none.
    ...(typeof raw?.side === 'string' && ID.test(raw.side) ? { side: raw.side } : {}),
  }
}

function cleanExit(raw, ids) {
  const to = typeof raw?.to === 'string' ? raw.to : ''
  if (!ids.has(to)) return null
  const needs = {}
  if (typeof raw?.needs?.seen === 'string' && ids.has(raw.needs.seen)) needs.seen = raw.needs.seen
  if (typeof raw?.needs?.unseen === 'string' && ids.has(raw.needs.unseen)) needs.unseen = raw.needs.unseen
  // 程序判的条件: a variable compared, the scene's latest roll, its latest fight.
  const vars = (Array.isArray(raw?.needs?.vars) ? raw.needs.vars : []).map(cleanVar).filter(Boolean).slice(0, MAX_VARS)
  if (vars.length) needs.vars = vars
  if (raw?.needs?.check === 'pass' || raw?.needs?.check === 'fail') needs.check = raw.needs.check
  if (raw?.needs?.battle === 'won' || raw?.needs?.battle === 'lost') needs.battle = raw.needs.battle
  // 满足就走: taken by itself once what it needs holds (only for what the program judges).
  const auto = raw?.auto === true && Boolean(needs.vars || needs.check || needs.battle)
  return { to, when: str(raw?.when, LIMITS.when), hint: str(raw?.hint, LIMITS.hint), ...(Object.keys(needs).length ? { needs } : {}), ...(auto ? { auto } : {}) }
}

function cleanVar(raw) {
  const path = str(raw?.path, 80).replace(/^\$\{?|\}$/g, '')
  if (!path || !OPS.includes(raw?.op)) return null
  const number = typeof raw.value === 'number' ? raw.value : typeof raw.value === 'string' && raw.value.trim() !== '' && Number.isFinite(Number(raw.value)) ? Number(raw.value) : null
  const value = number ?? str(raw?.value, 40)
  return { path, op: raw.op, value }
}

/**
 * A plot as kept: its scenes cut to the limits and given ids, exits to scenes that are not there dropped. null when it
 * has no scene at all.
 */
export function cleanPlot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const taken = new Set()
  const scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, MAX_SCENES).map((scene, index) => cleanScene(scene, index, taken))
  if (!scenes.length) return null
  const ids = new Set(scenes.map(scene => scene.id))
  // 支线: each with a start among its own scenes, opened by a scene of the main line (or from the first); scenes of a
  // line that is not there are the main line's. A plot all of side lines has none.
  const sides = []
  for (const rawSide of Array.isArray(raw.sides) ? raw.sides : []) {
    const id = typeof rawSide?.id === 'string' && ID.test(rawSide.id) ? rawSide.id : ''
    const own = scenes.filter(scene => scene.side === id)
    if (!id || !own.length || sides.length >= MAX_SIDES || sides.some(side => side.id === id)) continue
    sides.push({ id, name: str(rawSide.name, LIMITS.sideName) || `支线${sides.length + 1}`, start: own.some(scene => scene.id === rawSide.start) ? rawSide.start : own[0].id, opens: typeof rawSide.opens === 'string' ? rawSide.opens : '' }) // i18n-ignore: the model reads it in Chinese
  }
  for (const scene of scenes) if (scene.side && !sides.some(side => side.id === scene.side)) delete scene.side
  if (!scenes.some(scene => !scene.side)) {
    for (const scene of scenes) delete scene.side
    sides.length = 0
  }
  const lineOf = id => sceneOf({ scenes }, id)?.side ?? ''
  for (const side of sides) if (!ids.has(side.opens) || lineOf(side.opens)) side.opens = ''
  // A way on stays on its own line.
  for (const scene of scenes) scene.exits = scene.exits.map(exit => cleanExit(exit, ids)).filter(exit => exit && lineOf(exit.to) === (scene.side ?? '')).slice(0, MAX_EXITS)
  return {
    id: typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : newPlotId('plot'),
    name: str(raw.name, LIMITS.name) || '未命名剧本', // i18n-ignore: the model reads it in Chinese
    intro: str(raw.intro, LIMITS.intro),
    summary: str(raw.summary, LIMITS.summary),
    tightness: TIGHTNESS.includes(raw.tightness) ? raw.tightness : 'steady',
    greeting: Number.isInteger(raw.greeting) && raw.greeting >= 0 ? raw.greeting : null,
    start: ids.has(raw.start) && !lineOf(raw.start) ? raw.start : scenes.find(scene => !scene.side).id,
    // Who wrote it: 'imported' (came with a card from elsewhere: played blind by default), 'own'.
    source: raw.source === 'imported' ? 'imported' : 'own',
    scenes,
    ...(sides.length ? { sides } : {}),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

/** A card's plots (at most MAX_PLOTS, each id once). */
export function cleanPlots(list) {
  const out = []
  const ids = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const plot = cleanPlot(raw)
    if (!plot || out.length >= MAX_PLOTS) continue
    if (ids.has(plot.id)) plot.id = newPlotId('plot', ids)
    ids.add(plot.id)
    out.push(plot)
  }
  return out
}

export const sceneOf = (plot, id) => plot?.scenes.find(scene => scene.id === id) ?? null

/**
 * What is wrong with a plot's shape, for the editor and before a story starts on it: { blocking: [...], hints: [...] },
 * each { kind, scene?, title?, text }: `text` in Chinese (the server's messages), `kind` and `title` for the page to say it
 * in its own language (web/plot-edit.js problemText). Blocking: a scene with no way on that is not an ending, a scene
 * the start never reaches, no ending at all. Hints are only advice.
 */
export function plotProblems(plot) {
  const blocking = []
  const hints = []
  if (!plot) return { blocking: [{ kind: 'empty', text: '剧本里还没有幕' }], hints } // i18n-ignore: the model reads it in Chinese
  const starts = [plot.start, ...(plot.sides ?? []).map(side => side.start)]
  const reached = new Set(starts)
  const queue = [...starts]
  while (queue.length) {
    for (const exit of sceneOf(plot, queue.shift())?.exits ?? []) {
      if (reached.has(exit.to)) continue
      reached.add(exit.to)
      queue.push(exit.to)
    }
  }
  for (const scene of plot.scenes) {
    const at = { scene: scene.id, title: scene.title }
    if (!scene.ending && !scene.exits.length && plot.scenes.length > 1) blocking.push({ kind: 'noExit', ...at, text: `「${scene.title}」既没有出口也不是结局` }) // i18n-ignore: the model reads it in Chinese
    if (!reached.has(scene.id)) blocking.push({ kind: 'unreached', ...at, text: `从开头走不到「${scene.title}」` }) // i18n-ignore: the model reads it in Chinese
    if (scene.what.length > 300) hints.push({ kind: 'longWhat', ...at, text: `「${scene.title}」的梗概有点长，模型不容易抓住重点` }) // i18n-ignore: the model reads it in Chinese
    if (!scene.what) hints.push({ kind: 'noWhat', ...at, text: `「${scene.title}」还没写要发生什么` }) // i18n-ignore: the model reads it in Chinese
    if (scene.exits.length > 1 && scene.exits.some(exit => !exit.when && !exit.needs)) hints.push({ kind: 'vagueFork', ...at, text: `「${scene.title}」有岔路，但有的出口没写什么时候走` }) // i18n-ignore: the model reads it in Chinese
    // Two ways on the same words: the model cannot tell which the player took.
    const whens = scene.exits.filter(exit => exit.when && !exit.needs).map(exit => exit.when.replace(/^当/, '').replace(/\s+/g, ''))
    if (new Set(whens).size < whens.length) hints.push({ kind: 'sameWhen', ...at, text: `「${scene.title}」有两个出口的条件一样，模型分不开` }) // i18n-ignore: the model reads it in Chinese
  }
  if (plot.scenes.length > 1 && !plot.scenes.some(scene => scene.ending && !scene.side)) blocking.push({ kind: 'noEnding', text: '还没有结局：至少把一幕标成结局' }) // i18n-ignore: the model reads it in Chinese
  // Forks that all come to one ending: nothing to play again for.
  const mainEndings = plot.scenes.filter(scene => scene.ending && !scene.side).length
  if (mainEndings === 1 && plot.scenes.some(scene => !scene.side && scene.exits.length > 1)) hints.push({ kind: 'fewEndings', text: '有岔路，但只有一个结局：岔路最后都走到同一个地方' }) // i18n-ignore: the model reads it in Chinese
  for (const side of plot.sides ?? []) {
    const own = plot.scenes.filter(scene => scene.side === side.id)
    if (own.length > 1 && !own.some(scene => scene.ending)) blocking.push({ kind: 'sideNoEnding', title: side.name, text: `支线「${side.name}」还没有结局` }) // i18n-ignore: the model reads it in Chinese
  }
  return { blocking, hints }
}

// ─── Progress ────────────────────────────────────────────────────────────────
// A reply's progress (node.plot): { of, at, ticks: [point ids], turns, seen: [scene ids], astray, ended?, from? }.
// `of` is the plot copy it belongs to (chat.plot.copy.id); `from` the scene it came in from, on the reply that came in.

/** Where a story on `plot` starts (chat.plot.start, a scene). */
export const startProgress = (plot, at = plot.start) => openSides(plot, { of: plot.id, at: sceneOf(plot, at) && !sceneOf(plot, at).side ? at : plot.start, ticks: [], turns: 0, seen: [], astray: 0 })

/**
 * 支线 opened on `progress`: those whose opening scene the main line has reached (or opened from the first), each
 * from its start: progress.sides = { [side id]: { at, ticks, turns, seen, ended?, from? } }.
 */
export function openSides(plot, progress) {
  const sides = plot?.sides ?? []
  if (!sides.length) return progress
  const walked = new Set([...progress.seen, progress.at])
  let next = progress
  for (const side of sides) {
    if (next.sides?.[side.id] || (side.opens && !walked.has(side.opens))) continue
    next = { ...next, sides: { ...next.sides, [side.id]: { at: side.start, ticks: [], turns: 0, seen: [] } } }
  }
  return next
}

/** A side line's progress into scene `to`. */
const enterSide = (line, to) => (to === line.at ? line : { at: to, ticks: [], turns: 0, seen: [...line.seen.filter(id => id !== line.at), line.at], from: line.at })

/** `progress` read against `plot` as it is now: a scene gone falls back to the latest one still there, points gone go. */
export function fitProgress(plot, progress) {
  if (!progress || progress.of !== plot.id) return startProgress(plot)
  const seen = (progress.seen ?? []).filter(id => sceneOf(plot, id))
  let at = progress.at
  if (!sceneOf(plot, at)) at = seen.pop() ?? plot.start
  const points = new Set((sceneOf(plot, at)?.points ?? []).map(point => point.id))
  // 支线: those still there, each on a scene of its own line.
  const sides = {}
  for (const side of plot.sides ?? []) {
    const line = progress.sides?.[side.id]
    if (!line) continue
    const lineAt = sceneOf(plot, line.at)?.side === side.id ? line.at : side.start
    const own = new Set((sceneOf(plot, lineAt)?.points ?? []).map(point => point.id))
    sides[side.id] = { ...line, at: lineAt, seen: (line.seen ?? []).filter(id => sceneOf(plot, id)), ticks: (line.ticks ?? []).filter(id => own.has(id)) }
  }
  const { sides: _old, ...rest } = progress
  return openSides(plot, { ...rest, at, seen, ticks: (progress.ticks ?? []).filter(id => points.has(id)), ...(Object.keys(sides).length ? { sides } : {}) })
}

/** Into scene `to` from where `progress` is (a jump, an exit taken, a report). */
export function enter(progress, to) {
  if (to === progress.at) return progress
  // What is not the scene's own goes on: the side lines, how the model has been reporting, the helper's count.
  const kept = Object.fromEntries(['sides', 'silent', 'wait'].filter(key => progress[key] !== undefined).map(key => [key, progress[key]]))
  return { of: progress.of, at: to, ticks: [], turns: 0, seen: [...progress.seen.filter(id => id !== progress.at), progress.at], astray: 0, from: progress.at, ...kept }
}

/**
 * The player's own change to the progress (plotSet): { at } a jump or an exit picked, { ticks } points ticked, { ended },
 * { quiet } no more 故事岔开了 in this scene. ({ pull }, 拉回来, is for the turn's block only.)
 */
export function applySet(plot, progress, set) {
  if (!set) return progress
  let next = progress
  if (typeof set.at === 'string' && sceneOf(plot, set.at)) next = enter(next, set.at)
  if (Array.isArray(set.ticks)) next = { ...next, ticks: [...new Set([...next.ticks, ...set.ticks])] }
  if (set.ended === true && sceneOf(plot, next.at)?.ending) next = { ...next, ended: true }
  if (set.quiet === true) next = { ...next, quiet: true, astray: 0 }
  // 支线: the player's own word on one ({ id, to } a way taken, { id, ended } its ending played out).
  const sideSet = set.side
  if (sideSet && typeof sideSet.id === 'string') {
    next = openSides(plot, next)
    // A way into a line not open yet (跳到 one of its scenes on the map) opens it there.
    const side = (plot.sides ?? []).find(item => item.id === sideSet.id)
    const line = next.sides?.[sideSet.id] ?? (side && typeof sideSet.to === 'string' ? { at: side.start, ticks: [], turns: 0, seen: [] } : null)
    if (line) {
      let changed = line
      if (typeof sideSet.to === 'string' && sceneOf(plot, sideSet.to)?.side === sideSet.id) changed = enterSide(line, sideSet.to)
      if (sideSet.ended === true && sceneOf(plot, line.at)?.ending) changed = { ...line, ended: true }
      next = { ...next, sides: { ...next.sides, [sideSet.id]: changed } }
    }
  }
  return next
}

/** A variable of the story's state by its path; an MVU card's under stat_data answers to the bare path too. */
export function varOf(state, path) {
  if (!state || typeof state !== 'object') return undefined
  const found = getPath(state, path)
  return unwrap(found !== undefined ? found : getPath(state, `stat_data.${path}`))
}

/** Whether a 变量 condition holds: as numbers when both sides are; otherwise only = and != , as words. */
export function varHolds(cond, state) {
  const value = varOf(state, cond.path)
  if (value === undefined || value === null || typeof value === 'object') return false
  const a = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  const b = typeof cond.value === 'number' ? cond.value : Number(cond.value)
  if (Number.isFinite(a) && Number.isFinite(b) && String(cond.value).trim() !== '') {
    return { '>=': a >= b, '>': a > b, '<=': a <= b, '<': a < b, '=': a === b, '!=': a !== b }[cond.op] ?? false
  }
  if (cond.op === '=') return String(value) === String(cond.value)
  if (cond.op === '!=') return String(value) !== String(cond.value)
  return false
}

/**
 * What exit `exit` still needs on `progress` (and the story's variables, `state`): [] when it is open. Each
 * { kind: 'seen' | 'unseen', scene } or { kind: 'var', path, op, value } or { kind: 'check' | 'battle', want }.
 */
export function exitLacks(exit, progress, state = null) {
  const needs = exit.needs
  if (!needs) return []
  const walked = new Set([...progress.seen, progress.at])
  const lacks = []
  if (needs.seen && !walked.has(needs.seen)) lacks.push({ kind: 'seen', scene: needs.seen })
  if (needs.unseen && walked.has(needs.unseen)) lacks.push({ kind: 'unseen', scene: needs.unseen })
  for (const cond of needs.vars ?? []) if (!varHolds(cond, state)) lacks.push({ kind: 'var', ...cond })
  if (needs.check && progress.check !== needs.check) lacks.push({ kind: 'check', want: needs.check })
  if (needs.battle && progress.battle !== needs.battle) lacks.push({ kind: 'battle', want: needs.battle })
  return lacks
}

/** Whether exit `exit` is open on `progress`: the scenes walked, the variables (`state`), the scene's roll and fight. */
export const exitOpen = (exit, progress, state = null) => exitLacks(exit, progress, state).length === 0

/** How many turns a scene takes at a 推进速度: { min (至少演几轮), max (最多几轮) or null }. */
export function turnsOf(scene, pace = 0) {
  const times = PACES[pace]?.times ?? 1
  const min = Math.min(50, Math.ceil((scene?.minTurns ?? 0) * times))
  return { min, max: scene?.maxTurns ? Math.min(99, Math.max(1, min, Math.ceil(scene.maxTurns * times))) : null }
}

/** 故事岔开了: 'astray' (the model said the player left the plot), 'long' (past the scene's 最多几轮), or null. */
export function strayOf(plot, progress, pace = 0) {
  if (!progress || progress.ended || progress.quiet) return null
  if ((progress.astray ?? 0) > 0) return 'astray'
  const { max } = turnsOf(sceneOf(plot, progress.at), pace)
  return max && progress.turns >= max ? 'long' : null
}

/**
 * The progress on `path` (root to a node of the chat, its hidden rounds left out by the caller): the latest reply's
 * own, or a player message's change on what was before it, or where the plot starts. Replies of another copy (a plot
 * put on since) are passed over.
 */
export function progressOn(plot, path, start = null) {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]
    if (node.plot?.of === plot.id) return fitProgress(plot, node.plot)
    if (node.plotSet?.of === plot.id) return fitProgress(plot, applySet(plot, progressOn(plot, path.slice(0, i), start), node.plotSet))
  }
  return startProgress(plot, start ?? plot.start)
}

// ─── The 幕后标记 a reply ends with ───────────────────────────────────────────
// <剧本进度 要点="1,3" 完成="是" 出口="2"/>: full-width brackets, 【】, any quotes, attributes in any order.
const MARK = /(?:\n[ \t]*)*[<＜【]\s*剧本进度([^<>＜＞【】\n]*?)\/?\s*[>＞】](?:\s*[<＜]\s*\/\s*剧本进度\s*[>＞])?/g
const FENCE = /```[\s\S]*?(?:```|$)/g
const YES = /^(是|对|完成|完了|演完|true|yes|y|1)$/i

function attrsOf(text) {
  const attrs = {}
  const pattern = /([^\s=,，、"“”'‘’]+)\s*[=＝]\s*(?:"([^"]*)"|“([^”]*)”|'([^']*)'|‘([^’]*)’|([^\s,，、]+))/g
  for (const match of text.matchAll(pattern)) attrs[match[1]] = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? '').trim()
  return attrs
}

/** A reply without its 剧本进度 marks, and the last one read: { text, mark: { points, done, exit, astray } | null, raw }. */
export function takePlotMark(reply) {
  const source = String(reply ?? '')
  const fences = [...source.matchAll(FENCE)].map(match => [match.index, match.index + match[0].length])
  let last = null
  let raw = ''
  const text = source.replace(MARK, (whole, body, offset) => {
    if (fences.some(([from, to]) => offset >= from && offset < to)) return whole
    raw = whole.trim()
    const attrs = attrsOf(body)
    const points = String(attrs['要点'] ?? '').split(/[\s,，、;；]+/).map(Number).filter(n => Number.isInteger(n) && n > 0) // i18n-ignore: the model reads it in Chinese
    const exit = String(attrs['出口'] ?? '').trim() // i18n-ignore: the model reads it in Chinese
    // 支线: 支线1="是", 支线1要点="2", 支线1出口="1" (numbered as the turn listed them).
    const sides = {}
    for (const [key, value] of Object.entries(attrs)) {
      const found = key.match(/^支线(\d+)(要点|出口)?$/) // i18n-ignore: the model reads it in Chinese
      if (!found) continue
      if (!sides[Number(found[1])]) sides[Number(found[1])] = { points: [], done: false, exit: '' }
      const line = sides[Number(found[1])]
      if (found[2] === '要点') line.points = String(value).split(/[\s,，、;；]+/).map(Number).filter(n => Number.isInteger(n) && n > 0) // i18n-ignore: the model reads it in Chinese
      else if (found[2] === '出口') line.exit = /^(无|没有|0|-)$/.test(String(value).trim()) ? '' : String(value).trim() // i18n-ignore: the model reads it in Chinese
      else line.done = YES.test(String(value).trim())
    }
    last = Object.keys(attrs).length
      ? { points, done: YES.test(String(attrs['完成'] ?? '').trim()), exit: exit && !/^(无|没有|0|-)$/.test(exit) ? exit : '', astray: YES.test(String(attrs['偏离'] ?? '').trim()), ...(Object.keys(sides).length ? { sides } : {}) } // i18n-ignore: the model reads it in Chinese
      : null
    return ''
  })
  return { text: last || raw ? text.replace(/\s+$/, '') : source, mark: last, raw: raw.slice(0, 200) }
}

/**
 * Hidden while it is written: a tail that is, or may become, a 剧本进度 mark (render.js streamingText). '<' and the
 * first characters of the name are held back too, a moment.
 */
export function withoutOpenMark(text) {
  const source = String(text ?? '')
  const open = source.search(/[<＜【]\s*剧本进度[^>＞】]*$/)
  if (open >= 0) return source.slice(0, open)
  const name = '剧本进度' // i18n-ignore: the model reads it in Chinese
  for (let n = name.length - 1; n >= 0; n--) {
    const tail = new RegExp(`[<＜【]\\s*${name.slice(0, n)}$`) // i18n-ignore: the model reads it in Chinese
    const at = source.search(tail)
    if (at >= 0) return source.slice(0, at)
  }
  return source
}

/**
 * The progress after a reply: `base` (before it, the player's own change in), what the model reported (`mark`, read
 * against `sent`, what this turn told it: { at, points: [ids], exits: [scene ids], pace, push }), and whether the reply was whole.
 * `facts`: what the program knows after the reply ({ state: the variables, check: 'pass' | 'fail', battle: 'won' |
 * 'lost' }, this turn's roll and fight); an exit marked 满足就走 whose needs now hold is taken whatever the model wrote.
 * A turn sent to play the scene out (推到收尾) ends it once the reply is whole, whatever the mark says; at a fork only the
 * player's way does.
 */
export function applyMark(plot, base, mark, sent, { whole = true, facts = null, judged = false } = {}) {
  let next = { ...base, turns: (base.turns ?? 0) + 1 }
  // What said something of the reply before (it came in, the helper looked, an ending reached the first time).
  delete next.from
  delete next.judged
  delete next.first
  // 模型没写进度: replies in a row the model was asked for its mark and wrote none (the helper's judging asks none).
  if (sent?.mark !== false && !judged) next.silent = mark ? 0 : (base.silent ?? 0) + 1
  if (facts?.check === 'pass' || facts?.check === 'fail') next.check = facts.check
  if (facts?.battle === 'won' || facts?.battle === 'lost') next.battle = facts.battle
  if (!sent || sent.at !== base.at) return next
  if (mark) {
    const ticked = mark.points.map(n => sent.points[n - 1]).filter(Boolean)
    if (ticked.length) next.ticks = [...new Set([...next.ticks, ...ticked])]
    next.astray = mark.astray ? (next.astray ?? 0) + 1 : 0
  }
  next = sideMarks(plot, openSides(plot, next), mark, sent, { whole, state: facts?.state ?? null })
  const scene = sceneOf(plot, base.at)
  const auto = whole && scene && !scene.ending ? scene.exits.find(exit => exit.auto && sceneOf(plot, exit.to) && exitOpen(exit, next, facts?.state)) : null
  if (auto) return enter(next, auto.to)
  const pushed = sent.push === 'scene'
  const over = mark?.done || (pushed && (scene?.ending || sent.exits.length === 1))
  if (!over || !whole || !scene || (!pushed && next.turns < turnsOf(scene, sent.pace).min)) return next
  if (scene.ending) return { ...next, ended: true }
  const open = sent.exits.filter(to => sceneOf(plot, to))
  let to = ''
  if (mark?.exit) {
    const n = Number(mark.exit)
    to = Number.isInteger(n) && n > 0 ? open[n - 1] ?? '' : open.find(id => id === mark.exit || sceneOf(plot, id)?.title === mark.exit) ?? ''
  } else if (open.length === 1) to = open[0]
  return to ? enter(next, to) : next
}

/** 支线 after a reply: each the turn listed (sent.sides) a turn on, its points, its way on as the mark says. */
function sideMarks(plot, progress, mark, sent, { whole, state }) {
  if (!progress.sides) return progress
  const sides = Object.fromEntries(Object.entries(progress.sides).map(([id, line]) => {
    const { from: _from, ...kept } = line
    return [id, kept]
  }))
  for (const [index, item] of (sent.sides ?? []).entries()) {
    const line = sides[item.id]
    if (!line || line.at !== item.at || line.ended) continue
    let next = { ...line, turns: (line.turns ?? 0) + 1 }
    const said = mark?.sides?.[index + 1]
    if (said) {
      const ticked = said.points.map(n => item.points[n - 1]).filter(Boolean)
      if (ticked.length) next.ticks = [...new Set([...next.ticks, ...ticked])]
    }
    const scene = sceneOf(plot, next.at)
    const walked = { ...next, seen: [...progress.seen, progress.at, ...next.seen] }
    const auto = whole && scene && !scene.ending ? scene.exits.find(exit => exit.auto && exitOpen(exit, walked, state)) : null
    if (auto) next = enterSide(next, auto.to)
    else if (said?.done && whole && scene && next.turns >= turnsOf(scene, sent.pace).min) {
      if (scene.ending) next = { ...next, ended: true }
      else {
        const n = Number(said.exit)
        const to = said.exit
          ? Number.isInteger(n) && n > 0 ? item.exits[n - 1] : item.exits.find(id => id === said.exit || sceneOf(plot, id)?.title === said.exit)
          : item.exits.length === 1 ? item.exits[0] : ''
        if (to) next = enterSide(next, to)
      }
    }
    sides[item.id] = next
  }
  return { ...progress, sides }
}

// ─── What the turn tells the model ────────────────────────────────────────────
const RULES = {
  loose: '这一幕只是个方向：玩家往别处走时就跟着玩家走，有合适的机会再绕回来，不必强求。', // i18n-ignore: the model reads it in Chinese
  steady: '这一幕的要点要在接下来几轮里陆续出现；玩家偏离时先顺着玩家写，两三轮内找自然的机会带回来。', // i18n-ignore: the model reads it in Chinese
  tight: '这一幕的要点必须出现；玩家偏离时，用故事里的事（有人来了、出了变故、时间到了）把场面自然地带回来。', // i18n-ignore: the model reads it in Chinese
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const firstLine = text => clip(String(text ?? '').split(/[。！？\n]/)[0] ?? '', 40)

/** 主动推进: what this one turn plays. */
function pushLine(scene, push, ticked, ways) {
  const own = '玩家的行动照样写，顺着它引出来，不要替玩家做决定。' // i18n-ignore: the model reads it in Chinese
  if (push.how === 'scene') {
    const rest = scene.points.some(point => !ticked.has(point.id)) ? '还没演到的要点，要紧的带到，其余略过；' : '' // i18n-ignore: the model reads it in Chinese
    return scene.ending
      ? `玩家要这一轮把结局写完：${rest}写到收场。${own}` // i18n-ignore: the model reads it in Chinese
      : ways > 1
        ? `玩家要这一轮走到岔路口：${rest}把场面推到要选路的地方停住，等玩家选。${own}` // i18n-ignore: the model reads it in Chinese
        : `玩家要这一轮演完这一幕：${rest}自然收住，下一轮就进下一幕。${own}` // i18n-ignore: the model reads it in Chinese
  }
  const point = scene.points.find(item => item.id === push.point) ?? scene.points.find(item => !ticked.has(item.id))
  return point
    ? `玩家要这一轮推进一步：让「${point.text}」在这一轮里发生，演出来，不要只提一句。${own}` // i18n-ignore: the model reads it in Chinese
    : `玩家要这一轮推进一步：让局面有一个实实在在的变化，离${scene.done ? `「${scene.done}」` : '这一幕的结尾'}更近一步。${own}` // i18n-ignore: the model reads it in Chinese
}

/**
 * The turn's <剧本> block and what it told the model ({ at, points, exits }, kept on the player's message so the reply's
 * mark is read against it). `progress` is where the story is as the turn starts; `state` the story's variables (for
 * the exits that compare them); `pull`: 拉回来, this turn brings the story back to the scene; `pace`: 推进速度;
 * `push`: 主动推进, this turn plays one step of the scene ({ how: 'step', point? }) or the rest of it ({ how: 'scene' }).
 */
export function plotBlock(plot, progress, { tightness = plot.tightness, state = null, pull = false, mark = true, pace = 0, push = null } = {}) {
  const scene = sceneOf(plot, progress.at)
  if (!scene) return { text: '', sent: null }
  const turns = turnsOf(scene, pace)
  // Past 最多几轮 the scene is brought to its end, whatever the pace.
  const late = Boolean(turns.max) && progress.turns >= turns.max
  const going = push || (late && pace < 0) ? 0 : pace
  const lines = ['这是这段故事要照着走的剧本，玩家看不到；只管这一轮，之前消息里的剧本都作废，以这里为准。'] // i18n-ignore: the model reads it in Chinese
  if (plot.summary) lines.push(`故事总览：${plot.summary}`) // i18n-ignore: the model reads it in Chinese
  const walked = progress.seen.map(id => sceneOf(plot, id)?.title).filter(Boolean)
  if (walked.length) lines.push(`已经走过：${walked.length > 8 ? `（之前还有 ${walked.length - 8} 幕）→ ` : ''}${walked.slice(-8).join(' → ')}`) // i18n-ignore: the model reads it in Chinese
  lines.push('', `当前这一幕：「${scene.title}」${scene.chapter ? `（${scene.chapter}）` : ''}`) // i18n-ignore: the model reads it in Chinese
  if (progress.turns === 0 && progress.from) lines.push(`这一轮刚从「${sceneOf(plot, progress.from)?.title ?? ''}」进入这一幕：先把上一幕自然收尾、过渡过来，不要一句话跳过去。`) // i18n-ignore: the model reads it in Chinese
  if (scene.what) lines.push(`要发生什么：${scene.what}`) // i18n-ignore: the model reads it in Chinese
  const ticked = new Set(progress.ticks)
  if (scene.points.length) {
    lines.push(PACES[going]?.points ?? '要点（陆续让它们在故事里出现，不必一轮写完）：') // i18n-ignore: the model reads it in Chinese
    scene.points.forEach((point, index) => lines.push(`${index + 1}. ${point.text}${ticked.has(point.id) ? '（已经演到）' : ''}`)) // i18n-ignore: the model reads it in Chinese
  }
  if (scene.done) lines.push(`演到什么算完：${scene.done}`) // i18n-ignore: the model reads it in Chinese
  if (scene.style) lines.push(`写法：${scene.style}`) // i18n-ignore: the model reads it in Chinese
  lines.push(`这一幕已经演了 ${progress.turns} 轮${turns.min > progress.turns ? `，至少要演 ${turns.min} 轮才能结束` : ''}。`) // i18n-ignore: the model reads it in Chinese
  const exits = scene.ending ? [] : scene.exits.filter(exit => exitOpen(exit, progress, state))
  if (scene.ending) {
    // 真模型 (2026-11-22): a model left it at 完成="否" turn after turn once the ending was written.
    lines.push('', `这一幕是结局。${scene.ending.text ? `收场要求：${scene.ending.text}` : '把故事好好收尾。'}收场写出来了，这一幕就算演完，剧本也就演完了。`) // i18n-ignore: the model reads it in Chinese
  } else if (exits.length) {
    // 真模型 (2026-11-22): a model left to it chose a way for the player before the player had made any choice.
    lines.push('', exits.length > 1
      ? '这一幕有岔路，走哪条由玩家的行动决定：只有玩家的行动已经清楚地对上某条路的条件，才算选了那条路；玩家还没表态，就把场面停在要做选择的地方，等玩家下一轮的行动，不要替玩家选。能走的路：' // i18n-ignore: the model reads it in Chinese
      : '这一幕演完后走这条路：') // i18n-ignore: the model reads it in Chinese
    exits.forEach((exit, index) => {
      const target = sceneOf(plot, exit.to)
      lines.push(`${index + 1}. ${exit.when ? `当${exit.when.replace(/^当/, '')}` : '演完后'} → 去「${target.title}」${firstLine(target.what) ? `：${firstLine(target.what)}` : ''}`) // i18n-ignore: the model reads it in Chinese
    })
  }
  // 支线: each open and not played out, its scene now in a few lines.
  const opened = openSides(plot, progress)
  const sideItems = []
  for (const side of plot.sides ?? []) {
    const line = opened.sides?.[side.id]
    const sideScene = line && !line.ended ? sceneOf(plot, line.at) : null
    if (!sideScene) continue
    const walked = { ...line, seen: [...progress.seen, progress.at, ...line.seen] }
    sideItems.push({ side, line, scene: sideScene, ways: sideScene.ending ? [] : sideScene.exits.filter(exit => exitOpen(exit, walked, state)) })
  }
  if (sideItems.length) {
    lines.push('', '支线（和主线并行的小故事：玩家往那边走时穿插着演，不要抢主线，也不要硬塞）：') // i18n-ignore: the model reads it in Chinese
    sideItems.forEach(({ side, line, scene: at, ways }, index) => {
      const bits = [`支线${index + 1}「${side.name}」，现在是「${at.title}」${at.what ? `：${at.what}` : ''}`] // i18n-ignore: the model reads it in Chinese
      if (at.points.length) bits.push(`要点：${at.points.map((point, j) => `${j + 1}. ${point.text}${line.ticks.includes(point.id) ? '（已经演到）' : ''}`).join('；')}`) // i18n-ignore: the model reads it in Chinese
      // 真模型 (2026-11-22): with nothing said of when a part is done, a model never said it was.
      bits.push(at.done ? `演到什么算完：${at.done}` : at.ending ? '' : '上面写的事在故事里发生了，这一段就算演完。') // i18n-ignore: the model reads it in Chinese
      if (at.ending) bits.push(`这一段是这条支线的结局${at.ending.text ? `：${at.ending.text}` : ''}`) // i18n-ignore: the model reads it in Chinese
      else if (ways.length) bits.push(`演完后：${ways.map((exit, j) => `${j + 1}. ${exit.when ? `当${exit.when.replace(/^当/, '')}` : '演完后'} → 「${sceneOf(plot, exit.to)?.title ?? ''}」`).join('；')}`) // i18n-ignore: the model reads it in Chinese
      lines.push(bits.filter(Boolean).join('\n'))
    })
  }
  lines.push('', RULES[tightness] ?? RULES.steady)
  if (PACES[going]) lines.push(PACES[going].rule)
  // The way on at a fork is still the player's.
  if (push) lines.push(pushLine(scene, push, ticked, exits.length))
  else if (late && !pull) {
    lines.push(`这一幕原定最多演 ${turns.max} 轮，已经超过了：从这一轮起收尾，${exits.length > 1 ? '把场面推到要选路的地方' : scene.ending ? '把收场写出来' : '让还没演到、又不能少的事发生，然后结束这一幕'}，不要再展开新的枝节。`) // i18n-ignore: the model reads it in Chinese
  }
  if (pull) lines.push('故事已经离这一幕比较远了：这一轮用故事里自然发生的事（有人来了、出了变故、传来消息、时间到了）把场面带回这一幕，但不要替玩家做决定。') // i18n-ignore: the model reads it in Chinese
  lines.push('玩家的行动永远优先：不要替玩家做决定、说话或行动。不要在正文里说出剧本，也不要提前写后面的幕。') // i18n-ignore: the model reads it in Chinese
  // Both cases shown: a model given only 完成="否" wrote nothing else (真模型, 2026-11-22).
  const notDone = '<剧本进度 要点="1" 完成="否"/>' // i18n-ignore: the model reads it in Chinese
  const done = exits.length > 1 ? '<剧本进度 要点="2" 完成="是" 出口="1"/>' : '<剧本进度 要点="2" 完成="是"/>' // i18n-ignore: the model reads it in Chinese
  const when = exits.length > 1
    ? '，并写玩家选的那条路的序号；玩家还没选路就写 完成="否"' // i18n-ignore: the model reads it in Chinese
    : ''
  // 辅助模型判断: the model is asked for no mark (the helper reads the story every few turns instead).
  if (mark) lines.push(`每次回复的最后单独一行写进度，玩家看不到。要点写这一轮演到的序号（没有就写 无）。${scene.done ? `「${scene.done}」` : '这一幕要发生的事'}在故事里已经发生了（包括刚写的这一条回复），就写 完成="是"${when}；还没发生写 完成="否"。不要一直写否，也不要提前写是。玩家明显偏离了剧本就加上 偏离="是"。${sideItems.length ? '支线有进展时在同一行加上：支线N要点="序号"；支线N这一段演完了写 支线N="是"，有几条路可走就再写 支线N出口="序号"（N 是上面支线的编号）。' : ''}例如，还没演完：${notDone}；演完了：${done}`) // i18n-ignore: the model reads it in Chinese
  return {
    text: `<剧本>\n${lines.join('\n')}\n</剧本>`, // i18n-ignore: the model reads it in Chinese
    sent: {
      at: scene.id,
      points: scene.points.map(point => point.id),
      exits: exits.map(exit => exit.to),
      ...(mark ? {} : { mark: false }),
      ...(PACES[pace] ? { pace } : {}),
      ...(push?.how === 'scene' ? { push: 'scene' } : {}),
      ...(sideItems.length ? { sides: sideItems.map(({ side, scene: at, ways }) => ({ id: side.id, at: at.id, points: at.points.map(point => point.id), exits: ways.map(exit => exit.to) })) } : {}),
    },
  }
}

/** The block in a player message as sent (taken out of the older ones, as the 剧情向导's is). */
export const PLOT_BLOCK = /\n*<剧本>\n[\s\S]*?\n<\/剧本>/g

/**
 * What a reader on `spoiler` may see of a scene on `progress`: 'full' (all of it), 'title' (its name only), 'none'.
 * Every place that shows a scene asks this.
 */
export function shown(scene, spoiler, progress) {
  if (!scene) return 'none'
  const walked = progress && (scene.id === progress.at || progress.seen.includes(scene.id) || Object.values(progress.sides ?? {}).some(line => line.at === scene.id || line.seen?.includes(scene.id)))
  if (spoiler === 'all' || walked) return 'full'
  if (spoiler === 'outline') return 'title'
  return 'none'
}

// ─── The guide's changes to a plot, one by one (让向导改) ──────────────────────
const INFO = ['name', 'intro', 'summary', 'tightness', 'start', 'sides']
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What `after` changes of `before`, for the player to take one by one: [{ id, kind: 'info' | 'add' | 'change' |
 * 'remove', scene?, title, was? }]. `locked`: scenes already played (while playing), whose changes are not offered.
 */
export function plotChanges(before, after, { locked = new Set() } = {}) {
  const changes = []
  if (INFO.some(key => !same(before[key], after[key]))) changes.push({ id: 'info', kind: 'info', title: after.name, was: before.name })
  for (const scene of after.scenes) {
    const old = sceneOf(before, scene.id)
    if (locked.has(scene.id)) continue
    if (!old) changes.push({ id: `scene:${scene.id}`, kind: 'add', scene: scene.id, title: scene.title })
    else if (!same(old, scene)) changes.push({ id: `scene:${scene.id}`, kind: 'change', scene: scene.id, title: scene.title, was: old.title })
  }
  for (const scene of before.scenes) {
    if (!locked.has(scene.id) && !sceneOf(after, scene.id)) changes.push({ id: `scene:${scene.id}`, kind: 'remove', scene: scene.id, title: scene.title })
  }
  return changes
}

/** `before` with the changes picked (ids of plotChanges) taken from `after`; the scenes in `after`'s order. */
export function applyPlotChanges(before, after, picked, { locked = new Set() } = {}) {
  const take = id => picked.has(id)
  const info = take('info') ? Object.fromEntries(INFO.map(key => [key, after[key]])) : Object.fromEntries(INFO.map(key => [key, before[key]]))
  const scenes = []
  for (const scene of after.scenes) {
    const old = sceneOf(before, scene.id)
    if (old) scenes.push(!locked.has(scene.id) && take(`scene:${scene.id}`) ? scene : old)
    else if (take(`scene:${scene.id}`)) scenes.push(scene)
  }
  for (const scene of before.scenes) {
    if (!sceneOf(after, scene.id) && (locked.has(scene.id) || !take(`scene:${scene.id}`))) scenes.push(scene)
  }
  const kept = new Set(scenes.map(scene => scene.id))
  return cleanPlot({ ...before, ...info, start: kept.has(info.start) ? info.start : before.start, scenes: structuredClone(scenes) })
}
