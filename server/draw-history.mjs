// 抽图历史: the pictures a place had before it was drawn or uploaded again,
// kept so the player can take one back or delete it. A card's places keep
// theirs in cards/<id>/history.json (by place, newest first), the pictures in
// cards/<id>/history/. Places: roster:<entryId> (人设图), sprite:<entryId>
// (立绘), face:<entryId>:<expression> (表情差分), scene:<sceneId> (场景),
// avatar (the card's picture, and avatars drawn but not taken). A chat's
// pictures keep theirs on the reply (node.media.images[].history, the helpers
// at the end). Each place keeps media.drawHistory old ones (配图 settings,
// 0 = none), the oldest going first; deleting a card, a chat, a cast member or
// a scene takes theirs along. Card exports and chat packages carry only the
// pictures in use.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageKind } from './appearance.mjs'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

export const HISTORY_DEFAULT = 5
export const HISTORY_MAX = 20
const SLOT = /^(?:avatar|(?:roster|sprite):[\w-]{1,40}|face:[\w-]{1,40}:[a-z]{1,20}|scene:[\w-]{1,64})$/
const FILE = /^[\w-]{1,100}\.(png|jpg|webp)$/
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** The setting as kept: how many old pictures a place keeps, 0 to HISTORY_MAX. */
export function cleanKeep(value, fallback = HISTORY_DEFAULT) {
  const n = Number(value)
  return value !== '' && value !== null && Number.isFinite(n) ? Math.min(HISTORY_MAX, Math.max(0, Math.round(n))) : fallback
}

/** When a picture on disk was made, for one that does not say: its file's time. */
export async function madeAt(file) {
  try {
    return (await stat(file)).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/** @param keep - async () → how many old pictures a place keeps now (media.drawHistory). */
export function createDrawHistory(store, { keep }) {
  const indexFile = cardId => path.join(store.dirs.cards, cardId, 'history.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'history')
  const locks = new Map()

  /** { slot: [entry, newest first] }. A list that no longer parses starts over; any other read error is thrown, so nothing writes over it. */
  async function read(cardId) {
    let text
    try {
      text = await readFile(indexFile(cardId), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
    try {
      const slots = JSON.parse(text)?.slots
      return slots && typeof slots === 'object' && !Array.isArray(slots) ? slots : {}
    } catch {
      return {}
    }
  }

  async function write(cardId, slots) {
    const file = indexFile(cardId)
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify({ slots }, null, 1), 'utf8')
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await rename(tmp, file)
        } catch (error) {
          // Windows refuses a rename onto a file being read for a moment.
          if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
          await new Promise(resolve => setTimeout(resolve, 20 * attempt))
        }
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** fn(slots) changes them in place, alone for this card; the list is saved after (no list left once it is empty). */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const slots = await read(cardId)
      const result = await fn(slots)
      for (const [slot, list] of Object.entries(slots)) if (!list?.length) delete slots[slot]
      if (Object.keys(slots).length) await write(cardId, slots)
      else await rm(indexFile(cardId), { force: true })
      return result
    })
    locks.set(cardId, run)
    return run
  }

  const removeFiles = (cardId, entries) => Promise.all(entries.map(entry => (FILE.test(entry?.file ?? '') ? rm(path.join(dir(cardId), entry.file), { force: true }) : null)))

  /**
   * The picture a place had, kept before a new one takes its place: `from` (its
   * file, moved here) or `buffer`. With no history kept (0), `from` is deleted
   * as before. Never fails the change it is part of: a picture that cannot be
   * kept is deleted. → the entry, or null.
   */
  async function push(cardId, slot, { from = '', buffer = null, at = '', backend = '', source = '', prompt = '' } = {}) {
    const n = SLOT.test(slot) ? await keep() : 0
    const ext = from ? path.extname(from).slice(1).toLowerCase().replace('jpeg', 'jpg') : buffer ? imageKind(buffer) : ''
    if (n <= 0 || !TYPES[ext]) {
      if (from) await rm(from, { force: true })
      return null
    }
    const file = `${slot.replace(/:/g, '-')}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${ext}`
    try {
      await mkdir(dir(cardId), { recursive: true })
      if (from) await rename(from, path.join(dir(cardId), file))
      else await writeFile(path.join(dir(cardId), file), buffer)
    } catch {
      if (from) await rm(from, { force: true }).catch(() => {})
      return null
    }
    const entry = { file, at: at || new Date().toISOString(), backend: clip(backend, 120), source: clip(source, 20), ...(prompt ? { prompt: clip(prompt, 4000) } : {}) }
    const dropped = await change(cardId, slots => {
      const list = [entry, ...(Array.isArray(slots[slot]) ? slots[slot] : [])]
      slots[slot] = list.slice(0, n)
      return list.slice(n)
    })
    await removeFiles(cardId, dropped)
    return entry
  }

  /** → { keep, slots: { slot: [entry, newest first] } } */
  async function list(cardId) {
    await store.getCard(cardId)
    const [n, slots] = await Promise.all([keep(), read(cardId)])
    return { keep: n, slots }
  }

  /** Where a kept picture is: { slot, entry }, or null. */
  async function find(cardId, file) {
    if (!FILE.test(String(file))) return null
    for (const [slot, entries] of Object.entries(await read(cardId))) {
      const entry = Array.isArray(entries) ? entries.find(item => item.file === file) : null
      if (entry) return { slot, entry }
    }
    return null
  }

  /** Takes a kept picture out to be used again: → { slot, entry, buffer }; it is no longer kept. */
  async function take(cardId, file) {
    const found = await find(cardId, file)
    if (!found) throw httpError(404, msg`这张旧图已经不在了`)
    const buffer = await readFile(path.join(dir(cardId), file)).catch(() => null)
    if (!buffer) {
      await remove(cardId, file)
      throw httpError(404, msg`这张旧图已经不在了`)
    }
    await remove(cardId, file)
    return { ...found, buffer }
  }

  /** Deletes one kept picture. → the place it was kept for, or null. */
  async function remove(cardId, file) {
    if (!FILE.test(String(file))) throw httpError(400, msg`文件名不对`)
    const slot = await change(cardId, slots => {
      for (const [key, entries] of Object.entries(slots)) {
        if (!Array.isArray(entries) || !entries.some(item => item.file === file)) continue
        slots[key] = entries.filter(item => item.file !== file)
        return key
      }
      return null
    })
    await rm(path.join(dir(cardId), file), { force: true })
    return slot
  }

  /** Deletes what the places `test(slot)` picks kept (a cast member, a scene gone). */
  async function drop(cardId, test) {
    const dropped = await change(cardId, slots => {
      const gone = []
      for (const [slot, entries] of Object.entries(slots)) {
        if (!test(slot)) continue
        gone.push(...(Array.isArray(entries) ? entries : []))
        delete slots[slot]
      }
      return gone
    })
    await removeFiles(cardId, dropped)
  }

  /** → { data, type }, or null. */
  async function readPicture(cardId, file) {
    if (!FILE.test(String(file))) return null
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  return { keep, push, list, find, take, remove, drop, readPicture }
}

// ─── A reply's pictures (node.media.images) ─────────────────────────────
// Each picture may carry history: [{ file, prompt, backend, at }], newest
// first, the ones it was drawn again over. The files sit beside it in the
// chat's media folder; what a change leaves out is returned as `dropped`, for
// the caller to delete.

const kept = ({ file, prompt = '', backend = '', at = '' }) => ({ file, prompt, backend, at })

/**
 * `image` drawn again over the picture whose file is `replace`: that one leads
 * its history, which keeps `keep`. → { images, dropped }, or null when there
 * is no such picture.
 */
export function redrawImage(images, replace, image, keep) {
  const index = (images ?? []).findIndex(item => item.file === replace)
  if (index < 0) return null
  const before = images[index]
  const all = [kept(before), ...(before.history ?? [])]
  const n = Math.max(0, keep)
  const next = [...images]
  next[index] = { ...image, ...(n && all.length ? { history: all.slice(0, n) } : {}) }
  return { images: next, dropped: all.slice(n) }
}

/** The old picture `old` of the picture `file` shown again; the one shown now leads the history. → images, or null. */
export function pickImage(images, file, old) {
  const index = (images ?? []).findIndex(item => item.file === file)
  const before = index < 0 ? null : images[index]
  const chosen = before?.history?.find(item => item.file === old)
  if (!chosen) return null
  const next = [...images]
  next[index] = { ...kept(chosen), history: [kept(before), ...before.history.filter(item => item.file !== old)] }
  return next
}

/** One old picture of the picture `file` deleted. → { images, dropped }, or null. */
export function dropOldImage(images, file, old) {
  const index = (images ?? []).findIndex(item => item.file === file)
  const before = index < 0 ? null : images[index]
  const gone = before?.history?.find(item => item.file === old)
  if (!gone) return null
  const next = [...images]
  const { history, ...shown } = before
  const rest = history.filter(item => item.file !== old)
  next[index] = rest.length ? { ...shown, history: rest } : shown
  return { images: next, dropped: [gone] }
}

/** The picture `file` deleted with its old ones. → { images, dropped } (nothing dropped when it is not there). */
export function dropImage(images, file) {
  const gone = (images ?? []).find(item => item.file === file)
  return { images: (images ?? []).filter(item => item.file !== file), dropped: gone ? [gone, ...(gone.history ?? [])] : [] }
}

/** Every file a chat's pictures keep as old ones. */
export function oldImageFiles(chat) {
  return Object.values(chat.nodes ?? {}).flatMap(node => (node.media?.images ?? []).flatMap(image => (image.history ?? []).map(item => item.file)))
}

/** The nodes with only the pictures in use (a chat package). */
export function withoutOldImages(nodes) {
  return Object.fromEntries(Object.entries(nodes ?? {}).map(([id, node]) => {
    if (!node?.media?.images?.some(image => image.history)) return [id, node]
    return [id, { ...node, media: { ...node.media, images: node.media.images.map(({ history, ...image }) => image) } }]
  }))
}
