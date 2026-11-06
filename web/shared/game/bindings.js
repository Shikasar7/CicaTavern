// 游戏规则 and a card's own variables. A field of the sheet can live in one of them (主角.体力): the story keeps
// it as the card says, the rules read it, and write it only for what they settle themselves. Cards keep
// these in many shapes, so everything here reads what is there and changes it in the same shape.
import { getPath, isDescribed, unwrap } from '../vars.js'

/** The fields a variable can stand for. */
export const BINDABLE = ['life', 'maxLife', 'energy', 'maxEnergy', 'sanity', 'level', 'rank', 'money', 'things', 'quests']

const NAME_KEYS = ['name', '名称', '名字', '物品', '道具', 'title', '标题']
const COUNT_KEYS = ['count', '数量', '个数', 'num']
const NOTE_KEYS = ['效果', '描述', '说明', '内容', 'effect', 'description', 'note']
const STATE_KEYS = ['状态', 'status']
const WORDS = /[、，,;；]/
const MAX_DEPTH = 4
const clip = (text, max = 40) => String(text).trim().slice(0, max)
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const firstKey = (item, keys) => keys.find(key => item[key] !== undefined)

export function cleanBindings(value) {
  const out = {}
  if (!isRecord(value)) return out
  for (const field of BINDABLE) if (typeof value[field] === 'string' && value[field].trim()) out[field] = value[field].trim().slice(0, 120)
  return out
}

/** The number at a path, or null for anything else. */
export function numberAt(state, path) {
  const value = unwrap(getPath(state ?? {}, path))
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function addThing(things, name, count, note = '') {
  const key = clip(name)
  if (!key) return
  const held = things.find(thing => thing.name === key)
  if (held) held.count += count
  else things.push({ name: key, count, ...(note ? { note: clip(note, 120) } : {}) })
}

const countOf = item => {
  const key = firstKey(item, COUNT_KEYS)
  const count = key ? Number(unwrap(item[key])) : 1
  return Number.isFinite(count) ? count : 1
}
const noteOf = item => {
  const key = firstKey(item, NOTE_KEYS)
  return key && typeof item[key] === 'string' ? item[key] : ''
}

/** The things a variable holds: [{ name, count, note? }], or null for a shape that is no bag. */
export function bagItems(value) {
  const v = unwrap(value)
  const things = []
  if (v === undefined || v === null || v === '') return things
  if (typeof v === 'string') {
    v.split(WORDS).forEach(word => addThing(things, word, 1))
    return things
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string') addThing(things, item, 1)
      else if (isRecord(item) && firstKey(item, NAME_KEYS)) addThing(things, item[firstKey(item, NAME_KEYS)], countOf(item), noteOf(item))
      else return null
    }
    return things.filter(thing => thing.count > 0)
  }
  if (!isRecord(v)) return null
  for (const [name, raw] of Object.entries(v)) {
    if (name.startsWith('$')) continue
    const item = unwrap(raw)
    if (typeof item === 'number') addThing(things, name, item)
    else if (typeof item === 'string') addThing(things, name, 1, item)
    else if (isRecord(item)) addThing(things, name, countOf(item), noteOf(item))
    else if (item === true) addThing(things, name, 1)
    else if (item !== false) return null
  }
  return things.filter(thing => thing.count > 0)
}

function changeList(list, name, delta) {
  const next = structuredClone(list)
  const sample = next.find(isRecord)
  const nameKey = sample ? firstKey(sample, NAME_KEYS) : null
  const named = item => (isRecord(item) ? nameKey && item[nameKey] === name : item === name)
  if (delta > 0) {
    const held = next.find(named)
    const countKey = isRecord(held) ? firstKey(held, COUNT_KEYS) : null
    if (countKey) held[countKey] = countOf(held) + delta
    else if (sample) next.push({ [nameKey ?? NAME_KEYS[1]]: name, ...(firstKey(sample, COUNT_KEYS) ? { [firstKey(sample, COUNT_KEYS)]: delta } : {}) })
    else for (let i = 0; i < delta; i++) next.push(name)
    return next
  }
  let left = -delta
  for (let i = next.length - 1; i >= 0 && left > 0; i--) {
    if (!named(next[i])) continue
    const countKey = isRecord(next[i]) ? firstKey(next[i], COUNT_KEYS) : null
    const count = countKey ? countOf(next[i]) : 1
    if (count > left) {
      next[i][countKey] = count - left
      left = 0
    } else {
      next.splice(i, 1)
      left -= count
    }
  }
  return next
}

function changeMap(map, name, delta) {
  const next = structuredClone(map)
  const raw = next[name]
  const item = unwrap(raw)
  if (raw === undefined) {
    if (delta > 0) next[name] = delta
    return next
  }
  const countKey = isRecord(item) ? firstKey(item, COUNT_KEYS) : null
  const count = (typeof item === 'number' ? item : countKey ? countOf(item) : 1) + delta
  if (count <= 0) delete next[name]
  else if (isDescribed(raw)) raw[0] = count
  else if (typeof item === 'number') next[name] = count
  else if (countKey) item[countKey] = count
  return next
}

/** A bag with `delta` more of a thing, in the shape it came in. */
export function bagChanged(value, name, delta) {
  const v = unwrap(value)
  if (v === undefined || v === null || v === '') return delta > 0 ? Array(delta).fill(name) : []
  if (typeof v === 'string') return changeList(v.split(WORDS).map(word => word.trim()).filter(Boolean), name, delta).join('、') // i18n-ignore: a state value
  return Array.isArray(v) ? changeList(v, name, delta) : changeMap(v, name, delta)
}

const questStatus = text => (/失败/.test(text) ? 'failed' : /完成|已结束/.test(text) ? 'done' : 'new')

/** The quests a variable holds: [{ title, note, status }], or null for a shape that is none. */
export function questsAt(value) {
  const v = unwrap(value)
  if (v === undefined || v === null || v === '') return []
  const quest = (title, note = '', status = 'new') => ({ title: clip(title), note: clip(note, 120), status })
  if (typeof v === 'string') return v.split(WORDS).map(word => quest(word)).filter(item => item.title)
  const fromRecord = (item, title) => {
    const key = firstKey(item, STATE_KEYS)
    return quest(title, noteOf(item), key ? questStatus(String(item[key])) : 'new')
  }
  if (Array.isArray(v)) {
    const quests = []
    for (const item of v) {
      if (typeof item === 'string') quests.push(quest(item))
      else if (isRecord(item) && firstKey(item, NAME_KEYS)) quests.push(fromRecord(item, item[firstKey(item, NAME_KEYS)]))
      else return null
    }
    return quests
  }
  if (!isRecord(v)) return null
  return Object.entries(v).filter(([title]) => !title.startsWith('$')).map(([title, raw]) => {
    const item = unwrap(raw)
    if (typeof item === 'boolean') return quest(title, '', item ? 'done' : 'new')
    if (isRecord(item)) return fromRecord(item, title)
    return quest(title, String(item ?? ''), questStatus(String(item ?? '')))
  })
}

/** Every variable that could stand for a field: [{ path, kind: 'number'|'list'|'words' }]. */
export function variablePaths(state) {
  const paths = []
  const walk = (value, prefix, depth) => {
    for (const [key, raw] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      const item = unwrap(raw)
      if (typeof item === 'number') paths.push({ path, kind: 'number' })
      else if (typeof item === 'string') paths.push({ path, kind: 'words' })
      else if (Array.isArray(item)) paths.push({ path, kind: 'list' })
      else if (isRecord(item)) {
        paths.push({ path, kind: 'list' })
        if (depth < MAX_DEPTH) walk(item, path, depth + 1)
      }
    }
  }
  if (isRecord(state)) walk(state, '', 1)
  return paths
}

const GUESSES = {
  maxLife: /^\$?(最大|max).*(生命|血量|气血|hp|体力|耐力)|(生命|血量|气血|体力|耐力)上限$/i,
  maxEnergy: /^\$?(最大|max).*(气力|内力|法力|灵力|精力|mp|真气)|(气力|内力|法力|灵力|精力|真气)上限$/i,
  life: /^(生命|生命值|血量|气血|hp|体力|耐力)$/i,
  energy: /^(气力|内力|法力|灵力|精力|mp|真气)$/i,
  sanity: /^(理智|理智值|san|san值|sanity|精神值)$/i,
  level: /^(等级|level|lv)$/i,
  rank: /^(境界|等级|段位|军衔|阶位|位阶|rank|realm)$/i,
  money: /^(金钱|银两|灵石|积分|余额|金币|铜钱|钱)$/,
  things: /^(背包|物品|道具|行囊|储物袋)$/,
  quests: /^(任务|主线|支线|目标)$/,
}
const PLAYER_ROOT = /^(主角|玩家|user|player|你)(\.|$)/i
const LIST_ONES = new Set(['things', 'quests'])

/** Whether a variable of this kind can stand for a field. */
export const fitsField = (field, kind) => (LIST_ONES.has(field) ? kind !== 'number' : kind === (field === 'rank' ? 'words' : 'number'))

/** Which variables look like which fields, by their names; the player's own first. */
export function guessBindings(state) {
  const paths = variablePaths(state)
  const ranked = [...paths.filter(item => PLAYER_ROOT.test(item.path)), ...paths.filter(item => !PLAYER_ROOT.test(item.path))]
  const out = {}
  for (const [field, name] of Object.entries(GUESSES)) {
    const found = ranked.find(item => name.test(item.path.split('.').at(-1)) && fitsField(field, item.kind))
    if (found) out[field] = found.path
  }
  return out
}

/** A write of a number to a variable: `[值, "说明"]` keeps its words. */
export function numberWrite(state, path, value) {
  return { op: 'replace', path: isDescribed(getPath(state ?? {}, path)) ? `${path}.0` : path, value }
}
