// Prompts a card's scripts inject (Tavern Helper injectPrompts / uninjectPrompts), kept on the chat they were made in
// (`chat.scriptInjections`), as Tavern Helper keeps them to the chat file. Made by a script on the server
// (card-scripts.mjs) or in a frame on the page (web/compat.js, through the chat's /injections route), read by the turn
// (engine.mjs buildPrompt). The history is cached as sent, so an injection goes into the turn's own message, not back
// among earlier messages: at depth 0 after the player's input, deeper ones before it. `once` ones go after the next turn.

const MAX_PROMPTS = 50
const MAX_CHARS = 60_000
const ROLES = new Set(['system', 'assistant', 'user'])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One prompt as a script wrote it, checked; null for one without an id. A `filter` function cannot be kept: the prompt counts as on. */
function cleanPrompt(prompt, once) {
  if (!isObject(prompt) || prompt.id === undefined || prompt.id === null) return null
  return {
    id: String(prompt.id).slice(0, 120),
    position: prompt.position === 'none' ? 'none' : 'in_chat',
    depth: Math.max(0, Math.min(1000, Math.round(Number(prompt.depth) || 0))),
    role: ROLES.has(prompt.role) ? prompt.role : 'system',
    content: String(prompt.content ?? ''),
    scan: prompt.should_scan === true || prompt.position === 'none',
    ...(once ? { once: true } : {}),
  }
}

/**
 * `prompts` injected into `chat` (replacing those of the same id). → whether the chat changed: a script that injects
 * the same prompts again each time its chat opens changes nothing.
 */
export function injectPrompts(chat, prompts, { once = false } = {}) {
  const added = (Array.isArray(prompts) ? prompts : [prompts]).map(prompt => cleanPrompt(prompt, once)).filter(Boolean)
  if (!added.length) return false
  const ids = new Set(added.map(prompt => prompt.id))
  const next = [...(chat.scriptInjections ?? []).filter(prompt => !ids.has(prompt.id)), ...added].slice(-MAX_PROMPTS)
  let total = 0
  const kept = next.filter(prompt => (total += prompt.content.length) <= MAX_CHARS)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const was = chat.scriptInjections ?? []
  // The same prompts again: they stay where they were.
  if (kept.length === was.length && kept.every(prompt => was.some(old => same(old, prompt)))) return false
  chat.scriptInjections = kept
  return true
}

/** The prompts of `ids` taken out of `chat`. → whether any was there. */
export function uninjectPrompts(chat, ids) {
  const gone = new Set((Array.isArray(ids) ? ids : [ids]).map(String))
  const before = chat.scriptInjections ?? []
  const kept = before.filter(prompt => !gone.has(prompt.id))
  if (kept.length === before.length) return false
  if (kept.length) chat.scriptInjections = kept
  else delete chat.scriptInjections
  return true
}

/**
 * What a turn makes of `chat`'s injections: `before` and `after` the player's input (by depth, deepest first), and
 * `scan`, the text keyword entries also look through.
 */
export function turnInjections(chat) {
  const list = chat.scriptInjections ?? []
  const sent = list.filter(prompt => prompt.position === 'in_chat' && prompt.content.trim())
  const item = prompt => ({ title: '', text: prompt.content })
  return {
    before: sent.filter(prompt => prompt.depth > 0).sort((a, b) => b.depth - a.depth).map(item),
    after: sent.filter(prompt => prompt.depth === 0).map(item),
    scan: list.filter(prompt => prompt.scan).map(prompt => prompt.content).join('\n'),
  }
}

/** After a turn: its `once` injections go. → whether any went. */
export function afterTurn(chat) {
  const before = chat.scriptInjections ?? []
  const kept = before.filter(prompt => !prompt.once)
  if (kept.length === before.length) return false
  if (kept.length) chat.scriptInjections = kept
  else delete chat.scriptInjections
  return true
}
