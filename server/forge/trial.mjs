// 试玩体检: a few rounds of a saved card on the real chat engine, in a chat of its own that nobody sees and that goes when
// the round is over. One model plays the card as a chat always does, another call stands in for the player, and every
// round is looked over by the program: what a reply should carry, what reached the variables, what showed that should
// not. One last call reads the story for what only a reader sees. The window says about how much before anything is sent.
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { estimateTokens } from '../context.mjs'
import { msg } from '../i18n.mjs'
import { estimateCost } from '../models.mjs'
import { hasUpdateBlock, usesMvu } from '../mvu.mjs'
import { chatTemplates, replyBlocks } from '../prompt.mjs'
import { storyPath } from '../recap.mjs'
import { isProviderRef, refLabel } from '../providers.mjs'
import { applyScripts } from '../regex-guard.mjs'
import { applyWrites, displayText } from '../state.mjs'
import { httpError } from '../store.mjs'
import { hasEjs, splitDecorators, templateSession } from '../template.mjs'
import { greetingList } from '../../web/shared/card-edit.js'
import { PLACEMENT } from '../../web/shared/regex.js'
import { cleanPath, joinPath } from '../../web/shared/status.js'
import { getPath, unwrap } from '../../web/shared/vars.js'
import { booksForCard, chatScripts, createChat, pathTo, presetFor } from '../chats.mjs'
import { asksChoices } from '../basic.mjs'
import { constantEntries, isConstant, lateEntries } from '../worldbook.mjs'
import { autoCommands, startBattle, step } from '../../web/shared/game/battle.js'
import { encounterSetup } from '../../web/shared/game/encounter.js'
import { rulesOn, sheetOf, sheetOnPath } from '../../web/shared/game/sheet.js'
import { CREATION_TAG, creationOf, randomSheet } from './creation.mjs'
import { LONG_TOKENS, TALK_TOKENS, looseJson, section } from './prompts.mjs'

const PREFIX = 'edit-trial-'
/** The session a card's trial and its report are kept in. */
export const trialSessionId = cardId => `${PREFIX}${cardId}`
export const TRIAL_ROUNDS = [3, 6, 10]
const DEFAULT_ROUNDS = 6
const MAX_QUOTE = 60
const MAX_ISSUES = 12
const MAX_TEXT = 2400
const RECENT_ROUNDS = 3
// A settled roll can lead straight into a fight: how many stops one round goes through before the player has a say.
const MAX_STOPS = 3
// What a round comes to beyond the card's own text, from the real runs of 2026-11: a reply and its thinking, the story so
// far growing by about this much a round, and the stand-in player.
const REPLY_TOKENS = 2500
const GROWTH_TOKENS = 1500
const PRESET_TOKENS = 3000
const PLAYER_INPUT = 2500
const PLAYER_OUTPUT = 600
const REVIEW_OUTPUT = 4000
// What the reader gets beyond the story on a card with variables: a line a round of what changed, the rules, the events.
const VALUE_ROUND_TOKENS = 120
const VALUE_BASE_TOKENS = 400
const MAX_NOTED = 16

// What the stand-in player tries, in order. Each is a thing real cards fell over in testing: going along with a false
// claim, letting a player do what the rules forbid, answering for the player, losing count of what was spent.
const INTENTS = {
  go: '顺着眼前的情况自然地往下走，可以选一个选项。',
  use: '用掉一样东西，或者花一笔钱，或者拿到一样东西。说清是什么、多少。',
  ask: '追问一个人物不愿说的事。',
  push: '坚决地做一件明显超出你本事或规矩的事。',
  claim: '当真地说一件和前文不符的小事，比如记错了数目、时间或谁说过的话。',
  hand: '不做决定，让对方替你决定接下来怎么办。',
}
const INTENT_ORDER = {
  3: ['go', 'push', 'claim'],
  6: ['go', 'use', 'ask', 'push', 'claim', 'hand'],
  10: ['go', 'use', 'ask', 'go', 'push', 'use', 'claim', 'go', 'hand', 'ask'],
}

export const cleanRounds = value => (TRIAL_ROUNDS.includes(Number(value)) ? Number(value) : DEFAULT_ROUNDS)
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const valueOf = (state, field) => getPath(state ?? {}, cleanPath(field.path))

/** The stand-in player's line for a round. @param story - [{ you, reply }], the rounds so far, the opening first. */
export function playerRequest(card, story, intent) {
  const recent = story.slice(-RECENT_ROUNDS).map(({ you, reply }) => [you ? `玩家：${you}` : '', `故事：${clip(reply, MAX_TEXT)}`].filter(Boolean).join('\n')).join('\n\n')
  const system = `你在替一位玩家试玩角色卡《${card.name}》。写这位玩家这一轮说的话或做的事：
- 一到三句，第一人称，用故事的语言写。
- 只写玩家自己的话和动作，不写别人的反应，不写结果。
- 不解释，不写括号里的说明。这一轮要做的事不要点破，当作玩家本来就想这么做。`
  return { system, messages: [{ role: 'user', content: `<故事>\n${recent}\n</故事>\n\n这一轮：${INTENTS[intent] ?? INTENTS.go}\n\n只输出玩家这一轮的话。` }], maxTokens: TALK_TOKENS, softCap: true }
}

/** What the model answered, as a player's line: quotes and labels it put around it go. */
export function playerLine(text) {
  return String(text ?? '').trim().replace(/^(玩家|我|Player)[:：]\s*/, '').replace(/^["“「]([\s\S]*)["”」]$/, '$1').trim()
}

/** One round as the program sees it. @param reply - { text, shown, node }; @param needs - what roundNeeds worked out. */
export function roundChecks({ text, shown, node }, needs) {
  const problems = []
  const add = (kind, what, extra = {}) => problems.push({ kind, what, ...extra })
  if (!text.trim()) add('empty', msg`回复是空的`)
  if (node.api?.truncated) add('cut', msg`回复写到输出上限被截断了`)
  if (needs.update && !hasUpdateBlock(text)) add('update', msg`没写变量更新`)
  else if (needs.update && node.updateUnread) add('update', msg`变量更新块读不出来`)
  if (needs.choices && !/<choices>[\s\S]*<\/choices>/.test(text)) add('choices', msg`没写行动选项`)
  for (const tag of needs.always) if (!text.includes(`<${tag}>`)) add('block', msg`没写 <${tag}> 块`)
  if (node.schemaProblem) add('schema', msg`变量没通过卡的规则：${String(node.schemaProblem).slice(0, 120)}`)
  for (const error of node.templateErrors ?? []) add('template', msg`模板出错：${String(error).slice(0, 120)}`)
  const leaked = [...new Set([...shown.matchAll(/<\/?([a-zA-Z_][\w-]*)>/g)].map(match => match[1]))].filter(tag => !HTML_TAGS.has(tag.toLowerCase()))
  if (leaked.length) add('leak', msg`玩家看到了本该隐藏的标签：${leaked.map(tag => `<${tag}>`).join(' ')}`)
  for (const field of needs.ranged) {
    const value = Number(unwrap(valueOf(node.state, field)))
    if (Number.isFinite(value) && (value < field.min || value > field.max)) add('range', msg`「${field.label || field.path}」到了 ${value}，超出 ${field.min} 到 ${field.max}`, { field: field.label || field.path })
  }
  return problems
}

const HTML_TAGS = new Set(['b', 'i', 'u', 's', 'p', 'br', 'hr', 'em', 'strong', 'span', 'div', 'small', 'big', 'sub', 'sup', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'center', 'font', 'details', 'summary', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'style', 'script', 'body', 'html', 'head', 'meta', 'title', 'iframe'])

/** What every reply of this card should carry; a block the rules ask for only now and then is not held against it. */
export function roundNeeds({ mvu, choices, blocks, fields }) {
  return {
    update: mvu,
    choices,
    always: blocks.filter(tag => tag === 'self_check'),
    ranged: (fields ?? []).filter(field => Number.isFinite(field.min) && Number.isFinite(field.max) && field.max > field.min),
  }
}

/** A reply that stops on a roll or a fight is told to write nothing past the mark: its update and choices come with the reply after it. */
export const stopNeeds = needs => ({ ...needs, update: false, choices: false, always: [] })

/** A fight a reply stopped on, played by 自动 as the page plays it, and reported the way the page reports it. */
export function autoFight(book, chat, stop) {
  const setup = encounterSetup(sheetOf(book, sheetOnPath(pathTo(chat, stop.id)), stop.state), book, stop.gate, chat.id, stop.id)
  let state = startBattle(setup)
  const actions = []
  while (!state.over) {
    const action = autoCommands(state)
    actions.push(action)
    state = step(state, action).state
  }
  return { over: state.over, attempt: 0, actions }
}

const TIERS = () => ({ crit: msg`大成功`, success: msg`成功`, close: msg`险胜`, fail: msg`失败` })
const ENDS = () => ({ won: msg`胜利`, lost: msg`战败`, fled: msg`逃脱` })

/** A settled roll or fight as the report shows it, from what the turn kept (the engine's own line is for the model). */
export function stopLine(asked) {
  const { check, battle } = asked ?? {}
  if (battle?.over === 'story') return msg`（没有开打，交给了剧情：${battle.foes}）`
  // Who went down, so the reader can tell a story that has one of them run away from a fight the program won.
  if (battle) return battle.downed ? msg`（战斗：${ENDS()[battle.over]}，${battle.rounds} 回合，击倒 ${battle.downed}，生命 ${battle.life}/${battle.maxLife}）` : msg`（战斗：${ENDS()[battle.over]}，${battle.rounds} 回合，生命 ${battle.life}/${battle.maxLife}）`
  if (!check) return ''
  const what = check.stat ? msg`${check.stat}检定` : msg`检定`
  return check.lacks ? msg`（${what}：${check.total}，需要 ${check.dc}，缺${check.lacks}，${TIERS()[check.tier]}）` : msg`（${what}：${check.total}，需要 ${check.dc}，${TIERS()[check.tier]}）`
}

/** Numbers that stayed where they started, all the way through. */
function stillFields(fields, first, last) {
  return (fields ?? []).filter(field => field.show !== 'hidden').filter(field => {
    const before = valueOf(first, field)
    return before !== undefined && JSON.stringify(before) === JSON.stringify(valueOf(last, field))
  })
}

/**
 * The rounds added up, as the report opens with them.
 * @param rounds - { problems, triggered, state }, in order.
 * @returns [{ level: 'ok' | 'warn' | 'error', text }]
 */
export function summaryLines(rounds, { needs, fields, start, keyed = [], ruled = false }) {
  const total = rounds.length
  const lines = []
  const count = kind => rounds.filter(round => round.problems.some(problem => problem.kind === kind)).length
  const rate = (label, missed) => lines.push({ level: missed === 0 ? 'ok' : missed > total / 3 ? 'error' : 'warn', text: msg`${label}：${total} 回合写了 ${total - missed} 回合` })
  if (needs.update) rate(msg`变量更新`, count('update'))
  if (needs.choices) rate(msg`行动选项`, count('choices'))
  for (const tag of needs.always) rate(`<${tag}>`, rounds.filter(round => round.problems.some(problem => problem.kind === 'block' && problem.what.includes(`<${tag}>`))).length)
  for (const [kind, text] of [['empty', msg`回复是空的：${count('empty')} 回合`], ['cut', msg`回复被截断：${count('cut')} 回合`], ['leak', msg`露出了隐藏内容：${count('leak')} 回合`], ['schema', msg`变量没通过卡的规则：${count('schema')} 回合`], ['template', msg`模板出错：${count('template')} 回合`]]) {
    if (count(kind)) lines.push({ level: 'error', text })
  }
  // Which number and in which rounds, for the line to be acted on from 检查这张卡 without opening the rounds.
  const over = new Map()
  rounds.forEach((round, i) => {
    for (const problem of round.problems) if (problem.kind === 'range') over.set(problem.field ?? '', [...new Set([...(over.get(problem.field ?? '') ?? []), i + 1])])
  })
  if (over.size) lines.push({ level: 'error', text: msg`数值超出范围：${[...over].map(([field, at]) => msg`「${field}」第 ${at.join(msg`、`)} 回合`).join(msg`；`)}` })
  if (!count('leak')) lines.push({ level: 'ok', text: msg`没有后台内容露给玩家` })
  const last = rounds.at(-1)?.state
  const still = total >= 5 && needs.update ? stillFields(fields, start, last) : []
  if (still.length) lines.push({ level: 'warn', text: msg`这些变量一直没变过：${still.map(field => field.label || field.path).slice(0, 8).join(msg`、`)}。也许只是没玩到，也许更新规则没写清` })
  const fired = new Set(rounds.flatMap(round => round.triggered))
  const asleep = keyed.filter(title => !fired.has(title))
  if (keyed.length) lines.push({ level: 'ok', text: msg`按关键词的世界书触发了 ${keyed.length - asleep.length} 条，共 ${keyed.length} 条` })
  if (ruled) {
    // The stand-in writes its own actions and never picks a choice, so a choice's roll or fight is not tried: said, not hidden.
    const stops = rounds.flatMap(round => round.stops ?? [])
    const checks = stops.filter(kind => kind === 'check').length
    const fights = stops.length - checks
    lines.push({ level: 'ok', text: stops.length ? msg`回复停下来检定 ${checks} 次、战斗 ${fights} 场，都由程序自动掷骰、自动打完。选项上的检定和战斗没有试` : msg`开着游戏规则，这一局回复没有停下来检定或战斗。选项上的检定和战斗没有试` })
  }
  return lines
}

// ─── Values, and the events that wait on them ─────────────────────────────
// Told by the program from each round's state: an event entry sent on a condition on the variables (an @@if, as
// 创作角色卡 writes them) against the rounds it held in, and the values against the card's update rules. What it
// cannot tell, whether an event came into the story or a value should have moved, goes to the reader with the story:
// no call of its own.

// The test of an event kept to once (write.mjs notHappened): the list it goes on and its name there.
const ONCE_TEST = /!JSON\.stringify\(getvar\((["'])stat_data\.(.+?)\1,\s*\{\s*defaults:\s*\[\]\s*\}\)\)\.includes\(("(?:[^"\\]|\\.)*")\)/
const READS_VALUES = /getvar|stat_data/

/**
 * The worldbook entries sent on a condition on the variables.
 * @returns [{ title, value: the condition on the values, once: { list, item } | null, keyed: sent on its keywords too }]
 */
export function valueEvents(books) {
  const out = []
  for (const entry of (books ?? []).flatMap(book => book.entries ?? [])) {
    if (entry.enabled === false) continue
    const test = splitDecorators(entry.content).condition
    if (!test || !READS_VALUES.test(test)) continue
    const mark = ONCE_TEST.exec(test)
    let once = null
    try {
      once = mark ? { list: mark[2], item: JSON.parse(JSON.parse(mark[3])) } : null
    } catch {}
    // The rest of the condition, the once-test taken out with the && before it (or left as true where there is none).
    const head = once ? test.slice(0, mark.index).trimEnd() : ''
    const value = !once ? test : head.endsWith('&&') ? `${head.slice(0, -2).trimEnd()}${test.slice(mark.index + mark[0].length)}` : test.replace(mark[0], 'true')
    // Kept to once and nothing more: it waits on its keywords, not on a value.
    if (!READS_VALUES.test(value)) continue
    // As the turn records an entry it sent (engine.mjs injectedTitles).
    out.push({ title: entry.comment || entry.keys?.[0] || String(entry.uid), value, once, keyed: !isConstant(entry) })
  }
  return out
}

/** Which of `tests` hold in `session` (closed after): true, false, or null for one that cannot be run. */
function testsOn(tests, session) {
  if (!tests.length) return []
  try {
    return tests.map(test => {
      const { text, error } = session.render(`<% if (${test}) { %>1<% } %>`)
      return error || text == null ? null : text.trim() === '1'
    })
  } finally {
    session.dispose()
  }
}

// As notHappened reads it: the name, quoted, anywhere in the list as JSON.
const marked = (state, once) => JSON.stringify(getPath(state ?? {}, once.list) ?? []).includes(JSON.stringify(once.item))

const RULE_KEYS = ['type', 'range', 'check']
const RULES_NAME = /变量更新规则|update[ _-]?rules/i
const RANGE = /(-?\d+(?:\.\d+)?)\s*(?:~|～|-|—|–|到|至|,|，)\s*(-?\d+(?:\.\d+)?)/
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function rangeOf(range) {
  const [low, high] = Array.isArray(range) ? range.map(Number) : (RANGE.exec(String(range ?? '')) ?? []).slice(1).map(Number)
  return Number.isFinite(low) && Number.isFinite(high) && high > low ? { min: low, max: high } : {}
}

/**
 * The card's update rules as MVU cards write them (变量更新规则: a variable's type, range and check, or a line):
 * [{ path, label, check, min?, max? }]. A card without them has none.
 */
export function updateRules(books) {
  for (const entry of (books ?? []).flatMap(book => book.entries ?? [])) {
    if (entry.enabled === false || hasEjs(entry.content) || !RULES_NAME.test(`${entry.comment ?? ''}\n${entry.content ?? ''}`)) continue
    let doc = null
    try {
      // Cards wrap the YAML in a tag of their own.
      doc = YAML.parse(String(entry.content ?? '').replace(/^\s*<\/?[\w-]+>\s*$/gm, ''))
    } catch {}
    if (!isRecord(doc)) continue
    const key = Object.keys(doc).find(name => RULES_NAME.test(name))
    const root = key ? doc[key] : RULES_NAME.test(entry.comment ?? '') ? doc : null
    if (!isRecord(root)) continue
    const out = []
    const walk = (node, keys) => {
      if (keys.length && (typeof node === 'string' || (isRecord(node) && RULE_KEYS.some(name => name in node)))) {
        const check = typeof node === 'string' ? node : [node.check].flat().filter(line => typeof line === 'string').join('；')
        out.push({ path: joinPath(keys), label: keys.at(-1), check: clip(check, 120), ...(isRecord(node) ? rangeOf(node.range) : {}) })
      } else if (isRecord(node)) for (const [name, value] of Object.entries(node)) walk(value, [...keys, name])
    }
    walk(root, [])
    if (out.length) return out
  }
  return []
}

/** The status bar's fields with the update rules joined in: a rule's range where the field has none, a rule's variable not shown. */
export function ruledFields(fields, rules) {
  const out = (fields ?? []).map(field => ({ ...field }))
  for (const rule of rules ?? []) {
    const field = out.find(item => cleanPath(item.path) === rule.path)
    if (!field) out.push({ ...rule })
    else {
      field.check ??= rule.check
      if (!(Number.isFinite(field.min) && Number.isFinite(field.max)) && Number.isFinite(rule.min)) Object.assign(field, { min: rule.min, max: rule.max })
    }
  }
  return out
}

const shapeOf = value => (value === undefined ? 'gone' : value === null ? 'none' : Array.isArray(value) ? 'list' : typeof value)
const SHAPES = () => ({ number: msg`数字`, string: msg`文字`, boolean: msg`是或否`, list: msg`列表`, object: msg`一组值`, gone: msg`没有` })
const shortValue = value => clip(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 24)

/**
 * The variables and the events waiting on them over a run, as far as the program can tell.
 * @param rounds - { state, triggered: titles of the entries sent, input, turns?: [{ state }] each turn began on }, in
 *   order; @param start - the state before the first.
 * @param sandbox - (state, round, turn) => the template session that turn's conditions ran in (the engine's chatTemplates,
 *   with the @@preload helpers and the chat's variables); a bare one on the state when not given.
 * @returns { problems: [[{ kind, what }]] by round, lines: [{ level, text }], notes: what the reader gets, '' for none }
 */
export function valueChecks(rounds, { start = {}, fields = [], events = [], sandbox = state => templateSession({ state }) } = {}) {
  const problems = rounds.map(() => [])
  const lines = []
  const before = [start, ...rounds.map(round => round.state)]
  const label = field => field.label || field.path
  const listed = list => list.map(at => at + 1).join(msg`、`)
  // The reader's notes stay in Chinese, as the rest of what it is given.
  const told = list => list.map(at => at + 1).join('、')

  // A value whose kind changed from the one it started with (a number written back as text, one taken out).
  for (const field of fields) {
    const shape = shapeOf(unwrap(valueOf(start, field)))
    if (shape === 'gone' || shape === 'none') continue
    const at = []
    let became = ''
    rounds.forEach((round, i) => {
      const was = shapeOf(unwrap(valueOf(before[i], field)))
      const now = unwrap(valueOf(round.state, field))
      if (was !== shape || [shape, 'none'].includes(shapeOf(now))) return
      at.push(i)
      became ||= shapeOf(now)
      problems[i].push({ kind: 'shape', field: label(field), what: now === undefined ? msg`「${label(field)}」被删掉了` : msg`「${label(field)}」从${SHAPES()[shape]}变成了${SHAPES()[shapeOf(now)]}：${clip(JSON.stringify(now), 24)}` })
    })
    if (at.length) lines.push({ level: 'error', text: became === 'gone' ? msg`「${label(field)}」第 ${listed(at)} 回合被删掉了` : msg`「${label(field)}」开局是${SHAPES()[shape]}，第 ${listed(at)} 回合变成了${SHAPES()[became]}` })
  }

  const waiting = []
  // Events whose condition the program could not run where it mattered: no verdict, the reader tells from the story.
  const unsure = []
  const notes = []
  // A round the rules stopped for a roll or a fight is several turns, each sent on the state it began with: the reply
  // before it with the rules' writes on top. A condition met on any of them was met that round.
  const starts = rounds.map((round, i) => (round.turns?.length ? round.turns : [{ state: before[i] }]))
  const held = events.length ? starts.map((turns, i) => turns.map((turn, j) => testsOn(events.map(event => event.value), sandbox(turn.state ?? {}, i, j)))) : []
  const anyOf = list => (list.includes(true) ? true : list.includes(null) ? null : false)
  events.forEach((event, k) => {
    if (event.once && marked(start, event.once)) return
    const fired = round => (round.triggered ?? []).map(String).includes(event.title)
    // A keyword entry the engine sent had its condition hold, whatever the program made of it.
    const on = rounds.map((round, i) => (event.keyed && fired(round) ? true : anyOf(held[i].map(turn => turn[k]))))
    const first = on.indexOf(true)
    const sent = rounds.map((round, i) => (event.keyed ? fired(round) : held[i].some((turn, j) => turn[k] === true && !(event.once && marked(starts[i][j].state, event.once)))))
    const heldAt = on.flatMap((yes, i) => (yes === true ? [i] : []))
    const unknownAt = on.flatMap((yes, i) => (yes == null ? [i] : []))
    const sentAt = sent.flatMap((yes, i) => (yes ? [i] : []))
    const note = [`「${event.title}」条件：${clip(event.value, 100)}`, `满足的回合：${heldAt.length ? told(heldAt) : '无'}`]
    if (unknownAt.length) note.push(`程序算不出条件的回合：${told(unknownAt)}（按故事和变量判断该不该发生）`)
    note.push(`发给模型的回合：${sentAt.length ? told(sentAt) : '无'}${unknownAt.length && !event.keyed ? '（算不出的回合不知道）' : ''}`)
    if (!event.once) {
      // Without a list of what happened, whether it came is for the reader to tell.
      if (first >= 0) lines.push({ level: 'ok', text: msg`「${event.title}」第 ${listed(heldAt)} 回合数值条件满足` })
      else if (unknownAt.length) unsure.push(event.title)
      else waiting.push(event.title)
      notes.push(note.join('；'))
      return
    }
    const at = rounds.findIndex((round, i) => !marked(before[i], event.once) && marked(round.state, event.once))
    const dropped = rounds.findIndex((round, i) => marked(before[i], event.once) && !marked(round.state, event.once))
    note.push(at >= 0 ? `记为已发生：第 ${at + 1} 回合` : '没有记为已发生')
    notes.push(note.join('；'))
    if (dropped >= 0) {
      const what = msg`「${event.once.list}」里的「${event.once.item}」第 ${dropped + 1} 回合被删掉了，规则是加过的不删`
      problems[dropped].push({ kind: 'event', what })
      lines.push({ level: 'error', text: what })
    }
    // Early only when the condition was known not to hold in every round up to it.
    const early = at >= 0 && (first < 0 || first > at)
    if (early && unknownAt.some(i => i <= at)) unsure.push(event.title)
    else if (early) {
      const what = msg`第 ${at + 1} 回合「${event.title}」提前发生了：数值条件还没满足`
      problems[at].push({ kind: 'event', what })
      lines.push({ level: 'error', text: what })
    } else if (at >= 0) lines.push({ level: 'ok', text: at === first ? msg`「${event.title}」第 ${at + 1} 回合数值条件满足，当回合就发生了` : msg`「${event.title}」第 ${first + 1} 回合数值条件满足，第 ${at + 1} 回合发生` })
    else if (first < 0) (unknownAt.length ? unsure : waiting).push(event.title)
    else if (sentAt.length) lines.push({ level: 'warn', text: msg`「${event.title}」第 ${first + 1} 回合起数值条件满足，发给了模型 ${sentAt.length} 回合，到最后都没发生` })
    else lines.push({ level: 'ok', text: msg`「${event.title}」第 ${first + 1} 回合起数值条件满足，但没有提到它的关键词，没发给模型` })
  })
  if (waiting.length) lines.push({ level: 'ok', text: msg`这些按数值触发的事件条件一直没满足：${waiting.slice(0, 8).join(msg`、`)}。也许只是没玩到` })
  if (unsure.length) lines.push({ level: 'ok', text: msg`这些按数值触发的事件，程序算不出条件，交给审读按故事判断：${unsure.slice(0, 8).join(msg`、`)}` })

  const noted = fields.filter(field => valueOf(start, field) !== undefined).slice(0, MAX_NOTED)
  if (!noted.length && !notes.length) return { problems, lines, notes: '' }
  const ruleLines = noted.map(field => `- ${label(field)}${field.label && field.label !== field.path ? `（${cleanPath(field.path)}）` : ''}：${[field.check, Number.isFinite(field.min) ? `范围 ${field.min} 到 ${field.max}` : ''].filter(Boolean).join('；') || '没写规则'}`)
  const changeLines = rounds.map((round, i) => {
    const moved = noted.flatMap(field => {
      const was = unwrap(valueOf(before[i], field))
      const now = unwrap(valueOf(round.state, field))
      return JSON.stringify(was) === JSON.stringify(now) ? [] : [`${label(field)} ${shortValue(was)}→${shortValue(now)}`]
    })
    return `- 第 ${i + 1} 回合：${moved.length ? moved.slice(0, 8).join('；') : '没变'}`
  })
  const text = [
    noted.length ? `变量和它的更新规则：\n${ruleLines.join('\n')}` : '',
    noted.length ? `每回合变量的变化（回合末的值）：\n${changeLines.join('\n')}` : '',
    notes.length ? `按数值触发的事件（时机程序查过了，看故事里是不是真的写到了；程序算不出的回合由你判断）：\n${notes.map(line => `- ${line}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return { problems, lines, notes: text }
}

/**
 * The story as the reader gets it, and what the card asks of it. `opening`: what the story opened on, which the rounds
 * go on from (without it a thing it set up read as a contradiction). `game`: the card plays by 游戏规则, its rolls and
 * fights played by the program, not written by the card.
 */
export function reviewRequest(card, rounds, { reply = '简体中文', rules = '', values = '', opening = '', game = false } = {}) {
  const story = rounds.map((round, i) => `【第 ${i + 1} 回合】\n玩家：${round.input}\n回复：${clip(round.told ?? round.shown, MAX_TEXT)}`).join('\n\n')
  // The values are the program's to count; whether they moved with the story, and whether an event came, are the reader's.
  const valueKinds = values
    ? `
- 数值：<变量和事件> 里写着每回合变量怎么变。按变量的更新规则和这一回合的剧情，该变没变、变得和剧情对不上、方向或幅度不合规则的，记下来，variable 写变量名。
- 事件：按数值触发的事件在发给模型的回合里有没有真的写进故事；没发的回合有没有提前写了；写过的有没有又写一遍。写着程序算不出条件的，按条件、变量和剧情判断它是不是来得太早或该来没来。variable 写事件名。`
    : ''
  const system = `你是互动小说的审读员。一张角色卡刚被试玩了 ${rounds.length} 回合，玩家是程序扮的，有些回合在故意试探。挑出读者才看得出的毛病，格式${values ? '、数值范围和类型' : '和变量'}程序已经查过了，不用管。

看这些：
- 抢话：替玩家说话、做决定、写玩家的内心。
- 出戏：人物不像自己，或者叙述跳出故事。
- 矛盾：和前文的时间、地点、数目、谁知道什么对不上；顺着玩家说的假话走。
- 放水：玩家做明显做不到或规矩不许的事，却轻易成功。
- 重复：句式、桥段、结尾的写法一再出现。${valueKinds}${opening ? `
- <开场> 是故事开头玩家看到的那段，前文从这里算起：开场里有的人物、东西和说法，后面再提不算矛盾。` : ''}${game ? `
- 回复里括号写的掷骰和战斗结果，是程序按游戏规则替玩家掷骰、自动打完的，不是卡写的：没让玩家选怎么打、打赢打输，都不算抢话或放水。故事和这个结果对不上（比如结果是全部击败，故事里却有人逃了）算矛盾。` : ''}

只记真的有的，拿不准就不记，最多 ${MAX_ISSUES} 条。没有毛病就让 issues 为空。fix 写这张卡该怎么改，不写这一局该怎么写。

只输出：
<review>{"summary": "用${reply}写一两句：这张卡玩起来怎么样", "issues": [{"round": 3, "kind": "抢话", ${values ? '"variable": "数值和事件写名字，别的留空", ' : ''}"what": "用${reply}写一句话", "quote": "回复原文，不超过 30 字", "fix": "用${reply}写一句话"}]}</review>`
  const content = [
    `<角色卡>\n名字：${card.name}\n${clip(String(card.description ?? ''), MAX_TEXT)}\n</角色卡>`,
    rules ? `<这张卡的规则>\n${clip(rules, MAX_TEXT)}\n</这张卡的规则>` : '',
    opening ? `<开场>\n${clip(opening, MAX_TEXT)}\n</开场>` : '',
    `<试玩记录>\n${story}\n</试玩记录>`,
    values ? `<变量和事件>\n${clip(values, MAX_TEXT * 2)}\n</变量和事件>` : '',
  ].filter(Boolean).join('\n\n')
  return { system, messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }
}

const KINDS = ['抢话', '出戏', '矛盾', '放水', '重复', '数值', '事件']

/** The reader's answer; null when it can't be read. */
export function readReview(text, rounds) {
  const json = looseJson(section(text, 'review') || text)
  if (!json || typeof json !== 'object') return null
  const issues = (Array.isArray(json.issues) ? json.issues : [])
    .filter(item => item && typeof item === 'object' && String(item.what ?? '').trim())
    .slice(0, MAX_ISSUES)
    .map(item => ({ ...item, what: String(item.what).trim(), variable: clip(String(item.variable ?? '').trim(), 40) }))
    .map(item => ({
      round: Math.min(Math.max(1, Math.floor(Number(item.round) || 1)), Math.max(1, rounds)),
      kind: KINDS.includes(item.kind) ? item.kind : '其他',
      // Which variable or event, in the line itself: it is what 检查这张卡 lists.
      what: clip(item.variable && !item.what.includes(item.variable) ? `「${item.variable}」${item.what}` : item.what, 200),
      quote: clip(String(item.quote ?? '').trim(), MAX_QUOTE),
      fix: clip(String(item.fix ?? '').trim(), 200),
    }))
  return { summary: clip(String(json.summary ?? '').trim(), 300), issues }
}

/** About what a run comes to, for the window to say before it starts. */
export function estimateRun(card, books, rounds) {
  const text = [card.description, card.personality, card.scenario, card.systemPrompt, greetingList(card)[0], ...constantEntries(books).map(entry => entry.content)].filter(Boolean).join('\n')
  const base = estimateTokens(text) + PRESET_TOKENS
  // The prompt grows as the story does.
  const replies = Array.from({ length: rounds }, (_, round) => base + round * GROWTH_TOKENS).reduce((sum, tokens) => sum + tokens, 0)
  // A card with variables gives the reader their rules and a line a round of what changed, in the same call.
  const rules = updateRules(books)
  const values = usesMvu(card, books) || valueEvents(books).length ? VALUE_BASE_TOKENS + rounds * VALUE_ROUND_TOKENS + estimateTokens(rules.map(rule => `${rule.path}${rule.check}`).join('\n')) : 0
  const review = estimateTokens(String(card.description ?? '').slice(0, MAX_TEXT)) + rounds * GROWTH_TOKENS + values
  return { input: replies + rounds * PLAYER_INPUT + review, output: rounds * (REPLY_TOKENS + PLAYER_OUTPUT) + REVIEW_OUTPUT }
}

// What is there every turn: the entries in the prefix and the ones sent late.
const standing = books => [...constantEntries(books), ...lateEntries(books)]

// What of a card a run plays with: a report made on other values of these may no longer hold.
const PLAYED = ['name', 'description', 'personality', 'scenario', 'firstMes', 'alternateGreetings', 'mesExample', 'systemPrompt', 'postHistoryInstructions', 'depthPrompt', 'book', 'regexScripts', 'statusBar', 'mvuSchema', 'userName', 'worldbookIds']

/** A short mark of the card as played, kept with the report to tell when the card has moved on since. */
export function playedMark(card) {
  return createHash('sha1').update(JSON.stringify(PLAYED.map(key => card[key] ?? null))).digest('hex').slice(0, 16)
}

/** Whether a report was made on the card as it is; a report from before marks were kept cannot tell, and counts as not. */
export const reportOutdated = (report, card) => !report?.mark || report.mark !== playedMark(card)

/**
 * A report's problems as 检查这张卡 lists them (from: 'trial'): what the program counted and what the reader found.
 * They carry no changes: a model can be asked for some (check-session.mjs), or they are fixed by hand or ignored.
 */
export function trialFindings(report, card) {
  if (!report) return []
  const outdated = reportOutdated(report, card)
  const idOf = text => `trial:${createHash('sha1').update(`${report.at}\n${text}`).digest('hex').slice(0, 10)}`
  const lines = (report.lines ?? []).filter(line => line.level !== 'ok').map(line => ({
    id: idOf(line.text), rule: 'trial', level: line.level === 'error' ? 'error' : 'warn', from: 'trial', title: line.text, why: '', changes: [], outdated,
  }))
  const issues = (report.issues ?? []).map(issue => ({
    id: idOf(`${issue.round}\n${issue.kind}\n${issue.what}`), rule: 'trial', level: 'warn', from: 'trial', title: issue.what, why: '', changes: [], outdated,
    round: issue.round, kind: issue.kind, quote: issue.quote ?? '', fix: issue.fix ?? '',
  }))
  return [...lines, ...issues]
}

/**
 * @param deps - from createForge: { store, engine, load, save, serial, run, jobs, removeFile, cutNote, rulebooks }
 */
export function createTrial({ store, engine, load, save, serial, run, jobs, removeFile, cutNote, rulebooks = null }) {
  const idOf = trialSessionId
  // The chat each running trial plays in: stopping has to reach the turn under way as well.
  const playing = new Map()

  async function loadTrial(cardId) {
    const card = await store.getCard(cardId)
    const session = await load(idOf(cardId)).catch(error => {
      if (error.status !== 404) throw error
      const now = new Date().toISOString()
      return { id: idOf(cardId), kind: 'card', cardId, createdAt: now, updatedAt: now, model: '', rounds: DEFAULT_ROUNDS, job: null, error: null, report: null }
    })
    session.cardName = card.name
    return { card, session }
  }

  async function view(card, session) {
    const job = jobs.get(session.id)
    const rounds = cleanRounds(session.rounds)
    const books = await booksForCard(store, card, await store.getSettings())
    const { input, output } = estimateRun(card, books, rounds)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    return {
      cardId: card.id,
      name: card.name,
      model: session.model ?? '',
      rounds,
      choices: TRIAL_ROUNDS,
      estimate: { ready, model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '', input, output, cost: ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output }) : null },
      job: job ? { step: job.step, startedAt: job.startedAt } : null,
      error: session.error ?? null,
      report: session.report ? { ...session.report, outdated: reportOutdated(session.report, card) } : null,
    }
  }

  /** What every round will be held to, from the card and the chat it is played in. */
  async function needsOf(card, chat) {
    const books = await booksForCard(store, card, await store.getSettings(), chat)
    const scripts = await chatScripts(store, chat)
    const events = valueEvents(books)
    // The list of what happened stays empty while nothing does: the events say whether it should have moved.
    const lists = new Set(events.filter(event => event.once).map(event => cleanPath(event.once.list)))
    const fields = ruledFields(card.statusBar?.fields ?? [], updateRules(books)).filter(field => !lists.has(cleanPath(field.path)))
    const book = await rulebooks?.read(card.id).catch(() => null)
    return {
      books,
      scripts,
      fields,
      events,
      book: rulesOn(book) ? book : null,
      needs: roundNeeds({ mvu: usesMvu(card, books), choices: asksChoices(chat), blocks: replyBlocks(standing(books), scripts), fields }),
      keyed: books.flatMap(book => book.entries).filter(entry => entry.enabled !== false && !entry.constant && entry.keys?.length).map(entry => entry.comment).filter(Boolean),
    }
  }

  /**
   * One round: the stand-in's line, and the reply to it. A reply that stops on a roll or a fight (游戏规则) is settled as
   * the player would with one button: the roll made, the fight played by 自动; the reply after it is the round's too.
   */
  async function round(ctx, chat, parent, input, { needs, scripts }) {
    const parts = []
    // The same story for the stand-in and the reader, with the roll in the engine's own line (the model's text stays Chinese).
    const told = []
    const problems = []
    const changes = []
    const triggered = new Set()
    const stops = []
    // Where each turn began, for the conditions it was sent on (engine.mjs buildPrompt): the reply before it with the
    // rules' writes on top, the chat's and the app's variables as they were (the first turn's chat ones are the round before's).
    const turns = []
    let vars = null
    let globals = (await store.getSettings()).globalVars ?? {}
    const tokens = { input: 0, output: 0 }
    let turn = await engine.runTurn(chat.id, { parentId: parent, input }, () => {})
    let node
    for (;;) {
      node = turn.chat.nodes[turn.nodeId]
      const asked = turn.chat.nodes[node.parent]
      turns.push({ from: asked?.parent, input: asked?.text ?? '', state: applyWrites(turn.chat.nodes[asked?.parent]?.state ?? {}, asked?.gameWrites), vars, globals })
      vars = turn.chat.frameVars ?? {}
      globals = (await store.getSettings()).globalVars ?? {}
      // The roll or the fight between the two replies: in the page's language for the report, as sent for the models.
      if (stops.length) {
        parts.push(stopLine(asked))
        told.push(`（${asked?.text ?? ''}）`)
      }
      // The page shows a reply without its marks.
      const shown = applyScripts(node.display ?? displayText(node.text), scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0 }).replace(/```html[\s\S]*?```/g, '').replace(/<StatusPlaceHolderImpl\/>/g, '').trim()
      parts.push(shown)
      told.push(shown)
      problems.push(...roundChecks({ text: node.text, shown, node }, node.gate ? stopNeeds(needs) : needs))
      changes.push(...(node.stateChanges ?? []))
      // By title: injected holds the entries' refs (book:uid), which no event or report line goes by.
      for (const title of asked?.injectedTitles ?? []) triggered.add(String(title))
      const usage = node.usage ?? {}
      tokens.input += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      tokens.output += usage.output ?? 0
      if (!node.gate || stops.length >= MAX_STOPS) break
      // The rules as the engine will read them for this turn: they may have been changed since the run began, and a fight
      // played on other rules does not replay. Rules turned off leave the stop as it is.
      const book = await rulebooks?.read(chat.cardId).catch(() => null)
      if (!rulesOn(book)) break
      stops.push(node.gate.kind)
      const game = node.gate.kind === 'battle' ? { settle: true, battle: autoFight(book, turn.chat, node) } : { settle: true }
      turn = await engine.runTurn(chat.id, { parentId: node.id, game }, () => {})
    }
    return {
      nodeId: node.id,
      entry: {
        input,
        shown: parts.filter(Boolean).join('\n\n'),
        told: told.filter(Boolean).join('\n\n'),
        problems,
        changes: [...new Set(changes)].slice(0, 12),
        triggered: [...triggered],
        state: node.state ?? {},
        turns,
        // The chat's own variables after the round: the next round's conditions read them.
        vars: turn.chat.frameVars ?? {},
        ...(stops.length ? { stops } : {}),
        tokens,
      },
    }
  }

  /**
   * The sandbox a turn's conditions ran in, opened as the engine opens a turn's (engine.mjs preparePrompt): the
   * @@preload helpers, the chat's variables as the turn found them, the story up to its input. A bare one would
   * call a condition on a helper or a chat variable unmet, and an event that came on time early.
   */
  async function sandboxOf(card, played, held, done) {
    const [preset, chat] = await Promise.all([presetFor(store, played.presetId), store.getChat(played.id)])
    return (state, i, j = 0) => {
      const turn = done[i].turns[j]
      return chatTemplates({
        names: played.names, card, preset, books: held.books, scripts: held.scripts, state,
        local: turn.vars ?? (i ? done[i - 1].vars : played.frameVars) ?? {},
        global: turn.globals,
        messages: [...storyPath(pathTo(chat, turn.from)).map(node => ({ role: node.role, text: node.text ?? '' })), { role: 'user', text: turn.input }],
      })
    }
  }

  async function trialWork(ctx, cardId, rounds) {
    // A card saved before schemas were kept gets one on its first turn: filled in first, the mark is of the card as played.
    // Only filled in: checking an empty state against the schema would log a false error.
    await engine.cardWithSchema(cardId)
    const card = await store.getCard(cardId)
    const { session } = await loadTrial(cardId)
    // One left behind by a run the app did not live through.
    for (const old of await store.listChats(cardId)) if (old.trial) await store.deleteChat(old.id).catch(() => {})
    const chat = await createChat(store, cardId, 0)
    playing.set(cardId, chat.id)
    try {
      await store.withChat(chat.id, async () => {
        const fresh = await store.getChat(chat.id)
        fresh.trial = true
        fresh.title = msg`试玩体检：${card.name}`
        if (session.model) fresh.model = session.model
        await store.saveChat(fresh)
      })
      const played = await store.getChat(chat.id)
      const held = await needsOf(card, played)
      const opening = Object.values(played.nodes).find(node => node.role === 'assistant')
      const start = opening?.state ?? {}
      const form = String(opening?.text ?? '').includes(CREATION_TAG) ? creationOf(card.regexScripts) : null
      const story = [{ you: '', reply: displayText(opening?.text ?? '') }]
      const done = []
      const intents = INTENT_ORDER[rounds] ?? INTENT_ORDER[DEFAULT_ROUNDS]
      let tip = opening.id
      let stopped = false
      for (let i = 0; i < rounds; i++) {
        if (ctx.signal.aborted) {
          stopped = true
          break
        }
        ctx.step(`round:${i + 1}:${rounds}:player`)
        // A card that opens on a form starts by filling it in, as a player would.
        const said = i === 0 && form ? { text: randomSheet(form) } : await ctx.call(playerRequest(card, story, intents[i]))
        const input = playerLine(said.text)
        if (!input) throw new Error(msg`${ctx.label} 没有写出玩家的话${cutNote(said)}，再试一次，或者换个模型`)
        ctx.step(`round:${i + 1}:${rounds}:reply`)
        const { nodeId, entry } = await round(ctx, played, tip, input, held).catch(error => {
          if (ctx.signal.aborted) stopped = true
          if (ctx.signal.aborted && done.length) return {}
          throw error
        })
        if (!entry) break
        tip = nodeId
        done.push({ ...entry, intent: intents[i] })
        story.push({ you: input, reply: entry.told })
      }
      if (!done.length) throw httpError(499, msg`已停止`)
      // Each round's state, against the events that wait on it and the card's update rules.
      const values = held.needs.update || held.events.length ? valueChecks(done, { start, fields: held.fields, events: held.events, sandbox: await sandboxOf(card, played, held, done) }) : { problems: [], lines: [], notes: '' }
      values.problems.forEach((found, i) => done[i].problems.push(...found))
      let read = null
      if (!stopped && !ctx.signal.aborted) {
        ctx.step('review')
        const rules = standing(held.books).filter(entry => /每轮|规则|rule/i.test(entry.comment ?? '')).map(entry => entry.content).join('\n')
        const answer = await ctx.call(reviewRequest(card, done, { reply: ctx.languages.reply, rules, values: values.notes, opening: story[0].reply, game: Boolean(held.book) }))
        read = readReview(answer.text, done.length)
      }
      const lines = [...summaryLines(done, { needs: held.needs, fields: held.fields, start, keyed: held.keyed, ruled: Boolean(held.book) }), ...values.lines]
      await ctx.update(fresh => {
        fresh.report = {
          at: new Date().toISOString(),
          mark: playedMark(card),
          model: ctx.label,
          asked: rounds,
          stopped,
          lines,
          summary: read?.summary ?? '',
          issues: read?.issues ?? [],
          unread: !stopped && !read,
          rounds: done.map(({ state, told, turns, vars, ...entry }) => entry),
          tokens: done.reduce((sum, entry) => ({ input: sum.input + entry.tokens.input, output: sum.output + entry.tokens.output }), { input: 0, output: 0 }),
        }
      })
    } finally {
      playing.delete(cardId)
      engine.stop(chat.id)
      await store.deleteChat(chat.id).catch(() => {})
    }
  }

  const change = (cardId, fn) =>
    serial(idOf(cardId), async () => {
      const { card, session } = await loadTrial(cardId)
      const out = await fn(card, session)
      await save(session)
      return out ?? view(card, session)
    })

  return {
    async trialGet(cardId) {
      const { card, session } = await loadTrial(cardId)
      return view(card, session)
    },

    /** The model to play on, and how many rounds. */
    trialUpdate(cardId, { model, rounds } = {}) {
      return change(cardId, (_, session) => {
        if (typeof model === 'string') session.model = model.trim().slice(0, 200)
        if (rounds !== undefined) session.rounds = cleanRounds(rounds)
      })
    },

    /** Play it: sent only by this, after the window has said about how much. */
    async trialRun(cardId) {
      const key = idOf(cardId)
      const session = await serial(key, async () => {
        if (jobs.has(key)) throw httpError(409, msg`这张卡正在试玩，等它玩完或先停下`)
        return (await loadTrial(cardId)).session
      })
      const rounds = cleanRounds(session.rounds)
      await run(session, 'trial', ctx => trialWork(ctx, cardId, rounds))
      const { card, session: fresh } = await loadTrial(cardId)
      return view(card, fresh)
    },

    trialStop(cardId) {
      const job = jobs.get(idOf(cardId))
      job?.controller.abort()
      if (playing.has(cardId)) engine.stop(playing.get(cardId))
      return { stopped: Boolean(job) }
    },

    trialRunning: cardId => jobs.has(idOf(cardId)),

    /** A deleted card's goes with it. */
    async dropTrial(cardId) {
      jobs.get(idOf(cardId))?.controller.abort()
      await removeFile(idOf(cardId))
    },
  }
}
