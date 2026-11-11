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
import { getPath, splitPath, unwrap, writablePath } from './vars.js'

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
// 动效: what drifts over a bar (and over the card's 开场页), drawn by the program (web/status.js effectLayer).
export const EFFECTS = ['rain', 'snow', 'petals', 'embers', 'fireflies', 'stars', 'dust']
export const cleanEffect = value => (EFFECTS.includes(value) ? value : '')

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
  // 定制外观: a look written for this card goes in place of a theme, over the three colors.
  const skin = cleanSkin(raw.skin)
  // Variables past the limit are counted, so the bar can say they are not all there.
  const more = Number.isInteger(raw.more) && raw.more > 0 ? { more: raw.more } : {}
  // 立绘 and 场景图 on top of the bar (the pictures are the app's: 角色名册, 视觉小说的场景), and what drifts over it.
  const art = { ...(raw.portrait === true ? { portrait: true } : {}), ...(raw.scene === true ? { scene: true } : {}), ...(cleanEffect(raw.effect) ? { effect: raw.effect } : {}), ...(raw.phone === true ? { phone: true } : {}) }
  return fields.some(f => f.show !== 'hidden') ? { title: str(raw.title, 40), fields, ...(skin ? { skin } : theme), ...(palette ? { palette } : {}), ...art, ...more } : null
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

// 小手机: what a bar keeps off its face, to be opened like the apps of a phone. A bar in pages keeps its first page
// and makes an app of each other one; in any bar a list, a table, a paragraph or a set of numbers is an app of its own.
const APP_SHOWS = new Set(['table', 'list', 'long', 'stats'])

/**
 * A layout with 小手机 on, cut in two: { bar: what stays on the bar (no pages left in it), apps: [{ name, spec }] }.
 * Each app's spec is a layout of its own, drawn like a bar's.
 */
export function phoneApps(spec) {
  const pages = statusPages(spec)
  const apps = new Map()
  const stay = []
  for (const field of spec.fields) {
    const { page: _, ...plain } = field
    const paged = pages.length && field.page && field.page !== pages[0]
    const name = field.show === 'hidden' ? '' : paged ? field.page : APP_SHOWS.has(field.show) ? field.label || String(field.path).split('.').at(-1) : ''
    if (!name) stay.push(plain)
    else apps.set(name, [...(apps.get(name) ?? []), plain])
  }
  return { bar: { ...spec, fields: stay }, apps: [...apps].map(([name, fields]) => ({ name, spec: { ...spec, title: name, fields } })) }
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
        const percentOf = one => Math.max(0, Math.min(100, ((one.value - one.min) / (one.max - one.min)) * 100))
        if (field.show === 'meter') row.percent = percentOf(gauge)
        // Where the gauge stood before this reply: it fills from there.
        if (field.show === 'meter' && row.delta) row.from = percentOf(was)
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
      // Lines this reply wrote that were not there before (小手机 marks the app they are in).
      if (previous) {
        const old = new Set(linesOf(before))
        row.added = lines.filter(line => !old.has(line))
      }
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
export const BRICKS = ['books', 'selfcheck', 'events', 'judge', 'world', 'schedule', 'relations', 'routes', 'creation']
// These keep values, so a card with them tracks variables.
const VARIABLE_BRICKS = ['books', 'judge', 'world', 'schedule', 'relations', 'routes', 'creation']

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

// ─── 试数值 ───────────────────────────────────────────────────────────────
// The bar's preview with other values than the card starts with (调整状态栏, 创作角色卡's plan): to see a gauge full,
// a list long, a look of the card's own under them. Nothing of it is in the card or a chat.

/** The variables with some of them another way ({ path: value }); the state given is left as it is. */
export function withTried(state, values) {
  const next = JSON.parse(JSON.stringify(state ?? {}))
  for (const [path, value] of Object.entries(values ?? {})) {
    const keys = splitPath(path)
    if (!keys.length || !writablePath(keys)) continue
    let at = next
    for (const key of keys.slice(0, -1)) at = at[key] = isPlain(at[key]) ? at[key] : {}
    at[keys.at(-1)] = value
  }
  return next
}

/** What to try to see the bar at an end: every gauge and rating full and every flag on ('full'), or all of them down and the lists empty ('low'). */
export function triedExtreme(spec, state, end) {
  const values = {}
  for (const field of spec?.fields ?? []) {
    const now = unwrap(getPath(state ?? {}, field.path))
    if (now === undefined || field.show === 'hidden') continue
    if (field.show === 'meter' && typeof now === 'number') values[field.path] = end === 'full' ? field.max : field.min
    else if (field.show === 'rating' && typeof now === 'number') values[field.path] = end === 'full' ? field.max ?? 5 : 0
    else if (field.show === 'flag' && typeof now === 'boolean') values[field.path] = end === 'full'
    else if ((field.show === 'tags' || field.show === 'list') && Array.isArray(now) && end === 'low') values[field.path] = []
  }
  return values
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

/** The colors the bar is drawn in, worked out from a palette. Its green and red (a yes, +4, −8) are those that read on its background, whatever the page's are. */
export function paletteColors({ bg, ink, accent }) {
  const [r, g, b] = channels(accent)
  const light = luminance(bg) > 0.4
  return { surface: bg, ink, accent, muted: mix(ink, bg, 0.3), faint: mix(ink, bg, 0.5), line: mix(ink, bg, 0.82), track: mix(ink, bg, 0.86), soft: `rgba(${r},${g},${b},.13)`, ok: light ? '#2f7a55' : '#6fbf93', bad: light ? '#b0413a' : '#e57b70' }
}

/** How far apart two six-digit colors are for reading one on the other (1 to 21). */
export const colorContrast = (a, b) => (HEX.test(a) && HEX.test(b) ? contrast(a, b) : null)

/** `text` cut at its commas that are not inside brackets. */
function splitTop(text) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') depth -= 1
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  return [...parts, text.slice(start).trim()].filter(Boolean)
}

// A stripe this thin in a striped gradient (a ruler's ticks), or a layer that leaves this much of its box bare (a line
// along an edge, an ornament in a corner), is drawn beside the words, not behind them.
const HAIRLINE = 0.25
const BARE = 0.5

/** How much of one side of its box a background layer covers (0 to 1). */
function coverOf(length, repeats, side) {
  if (repeats || !length || length === 'auto') return 1
  const match = /^([\d.]+)(px|%)$/.exec(length)
  if (!match) return 1
  if (match[2] === '%') return Math.min(1, Number(match[1]) / 100)
  return side > 0 ? Math.min(1, Number(match[1]) / side) : 1
}

/** A gradient's stops that are more than a hairline: [color]. All of them where their places cannot be told. */
function wideStops(layer) {
  const stops = []
  // A color mixed in the rules (color-mix) computes to `color(srgb r g b / a)`.
  for (const match of layer.matchAll(/((?:rgba?|color)\([^)]*\))((?:\s+-?[\d.]+(?:px|%))*)/g)) {
    const places = match[2].trim().split(/\s+/).filter(Boolean)
    for (const place of places.length ? places : ['']) stops.push({ color: match[1], at: place ? parseFloat(place) : null, unit: place.replace(/^-?[\d.]+/, '') })
  }
  const placed = stops.length > 1 && stops.every(stop => stop.at !== null && stop.unit === stops[0].unit)
  if (!placed) return stops.map(stop => stop.color)
  const repeating = /^repeating-/.test(layer)
  // What is not striped ends in its outer colors: with places in percent they reach the box's edges.
  const [from, to] = repeating || stops[0].unit !== '%' ? [stops[0].at, stops.at(-1).at] : [Math.min(0, stops[0].at), Math.max(100, stops.at(-1).at)]
  if (!(to > from)) return stops.map(stop => stop.color)
  const share = new Map()
  stops.forEach((stop, i) => {
    const before = i ? (stop.at - stops[i - 1].at) / 2 : stop.at - from
    const after = i < stops.length - 1 ? (stops[i + 1].at - stop.at) / 2 : to - stop.at
    share.set(stop.color, (share.get(stop.color) ?? 0) + Math.max(0, before) + Math.max(0, after))
  })
  return [...share].filter(([, length]) => length / (to - from) >= HAIRLINE).map(([color]) => color)
}

/**
 * The colors of a computed `background-image` that may lie behind an element's words: its gradients' stops, without
 * the layers that leave most of the box bare (a line along an edge) and the stripes that are hairlines (a ruler's
 * ticks). null when a layer is no gradient (what it shows cannot be told).
 * @param options - { size, repeat: the computed background-size and background-repeat, box: { width, height } }
 */
export const backdropColors = (image, options) => backdropLayers(image, options)?.flat() ?? null

/**
 * The same, a layer at a time, the topmost first as CSS writes them: [[color]]. What is behind the words is each
 * layer's color over those under it, so a faint wash on top is never taken for the ground by itself.
 */
export function backdropLayers(image, { size = 'auto', repeat = 'repeat', box = null } = {}) {
  if (!image || image === 'none') return []
  const sizes = splitTop(String(size))
  const repeats = splitTop(String(repeat))
  const colors = []
  for (const [i, layer] of splitTop(String(image)).entries()) {
    // A layer that is only the fill (`gradient, #123` has `none` for its last picture).
    if (layer === 'none') continue
    if (!/gradient\(/.test(layer)) return null
    const [across, down = 'auto'] = (sizes[i % (sizes.length || 1)] ?? 'auto').split(/\s+/)
    const way = (repeats[i % (repeats.length || 1)] ?? 'repeat').split(/\s+/)
    const [alongX, alongY] = way.length > 1 ? way : way[0] === 'repeat-x' ? ['repeat', 'no-repeat'] : way[0] === 'repeat-y' ? ['no-repeat', 'repeat'] : [way[0], way[0]]
    const cover = coverOf(across, alongX !== 'no-repeat', box?.width ?? 0) * coverOf(down, alongY !== 'no-repeat', box?.height ?? 0)
    if (cover < BARE) continue
    const stops = wideStops(layer)
    // A gradient whose colors cannot be read (written some other way) is not one with none behind the words.
    if (!stops.length) return null
    colors.push(stops)
  }
  return colors
}

// ─── 定制外观 ─────────────────────────────────────────────────────────────
// A look of the card's own (状态栏 → 定制外观): CSS a model wrote for this card's bar, over the three colors. The
// program still draws the bar (web/status.js), so the variables always show; the CSS only dresses it. It is kept as
// plain rules that reach nothing but the bar: no addresses to load, no fixed layers, nothing beside the bar.
//   skin: { name: '玉简', css: '.status-bar { border-radius: 4px }\n.status-title::before { content: "◆ " }' }

// What a look may come to. It dresses the bar, its phone and the card's 开场页: real ones run to 10 000–13 000.
export const MAX_SKIN = 24000
const MAX_SKIN_RULES = 300
const MAX_SKIN_SOURCE = 60000
const MAX_DECLARATION = 600
// What a value may call: colors, sizes, gradients, transforms, filters, shapes, timing ('' is a plain bracket in a
// sum). Anything that loads an address (url, image-set, element…) is not here: a declaration with it is left out.
const SKIN_FUNCTIONS = new Set([
  '', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  'var', 'calc', 'min', 'max', 'clamp', 'attr', 'counter', 'counters', 'env',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d',
  'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  'cubic-bezier', 'steps', 'repeat', 'minmax', 'fit-content', 'inset', 'circle', 'ellipse', 'polygon',
])
const SKIN_PROPERTY = /^(?:--[\w-]{1,60}|-?[a-z][a-z-]{1,40})$/i
const SKIN_BLOCKED = new Set(['behavior', '-moz-binding', 'position-anchor', 'view-transition-name', 'container-name'])
const SKIN_CONDITION = /^[\w\s():.,<>=/%-]{1,200}$/
const SKIN_IDENT = /^-?[a-z_][\w-]{0,40}$/i
// Words an animation's line already uses: a movement of that name could not be told from them.
const SKIN_TIMING = new Set(['none', 'initial', 'inherit', 'unset', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end', 'infinite', 'alternate', 'alternate-reverse', 'normal', 'reverse', 'forwards', 'backwards', 'both', 'running', 'paused'])
const SKIN_GROUPS = new Set(['media', 'supports'])
const QUOTES = new Set(['"', "'"])

/** `text` with what is in quotes blanked out, the same length (to look for what must stand outside a string); null when a string never ends. */
function unquoted(text) {
  let out = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (!quote) {
      if (QUOTES.has(char)) quote = char
      out += char
    } else if (char === '\\') {
      out += '  '
      i += 1
    } else if (char === quote) {
      quote = ''
      out += char
    } else out += ' '
  }
  return quote ? null : out
}

/** Walk `text` from `from`, strings skipped: `visit(char, i)` for every character outside one, till it returns true → that index, else -1. */
function scanOutside(text, from, visit) {
  let quote = ''
  for (let i = from; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = ''
    } else if (QUOTES.has(char)) quote = char
    else if (visit(char, i)) return i
  }
  return -1
}

/** Where the brace opened at `open` closes; -1 when it never does. */
function closingBrace(text, open) {
  let depth = 0
  return scanOutside(text, open, char => (char === '{' ? (depth += 1, false) : char === '}' && (depth -= 1) === 0))
}

/** `text` cut at `mark` where it stands outside strings, brackets and parentheses. */
function splitOutside(text, mark) {
  const parts = []
  let depth = 0
  let from = 0
  scanOutside(text, 0, (char, i) => {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === mark && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
    return false
  })
  parts.push(text.slice(from))
  return parts
}

/** The blocks at one level: [{ prelude, body }]. A statement that ends in `;` (@import, @charset) is no block. */
function skinBlocks(text) {
  const blocks = []
  let at = 0
  while (at < text.length && blocks.length < MAX_SKIN_RULES * 2) {
    const open = scanOutside(text, at, char => char === '{' || char === ';')
    if (open < 0) break
    if (text[open] === '{') {
      const close = closingBrace(text, open)
      if (close < 0) break
      blocks.push({ prelude: text.slice(at, open).trim(), body: text.slice(open + 1, close) })
      at = close + 1
    } else at = open + 1
  }
  return blocks
}

/** One declaration as it may stay ([property, value]), or null. */
function skinDeclaration(text) {
  const colon = text.indexOf(':')
  if (colon < 1) return null
  const name = text.slice(0, colon).trim()
  const property = name.startsWith('--') ? name : name.toLowerCase()
  // `!important` is the page's to use (a hidden row stays hidden, a folded bar folded).
  const value = text.slice(colon + 1).replace(/!\s*important\s*$/i, '').replace(/\s+/g, ' ').trim()
  if (!SKIN_PROPERTY.test(property) || SKIN_BLOCKED.has(property) || !value || value.length > MAX_DECLARATION) return null
  const bare = unquoted(value)
  // Outside a string: no escapes (a function's name spelled around the list), no markup, no rule of its own.
  if (bare === null || /[\\<>{}@;!]/.test(bare)) return null
  for (const [, called] of bare.matchAll(/([\w-]*)\s*\(/g)) if (!SKIN_FUNCTIONS.has(called.toLowerCase())) return null
  if (property === 'position' && !/^(?:static|relative|absolute)$/i.test(value)) return null
  return [property, value]
}

const skinDeclarations = body => ((unquoted(body) ?? '{').includes('{') ? [] : splitOutside(body, ';').map(skinDeclaration).filter(Boolean))

const WHOLE_BAR = /^\.status-bar(?![\w-])/

/** One selector as it may stay, or ''. The page around the bar and what stands beside it are not its to name. */
function skinSelector(text) {
  const selector = text.replace(/\s+/g, ' ').trim()
  const bare = selector ? unquoted(selector) : null
  if (!bare || selector.length > 300 || /[\\<{};@/!&]/.test(bare)) return ''
  if (/(?:^|[\s>+~,(])(?:html|body|head|iframe|script|style|link)\b|:root\b|:host\b|:scope\b|::?backdrop|:fullscreen|::view-transition/i.test(bare)) return ''
  if (/^[+~]/.test(selector)) return ''
  if (WHOLE_BAR.test(selector)) {
    // `.status-bar + x`, `.status-bar:not(.a .b) ~ x`: beside the bar, not in it.
    let depth = 0
    const end = scanOutside(selector, 0, char => {
      if (char === '(' || char === '[') depth += 1
      else if (char === ')' || char === ']') depth -= 1
      return depth === 0 && /[\s>+~]/.test(char)
    })
    if (end >= 0 && /^\s*[+~]/.test(selector.slice(end))) return ''
  }
  return selector
}

function skinNode(block, depth = 0) {
  if (!block.prelude.startsWith('@')) {
    const selectors = splitOutside(block.prelude, ',').map(skinSelector).filter(Boolean)
    // A rule inside a rule is not read: its declarations are none.
    const declarations = skinDeclarations(block.body)
    return selectors.length && declarations.length ? { kind: 'rule', selectors, declarations } : null
  }
  const [, name = '', rest = ''] = /^@([\w-]+)\s*([\s\S]*)$/.exec(block.prelude) ?? []
  const kind = name.toLowerCase()
  if (kind === 'keyframes') {
    const called = rest.trim()
    if (!SKIN_IDENT.test(called) || SKIN_TIMING.has(called.toLowerCase())) return null
    const frames = skinBlocks(block.body)
      .map(frame => ({ at: frame.prelude.replace(/\s+/g, '').toLowerCase(), declarations: skinDeclarations(frame.body) }))
      .filter(frame => /^(?:from|to|\d{1,3}(?:\.\d+)?%)(?:,(?:from|to|\d{1,3}(?:\.\d+)?%))*$/.test(frame.at) && frame.declarations.length)
    return frames.length ? { kind: 'keyframes', name: called, frames } : null
  }
  if (!SKIN_GROUPS.has(kind) || depth > 1 || !SKIN_CONDITION.test(rest.trim())) return null
  const rules = skinBlocks(block.body).map(inner => skinNode(inner, depth + 1)).filter(Boolean)
  return rules.length ? { kind: 'group', name: kind, condition: rest.replace(/\s+/g, ' ').trim(), rules } : null
}

function withoutComments(text) {
  let out = ''
  let from = 0
  for (;;) {
    const open = scanOutside(text, from, (char, i) => char === '/' && text[i + 1] === '*')
    if (open < 0) return out + text.slice(from)
    out += `${text.slice(from, open)} `
    const close = text.indexOf('*/', open + 2)
    if (close < 0) return out
    from = close + 2
  }
}

const skinTree = text => skinBlocks(withoutComments(String(text ?? '').slice(0, MAX_SKIN_SOURCE))).map(block => skinNode(block)).filter(Boolean).slice(0, MAX_SKIN_RULES)

/** The rules as text, a rule a line. With `scope`, every one reaches only the bar that wears that class and what is in it. */
function printSkin(nodes, scope = '') {
  const moves = new Set(nodes.flatMap(node => (node.kind === 'keyframes' ? [node.name] : [])))
  // The bar's own movements, named so that two cards' cannot be each other's.
  const moved = value => (scope && moves.size ? value.replace(/[\w-]+/g, word => (moves.has(word) ? `${scope}-${word}` : word)) : value)
  const lines = declarations => declarations.map(([property, value]) => `${property}: ${/^animation(?:-name)?$/.test(property) ? moved(value) : value}`).join('; ')
  // `.status-bar…` is the bar itself, anything else something in it.
  const reach = selector => (!scope ? selector : WHOLE_BAR.test(selector) ? `.${scope}${selector}` : `.${scope} ${selector}`)
  const print = node => {
    if (node.kind === 'rule') return `${node.selectors.map(reach).join(', ')} { ${lines(node.declarations)} }`
    if (node.kind === 'keyframes') return `@keyframes ${scope ? `${scope}-` : ''}${node.name} { ${node.frames.map(frame => `${frame.at} { ${lines(frame.declarations)} }`).join(' ')} }`
    return `@${node.name} ${node.condition} { ${node.rules.map(print).join(' ')} }`
  }
  return nodes.map(print)
}

const skinKept = new Map()

/** A model's (or anyone's) CSS as a card keeps it: only what may dress the bar, a rule a line; '' when nothing may. */
export function cleanSkinCss(text) {
  const source = String(text ?? '')
  if (skinKept.has(source)) return skinKept.get(source)
  const lines = []
  let size = 0
  for (const line of printSkin(skinTree(source))) {
    if (size + line.length + 1 > MAX_SKIN) break
    lines.push(line)
    size += line.length + 1
  }
  const css = lines.join('\n')
  if (skinKept.size > 40) skinKept.clear()
  skinKept.set(source, css)
  return css
}

/** Whether what was written is longer than a look may be: its last rules were left out (cleanSkinCss stops at the limit). */
export const skinCut = text => printSkin(skinTree(String(text ?? ''))).join('\n').length > MAX_SKIN

/** The class a bar wears for this CSS: the same for the same rules, so a chat's bars share one sheet. */
export function skinClass(css) {
  let hash = 0x811c9dc5
  for (let i = 0; i < css.length; i += 1) hash = Math.imul(hash ^ css.charCodeAt(i), 0x01000193)
  return `skin-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** The CSS as the page loads it: every rule reaching only into the bar that wears `scope`. */
export const scopedSkinCss = (css, scope = skinClass(css)) => printSkin(skinTree(css), scope).join('\n')

/** A look as a card keeps it ({ name?, css }), or null. */
export function cleanSkin(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.css !== 'string') return null
  const css = cleanSkinCss(raw.css)
  return css ? { ...(str(raw.name, 24) ? { name: str(raw.name, 24) } : {}), css } : null
}

// ─── 变量模板 and 只读变量 ────────────────────────────────────────────────
// 创作角色卡's plan page: a set of variables for a kind of story, added to the plan in one go, each then changed by
// hand like any other. Whose a variable is: `c` the card's main character, `p` the player, `w` the world.
// A variable marked 只读 (locked) is one the story never changes: the model is told so, and a reply that writes it
// anyway has it put back (server/state.mjs keepReadOnly).

const TEMPLATE_ROOTS = { zh: { p: '主角', w: '世界' }, en: { p: 'Protagonist', w: 'World' } } // i18n-ignore: variable names in a card
// Each: [owner, zh name, en name, zh label, en label, type, show, initial (zh, en), range, zh check, en check]
const TEMPLATES = {
  romance: [
    ['c', '好感度', 'affection', '好感', 'Affection', 'number', 'meter', ['20', '20'], '0~100', '真心相待、记得她说过的话时 +1~3；敷衍、失约时 -2~5', '+1 to +3 for real care or remembering what she said; -2 to -5 for brushing her off or breaking a promise'], // i18n-ignore: a variable in a card
    ['c', '关系', 'bond', '关系', 'Bond', 'string', 'badge', ['陌生', 'strangers'], '', '好感过 30、60、85 时依次变成熟人、亲近、恋人；跌回去时也跟着改', 'acquaintances, close, lovers as affection passes 30, 60, 85; back again when it falls'], // i18n-ignore: a variable in a card
    ['c', '心情', 'mood', '心情', 'Mood', 'string', 'text', ['平静', 'calm'], '', '每轮按她这一刻的心情写一个词', 'one word each turn for how she feels right now'], // i18n-ignore: a variable in a card
    ['p', '约定', 'promises', '约定', 'Promises', 'list', 'tags', ['', ''], '', '答应了还没做的事加进来；做到或作废后去掉', 'add what was promised and not yet done; take it out once kept or called off'], // i18n-ignore: a variable in a card
  ],
  adventure: [
    ['p', '体力', 'stamina', '体力', 'Stamina', 'number', 'meter', ['100', '100'], '0~100', '赶路、打斗 -5~20；吃饭、休息 +10~30', '-5 to -20 for travel or a fight; +10 to +30 for a meal or rest'], // i18n-ignore: a variable in a card
    ['p', '金钱', 'money', '金钱', 'Money', 'number', 'number', ['50', '50'], '', '买卖和报酬照实增减', 'goes up and down by what is really paid and earned'], // i18n-ignore: a variable in a card
    ['p', '所在地', 'place', '所在', 'Place', 'string', 'text', ['', ''], '', '换了地方就改', 'changes when the place does'], // i18n-ignore: a variable in a card
    ['p', '背包', 'bag', '背包', 'Bag', 'book', 'table', ['干粮|3|三天的份', 'rations|3|three days of food'], '', '得到东西加一行；用掉减数量，用完删行', 'a row for each thing gained; the count goes down as it is used, the row goes when none is left'], // i18n-ignore: a variable in a card
    ['p', '任务', 'quests', '任务', 'Quests', 'list', 'list', ['', ''], '', '接下的事加进来；做完或放弃后去掉', 'add what was taken on; take it out when done or dropped'], // i18n-ignore: a variable in a card
  ],
  mystery: [
    ['p', '线索', 'clues', '线索', 'Clues', 'list', 'list', ['', ''], '', '查到确实的线索加一条，一句话写清', 'add each clue that is really found, in one clear line'], // i18n-ignore: a variable in a card
    ['p', '理智', 'nerve', '理智', 'Nerve', 'number', 'meter', ['80', '80'], '0~100', '撞见说不通的事 -5~15；睡足、有人陪着 +5', '-5 to -15 for meeting what cannot be explained; +5 for sleep or company'], // i18n-ignore: a variable in a card
    ['w', '剩余天数', 'days_left', '还剩', 'Days left', 'number', 'number', ['7', '7'], '0~7', '每过一天 -1；到 0 时该发生的事发生', '-1 for each day that passes; at 0 what was coming comes'], // i18n-ignore: a variable in a card
    ['c', '可疑', 'suspicion', '可疑', 'Suspicion', 'number', 'meter', ['30', '30'], '0~100', '说法对不上、行踪有空白时 +5~15；有了旁证 -10~30', '+5 to +15 when a story does not add up or time is unaccounted for; -10 to -30 when someone else bears it out'], // i18n-ignore: a variable in a card
  ],
  survival: [
    ['p', '饱腹', 'fullness', '饱腹', 'Fullness', 'number', 'meter', ['70', '70'], '0~100', '每过半天 -10；吃东西按分量 +10~40', '-10 for each half day; +10 to +40 for food, by how much'], // i18n-ignore: a variable in a card
    ['p', '伤势', 'wounds', '伤势', 'Wounds', 'string', 'badge', ['无伤', 'unhurt'], '', '受伤、恶化、好转时改：无伤、轻伤、重伤、垂危', 'unhurt, lightly hurt, badly hurt or dying, as it changes'], // i18n-ignore: a variable in a card
    ['p', '物资', 'supplies', '物资', 'Supplies', 'book', 'table', ['清水|2|两壶', 'water|2|two flasks'], '', '找到加一行；用掉减数量，用完删行', 'a row for each thing found; the count goes down as it is used, the row goes when none is left'], // i18n-ignore: a variable in a card
    ['w', '第几天', 'day', '第几天', 'Day', 'number', 'number', ['1', '1'], '', '每过一天 +1', '+1 for each day that passes'], // i18n-ignore: a variable in a card
    ['w', '天气', 'weather', '天气', 'Weather', 'string', 'text', ['阴', 'overcast'], '', '每天换一次，照季节来', 'changes once a day, as the season would have it'], // i18n-ignore: a variable in a card
  ],
  growth: [
    ['p', '境界', 'rank', '境界', 'Rank', 'string', 'badge', ['入门', 'novice'], '', '突破时改，一次只升一级', 'changes at a breakthrough, one step at a time'], // i18n-ignore: a variable in a card
    ['p', '修为', 'progress', '修为', 'Progress', 'number', 'meter', ['0', '0'], '0~100', '修炼、历练 +1~8；满了才能突破，突破后清零', '+1 to +8 for training or trials; a breakthrough needs it full and empties it'], // i18n-ignore: a variable in a card
    ['p', '本事', 'skills', '本事', 'Skills', 'list', 'tags', ['', ''], '', '学会一样加进来', 'add each one learned'], // i18n-ignore: a variable in a card
    ['p', '资源', 'resources', '资源', 'Resources', 'number', 'number', ['10', '10'], '', '得到和花掉照实增减', 'goes up and down by what is really gained and spent'], // i18n-ignore: a variable in a card
  ],
  business: [
    ['p', '资金', 'funds', '资金', 'Funds', 'number', 'number', ['1000', '1000'], '', '进账和开销照实增减', 'goes up and down by what is really taken in and paid out'], // i18n-ignore: a variable in a card
    ['p', '口碑', 'name', '口碑', 'Good name', 'number', 'meter', ['10', '10'], '0~100', '客人满意 +1~3；出了岔子 -3~10', '+1 to +3 for a happy customer; -3 to -10 for a blunder'], // i18n-ignore: a variable in a card
    ['w', '第几天', 'day', '第几天', 'Day', 'number', 'number', ['1', '1'], '', '每过一天 +1', '+1 for each day that passes'], // i18n-ignore: a variable in a card
    ['w', '时段', 'time', '时段', 'Time', 'string', 'badge', ['上午', 'morning'], '', '上午、下午、晚上轮着走；过了晚上是第二天上午', 'morning, afternoon, evening in turn; after evening comes the next morning'], // i18n-ignore: a variable in a card
    ['p', '家当', 'holdings', '家当', 'Holdings', 'book', 'table', ['柜台|1|旧的，还能用', 'counter|1|old but it works'], '', '添置加一行；升级或坏了改那一行', 'a row for each thing bought; change the row when it is improved or breaks'], // i18n-ignore: a variable in a card
  ],
}

/** The sets there are, in the order they are offered. */
export const VARIABLE_TEMPLATES = Object.keys(TEMPLATES)

/**
 * A set's variables as a plan keeps them.
 * @param character - the card's main character, whose values the set's own-character variables are.
 * @param english - the card's language.
 */
export function templateVariables(id, { character = '', english = false } = {}) {
  const roots = { ...TEMPLATE_ROOTS[english ? 'en' : 'zh'], c: String(character ?? '').trim() }
  const at = english ? 1 : 0
  return (TEMPLATES[id] ?? [])
    // Without a main character (a world card) the set goes without what is theirs.
    .filter(([owner]) => roots[owner])
    .map(([owner, zhName, enName, zhLabel, enLabel, type, show, initial, range, zhCheck, enCheck]) => ({
      path: `${roots[owner]}.${english ? enName : zhName}`,
      label: english ? enLabel : zhLabel,
      type,
      show,
      initial: initial[at],
      range,
      check: english ? enCheck : zhCheck,
      ...(type === 'book' ? { columns: english ? ['count', 'note'] : ['数量', '说明'] } : {}), // i18n-ignore: a variable in a card
    }))
}
