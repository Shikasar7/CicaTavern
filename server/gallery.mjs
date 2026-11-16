// 图库: every picture drawn or uploaded, across cards and chats, in one list to look through and export.
// The pictures stay where they are (a chat's 配图 and CG in media/<chat>, a card's 背景 and 立绘 with the card);
// this only reads them. Chats are read once each until they change: the list of a few hundred long chats
// would otherwise be read whole every time 图库 opens.
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'
import { crcOf, zipParts } from './update/zip.mjs'

const FILE = /^[\w-]{1,80}\.(png|jpg|jpeg|webp)$/
// At most this many in one export, and this many bytes (the pictures are held in memory until the zip is fetched).
const MAX_EXPORT = 2000
const MAX_EXPORT_BYTES = 600 * 1024 * 1024
const KINDS = ['reply', 'scene', 'sprite']

/** A name for a folder or a file in the zip: no path separators or characters Windows refuses. */
const safeName = (text, fallback) => String(text ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback

/**
 * @param scenes - createScenes(): a card's 背景 (list) and 立绘 (sprites).
 * @param media - createMedia(): a chat's pictures (readImage).
 */
export function createGallery(store, { scenes, media }) {
  // chat file → { mtimeMs, size, chat: { id, cardId, title, updatedAt }, images: [{ file, prompt, at, backend }] }
  const chatCache = new Map()

  async function chatPictures() {
    let names = []
    try {
      names = await readdir(store.dirs.chats)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const out = []
    const present = new Set()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(store.dirs.chats, name)
      present.add(file)
      const info = await stat(file).catch(() => null)
      if (!info) continue
      let kept = chatCache.get(file)
      if (!kept || kept.mtimeMs !== info.mtimeMs || kept.size !== info.size) {
        let chat
        try {
          chat = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          continue // being written, or broken: the chat list says so, not this
        }
        const images = []
        for (const node of Object.values(chat.nodes ?? {})) {
          for (const image of node?.media?.images ?? []) {
            if (FILE.test(image?.file ?? '')) images.push({ file: image.file, prompt: String(image.prompt ?? ''), at: String(image.at ?? ''), backend: String(image.backend ?? '') })
          }
        }
        kept = { mtimeMs: info.mtimeMs, size: info.size, chat: { id: chat.id, cardId: chat.cardId, title: String(chat.title ?? ''), trial: Boolean(chat.trial) }, images }
        chatCache.set(file, kept)
      }
      if (kept.images.length && !kept.chat.trial) out.push(kept)
    }
    for (const file of chatCache.keys()) if (!present.has(file)) chatCache.delete(file)
    return out
  }

  /**
   * Every picture, newest first: { id, kind ('reply' 配图和 CG, 'scene' 背景, 'sprite' 立绘和表情), cardId, cardName,
   * chatId, chatTitle, name, src, prompt, at }. `id` is what export takes.
   */
  async function list() {
    const cards = await store.listCards().catch(() => [])
    const cardName = new Map(cards.map(card => [card.id, card.name]))
    const items = []
    for (const { chat, images } of await chatPictures()) {
      for (const image of images) {
        items.push({ id: `reply:${chat.id}:${image.file}`, kind: 'reply', cardId: chat.cardId, cardName: cardName.get(chat.cardId) ?? '', chatId: chat.id, chatTitle: chat.title, name: '', src: `/api/media/${chat.id}/${image.file}`, prompt: image.prompt, at: image.at })
      }
    }
    // A card's two lists read together, a few cards at a time: one after another, a few hundred cards took seconds.
    const read = []
    for (let i = 0; i < cards.length; i += 16) {
      read.push(...(await Promise.all(cards.slice(i, i + 16).map(async card => [card, await scenes.list(card.id).catch(() => null), await scenes.sprites(card.id).catch(() => null)]))))
    }
    for (const [card, placeList, cast] of read) {
      for (const scene of placeList?.scenes ?? []) {
        if (!FILE.test(scene?.file ?? '')) continue
        items.push({ id: `scene:${card.id}:${scene.file}`, kind: 'scene', cardId: card.id, cardName: card.name, chatId: '', chatTitle: '', name: String(scene.name ?? ''), src: `/api/scenes/${card.id}/${scene.file}`, prompt: String(scene.prompt ?? ''), at: String(scene.updatedAt ?? scene.at ?? '') })
      }
      if (!cast) continue
      const names = new Map((card.media?.roster ?? []).map(entry => [entry.id, entry.name]))
      for (const [entryId, sprite] of Object.entries(cast.sprites ?? {})) {
        items.push({ id: `sprite:${card.id}:${sprite.file}`, kind: 'sprite', cardId: card.id, cardName: card.name, chatId: '', chatTitle: '', name: names.get(entryId) ?? '', src: `/api/sprites/${card.id}/${sprite.file}`, prompt: String(sprite.prompt ?? ''), at: String(sprite.updatedAt ?? '') })
      }
      for (const [entryId, faces] of Object.entries(cast.expressions ?? {})) {
        for (const [face, picture] of Object.entries(faces)) {
          items.push({ id: `sprite:${card.id}:${picture.file}`, kind: 'sprite', cardId: card.id, cardName: card.name, chatId: '', chatTitle: '', name: `${names.get(entryId) ?? ''}·${face}`, face, src: `/api/sprites/${card.id}/${picture.file}`, prompt: String(picture.prompt ?? ''), at: String(picture.updatedAt ?? '') })
        }
      }
    }
    items.sort((a, b) => b.at.localeCompare(a.at))
    return { items }
  }

  /** The bytes of one picture by its id, or null when it is gone. */
  async function read(id) {
    const [kind, owner, file] = String(id).split(':')
    if (!KINDS.includes(kind) || !/^[\w-]{1,64}$/.test(owner ?? '') || !FILE.test(file ?? '')) return null
    try {
      if (kind === 'reply') return await media.readImage(owner, file)
      if (kind === 'scene') return (await scenes.readPicture(owner, file))?.data ?? null
      return (await scenes.readSprite(owner, file))?.data ?? null
    } catch {
      return null
    }
  }

  /**
   * A zip of the pictures `ids` names, in folders by card and kind (配图 of a chat under its title), each file named
   * by its date or name. → { parts, size, count, missing }: the zip in pieces to write one after another.
   */
  async function exportZip(ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String))]
    if (!wanted.length) throw httpError(400, msg`没有选图`)
    if (wanted.length > MAX_EXPORT) throw httpError(400, msg`一次最多导出 ${MAX_EXPORT} 张`)
    const known = new Map((await list()).items.map(item => [item.id, item]))
    const folders = { reply: msg`配图和CG`, scene: msg`背景`, sprite: msg`立绘` }
    const entries = []
    const used = new Set()
    let missing = 0
    let total = 0
    for (const id of wanted) {
      const item = known.get(id)
      const data = item ? await read(id) : null
      if (!data) {
        missing++
        continue
      }
      const ext = id.split('.').pop()
      const card = safeName(item.cardName, item.cardId)
      const folder = item.kind === 'reply' ? `${card}/${folders.reply}/${safeName(item.chatTitle, item.chatId)}` : `${card}/${folders[item.kind]}`
      const stamp = item.at ? item.at.slice(0, 19).replace(/[T:]/g, '-') : ''
      const base = safeName([item.name, stamp].filter(Boolean).join(' '), id.split(':')[2].replace(/\.\w+$/, ''))
      let name = `${folder}/${base}.${ext}`
      for (let n = 2; used.has(name); n++) name = `${folder}/${base} (${n}).${ext}`
      used.add(name)
      total += data.length
      if (total > MAX_EXPORT_BYTES) throw httpError(413, msg`选的图太多了（超过 600MB），分几次导出`)
      entries.push({ name, data, crc: crcOf(data), when: item.at ? new Date(item.at) : new Date() })
      // The checksum of a big picture takes a while where zlib has none (the phone): a reply being written goes on.
      await new Promise(resolve => setImmediate(resolve))
    }
    if (!entries.length) throw httpError(404, msg`选的图都已经不在了`)
    return { ...zipParts(entries), count: entries.length, missing }
  }

  return { list, read, exportZip }
}
