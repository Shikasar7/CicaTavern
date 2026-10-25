// What a card's own HTML (its message frames, web/compat.js) may read and write
// besides the story turns, in Tavern Helper's terms:
//   - the chat's card-kept variables (Tavern Helper's chat variables);
//   - the books this chat uses, as Tavern Helper's worldbook entries; a card's
//     changes are kept on the chat (`bookOverlay`), never on the book itself, so
//     the card's other chats and its export stay as they were;
//   - the app's own MVU parser (Mvu.parseMessage);
//   - the prompt for a model call the card makes without the chat's history (generateRaw).
import { applyStateUpdates } from './state.mjs'
import { inPrefix, normalizeBook } from './worldbook.mjs'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

// SillyTavern's numbers for an entry's position, role and secondary-key logic, by Tavern Helper's names.
const POSITIONS = ['before_character_definition', 'after_character_definition', 'before_author_note', 'after_author_note', 'at_depth', 'before_example_messages', 'after_example_messages', 'outlet']
const ROLES = ['system', 'user', 'assistant']
const LOGICS = ['and_any', 'not_all', 'not_any', 'and_all']
// What a card may keep in chat variables, at most.
const FRAME_VARS_MAX = 200_000

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyText = key => (typeof key === 'string' ? key : String(key ?? ''))

/** An entry as Tavern Helper's getWorldbook gives it. */
export function thEntry(entry, index = 0) {
  const extra = entry.extra ?? {}
  const uid = /^\d+$/.test(entry.uid) ? Number(entry.uid) : index
  return {
    uid,
    name: entry.comment,
    enabled: entry.enabled !== false,
    strategy: {
      type: entry.constant ? 'constant' : 'selective',
      keys: [...(entry.keys ?? [])],
      keys_secondary: { logic: LOGICS[entry.selectiveLogic] ?? 'and_any', keys: [...(entry.secondaryKeys ?? [])] },
      scan_depth: Number.isFinite(extra.scanDepth) ? extra.scanDepth : 'same_as_global',
    },
    position: {
      type: POSITIONS[entry.position] ?? 'before_character_definition',
      role: ROLES[extra.role] ?? 'system',
      depth: Number.isFinite(extra.depth) ? extra.depth : 4,
      order: entry.order ?? 100,
    },
    content: entry.content ?? '',
    probability: entry.probability ?? 100,
    recursion: { prevent_incoming: extra.excludeRecursion === true, prevent_outgoing: extra.preventRecursion === true, delay_until: extra.delayUntilRecursion || null },
    effect: { sticky: extra.sticky ?? null, cooldown: extra.cooldown ?? null, delay: extra.delay ?? null },
  }
}

const deepMerge = (base, change) => {
  const out = { ...base }
  for (const [key, value] of Object.entries(change ?? {})) out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value
  return out
}

/**
 * A Tavern Helper entry (whole or partial) back to this app's entry: over `base`
 * when the card changed one it read, keeping what this app keeps beside the
 * fields Tavern Helper has (group, depth…); read the way an imported book is.
 */
export function entryFromTh(change, base = null, uid = '0') {
  const th = deepMerge(base ? thEntry(base) : thEntry({ uid, comment: '', content: '', keys: [], secondaryKeys: [], selectiveLogic: 0, constant: false, enabled: true, order: 100, position: 0, probability: 100 }), change)
  const raw = {
    uid: String(th.uid ?? uid),
    comment: String(th.name ?? ''),
    key: (th.strategy?.keys ?? []).map(keyText),
    keysecondary: (th.strategy?.keys_secondary?.keys ?? []).map(keyText),
    selectiveLogic: Math.max(0, LOGICS.indexOf(th.strategy?.keys_secondary?.logic)),
    constant: th.strategy?.type === 'constant',
    disable: th.enabled === false,
    order: Number(th.position?.order ?? 100),
    position: Math.max(0, POSITIONS.indexOf(th.position?.type)),
    probability: Number(th.probability ?? 100),
    useProbability: Number(th.probability ?? 100) < 100,
    content: String(th.content ?? ''),
    caseSensitive: base?.caseSensitive ?? false,
    matchWholeWords: base?.wholeWords ?? false,
    depth: Number(th.position?.depth ?? 4),
    role: Math.max(0, ROLES.indexOf(th.position?.role)),
    ...(Number.isFinite(th.strategy?.scan_depth) ? { scanDepth: th.strategy.scan_depth } : {}),
    excludeRecursion: th.recursion?.prevent_incoming === true,
    preventRecursion: th.recursion?.prevent_outgoing === true,
    delayUntilRecursion: th.recursion?.delay_until || false,
    sticky: th.effect?.sticky ?? null,
    cooldown: th.effect?.cooldown ?? null,
    delay: th.effect?.delay ?? null,
  }
  const [entry] = normalizeBook({ entries: [raw] }, 'x', { standalone: true }).entries
  return base?.extra ? { ...entry, extra: { ...base.extra, ...entry.extra } } : entry
}

/** The books with this chat's own changes (what its card's HTML wrote) on top. */
export function withChatChanges(books, chat) {
  const overlay = chat?.bookOverlay
  if (!isObject(overlay)) return books
  return books.map(book => {
    const changes = overlay[book.id]
    if (!isObject(changes)) return book
    const kept = book.entries.filter(e => changes[e.uid] !== null).map(e => changes[e.uid] ?? e)
    const known = new Set(book.entries.map(e => e.uid))
    const added = Object.entries(changes).filter(([uid, e]) => e && !known.has(uid)).map(([, e]) => e)
    return { ...book, entries: [...kept, ...added] }
  })
}

/**
 * The names a card sees: its own book, the books mounted on it, the global ones.
 * @param books - booksForCard: the card's own first (id card-<id>).
 */
export function bookNames(books, card, globalIds = []) {
  const own = books.find(b => b.id === `card-${card.id}`)
  const named = ids => books.filter(b => ids.includes(b.id)).map(b => b.name)
  return { own: own?.name ?? '', mounted: named(card.worldbookIds ?? []), global: named(globalIds) }
}

/** The book a card means by `name` ('' = its own); its own, then mounted, then global. */
export function bookByName(books, name, card) {
  const wanted = String(name ?? '').trim()
  const own = books.find(b => b.id === `card-${card.id}`)
  if (!wanted) return own ?? null
  return books.find(b => b.name === wanted) ?? null
}

/**
 * A card replaced a book's entries (Tavern Helper replaceWorldbook): stored as
 * this chat's changes against the book. `prefix`: an entry in the frozen prefix
 * changed, so the chat's prompt is rebuilt.
 * @param base - the book as saved (without this chat's changes).
 */
export function writeChatBook(chat, base, entries) {
  if (!Array.isArray(entries)) throw httpError(400, msg`世界书条目要是列表`)
  if (entries.length > 2000) throw httpError(400, msg`条目太多`)
  const [current] = withChatChanges([base], chat)
  const before = new Map(current.entries.map(e => [e.uid, e]))
  let next = current.entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1) + 1
  const seen = new Set()
  const written = entries.filter(isObject).map(change => {
    let uid = change.uid !== undefined && change.uid !== null ? String(change.uid) : String(next++)
    if (seen.has(uid)) uid = String(next++)
    seen.add(uid)
    return entryFromTh({ ...change, uid: Number(uid) }, before.get(uid) ?? null, uid)
  })
  const saved = new Map(base.entries.map(e => [e.uid, e]))
  const changes = {}
  // Changed as the card sees an entry; one it only read back stays the book's own.
  const seenAs = entry => JSON.stringify(thEntry(entry))
  for (const entry of written) {
    const was = saved.get(entry.uid)
    if (!was || seenAs(was) !== seenAs(entry)) changes[entry.uid] = entry
  }
  for (const entry of base.entries) if (!seen.has(entry.uid)) changes[entry.uid] = null
  const overlay = { ...(isObject(chat.bookOverlay) ? chat.bookOverlay : {}) }
  if (Object.keys(changes).length) overlay[base.id] = changes
  else delete overlay[base.id]
  chat.bookOverlay = overlay
  const prefixOf = list => JSON.stringify(list.filter(inPrefix).map(e => [e.uid, e.comment, e.content, e.order, e.position]))
  const [after] = withChatChanges([base], chat)
  return { entries: after.entries.map(thEntry), prefix: prefixOf(current.entries) !== prefixOf(after.entries) }
}

/** What a card keeps in chat variables (Tavern Helper `{ type: 'chat' }`), checked and capped. */
export function setFrameVars(chat, value) {
  if (!isObject(value)) throw httpError(400, msg`变量必须是 JSON 对象`)
  if (JSON.stringify(value).length > FRAME_VARS_MAX) throw httpError(400, msg`界面保存的变量太大`)
  chat.frameVars = value
  return chat
}

/** Mvu.parseMessage: the update commands in `text` applied to `state`; nothing is saved. */
export function parseUpdates(state, text) {
  return applyStateUpdates(isObject(state) ? state : {}, String(text ?? '')).state
}

/**
 * generateRaw: the prompt a card lays out itself. Its ordered prompts are
 * messages of their own or Tavern Helper's placeholders, filled from the card,
 * the player, the story so far and the card's `overrides`.
 * @param history - the story so far as [{ role, content }], newest last.
 */
export function rawRequest({ card, persona, history = [], config = {} }) {
  const overrides = isObject(config.overrides) ? config.overrides : {}
  const recent = Number.isInteger(config.max_chat_history) && config.max_chat_history >= 0 ? history.slice(history.length - config.max_chat_history) : history
  const fill = {
    world_info_before: '',
    world_info_after: '',
    persona_description: persona?.description ?? '',
    char_description: card.description ?? '',
    char_personality: card.personality ?? '',
    scenario: card.scenario ?? '',
    dialogue_examples: card.mesExample ?? '',
  }
  const items = Array.isArray(config.ordered_prompts) && config.ordered_prompts.length
    ? config.ordered_prompts
    : ['char_description', 'char_personality', 'scenario', 'chat_history', 'user_input']
  const out = []
  const push = (role, content) => {
    const text = String(content ?? '').trim()
    if (!text) return
    const last = out.at(-1)
    if (last && last.role === role) last.content += `\n\n${text}`
    else out.push({ role, content: text })
  }
  for (const item of items) {
    if (typeof item === 'string') {
      if (item === 'chat_history') {
        if (typeof overrides.chat_history === 'string') push('user', overrides.chat_history)
        else for (const m of recent) push(m.role, m.content)
      } else if (item === 'user_input') push('user', typeof overrides.user_input === 'string' ? overrides.user_input : config.user_input)
      else if (item in fill) push('system', typeof overrides[item] === 'string' ? overrides[item] : fill[item])
    } else if (isObject(item)) push(item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system', item.content)
  }
  // The system parts lead; any later ones are read as the player's text, which every model accepts.
  const lead = []
  while (out[0]?.role === 'system') lead.push(out.shift().content)
  const messages = out.map(m => (m.role === 'system' ? { role: 'user', content: m.content } : m))
  if (!messages.length || messages.at(-1).role !== 'user') messages.push({ role: 'user', content: typeof config.user_input === 'string' && config.user_input.trim() ? config.user_input : '继续。' })
  return { system: lead.join('\n\n'), messages }
}

/** `/setentryfield`'s field names for a Tavern Helper entry change. */
export function fieldChange(field, value) {
  const text = String(value ?? '')
  const list = () => text.split(/[,，]/).map(k => k.trim()).filter(Boolean)
  switch (String(field || 'content')) {
    case 'content': return { content: text }
    case 'comment': return { name: text }
    case 'key': case 'keys': return { strategy: { keys: list() } }
    case 'keysecondary': return { strategy: { keys_secondary: { keys: list() } } }
    case 'disable': return { enabled: !/^(1|true|on|yes)$/i.test(text) }
    case 'constant': return { strategy: { type: /^(1|true|on|yes)$/i.test(text) ? 'constant' : 'selective' } }
    case 'order': return { position: { order: Number(text) || 0 } }
    case 'probability': return { probability: Number(text) || 0 }
    default: throw httpError(400, msg`不支持修改条目的「${field}」`)
  }
}

