// 卡片界面权限: what a card's own interface (the HTML it draws in replies) may do
// without a click from the player, asked once per card and kept in this browser:
// send what is in the input box as a turn ('send'), call the model ('generate'),
// and reach an address through the app ('relay', per address; 'local' once more
// for one on this computer or the local network). A no is kept as a yes is, so a
// card cannot ask again and again; both are changed in the card's menu
// (web/card-permissions.js).

export const PERMISSIONS_KEY = 'agent-tavern:frame-permissions'
// Before: the cards allowed to call the model, and per card the addresses allowed (a no lasted until a reload).
const OLD_GENERATE = 'agent-tavern:frame-generate'
const OLD_RELAY = 'agent-tavern:frame-relay'
const OLD_LOCAL = 'agent-tavern:frame-relay-local'

const DECISIONS = new Set(['allow', 'deny'])
const PER_ADDRESS = new Set(['relay', 'local'])
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Only what this file writes: { [cardId]: { send, generate, relay: { [origin]: decision }, local: { … } } }. */
function clean(all) {
  const out = {}
  if (!isObject(all)) return out
  for (const [cardId, entry] of Object.entries(all)) {
    if (!isObject(entry)) continue
    const kept = {}
    for (const kind of ['send', 'generate']) if (DECISIONS.has(entry[kind])) kept[kind] = entry[kind]
    for (const kind of PER_ADDRESS) {
      if (!isObject(entry[kind])) continue
      const origins = Object.fromEntries(Object.entries(entry[kind]).filter(([, decision]) => DECISIONS.has(decision)))
      if (Object.keys(origins).length) kept[kind] = origins
    }
    if (Object.keys(kept).length) out[cardId] = kept
  }
  return out
}

/**
 * @param storage - localStorage, or anything with getItem / setItem / removeItem. It may be missing or throw
 *   (private mode, blocked site data): the answers then last until the page is closed.
 */
export function createFramePermissions(storage) {
  let memory = null

  function readOld(key) {
    try {
      return JSON.parse(storage.getItem(key) || 'null')
    } catch {
      return null
    }
  }

  /** What the keys before this one allowed, moved over once. */
  function migrate() {
    const all = {}
    const entry = cardId => (all[cardId] ??= {})
    const generate = readOld(OLD_GENERATE)
    if (Array.isArray(generate)) for (const cardId of generate) if (typeof cardId === 'string') entry(cardId).generate = 'allow'
    for (const [key, kind] of [[OLD_RELAY, 'relay'], [OLD_LOCAL, 'local']]) {
      const map = readOld(key)
      if (!isObject(map)) continue
      for (const [cardId, origins] of Object.entries(map)) {
        if (!Array.isArray(origins)) continue
        for (const origin of origins) if (typeof origin === 'string') (entry(cardId)[kind] ??= {})[origin] = 'allow'
      }
    }
    const moved = clean(all)
    if (save(moved)) {
      for (const key of [OLD_GENERATE, OLD_RELAY, OLD_LOCAL]) {
        try {
          storage.removeItem(key)
        } catch {
          // Left behind: read again only if the new key goes missing.
        }
      }
    }
    return moved
  }

  function load() {
    let text
    try {
      text = storage.getItem(PERMISSIONS_KEY)
    } catch {
      return memory ?? {}
    }
    if (text === null) return memory ?? migrate()
    try {
      return clean(JSON.parse(text))
    } catch {
      return {}
    }
  }

  /** @returns whether it reached the storage. */
  function save(all) {
    memory = all
    try {
      storage.setItem(PERMISSIONS_KEY, JSON.stringify(all))
      return true
    } catch {
      return false
    }
  }

  return {
    /** 'allow', 'deny', or undefined when the card has not been asked. `origin` for 'relay' and 'local'. */
    decision(cardId, kind, origin) {
      const entry = load()[cardId]
      return PER_ADDRESS.has(kind) ? entry?.[kind]?.[origin] : entry?.[kind]
    },

    /**
     * Keep an answer; null forgets it (asked again next time). A changed answer for an address forgets its
     * 'local' one too, so the question about this computer or the local network comes again.
     */
    decide(cardId, kind, decision, origin) {
      const all = load()
      const entry = { ...all[cardId] }
      const value = DECISIONS.has(decision) ? decision : null
      if (PER_ADDRESS.has(kind)) {
        const origins = { ...entry[kind] }
        if (value) origins[origin] = value
        else delete origins[origin]
        entry[kind] = origins
        if (kind === 'relay' && entry.local) {
          entry.local = { ...entry.local }
          delete entry.local[origin]
        }
      } else if (value) entry[kind] = value
      else delete entry[kind]
      save(clean({ ...all, [cardId]: entry }))
    },

    /** The addresses a card may reach through the app ('relay'), or those allowed as local ones ('local'). */
    allowedOrigins(cardId, kind = 'relay') {
      return Object.entries(load()[cardId]?.[kind] ?? {})
        .filter(([, decision]) => decision === 'allow')
        .map(([origin]) => origin)
    },

    /** Everything kept for a card, for the panel: { send, generate, relay, local }. */
    of(cardId) {
      const entry = load()[cardId] ?? {}
      return { send: entry.send, generate: entry.generate, relay: { ...entry.relay }, local: { ...entry.local } }
    },
  }
}
