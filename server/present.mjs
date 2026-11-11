// 只发在场角色的变量 (设置 → 世界书与状态 → 扫描与状态). A card with a large cast keeps a group of variables for
// each of them, and <当前状态> sent whole is mostly people who are nowhere near the scene. When the state is long,
// the groups of characters not around are left out of it and named in a line; the turn one of them shows up, their
// group is sent on its own. Everything else in the state goes as it always did.
//
// A group is a character's when the card says so: its name is in the cast (配图's 角色名册; their 别称 are names they
// go by), or is a keyword of a worldbook entry sent on keywords (that entry's keywords are then the names). What the card does not
// name (the world's own values, the player's, a bag, a book of rows) is never left out.

/** Shorter than this as it would be sent, a state goes whole. */
export const PRESENT_MIN = 2000
// How far down a group is looked for: 林雪.好感, 角色.林雪.好感, 世界.角色.林雪.好感.
const MAX_DEPTH = 3
// Keys a card uses for the player's own values, besides their name.
const PLAYER_KEYS = ['<user>', '{{user}}', 'user', 'player', 'you', 'protagonist', '你', '玩家', '主角']

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const lower = text => String(text ?? '').trim().toLowerCase()

/**
 * Who a card's state can be about: { groups: Map of a name → the words that say they are around, own: the keys the
 * player's own values go under (nothing in there is anyone else's) }.
 * @param roster - the card's cast (card.media.roster). @param books - the books the chat reads.
 * @param player - names the player goes by.
 */
export function castNames({ roster = [], books = [], player = [] } = {}) {
  const groups = new Map()
  const add = (name, words) => {
    const key = String(name ?? '').trim()
    if (!key) return
    groups.set(key, [...new Set([...(groups.get(key) ?? [key]), ...words.map(word => String(word ?? '').trim()).filter(Boolean)])])
  }
  // 别称 in the cast is one line, the names apart by commas.
  for (const item of Array.isArray(roster) ? roster : []) if (item && !item.player) add(item.name, String(item.aliases ?? '').split(/[,，、;；]/))
  for (const book of books) {
    for (const entry of book?.entries ?? []) {
      if (entry.enabled === false || entry.constant) continue
      // A pattern is no name; the plain keywords of an entry are the names of one thing.
      const keys = (entry.keys ?? []).filter(key => typeof key === 'string' && key.trim() && !key.trim().startsWith('/'))
      for (const key of keys) add(key, keys)
    }
  }
  const own = new Set([...PLAYER_KEYS, ...player.map(lower)].filter(Boolean))
  for (const name of [...groups.keys()]) if (own.has(lower(name))) groups.delete(name)
  return { groups, own }
}

/**
 * The state with the groups `keep` turns away taken out. `only`: nothing but the groups kept (and what holds them).
 * A group is kept or left whole: what is inside a character's own values is theirs.
 */
function sift(state, { groups, own }, keep, only = false) {
  const kept = []
  const left = []
  const walk = (value, depth) => {
    const out = {}
    // MVU's marks on a list that grows ($meta…): its rows are rows, whatever they are called.
    const rows = Object.keys(value).some(key => key.startsWith('$'))
    for (const [key, item] of Object.entries(value)) {
      if (isPlain(item) && !rows && groups.has(key)) {
        if (keep(key)) {
          out[key] = item
          kept.push(key)
        } else left.push(key)
      } else if (isPlain(item) && depth < MAX_DEPTH && !own.has(lower(key))) {
        const inner = walk(item, depth + 1)
        if (!only || Object.keys(inner).length) out[key] = inner
      } else if (!only) out[key] = item
    }
    return out
  }
  return { state: walk(state, 1), kept: [...new Set(kept)], left: [...new Set(left)] }
}

const aroundIn = (groups, text) => {
  const said = lower(text)
  return name => groups.get(name).some(word => said.includes(lower(word)))
}

/**
 * The state as a turn sends it whole: { state, left }, `left` the characters not around whose groups were taken out.
 * Short, with no cast to go by, or with nothing said to look in, it goes as it is.
 * @param cast - castNames'. @param text - what was said lately (the window the worldbook is scanned in).
 */
export function presentState(state, { cast, text, min = PRESENT_MIN } = {}) {
  if (!isPlain(state) || !cast?.groups.size || !lower(text) || JSON.stringify(state, null, 1).length < min) return { state, left: [] }
  const { state: shown, left } = sift(state, cast, aroundIn(cast.groups, text))
  return left.length ? { state: shown, left } : { state, left: [] }
}

/**
 * The groups of characters left out last time who are around now: { state: only those groups, back: their names }.
 * @param left - the names left out and not sent since.
 */
export function returnedState(state, { cast, text, left = [] } = {}) {
  if (!isPlain(state) || !cast?.groups.size || !left.length || !lower(text)) return { state: {}, back: [] }
  const around = aroundIn(cast.groups, text)
  const waiting = new Set(left)
  const { state: shown, kept } = sift(state, cast, name => waiting.has(name) && around(name), true)
  return { state: shown, back: kept }
}

/** What <当前状态> says after a state with groups left out, and after groups sent on their own. */
export const leftNote = left => `（这些角色这一轮不在场，他们的变量这次没有列出，值没有变：${left.join('、')}。他们出场后会补发；在那之前不要改他们的变量。）`
export const backNote = () => '（上面是刚出场的角色的变量，之前没有列出。其余变量没有变。）'
