// 游戏式 HUD (web/vn-hud.js): a few of the story's variables kept on the picture,
// each a bar, a number or an icon, and what a reply changed (好感 +5, 获得：铜钥匙).
// Read from the chat's state and the status bar layout (web/shared/status.js)
// only; the model is asked for nothing. Pure, so Node can test it.
import { getPath, splitPath, unwrap } from './vars.js'

/** How a kept variable looks: a bar, a number, an icon and its number, or its words. */
export const LOOKS = ['meter', 'number', 'icon', 'text']
// Kept when the player has chosen nothing: the layout's first numbers.
const DEFAULT_COUNT = 4
const NUMERIC = new Set(['meter', 'number'])

const round = n => Math.round(n * 100) / 100

/** A field's look when nobody chose one: its number as laid out, else its words. */
const lookOf = field => (NUMERIC.has(field.show) ? field.show : 'text')

/**
 * Which variables the HUD keeps and how: the player's choice for this card
 * (`saved`: { paths, looks }), else the layout's first few numbers (好感, 体力, 金钱…).
 * @returns {{ path: string, look: string }[]}
 */
export function hudPicks(spec, saved = null) {
  const fields = (spec?.fields ?? []).filter(field => field.show !== 'hidden')
  if (Array.isArray(saved?.paths)) {
    return saved.paths.map(path => {
      const field = fields.find(item => item.path === path)
      const look = saved.looks?.[path]
      return { path, look: LOOKS.includes(look) ? look : field ? lookOf(field) : 'text' }
    })
  }
  return fields.filter(field => NUMERIC.has(field.show)).slice(0, DEFAULT_COUNT).map(field => ({ path: field.path, look: field.show }))
}

/** A field's name as the HUD shows it: its label (or last key), after its owner's name when several own the kept ones. */
function namer(spec, paths) {
  const owners = new Set(paths.map(path => splitPath(path).slice(0, -1).join('.')))
  return path => {
    const field = spec?.fields?.find(item => item.path === path)
    const keys = splitPath(path)
    const label = field?.label || keys.at(-1) || path
    return owners.size > 1 && keys.length > 1 ? `${keys.at(-2)}·${label}` : label
  }
}

/** One line of a value's words. */
function wordsOf(value) {
  const v = unwrap(value)
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(wordsOf).filter(Boolean).join('、') // i18n-ignore: state values
  if (typeof v === 'object') return Object.keys(v).join('、') // i18n-ignore: state values
  const text = String(v)
  return text.length > 24 ? `${text.slice(0, 23)}…` : text
}

/**
 * The HUD's rows for a state: { path, label, look, value?, percent?, text?, on?, icon? } (on: a switch, yes or no);
 * a kept variable with no value now is left out, a number that is not one shows as words.
 */
export function hudRows(spec, picks, state) {
  const name = namer(spec, picks.map(pick => pick.path))
  const rows = []
  for (const { path, look } of picks) {
    const value = unwrap(getPath(state ?? {}, path))
    if (value === undefined || value === null || value === '') continue
    const label = name(path)
    if (typeof value === 'boolean') {
      rows.push({ path, label, look: 'text', on: value })
      continue
    }
    const n = Number(value)
    if (look === 'text' || !Number.isFinite(n)) {
      rows.push({ path, label, look: 'text', text: wordsOf(value) })
      continue
    }
    const row = { path, label, look, value: round(n) }
    if (look === 'meter') {
      const field = spec?.fields?.find(item => item.path === path)
      const min = field?.show === 'meter' ? field.min : 0
      const max = field?.show === 'meter' ? field.max : 100
      row.percent = Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100))
    }
    if (look === 'icon') row.icon = iconFor(label)
    rows.push(row)
  }
  return rows
}

/** The things a value holds, with how many of each: a list, a {名字: 数量} bag, or words split on commas. */
function itemsOf(value) {
  const v = unwrap(value)
  const items = new Map()
  const add = (name, count = 1) => {
    const key = String(name).trim()
    if (key) items.set(key, (items.get(key) ?? 0) + count)
  }
  if (v === undefined || v === null || v === '') return items
  if (Array.isArray(v)) {
    for (const item of v) {
      const inner = unwrap(item)
      if (inner !== null && typeof inner === 'object') add(inner.name ?? inner.名称 ?? Object.keys(inner)[0] ?? '') // i18n-ignore: a state key
      else add(inner)
    }
  } else if (typeof v === 'object') {
    for (const [key, count] of Object.entries(v)) {
      const n = Number(unwrap(count))
      add(key, Number.isFinite(n) && n > 0 ? n : 1)
    }
  } else String(v).split(/[、，,;；]/).forEach(part => add(part))
  return items
}

/**
 * What a reply changed, for the notes that pop up at its end: numbers that
 * moved (up / down, by how much), things gained or lost from a list or a bag,
 * switches turned on or off. Words that changed (心情, 位置) say nothing: they
 * change every turn. None when there was no state before.
 * @returns {{ kind: 'up'|'down'|'gain'|'lose'|'on'|'off', label: string, delta?: number, item?: string, count?: number }[]}
 */
export function changeNotes(spec, before, after, { max = 6 } = {}) {
  if (!before || !after) return []
  const fields = (spec?.fields ?? []).filter(field => field.show !== 'hidden')
  const name = namer(spec, fields.map(field => field.path))
  const notes = []
  for (const field of fields) {
    const was = unwrap(getPath(before, field.path))
    const now = unwrap(getPath(after, field.path))
    if (NUMERIC.has(field.show)) {
      const [a, b] = [Number(was), Number(now)]
      if (was === undefined || now === undefined || !Number.isFinite(a) || !Number.isFinite(b) || a === b) continue
      const delta = round(b - a)
      notes.push({ kind: delta > 0 ? 'up' : 'down', label: name(field.path), delta })
    } else if (field.show === 'tags' && was !== undefined) {
      const [had, has] = [itemsOf(was), itemsOf(now)]
      for (const [item, count] of has) if (count > (had.get(item) ?? 0)) notes.push({ kind: 'gain', label: name(field.path), item, count: count - (had.get(item) ?? 0) })
      for (const [item, count] of had) if (count > (has.get(item) ?? 0)) notes.push({ kind: 'lose', label: name(field.path), item, count: count - (has.get(item) ?? 0) })
    } else if (field.show === 'flag' && was !== undefined && now !== undefined) {
      const on = value => Boolean(value) && value !== 'false' && value !== '否' // i18n-ignore: a state value
      if (on(was) !== on(now)) notes.push({ kind: on(now) ? 'on' : 'off', label: name(field.path) })
    }
  }
  return notes.slice(0, max)
}

// A little picture for a variable's name, for the HUD's icon look.
const ICONS = [
  ['❤️', /好感|爱意|喜欢|亲密|羁绊|恋|affection|love/i],
  ['🤝', /信任|友谊|友情|关系|trust/i],
  ['⚡', /体力|精力|耐力|活力|stamina|energy/i],
  ['🩸', /生命|血量|血|健康|伤|\bhp\b|health/i],
  ['🔮', /魔力|法力|灵力|内力|真气|\bmp\b|mana/i],
  ['💰', /金钱|金币|银两|铜钱|货币|钱|金|币|gold|money|coin/i],
  ['🔥', /欲望|性欲|兴奋|情欲|热情|lust|arous/i],
  ['🧠', /理智|san|理性|sanity/i],
  ['😊', /心情|情绪|快乐|mood/i],
  ['🍖', /饥饿|饱食|食物|hunger/i],
  ['⭐', /声望|名望|名声|人气|fame|reputation/i],
  ['✨', /经验|exp/i],
  ['🎖️', /等级|级别|\blv\b|level/i],
  ['😨', /恐惧|压力|紧张|fear|stress/i],
]

/** The icon for a variable's name, or a plain diamond. */
export function iconFor(label) {
  return ICONS.find(([, pattern]) => pattern.test(String(label ?? '')))?.[0] ?? '◆'
}
