// Status bar layout (状态栏): which variables show under the latest reply, how,
// and in what order. A card made in the card creator carries one
// (extensions.cicatavern.status_bar); for other cards with variables the page
// lays one out from the state itself. Shared by the server (cards, card
// creator) and the page (drawing it).
//   { title: '林小雨', fields: [
//       { path: '林小雨.好感度', label: '好感', show: 'meter', min: 0, max: 100 },
//       { path: '林小雨.心情', show: 'text' },
//       { path: '你.随身物品', label: '随身', show: 'tags' } ] }
import { getPath, splitPath, unwrap } from './vars.js'

export const SHOWS = ['meter', 'number', 'text', 'tags', 'flag', 'hidden']
const MAX_FIELDS = 40
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
export const STATUS_THEMES = ['plain', 'paper', 'neon', 'pastel']

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
    fields.push(out)
  }
  // The look picked in 创作角色卡 (paper, neon, pastel); none = the plain one.
  const theme = STATUS_THEMES.includes(raw.theme) && raw.theme !== 'plain' ? { theme: raw.theme } : {}
  return fields.some(f => f.show !== 'hidden') ? { title: str(raw.title, 40), fields, ...theme } : null
}

// Names of 0–100 gauges in MVU cards: 好感度, 信任值, 体力, 欲望, HP… (a guess; other numbers stay numbers).
const GAUGE = /(度|值|率|感|欲|力|HP|MP|SP|进度)$/i

function guessShow(key, value) {
  if (typeof value === 'number') return value >= 0 && value <= 100 && GAUGE.test(key) ? 'meter' : 'number'
  if (typeof value === 'boolean') return 'flag'
  if (Array.isArray(value) && value.every(v => v === null || typeof v !== 'object')) return 'tags'
  return 'text'
}

/**
 * A layout for a state nobody laid out: objects open up two levels deep
 * (character → their values), `$` keys stay hidden as MVU intends.
 */
export function autoStatusSpec(state) {
  const fields = []
  const walk = (value, keys) => {
    for (const [key, raw] of Object.entries(value)) {
      if (fields.length >= MAX_FIELDS) return
      if (key.startsWith('$')) continue
      const inner = unwrap(raw)
      const path = [...keys, key]
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && keys.length < 1 && Object.keys(inner).length) walk(inner, path)
      else {
        const show = guessShow(key, inner)
        fields.push(show === 'meter' ? { path: joinPath(path), show, min: 0, max: 100 } : { path: joinPath(path), show })
      }
    }
  }
  if (state && typeof state === 'object') walk(state, [])
  return cleanStatusSpec({ title: '', fields })
}

/** One line of text for any value: lists joined, objects as `key：value；…`. */
export function compactText(value, max = 160) {
  const v = unwrap(value)
  let text
  if (v === undefined || v === null) text = ''
  else if (typeof v !== 'object') text = String(v)
  else if (Array.isArray(v)) text = v.map(x => compactText(x, max)).filter(Boolean).join('、') // i18n-ignore: state values
  else text = Object.entries(v).map(([k, x]) => `${k}：${compactText(x, max)}`).join('；') // i18n-ignore: state values
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function tagsOf(value) {
  const v = unwrap(value)
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v.map(x => compactText(x, 40)).filter(Boolean)
  if (typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => {
      const inner = unwrap(x)
      return typeof inner === 'number' ? `${k} ×${inner}` : k
    })
  }
  return String(v).split(/[、，,;；]/).map(s => s.trim()).filter(Boolean)
}

const round = n => Math.round(n * 100) / 100

/**
 * The rows to draw, grouped by owner (a path's second-to-last part:
 * 林小雨.好感度 → 林小雨). `previous`: the state before this reply, for the
 * change marks (+4, −8).
 */
export function statusGroups(spec, state, previous = null) {
  const groups = []
  for (const field of spec?.fields ?? []) {
    if (field.show === 'hidden') continue
    const keys = splitPath(field.path)
    const value = unwrap(getPath(state ?? {}, field.path))
    if (value === undefined) continue
    const row = { path: field.path, label: field.label || keys.at(-1), show: field.show }
    if (field.show === 'meter' || field.show === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) {
        Object.assign(row, { show: 'text', text: compactText(value) })
      } else {
        row.value = n
        const before = previous ? Number(unwrap(getPath(previous, field.path))) : NaN
        if (Number.isFinite(before) && before !== n) row.delta = round(n - before)
        if (field.show === 'meter') row.percent = Math.max(0, Math.min(100, ((n - field.min) / (field.max - field.min)) * 100))
      }
    } else if (field.show === 'tags') row.tags = tagsOf(value)
    else if (field.show === 'flag') row.on = Boolean(value) && value !== 'false' && value !== '否' // i18n-ignore: a state value
    else row.text = compactText(value)
    const name = keys.length > 1 ? keys.at(-2) : ''
    let group = groups.find(g => g.name === name)
    if (!group) groups.push((group = { name, rows: [] }))
    group.rows.push(row)
  }
  return groups.filter(g => g.rows.length)
}
