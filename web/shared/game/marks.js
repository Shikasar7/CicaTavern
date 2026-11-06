// 游戏规则的标记: what the model writes for the rules, in the 【类别|值】 form the 视觉小说 marks use.
//   【检定|灵巧|DC12】              a roll: at the end of a reply, or at the end of an action choice
//   【检定|灵巧|DC12|绳索】          with a thing that helps, if the player has it
//   【检定|心智|DC12|需要:铜钥匙】    with a thing it cannot be done without
//   【战斗|灰狼×2:杂兵|狼王:精英】   a fight: at the end of a reply (no way round it), or of an action choice (the player's to take)
//   【战斗|魔修长老:精英:远强】       how strong a foe is, after its tier: a word beside the player, or a rank of the card's
//   【获得|铜钥匙×1】 【失去|伞】     things
//   【任务|新|标题|一句话】 【任务|完成|标题】 【任务|失败|标题】
//   【受伤|轻】 【恢复|中】           life outside a fight (轻 中 重)
//   【学会|技能名】
//   【异常|扭伤左脚|灵巧|中】 【异常|解除|扭伤左脚】   what holds the player back, on one attribute or all of them (轻 中 重)
//   【晋升|筑基】                    the player has risen to a rank of the card's
//   【理智|中】 【理智|回复|轻】       the mind shaken or calmed, on a card that counts it (轻 中 重)
// A mark that makes no sense stays in the text as it was: it may be the card's own. Numbers are never
// the model's: it writes sizes and names, and the rules work out the rest.
import { clampDc } from './dice.js'
import { otherChoices } from '../basic.js'

// Models do write them in the wrong brackets (<检定|灵巧|DC12>): the page would swallow that as a tag, and the story would
// stop with nothing to do. The kind and the bar are what tell it from anything else.
const MARK = /(?:\*\*)?[【<\[［〖〔]\s*(检定|战斗|获得|失去|任务|受伤|恢复|学会|异常|晋升|理智)\s*[|｜]\s*([^【】<>\[\]［］〖〗〔〕\n]{0,80}?)\s*[】>\]］〗〕](?:\*\*)?/g
// Where a mark is not the story's: the model's thinking, the update blocks, the action choices.
const SEALED = /<(think|thinking|reasoning|choices|UpdateVariable|state)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
const KEYCAP_LINE = /^[ \t]*[1-9]️?⃣.*$/gm
const DC = /^(?:DC|难度)?\s*[:：=]?\s*(\d{1,3})$/i
const COUNTED = /^(.+?)\s*[×xX*＊]\s*(\d{1,4})$/
const FOE = /^(.+?)\s*[:：]\s*(.*)$/
const NEEDS = /^(?:需要|必须|必需)\s*[:：]\s*(.+)$/
const BONUS = /\s*[+＋]\s*\d+$/
const OPTION_LABEL = /^\s*(?:[-*•]\s*)?(?:[A-Ia-i1-9①-⑨][.、．:：)）]\s*|[1-9]\ufe0f?\u20e3\s*)/
const QUEST = { 新: 'new', 完成: 'done', 失败: 'failed' }
const SIZE = { 轻: 'light', 中: 'medium', 重: 'heavy' }
const TIERS = { 杂兵: 'minion', 普通: 'normal', 精英: 'elite', 首领: 'boss' }

const DEFAULT_DC = 12
const MAX_FOES = 4
const MAX_COUNT = 99
const fieldsOf = body => body.split(/[|｜]/).map(field => field.trim())
const clip = text => text.slice(0, 40)

/** '铜钥匙×2' → { name, count }; a count that makes no sense is 1. */
function counted(text) {
  const match = COUNTED.exec(text)
  const count = match ? Math.min(MAX_COUNT, Number(match[2])) : 1
  return { name: clip(match ? match[1].trim() : text), count: count >= 1 ? count : 1 }
}

function readFoes(body) {
  const foes = []
  let left = MAX_FOES
  for (const field of body.split(/[|｜,，、]/)) {
    const part = field.trim()
    if (!part || !left) continue
    const tiered = FOE.exec(part)
    const { name, count } = counted(tiered ? tiered[1].trim() : part)
    if (!name) continue
    const taken = Math.min(count, left)
    left -= taken
    const words = (tiered?.[2] ?? '').split(/[:：]/).map(word => word.trim()).filter(Boolean)
    const tier = words.find(word => TIERS[word])
    const power = words.find(word => word !== tier)
    foes.push({ name, count: taken, tier: TIERS[tier] ?? 'normal', ...(power ? { power: clip(power) } : {}) })
  }
  return foes
}

/** One mark as data, or null when it makes no sense. */
function readMark(kind, body) {
  const fields = fieldsOf(body)
  if (kind === '检定') {
    const dcField = fields.find(field => DC.test(field))
    const [stat = '', ...rest] = fields.filter(field => field && field !== dcField)
    const item = rest.find(field => !NEEDS.test(field))?.replace(BONUS, '').trim()
    const needs = rest.map(field => NEEDS.exec(field)?.[1].trim()).find(Boolean)
    return { kind: 'check', stat: clip(stat), dc: dcField ? clampDc(Number(DC.exec(dcField)[1])) : DEFAULT_DC, ...(item ? { item: clip(item) } : {}), ...(needs ? { needs: clip(needs) } : {}) }
  }
  if (kind === '战斗') {
    const foes = readFoes(body)
    return foes.length ? { kind: 'battle', foes } : null
  }
  if (kind === '获得' || kind === '失去') {
    const { name, count } = counted(fields[0])
    return name ? { kind: kind === '获得' ? 'gain' : 'lose', name, count } : null
  }
  if (kind === '任务') {
    const status = QUEST[fields[0]]
    return status && fields[1] ? { kind: 'quest', status, title: clip(fields[1]), note: (fields[2] ?? '').slice(0, 120) } : null
  }
  if (kind === '受伤' || kind === '恢复') return { kind: kind === '受伤' ? 'hurt' : 'heal', size: SIZE[fields[0]] ?? 'light' }
  if (kind === '晋升') return fields[0] ? { kind: 'promote', name: clip(fields[0]) } : null
  if (kind === '理智') return { kind: 'sanity', back: fields.includes('回复'), size: SIZE[fields.find(field => SIZE[field])] ?? 'light' }
  if (kind === '异常') {
    if (fields[0] === '解除') return fields[1] ? { kind: 'mend', name: clip(fields[1]) } : null
    const size = fields.slice(1).find(field => SIZE[field])
    return fields[0] ? { kind: 'ail', name: clip(fields[0]), stat: fields.slice(1).find(field => field && field !== size) ?? '', size: SIZE[size] ?? 'light' } : null
  }
  return fields[0] ? { kind: 'learn', name: clip(fields[0]) } : null
}

const blank = text => text.replace(/[^\n]/g, ' ')

/** The text with everything that is not the story blanked out, so places in it are places in the text. */
function storyOnly(source) {
  const open = source.replace(SEALED, blank).replace(KEYCAP_LINE, blank)
  const { choices } = otherChoices(open)
  if (!choices.length) return open
  return open.split('\n').map(line => (choices.some(choice => line.includes(choice)) ? blank(line) : line)).join('\n')
}

function storyMarks(text) {
  const source = String(text ?? '')
  const marks = []
  for (const match of storyOnly(source).matchAll(MARK)) {
    const mark = readMark(match[1], match[2])
    if (mark) marks.push({ mark, start: match.index, end: match.index + match[0].length })
  }
  return { source, marks }
}

const GATES = ['check', 'battle']
const isGate = mark => GATES.includes(mark.kind)

/** What this reply stops on: its first 【检定】 or 【战斗】 in the story, or null. */
export function gateOf(text) {
  return storyMarks(text).marks.find(item => isGate(item.mark))?.mark ?? null
}

/**
 * A reply cut after the mark it stops on: what the model wrote past it is not kept. → { text, gate }
 * @param kinds - the stops that count this turn; any other mark of the kind is left to fall out of what is shown.
 */
export function cutAtGate(text, kinds = GATES) {
  const { source, marks } = storyMarks(text)
  const found = marks.find(item => kinds.includes(item.mark.kind))
  return found ? { text: source.slice(0, found.end).trimEnd(), gate: found.mark } : { text: source, gate: null }
}

/** What the reply's story changes: the marks that are not a stop. */
export function replyMarks(text) {
  return storyMarks(text).marks.map(item => item.mark).filter(mark => !isGate(mark))
}

/**
 * Where a reply's first change comes (a thing gained, a wound, a quest): the last line of the story before it, the
 * marks left out. '' for a reply that opens on one, null for one with none.
 */
export function changeWords(text) {
  const { source, marks } = storyMarks(text)
  const first = marks.find(item => !isGate(item.mark))
  if (!first) return null
  return withoutGameMarks(source.slice(0, first.start)).split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? ''
}

/** An action choice as shown and sent, with the roll or the fight it asks for. */
export function parseChoice(text) {
  let check = null
  let fight = null
  const rest = String(text ?? '').replace(MARK, (whole, kind, body) => {
    const mark = readMark(kind, body)
    if (!mark) return whole
    if (mark.kind === 'check') check ??= mark
    if (mark.kind === 'battle') fight ??= mark
    return ''
  })
  return { text: rest.trim(), check, ...(fight ? { fight } : {}) }
}

/** What a reply's action choices ask for, by the choice's text as shown. */
function choiceMarks(text, kind) {
  const found = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const choice = parseChoice(line)
    if (choice[kind]) found.set(choice.text.replace(OPTION_LABEL, '').trim(), choice[kind])
  }
  return found
}

/** The rolls of a reply's choices. Every line is looked at, so a card's own options count as well as the <choices> of the built-in presets. */
export const choiceChecks = text => choiceMarks(text, 'check')

/** The fights of a reply's choices, the same way. */
export const choiceFights = text => choiceMarks(text, 'fight')

/** The text without the marks; a line that held nothing else goes with them. */
export function withoutGameMarks(text) {
  return String(text ?? '').split('\n').flatMap(line => {
    const rest = line.replace(MARK, (whole, kind, body) => (readMark(kind, body) ? '' : whole))
    return rest === line ? [line] : rest.trim() ? [rest.trimEnd()] : []
  }).join('\n')
}
