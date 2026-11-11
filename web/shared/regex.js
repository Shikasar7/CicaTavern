// SillyTavern regex scripts (card `extensions.regex_scripts`), shared by the
// server (text sent to the model) and the web UI (text shown to the player).
import { reasoningSpans } from './basic.js'

export const PLACEMENT = Object.freeze({ USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 })

/** The scripts run over worldbook text: as SillyTavern reads it there (a prompt, not the message), only 仅格式提示词 ones. */
export const worldScripts = scripts => scripts.filter(s => !s.disabled && s.promptOnly && s.placement.includes(PLACEMENT.WORLD_INFO))

/**
 * A card's or preset's scripts each with an id of its own, as the editor finds them by: one missing or already
 * used (SillyTavern files may have none, or repeat one) gets `script-<place in the list>`, so the same list
 * gives the same ids. (Saving through server/regex.mjs cleanScripts keeps them.)
 */
export function withUniqueIds(scripts) {
  const taken = new Set(scripts.map(s => s.id).filter(Boolean))
  const seen = new Set()
  return scripts.map((script, index) => {
    if (script.id && !seen.has(script.id)) {
      seen.add(script.id)
      return script
    }
    let id = `script-${index + 1}`
    for (let n = 2; taken.has(id) || seen.has(id); n++) id = `script-${index + 1}-${n}`
    seen.add(id)
    return { ...script, id }
  })
}

/** Keep only the fields the engine reads; drop anything malformed. */
export function normalizeScripts(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter(s => s && typeof s === 'object' && typeof s.findRegex === 'string' && s.findRegex !== '')
    .map(s => ({
      id: String(s.id ?? ''),
      scriptName: String(s.scriptName ?? ''),
      findRegex: s.findRegex,
      replaceString: typeof s.replaceString === 'string' ? s.replaceString : '',
      trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings.filter(t => typeof t === 'string' && t) : [],
      placement: Array.isArray(s.placement) ? s.placement.map(Number) : [],
      disabled: s.disabled === true,
      markdownOnly: s.markdownOnly === true,
      promptOnly: s.promptOnly === true,
      substituteRegex: Number(s.substituteRegex ?? 0),
      minDepth: Number.isFinite(s.minDepth) ? s.minDepth : null,
      maxDepth: Number.isFinite(s.maxDepth) ? s.maxDepth : null,
      // Not read here (it is for editing a message in SillyTavern), kept so an export gives it back.
      ...(typeof s.runOnEdit === 'boolean' ? { runOnEdit: s.runOnEdit } : {}),
    }))
}

/**
 * The scripts a chat runs, in order: the global ones, its preset's, its card's own, then the 正则集 (regex sets)
 * attached to its card, in the sets' order — after the card's own, where SillyTavern puts scripts added to a card.
 * A script an attached set shares with the card (the same id: a card exported with its sets and imported again)
 * runs once, as the card has it.
 */
export function chatScriptList({ global = [], preset = [], card = [], cardId = '', sets = [], changes = null }) {
  const seen = new Set(card.map(s => s.id))
  const attached = []
  for (const set of setsOfCard(sets, cardId)) {
    for (const script of set.scripts ?? []) {
      if (seen.has(script.id)) continue
      seen.add(script.id)
      attached.push(script)
    }
  }
  return withRegexChanges([...global, ...preset, ...card, ...attached], changes)
}

// ─── A chat's own changes (Tavern Helper's regex functions in a card's script) ───
// A card's script that turns a regex on or off, or rewrites one, changes it for the chat it runs in (chat.regexChanges),
// never the card or the app's settings: the card's other chats and its export stay as they were, as with its books.
// { changed: { [id]: fields }, added: [script] }; a script left out of a replacement list is turned off.

/** `scripts` with a chat's changes: changed fields over each, the chat's own after them all. */
export function withRegexChanges(scripts, changes) {
  if (!changes || typeof changes !== 'object') return scripts
  const changed = changes.changed && typeof changes.changed === 'object' ? changes.changed : {}
  const own = scripts.map(script => (Object.prototype.hasOwnProperty.call(changed, script.id) ? { ...script, ...changed[script.id] } : script))
  return [...own, ...normalizeScripts(Array.isArray(changes.added) ? changes.added : [])]
}

// Tavern Helper's sources, by SillyTavern's placement numbers.
const SOURCES = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 5, reasoning: 6 }

/** A script as Tavern Helper's getTavernRegexes gives it. */
export function thRegex(script) {
  return {
    id: script.id,
    script_name: script.scriptName,
    enabled: !script.disabled,
    find_regex: script.findRegex,
    replace_string: script.replaceString,
    trim_strings: script.trimStrings.slice(),
    source: Object.fromEntries(Object.entries(SOURCES).map(([key, n]) => [key, script.placement.includes(n)])),
    destination: { display: !script.promptOnly, prompt: !script.markdownOnly },
    run_on_edit: script.runOnEdit === true,
    min_depth: script.minDepth,
    max_depth: script.maxDepth,
  }
}

/** A Tavern Helper regex back as a script, over `base` (the one of the same id); null for one without a pattern. */
export function scriptFromTh(regex, base = null) {
  if (!regex || typeof regex !== 'object') return null
  const was = base ?? {}
  const destination = regex.destination && typeof regex.destination === 'object' ? regex.destination : null
  const [script] = normalizeScripts([{
    ...was,
    id: String(regex.id ?? was.id ?? ''),
    scriptName: String(regex.script_name ?? was.scriptName ?? ''),
    findRegex: typeof regex.find_regex === 'string' ? regex.find_regex : was.findRegex,
    replaceString: typeof regex.replace_string === 'string' ? regex.replace_string : was.replaceString,
    trimStrings: Array.isArray(regex.trim_strings) ? regex.trim_strings : was.trimStrings,
    placement: regex.source && typeof regex.source === 'object' ? Object.entries(SOURCES).filter(([key]) => regex.source[key]).map(([, n]) => n) : was.placement,
    disabled: typeof regex.enabled === 'boolean' ? !regex.enabled : was.disabled,
    markdownOnly: destination ? destination.display === true && destination.prompt !== true : was.markdownOnly,
    promptOnly: destination ? destination.prompt === true && destination.display !== true : was.promptOnly,
    minDepth: regex.min_depth !== undefined ? regex.min_depth : was.minDepth,
    maxDepth: regex.max_depth !== undefined ? regex.max_depth : was.maxDepth,
  }])
  return script ?? null
}

const FIELDS = ['scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled', 'markdownOnly', 'promptOnly', 'minDepth', 'maxDepth']

/**
 * A chat's changes after a script replaced the list `base` (one scope's scripts as saved) with `list` (Tavern Helper
 * regexes): `previous` (the chat's changes so far) with this scope's taken anew. A script of `base` not in `list` is
 * turned off; one new to `base` becomes the chat's own. The order is not kept.
 * @param options.own - `base` is the scope the chat's own scripts are listed in (the card's, 'character'): the list
 *   names all of them, so one of its own left out of it is gone. Another scope's replacement leaves them be.
 */
export function regexChanges(base, list, previous = null, { own = false } = {}) {
  const ids = new Set(base.map(script => script.id))
  const changed = Object.fromEntries(Object.entries(previous?.changed ?? {}).filter(([id]) => !ids.has(id)))
  const added = own ? [] : (previous?.added ?? []).filter(script => !ids.has(script.id) && !(list ?? []).some(regex => String(regex?.id ?? '') === script.id))
  const byId = new Map(base.map(script => [script.id, script]))
  const kept = new Set()
  for (const regex of Array.isArray(list) ? list : []) {
    const was = byId.get(String(regex?.id ?? ''))
    const script = scriptFromTh(regex, was)
    if (!script) continue
    if (!was) {
      added.push(script)
      continue
    }
    kept.add(was.id)
    const diff = Object.fromEntries(FIELDS.filter(key => JSON.stringify(script[key]) !== JSON.stringify(was[key])).map(key => [key, script[key]]))
    if (Object.keys(diff).length) changed[was.id] = diff
  }
  for (const script of base) if (!kept.has(script.id) && !script.disabled) changed[script.id] = { disabled: true }
  return Object.keys(changed).length || added.length ? { changed, added } : null
}

/** Tavern Helper's sources and destinations as applyScripts' placement and target. */
export function regexTarget(source, destination) {
  return { placement: SOURCES[source] ?? SOURCES.ai_output, target: destination === 'prompt' ? 'prompt' : 'display' }
}

/** The 正则集 attached to a card, in their order. */
export const setsOfCard = (sets, cardId) => (cardId ? sets.filter(set => Array.isArray(set.cardIds) && set.cardIds.includes(cardId)) : [])

/**
 * Scripts as SillyTavern exports them, every field it reads: its import refuses one without a name, so a
 * nameless one is named by its pattern. One script is saved as it is, several as a list (SillyTavern reads both).
 */
export function stScripts(scripts) {
  return scripts.map(s => ({
    id: s.id,
    scriptName: s.scriptName || s.findRegex.slice(0, 80),
    findRegex: s.findRegex,
    replaceString: s.replaceString,
    trimStrings: s.trimStrings,
    placement: s.placement,
    disabled: s.disabled,
    markdownOnly: s.markdownOnly,
    promptOnly: s.promptOnly,
    runOnEdit: s.runOnEdit ?? false,
    substituteRegex: s.substituteRegex,
    minDepth: s.minDepth,
    maxDepth: s.maxDepth,
  }))
}

/** Same parsing rule as SillyTavern: `/pattern/flags`, otherwise the whole string is the pattern. */
export function regexFromString(input) {
  const match = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(input)
  try {
    return match ? new RegExp(match[1], match[2]) : new RegExp(input)
  } catch {
    return null
  }
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What a script changes: 'display', 'prompt' or 'both'. As SillyTavern reads the flags: markdownOnly the
 * display, promptOnly the prompt, both ticked both; neither edits the message itself, which here is both too.
 */
export const effectOf = script => (script.markdownOnly && !script.promptOnly ? 'display' : script.promptOnly && !script.markdownOnly ? 'prompt' : 'both')

/** The flags for an effect; a script's own flags when its effect stays (both ticked stays so, for SillyTavern). */
export function effectFlags(effect, script = null) {
  if (script && effectOf(script) === effect) return { markdownOnly: script.markdownOnly === true, promptOnly: script.promptOnly === true }
  return { markdownOnly: effect === 'display', promptOnly: effect === 'prompt' }
}

function appliesTo(script, { placement, target, depth }) {
  if (script.disabled || !script.placement.includes(placement)) return false
  const effect = effectOf(script)
  if (target === 'display' && effect === 'prompt') return false
  if (target === 'prompt' && effect === 'display') return false
  if (typeof depth === 'number') {
    if (script.minDepth !== null && script.minDepth >= 0 && depth < script.minDepth) return false
    if (script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) return false
  }
  return true
}

/**
 * The deepest message whose result can still change as it moves back: past this depth no
 * applicable script starts or stops applying. -1 when no script depends on depth.
 */
export function depthWindow(scripts, { placement, target }) {
  let deepest = -1
  for (const script of scripts) {
    if (!appliesTo(script, { placement, target })) continue
    if (script.maxDepth !== null && script.maxDepth >= 0) deepest = Math.max(deepest, script.maxDepth)
    if (script.minDepth !== null && script.minDepth > 0) deepest = Math.max(deepest, script.minDepth - 1)
  }
  return deepest
}

/** A script's pattern with the macros in it filled as its substituteRegex says (1: as they are, 2: escaped); null if it doesn't compile. */
export function patternOf(script, macros = t => t) {
  let source = script.findRegex
  if (script.substituteRegex === 1) source = macros(source)
  else if (script.substituteRegex === 2) source = source.replace(/\{\{[^}]+\}\}/g, m => escapeRegex(macros(m)))
  return regexFromString(source)
}

const FENCED = /```[\s\S]*?```/g
/** The model's thinking blocks and the fenced blocks (a page an earlier script made of the thinking, say) in `text`. */
function closedSpans(text) {
  const spans = reasoningSpans(text)
  for (const match of text.matchAll(FENCED)) spans.push({ inner: match.index + 3, close: match.index + match[0].length - 3, end: match.index + match[0].length })
  return spans
}

/**
 * `replace` that lets no match run out of the model's thinking. Thinking often names the blocks it plans to write
 * (「结尾输出 <choices>…及<fox_tip>」), and a script's `<fox_tip>[\s\S]*?</fox_tip>` would take the mention for the block:
 * from there to the real closing tag goes, the story with it, and the thinking's own closing tag too. So with a fenced
 * block, which is where the thinking is once a script has made a page of it. A match that starts inside one and ends
 * past its closing tag keeps that much as it is; the script then goes on over the rest of the match, as if it had
 * looked again after the block.
 */
function outOfThinking(replace) {
  const safe = (from, regex, replacer) => {
    let spans = null
    let spansOf = null
    return replace(from, regex, (...args) => {
      const named = typeof args.at(-1) === 'object' && args.at(-1) !== null
      const offset = args.at(named ? -3 : -2)
      const whole = args.at(named ? -2 : -1)
      if (typeof offset !== 'number' || typeof whole !== 'string') return replacer(...args)
      if (spansOf !== whole) {
        spansOf = whole
        spans = closedSpans(whole)
      }
      const end = offset + args[0].length
      const span = spans.find(s => offset >= s.inner && offset < s.close && end > s.close)
      if (!span) return replacer(...args)
      const kept = span.end - offset
      return args[0].slice(0, kept) + safe(args[0].slice(kept), new RegExp(regex.source, regex.flags), replacer)
    })
  }
  return safe
}

/**
 * Run every applicable script over `text`, in order.
 * @param options.placement - a PLACEMENT.
 * @param options.target - 'display' or 'prompt'.
 * @param options.depth - 0 for the latest message, counting up towards the start.
 * @param options.macros - text => text, applied to replace strings and (per substituteRegex) patterns.
 * @param options.replace - (text, regex, replacer) => text, String.prototype.replace by default; the server's runs
 *   a card's pattern with a bound on its time (server/regex-guard.mjs).
 */
export function applyScripts(text, scripts, { placement, target, depth, macros = t => t, replace: plain = (from, regex, replacer) => from.replace(regex, replacer) }) {
  const replace = outOfThinking(plain)
  let out = String(text ?? '')
  for (const script of scripts) {
    if (!appliesTo(script, { placement, target, depth })) continue
    const regex = patternOf(script, macros)
    if (!regex) continue
    const trims = script.trimStrings.map(t => macros(t))
    out = replace(out, regex, (...args) => {
      const hasNamed = typeof args.at(-1) === 'object' && args.at(-1) !== null
      const groups = args.slice(1, hasNamed ? -3 : -2)
      const named = hasNamed ? args.at(-1) : {}
      const trim = value => trims.reduce((acc, t) => acc.split(t).join(''), value ?? '')
      // As SillyTavern reads it: {{match}} is $0 (the whole match), then one pass over $n and $<name>, so what a match
      // brings in ("it costs $10") is never read for them again. A group that is missing or empty gives ''.
      const values = [args[0], ...groups]
      const replaced = script.replaceString
        .replace(/\{\{match\}\}/gi, () => '$0')
        .replace(/\$(\d+)|\$<([^>]+)>/g, (whole, index, name) => trim((name !== undefined ? named[name] : values[Number(index)]) || ''))
      return macros(replaced)
    })
  }
  return out
}

/** The scripts a SillyTavern file holds: one script, a list of them, or a card/preset's regex_scripts. */
export function scriptsInFile(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.regex_scripts) ? json.regex_scripts : Array.isArray(json?.extensions?.regex_scripts) ? json.extensions.regex_scripts : [json]
  return list.filter(s => s && typeof s === 'object' && typeof s.findRegex === 'string' && s.findRegex)
}

/** Whether a file is SillyTavern regex on its own (the importer sends it to 正则), not a card or a preset carrying some. */
export const isRegexFile = json => scriptsInFile(json).length > 0 && !json?.spec && !json?.data && !json?.prompts && json?.first_mes === undefined && json?.char_name === undefined
