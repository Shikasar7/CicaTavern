// 你的角色 and 文风 (设置 → 写作): the player's personas and writing styles, each
// a list with one default, and each card free to pick one of each for its new
// chats. A chat keeps what it started with (chats.mjs): its own pick, else its
// card's, else the default. Shared by the server (store.mjs cleans what it
// saves, the import route reads files) and the page (web/personas.js exports).
// Personas go out as SillyTavern's persona backup (Persona Management → Backup,
// Restore there); a style as SillyTavern's system prompt (Advanced Formatting →
// import).

/** The id of the item an install from before the lists started with (persona.json, settings.writingRules). */
export const DEFAULT_ITEM = 'default'

const SAFE_ID = /^[\w-]{1,64}$/
const NAME_MAX = 80
const TEXT_MAX = 100_000
const text = (value, max = TEXT_MAX) => (typeof value === 'string' ? value : '').slice(0, max)
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A persona as the list keeps it: `name` is the player's name in the story ({{user}}), `title` a note in the list. */
export function cleanPersona(item) {
  return { id: text(item?.id, 64), name: text(item?.name, NAME_MAX).trim() || '你', title: text(item?.title, NAME_MAX).trim(), description: text(item?.description) } // i18n-ignore: the default name is for the model
}

/** A style as the list keeps it: `name` is only for the list, `text` goes into the prefix as 文风与写作要求. */
export function cleanStyle(item) {
  return { id: text(item?.id, 64), name: text(item?.name, NAME_MAX).trim(), text: text(item?.text) }
}

export const KINDS = Object.freeze({
  persona: { clean: cleanPersona, fallback: () => cleanPersona({ id: DEFAULT_ITEM }) },
  style: { clean: cleanStyle, fallback: () => cleanStyle({ id: DEFAULT_ITEM }) },
})

/**
 * A list as saved: { defaultId, items, cards } — never empty, each id once and fit for a URL, the default one of the
 * items, and `cards` (card id → item id) naming only items that are there.
 */
export function cleanList(kind, value) {
  const { clean, fallback } = KINDS[kind]
  const seen = new Set()
  const items = []
  for (const raw of Array.isArray(value?.items) ? value.items : []) {
    const item = clean(raw)
    if (!SAFE_ID.test(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  if (!items.length) items.push(fallback())
  const has = id => items.some(item => item.id === id)
  const defaultId = has(value?.defaultId) ? value.defaultId : items[0].id
  const cards = {}
  for (const [cardId, id] of Object.entries(isRecord(value?.cards) ? value.cards : {})) {
    if (SAFE_ID.test(cardId) && has(id)) cards[cardId] = id
  }
  return { defaultId, items, cards }
}

export const itemOf = (list, id) => (typeof id === 'string' && id ? list.items.find(item => item.id === id) ?? null : null)
export const defaultOf = list => itemOf(list, list.defaultId) ?? list.items[0]
/** The item a card picked for its new chats, or null (it uses the default). */
export const cardPick = (list, cardId) => itemOf(list, list.cards[cardId])
/** What a chat uses: `own` (the chat's) while it is there, else its card's pick, else the default. */
export const pickFor = (list, cardId, own = null) => itemOf(list, own) ?? cardPick(list, cardId) ?? defaultOf(list)
/** The cards that picked an item. */
export const cardsOf = (list, id) => Object.keys(list.cards).filter(cardId => list.cards[cardId] === id)

// ─── Files ──────────────────────────────────────────────────────────────

/** The key a persona has in SillyTavern's backup: its avatar file there (Restore makes one with the default picture). */
const stKey = item => `cicatavern-${item.id}.png`

/**
 * Personas as SillyTavern's persona backup ({ personas, persona_descriptions }), which its Persona Management
 * restores (one exported again is skipped there, not doubled). Which cards picked them stays here.
 */
export function stPersonas(items) {
  const personas = {}
  const descriptions = {}
  for (const item of items) {
    personas[stKey(item)] = item.name
    descriptions[stKey(item)] = { description: item.description, position: 0, depth: 2, role: 0, lorebook: '', connections: [], title: item.title }
  }
  return { personas, persona_descriptions: descriptions }
}

/** One style as SillyTavern's system prompt file, several as a list of them; nameless ones get `fallbackName`. */
export function stStyles(items, fallbackName = 'CicaTavern') {
  const files = items.map(item => ({ name: item.name || fallbackName, content: item.text }))
  return files.length === 1 ? files[0] : files
}

/**
 * The personas in a file: SillyTavern's persona backup, or one or a list of { name, description, title? }.
 * Nothing else: [] for a file that is not one.
 */
export function personasInFile(json) {
  if (isRecord(json?.personas) && isRecord(json.persona_descriptions)) {
    return Object.entries(json.personas)
      .filter(([, name]) => typeof name === 'string')
      .map(([key, name]) => {
        const more = isRecord(json.persona_descriptions[key]) ? json.persona_descriptions[key] : {}
        return cleanPersona({ name, title: more.title, description: more.description })
      })
  }
  const list = Array.isArray(json) ? json : [json]
  // A character card has a name and a description too: not a persona.
  const persona = item => isRecord(item) && typeof item.name === 'string' && typeof item.description === 'string' && !('first_mes' in item) && !('spec' in item)
  return list.filter(persona).map(cleanPersona)
}

/**
 * The styles in a file: SillyTavern's system prompt ({ name, content }), a list of them, its Advanced Formatting
 * export ({ sysprompt: { … } }), or { name, text }. Plain text (a .txt or .md that is not JSON) is one style named
 * after the file. [] for a file that is none of these.
 */
export function stylesInFile(source, filename = '') {
  let json
  try {
    json = JSON.parse(source)
  } catch {
    const plain = String(source ?? '').trim()
    return plain ? [cleanStyle({ name: String(filename).replace(/\.[^.]*$/, ''), text: plain })] : []
  }
  if (isRecord(json?.sysprompt)) json = json.sysprompt
  const list = Array.isArray(json) ? json : [json]
  return list
    .filter(item => isRecord(item) && (typeof item.content === 'string' || typeof item.text === 'string'))
    .map(item => cleanStyle({ name: item.name, text: typeof item.content === 'string' ? item.content : item.text }))
}

/** Whether two items say the same (an import skips one the list has already). */
export function sameItem(kind, a, b) {
  return kind === 'persona' ? a.name === b.name && a.title === b.title && a.description === b.description : a.name === b.name && a.text === b.text
}
