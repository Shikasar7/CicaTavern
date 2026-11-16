// 外观的图: the pictures a card's 定制外观 may name (web/shared/status.js LOOK_TOKEN). A look names a picture by a
// variable (--pic-scene-15d494); this keeps the files the variables are filled with, in cards/<id>/look/, and their
// list in cards/<id>/look.json: { pictures: { token: { file, at, kind, from?, prompt?, backend? } } }.
// Two kinds: decorative pictures drawn for the look (画装饰图: --pic-decor-<slot>), and small copies of the card's own
// pictures (its scenes, 立绘, avatar, 开场页 picture) the page makes when a look first names one: a look carries
// every picture it uses, so a SillyTavern copy (embedded as data, within a cap) and a card pack (the files) have them.
// `from` on a copy is the picture it was made from: a scene drawn again makes the page copy it anew.
// A picture replaced or deleted goes to 抽图历史 (slot look:<name>), where it can be taken back.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageKind } from './appearance.mjs'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'
import { DECOR_SLOTS, LOOK_TOKEN, lookTokensUsed } from '../web/shared/status.js'

const FILE = /^[\w-]{1,100}\.(png|jpg|webp)$/
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const KINDS = ['decor', 'scene', 'sprite', 'avatar', 'cover']
// A copy or a decoration is small (the page makes them so): one this big is not one.
const MAX_PICTURE = 2 * 1024 * 1024
// What a look's pictures may add to a SillyTavern copy, as data: past it, the rest are left out (the look has none for them).
export const EMBED_CAP = 1536 * 1024
// The card's own pictures offered to a look, of each kind.
const MAX_OFFERED = 12
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** The name a token goes by in a file name and a history slot: --pic-scene-15d494 → scene-15d494. */
export const tokenName = token => token.slice('--pic-'.length)
const kindOf = token => (token.startsWith('--pic-decor-') ? 'decor' : tokenName(token).split('-')[0])

/** A data URL from the page → its bytes, a picture of one of the three kinds. */
export function decodePicture(image) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!match) throw httpError(400, msg`外观的图要是 PNG、JPG 或 WebP`)
  const buffer = Buffer.from(match[1], 'base64')
  if (!imageKind(buffer)) throw httpError(400, msg`外观的图要是 PNG、JPG 或 WebP`)
  if (buffer.length > MAX_PICTURE) throw httpError(400, msg`外观的图太大了（2 MB 以内）`)
  return buffer
}

/**
 * @param scenes - createScenes(): the card's scenes and 立绘 (what a look may be offered)
 * @param history - createDrawHistory(): where a picture replaced or deleted is kept
 */
export function createLookPictures(store, { scenes, history }) {
  const dir = cardId => path.join(store.dirs.cards, cardId, 'look')
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'look.json')
  const locks = new Map()

  async function read(cardId) {
    let text
    try {
      text = await readFile(listFile(cardId), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw error
    }
    try {
      const pictures = JSON.parse(text)?.pictures
      if (!pictures || typeof pictures !== 'object' || Array.isArray(pictures)) return {}
      return Object.fromEntries(Object.entries(pictures).filter(([token, item]) => LOOK_TOKEN.test(token) && FILE.test(item?.file ?? '')))
    } catch {
      return {}
    }
  }

  /** One change at a time for a card: fn(pictures) changes them in place and returns what to give back. */
  function change(cardId, fn) {
    const before = locks.get(cardId) ?? Promise.resolve()
    const next = before.catch(() => {}).then(async () => {
      const pictures = await read(cardId)
      const result = await fn(pictures)
      await mkdir(path.dirname(listFile(cardId)), { recursive: true })
      const temp = `${listFile(cardId)}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temp, JSON.stringify({ pictures }, null, 1))
      await rename(temp, listFile(cardId))
      return result
    })
    locks.set(cardId, next)
    return next.finally(() => { if (locks.get(cardId) === next) locks.delete(cardId) })
  }

  /** The card's own pictures a look may name, with what each is: [{ token, kind, label, shape, clear, source, from }]. */
  async function offered(cardId) {
    const card = await store.getCard(cardId)
    const out = []
    if (card.hasAvatar) out.push({ token: '--pic-avatar', kind: 'avatar', label: card.name ?? '', shape: 'portrait', clear: false, source: `/api/cards/${cardId}/avatar`, from: `avatar:${card.avatarAt ?? card.importedAt ?? ''}` })
    if (card.coverArt) out.push({ token: '--pic-cover', kind: 'cover', label: '', shape: 'landscape', clear: false, source: `/api/cards/${cardId}/cover-art?v=${card.coverArt}`, from: `cover:${card.coverArt}` })
    const [{ scenes: list = [] } = {}, { sprites = {} } = {}] = await Promise.all([scenes.list(cardId).catch(() => ({})), scenes.sprites(cardId).catch(() => ({}))])
    const seen = new Set()
    for (const scene of list.filter(one => one.file).slice(0, MAX_OFFERED)) {
      const token = `--pic-scene-${scene.id.slice(0, 6)}`
      if (!/^[0-9a-f]{6}$/.test(scene.id.slice(0, 6)) || seen.has(token)) continue
      seen.add(token)
      out.push({ token, kind: 'scene', label: scene.name, shape: 'landscape', clear: false, source: `/api/scenes/${cardId}/${scene.file}`, from: scene.file })
    }
    const cast = (Array.isArray(card.media?.roster) ? card.media.roster : []).filter(entry => sprites[entry.id]?.file && /^[\w-]{1,40}$/.test(entry.id))
    for (const entry of [...cast.filter(one => !one.player), ...cast.filter(one => one.player)].slice(0, MAX_OFFERED)) {
      out.push({ token: `--pic-sprite-${entry.id}`, kind: 'sprite', label: entry.name ?? '', shape: 'portrait', clear: true, source: `/api/sprites/${cardId}/${sprites[entry.id].file}`, from: sprites[entry.id].file })
    }
    for (const [slot, { clear, shape }] of Object.entries(DECOR_SLOTS)) out.push({ token: `--pic-decor-${slot}`, kind: 'decor', label: slot, shape, clear })
    return out
  }

  const address = (cardId, item) => `/api/look/${cardId}/${item.file}?v=${Date.parse(item.at || 0).toString(36)}`

  /** For the page: { pictures: [{ token, url, kind, at, from?, prompt?, backend? }], offered: what a look may name }. */
  async function view(cardId) {
    const [pictures, offer] = await Promise.all([read(cardId), offered(cardId)])
    return {
      pictures: Object.entries(pictures).map(([token, item]) => ({ token, url: address(cardId, item), kind: item.kind, at: item.at, ...(item.from ? { from: item.from } : {}), ...(item.prompt ? { prompt: item.prompt } : {}), ...(item.backend ? { backend: item.backend } : {}) })),
      offered: offer,
    }
  }

  /** What a look's prompt is told (skin.mjs picturesBlock): { pictures: offered, drawn: the decorations there are }. */
  async function forPrompt(cardId) {
    if (!cardId) return { pictures: [], drawn: [] }
    try {
      const [offer, pictures] = await Promise.all([offered(cardId), read(cardId)])
      return { pictures: offer, drawn: Object.keys(pictures).filter(token => token.startsWith('--pic-decor-')) }
    } catch {
      return { pictures: [], drawn: [] }
    }
  }

  /** { token: address } for what wears the look in this app (web/status.js wear). */
  async function addresses(cardId) {
    const pictures = await read(cardId)
    return Object.fromEntries(Object.entries(pictures).map(([token, item]) => [token, address(cardId, item)]))
  }

  /** A picture for a token, the one there before going to 抽图历史. → view() */
  async function save(cardId, token, buffer, { from = '', prompt = '', backend = '', at = '' } = {}) {
    if (!LOOK_TOKEN.test(token)) throw httpError(400, msg`外观里没有这张图的位置`)
    await store.getCard(cardId)
    const ext = imageKind(buffer)
    if (!ext) throw httpError(400, msg`外观的图要是 PNG、JPG 或 WebP`)
    const file = `${tokenName(token)}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${ext}`
    await mkdir(dir(cardId), { recursive: true })
    await writeFile(path.join(dir(cardId), file), buffer)
    const old = await change(cardId, pictures => {
      const before = pictures[token] ?? null
      pictures[token] = { file, at: at || new Date().toISOString(), kind: kindOf(token), ...(clip(from, 200) ? { from: clip(from, 200) } : {}), ...(clip(prompt, 4000) ? { prompt: clip(prompt, 4000) } : {}), ...(clip(backend, 120) ? { backend: clip(backend, 120) } : {}) }
      return before
    })
    if (old) await keepOld(cardId, token, old)
    return view(cardId)
  }

  /** A picture taken off (deleted): kept in 抽图历史 like one replaced. → view() */
  async function remove(cardId, token) {
    if (!LOOK_TOKEN.test(token)) throw httpError(400, msg`外观里没有这张图的位置`)
    await store.getCard(cardId)
    const old = await change(cardId, pictures => {
      const before = pictures[token] ?? null
      delete pictures[token]
      return before
    })
    if (old) await keepOld(cardId, token, old)
    return view(cardId)
  }

  async function keepOld(cardId, token, item) {
    const file = path.join(dir(cardId), item.file)
    // Copies of the card's own pictures are made again from them; only what was drawn is worth keeping.
    if (item.kind !== 'decor' || !history) return rm(file, { force: true })
    await history.push(cardId, `look:${tokenName(token)}`, { from: file, at: item.at, backend: item.backend ?? '', source: 'draw', prompt: item.prompt ?? '' })
  }

  /** 抽图历史 → 换回这张: a kept picture back in its place (the one there now kept instead). → view() */
  async function restore(cardId, slot, buffer, entry = {}) {
    const token = `--pic-${slot.slice('look:'.length)}`
    return save(cardId, token, buffer, { prompt: entry.prompt ?? '', backend: entry.backend ?? '', at: entry.at ?? '' })
  }

  async function readPicture(cardId, file) {
    if (!FILE.test(file)) throw httpError(400, msg`文件名不对`)
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, msg`图片不存在`)
      throw error
    }
  }

  /**
   * The pictures a card's look names, as data for a copy that leaves the app (SillyTavern): { vars: { token: data URL },
   * dropped: [token] } — those past EMBED_CAP, or named with no picture, are left out (the look's fallback shows).
   */
  async function embedded(card) {
    const used = lookTokensUsed(card?.statusBar?.skin?.css ?? '')
    if (!card?.id || !used.length) return { vars: {}, dropped: [] }
    const pictures = await read(card.id).catch(() => ({}))
    const vars = {}
    const dropped = []
    let size = 0
    for (const token of used) {
      const item = pictures[token]
      const data = item ? await readFile(path.join(dir(card.id), item.file)).catch(() => null) : null
      const url = data && imageKind(data) ? `data:${TYPES[imageKind(data)]};base64,${data.toString('base64')}` : ''
      if (!url || size + url.length > EMBED_CAP) {
        if (LOOK_TOKEN.test(token)) dropped.push(token)
        continue
      }
      vars[token] = url
      size += url.length
    }
    return { vars, dropped }
  }

  /** For a card pack: [{ token, name (in the zip), file (on disk), item }]. */
  async function files(cardId) {
    const pictures = await read(cardId)
    return Object.entries(pictures).map(([token, item]) => ({ token, name: `look/${item.file}`, file: path.join(dir(cardId), item.file), item }))
  }

  /** A card pack's look pictures into a card: [{ token, data, item }]. → how many came. */
  async function unpack(cardId, entries) {
    let count = 0
    for (const { token, data, item } of entries) {
      if (!LOOK_TOKEN.test(token) || !Buffer.isBuffer(data) || !imageKind(data) || data.length > MAX_PICTURE) continue
      await save(cardId, token, data, { from: item?.from ?? '', prompt: item?.prompt ?? '', backend: item?.backend ?? '', at: item?.at ?? '' })
      count += 1
    }
    return count
  }

  return { view, offered, forPrompt, addresses, save, remove, restore, readPicture, embedded, files, unpack, kinds: KINDS }
}
