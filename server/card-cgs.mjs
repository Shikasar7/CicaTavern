// 卡的 CG: pictures a card brings for moments of its story, in named groups (one moment, a few pictures in order).
// The visual novel shows a group full screen when the reply marks it (【CG|组名】, asked for in the turn's message
// with the groups listed: server/prompt.mjs dialogueFormat). cards/<id>/cgs.json lists them; the pictures are
// cards/<id>/cgs/<groupId>-<6 hex>.<ext>, never renamed (a new picture is a new file), so the page keeps them cached.
// Filled by hand in the visual novel's library, from a picture pack (card-bundle.mjs) or a card pack (card-pack.mjs).
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { cgList, LISTED_GROUPS, normalizePlace, placeKeys } from '../web/shared/vn.js'
import { imageKind } from './appearance.mjs'
import { httpError, newId, readJsonFile, writeJson } from './store.mjs'
import { msg } from './i18n.mjs'

export const MAX_GROUPS = 200
export const MAX_GROUP_PICTURES = 24
export const MAX_CG_BYTES = 12 * 1024 * 1024
// The groups offered each turn (shared/vn.js: the SillyTavern build lists them the same way).
export { cgList, LISTED_GROUPS }
const FILE = /^[\w-]{1,64}\.(png|jpg|webp)$/
const ID = /^[\w-]{1,40}$/
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
// 假动态 (web/game-look.js cgMotion): how a group's pictures move while shown. '' is still; calm, a slow push and breathing;
// climax, the same with a shake and a white flash on its last picture.
export const MOTIONS = ['calm', 'climax']
export const cleanMotion = value => (MOTIONS.includes(value) ? value : '')
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** A group's name and aliases as kept: trimmed, no repeats, no alias equal to the name, no 【】| that would break the mark. */
function cleanNames(name, aliases) {
  const strip = value => clip(value, 40).replace(/[【】|｜\n]/g, '')
  const clean = strip(name)
  if (!clean) throw httpError(400, msg`CG 组要有名字`)
  const seen = new Set([normalizePlace(clean)])
  const list = []
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const value = strip(alias)
    const key = normalizePlace(value)
    if (!value || seen.has(key) || list.length >= 8) continue
    seen.add(key)
    list.push(value)
  }
  return { name: clean, aliases: list }
}

// Every name a group answers to, as compared (as a scene's: the page finds the group a mark names with matchScene).
const groupKeys = placeKeys


/** cgs.json read as it is in the folder, without the card. */
export async function readCgs(dirs, cardId) {
  const value = await readJsonFile(path.join(dirs.cards, cardId, 'cgs.json'), null).catch(() => null)
  return Array.isArray(value?.groups) ? value.groups : []
}

export function createCardCgs(store) {
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'cgs.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'cgs')
  const locks = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    return readCgs(store.dirs, cardId)
  }

  /** fn(groups) → { groups, result }: run alone for this card, the list saved after. */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const { groups, result } = await fn(await read(cardId))
      await writeJson(listFile(cardId), { groups })
      return result
    })
    locks.set(cardId, run.catch(() => {}))
    return run
  }

  async function writeImage(cardId, groupId, buffer) {
    const kind = imageKind(buffer)
    if (!['png', 'jpg', 'webp'].includes(kind)) throw httpError(400, msg`CG 要是 PNG、JPG 或 WebP`)
    if (buffer.length > MAX_CG_BYTES) throw httpError(400, msg`CG 太大（最多 12MB）`)
    const file = `${groupId}-${randomBytes(3).toString('hex')}.${kind}`
    await mkdir(dir(cardId), { recursive: true })
    await writeFile(path.join(dir(cardId), file), buffer)
    return file
  }
  const dropFile = async (cardId, file) => {
    if (file && FILE.test(file)) await rm(path.join(dir(cardId), file), { force: true })
  }

  const view = async cardId => ({ groups: await read(cardId) })
  const found = (groups, groupId) => {
    const group = groups.find(item => item.id === groupId)
    if (!group) throw httpError(404, msg`没有这组 CG`)
    return group
  }
  const taken = (groups, names, except = '') => groups.some(group => group.id !== except && groupKeys(group).some(key => groupKeys(names).includes(key)))

  /** A group added by hand: { name, aliases, note }, no pictures yet. */
  function add(cardId, { name, aliases, note, motion } = {}) {
    const names = cleanNames(name, aliases)
    return change(cardId, async groups => {
      if (groups.length >= MAX_GROUPS) throw httpError(400, msg`CG 组太多了（最多 ${MAX_GROUPS} 组），先删掉一些`)
      if (taken(groups, names)) throw httpError(400, msg`已经有叫「${names.name}」的 CG 组了`)
      const group = { id: newId(), ...names, note: clip(note, 80), ...(cleanMotion(motion) ? { motion: cleanMotion(motion) } : {}), pictures: [], at: new Date().toISOString() }
      return { groups: [...groups, group], result: group }
    }).then(async group => ({ group, ...(await view(cardId)) }))
  }

  /** Its name, aliases, note, and the order of its pictures (`files`: the same files, reordered). */
  function update(cardId, groupId, { name, aliases, note, files, motion } = {}) {
    return change(cardId, async groups => {
      const before = found(groups, groupId)
      const names = cleanNames(name ?? before.name, aliases ?? before.aliases)
      if (taken(groups, names, groupId)) throw httpError(400, msg`已经有叫「${names.name}」的 CG 组了`)
      let pictures = before.pictures
      if (Array.isArray(files)) {
        const byFile = new Map(before.pictures.map(picture => [picture.file, picture]))
        const ordered = files.map(file => byFile.get(file)).filter(Boolean)
        if (ordered.length === before.pictures.length && new Set(files).size === files.length) pictures = ordered
      }
      const group = { ...before, ...names, note: note === undefined ? before.note : clip(note, 80), pictures }
      if (motion !== undefined) {
        if (cleanMotion(motion)) group.motion = cleanMotion(motion)
        else delete group.motion
      }
      return { groups: groups.map(item => (item.id === groupId ? group : item)), result: group }
    }).then(async group => ({ group, ...(await view(cardId)) }))
  }

  /** One more picture at the end of a group (a data URL from the page, or its bytes). */
  function addPicture(cardId, groupId, image) {
    const buffer = Buffer.isBuffer(image) ? image : decode(image)
    return change(cardId, async groups => {
      const before = found(groups, groupId)
      if (before.pictures.length >= MAX_GROUP_PICTURES) throw httpError(400, msg`一组 CG 最多 ${MAX_GROUP_PICTURES} 张`)
      const file = await writeImage(cardId, groupId, buffer)
      const group = { ...before, pictures: [...before.pictures, { file, at: new Date().toISOString() }] }
      return { groups: groups.map(item => (item.id === groupId ? group : item)), result: group }
    }).then(async group => ({ group, ...(await view(cardId)) }))
  }

  /** 存为 CG: a picture of a chat into one of the card's groups (`groupId`), or into a new one ({ name, note }). */
  async function keep(cardId, buffer, { groupId = '', name = '', note = '' } = {}) {
    // Looked at first: a new group is not left empty by a picture that cannot go in.
    if (!['png', 'jpg', 'webp'].includes(imageKind(buffer))) throw httpError(400, msg`CG 要是 PNG、JPG 或 WebP`)
    if (buffer.length > MAX_CG_BYTES) throw httpError(400, msg`CG 太大（最多 12MB）`)
    const id = groupId || (await add(cardId, { name, note })).group.id
    return addPicture(cardId, id, buffer)
  }

  function removePicture(cardId, groupId, file) {
    return change(cardId, async groups => {
      const before = found(groups, groupId)
      if (!before.pictures.some(picture => picture.file === file)) throw httpError(404, msg`这组 CG 里没有这张`)
      await dropFile(cardId, file)
      const group = { ...before, pictures: before.pictures.filter(picture => picture.file !== file) }
      return { groups: groups.map(item => (item.id === groupId ? group : item)), result: group }
    }).then(async group => ({ group, ...(await view(cardId)) }))
  }

  function remove(cardId, groupId) {
    return change(cardId, async groups => {
      const before = groups.find(item => item.id === groupId)
      for (const picture of before?.pictures ?? []) await dropFile(cardId, picture.file)
      return { groups: groups.filter(item => item.id !== groupId), result: null }
    }).then(() => view(cardId))
  }

  /**
   * Groups brought in whole (a picture pack, a card pack): [{ name, aliases?, note?, motion?, pictures: Buffer[] }]. One of a
   * name the card already has takes its place (its pictures replaced); pictures that are no PNG, JPG or WebP, or are
   * too big, are left out, and a group left with none is not added. → how many groups and pictures came in, and
   * the names of groups left out for the most.
   */
  function bring(cardId, incoming) {
    return change(cardId, async groups => {
      let list = [...groups]
      const result = { groups: 0, pictures: 0, skipped: [] }
      for (const item of incoming) {
        let names
        try {
          names = cleanNames(item.name, item.aliases)
        } catch {
          continue
        }
        const same = list.find(group => groupKeys(group).includes(normalizePlace(names.name)))
        if (!same && list.length >= MAX_GROUPS) {
          result.skipped.push(names.name)
          continue
        }
        const id = same?.id ?? newId()
        const pictures = []
        for (const buffer of (item.pictures ?? []).slice(0, MAX_GROUP_PICTURES)) {
          if (!['png', 'jpg', 'webp'].includes(imageKind(buffer)) || buffer.length > MAX_CG_BYTES) continue
          pictures.push({ file: await writeImage(cardId, id, buffer), at: new Date().toISOString() })
        }
        if (!pictures.length) continue
        for (const picture of same?.pictures ?? []) await dropFile(cardId, picture.file)
        const motion = cleanMotion(item.motion) || (item.motion === undefined ? same?.motion ?? '' : '')
        const group = { id, ...names, note: clip(item.note, 80) || same?.note || '', ...(motion ? { motion } : {}), pictures, at: same?.at ?? new Date().toISOString() }
        list = same ? list.map(old => (old.id === id ? group : old)) : [...list, group]
        result.groups++
        result.pictures += pictures.length
      }
      return { groups: list, result }
    })
  }

  /** → { data, type }, or null. */
  async function readPicture(cardId, file) {
    if (!ID.test(cardId) || !FILE.test(file)) return null
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  /** A newer version of a card takes the older one's CG (http.mjs, as scenes.inherit). */
  async function inherit(fromId, toId) {
    const groups = await readCgs(store.dirs, fromId)
    if (!groups.length) return
    await mkdir(dir(toId), { recursive: true })
    for (const group of groups) {
      for (const picture of group.pictures ?? []) {
        if (FILE.test(picture.file)) await copyFile(path.join(dir(fromId), picture.file), path.join(dir(toId), picture.file)).catch(() => {})
      }
    }
    await writeJson(listFile(toId), { groups })
  }

  return { list: view, read, add, update, addPicture, keep, removePicture, remove, bring, readPicture, inherit, dir, FILE }
}

/** A picture from the page: a data URL. */
function decode(image) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!match) throw httpError(400, msg`CG 要是 PNG、JPG 或 WebP`)
  return Buffer.from(match[1], 'base64')
}
