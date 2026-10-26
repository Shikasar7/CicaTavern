// SillyTavern regex scripts (card `extensions.regex_scripts`), shared by the
// server (text sent to the model) and the web UI (text shown to the player).

export const PLACEMENT = Object.freeze({ USER_INPUT: 1, AI_OUTPUT: 2 })

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
export function chatScriptList({ global = [], preset = [], card = [], cardId = '', sets = [] }) {
  const seen = new Set(card.map(s => s.id))
  const attached = []
  for (const set of setsOfCard(sets, cardId)) {
    for (const script of set.scripts ?? []) {
      if (seen.has(script.id)) continue
      seen.add(script.id)
      attached.push(script)
    }
  }
  return [...global, ...preset, ...card, ...attached]
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

/**
 * Run every applicable script over `text`, in order.
 * @param options.placement - PLACEMENT.USER_INPUT or PLACEMENT.AI_OUTPUT.
 * @param options.target - 'display' or 'prompt'.
 * @param options.depth - 0 for the latest message, counting up towards the start.
 * @param options.macros - text => text, applied to replace strings and (per substituteRegex) patterns.
 * @param options.replace - (text, regex, replacer) => text, String.prototype.replace by default; the server's runs
 *   a card's pattern with a bound on its time (server/regex-guard.mjs).
 */
export function applyScripts(text, scripts, { placement, target, depth, macros = t => t, replace = (from, regex, replacer) => from.replace(regex, replacer) }) {
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
