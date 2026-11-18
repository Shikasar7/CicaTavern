// 导入角色卡 with a zip that is no pack of this app's (card-pack.mjs takes those):
//   .charx      card.json at the top with its pictures listed in it (data.assets): the card, its picture, its 表情
//               and backgrounds go in at once.
//   anything else (an 整合包 someone put together): looked through first, nothing kept, and what it has is shown to
//               tick: cards, worldbooks, regex, presets, pictures listed in a JSON beside them (who each is, their
//               faces, groups of CG), folders of 表情 named the SillyTavern way, other folders of pictures.
// Only what the files are tells what they are, never their names; pictures are checked by their first bytes.
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { zipData, zipEntries } from '../web/shared/zip.js'
import { EXPRESSIONS, PACK_NAMES, PACK_PICTURE, packFaces } from '../web/shared/stage.js'
import { normalizePlace } from '../web/shared/vn.js'
import { imageKind } from './appearance.mjs'
import { parseCardFile } from './cards.mjs'
import { cleanCardMedia } from './media.mjs'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const inflateRaw = promisify(zlib.inflateRaw)
export const MAX_BUNDLE_ENTRIES = 6000
const MAX_JSON = 32 * 1024 * 1024
const MAX_CARD_FILE = 150 * 1024 * 1024
const MAX_PICTURE = 15 * 1024 * 1024
// A 立绘, an expression, a scene or a CG: what scenes.mjs and card-cgs.mjs keep.
const MAX_SPRITE = 12 * 1024 * 1024
const PICTURE = /\.(png|jpe?g|webp)$/i
// RisuAI's spelling, the right one, and the older one.
const EMBEDDED = ['embeded://', 'embedded://', '__asset:']
const SKIP = /(^|\/)(__MACOSX|\.[^/]*)(\/|$)/
const record = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const baseName = file => file.split('/').pop().replace(/\.[^.]+$/, '')
const folderOf = file => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

/** A zip opened for reading: its files by name, and `file(name, max)` → Buffer | null (too big, encrypted, unreadable). */
export function openZip(buffer) {
  let entries
  try {
    entries = zipEntries(buffer)
  } catch {
    throw httpError(400, msg`这个 zip 读不出来（分卷、zip64 和加密的 zip 不支持；7z、rar 先解压，再选里面的卡）`)
  }
  if (entries.length > MAX_BUNDLE_ENTRIES) throw httpError(400, msg`这个 zip 里的文件太多`)
  const byName = new Map(entries.filter(entry => !SKIP.test(entry.name)).map(entry => [entry.name, entry]))
  const file = async (name, max) => {
    const entry = byName.get(name)
    if (!entry || entry.encrypted || entry.size > max || entry.compressed > max) return null
    try {
      const data = Buffer.from(await zipData(buffer, entry, bytes => inflateRaw(bytes, { maxOutputLength: max })))
      return data.length <= max ? data : null
    } catch {
      return null
    }
  }
  return { names: [...byName.keys()], has: name => byName.has(name), file }
}

const jsonOf = async (zip, name, max = MAX_JSON) => {
  const data = await zip.file(name, max)
  if (!data) return null
  try {
    return JSON.parse(data.toString('utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/** A picture's bytes when they are a PNG, JPG or WebP within the size, else null. */
async function pictureOf(zip, name, max = MAX_PICTURE) {
  const data = await zip.file(name, max)
  return data && imageKind(data) ? data : null
}

/** 'charx' when the zip is a CharX (card.json at the top, a card in it), else 'bundle'. */
export async function zipKind(zip) {
  if (!zip.has('card.json')) return 'bundle'
  const card = await jsonOf(zip, 'card.json', MAX_CARD_FILE)
  return card && typeof card === 'object' && typeof card.spec === 'string' ? 'charx' : 'bundle'
}

// ─── .charx ─────────────────────────────────────────────────────────────

/** An asset's path in the zip, from its uri, or '' when it is not in the zip (a link, the card's default). */
function assetPath(uri) {
  const value = String(uri ?? '').trim()
  const prefix = EMBEDDED.find(item => value.toLowerCase().startsWith(item))
  return prefix ? value.slice(prefix.length).replace(/^\/+/, '') : ''
}

/**
 * A CharX → { card: { filename, buffer }, faces: { expression: path }, backgrounds: [{ name, path }], left: [names],
 * iconPath }. The card's picture (the icon named main, else the first) goes into the card's PNG when it is one, else
 * its path in the zip is iconPath (web/card-pack.js makes it a PNG and sets it); 表情 named the
 * SillyTavern or RisuAI way take the expression they mean (the plainest of several for one); the rest is listed.
 */
export async function readCharx(zip, writeCardPng) {
  const raw = await jsonOf(zip, 'card.json', MAX_CARD_FILE)
  if (!raw || typeof raw.spec !== 'string') throw httpError(400, msg`这个 .charx 里没有角色卡`)
  const assets = (Array.isArray(raw.data?.assets) ? raw.data.assets : []).map(asset => ({ ...record(asset), path: assetPath(asset?.uri) })).filter(asset => asset.path && zip.has(asset.path))
  const icons = assets.filter(asset => asset.type === 'icon' && PICTURE.test(asset.path))
  const icon = icons.find(asset => String(asset.name).toLowerCase() === 'main') ?? icons[0]
  const iconData = icon ? await pictureOf(zip, icon.path, MAX_CARD_FILE) : null
  let card = { filename: 'card.json', buffer: Buffer.from(JSON.stringify(raw), 'utf8') }
  const left = []
  // A picture that is no PNG (WebP, JPG): the page turns it into one from the file it still has (iconPath).
  let iconPath = ''
  if (iconData && imageKind(iconData) === 'png') card = { filename: 'card.png', buffer: writeCardPng(iconData, raw) }
  else if (iconData) iconPath = icon.path
  // 表情: by the asset's name (joy, 喜悦…), as a SillyTavern pack is read by its file names.
  const emotions = assets.filter(asset => ['emotion', 'expression'].includes(asset.type) && PICTURE.test(asset.path))
  const named = emotions.map(asset => `${clip(asset.name, 40) || baseName(asset.path)}.${asset.path.split('.').pop()}`)
  const faces = {}
  for (const pack of packFaces(named)) {
    for (const [expression, file] of Object.entries(pack.faces)) if (!faces[expression]) faces[expression] = emotions[named.indexOf(file)].path
  }
  const used = new Set(Object.values(faces))
  for (const asset of emotions) if (!used.has(asset.path)) left.push(clip(asset.name, 40) || baseName(asset.path))
  const backgrounds = assets.filter(asset => asset.type === 'background' && PICTURE.test(asset.path)).map(asset => ({ name: clip(asset.name, 40) || baseName(asset.path), path: asset.path }))
  // The card's CG as this app exports them (CG_FIELD), in their groups and order; other pictures are left out.
  const groups = new Map()
  for (const asset of assets) {
    const group = clip(asset[CG_FIELD], 40)
    if (!group || !PICTURE.test(asset.path)) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(asset.path)
  }
  const cgs = [...groups].map(([name, pictures]) => ({ name, pictures }))
  const others = assets.filter(asset => asset !== icon && !asset[CG_FIELD] && !['icon', 'user_icon', 'emotion', 'expression', 'background'].includes(asset.type))
  if (others.length) left.push(msg`别的图 ${others.length} 张`)
  if (zip.names.some(name => name.endsWith('.risum'))) left.push(msg`RisuAI 模块`)
  return { card, faces, backgrounds, cgs, left, iconPath }
}

// The expressions as SillyTavern's labels (its expression extension and a CharX's emotion assets read these), each the
// first of its list in PACK_NAMES that SillyTavern knows: read back here, they take the same expression.
export const ST_LABELS = { neutral: 'neutral', smile: 'approval', happy: 'joy', shy: 'embarrassment', angry: 'anger', sad: 'sadness', surprised: 'surprise', thinking: 'curiosity' }
// A CharX's asset of the card's CG: an ordinary 'other' picture elsewhere (SillyTavern keeps those with the card's
// images), with the group it belongs to for this app to read back.
export const CG_FIELD = 'x_cicatavern_cg'

/**
 * 导出 → .charx: the card file (SillyTavern V3) and its pictures in one zip, as SillyTavern 1.13 and later and RisuAI
 * import it: the card's picture as its icon, the card's own character's 立绘 and expressions as emotions (by
 * SillyTavern's labels), the scenes as backgrounds, the card's CG as other pictures (CG_FIELD says whose group).
 * @param pictures - { icon: Buffer | null, faces: { expression: Buffer }, backgrounds: [{ name, data }], cgs: [{ group, data }] }
 * → [{ name, data }] for zipParts, and what went in: { faces, backgrounds, cgs }.
 */
export function charxFiles(written, { icon = null, faces = {}, backgrounds = [], cgs = [] }) {
  const files = []
  const assets = []
  const add = (type, folder, base, data, extra = {}) => {
    const ext = imageKind(data)
    if (!ext) return
    const name = `assets/${folder}/${base}.${ext}`
    files.push({ name, data })
    assets.push({ type, uri: `embeded://${name}`, name: extra.name ?? base, ext, ...extra.fields })
  }
  if (icon) add('icon', 'icon', 'main', icon)
  for (const [expression, data] of Object.entries(faces)) if (ST_LABELS[expression]) add('emotion', 'emotion', ST_LABELS[expression], data)
  backgrounds.forEach((item, i) => add('background', 'background', `bg${i + 1}`, item.data, { name: item.name }))
  cgs.forEach((item, i) => add('other', 'other', `cg${i + 1}`, item.data, { name: `${item.group} ${i + 1}`, fields: { [CG_FIELD]: item.group } }))
  const card = { ...written, data: { ...written.data, assets } }
  return {
    files: [{ name: 'card.json', data: Buffer.from(JSON.stringify(card, null, 2), 'utf8') }, ...files],
    counts: { faces: Object.keys(faces).filter(key => ST_LABELS[key]).length, backgrounds: backgrounds.length, cgs: cgs.length },
  }
}

// ─── 整合包 ─────────────────────────────────────────────────────────────

const isBook = json => record(json).entries && typeof json.entries === 'object' && !json.spec && !json.data
const isRegex = json => (Array.isArray(json) ? json.length > 0 && json.every(item => typeof record(item).findRegex === 'string') : typeof record(json).findRegex === 'string')
const isPreset = json => Array.isArray(record(json).prompts) && (Array.isArray(json.prompt_order) || 'temperature' in json || 'openai_max_context' in json)
const isCardJson = json => {
  const data = record(json).data ?? json
  return typeof record(data).name === 'string' && (typeof json.spec === 'string' || 'first_mes' in record(data) || 'description' in record(data)) && !isBook(json)
}

/** A mood as compared: mood-joy, emotion_joy and Joy are joy. */
const moodWord = mood => String(mood ?? '').toLowerCase().replace(/^(mood|emotion|expression|face)[-_]/, '').trim()

/**
 * Pictures a JSON in the zip lists with who they are: { people: [{ name, portrait, faces: { expression: path },
 * left }], groups: [{ name, pictures: [path] }], paths: Set } (empty when it lists none). Read by shape only: an
 * object with a path to a picture in the zip and a name is someone's picture, with a mood or expression too it is
 * one of their faces; an object with a list of such is a group of CG.
 */
function listedPictures(json, zip) {
  const people = new Map()
  const groups = []
  const paths = new Set()
  const pathOf = item => {
    for (const key of ['zipPath', 'path', 'file', 'src']) {
      const value = record(item)[key]
      if (typeof value === 'string' && PICTURE.test(value) && zip.has(value.replace(/^\.?\//, ''))) return value.replace(/^\.?\//, '')
    }
    return ''
  }
  const person = name => {
    if (!people.has(name)) people.set(name, { name, portrait: '', words: {} })
    return people.get(name)
  }
  const walk = (value, key = '') => {
    if (Array.isArray(value)) return value.forEach(item => walk(item, key))
    if (!value || typeof value !== 'object') return
    // A group: a name and a list of pictures.
    const list = Object.values(value).find(item => Array.isArray(item) && item.length && item.every(entry => pathOf(entry)))
    const groupName = clip(value.group ?? value.title ?? value.name, 40)
    if (list && groupName) {
      const pictures = list.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0)).map(pathOf)
      groups.push({ name: groupName, pictures })
      pictures.forEach(path => paths.add(path))
      return
    }
    const path = pathOf(value)
    const who = clip(value.name ?? value.character ?? value.char, 40)
    if (path && who) {
      const mood = value.moodId ?? value.mood ?? value.emotion ?? value.expression
      if (typeof mood === 'string' && moodWord(mood)) person(who).words[moodWord(mood)] = path
      else if (/avatar|portrait|icon|head|头像|立绘/i.test(key)) person(who).portrait = path
      else return
      paths.add(path)
      return
    }
    for (const [k, item] of Object.entries(value)) walk(item, k)
  }
  walk(json)
  // Each expression takes the mood its SillyTavern list names first (anger before disgust); a calm face is the
  // portrait when there is none (the 立绘 stays the player's to give: a square face is no half-body picture).
  const out = [...people.values()].map(entry => {
    const faces = {}
    for (const [expression, names] of Object.entries(PACK_NAMES)) {
      const word = names.find(name => entry.words[name])
      if (word && expression !== 'neutral') faces[expression] = entry.words[word]
      else if (word && !entry.portrait) entry.portrait = entry.words[word]
    }
    const used = new Set([...Object.values(faces), entry.portrait])
    return { name: entry.name, portrait: entry.portrait, faces, left: Object.keys(entry.words).filter(mood => !used.has(entry.words[mood])) }
  })
  return { people: out, groups, paths }
}

/** A folder's pictures go to scenes or CG by its name, else nowhere until ticked. */
function folderSuggest(folder) {
  const last = normalizePlace(folder.split('/').pop())
  const top = normalizePlace(folder.split('/')[0])
  if (/^(cg|cgs|插图|事件图|事件|剧情图|event|events)$/.test(top) || /^(cg|cgs)$/.test(last)) return 'cgs'
  if (/^(背景|场景|bg|bgs|background|backgrounds|scene|scenes)$/.test(last) || /^(背景|场景|bg|bgs|background|backgrounds|scene|scenes)$/.test(top)) return 'scenes'
  return 'skip'
}

/**
 * What an 整合包 has, for the window to tick (no file kept): { cards: [{ path, name }], books: [{ path, name,
 * entries }], regex: [{ path, name, count }], presets: [{ path, name }], people: [{ key, name, portrait, faces,
 * left, from }], groups: [{ name, pictures }], folders: [{ folder, pictures, suggest }], others: [path] }.
 */
export async function surveyBundle(zip) {
  const out = { cards: [], books: [], regex: [], presets: [], people: [], groups: [], folders: [], others: [] }
  const claimed = new Set()
  const pictures = zip.names.filter(name => PICTURE.test(name))
  for (const name of zip.names) {
    if (/\.png$/i.test(name)) {
      const data = await zip.file(name, MAX_CARD_FILE)
      let raw = null
      try {
        raw = data ? parseCardFile(name, data).raw : null
      } catch {
        // a picture, not a card
      }
      if (raw) {
        out.cards.push({ path: name, name: clip(record(raw.data ?? raw).name, 80) || baseName(name) })
        claimed.add(name)
      }
      continue
    }
    if (!/\.json$/i.test(name)) continue
    const json = await jsonOf(zip, name)
    claimed.add(name)
    if (!json) {
      out.others.push(name)
      continue
    }
    if (isCardJson(json)) out.cards.push({ path: name, name: clip((json.data ?? json).name, 80) })
    else if (isBook(json)) out.books.push({ path: name, name: clip(json.name, 80) || baseName(name), entries: Object.keys(json.entries).length })
    else if (isRegex(json)) out.regex.push({ path: name, name: baseName(name), count: Array.isArray(json) ? json.length : 1 })
    else if (isPreset(json)) out.presets.push({ path: name, name: baseName(name) })
    else {
      const listed = listedPictures(json, zip)
      if (!listed.people.length && !listed.groups.length) {
        out.others.push(name)
        continue
      }
      for (const entry of listed.people) out.people.push({ key: `${name}#${entry.name}`, ...entry, from: name })
      out.groups.push(...listed.groups)
      listed.paths.forEach(path => claimed.add(path))
    }
  }
  // 表情 folders named the SillyTavern way (at least three faces), among the pictures no list claimed.
  const free = pictures.filter(name => !claimed.has(name))
  for (const pack of packFaces(free)) {
    if (Object.keys(pack.faces).length < 3) continue
    const name = pack.folder.split('/').pop()
    out.people.push({ key: `folder:${pack.folder}`, name, portrait: '', faces: pack.faces, left: [], from: pack.folder || '' })
    Object.values(pack.faces).forEach(path => claimed.add(path))
  }
  // The other pictures, by folder.
  const folders = new Map()
  for (const name of pictures) {
    if (claimed.has(name)) continue
    const folder = folderOf(name)
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push(name)
  }
  for (const [folder, list] of folders) out.folders.push({ folder, pictures: list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), suggest: folderSuggest(folder) })
  for (const name of zip.names) if (!claimed.has(name) && !PICTURE.test(name) && !/\.json$/i.test(name) && !name.endsWith('/')) out.others.push(name)
  return out
}

const dataUrl = data => `data:image/${imageKind(data) === 'jpg' ? 'jpeg' : imageKind(data)};base64,${data.toString('base64')}`

/**
 * Bringing a zip's pictures and files onto cards: a CharX's 表情 and backgrounds, an 整合包 as ticked.
 * @param deps.importCard - (body, pack) → the saved card's summary (http.mjs, as 导入角色卡 does it).
 * @param deps.importBook / importPreset - (json, name) → the saved worldbook / preset ({ id, name }).
 */
export function createBundles({ store, media, scenes, cardCgs, regex, importCard, importBook, importPreset }) {
  /** The cast entries for these names on the card, added where it has none: name → entry id. */
  async function castFor(cardId, wanted) {
    const card = await store.getCard(cardId)
    let roster = cleanCardMedia(card.media).roster
    const byName = name => roster.find(entry => [entry.name, ...String(entry.aliases ?? '').split(/[,，、/|]+/)].map(n => n.trim()).includes(name))
    const fresh = [...new Set(wanted.filter(name => name && !byName(name)))]
    if (fresh.length) {
      await media.saveCardMedia(cardId, { ...card.media, roster: [...roster, ...fresh.map(name => ({ name }))] })
      roster = cleanCardMedia((await store.getCard(cardId)).media).roster
    }
    return new Map(wanted.map(name => [name, byName(name)?.id ?? null]))
  }

  /** Someone's pictures: the portrait as their 人设图, faces as expressions (a neutral face as their 立绘). → pictures kept. */
  async function putFaces(cardId, entryId, { portrait = '', faces = {} }, zip) {
    let kept = 0
    if (portrait) {
      const data = await pictureOf(zip, portrait)
      if (data) {
        await media.saveRosterRef(cardId, entryId, dataUrl(data))
        kept++
      }
    }
    for (const [expression, path] of Object.entries(faces)) {
      if (!EXPRESSIONS.includes(expression)) continue
      const data = await pictureOf(zip, path, MAX_SPRITE)
      if (!data) continue
      if (expression === 'neutral') await scenes.setSprite(cardId, entryId, data, 'upload')
      else await scenes.setExpression(cardId, entryId, expression, dataUrl(data))
      kept++
    }
    return kept
  }

  /** Pictures as scenes, each named after its file. */
  async function putScenes(cardId, items, zip) {
    let kept = 0
    for (const { name, path } of items) {
      const data = await pictureOf(zip, path, MAX_SPRITE)
      if (!data) continue
      try {
        await scenes.add(cardId, { name, image: dataUrl(data) })
        kept++
      } catch {
        break // the card's scenes are full
      }
    }
    return kept
  }

  /** Groups of CG, one group at a time (never the whole pack in memory). */
  async function putCgs(cardId, groups, zip) {
    const result = { groups: 0, pictures: 0 }
    for (const group of groups) {
      const pictures = []
      for (const path of group.pictures) {
        const data = await pictureOf(zip, path, MAX_SPRITE)
        if (data) pictures.push(data)
      }
      const got = await cardCgs.bring(cardId, [{ name: group.name, note: group.note, pictures }])
      result.groups += got.groups
      result.pictures += got.pictures
    }
    return result
  }

  /** A CharX's 表情 (on the card's own cast entry) and backgrounds, after its card is in. */
  async function restoreCharx(cardId, pack) {
    const { faces, backgrounds, cgs = [], left, iconPath } = pack.charx
    const arrived = { sprites: 0, scenes: 0, cgs: 0, left: [...left], ...(iconPath ? { iconPath } : {}) }
    if (Object.keys(faces).length) {
      const card = await store.getCard(cardId)
      const id = (await castFor(cardId, [card.name])).get(card.name)
      if (id) arrived.sprites = await putFaces(cardId, id, { faces }, pack.zip)
    }
    arrived.scenes = await putScenes(cardId, backgrounds, pack.zip)
    arrived.cgs = (await putCgs(cardId, cgs, pack.zip)).pictures
    return arrived
  }

  /**
   * An 整合包 as ticked:
   * @param choices.cards - [{ path, replace }]: the cards to import (replace: the card to update in place, or '').
   * @param choices.target - the id of a card already here for what comes without a card; else the first card imported.
   * @param choices.books / regex / presets - the paths ticked; `link` false: the worldbooks stay off the card.
   * @param choices.people - { key: 'new' | entry id | '' }: whose pictures each listed person or 表情 folder is.
   * @param choices.cgs - whether the listed groups of CG come along.
   * @param choices.folders - { folder: 'scenes' | 'cgs' | '' }.
   * → { cards: [{ id, name, updated? }], target, books, regex, presets, people, pictures, cgs: { groups, pictures }, scenes }.
   */
  async function take(pack, choices) {
    const { zip, survey } = pack
    const out = { cards: [], target: null, books: 0, regex: 0, presets: 0, people: 0, pictures: 0, cgs: { groups: 0, pictures: 0 }, scenes: 0 }
    const picked = (Array.isArray(choices.cards) ? choices.cards : []).filter(item => survey.cards.some(card => card.path === item?.path))
    for (const item of picked) {
      const buffer = await zip.file(item.path, MAX_CARD_FILE)
      if (!buffer) continue
      const saved = await importCard(typeof item.replace === 'string' && item.replace ? { replace: item.replace } : {}, { card: { filename: item.path.split('/').pop(), buffer } })
      out.cards.push({ id: saved.id, name: saved.name, ...(saved.updated ? { updated: saved.updated } : {}) })
    }
    const target = out.cards[0]?.id ?? (typeof choices.target === 'string' && choices.target ? choices.target : null)
    if (target) await store.getCard(target)
    out.target = target
    const ticked = (list, paths) => list.filter(item => Array.isArray(paths) && paths.includes(item.path))
    for (const item of ticked(survey.books, choices.books)) {
      const json = await jsonOf(zip, item.path)
      if (!json) continue
      const book = await importBook(json, item.name)
      out.books++
      if (target && choices.link !== false) {
        const card = await store.getCard(target)
        if (!(card.worldbookIds ?? []).includes(book.id)) {
          card.worldbookIds = [...(card.worldbookIds ?? []), book.id]
          await store.saveCard(card)
        }
      }
    }
    for (const item of ticked(survey.regex, choices.regex)) {
      const json = await jsonOf(zip, item.path)
      if (!json) continue
      try {
        out.regex += (await regex.importScripts(Array.isArray(json) ? json : [json], target ? `card-${target}` : 'global')).added
      } catch {
        // nothing usable in it
      }
    }
    for (const item of ticked(survey.presets, choices.presets)) {
      const json = await jsonOf(zip, item.path)
      if (!json) continue
      await importPreset(json, item.name)
      out.presets++
    }
    if (!target) return out
    // People: their names onto the cast first (all at once), then their pictures.
    const people = record(choices.people)
    const chosen = survey.people.filter(person => typeof people[person.key] === 'string' && people[person.key])
    const ids = await castFor(target, chosen.filter(person => people[person.key] === 'new').map(person => person.name))
    for (const person of chosen) {
      const id = people[person.key] === 'new' ? ids.get(person.name) : people[person.key]
      if (!id) continue
      out.pictures += await putFaces(target, id, person, zip).catch(() => 0)
      out.people++
    }
    if (choices.cgs && survey.groups.length) {
      const done = await putCgs(target, survey.groups, zip)
      out.cgs.groups += done.groups
      out.cgs.pictures += done.pictures
    }
    const folders = record(choices.folders)
    for (const folder of survey.folders) {
      const as = folders[folder.folder]
      if (as === 'scenes') out.scenes += await putScenes(target, folder.pictures.map(path => ({ name: baseName(path), path })), zip)
      if (as === 'cgs') {
        const done = await putCgs(target, [{ name: folder.folder.split('/').pop() || baseName(folder.pictures[0]), pictures: folder.pictures }], zip)
        out.cgs.groups += done.groups
        out.cgs.pictures += done.pictures
      }
    }
    return out
  }

  return { restoreCharx, take }
}

export { jsonOf, pictureOf }
