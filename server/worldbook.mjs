// Worldbook normalization and keyword activation. Accepts both the card-embedded
// `character_book` shape and SillyTavern's standalone world file shape.
import YAML from 'yaml'
import { httpError, newId } from './store.mjs'
import { decoratorsOf, hasTemplate, splitDecorators } from './template.mjs'
import { hasVariableMacros } from '../web/shared/vars.js'
import { msg } from './i18n.mjs'

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
const SCRIPT = /<%[\s\S]*?%>/

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

function normalizeEntry(raw, index, { keep = false } = {}) {
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  const comment = str(raw.comment || raw.name).trim()
  const content = str(raw.content)
  const extra = keep ? extraOf(raw) : {}
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
    // 0 before the character data, 1 after it (presets place the two apart).
    position: typeof raw.position === 'number' ? raw.position : Number.isFinite(ext.position) ? ext.position : raw.position === 'after_char' ? 1 : 0,
    caseSensitive: (raw.case_sensitive ?? raw.caseSensitive ?? ext.case_sensitive) === true,
    wholeWords: (raw.matchWholeWords ?? ext.match_whole_words) === true,
    probability: Number(raw.probability ?? ext.probability ?? 100),
    useProbability: (raw.useProbability ?? ext.useProbability) === true,
    initvar: INITVAR.test(comment) || decoratorsOf(content).has('@@initial_variables'),
    hasScript: SCRIPT.test(content),
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
  return splitDecorators(entry.content).body.replace(/<%[\s\S]*?%>/g, '').trim()
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

function readInitvar(entries, render) {
  let state = {}
  for (const entry of entries) {
    try {
      const parsed = YAML.parse(render(entry))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = { ...state, ...parsed }
    } catch {
      // A malformed initvar entry is ignored; the card still plays without state.
    }
  }
  return state
}

/**
 * Initial state from `[initvar]`-style entries (JSON or YAML).
 * @param render - entry => its text to parse; by default its EJS is taken out
 *   (chats.mjs renders it once when a chat starts, as ST-Prompt-Template does).
 */
export function initialState(books, render = entryText) {
  // Initvar entries are usually disabled (so they never reach the model) — still read them.
  return readInitvar(books.flatMap(book => book.entries.filter(isInitvar)), render)
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
 */
export function isLate(entry) {
  return entry.position >= 2 && entry.position <= 4
}

/** Static constant entries: rendered into a chat's frozen prefix when it starts. */
export const inPrefix = e => e.enabled && isConstant(e) && !special(e) && !isDynamic(e)

/** Constant entries that never change: they go into the cached prefix. */
export function constantEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => inPrefix(e) && !isLate(e))))
}

/**
 * Static constant entries meant for the end of the context. They also go into
 * the cached prefix (last, under the every-turn rules), and each turn carries a
 * one-line reminder naming them: re-sending their full text every turn would
 * pile up in the history, and the history cannot be edited without losing the
 * cache for everything after the edit.
 */
export function lateEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => inPrefix(e) && isLate(e))))
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
      return text => re.test(text)
    } catch {
      return () => false
    }
  }
  const needle = entry.caseSensitive ? key : key.toLowerCase()
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

/**
 * Keyword-triggered entries for this turn.
 * @param books - active books.
 * @param scanText - recent story text plus the player's input, or a function
 *   giving it for a book (a book may scan its own number of messages).
 * @param recentlyInjected - `${bookId}:${uid}` refs still visible in recent turns.
 */
export function triggeredEntries(books, scanText, recentlyInjected) {
  const hits = []
  for (const book of books) {
    const text = typeof scanText === 'function' ? scanText(book) : scanText
    for (const entry of book.entries) {
      if (!entry.enabled || entry.constant || special(entry)) continue
      const decorators = decoratorsOf(entry.content)
      if (decorators.has('@@activate') || decorators.has('@@dont_activate')) continue
      const ref = `${book.id}:${entry.uid}`
      if (recentlyInjected.has(ref)) continue
      if (!entryMatches(entry, text)) continue
      if (entry.useProbability && entry.probability < 100 && Math.random() * 100 >= entry.probability) continue
      hits.push({ ref, entry })
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
  if (change.position !== undefined) {
    const position = Math.trunc(Number(change.position))
    if (position >= 0 && position <= 7) entry.position = position
  }
  entry.initvar = INITVAR.test(entry.comment) || decoratorsOf(entry.content).has('@@initial_variables')
  entry.hasScript = SCRIPT.test(entry.content)
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
