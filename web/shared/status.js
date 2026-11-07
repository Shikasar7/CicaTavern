// Status bar layout (状态栏): which variables show under the latest reply, how,
// and in what order. A card made in the card creator carries one
// (extensions.cicatavern.status_bar); for other cards with variables the page
// lays one out from the state itself. Shared by the server (cards, card
// creator) and the page (drawing it).
//   { title: '林小雨', fields: [
//       { path: '林小雨.好感度', label: '好感', show: 'meter', min: 0, max: 100 },
//       { path: '林小雨.心情', show: 'text' },
//       { path: '你.随身物品', label: '随身', show: 'tags' } ] }
// How a field shows: meter a gauge (a number, 80/100 or 45%), number, rating (stars out of `max`), text, long (a
// paragraph), badge (a short word that stands out), tags, list (a line each), stats (a grid of named values),
// table (a row per item), flag (yes or no), hidden.
import { getPath, splitPath, unwrap } from './vars.js'

export const SHOWS = ['meter', 'number', 'rating', 'text', 'long', 'badge', 'tags', 'list', 'stats', 'table', 'flag', 'hidden']
const MAX_FIELDS = 200
const MAX_RATING = 10
const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const num = value => (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value))

const RANGE = /(-?\d+(?:\.\d+)?)\s*(?:~|～|-|–|—|到|至)\s*(-?\d+(?:\.\d+)?)/ // i18n-ignore: range separators

/** `0~100` → { min: 0, max: 100 }; nothing when the text names no numbers. */
export function rangeOf(text) {
  const match = RANGE.exec(String(text ?? ''))
  if (!match) return {}
  const [min, max] = [Number(match[1]), Number(match[2])]
  return max > min ? { min, max } : {}
}

/** A field's path without MVU's `stat_data` root, dotted. */
export function cleanPath(path) {
  // `/stat_data/a/b` → `/a/b` (still a JSON pointer), `stat_data.a.b` → `.a.b`.
  return joinPath(splitPath(String(path ?? '').trim().replace(/^(\/?)stat_data(?=[./])/, '')))
}

/** Keys as a path: dotted, or a JSON pointer when a key has a dot, a bracket or a slash in it (`Dr. Chen`, `Lv.`). */
export function joinPath(keys) {
  if (!keys.some(key => /[.[\]/~]/.test(key))) return keys.join('.')
  return `/${keys.map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
}

/** A layout as saved, or null when there is nothing to show. */
export const STATUS_THEMES = ['plain', 'paper', 'neon', 'pastel', 'ink', 'parchment', 'gothic', 'terminal', 'ocean']

export function cleanStatusSpec(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) return null
  const seen = new Set()
  const fields = []
  for (const field of raw.fields) {
    const path = cleanPath(field?.path)
    if (!path || seen.has(path) || fields.length >= MAX_FIELDS) continue
    seen.add(path)
    const show = SHOWS.includes(field.show) ? field.show : 'text'
    const out = { path, label: str(field.label, 24), show }
    if (show === 'meter') {
      const min = num(field.min) ?? 0
      const max = num(field.max) ?? 100
      Object.assign(out, max > min ? { min, max } : { min: 0, max: 100 })
    }
    if (show === 'rating') {
      const max = num(field.max) ?? 5
      out.max = max >= 1 && max <= MAX_RATING ? Math.round(max) : 5
    }
    if (field.pair === true) out.pair = true
    if (str(field.page, 8)) out.page = str(field.page, 8)
    fields.push(out)
  }
  // The look picked in 创作角色卡; none = the plain one. Colors of the card's own go over it.
  const theme = STATUS_THEMES.includes(raw.theme) && raw.theme !== 'plain' ? { theme: raw.theme } : {}
  const palette = cleanPalette(raw.palette)
  // Variables past the limit are counted, so the bar can say they are not all there.
  const more = Number.isInteger(raw.more) && raw.more > 0 ? { more: raw.more } : {}
  return fields.some(f => f.show !== 'hidden') ? { title: str(raw.title, 40), fields, ...theme, ...(palette ? { palette } : {}), ...more } : null
}

// Names of 0–100 gauges in MVU cards: 好感度, 信任值, 体力, 欲望, HP… (a guess; other numbers stay numbers).
const GAUGE = /(度|值|率|感|欲|力|HP|MP|SP|进度)$/i
const RATING = /(星级|星数|评级)$/
// Short words that say what someone is right now.
const BADGE = /(阶段|状态|关系|身份|称号|境界|职业|种族|阵营|等级|段位|心情|情绪)$/
// What a person carries or keeps a list of: one field however it is stored, never a person of its own.
const ITEMS = /(背包|行囊|包裹|物品|道具|装备|武器|库存|仓库|任务|委托|技能|法术|招式|功法|成就|线索|inventory|items?$|equipment|quests?$|skills?$|spells?$)/i
const RATIO = /^\s*(-?\d+(?:\.\d+)?)\s*[/／]\s*(\d+(?:\.\d+)?)\s*$/
const PERCENT = /^\s*(-?\d+(?:\.\d+)?)\s*[%％]\s*$/
const LONG_TEXT = 48
const LONG_ITEM = 10
const MAX_DEPTH = 6

const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const shownEntries = object => Object.entries(object).filter(([key]) => !key.startsWith('$'))
// MVU's mark on a list that may grow: without it, MVU refuses every addition ("不可扩展的数组").
export const LIST_GROWS = '$__META_EXTENSIBLE__$'
// Where a card made by 创作角色卡 keeps the events that already happened (a list of their names), by the card's language.
export const EVENTS_DONE = { zh: '已发生事件', en: 'PastEvents' } // i18n-ignore: a variable's name in a card
const EVENTS_DONE_KEYS = new Set(Object.values(EVENTS_DONE))
const shownItems = list => list.filter(item => !(typeof item === 'string' && item.startsWith('$__META')))

function guessShow(key, value) {
  if (typeof value === 'number') {
    if (RATING.test(key) && Number.isInteger(value) && value >= 0 && value <= 5) return 'rating'
    return value >= 0 && value <= 100 && GAUGE.test(key) ? 'meter' : 'number'
  }
  if (typeof value === 'boolean') return 'flag'
  if (typeof value === 'string') {
    if (RATIO.test(value) || PERCENT.test(value)) return 'meter'
    if (value.length > LONG_TEXT || value.includes('\n')) return 'long'
    return value && value.length <= 12 && BADGE.test(key) ? 'badge' : 'text'
  }
  if (Array.isArray(value)) {
    const items = shownItems(value)
    if (items.length && items.every(isPlain)) return 'table'
    return items.some(v => (v !== null && typeof v === 'object') || String(v).length > LONG_ITEM) ? 'list' : 'tags'
  }
  if (isPlain(value)) {
    const values = shownEntries(value).map(([, v]) => unwrap(v))
    if (!values.length) return 'tags'
    if (values.every(v => typeof v === 'number')) return 'stats'
    if (values.every(isPlain)) return 'table'
    return ITEMS.test(key) ? 'tags' : 'text'
  }
  return 'text'
}

/** The pages a layout is split into: two or more, in the order they come; none when it is one page. */
export function statusPages(spec) {
  const pages = [...new Set((spec?.fields ?? []).filter(field => field.show !== 'hidden' && field.page).map(field => field.page))]
  return pages.length >= 2 ? pages : []
}

/** A layout's fields on one page: those with no page of their own go on the first. */
export const onPage = (spec, page, pages) => ({ ...spec, fields: spec.fields.filter(field => (field.page || pages[0]) === page) })

/** Whether at least two of these key lists have a key in common: people of one shape, not parts of one thing. */
const twoAlike = lists => lists.filter((a, i) => lists.some((b, j) => i !== j && a.some(key => b.includes(key)))).length >= 2

/** An object shown as one field inside a person: numbers that are no gauges, and a row for each of the same things. */
function oneField(key, value) {
  if (ITEMS.test(key)) return true
  const entries = shownEntries(value)
  const values = entries.map(([, v]) => unwrap(v))
  if (values.length < 2) return false
  if (values.every(v => typeof v === 'number')) return !entries.every(([name]) => GAUGE.test(name))
  return values.every(isPlain) && twoAlike(values.map(v => Object.keys(v)))
}

// Old MVU cards keep every variable as [value, "description"]. Words in a pair look like a list of two (["伞", "钥匙"]),
// so they are read as one only in a state whose numbers show it is written that way, and when the second says more.
const describes = (value, words) => typeof value !== 'string' || (words.length >= 4 && words.length > value.length)
const pairValue = raw => (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === 'string' && describes(raw[0], raw[1]) ? raw[0] : raw)

function hasDescribedNumbers(value, depth = 0) {
  if (unwrap(value) !== value) return true
  if (depth > MAX_DEPTH || !isPlain(value)) return false
  return Object.values(value).some(inner => hasDescribedNumbers(inner, depth + 1))
}

/**
 * A layout for a state nobody laid out, however deep its people are: 林雪.好感度 and 角色.林雪.好感度 both end up
 * with 林雪 and her values. `$` keys stay hidden as MVU intends. Past MAX_FIELDS the rest is counted in `more`.
 */
export function autoStatusSpec(state) {
  if (!isPlain(state)) return null
  // The card creator's record of events that happened is for the card's own conditions, not for the player.
  state = Object.fromEntries(Object.entries(state).filter(([key]) => !EVENTS_DONE_KEYS.has(key)))
  const read = hasDescribedNumbers(state) ? pairValue : unwrap
  const fields = []
  const add = (keys, raw, value) => {
    const show = guessShow(keys.at(-1), value)
    fields.push({ path: joinPath(keys), show, ...(show === 'meter' ? { min: 0, max: 100 } : {}), ...(value !== unwrap(raw) ? { pair: true } : {}) })
  }
  const childrenOf = value => shownEntries(value).map(([key, raw]) => ({ key, raw, value: read(raw) }))
  const opens = child => isPlain(child.value) && shownEntries(child.value).length > 0
  // Inside a person: what is left opens up, each level a section of them.
  const inside = (value, keys, depth) => {
    for (const child of childrenOf(value)) {
      const path = [...keys, child.key]
      if (opens(child) && depth < MAX_DEPTH && !oneField(child.key, child.value)) inside(child.value, path, depth + 1)
      else add(path, child.raw, child.value)
    }
  }
  // Above them: down to the first level where people stand side by side, or an object has values of its own.
  const above = (value, keys) => {
    const children = childrenOf(value)
    const branches = children.filter(child => opens(child) && !ITEMS.test(child.key))
    const alike = twoAlike(branches.map(child => Object.keys(child.value)))
    if (keys.length && !alike && branches.length < children.length) return inside(value, keys, 1)
    for (const child of children) {
      const path = [...keys, child.key]
      if (!branches.includes(child)) add(path, child.raw, child.value)
      else if (alike) inside(child.value, path, 1)
      else above(child.value, path)
    }
  }
  above(state, [])
  return cleanStatusSpec({ title: '', fields: fields.slice(0, MAX_FIELDS), more: fields.length - MAX_FIELDS })
}

/** A tree of paths: each key's next keys, an empty Map at a field. */
function pathTree(paths) {
  const root = new Map()
  for (const keys of paths) {
    let node = root
    for (const key of keys) {
      if (!node.has(key)) node.set(key, new Map())
      node = node.get(key)
    }
  }
  return root
}

/**
 * Who each path belongs to: path → the keys of its owner, found as autoStatusSpec lays people out, so that
 * 林雪.身体.体力 is 林雪's and not put with 苏晚.身体.体力. What lies between an owner and a value is a section.
 */
function ownersOf(paths) {
  const owners = new Map()
  const claim = (node, keys, owner) => {
    if (!node.size) owners.set(joinPath(keys), owner)
    for (const [key, next] of node) claim(next, [...keys, key], owner)
  }
  const walk = (node, keys) => {
    const entries = [...node]
    const branches = entries.filter(([, next]) => next.size)
    const alike = twoAlike(branches.map(([, next]) => [...next.keys()]))
    if (keys.length && !alike && branches.length < entries.length) return claim(node, keys, keys)
    for (const [key, next] of entries) {
      const path = [...keys, key]
      if (!next.size) owners.set(joinPath(path), keys)
      else if (alike) claim(next, path, path)
      else walk(next, path)
    }
  }
  walk(pathTree(paths), [])
  return owners
}

/**
 * A card's own layout on a state with someone new in it: a person who came along mid-story, standing beside the
 * ones it names and holding the same values, is shown as they are. Everything else stays as the card laid it out.
 */
export function withNewcomers(spec, state) {
  if (!spec || !isPlain(state)) return spec
  const parsed = spec.fields.map(field => ({ field, keys: splitPath(field.path) }))
  const owners = ownersOf(parsed.map(item => item.keys))
  const known = new Set()
  const beside = new Map() // the keys above the owners → what each owner shows
  for (const { field, keys } of parsed) {
    const owner = owners.get(joinPath(keys)) ?? []
    if (!owner.length) continue
    known.add(joinPath(owner))
    const parent = joinPath(owner.slice(0, -1))
    if (!beside.has(parent)) beside.set(parent, { keys: owner.slice(0, -1), shown: new Map() })
    if (field.show !== 'hidden') beside.get(parent).shown.set(joinPath(keys.slice(owner.length)), field)
  }
  const added = []
  for (const { keys: parent, shown } of beside.values()) {
    const holder = parent.length ? unwrap(getPath(state, joinPath(parent))) : state
    if (!isPlain(holder)) continue
    for (const [name, raw] of shownEntries(holder)) {
      const person = [...parent, name]
      if (known.has(joinPath(person)) || !isPlain(unwrap(raw))) continue
      for (const [rest, field] of shown) {
        const path = joinPath([...person, ...splitPath(rest)])
        if (getPath(state, path) !== undefined) added.push({ ...field, path })
      }
    }
  }
  return added.length ? { ...spec, fields: [...spec.fields, ...added].slice(0, MAX_FIELDS) } : spec
}

/** One line of text for any value: lists joined, objects as `key：value；…`. */
export function compactText(value, max = 160) {
  const v = unwrap(value)
  let text
  if (v === undefined || v === null) text = ''
  else if (typeof v !== 'object') text = String(v)
  else if (Array.isArray(v)) text = shownItems(v).map(x => compactText(x, max)).filter(Boolean).join('、') // i18n-ignore: state values
  else text = shownEntries(v).map(([k, x]) => `${k}：${compactText(x, max)}`).join('；') // i18n-ignore: state values
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function tagsOf(value) {
  const v = unwrap(value)
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return shownItems(v).map(x => compactText(x, 40)).filter(Boolean)
  if (typeof v === 'object') {
    return shownEntries(v).map(([k, x]) => {
      const inner = unwrap(x)
      return typeof inner === 'number' ? `${k} ×${inner}` : k
    })
  }
  return String(v).split(/[、，,;；]/).map(s => s.trim()).filter(Boolean)
}

const round = n => Math.round(n * 100) / 100
const LONG_MAX = 2000
const MAX_ROWS = 60
const MAX_COLUMNS = 6
const CELL_MAX = 60
const ITEM_MAX = 200

/** A number with its scale: a number on the field's, 80/100 and 45% on their own. Null when it is none of these. */
function gaugeOf(value, field) {
  const text = typeof value === 'string' ? value : ''
  const ratio = RATIO.exec(text)
  if (ratio && Number(ratio[2]) > 0) return { value: Number(ratio[1]), min: 0, max: Number(ratio[2]), words: `${ratio[1]}/${ratio[2]}` }
  const percent = PERCENT.exec(text)
  if (percent) return { value: Number(percent[1]), min: 0, max: 100, words: `${percent[1]}%` }
  const n = value === '' || value === null ? NaN : Number(value)
  return Number.isFinite(n) ? { value: n, min: field.min ?? 0, max: field.max ?? 100 } : null
}

function linesOf(value) {
  if (Array.isArray(value)) return shownItems(value).map(x => compactText(x, ITEM_MAX)).filter(Boolean)
  if (isPlain(value)) return shownEntries(value).map(([k, x]) => `${k}：${compactText(x, ITEM_MAX)}`) // i18n-ignore: state values
  return String(value ?? '').split(/\n+/).map(s => s.trim()).filter(Boolean)
}

/** Named values for a grid: { label, value, delta? } each, or null for anything without names. */
function statsOf(value, before) {
  if (!isPlain(value)) return null
  return shownEntries(value).map(([label, raw]) => {
    const inner = unwrap(raw)
    const stat = { label, value: typeof inner === 'number' ? round(inner) : compactText(inner, CELL_MAX) }
    const old = isPlain(before) ? unwrap(before[label]) : undefined
    if (typeof inner === 'number' && typeof old === 'number' && old !== inner) stat.delta = round(inner - old)
    return stat
  })
}

/**
 * A list or record of things as a table: { named, columns, rows: [{ name, cells, changed? }], more? }; `named`
 * when the rows have names of their own (a record's keys). `changed`: this reply added or altered the row
 * (`before` undefined: nothing to tell it by).
 */
function tableOf(value, before) {
  const items = Array.isArray(value)
    ? shownItems(value).map((item, index) => [String(index), item])
    : isPlain(value) ? shownEntries(value) : []
  if (!items.length) return null
  const records = items.map(([name, raw]) => [name, unwrap(raw)])
  const columns = []
  for (const [, item] of records) {
    for (const [key] of isPlain(item) ? shownEntries(item) : []) if (!columns.includes(key) && columns.length < MAX_COLUMNS) columns.push(key)
  }
  const old = key => (Array.isArray(before) ? shownItems(before)[Number(key)] : isPlain(before) ? before[key] : undefined)
  const rows = records.slice(0, MAX_ROWS).map(([name, item]) => ({
    name,
    cells: columns.length ? columns.map(key => (isPlain(item) ? compactText(item[key], CELL_MAX) : '')) : [compactText(item, CELL_MAX)],
    ...(before !== undefined && JSON.stringify(unwrap(old(name))) !== JSON.stringify(item) ? { changed: true } : {}),
  }))
  return { named: !Array.isArray(value), columns, rows, ...(records.length > rows.length ? { more: records.length - rows.length } : {}) }
}

/**
 * The rows to draw, grouped by owner (林小雨.好感度 → 林小雨; 角色.林雪.身体.体力 → 林雪, in a section 身体).
 * `previous`: the state before this reply, for the change marks (+4, −8) and what is new.
 * Each group: { key, name, rows, changed }, `changed` when this reply touched it.
 */
export function statusGroups(spec, state, previous = null) {
  const fields = (spec?.fields ?? []).filter(field => field.show !== 'hidden')
  const owners = ownersOf(fields.map(field => splitPath(field.path)))
  const groups = []
  for (const field of fields) {
    const keys = splitPath(field.path)
    const raw = getPath(state ?? {}, field.path)
    const value = field.pair ? pairValue(raw) : unwrap(raw)
    if (value === undefined) continue
    const oldRaw = previous ? getPath(previous, field.path) : undefined
    const before = field.pair ? pairValue(oldRaw) : unwrap(oldRaw)
    const row = { path: field.path, label: field.label || keys.at(-1), show: field.show }
    const asText = () => Object.assign(row, { show: 'text', text: compactText(value) })
    if (field.show === 'meter' || field.show === 'number') {
      const gauge = gaugeOf(value, field)
      if (!gauge) asText()
      else {
        row.value = gauge.value
        if (gauge.words) row.words = gauge.words
        const was = before === undefined ? null : gaugeOf(before, field)
        if (was && was.value !== gauge.value) row.delta = round(gauge.value - was.value)
        if (field.show === 'meter') row.percent = Math.max(0, Math.min(100, ((gauge.value - gauge.min) / (gauge.max - gauge.min)) * 100))
      }
    } else if (field.show === 'rating') {
      const n = Number(value)
      if (!Number.isFinite(n)) asText()
      else Object.assign(row, { value: Math.max(0, Math.min(field.max ?? 5, Math.round(n))), max: field.max ?? 5 })
    } else if (field.show === 'tags') {
      row.tags = tagsOf(value)
      if (previous) {
        const old = new Set(tagsOf(before))
        row.added = row.tags.filter(tag => !old.has(tag))
      }
    } else if (field.show === 'list') {
      const lines = linesOf(value)
      row.items = lines.slice(0, MAX_ROWS)
      row.more = Math.max(0, lines.length - MAX_ROWS)
    } else if (field.show === 'stats') {
      row.stats = statsOf(value, before)
      if (!row.stats) asText()
    } else if (field.show === 'table') {
      row.table = tableOf(value, previous ? before ?? null : undefined)
      // A book with nothing in it yet says so, and shows none of MVU's marks.
      if (!row.table) Object.assign(row, { show: 'text', text: isPlain(value) || Array.isArray(value) ? '' : compactText(value) })
    } else if (field.show === 'flag') row.on = Boolean(value) && value !== 'false' && value !== '否' // i18n-ignore: a state value
    else if (field.show === 'long') row.text = compactText(value, LONG_MAX)
    else row.text = compactText(value)
    // Words have no +4: a mark says they changed.
    if (previous && before !== undefined && (row.text !== undefined || row.on !== undefined) && JSON.stringify(before) !== JSON.stringify(value)) row.changed = true
    const owner = owners.get(joinPath(keys)) ?? keys.slice(0, -1)
    const section = keys.slice(owner.length, -1).join(' · ')
    if (section) row.section = section
    const key = joinPath(owner)
    let group = groups.find(g => g.key === key)
    if (!group) groups.push((group = { key, name: owner.at(-1) ?? '', owner, rows: [], changed: false }))
    group.rows.push(row)
    if (row.delta || row.changed || row.added?.length || row.table?.rows.some(item => item.changed) || row.stats?.some(stat => stat.delta)) group.changed = true
  }
  // Two people of one name in different places say where.
  const names = groups.map(group => group.name)
  for (const group of groups) {
    if (group.owner.length > 1 && names.filter(name => name === group.name).length > 1) group.name = group.owner.join(' · ')
  }
  return groups.map(({ owner, ...group }) => group)
}
// ─── 玩法积木 and 卡的规模 ────────────────────────────────────────────────
// What 创作角色卡's 高级选项 can add to a card: shared by the server (prompts, the plan, the card) and the page (the
// picks, the status bar editor). What the bricks write into a card: server/forge/bricks.mjs.

/** The bricks, in the order they are shown. */
export const BRICKS = ['books', 'selfcheck', 'events', 'judge', 'world', 'creation']
// These keep values, so a card with them tracks variables.
const VARIABLE_BRICKS = ['books', 'judge', 'world', 'creation']

/** Whether picks need variables to work. */
export const needsVariables = (bricks = []) => bricks.some(brick => VARIABLE_BRICKS.includes(brick))

/** How often a random event comes: about one turn in n. */
export const EVENT_RATES = { rare: 8, normal: 5, often: 3 }

const LIGHT = { characters: 12, places: 10, factions: 8, events: 6, rules: 12, playRules: 8, history: 10, variables: 80 }

/** How much a plan holds. '' = 轻量, as a card always was. */
export const SCALES = {
  '': LIGHT,
  standard: { characters: 30, places: 20, factions: 12, events: 12, rules: 20, playRules: 12, history: 16, variables: 120 },
  epic: { characters: 60, places: 40, factions: 20, events: 24, rules: 30, playRules: 16, history: 24, variables: 200 },
}

export const cleanScale = value => (value && Object.hasOwn(SCALES, value) ? value : '')
export const limitsOf = scale => SCALES[cleanScale(scale)]

/**
 * The picks after one change, as they can stand together:
 * - 裁判表 and 战斗与成长 are two ways of judging, and the one picked last stays;
 * - 册子 and 裁判表 keep values: the format moves to a card with variables, and back when they go
 *   (`formatBefore`, so the page can say so). 纯文本 picked by hand takes those bricks away instead.
 */
export function settlePicks(next, before = {}) {
  const out = { ...next, bricks: [...(next.bricks ?? [])], play: [...(next.play ?? [])] }
  if (out.bricks.includes('judge') && out.play.includes('battle')) {
    if (before.play?.includes('battle')) out.play = out.play.filter(play => play !== 'battle')
    else out.bricks = out.bricks.filter(brick => brick !== 'judge')
  }
  const needs = needsVariables(out.bricks)
  const needed = needsVariables(before.bricks)
  if (needs && needed && out.format === 'text') {
    out.bricks = out.bricks.filter(brick => !VARIABLE_BRICKS.includes(brick))
    delete out.formatBefore
  } else if (needs && !needed && (out.format === '' || out.format === 'text')) {
    out.formatBefore = out.format
    out.format = 'mvu-ui'
  } else if (!needs && needed && out.formatBefore !== undefined) {
    out.format = out.formatBefore
    delete out.formatBefore
  } else if (out.format !== before.format) delete out.formatBefore
  return out
}

// ─── 册子 ─────────────────────────────────────────────────────────────────
// A list that grows and shrinks in play: a record, a row per name. A plan keeps its starting rows as text, as it
// keeps every initial value: 旧地图|1|手绘的；铜钱|5.

const ROWS = /[；;、\n]+/
const CELL = '|'
const BOOK_ROWS = 40
const BOOK_TEXT = 800

/** A book's starting rows as a plan keeps them, from the model's rows ([{ name, 列: 值 }]) or text. */
export function bookText(raw, columns = []) {
  if (typeof raw === 'string') return raw.trim().slice(0, BOOK_TEXT)
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).filter(([name]) => !name.startsWith('$')).map(([name, row]) => (row && typeof row === 'object' ? { ...row, name } : { name, [columns[0]]: row })) : []
  return rows
    .filter(row => row && typeof row === 'object' && String(row.name ?? '').trim())
    .slice(0, BOOK_ROWS)
    .map(row => [row.name, ...columns.map(column => row[column] ?? '')].map(cell => String(cell).replace(/[|；;、\n]/g, ' ').trim()).join(CELL).replace(/\|+$/, ''))
    .join('；') // i18n-ignore: rows as a card keeps them
    .slice(0, BOOK_TEXT)
}

/** A book's starting value: a record that MVU lets grow, a row per name. */
export function bookValue(text, columns = []) {
  const out = { $meta: { extensible: true } }
  for (const line of String(text ?? '').split(ROWS).slice(0, BOOK_ROWS)) {
    const [name, ...cells] = line.split(CELL).map(cell => cell.trim())
    if (!name || name.startsWith('$') || ['__proto__', 'constructor', 'prototype'].includes(name)) continue
    out[name] = Object.fromEntries(columns.map((column, i) => {
      const cell = cells[i] ?? ''
      return [column, cell !== '' && Number.isFinite(Number(cell)) ? Number(cell) : cell]
    }))
  }
  return out
}

// ─── 配色 ─────────────────────────────────────────────────────────────────
// 按卡配色: the status bar in three colors the plan picked for the card. The rest is worked out from them, and
// text that could not be read is put right.

const HEX = /^#[0-9a-f]{6}$/i
const channels = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16))
const toHex = rgb => `#${rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`
const mix = (from, to, share) => toHex(channels(from).map((value, i) => value + (channels(to)[i] - value) * share))

function luminance(hex) {
  const [r, g, b] = channels(hex).map(value => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Three colors as a card keeps them, or null when they are not all there. Text too close to its background goes black or white. */
export function cleanPalette(raw) {
  if (!raw || typeof raw !== 'object') return null
  const [bg, ink, accent] = [raw.bg, raw.ink, raw.accent].map(value => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
  if (![bg, ink, accent].every(value => HEX.test(value))) return null
  const plain = luminance(bg) > 0.4 ? '#1c1c1c' : '#f5f5f5'
  return { bg, ink: contrast(ink, bg) >= 4.5 ? ink : plain, accent: contrast(accent, bg) >= 3 ? accent : mix(accent, plain, 0.6) }
}

/** The colors the bar is drawn in, worked out from a palette. */
export function paletteColors({ bg, ink, accent }) {
  const [r, g, b] = channels(accent)
  return { surface: bg, ink, accent, muted: mix(ink, bg, 0.3), faint: mix(ink, bg, 0.5), line: mix(ink, bg, 0.82), track: mix(ink, bg, 0.86), soft: `rgba(${r},${g},${b},.13)` }
}
