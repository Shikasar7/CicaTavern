// 剧情向导: the words of it (plans/21). What the guide is told, the 剧情方案 it writes read back, and the
// <剧情向导> block a plan the player took rides in on each turn's message. No storage here: chats.mjs and
// engine.mjs read the block and the view from this, guide.mjs keeps the guide's own talk.
import { msg } from './i18n.mjs'
import { storyTurns } from './recap.mjs'
import { httpError } from './store.mjs'

export const GUIDE_TAG = '剧情向导'
/** The block in a turn's message: taken out of the older messages (engine historyFor), as 紧挨回复 lore is. */
export const GUIDE_BLOCK = /\n*<剧情向导>\n[\s\S]*?\n<\/剧情向导>/g

/** How hard a plan pushes: the one line of the guidance that says so (节奏：…), swapped when the player picks another. */
export const STRENGTHS = Object.freeze({
  hint: '节奏：只铺垫。这几轮只埋下和目标有关的迹象，不让它真的发生。',
  steady: '节奏：自然推进。顺着当下的情节一点点靠近，几轮之内让它自然发生。',
  soon: '节奏：尽快引爆。一两轮之内找一个合理的契机让它发生。',
})
export const DEFAULT_STRENGTH = 'steady'
const PACE = /^节奏[:：].*$/m

export const MAX_PLANS = 3
const MAX_GOAL = 160
const MAX_ITEM = 160
const MAX_ITEMS = 4
export const MAX_GUIDANCE = 2000
// Plans the player saw through (完成) or stopped, kept for the guide to know what came before.
export const MAX_DONE = 8

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** A plan as kept: { goal, start: [], notes: [] }, each part cut to size; null without a goal. */
export function cleanPlan(plan) {
  const goal = clip(plan?.goal, MAX_GOAL)
  if (!goal) return null
  const list = items => (Array.isArray(items) ? items : []).map(item => clip(item, MAX_ITEM)).filter(Boolean).slice(0, MAX_ITEMS)
  return { goal, start: list(plan.start), notes: list(plan.notes) }
}

/** The guidance a plan gives at `strength`, the line the turn's message carries (guideBlock). */
export function guidanceText(plan, strength = DEFAULT_STRENGTH) {
  const lines = [`目标：${plan.goal}`]
  if (plan.start?.length) lines.push('可以从这些地方起头：', ...plan.start.map(item => `- ${item}`))
  if (plan.notes?.length) lines.push('注意：', ...plan.notes.map(item => `- ${item}`))
  lines.push(STRENGTHS[strength] ?? STRENGTHS[DEFAULT_STRENGTH])
  return lines.join('\n')
}

/** Guidance the player wrote over, at another strength: its 节奏 line swapped (added when they took it out). */
export function withStrength(text, strength) {
  const pace = STRENGTHS[strength] ?? STRENGTHS[DEFAULT_STRENGTH]
  return PACE.test(text) ? text.replace(PACE, pace) : `${text.trimEnd()}\n${pace}`
}

/** The strength a guidance text says, from its 节奏 line; null when it says none of the three. */
export function strengthOf(text) {
  const line = String(text ?? '').match(PACE)?.[0]
  return Object.keys(STRENGTHS).find(key => STRENGTHS[key] === line) ?? null
}

// The same three rules each turn: the player first, a little at a time, never said aloud. The chat's system prompt is
// frozen, so what this block is goes in the block itself.
const RULES = [
  '以上是幕后的剧情方向，玩家看不到；只管这一轮，之前消息里给过的方向都作废，以这里为准。',
  '玩家的行动永远优先：玩家往别处走时顺着玩家写，换个机会再铺，不要硬拉回来；不要替玩家做决定、说话或行动。',
  '不要在正文里说出这个方向，也不要让人物知道有人在安排。',
].join('\n')

/**
 * Whether `active` (chat.guide.active) holds on `path` (root to the turn's parent), and how many turns of it this one is.
 * It began at `anchor` (the player message before the reply it was taken at, or the root): a branch from before
 * that is a story it was never taken in, so it rests there.
 */
export function guideOn(active, path) {
  if (!active?.plan) return null
  if (!path.some(node => node.id === active.anchor)) return null
  return { turn: Math.max(1, storyTurns(path) - (Number(active.sinceTurn) || 0) + 1) }
}

/** Where a plan taken now starts, on `path` (the chat's active path): { anchor, sinceTurn } for changeGuide. */
export function anchorOf(path) {
  const tip = path.at(-1)
  return { anchor: tip?.parent ?? tip?.id ?? 'root', sinceTurn: storyTurns(path) }
}

/** The turn's <剧情向导> block, or '' when there is no plan or it rests on this branch. */
export function guideBlock(active, path) {
  const on = guideOn(active, path)
  if (!on) return ''
  const text = String(active.edited ?? '').trim() || guidanceText(active.plan, active.strength)
  return `<剧情向导>\n${text}\n这是这个方向的第 ${on.turn} 轮。\n${RULES}\n</剧情向导>`
}

/** What the page shows of the plan being followed on `path`: null when there is none. */
export function guideView(guide, path, { held = false } = {}) {
  const active = guide?.active
  if (!active?.plan) return null
  const on = held ? null : guideOn(active, path)
  return {
    plan: active.plan,
    strength: strengthOf(active.edited) ?? active.strength ?? DEFAULT_STRENGTH,
    text: String(active.edited ?? '').trim() || guidanceText(active.plan, active.strength),
    edited: Boolean(active.edited),
    at: active.at,
    on: Boolean(on),
    // A 剧本 runs: the plan rests till it is paused or taken off.
    held,
    // Turns already sent with it on this branch.
    turns: on ? on.turn - 1 : 0,
  }
}

// 剧情方案 the guide writes: one block per plan, its parts on lines of their own.
const OPEN = /[<＜]\s*剧情方案\s*[>＞]/g
const CLOSE = /[<＜]\s*\/\s*剧情方案\s*[>＞]/
const FIELDS = [
  ['goal', /^(?:目标|方向)\s*[:：]\s*/],
  ['start', /^(?:怎么起头|起头|开头|切入|迹象)\s*[:：]\s*/],
  ['notes', /^(?:要注意|注意|禁忌|避免)\s*[:：]\s*/],
]
const BULLET = /^\s*(?:[-*·•●○◦]|\d+[.)、．）]|[（(]\d+[)）])\s*/

function readPlan(body) {
  const plan = { goal: '', start: [], notes: [] }
  let field = null
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\*\*|__/g, '').trim()
    if (!line) continue
    const named = FIELDS.find(([, pattern]) => pattern.test(line.replace(BULLET, '')))
    if (named) {
      field = named[0]
      const rest = line.replace(BULLET, '').replace(named[1], '').trim()
      if (field === 'goal') plan.goal = rest
      else if (rest) plan[field].push(...rest.split(/[;；]/))
      continue
    }
    if (field === 'goal') plan.goal = plan.goal ? `${plan.goal} ${line}` : line
    else if (field) plan[field].push(line.replace(BULLET, ''))
    // A first line with no name: the goal.
    else if (!plan.goal) {
      plan.goal = line.replace(BULLET, '')
      field = 'goal'
    }
  }
  return cleanPlan(plan)
}

/**
 * The 剧情方案 in a reply of the guide's, and the reply without them: { text, plans } (at most MAX_PLANS). A block
 * missing its closing tag runs to the next one or the end.
 */
export function planOf(reply) {
  const source = String(reply ?? '')
  const opens = [...source.matchAll(OPEN)]
  if (!opens.length) return { text: source.trim(), plans: [] }
  const plans = []
  let text = source.slice(0, opens[0].index)
  opens.forEach((open, index) => {
    const from = open.index + open[0].length
    const until = opens[index + 1]?.index ?? source.length
    const span = source.slice(from, until)
    const close = CLOSE.exec(span)
    const plan = readPlan(close ? span.slice(0, close.index) : span)
    if (plan && plans.length < MAX_PLANS) plans.push(plan)
    if (close) text += span.slice(close.index + close[0].length)
  })
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), plans }
}

/** The guide's own instructions: who it is, what it may do, and the 剧情方案 form. */
export function guideSystem(names = {}) {
  const user = names.user || '玩家'
  const char = names.char || '角色'
  return [
    `你是「剧情向导」：${user}和${char}这段互动故事的幕后编剧搭档兼写作顾问。你不在故事里，不扮演任何人物，不续写正文；你和${user}在幕后聊这段故事。`,
    '',
    '## 你要做的',
    '- 回答关于这段故事的问题：人物为什么这样做、伏笔和线索、关系走到了哪、接下来可以怎么走。回答要落到这段故事里具体发生过的事，不说放之四海皆准的空话。',
    '- 给写作上的建议：这种题材怎么写好看，为什么讲故事的模型老是这样写，怎么调整。建议要能马上用上。',
    '- 用户的语言是什么就用什么回答，简短直接，先说结论。',
    '',
    '## 提方案',
    `${user}问接下来怎么走、想让故事往某个方向发展，或者你觉得故事卡住了，就提 1 到 3 个方案。每个方案单独写一个块，放在回复最后：`,
    '<剧情方案>',
    '目标：一句话，要发生的事',
    '起头：两三个能落地的迹象，用分号隔开',
    '注意：别一轮演完、别直接说破、哪些人物不该出场之类，用分号隔开',
    '</剧情方案>',
    `${user}采用一个方案后，它会作为幕后方向每轮悄悄带给讲故事的模型；你不用再复述它。没必要提方案时就不要提。`,
    '',
    '## 分寸',
    `- 不替${user}做决定：给选择和理由，由${user}定。`,
    `- 资料里有${user}在故事里还没见到的秘密设定时，可以据此出主意，但不要主动说破；${user}明确问了再说。`,
    '- 你改不了角色卡、世界书和预设。想长期改变写法时，建议用「修改角色卡」里的「对话修改」，或者把要求写进角色卡的「角色备注」。',
    '- 问到 CicaTavern 这个应用本身怎么用时，建议去「直连对话」里打开「应用帮助」问，那边能查使用说明。',
    '',
    '## 写作上可以参考的',
    '- 节奏：一场戏只做一件事；紧张的段落后面给一段喘息；别在一轮里把几件大事一起推完。',
    '- 张力：人物想要什么、什么挡着他，两样都清楚，戏才立得住；挡着的东西越具体越好。',
    '- 伏笔：埋下的要记得收；收的时候让人意外，回头想又在情理之中。',
    '- 人物：动机比性格标签可靠，让人物按自己想要的去做，而不是按剧情需要去做。',
    '- 对话：话里有话比直说动人；同一句话，谁说、什么时候说，意思就不同。',
    '- 题材：恋爱看距离的变化，悬疑看信息给多少、什么时候给，武侠看规矩和代价，冒险看目标和障碍，日常看小事里的情绪。',
  ].join('\n')
}

/** The guide's talk before this question, as the in-story request reads it (askInContext has no turns of its own). */
export function talkLines(turns, max = 8) {
  const lines = []
  for (const turn of turns.slice(-max)) {
    if (turn.note) lines.push(`（${turn.note}）`)
    if (turn.user) lines.push(`玩家：${turn.user.text}`)
    if (turn.assistant) lines.push(`向导：${turn.assistant.text}${turn.assistant.plans?.length ? `\n（提了 ${turn.assistant.plans.length} 个方案：${turn.assistant.plans.map(plan => plan.goal).join('；')}）` : ''}`)
  }
  return lines.join('\n\n')
}

/** What the guide knows of the plan being followed and the ones before it. */
export function guidanceNote(guide) {
  const parts = []
  const active = guide?.active
  if (active?.plan) parts.push(`<正在进行的引导>\n${String(active.edited ?? '').trim() || guidanceText(active.plan, active.strength)}\n</正在进行的引导>`)
  const done = (guide?.done ?? []).slice(-4)
  if (done.length) parts.push(`<之前的引导>\n${done.map(item => `- ${item.goal}（${item.how === 'done' ? '已经演到' : '中途停了'}）`).join('\n')}\n</之前的引导>`)
  return parts.join('\n\n')
}

/**
 * chat.guide after the player's action on it: { active?, done } (a copy; `guide` is left as it was).
 *   adopt { plan, strength }: follow this plan from here (`anchor`, `sinceTurn`), the one before it counted as stopped;
 *   strength { strength }; edit { text } (empty: back to the words the plan gives); done / stop: end it.
 */
export function changeGuide(guide, { action, plan, strength, text } = {}, { anchor = 'root', sinceTurn = 0, at = new Date().toISOString() } = {}) {
  const next = { ...(guide ?? {}), done: [...(guide?.done ?? [])] }
  const active = next.active ? { ...next.active } : null
  const end = how => {
    if (active) next.done = [...next.done, { goal: active.plan.goal, how, at }].slice(-MAX_DONE)
    delete next.active
  }
  if (action === 'adopt') {
    const cleaned = cleanPlan(plan)
    if (!cleaned) throw httpError(400, msg`这个方案没有目标`)
    end('stop')
    next.active = { plan: cleaned, strength: STRENGTHS[strength] ? strength : DEFAULT_STRENGTH, anchor, sinceTurn, at }
    return next
  }
  if (!active) throw httpError(409, msg`现在没有在引导`)
  if (action === 'strength') {
    if (!STRENGTHS[strength]) throw httpError(400, msg`不认识的节奏`)
    active.strength = strength
    if (active.edited) active.edited = withStrength(active.edited, strength)
  } else if (action === 'edit') {
    const value = String(text ?? '').trim().slice(0, MAX_GUIDANCE)
    if (!value || value === guidanceText(active.plan, active.strength)) delete active.edited
    else {
      active.edited = value
      active.strength = strengthOf(value) ?? active.strength
    }
  } else if (action === 'done' || action === 'stop') {
    end(action)
    return next
  } else throw httpError(400, msg`不认识的操作`)
  next.active = active
  return next
}
