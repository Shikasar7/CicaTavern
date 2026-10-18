// How each worldbook entry of a created card is set up: always sent or only
// when its keywords come up, where it goes in the context, and in what order.
// Worked out from the plan by rules, never by the model, so the same plan
// always gives the same card:
//   - world rules, play rules and history are always there, before the character;
//   - each core character's sheet and palette are always there while the cast is
//     small, and turn into keyword entries as it grows (basic from 5, the rest from 2);
//   - side characters and one-off events only come in when named;
//   - places are always there until there are 4 or more of them;
//   - the "how to read this character" notes (rephrase) go last, at the very end
//     of the context, where they correct the model's habits best;
//   - state tracking: its initial values are never sent; its rules sit at the end.

// Where an entry goes: before or after the character definition, or at depth 0.
export const POSITION = { before: 0, after: 1, depth: 4 }

const BEFORE = ['世界观', '扮演准则', '时间线', '地理']
const AFTER = ['角色', 'NPC']
const DEPTH = ['事件', '状态']
export const ENTRY_TYPES = [...BEFORE, ...AFTER, ...DEPTH]

// Count at or above which an entry turns from always-sent into keyword-only;
// Infinity: always sent; 0: always keyword-only; null: never sent (data only).
const THRESHOLD = {
  世界观: Infinity,
  扮演准则: Infinity,
  时间线: Infinity,
  地理: 4,
  角色: { basic: 5, personality: 2, facets: 2, other: 2, catalog: Infinity },
  NPC: 0,
  事件: 0,
  状态: { initvar: null, variables: Infinity, rules: Infinity, format: Infinity },
}

const SPLIT = /[-_\s/·・]+/

/** A threshold for one entry, by its type and part. */
function thresholdOf(entry) {
  const value = THRESHOLD[entry.type]
  if (value === undefined) return Infinity
  if (typeof value === 'number' || value === null) return value
  return entry.part in value ? value[entry.part] : value.other ?? Infinity
}

/** What the count is for each type: core characters for 角色, places for 地理. */
function countsOf(entries) {
  const core = new Set(entries.filter(e => e.type === '角色' && e.part === 'basic').map(e => e.owner || e.name))
  const places = entries.filter(e => e.type === '地理' && !e.rephrase).length
  return { 角色: core.size, 地理: places }
}

/**
 * The entries with { strategy: 'constant' | 'keyword' | 'off', position, order }
 * added. Entries keep their order within a type; a type's entries that share a
 * name part or keyword (one character's sheet, palette and notes) stay in one
 * block of ten.
 */
export function configureEntries(input) {
  const entries = input.map(entry => ({ ...entry, keywords: [...(entry.keywords ?? [])] }))
  const counts = countsOf(entries)
  for (const entry of entries) {
    const threshold = thresholdOf(entry)
    const count = counts[entry.type] ?? 0
    if (threshold === null) entry.strategy = 'off'
    else if (entry.part === 'catalog' || threshold === Infinity) entry.strategy = 'constant'
    else entry.strategy = count >= threshold ? 'keyword' : 'constant'
    // A keyword entry with no keywords would never be sent: keep it in.
    if (entry.strategy === 'keyword' && !entry.keywords.length) entry.strategy = 'constant'
    entry.position = entry.rephrase || DEPTH.includes(entry.type) ? 'depth' : AFTER.includes(entry.type) ? 'after' : 'before'
  }

  // Orders: from 10 up, one block of ten per type (and per group inside a type);
  // the rephrase notes last, in reverse, so the first character's are nearest the end.
  const nextBlock = n => Math.ceil(n / 10) * 10
  let order = 10
  const notes = []
  for (const type of ENTRY_TYPES) {
    let group = null
    for (const entry of entries.filter(e => e.type === type)) {
      if (entry.rephrase) {
        notes.push(entry)
        continue
      }
      const words = new Set([...String(entry.owner || entry.name).split(SPLIT), ...entry.keywords].filter(Boolean))
      const joins = group && [...words].some(word => group.has(word))
      if (group && !joins) order = nextBlock(order)
      group = joins ? new Set([...group, ...words]) : words
      entry.order = order++
    }
    if (group) order = nextBlock(order)
  }
  for (const entry of notes.reverse()) entry.order = order++
  return entries
}

/** The entry as SillyTavern's embedded worldbook keeps it (character_book, V3). */
export function toBookEntry(entry, index) {
  const constant = entry.strategy === 'constant'
  return {
    id: index,
    keys: entry.keywords,
    secondary_keys: [],
    comment: entry.name,
    content: entry.content ?? '',
    constant,
    selective: !constant,
    insertion_order: entry.order,
    enabled: entry.strategy !== 'off',
    position: entry.position === 'before' ? 'before_char' : 'after_char',
    use_regex: true,
    extensions: {
      position: POSITION[entry.position],
      exclude_recursion: true,
      prevent_recursion: true,
      delay_until_recursion: false,
      display_index: index,
      probability: 100,
      useProbability: true,
      depth: 0,
      role: 0,
      selectiveLogic: 0,
      group: '',
      group_override: false,
      group_weight: 100,
      use_group_scoring: false,
      scan_depth: null,
      match_whole_words: null,
      case_sensitive: null,
      vectorized: false,
      sticky: 0,
      cooldown: 0,
      delay: 0,
    },
  }
}
