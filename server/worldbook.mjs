// Worldbook normalization and keyword activation. Accepts both the card-embedded
// `character_book` shape and SillyTavern's standalone world file shape.
import YAML from 'yaml'
import { httpError, newId } from './store.mjs'
import { decoratorsOf, hasEjs, hasTemplate, splitDecorators, stripTemplates } from './template.mjs'
import { hasVariableMacros } from '../web/shared/vars.js'
import { msg } from './i18n.mjs'
import { guardedTest } from './regex-guard.mjs'

// SillyTavern selectiveLogic values.
const AND_ANY = 0
const NOT_ALL = 1
const NOT_ANY = 2
const AND_ALL = 3

const str = value => (typeof value === 'string' ? value : '')
const list = value =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map(item => String(item).trim())
    .filter(Boolean)

// MVU-style cards keep the initial variables in an entry, not in the prompt.
const INITVAR = /initvar|初始变量|\[init/i
// The item that lets an array grow in MVU; an object says so with `$meta: { extensible: true }`.
export const EXTENSIBLE_MARK = '$__META_EXTENSIBLE__$'

// What normalizeEntry reads of an entry. An imported book keeps the rest
// (depth, group, sticky…) as `extra`, so its export gives SillyTavern them back.
const READ = new Set(['uid', 'id', 'comment', 'name', 'keys', 'key', 'secondary_keys', 'keysecondary', 'selective', 'selectiveLogic', 'content', 'constant', 'enabled', 'disable', 'insertion_order', 'order', 'position', 'case_sensitive', 'caseSensitive', 'matchWholeWords', 'probability', 'useProbability', 'extensions'])
const READ_EXT = new Set(['position', 'selectiveLogic', 'probability', 'useProbability', 'case_sensitive', 'match_whole_words'])
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

/** What SillyTavern keeps of an entry and this app does not read, in world-file names. */
export function extraOf(raw) {
  const extra = {}
  for (const [key, value] of Object.entries(raw)) if (!READ.has(key)) extra[key] = value
  // character_book keeps SillyTavern's fields under extensions, in snake case.
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  for (const [key, value] of Object.entries(ext)) if (!READ_EXT.has(key) && !(camel(key) in extra)) extra[camel(key)] = value
  // null is "as the global setting says" in SillyTavern; off here, and null again on the way back.
  if (raw.caseSensitive === null) extra.caseSensitive = null
  if (raw.matchWholeWords === null) extra.matchWholeWords = null
  return extra
}

/**
 * SillyTavern's recursion switches of an entry (world file, or a card's extensions), kept in `extra` even for a book
 * that keeps nothing else: excludeRecursion (not found through other entries), preventRecursion (its text finds no
 * others), delayUntilRecursion (found only through other entries; a number: from that level of them on).
 */
function recursionOf(raw, position) {
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  const out = {}
  if ((raw.excludeRecursion ?? ext.exclude_recursion) === true) out.excludeRecursion = true
  if ((raw.preventRecursion ?? ext.prevent_recursion) === true) out.preventRecursion = true
  const delay = raw.delayUntilRecursion ?? ext.delay_until_recursion
  if (delay === true || (Number.isFinite(delay) && delay >= 1)) out.delayUntilRecursion = delay === true ? true : Math.min(10, Math.trunc(delay))
  // 聊天中 @深度 (depthOf): its depth, kept for a card's book too (a world file's entry keeps all its fields anyway).
  const depth = Number(raw.depth ?? ext.depth)
  if (position === AT_DEPTH && Number.isFinite(depth)) out.depth = depth
  // 紧挨着回复, the 发送位置 this app had before @深度 (as @深度 0 now): in a world file as cicaSend, in a card's
  // extensions as cica_send.
  if ((raw.cicaSend ?? ext.cica_send) === 'near') out.cicaSend = 'near'
  return out
}

// SillyTavern's 位置 聊天中 @深度 (world_info_position.atDepth), and the depth an entry there has when it names none.
export const AT_DEPTH = 4
export const DEFAULT_DEPTH = 4
export const MAX_DEPTH = 9999

/**
 * Where in the chat an entry goes (位置「聊天中 @深度」): how many messages before the end, as SillyTavern counts them
 * (0 after the newest message, 1 before it, each message of either side one more), or null for an entry that goes
 * elsewhere (a constant one in the frozen prefix, a keyword one with the turn's message: 随这一轮). A keyword entry
 * set 紧挨着回复 before there was @深度 is @深度 0. One at a depth is sent again each turn, there, and taken out of the
 * older messages (engine.mjs placeDeepLore), as SillyTavern does.
 */
export function depthOf(entry) {
  if (!entry) return null
  if (entry.position === AT_DEPTH) {
    const depth = Math.trunc(Number(entry.extra?.depth))
    return Number.isFinite(depth) && depth >= 0 ? Math.min(MAX_DEPTH, depth) : DEFAULT_DEPTH
  }
  return !entry.constant && entry.extra?.cicaSend === 'near' ? 0 : null
}

/** An entry's recursion switches, as recursionOf keeps them: { exclude, prevent, delay } (delay 0: not delayed). */
export function recursionFlags(entry) {
  const extra = entry.extra ?? {}
  const delay = extra.delayUntilRecursion
  return { exclude: extra.excludeRecursion === true, prevent: extra.preventRecursion === true, delay: delay === true ? 1 : Number.isFinite(delay) && delay >= 1 ? delay : 0 }
}

function normalizeEntry(raw, index, { keep = false } = {}) {
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  const comment = str(raw.comment || raw.name).trim()
  const content = str(raw.content)
  // 0 before the character data, 1 after it (presets place the two apart), 4 聊天中 @深度 (SillyTavern's numbers).
  const position = typeof raw.position === 'number' ? raw.position : Number.isFinite(ext.position) ? ext.position : raw.position === 'after_char' ? 1 : 0
  const extra = keep ? extraOf(raw) : recursionOf(raw, position)
  return {
    uid: String(raw.uid ?? raw.id ?? index),
    comment,
    keys: list(raw.keys ?? raw.key),
    secondaryKeys: list(raw.secondary_keys ?? raw.keysecondary),
    selective: raw.selective !== false,
    selectiveLogic: Number(raw.selectiveLogic ?? ext.selectiveLogic ?? AND_ANY),
    content,
    constant: raw.constant === true,
    enabled: raw.enabled !== false && raw.disable !== true,
    order: Number(raw.insertion_order ?? raw.order ?? 100),
    position,
    caseSensitive: (raw.case_sensitive ?? raw.caseSensitive ?? ext.case_sensitive) === true,
    wholeWords: (raw.matchWholeWords ?? ext.match_whole_words) === true,
    probability: Number(raw.probability ?? ext.probability ?? 100),
    useProbability: (raw.useProbability ?? ext.useProbability) === true,
    initvar: INITVAR.test(comment) || decoratorsOf(content).has('@@initial_variables'),
    hasScript: hasEjs(content),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

/**
 * @param standalone - an imported world file (not a card's own book): it keeps
 *   each entry's SillyTavern fields (`extras`), and the description and scan
 *   depth this app's own export writes.
 */
export function normalizeBook(input, fallbackName = '世界书', { standalone = false } = {}) {
  if (!input || typeof input !== 'object') throw httpError(400, msg`世界书格式无效`)
  const rawEntries = Array.isArray(input.entries)
    ? input.entries
    : input.entries && typeof input.entries === 'object'
      ? Object.values(input.entries)
      : null
  if (!rawEntries) throw httpError(400, msg`世界书里没有 entries`)
  const book = {
    id: newId(),
    name: str(input.name).trim() || fallbackName,
    entries: rawEntries.filter(e => e && typeof e === 'object').map((raw, index) => normalizeEntry(raw, index, { keep: standalone })),
    importedAt: new Date().toISOString(),
  }
  if (!standalone) return book
  // Only `scanDepth`, which this app writes: character_book's scan_depth is not
  // read (SillyTavern does not use it either), so a book plays as it did before.
  return editBookInfo({ ...book, extras: true }, { description: str(input.description), scanDepth: input.scanDepth ?? null })
}

/**
 * A card's own book as an imported one (卡里自带 → 导出 / 抽出): its entries as
 * edited here, each over the SillyTavern fields its card's file has for it
 * (`raw`, the character_book there: depth, group, sticky…), so the book plays
 * and exports as the card's did. Entries made here have none.
 */
export function standaloneBook(book, raw = null, { name = '' } = {}) {
  const rawEntries = raw && typeof raw === 'object' ? (Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries ?? {})) : []
  const byUid = new Map(rawEntries.filter(e => e && typeof e === 'object').map((e, i) => [String(e.uid ?? e.id ?? i), e]))
  return {
    id: newId(),
    name: cleanBookName(name) || book.name,
    entries: book.entries.map(entry => {
      const from = byUid.get(entry.uid)
      const { extra: kept, ...copy } = structuredClone(entry)
      const extra = { ...(from ? extraOf(from) : {}), ...(kept ?? {}) }
      return Object.keys(extra).length ? { ...copy, extra } : copy
    }),
    importedAt: new Date().toISOString(),
    extras: true,
  }
}

/** A new empty book (世界书 → 新建, or the target of entries moved out of another). */
export function emptyBook(name) {
  return { id: newId(), name: cleanBookName(name) || msg`新世界书`, entries: [], importedAt: new Date().toISOString(), extras: true }
}

const cleanBookName = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : '')

/** How many recent messages a book's keywords are looked for in; null follows the setting. */
export function scanDepthOf(value) {
  if (value === null || value === undefined || value === '') return null
  const depth = Math.trunc(Number(value))
  return Number.isFinite(depth) && depth >= 1 ? Math.min(100, depth) : null
}

/**
 * An imported book's own fields: `{ name, description, scanDepth }`. None of
 * them is in a chat's prefix: the name and description are for the player, and
 * the scan depth decides which keyword entries a turn sends.
 */
export function editBookInfo(book, change = {}) {
  if (change.name !== undefined) {
    const name = cleanBookName(change.name)
    if (!name) throw httpError(400, msg`名字不能空着`)
    book.name = name
  }
  if (typeof change.description === 'string') book.description = change.description.slice(0, 4000)
  if (change.scanDepth !== undefined) book.scanDepth = scanDepthOf(change.scanDepth)
  return book
}

/** Entry text with any EJS removed (used when a template cannot be rendered). */
export function entryText(entry) {
  return stripTemplates(splitDecorators(entry.content).body).trim()
}

/**
 * Entries that hold initial variables rather than prompt text: an `[initvar]`-style
 * title (also ST-Prompt-Template's `[InitialVariables]`) or `@@initial_variables`.
 * Entries imported before the decorator was read are checked again here.
 */
export function isInitvar(entry) {
  return Boolean(entry.initvar) || decoratorsOf(entry.content).has('@@initial_variables')
}

/** ST-Prompt-Template's own initial-variable entries (its `initial` scope), not MVU's [InitVar]. */
const pluginInitvar = entry => /\[InitialVariables\]/i.test(entry.comment) || decoratorsOf(entry.content).has('@@initial_variables')

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** `change` over `base`, objects merged all the way down as MVU's _.merge does (a later entry adds, never wipes). */
function mergeDeep(base, change) {
  const out = { ...base }
  for (const [key, value] of Object.entries(change)) out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value
  return out
}

/** What in an array says it may grow in MVU: its marker, or a settings item. */
const isGrowMark = item => item === EXTENSIBLE_MARK || (isPlainObject(item) && item.$arrayMeta === true)

/**
 * The initial variables without MVU's marks for what may grow ($meta, $__META_EXTENSIBLE__$): they are for
 * SillyTavern. Nothing here limits what is added, so they stay in the entry's text and out of the variables.
 */
function withoutGrowMarks(value) {
  if (Array.isArray(value)) return value.filter(item => !isGrowMark(item)).map(withoutGrowMarks)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$meta').map(([key, item]) => [key, withoutGrowMarks(item)]))
}

function mergedInitvar(entries, render) {
  let state = {}
  for (const entry of entries) {
    try {
      const parsed = YAML.parse(render(entry))
      // Cards split them by character (one entry per 角色.小雨, 角色.小雪): each adds its own.
      if (isPlainObject(parsed)) state = mergeDeep(state, parsed)
    } catch {
      // A malformed initvar entry is ignored; the card still plays without state.
    }
  }
  return state
}

const readInitvar = (entries, render) => withoutGrowMarks(mergedInitvar(entries, render))

/**
 * Initial state from `[initvar]`-style entries (JSON or YAML).
 * @param render - entry => its text to parse; by default its EJS is taken out
 *   (chats.mjs renders it once when a chat starts, as ST-Prompt-Template does).
 */
export function initialState(books, render = entryText) {
  // Initvar entries are usually disabled (so they never reach the model) — still read them.
  return readInitvar(books.flatMap(book => book.entries.filter(isInitvar)), render)
}

/** The same variables with MVU's marks left in, for what a card lets grow. */
export function markedInitialState(books, render = entryText) {
  return mergedInitvar(books.flatMap(book => book.entries.filter(isInitvar)), render)
}

/** The values ST-Prompt-Template keeps as `initial` variables: from [InitialVariables] / @@initial_variables entries only. */
export function templateInitialVariables(books, render = entryText) {
  return readInitvar(books.flatMap(book => book.entries.filter(pluginInitvar)), render)
}

/**
 * An entry whose text depends on game state (EJS or variable macros) cannot
 * live in the frozen prefix; it is rendered with the current state every turn.
 * So is one made constant by `@@activate` and one rendered before matching
 * (`preprocessed`): decorator features stay out of the prefix.
 */
export function isDynamic(entry) {
  return Boolean(entry.preprocessed) || hasTemplate(entry.content) || hasVariableMacros(entry.content) || decoratorsOf(entry.content).has('@@activate')
}

/**
 * Sent every turn regardless of keywords: constant, or `@@activate`. `@@dont_activate`
 * keeps an entry out of every turn (getwi can still read it; activewi with `force` sends it).
 */
export function isConstant(entry) {
  const decorators = decoratorsOf(entry.content)
  if (decorators.has('@@dont_activate')) return false
  return entry.constant || decorators.has('@@activate')
}

/** Never sent as an entry of its own: initial variables, and entries that only run before each turn (`@@only_preload`). */
const special = entry => isInitvar(entry) || decoratorsOf(entry.content).has('@@only_preload')

/**
 * Entries run first in each turn's template sandbox, their output dropped, so
 * their define()s exist for the rest (ST-Prompt-Template's preload, which here
 * happens every turn): `@@preload` on an enabled entry, `@@only_preload` on any.
 */
export function preloadEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(entry => {
    const decorators = decoratorsOf(entry.content)
    if (decorators.has('@@dont_preload')) return false
    return decorators.has('@@only_preload') || (decorators.has('@@preload') && entry.enabled)
  })))
}

/** Entries whose content and keywords are rendered before keyword matching (`@@preprocessing` / a [Preprocessing] title). */
export function isPreprocessing(entry) {
  return entry.enabled && !special(entry) && (/\[Preprocessing\]/i.test(entry.comment) || decoratorsOf(entry.content).has('@@preprocessing'))
}

/**
 * SillyTavern positions 2–4 (author's note top/bottom, @depth) put an entry
 * near the end of the context, usually rules the model must apply every turn
 * (MVU's 变量输出格式 / 变量更新规则 sit at @D0).
 * @param atDepth - whether @depth (4) entries go at their depth each turn (a chat whose prefix was built since there
 *   was @深度: chat.loreAtDepth), so not into the prefix.
 */
export function isLate(entry, { atDepth = true } = {}) {
  return entry.position >= 2 && entry.position <= (atDepth ? 3 : 4)
}

/** Constant entries sent each turn at their depth (a chat with loreAtDepth): the static ones placed at @深度. */
export function deepConstantEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => inPrefix(e) && e.position === AT_DEPTH)))
}

/** Static constant entries: rendered into a chat's frozen prefix when it starts. */
export const inPrefix = e => e.enabled && isConstant(e) && !special(e) && !isDynamic(e)

/** Constant entries that never change: they go into the cached prefix. */
export function constantEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => inPrefix(e) && !isLate(e, { atDepth: false }))))
}

/**
 * Static constant entries meant for the end of the context. They also go into
 * the cached prefix (last, under the every-turn rules), and each turn carries a
 * one-line reminder naming them: re-sending their full text every turn would
 * pile up in the history, and the history cannot be edited without losing the
 * cache for everything after the edit.
 */
export function lateEntries(books, { atDepth = true } = {}) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => inPrefix(e) && isLate(e, { atDepth }))))
}

export function entryTitle(entry) {
  return entry.comment || entryText(entry).replace(/\s+/g, ' ').slice(0, 16)
}

/** Constant entries rendered fresh each turn, at the tail. */
export function dynamicEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => e.enabled && isConstant(e) && !special(e) && isDynamic(e))))
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.order - b.order)
}

function keyMatcher(key, entry) {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(key)
  if (regex) {
    try {
      const re = new RegExp(regex[1], regex[2])
      // A card's own pattern: run with a bound on its time.
      return text => guardedTest(re, text)
    } catch {
      return () => false
    }
  }
  const needle = entry.caseSensitive ? key : key.toLowerCase()
  // An empty key would be in every text.
  if (!needle.trim()) return () => false
  const asciiWord = /^[\w\s]+$/.test(needle)
  if (entry.wholeWords && asciiWord) {
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, entry.caseSensitive ? '' : 'i')
    return text => re.test(text)
  }
  return text => (entry.caseSensitive ? text : text.toLowerCase()).includes(needle)
}

function entryMatches(entry, text) {
  if (entry.keys.length === 0) return false
  if (!entry.keys.some(key => keyMatcher(key, entry)(text))) return false
  if (!entry.selective || entry.secondaryKeys.length === 0) return true
  const hits = entry.secondaryKeys.map(key => keyMatcher(key, entry)(text))
  switch (entry.selectiveLogic) {
    case AND_ALL: return hits.every(Boolean)
    case NOT_ANY: return !hits.some(Boolean)
    case NOT_ALL: return !hits.every(Boolean)
    default: return hits.some(Boolean)
  }
}

// 递归触发 (设置 → 世界书与状态 → 扫描与状态): 'off'; 'keyword', the text of entries found by keyword finds more;
// 'all', the always-on entries' text too, as SillyTavern does.
export const RECURSION_MODES = Object.freeze(['off', 'keyword', 'all'])
// Levels of entries found through entries, at most: a book of entries naming each other stops here.
export const MAX_RECURSION = 5
// What recursion may add in a turn, at most: nearer levels first, a smaller 顺序 first within one. The rest waits
// (found again when the story names it). Without it, a book whose entries all name each other sent half of itself.
export const RECURSION_BUDGET = Object.freeze({ entries: 10, chars: 8000 })

/**
 * Keyword-triggered entries for this turn.
 * @param books - active books.
 * @param scanText - recent story text plus the player's input, or a function
 *   giving it for a book (a book may scan its own number of messages).
 * @param recentlyInjected - `${bookId}:${uid}` refs still visible in recent turns.
 * @param options.recursion - RECURSION_MODES: whether what was found finds more, level by level, as SillyTavern's
 *   recursive scan, by each entry's switches (recursionFlags). An entry still visible in recent turns is not sent
 *   again, and its text finds nothing new: what it found came with it.
 */
export function triggeredEntries(books, scanText, recentlyInjected, { recursion = 'off' } = {}) {
  const hits = []
  const looked = new Set()
  const candidates = []
  for (const book of books) {
    for (const entry of book.entries) {
      if (!entry.enabled || entry.constant || special(entry)) continue
      const decorators = decoratorsOf(entry.content)
      if (decorators.has('@@activate') || decorators.has('@@dont_activate')) continue
      candidates.push({ book, entry, ref: `${book.id}:${entry.uid}`, flags: recursionFlags(entry) })
    }
  }
  // What recursion has added so far this turn (RECURSION_BUDGET).
  const spent = { entries: 0, chars: 0 }
  const byOrder = [...candidates].sort((a, b) => a.entry.order - b.entry.order)
  // Those of `candidates` the text matches at this level, once each; the ones sent, as found.
  const find = (level, textOf) => {
    const found = []
    for (const item of level ? byOrder : candidates) {
      if (looked.has(item.ref)) continue
      if (level === 0 ? item.flags.delay > 0 : item.flags.exclude || item.flags.delay > level) continue
      if (!entryMatches(item.entry, textOf(item.book))) continue
      // Through other entries, within what a turn may add; past it, nothing more at this level or after.
      if (level && (spent.entries + 1 > RECURSION_BUDGET.entries || spent.chars + item.entry.content.length > RECURSION_BUDGET.chars)) {
        spent.full = true
        break
      }
      looked.add(item.ref)
      // One at a depth (聊天中 @深度) is not in the history any more: sent each turn it is found.
      if (recentlyInjected.has(item.ref) && depthOf(item.entry) === null) continue
      if (item.entry.useProbability && item.entry.probability < 100 && Math.random() * 100 >= item.entry.probability) continue
      hits.push({ ref: item.ref, entry: item.entry, ...(level ? { level } : {}) })
      if (level) {
        spent.entries += 1
        spent.chars += item.entry.content.length
      }
      found.push(item)
    }
    return found
  }
  let fresh = find(0, book => (typeof scanText === 'function' ? scanText(book) : scanText))
  if (RECURSION_MODES.includes(recursion) && recursion !== 'off') {
    // The always-on entries' text: read at the first level, with what the story found.
    const constant = recursion === 'all'
      ? books.flatMap(book => book.entries.filter(entry => entry.enabled && entry.constant && !special(entry) && !recursionFlags(entry).prevent).map(entry => entry.content))
      : []
    for (let level = 1; level <= MAX_RECURSION; level++) {
      const text = [...(level === 1 ? constant : []), ...fresh.filter(item => !item.flags.prevent).map(item => item.entry.content)].join('\n\n')
      // Nothing to read at this level; one delayed to a later level still waits for text there.
      if (!text.trim()) break
      fresh = find(level, () => text)
      if (spent.full) break
      if (!fresh.length && !candidates.some(item => !looked.has(item.ref) && item.flags.delay > level)) break
    }
  }
  return hits.sort((a, b) => a.entry.order - b.entry.order)
}

/**
 * Enabled entries whose keywords `text` matches, constant ones too, as
 * ST-Prompt-Template's activateWorldInfoByKeywords selects them: [{ book, entry }].
 */
export function keywordEntries(books, text) {
  const found = []
  for (const book of books) {
    for (const entry of book.entries) {
      if (!entry.enabled || special(entry) || decoratorsOf(entry.content).has('@@dont_activate')) continue
      if (isConstant(entry) || entryMatches(entry, text)) found.push({ book, entry })
    }
  }
  return found
}

/** "27 entries, 26 in use, 19 of them constant", as the settings show a book. */
export function bookCounts(book) {
  const enabled = book.entries.filter(e => e.enabled !== false)
  return { entries: book.entries.length, enabled: enabled.length, constant: enabled.filter(e => e.constant).length }
}

// What of an entry the frozen prefix holds: its text, title and place, and whether it is in at all.
const PREFIX_FIELDS = ['enabled', 'constant', 'content', 'comment', 'order', 'position']
const MAX_ENTRIES = 2000

/** An entry's fields as the page edits them; anything else in `change` is left alone. */
function editEntry(entry, change) {
  if (typeof change.enabled === 'boolean') entry.enabled = change.enabled
  if (typeof change.constant === 'boolean') entry.constant = change.constant
  if (typeof change.caseSensitive === 'boolean') entry.caseSensitive = change.caseSensitive
  if (typeof change.wholeWords === 'boolean') entry.wholeWords = change.wholeWords
  if (typeof change.comment === 'string') entry.comment = change.comment.trim().slice(0, 200)
  if (change.keys !== undefined) entry.keys = list(change.keys).slice(0, 100)
  if (change.secondaryKeys !== undefined) entry.secondaryKeys = list(change.secondaryKeys).slice(0, 100)
  if (typeof change.content === 'string') entry.content = change.content
  if (change.order !== undefined) {
    const order = Math.trunc(Number(change.order))
    if (Number.isFinite(order)) entry.order = Math.min(99999, Math.max(-99999, order))
  }
  // 递归: SillyTavern's switches, kept in extra (recursionOf) where its export finds them.
  const switches = { excludeRecursion: change.excludeRecursion, preventRecursion: change.preventRecursion, delayUntilRecursion: change.delayUntilRecursion }
  if (change.position !== undefined) {
    const position = Math.trunc(Number(change.position))
    if (position >= 0 && position <= 7) {
      entry.position = position
      // 位置 set here says where it goes: the old 紧挨着回复 is @深度 0 now.
      switches.cicaSend = false
      if (position === AT_DEPTH && !Number.isFinite(Number(entry.extra?.depth))) switches.depth = entry.extra?.cicaSend === 'near' ? 0 : DEFAULT_DEPTH
    }
  }
  // 聊天中 @深度: how far back.
  if (change.depth !== undefined && change.depth !== null && change.depth !== '') {
    const depth = Math.trunc(Number(change.depth))
    if (Number.isFinite(depth)) switches.depth = Math.min(MAX_DEPTH, Math.max(0, depth))
  }
  for (const [key, value] of Object.entries(switches)) {
    if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') continue
    const extra = { ...(entry.extra ?? {}) }
    // A depth of 0 is one too.
    if (value || typeof value === 'number') extra[key] = value
    else delete extra[key]
    if (Object.keys(extra).length) entry.extra = extra
    else delete entry.extra
  }
  entry.initvar = INITVAR.test(entry.comment) || decoratorsOf(entry.content).has('@@initial_variables')
  entry.hasScript = hasEjs(entry.content)
  return entry
}

/**
 * Edit a book's entries in place (a card's own or an imported one):
 * `{ entries: [{ uid, enabled, constant, caseSensitive, wholeWords, comment, keys, secondaryKeys, content, order, position }], add: { … }, remove: [uid] }`.
 * Returns whether a chat's frozen prefix would now come out different, so the
 * page can say an open chat keeps the old text until it is applied again;
 * keyword entries and templated ones are read every turn.
 */
export function editBook(book, patch = {}) {
  let prefix = false
  let added = null
  const touches = (before, after) => (inPrefix(before) || inPrefix(after)) && PREFIX_FIELDS.some(key => before[key] !== after[key])
  for (const change of Array.isArray(patch.entries) ? patch.entries : []) {
    const entry = book.entries.find(e => e.uid === String(change?.uid))
    if (!entry) continue
    const before = { ...entry }
    if (touches(before, editEntry(entry, change))) prefix = true
  }
  if (patch.add && typeof patch.add === 'object') {
    if (book.entries.length >= MAX_ENTRIES) throw httpError(400, msg`条目太多（最多 ${MAX_ENTRIES} 条）`)
    // SillyTavern numbers entries; the next free number keeps that.
    const taken = new Set(book.entries.map(e => e.uid))
    let uid = book.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1) + 1
    while (taken.has(String(uid))) uid++
    const entry = editEntry(normalizeEntry({ uid, comment: '', content: '' }, uid), patch.add)
    book.entries.push(entry)
    if (inPrefix(entry)) prefix = true
    added = entry.uid
  }
  if (Array.isArray(patch.remove)) {
    const gone = new Set(patch.remove.map(String))
    if (book.entries.some(e => gone.has(e.uid) && inPrefix(e))) prefix = true
    book.entries = book.entries.filter(e => !gone.has(e.uid))
  }
  // 拖动调整顺序: the list's order (the uids named first, in that order; the rest after, as they were). What goes
  // to the model goes by each entry's 顺序 number; constant ones with the same number keep the list's order, so the
  // prefix may change.
  if (Array.isArray(patch.arrange)) {
    const before = constantEntries([book]).map(e => e.uid).join('\n')
    const at = new Map(patch.arrange.map((uid, index) => [String(uid), index]))
    const rank = e => (at.has(e.uid) ? at.get(e.uid) : at.size)
    book.entries = book.entries.map((e, index) => [e, index]).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([e]) => e)
    if (constantEntries([book]).map(e => e.uid).join('\n') !== before) prefix = true
  }
  return { book, prefix, added }
}

/**
 * Copies of entries into a book (移动/复制到): each keeps its number unless the
 * book has it already, and all it carries (its SillyTavern fields too).
 * `prefix`: a constant entry arrived, so chats using the book start differently.
 */
export function addEntries(book, entries) {
  if (book.entries.length + entries.length > MAX_ENTRIES) throw httpError(400, msg`条目太多（最多 ${MAX_ENTRIES} 条）`)
  const taken = new Set(book.entries.map(e => e.uid))
  let next = book.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1) + 1
  const added = []
  let prefix = false
  for (const entry of entries) {
    const copy = structuredClone(entry)
    if (taken.has(copy.uid)) {
      while (taken.has(String(next))) next++
      copy.uid = String(next)
    }
    taken.add(copy.uid)
    book.entries.push(copy)
    added.push(copy.uid)
    if (inPrefix(copy)) prefix = true
  }
  return { added, prefix }
}

// What SillyTavern gives a new entry, for the fields an entry made here never had.
const WORLD_DEFAULTS = { addMemo: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false, scanDepth: null, useGroupScoring: null, automationId: '', role: null, vectorized: false, sticky: null, cooldown: null, delay: null }

/**
 * A book as SillyTavern's world file (World Info → import): the entries as
 * this app keeps them, over the fields they came with. Books imported before
 * those were kept have only what this app reads. The description and scan
 * depth go along for this app to read back; SillyTavern leaves them alone.
 */
export function worldFile(book) {
  const numbered = book.entries.map(e => e.uid).filter(uid => /^\d+$/.test(uid)).map(Number)
  let next = Math.max(-1, ...numbered) + 1
  const entries = {}
  book.entries.forEach((entry, index) => {
    // SillyTavern numbers its entries; one named otherwise gets the next number.
    const uid = /^\d+$/.test(entry.uid) ? Number(entry.uid) : next++
    const extra = entry.extra ?? {}
    entries[uid] = {
      ...WORLD_DEFAULTS,
      displayIndex: index,
      ...extra,
      uid,
      key: entry.keys,
      keysecondary: entry.secondaryKeys,
      comment: entry.comment,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      selectiveLogic: entry.selectiveLogic,
      order: entry.order,
      position: entry.position,
      disable: !entry.enabled,
      probability: entry.probability,
      useProbability: entry.useProbability,
      caseSensitive: entry.caseSensitive ? true : extra.caseSensitive === null ? null : false,
      matchWholeWords: entry.wholeWords ? true : extra.matchWholeWords === null ? null : false,
    }
  })
  return {
    name: book.name,
    ...(book.description ? { description: book.description } : {}),
    ...(book.scanDepth ? { scanDepth: book.scanDepth } : {}),
    entries,
  }
}
