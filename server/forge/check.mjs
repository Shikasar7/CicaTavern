// 角色卡自检: what the program can tell about a saved card, for free, the moment its window opens. Each finding says
// what is wrong in plain words and, when the fix is mechanical, carries it as the changes 对话修改 proposes (edit.mjs,
// book-edit.mjs, regex-edit.mjs), so the same before-and-after shows it and the same code takes it in
// (check-apply.mjs). A card made elsewhere is rarely wrong: most of what comes up is worth a look, not an error.
//
// A finding: { id, rule, level, from: 'program', title, why, changes, where?, manual?, risky? }
//   level: error (does not work as written), warn (may not do what was meant), tip (works, could be better)
//   manual: there is no fix to take; `changes` holds the piece, to write one by hand
//   risky: it changes how the card plays, so it is not ticked for 一键采用
import YAML from 'yaml'
import { CARD_FIELDS, greetingList } from '../../web/shared/card-edit.js'
import { PLACEMENT, effectOf, regexFromString } from '../../web/shared/regex.js'
import { BRICKS, autoStatusSpec, cleanStatusSpec, joinPath } from '../../web/shared/status.js'
import { getPath, splitPath } from '../../web/shared/vars.js'
import { estimateTokens } from '../context.mjs'
import { helperSummary } from '../helper-scripts.mjs'
import { msg } from '../i18n.mjs'
import { usesMvu } from '../mvu.mjs'
import { keepToSchema } from '../schema.mjs'
import { decoratorsOf, hasTemplate, splitDecorators, templateSyntaxError } from '../template.mjs'
import { EXTENSIBLE_MARK, entryText, initialState, inPrefix, isConstant, isDynamic, isInitvar } from '../worldbook.mjs'
import { DICE_TOKEN, JUDGE, KEPT_DEPTH, RULE_TAGS, SELF_CHECK, WORLD_TOKEN, diceLine, diceScript, eventLine, eventScript, eventToken, judgeScripts, readDraw, selfCheckScripts, tokenFind, worldLine, worldMoveScript } from './bricks.mjs'
import { CREATION_TAG, creationOf } from './creation.mjs'
import { onOf } from './regex-edit.mjs'
import { INIT_BLOCK, madeHere } from './st-export.mjs'
import { ownWords } from './prompts.mjs'
import { eventItem, eventsDone, notHappened, onceMarked } from './write.mjs'

// Past these a card costs more than it needs to on every chat (固定前缀 is cached, what is sent each turn is not).
const HEAVY_PREFIX = 30_000
const HEAVY_TURN = 20_000
const BIGGEST_SHOWN = 5
const MAX_FRAME_PATHS = 40

const OLD_ENTRY = /废弃|弃用|deprecated|obsolete/i
// How a card writes its variables if not by update blocks.
const SETS_ITSELF = /setvar|setchatvar|setglobalvar|setmessagevar/i
// An example's stand-ins, not a variable: 角色.${名字}, 物品名, a.b[0]…
const STAND_IN = /[[\]{}<>$*…]|\.\.\.|x{2,}|路径|变量名|名字|名称|某|npc/i
const UPDATE_CALL = /_\.(set|add|insert|delete|remove|assign)\(\s*(['"`])(.+?)\2/g
const PATCH_OP = /\{[^{}]*"path"\s*:\s*"(\/[^"]+)"[^{}]*\}/g
const VAR_READ = /(?:get|format)_message_variable::stat_data\.([^}\s]+)\s*\}\}|getvar\(\s*['"`]stat_data\.([^'"`]+)['"`]/g
const JOINED_KEY = /[、，；;]/
const PATTERN_KEY = /^\/(.+)\/([a-z]*)$/s
const SEPARATOR_NAME = /^[-=—_*#~·\s]*$/
const BROKEN_MACRO = /(?<!\{)\{\s*(char|user)\s*\}\}|\{\{\s*(char|user)\s*\}(?!\})/gi
const UPDATE_TAG = /update(?:variable)?/i

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nameOf = entry => entry.comment || msg`未命名条目`
export const scriptName = script => script.scriptName || script.findRegex.slice(0, 24)
const pathKey = keys => keys.join('\u0000')

const finding = (rule, target, level, title, why, changes = [], more = {}) => ({ id: `${rule}:${target}`, rule, level, from: 'program', title, why, changes, ...more })

/** An entry as a change; `keysNow`, the keywords it has, for the box to write new ones in. */
export const entryChange = (entry, change = {}) => ({ id: `entry:${entry.uid}`, kind: 'entry', uid: entry.uid, title: entry.comment, constant: entry.constant, keysNow: entry.keys, before: entry.content, after: entry.content, ...change })

/** A script as a change that leaves it as it is until `change` says otherwise (regex-edit.mjs readRegexEdit). */
export const scriptChange = (script, change = {}) => ({
  id: `regex:${script.id}`, kind: 'regex', sid: script.id, title: scriptName(script), on: onOf(script), effect: effectOf(script),
  findBefore: script.findRegex, findAfter: script.findRegex, replaceBefore: script.replaceString, replaceAfter: script.replaceString, ...change,
})

/** A script a brick wrote (bricks.mjs) as a change that adds it. */
export const newScript = (script, more = {}) => ({
  id: `new:${script.id}`, kind: 'newRegex', name: script.scriptName, on: onOf(script), effect: effectOf(script), find: script.findRegex, replace: script.replaceString,
  ...(script.placement.includes(PLACEMENT.WORLD_INFO) ? { world: true } : {}), ...(script.minDepth === null ? {} : { minDepth: script.minDepth }), ...more,
})

const themeNames = () => ({ paper: msg`纸张`, neon: msg`霓虹`, pastel: msg`柔和`, ink: msg`水墨`, parchment: msg`羊皮卷`, gothic: msg`暗夜`, terminal: msg`终端`, ocean: msg`深海` })

/** A layout in lines, as a change's before and after read: all of it, a change gone out of date is told by these. */
export function statusLines(spec) {
  if (!spec) return ''
  const { palette } = spec
  const head = [
    spec.title ? `${msg`标题`}: ${spec.title}` : '',
    spec.theme ? `${msg`主题`}: ${themeNames()[spec.theme] ?? spec.theme}` : '',
    palette ? `${msg`配色`}: ${msg`背景`} ${palette.bg} · ${msg`文字`} ${palette.ink} · ${msg`强调`} ${palette.accent}` : '',
  ].filter(Boolean)
  return [...head, ...spec.fields.map(field => `${field.label || field.path} (${field.path}): ${field.show}${field.page ? ` · ${msg`页`}: ${field.page}` : ''}`)].join('\n')
}

export const statusChange = (before, after, more = {}) => ({ id: 'statusBar', kind: 'statusBar', spec: after, before: statusLines(before), after: statusLines(after), ...more })

/**
 * What the checks read of a card, worked out once.
 * @param helpers - the scripts its file carries ({ name, content }; helperScriptsOf), null when it was not read.
 */
function factsOf(card, helpers = null) {
  const entries = card.book?.entries ?? []
  const books = card.book ? [card.book] : []
  const live = entries.filter(entry => entry.enabled !== false)
  const initvars = entries.filter(isInitvar)
  const state = initialState(books)
  const scripts = Array.isArray(card.regexScripts) ? card.regexScripts : []
  // A schema (read at import, or from the file of a card imported before that) fills in what the entries leave out.
  const schema = card.mvuSchema || helpers?.find(script => /registerMvuSchema/.test(String(script.content ?? '')))?.content || ''
  const known = schema ? filledBySchema(schema, state) : state
  const made = madeHere(card, helpers)
  // One loaded from elsewhere cannot be read, and a card with scripts that were not read may have one (创作角色卡 writes none).
  const unknownSchema = !schema && ((card.helperScripts > 0 && !helpers && !made) || Boolean(helpers?.some(script => /zod|schema|变量结构/i.test(String(script.name ?? '')))))
  const texts = [card.description, card.systemPrompt, card.postHistoryInstructions, ...live.filter(entry => !isInitvar(entry)).map(entry => entry.content)].filter(Boolean)
  return { card, entries, live, initvars, state, known, scripts, texts, made, bricks: bricksOf(card), schema: Boolean(schema) || unknownSchema, mvu: usesMvu(card, books), variables: Object.keys(known).length > 0 }
}

function filledBySchema(source, state) {
  try {
    return keepToSchema(source, state).state ?? state
  } catch {
    return state
  }
}

/** `root` has every key of a path. */
function holds(root, keys) {
  let cursor = root
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) return false
    cursor = cursor[key]
  }
  return true
}

const valueAt = (root, keys) => keys.reduce((cursor, key) => (cursor === null || typeof cursor !== 'object' ? undefined : cursor[key]), root)

/** The paths the card's rules name: { keys, adds (it says a new item goes there) }. */
function namedPaths(texts) {
  const found = new Map()
  const note = (keys, more = {}) => {
    if (!keys.length || keys.some(key => STAND_IN.test(key))) return
    found.set(pathKey(keys), { keys, ...found.get(pathKey(keys)), ...more })
  }
  const dotted = path => splitPath(path.replace(/^stat_data\./, ''))
  for (const text of texts) {
    for (const [, verb, , path] of text.matchAll(UPDATE_CALL)) note(dotted(path), verb === 'insert' || verb === 'assign' ? { adds: true } : {})
    for (const [whole, path] of text.matchAll(PATCH_OP)) {
      const keys = splitPath(path)
      const op = /"op"\s*:\s*"(\w+)"/.exec(whole)?.[1]
      if (op === 'add') note(keys.slice(0, -1), { adds: true })
      else if (op === 'replace') note(keys)
    }
    for (const [, one, two] of text.matchAll(VAR_READ)) note(dotted(one ?? two))
  }
  return [...found.values()]
}

/** An object each of whose items is an object: people, places, things by name, that a story may add to. */
const isDictionary = value => isRecord(value) && Object.entries(value).filter(([key]) => !key.startsWith('$')).every(([, item]) => isRecord(item))

function emptyContainers(value, keys = []) {
  if (Array.isArray(value)) return value.length ? [] : [keys]
  if (!isRecord(value)) return []
  const inside = Object.entries(value).filter(([key]) => !key.startsWith('$'))
  if (!inside.length) return keys.length ? [keys] : []
  return inside.flatMap(([key, item]) => emptyContainers(item, [...keys, key]))
}

function mayGrow(root, keys) {
  const value = valueAt(root, keys)
  // An object above may say so for all it holds.
  if (keys.some((_, i) => valueAt(root, keys.slice(0, i))?.$meta?.recursiveExtensible === true)) return true
  if (Array.isArray(value)) return value.some(item => item === EXTENSIBLE_MARK || (isRecord(item) && item.$arrayMeta === true))
  return value?.$meta?.extensible === true
}

const parsedInit = entry => {
  try {
    const value = YAML.parse(entryText(entry))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** YAML with `targets` (paths in it) marked as able to grow, comments kept; null when it cannot be read that way. */
function markedYaml(text, targets) {
  const doc = YAML.parseDocument(text)
  if (doc.errors.length) return null
  for (const keys of targets) {
    const node = doc.getIn(keys, true)
    if (YAML.isMap(node)) node.items.unshift(doc.createPair('$meta', { extensible: true }))
    else if (YAML.isSeq(node)) node.add(EXTENSIBLE_MARK)
    else return null
  }
  return doc.toString({ lineWidth: 0 }).trimEnd()
}

/** An entry's text with `targets` marked. */
function markedText(entry, targets) {
  const { body } = splitDecorators(entry.content)
  if (hasTemplate(entry.content)) return null
  const text = markedYaml(body, targets)
  return text === null ? null : `${entry.content.slice(0, entry.content.length - body.length)}${text}`
}

/** An opening's own starting values with `targets` marked. */
const markedOpening = (text, block, targets) => {
  const marked = markedYaml(block, targets)
  return marked === null ? null : text.replace(INIT_BLOCK, () => `<initvar>\n${marked}\n</initvar>`)
}

/** Every list in a state: on a card 创作角色卡 made, they are all there to grow (write.mjs startingValue). */
function listPaths(value, keys = []) {
  if (Array.isArray(value)) return [keys]
  if (!isRecord(value)) return []
  return Object.entries(value).filter(([key]) => !key.startsWith('$')).flatMap(([key, item]) => listPaths(item, [...keys, key]))
}

/** The 册子 the rules name: `type: book` under its path (write.mjs rulesEntry). */
function booksInRules(texts) {
  const out = []
  const walk = (value, keys) => {
    if (!isRecord(value)) return
    if (value.type === 'book') out.push(keys)
    else for (const [key, item] of Object.entries(value)) walk(item, [...keys, key])
  }
  for (const text of texts.filter(item => /type:\s*book\b/.test(item))) {
    try {
      for (const value of Object.values(YAML.parse(text) ?? {})) walk(value, [])
    } catch {
      continue
    }
  }
  return out
}

// ─── Format ───────────────────────────────────────────────────────────────

function regexFindings({ scripts }) {
  const out = []
  for (const script of scripts) {
    if (script.disabled) continue
    const pattern = regexFromString(script.findRegex)
    const name = scriptName(script)
    if (!pattern) {
      out.push(finding('regex-invalid', script.id, 'error', msg`正则「${name}」写错了，不起作用`, msg`查找的表达式读不出来，多半是括号没配对。改好之前这条什么也不做。`, [scriptChange(script)], { where: name, manual: true }))
      continue
    }
    if (/<script/i.test(script.replaceString)) continue
    const groups = new RegExp(`${pattern.source}|`, pattern.flags.replace(/[gy]/g, '')).exec('').length - 1
    const used = Math.max(0, ...[...script.replaceString.matchAll(/\$(\d)/g)].map(match => Number(match[1])))
    if (used > groups) out.push(finding('regex-group', script.id, 'warn', msg`正则「${name}」用了不存在的捕获组`, msg`替换内容写了 $${used}，查找的表达式只有 ${groups} 组括号，那一处会原样显示。`, [scriptChange(script)], { where: name, manual: true }))
  }
  return out
}

function keyFindings({ live }) {
  const out = []
  for (const entry of live) {
    if (entry.constant || isInitvar(entry)) continue
    const name = nameOf(entry)
    const joined = entry.keys.filter(key => !PATTERN_KEY.test(key) && JOINED_KEY.test(key) && key.split(JOINED_KEY).filter(part => part.trim()).length > 1)
    if (joined.length) {
      const keys = [...new Set(entry.keys.flatMap(key => (joined.includes(key) ? key.split(JOINED_KEY).map(part => part.trim()).filter(Boolean) : [key])))]
      out.push(finding('key-joined', entry.uid, 'error', msg`「${name}」几个关键词连成了一个`, msg`「${joined[0]}」是一整串，只有这串字原样出现才触发，等于永远不触发。分开后每个词都能触发。`, [entryChange(entry, { keys })], { where: name }))
    }
    for (const key of entry.keys) {
      const match = PATTERN_KEY.exec(key)
      if (!match) continue
      try {
        new RegExp(match[1], match[2])
      } catch {
        out.push(finding('key-invalid', `${entry.uid}:${key}`, 'error', msg`「${name}」有个关键词写错了`, msg`「${key}」是正则写法，但读不出来，这个词不会触发。`, [entryChange(entry)], { where: name, manual: true }))
      }
    }
    const wide = entry.keys.filter(key => !PATTERN_KEY.test(key) && [...key.trim()].length === 1)
    if (wide.length) {
      const rest = entry.keys.filter(key => !wide.includes(key))
      out.push(finding('key-single', entry.uid, 'tip', msg`「${name}」的关键词只有一个字`, msg`「${wide.join(msg`、`)}」太宽，聊到别的事也会触发，白白占上下文。`, [entryChange(entry, rest.length ? { keys: rest } : {})], { where: name, risky: true, ...(rest.length ? {} : { manual: true }) }))
    }
  }
  return out
}

function entryFindings({ live, texts }) {
  const out = []
  const scripted = texts.join('\n')
  // Read by name from another entry's template, it needs no keywords.
  const readByName = entry => entry.comment && /getwi|activewi|getWorldInfo|activateWorldInfo/i.test(scripted) && scripted.includes(entry.comment)
  for (const entry of live) {
    const name = nameOf(entry)
    if (isInitvar(entry)) continue
    if (hasTemplate(entry.content)) {
      const error = templateSyntaxError(splitDecorators(entry.content).body)
      if (error) out.push(finding('template-syntax', entry.uid, 'error', msg`「${name}」的模板写错了`, msg`模板读不出来（${error}），这条发给模型时会出问题。`, [entryChange(entry)], { where: name, manual: true }))
    }
    if (!entry.content.trim()) {
      if (!SEPARATOR_NAME.test(entry.comment)) out.push(finding('entry-empty', entry.uid, 'tip', msg`「${name}」是空的`, msg`这条没有内容，不起作用。`, [{ id: `remove:${entry.uid}`, kind: 'removeEntry', uid: entry.uid, title: entry.comment, constant: entry.constant, before: entry.content }], { where: name, risky: true }))
      continue
    }
    if (!entry.constant && !entry.keys.length && !decoratorsOf(entry.content).size && !readByName(entry)) {
      const short = entry.comment && [...entry.comment].length >= 2 && [...entry.comment].length <= 12 && !/[【】[\]：:]/.test(entry.comment)
      out.push(finding('entry-unreachable', entry.uid, 'warn', msg`「${name}」永远不会发送`, msg`它不是常驻，也没有关键词，别的条目也没有读它。${short ? msg`可以用条目名当关键词。` : msg`写几个故事里真会出现的词当关键词。`}`, [entryChange(entry, short ? { keys: [entry.comment] } : {})], { where: name, risky: true, ...(short ? {} : { manual: true }) }))
    }
  }
  return out
}

function greetingFindings({ card }) {
  const greetings = greetingList(card)
  const change = (index, after) => ({ id: `greeting:${index}`, kind: 'greeting', index, before: greetings[index] ?? '', after })
  if (!greetings.some(text => text.trim())) return [finding('no-greeting', 'card', 'warn', msg`这张卡没有开场白`, msg`新对话没有开头，要玩家先说话。`, [change(0, '')], { manual: true })]
  const out = []
  greetings.forEach((text, index) => {
    const label = msg`第 ${index + 1} 段开场白`
    const opens = (text.match(/<UpdateVariable>/gi) ?? []).length
    const closes = (text.match(/<\/UpdateVariable>/gi) ?? []).length
    if (opens > closes) out.push(finding('greeting-unclosed', index, 'warn', msg`${label}的变量块没有写完`, msg`<UpdateVariable> 没有收尾，后面的正文可能被当成变量块藏起来。`, [change(index, `${text.trimEnd()}\n</UpdateVariable>`)], { where: label }))
    if (hasTemplate(text)) {
      const error = templateSyntaxError(text)
      if (error) out.push(finding('template-syntax', `greeting-${index}`, 'error', msg`${label}的模板写错了`, msg`模板读不出来（${error}）。`, [change(index, text)], { where: label, manual: true }))
    }
  })
  return out
}

const fieldLabels = () => ({ name: msg`名字`, description: msg`描述`, personality: msg`性格`, scenario: msg`场景`, mesExample: msg`对话示例`, systemPrompt: msg`系统提示`, postHistoryInstructions: msg`每轮都要遵守`, depthPrompt: msg`角色备注`, creatorNotes: msg`创作者备注`, creator: msg`作者` })

function macroFindings({ card, live }) {
  const fix = text => text.replace(BROKEN_MACRO, (_, one, two) => `{{${(one ?? two).toLowerCase()}}}`)
  const broken = text => !/<%/.test(text) && fix(text) !== text
  const note = where => [msg`${where}有写坏的 {{char}} 或 {{user}}`, msg`括号少了一个，发给模型时不会换成名字。`]
  const out = []
  for (const { key } of CARD_FIELDS) {
    const text = String(card[key] ?? '')
    if (!broken(text)) continue
    const [title, why] = note(fieldLabels()[key])
    out.push(finding('macro-broken', `field-${key}`, 'warn', title, why, [{ id: `field:${key}`, kind: 'field', key, before: text, after: fix(text) }]))
  }
  greetingList(card).forEach((text, index) => {
    if (!broken(text)) return
    const [title, why] = note(msg`第 ${index + 1} 段开场白`)
    out.push(finding('macro-broken', `greeting-${index}`, 'warn', title, why, [{ id: `greeting:${index}`, kind: 'greeting', index, before: text, after: fix(text) }]))
  })
  for (const entry of live) {
    if (!broken(entry.content)) continue
    const [title, why] = note(msg`「${nameOf(entry)}」`)
    out.push(finding('macro-broken', entry.uid, 'warn', title, why, [entryChange(entry, { after: fix(entry.content) })], { where: nameOf(entry) }))
  }
  return out
}

// ─── Variables ────────────────────────────────────────────────────────────

/** Whether what goes into the card itself is written in English. */
export const englishCard = card => !/[\u4e00-\u9fff]/.test(`${card.description}${card.firstMes}`)

/** A frame for the rules a card with initial variables lacks; the words between the brackets are for the author. */
function rulesFrame(card, state, paths) {
  const english = englishCard(card)
  const example = paths[0]
  const value = valueAt(state, example)
  const patch = `[{ "op": "replace", "path": "/${example.join('/')}", "value": ${JSON.stringify(typeof value === 'number' ? value + 1 : value ?? '')} }]`
  const lines = paths.map(keys => `- ${keys.join('.')}: ${english ? '(when and how it changes)' : '（什么时候变、怎么变）'}`)
  return [
    '<update_variable_rules>',
    english ? 'At the end of every reply, write how the variables changed this turn, like this:' : '每次回复的末尾写这一轮变了的变量，格式如下：',
    '<UpdateVariable>',
    '<JSONPatch>',
    patch,
    '</JSONPatch>',
    '</UpdateVariable>',
    english ? 'With no change this turn, write []. The variables:' : '这一轮没有变化就写 []。要记的变量：',
    ...lines,
    '</update_variable_rules>',
  ].join('\n')
}

function leafPaths(value, keys = []) {
  if (!isRecord(value)) return keys.length ? [keys] : []
  return Object.entries(value).filter(([key]) => !key.startsWith('$')).flatMap(([key, item]) => leafPaths(item, [...keys, key]))
}

function variableFindings({ card, initvars, state, mvu, texts, schema }) {
  const out = []
  for (const entry of initvars) {
    try {
      const value = YAML.parse(entryText(entry))
      if (entryText(entry).trim() && !isRecord(value)) throw new Error(msg`最外层要写成「名字: 值」`)
    } catch (error) {
      const name = nameOf(entry)
      out.push(finding('initvar-broken', entry.uid, 'error', msg`初始变量「${name}」读不出来`, msg`这一条读不出来，开局时里面的变量都是空的（${String(error.message).split('\n')[0]}）。`, [entryChange(entry)], { where: name, manual: true }))
    }
  }
  if (mvu && !initvars.length && !schema) out.push(finding('rules-no-initvar', 'card', 'error', msg`写了变量规则，但没有初始变量`, msg`规则要模型更新变量，开局却一个变量都没有，状态栏是空的。要加一条初始变量条目，可以让模型帮忙（下面的「让模型再看看」）。`))
  const inUse = initvars.some(entry => !OLD_ENTRY.test(entry.comment))
  const paths = leafPaths(state).slice(0, MAX_FRAME_PATHS)
  if (!mvu && inUse && paths.length && !texts.some(text => SETS_ITSELF.test(text))) {
    out.push(finding('initvar-no-rules', 'card', 'warn', msg`有初始变量，但没有写怎么更新`, msg`模型不知道要改这些变量，它们会一直停在开局的值。下面先搭好规则的架子，括号里要写清每个变量什么时候变，可以手动填，也可以让模型填。`, [{ id: 'new:rules', kind: 'newEntry', name: msg`变量更新规则`, keys: [], constant: true, after: rulesFrame(card, state, paths) }], { risky: true }))
  }
  return out
}

/**
 * Where the rules go beyond the initial variables: a name that is not there, or a place that has to grow: what they add
 * to and what is empty on purpose, and on a card 创作角色卡 made its lists and 册子 too. An older card's lists have no mark
 * (export puts it on for SillyTavern, st-export.mjs), and a book that lost its `$meta` can have rows added here only.
 */
function pathFindings({ card, initvars, known, mvu, texts, schema, made, bricks }) {
  if (!mvu) return []
  const out = []
  const grows = new Map()
  for (const { keys, adds } of namedPaths(texts).filter(path => !path.keys.some(key => /^\d+$/.test(key)))) {
    const there = holds(known, keys)
    const parent = keys.slice(0, -1)
    if (adds && there) grows.set(pathKey(keys), keys)
    else if (there || !Object.keys(known).length) continue
    else if (parent.length && isDictionary(valueAt(known, parent))) grows.set(pathKey(parent), parent)
    else if (!schema) {
      const path = keys.join('.')
      out.push(finding('rule-path-missing', path, 'warn', msg`规则里的「${path}」在初始变量里没有`, msg`规则让模型改这个变量，开局却没有它，可能是名字写错了，或者初始变量漏了。`, initvars[0] ? [entryChange(initvars[0])] : [], { manual: true }))
    }
  }
  // A schema says what may grow; without one, MVU lets nothing grow unless told.
  if (schema) return out
  const raws = initvars.map(entry => ({ entry, value: parsedInit(entry) })).filter(item => item.value)
  // Empty on purpose: a place for what the story adds.
  for (const { value } of raws) for (const keys of emptyContainers(value)) grows.set(pathKey(keys), keys)
  for (const keys of bricks.books) grows.set(pathKey(keys), keys)
  if (made) for (const { value } of raws) for (const keys of listPaths(value)) grows.set(pathKey(keys), keys)
  const targetsIn = value => [...grows.values()].filter(keys => holds(value, keys) && !mayGrow(value, keys))
  const changes = []
  const named = new Set()
  for (const { entry, value } of raws) {
    const targets = targetsIn(value)
    if (!targets.length) continue
    for (const keys of targets) named.add(keys.join('.'))
    const after = markedText(entry, targets)
    changes.push(entryChange(entry, after === null ? {} : { after }))
  }
  // An opening with values of its own starts from those instead.
  if (made) {
    greetingList(card).forEach((text, index) => {
      const block = INIT_BLOCK.exec(text)?.[1]
      const value = block ? parsedInit({ content: block }) : null
      const targets = value ? targetsIn(value) : []
      const after = targets.length ? markedOpening(text, block, targets) : null
      if (after !== null) changes.push({ id: `greeting:${index}`, kind: 'greeting', index, before: text, after })
    })
  }
  if (named.size) {
    const manual = changes.every(change => change.after === change.before)
    const list = `${[...named].slice(0, 3).join(msg`、`)}${named.size > 3 ? msg` 等 ${named.size} 处` : ''}`
    out.push(finding('extensible', 'card', 'warn', msg`${list}在 SillyTavern 里加不了新项`, msg`这些地方玩的时候要加东西，但 MVU 默认不让加。在这里能玩，导出到 SillyTavern 新项会被丢掉。加上可以扩展的标记就好。`, changes, manual ? { manual } : {}))
  }
  return out
}

// 创作角色卡 once told an event only in words that it happens once, and a model would play it again. A card it made with
// variables can keep the events that happened in a list instead (write.mjs): the old entries get the test and the line,
// the starting values the list. Optional, so it is a tip, and it changes how the card plays.
const OLD_ONCE = { zh: ownWords('').eventOnce, en: ownWords('English').eventOnce }
const EVENT_NAME = /<event name="([^"]+)">/

/** YAML with an empty list of what happened under `key`; null when it cannot be read, or already has one. */
function withEventsDone(text, key) {
  const doc = YAML.parseDocument(text)
  if (doc.errors.length || !YAML.isMap(doc.contents) || doc.has(key)) return null
  doc.set(key, doc.createNode([EXTENSIBLE_MARK]))
  return doc.toString({ lineWidth: 0 }).trimEnd()
}

function eventOnceFindings({ card, live, initvars, made, mvu }) {
  if (!made || !mvu) return []
  const old = live.flatMap(entry => {
    const lines = entry.content.split('\n')
    const english = lines.includes(OLD_ONCE.en)
    const name = EVENT_NAME.exec(entry.content)?.[1]
    // Only an @@if the code put first is known to stand there; any other decorator is someone's own.
    if ((!english && !lines.includes(OLD_ONCE.zh)) || !name || (lines[0].startsWith('@@') && !lines[0].startsWith('@@if '))) return []
    return [{ entry, lines, english, item: eventItem(name) }]
  })
  const init = initvars.find(entry => !OLD_ENTRY.test(entry.comment) && !hasTemplate(entry.content) && parsedInit(entry))
  if (!old.length || !init) return []
  const language = old[0].english ? 'English' : ''
  const key = eventsDone(language)
  const changes = old.map(({ entry, lines, english, item }) => {
    const once = lines.map(line => (line === OLD_ONCE[english ? 'en' : 'zh'] ? onceMarked(language, item) : line))
    const test = notHappened(language, item)
    const after = once[0].startsWith('@@if ') ? [`${once[0]} && ${test}`, ...once.slice(1)] : [`@@if ${test}`, ...once]
    return entryChange(entry, { after: after.join('\n') })
  })
  const { body } = splitDecorators(init.content)
  const list = withEventsDone(body, key)
  if (list !== null) changes.push(entryChange(init, { after: `${init.content.slice(0, init.content.length - body.length)}${list}` }))
  // An opening with values of its own starts from those instead.
  greetingList(card).forEach((text, index) => {
    const block = INIT_BLOCK.exec(text)?.[1]
    const own = block ? withEventsDone(block, key) : null
    if (own !== null) changes.push({ id: `greeting:${index}`, kind: 'greeting', index, before: text, after: text.replace(INIT_BLOCK, () => `<initvar>\n${own}\n</initvar>`) })
  })
  return [finding('event-once', 'card', 'tip', msg`有 ${old.length} 个事件只靠文字提醒「只发生一次」`, msg`模型不一定记得一件事已经写过，到了时机可能再写一遍。可以改成用变量记下：事件写进故事的那一轮，模型把它加进「${key}」，之后这一条就不再发出去。在这里已经开始的聊天也照样记。在 SillyTavern 里要装提示词模板扩展（ST-Prompt-Template）才生效，最好从新的聊天开始。`, changes, { risky: true })]
}

/** Whether a card shows a status bar of its own making: a regex or a script draws it, not a layout. */
export function drawsOwnBar(card) {
  const scripts = Array.isArray(card.regexScripts) ? card.regexScripts : []
  return scripts.some(script => !script.disabled && /StatusPlaceHolderImpl|状态栏|status/i.test(`${script.findRegex}${script.scriptName}`))
}

function statusFindings({ card, state, known, scripts, mvu, variables, initvars, bricks }) {
  const out = []
  const spec = card.statusBar
  if (spec && variables) {
    // A book's rows come and go in play: a cell of one is no place for a field to point.
    const leaves = leafPaths(known).filter(keys => !bricks.books.some(book => book.every((key, i) => keys[i] === key)))
    const lost = spec.fields.filter(field => field.show !== 'hidden' && getPath(known, field.path) === undefined)
    if (lost.length) {
      const fields = spec.fields.flatMap(field => {
        if (!lost.includes(field)) return [field]
        const last = splitPath(field.path).at(-1)
        const same = leaves.filter(keys => keys.at(-1) === last)
        return same.length === 1 ? [{ ...field, path: joinPath(same[0]) }] : []
      })
      const after = cleanStatusSpec({ ...spec, fields })
      out.push(finding('status-path-missing', 'card', 'warn', msg`状态栏有 ${lost.length} 项对不上变量`, msg`「${lost.slice(0, 3).map(field => field.label || field.path).join(msg`、`)}」在初始变量里没有，开局显示不出来。能认出的改成对的路径，认不出的去掉。`, [statusChange(spec, after)]))
    }
  }
  // A bar drawn some other way, or variables the author gave up on, need no new one.
  if (!spec && !drawsOwnBar(card) && variables && initvars.some(entry => !OLD_ENTRY.test(entry.comment))) {
    const after = autoStatusSpec(state)
    if (after) out.push(finding('status-none', 'card', 'tip', msg`有变量，但没有自己的状态栏`, msg`可以按变量排一个状态栏，跟着卡走，导出到 SillyTavern 也在。排好后能改标题、显示方式和主题。`, [statusChange(null, after, { scripts: true })], { risky: true }))
  }
  if (mvu && !scripts.some(script => !script.disabled && UPDATE_TAG.test(script.findRegex) && script.placement?.includes(PLACEMENT.AI_OUTPUT) && effectOf(script) !== 'prompt')) {
    out.push(finding('no-hide-regex', 'card', 'tip', msg`在 SillyTavern 里玩家会看到变量块`, msg`这里会自动藏起 <UpdateVariable>，SillyTavern 不会。加一条只改显示的正则，导出后也藏得住。`, [{ id: 'new:hide', kind: 'newRegex', name: msg`对玩家隐藏变量更新`, on: 'ai', effect: 'display', find: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gi', replace: '' }]))
  }
  return out
}

// ─── 玩法积木 ─────────────────────────────────────────────────────────────
// 创作角色卡 writes a brick into a card as a rule and the regex that answers to it (bricks.mjs). A card that was edited,
// or made before a fix, can have one without the other. They are known by the rule's own tag and by what the regex
// does, not by the ids they came with. A rule turned off (裁判表, while 游戏规则 is on) has nothing to check.

const DRAW_TOKEN = /\[(RANDOM_EVENT_\d+|JUDGE_DICE|WORLD_MOVE)\]/g
const DRAW_NAME = /RANDOM_EVENT_\d+|JUDGE_DICE|WORLD_MOVE/
const DICE_NAME = DICE_TOKEN.slice(1, -1)
const WORLD_NAME = WORLD_TOKEN.slice(1, -1)
const drawName = script => DRAW_NAME.exec(script.findRegex)?.[0] ?? ''
const groupOf = name => Number(name.slice(name.lastIndexOf('_') + 1))

/** The bricks a card has: { selfcheck, events, judge, world: their rule, worldDraw: its script, creation: { page, opening, mark, rule }, books: paths, tokens: draws the rules read, draws: [{ group, script, items, rate }] }. */
export function bricksOf(card) {
  const live = (card.book?.entries ?? []).filter(entry => entry.enabled !== false && !isInitvar(entry))
  const scripts = Array.isArray(card.regexScripts) ? card.regexScripts : []
  const rule = tag => live.find(entry => entry.content.includes(`<${tag}>`)) ?? null
  const events = rule(RULE_TAGS.events)
  const tokens = new Set(live.flatMap(entry => [...entry.content.matchAll(DRAW_TOKEN)].map(match => match[1])))
  const groups = [...new Set([...tokens, ...(events ? scripts.map(drawName) : [])])].filter(name => name && name !== DICE_NAME && name !== WORLD_NAME)
  const draws = groups.map(name => {
    const script = scripts.find(item => drawName(item) === name) ?? null
    return { group: groupOf(name), script, ...(readDraw(script?.replaceString) ?? { items: [], rate: 'normal' }) }
  })
  const page = scripts.find(script => script.findRegex.includes('CreationPage')) ?? null
  const opening = greetingList(card).some(text => text.includes(CREATION_TAG))
  const mark = creationOf(scripts)?.mark.trim() ?? ''
  const creation = page || opening ? { page, opening, mark, rule: live.find(entry => entry.keys.includes(mark)) ?? null } : null
  return { selfcheck: rule(RULE_TAGS.selfcheck), events, judge: rule(RULE_TAGS.judge), world: rule(RULE_TAGS.world), worldDraw: scripts.find(script => drawName(script) === WORLD_NAME) ?? null, creation, books: booksInRules(live.map(entry => entry.content)), tokens, draws: draws.sort((a, b) => a.group - b.group) }
}

/** Whether a script takes a whole block out of a reply. */
function coversBlock(script, tag) {
  const pattern = regexFromString(script.findRegex)
  return Boolean(pattern) && script.placement.includes(PLACEMENT.AI_OUTPUT) && `<${tag}>\n结果：x\n</${tag}>`.replace(pattern, '').trim() === ''
}

/**
 * That a block stays out of what the model reads back and of what the player sees. Here the page hides it anyway;
 * SillyTavern shows what no regex takes out. One turned off comes back on before a new one is written.
 * @param add - { fromModel, fromPlayer }: the scripts to add. `keep`: the depth the one to the model starts at.
 */
function hiddenFindings(scripts, { tag, rule, name, add, keep }) {
  const covering = scripts.filter(script => coversBlock(script, tag))
  const on = covering.filter(script => !script.disabled)
  const toModel = script => effectOf(script) !== 'display'
  const toPlayer = script => effectOf(script) !== 'prompt'
  const out = []
  if (!on.some(toModel)) {
    const off = covering.find(toModel)
    out.push(finding(`${rule}-read`, 'card', 'warn', msg`${name}一直留在历史里`, msg`发给模型的内容里没有去掉它，模型每轮都要多读这些，白占上下文。加一条只改发给模型的正则就好。`, off ? [scriptChange(off, { enabled: true, ...(keep ? { minDepth: keep } : {}) })] : add.fromModel.map(script => newScript(script))))
  }
  if (!on.some(toPlayer)) {
    const off = covering.find(toPlayer)
    out.push(finding(`${rule}-shown`, 'card', 'warn', msg`在 SillyTavern 里玩家会看到${name}`, msg`这里会自动藏起来，SillyTavern 不会。加一条只改显示的正则，导出后也藏得住。`, off ? [scriptChange(off, { enabled: true })] : add.fromPlayer.map(script => newScript(script))))
  }
  return out
}

function selfCheckFindings({ card, scripts, bricks }) {
  if (!bricks.selfcheck) return []
  const { fromModel, fromPlayer } = selfCheckScripts(englishCard(card))
  const out = hiddenFindings(scripts, { tag: SELF_CHECK, rule: 'self-check', name: msg`写前自查`, keep: KEPT_DEPTH, add: { fromModel: [fromModel], fromPlayer: [fromPlayer] } })
  const reads = scripts.filter(script => !script.disabled && effectOf(script) !== 'display' && coversBlock(script, SELF_CHECK))
  if (reads.length && !reads.some(script => script.minDepth === KEPT_DEPTH)) {
    const target = reads.find(script => effectOf(script) === 'prompt')
    const now = reads[0].minDepth
    const why = now === null ? msg`现在每一条都对模型藏起来，模型在历史里看不到样子，容易漏写。` : msg`现在从深度 ${now} 起藏起来，和实测的不一样：留得太少模型容易漏写，留得太多白占上下文。`
    out.push(finding('self-check-depth', 'card', 'warn', msg`写前自查没有留最近两条`, msg`${why}从深度 ${KEPT_DEPTH} 起藏起来，正好留最近两条回复。`, [target ? scriptChange(target, { minDepth: KEPT_DEPTH }) : scriptChange(reads[0])], target ? {} : { manual: true }))
  }
  return out
}

/** What a draw's script needs: it runs over the rules, only for the model, and answers to the whole token. */
export function drawWorks(script, token) {
  const found = regexFromString(script.findRegex)?.exec(token)?.[0]
  return !script.disabled && script.promptOnly && script.placement.includes(PLACEMENT.WORLD_INFO) && found === token && Boolean(script.replaceString.trim())
}

/** What puts a token's script right; a list the card has lost is for a person or a model to write (`fill`). */
function drawFix(name, script, english) {
  const dice = name === DICE_NAME
  const fresh = dice ? diceScript(english) : name === WORLD_NAME ? worldMoveScript('', english) : eventScript(groupOf(name) - 1, '', english)
  if (!script) return newScript(fresh, dice ? {} : { fill: true })
  return scriptChange(script, {
    findAfter: fresh.findRegex,
    ...(script.replaceString.trim() ? {} : dice ? { replaceAfter: fresh.replaceString } : { fill: true }),
    ...(script.disabled ? { enabled: true } : {}),
    ...(script.promptOnly ? {} : { newEffect: 'prompt' }),
    ...(script.placement.includes(PLACEMENT.WORLD_INFO) ? {} : { world: true }),
  })
}

/** An entry's text with `line` before the first line `before` picks, or else before its closing tag. */
function withLine(entry, line, before, close) {
  const lines = entry.content.split('\n')
  const at = [lines.findIndex(before), lines.findIndex(text => text.includes(close))].find(index => index >= 0)
  return at === undefined ? null : [...lines.slice(0, at), line, ...lines.slice(at)].join('\n')
}

/** That each token in the rules has a script to fill it in, and each draw a rule to read it. */
function drawFindings({ card, scripts, bricks }) {
  const english = englishCard(card)
  const out = []
  const scriptOfName = name => scripts.find(script => drawName(script) === name) ?? null
  for (const name of bricks.tokens) {
    const token = `[${name}]`
    const named = scripts.filter(script => drawName(script) === name)
    if (named.some(script => drawWorks(script, token))) continue
    const change = drawFix(name, named[0], english)
    const dice = name === DICE_NAME
    const world = name === WORLD_NAME
    const title = dice ? msg`裁判表的骰子掷不出来` : world ? msg`世界动态抽不出来` : msg`随机事件第 ${groupOf(name)} 组抽不出来`
    const lead = msg`规则里的 ${token} 没有正则来换，模型读到的就是这几个字。`
    const why = change.fill && world
      ? msg`${lead}在「替换成」里写 {{random::一件事::另一件事::无::无::无}}，事情的名字用规则里写的，「无」越多动得越慢。`
      : change.fill
      ? msg`${lead}名单是这张卡的内容：在「替换成」里写 {{random::一件事::另一件事::无::无::无}}，「无」越多越少发生，也可以让模型补。`
      : named[0] ? msg`${lead}正则「${scriptName(named[0])}」停用了或者被改过，改回来就好。` : msg`${lead}加一条每轮掷一次的正则就好。`
    out.push(finding('draw-missing', name, 'error', title, why, [change], change.fill ? { manual: true } : {}))
  }
  const unread = names => names.filter(name => !bricks.tokens.has(name) && !scriptOfName(name)?.disabled)
  if (bricks.events) {
    for (const name of unread(bricks.draws.map(draw => `RANDOM_EVENT_${draw.group}`))) {
      const group = groupOf(name)
      const after = withLine(bricks.events, eventLine(group - 1, bricks.draws.length > 1 ? '' : null, english), line => line.startsWith('- '), `</${RULE_TAGS.events}>`)
      out.push(finding('draw-unread', name, 'warn', msg`随机事件第 ${group} 组抽了也没用上`, msg`规则里已经没有 ${eventToken(group - 1)}，这组名单碰不上了。要的话放回规则里，不要了就忽略这一条。`, [entryChange(bricks.events, after === null ? {} : { after })], { where: nameOf(bricks.events), risky: true, ...(after === null ? { manual: true } : {}) }))
    }
  }
  if (bricks.judge && scripts.some(script => drawName(script) === DICE_NAME) && unread([DICE_NAME]).length) {
    const after = withLine(bricks.judge, diceLine(english), line => /^(要判定时|When you judge)/.test(line), `</${RULE_TAGS.judge}>`)
    out.push(finding('draw-unread', DICE_NAME, 'warn', msg`裁判表每轮掷的骰子没有用上`, msg`规则里已经没有 ${DICE_TOKEN}，平手时模型看不到点数。要的话放回规则里，不看运气就忽略这一条。`, [entryChange(bricks.judge, after === null ? {} : { after })], { where: nameOf(bricks.judge), risky: true, ...(after === null ? { manual: true } : {}) }))
  }
  if (bricks.world && scripts.some(script => drawName(script) === WORLD_NAME) && unread([WORLD_NAME]).length) {
    const after = withLine(bricks.world, worldLine(english), line => /^- (抽到「|If it says)/.test(line), `</${RULE_TAGS.world}>`)
    out.push(finding('draw-unread', WORLD_NAME, 'warn', msg`世界动态抽了也没用上`, msg`规则里已经没有 ${WORLD_TOKEN}，世界不会动。要的话放回规则里，不要了就忽略这一条。`, [entryChange(bricks.world, after === null ? {} : { after })], { where: nameOf(bricks.world), risky: true, ...(after === null ? { manual: true } : {}) }))
  }
  return out
}

/** 建角页: a form that cannot show, one the card no longer opens on, one whose answers no rule reads. */
function creationFindings({ bricks }) {
  if (!bricks.creation) return []
  const { page, opening, mark, rule } = bricks.creation
  const out = []
  if (opening && (!page || page.disabled)) {
    const why = page ? msg`正则「${scriptName(page)}」停用了，开场白里的表出不来，改回来就好。` : msg`开场白里的表靠一条正则显示，这条没有了，玩家看不到表。换一段开场白，或者重新做一张带建角页的卡。`
    out.push(finding('creation-page', 'card', 'error', msg`开局的表显示不出来`, why, page ? [scriptChange(page, { enabled: true })] : []))
  }
  if (page && !page.disabled && !opening) out.push(finding('creation-unused', 'card', 'warn', msg`开局的表不会出现`, msg`开场白里已经没有 ${CREATION_TAG}，这张表出不来。要的话放回开场白，不要了就忽略这一条。`))
  if (mark && !rule) out.push(finding('creation-rule', 'card', 'warn', msg`填完表，模型不知道怎么用`, msg`世界书里没有关键词是 ${mark} 的规则，表里的值不会写进变量。`))
  return out
}

const RANK_LINE = /^(等级从低到高：|Ranks, low to high:\s*)(.+)$/
const KNOWN_LINE = /^(已知的等级：|Known ranks:\s*)(.+)$/
const RANK_BREAK = /\s*(?:<|＜|→|、|，|,|；|;)\s*/
const NUMBERED = /[（(]\d+[）)]$/
// What the rule said before its ranks had numbers.
const COUNTED_LINES = {
  '差距按这张表数格子：': '差距是两边等级的序号相减：',
  'Count the steps between the two on that list:': 'The gap is the two rank numbers subtracted:',
  '对比：<user>的等级 对 对方的等级': '对比：<user>的等级（序号）对 对方的等级（序号）',
  'Match: rank of <user> against the other side': 'Match: rank of <user> (its number) against the other side (its number)',
}

/** A 裁判表 with its ranks numbered from 1, or null when they are, or are not there to read. */
function numberedJudge(content) {
  const lines = content.split('\n')
  const at = lines.findIndex(line => RANK_LINE.test(line))
  if (at < 0) return null
  const [, lead, list] = RANK_LINE.exec(lines[at])
  const parts = list.split(RANK_BREAK).filter(Boolean)
  const placed = parts.map((part, i) => new RegExp(`^${i + 1}[\\s.．:：]+(.+)$`).exec(part)?.[1])
  if (parts.length < 2 || placed.every(Boolean)) return null
  const ranks = parts.map((part, i) => placed[i] ?? part)
  const english = lead.startsWith('Ranks')
  const known = item => {
    const number = ranks.findIndex(rank => item.endsWith(` ${rank}`)) + 1
    return NUMBERED.test(item) || !number ? item : `${item}${english ? ` (${number})` : `（${number}）`}`
  }
  const between = english ? ', ' : '；'
  return lines.map((line, i) => {
    if (i === at) return `${lead}${ranks.map((rank, n) => `${n + 1} ${rank}`).join(english ? ', ' : '、')}`
    const match = KNOWN_LINE.exec(line)
    return match ? `${match[1]}${match[2].split(between).map(known).join(between)}` : COUNTED_LINES[line] ?? line
  }).join('\n')
}

function judgeFindings({ card, scripts, bricks }) {
  if (!bricks.judge) return []
  const { fromModel, shown, rest } = judgeScripts(englishCard(card))
  const out = hiddenFindings(scripts, { tag: JUDGE, rule: 'judge', name: msg`判定块`, add: { fromModel: [fromModel], fromPlayer: [shown, rest] } })
  const after = numberedJudge(bricks.judge.content)
  if (after !== null) out.push(finding('judge-unnumbered', bricks.judge.uid, 'warn', msg`裁判表的等级没有排好序号`, msg`实测里模型照着没有序号的表数差距，常常数错。等级带上序号，模型只要做减法。`, [entryChange(bricks.judge, { after })], { where: nameOf(bricks.judge) }))
  return out
}

// ─── Cost ─────────────────────────────────────────────────────────────────

function heavyFindings({ entries }) {
  const fixed = entries.filter(inPrefix)
  const turn = entries.filter(entry => entry.enabled !== false && isConstant(entry) && isDynamic(entry) && !isInitvar(entry))
  const fixedChars = fixed.reduce((sum, entry) => sum + entry.content.length, 0)
  const turnChars = turn.reduce((sum, entry) => sum + entry.content.length, 0)
  if (fixedChars < HEAVY_PREFIX && turnChars < HEAVY_TURN) return []
  const biggest = [...fixed, ...turn].sort((a, b) => b.content.length - a.content.length).slice(0, BIGGEST_SHOWN).map(entry => msg`「${nameOf(entry)}」${entry.content.length.toLocaleString()} 字`)
  return [finding('constant-heavy', 'card', 'tip', msg`常驻内容偏多：约 ${(fixedChars + turnChars).toLocaleString()} 字`, msg`一开局就要带上这些，模型读得多，也更容易忽略要紧的规则。最长的几条：${biggest.join(msg`、`)}。人物、地点这类只在提到时才用的条目可以改成关键词，「让模型再看看」能挑出来。`)]
}

// ─── The whole of it ──────────────────────────────────────────────────────

const LEVELS = { error: 0, warn: 1, tip: 2 }

/** What the program finds on a card, the worst first. */
export function checkCard(card, { helpers = null } = {}) {
  const facts = factsOf(card, helpers)
  const found = [...regexFindings(facts), ...keyFindings(facts), ...entryFindings(facts), ...greetingFindings(facts), ...macroFindings(facts), ...variableFindings(facts), ...pathFindings(facts), ...eventOnceFindings(facts), ...statusFindings(facts), ...selfCheckFindings(facts), ...drawFindings(facts), ...creationFindings(facts), ...judgeFindings(facts), ...heavyFindings(facts)]
  return found.sort((a, b) => LEVELS[a.level] - LEVELS[b.level])
}

/** The variables as they start, for a status bar's preview. */
export const startingState = (card, { helpers = null } = {}) => factsOf(card, helpers).known

/** The status bar's shown fields with no variable behind them at the start ({ path, label }); none for a card without variables. */
export function missingStatusFields(card, { helpers = null } = {}) {
  const { known, variables } = factsOf(card, helpers)
  if (!card.statusBar || !variables) return []
  return card.statusBar.fields
    .filter(field => field.show !== 'hidden' && getPath(known, field.path) === undefined)
    .map(field => ({ path: field.path, label: field.label || splitPath(field.path).at(-1) }))
}

export const STATUS_TUNE = 'status-tune:card'

/**
 * 调整状态栏: the card's bar as a change to write over by hand, or one laid out from its variables; no model, nothing to
 * find. Taken in as any finding is, so it can be taken back. null when there is no bar to adjust: no variables, or the
 * card draws its own. `fields`: what the bar can show, for putting one back.
 */
export function statusTuning(card, { helpers = null } = {}) {
  const auto = autoStatusSpec(startingState(card, { helpers }))
  const spec = card.statusBar ?? (drawsOwnBar(card) ? null : auto)
  if (!spec) return null
  return { ...finding('status-tune', 'card', 'tip', msg`调整状态栏`, '', [statusChange(card.statusBar ?? null, spec, card.statusBar ? {} : { scripts: true })]), fields: auto?.fields ?? [] }
}

/** The hosts a card's scripts load things from: its look needs them online. */
function remoteHosts(scripts) {
  const hosts = new Set()
  for (const script of scripts) {
    if (script.disabled) continue
    for (const [, host] of script.replaceString.matchAll(/https?:\/\/([\w.-]+)/g)) hosts.add(host)
  }
  return [...hosts].slice(0, 8)
}

/** What kind of card it is, for the top of the window. */
export function cardFacts(card, { helpers = null } = {}) {
  const { entries, live, known, scripts, schema, bricks } = factsOf(card, helpers)
  const fixed = entries.filter(inPrefix)
  const chars = fixed.reduce((sum, entry) => sum + entry.content.length, 0)
  return {
    entries: entries.length,
    enabled: live.length,
    constantChars: chars,
    constantTokens: estimateTokens(fixed.map(entry => entry.content).join('')),
    variables: leafPaths(known).length,
    scripts: scripts.length,
    greetings: greetingList(card).filter(text => text.trim()).length,
    helperScripts: card.helperScripts ?? 0,
    // What each is, from the file when there is one; null when neither that nor a list kept at import says.
    helperList: helpers ? helperSummary(helpers) : card.helperList?.length ? card.helperList : null,
    schema,
    attachedBooks: card.worldbookIds?.length ?? 0,
    remote: remoteHosts(scripts),
    bricks: BRICKS.filter(brick => (brick === 'books' ? bricks.books.length > 0 : Boolean(bricks[brick]))),
  }
}

