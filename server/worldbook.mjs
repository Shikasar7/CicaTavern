// Worldbook normalization and keyword activation. Accepts both the card-embedded
// `character_book` shape and SillyTavern's standalone world file shape.
import YAML from 'yaml'
import { httpError, newId } from './store.mjs'
import { hasTemplate, splitDecorators } from './template.mjs'
import { hasVariableMacros } from '../web/shared/vars.js'

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

function normalizeEntry(raw, index) {
  const ext = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {}
  const comment = str(raw.comment || raw.name).trim()
  const content = str(raw.content)
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
    // MVU-style cards keep the initial variables in an entry, not in the prompt.
    initvar: /initvar|初始变量|\[init/i.test(comment),
    hasScript: /<%[\s\S]*?%>/.test(content),
  }
}

export function normalizeBook(input, fallbackName = '世界书') {
  if (!input || typeof input !== 'object') throw httpError(400, '世界书格式无效')
  const rawEntries = Array.isArray(input.entries)
    ? input.entries
    : input.entries && typeof input.entries === 'object'
      ? Object.values(input.entries)
      : null
  if (!rawEntries) throw httpError(400, '世界书里没有 entries')
  return {
    id: newId(),
    name: str(input.name).trim() || fallbackName,
    entries: rawEntries.filter(e => e && typeof e === 'object').map(normalizeEntry),
    importedAt: new Date().toISOString(),
  }
}

/** Entry text with any EJS removed (used when a template cannot be rendered). */
export function entryText(entry) {
  return splitDecorators(entry.content).body.replace(/<%[\s\S]*?%>/g, '').trim()
}

/** Initial state from `[initvar]`-style entries (JSON or YAML). */
export function initialState(books) {
  let state = {}
  for (const book of books) {
    for (const entry of book.entries) {
      // Initvar entries are usually disabled (so they never reach the model) — still read them.
      if (!entry.initvar) continue
      try {
        const parsed = YAML.parse(entryText(entry))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = { ...state, ...parsed }
      } catch {
        // A malformed initvar entry is ignored; the card still plays without state.
      }
    }
  }
  return state
}

/**
 * An entry whose text depends on game state (EJS or variable macros) cannot
 * live in the frozen prefix; it is rendered with the current state every turn.
 */
export function isDynamic(entry) {
  return hasTemplate(entry.content) || hasVariableMacros(entry.content)
}

/**
 * SillyTavern positions 2–4 (author's note top/bottom, @depth) put an entry
 * near the end of the context, usually rules the model must apply every turn
 * (MVU's 变量输出格式 / 变量更新规则 sit at @D0).
 */
export function isLate(entry) {
  return entry.position >= 2 && entry.position <= 4
}

const isStaticConstant = e => e.enabled && e.constant && !e.initvar && !isDynamic(e)

/** Constant entries that never change: they go into the cached prefix. */
export function constantEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => isStaticConstant(e) && !isLate(e))))
}

/**
 * Static constant entries meant for the end of the context. They also go into
 * the cached prefix (last, under the every-turn rules), and each turn carries a
 * one-line reminder naming them: re-sending their full text every turn would
 * pile up in the history, and the history cannot be edited without losing the
 * cache for everything after the edit.
 */
export function lateEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => isStaticConstant(e) && isLate(e))))
}

export function entryTitle(entry) {
  return entry.comment || entryText(entry).replace(/\s+/g, ' ').slice(0, 16)
}

/** Constant entries rendered fresh each turn, at the tail. */
export function dynamicEntries(books) {
  return sortEntries(books.flatMap(book => book.entries.filter(e => e.enabled && e.constant && !e.initvar && isDynamic(e))))
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
 * @param scanText - recent story text plus the player's input.
 * @param recentlyInjected - `${bookId}:${uid}` refs still visible in recent turns.
 */
export function triggeredEntries(books, scanText, recentlyInjected) {
  const hits = []
  for (const book of books) {
    for (const entry of book.entries) {
      if (!entry.enabled || entry.constant || entry.initvar) continue
      const ref = `${book.id}:${entry.uid}`
      if (recentlyInjected.has(ref)) continue
      if (!entryMatches(entry, scanText)) continue
      if (entry.useProbability && entry.probability < 100 && Math.random() * 100 >= entry.probability) continue
      hits.push({ ref, entry })
    }
  }
  return hits.sort((a, b) => a.entry.order - b.entry.order)
}
