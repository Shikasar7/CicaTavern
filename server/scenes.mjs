// 场景图库 (视觉小说模式): a card's backgrounds, one per place, drawn once and
// reused in every chat on the card. cards/<id>/scenes.json lists them; the
// pictures are cards/<id>/scenes/<sceneId>-<6 hex>.<ext>, renamed with each new
// picture so the page can keep them cached for good. They stay out of
// card.media and roster/, which the media settings clean up on save.
// 立绘 the same way: one half-body picture per cast member (the roster entry's
// id), cards/<id>/sprites.json and cards/<id>/sprites/<entryId>-<6 hex>.<ext>;
// the page cuts the plain background out. One picture is drawn at a time per
// card, scene or sprite.
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizePlace, placeKeys } from '../web/shared/vn.js'
import { imageKind } from './appearance.mjs'
import { booksForCard } from './chats.mjs'
import { entryText } from './worldbook.mjs'
import { httpError, newId } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_BYTES = 12 * 1024 * 1024
const MAX_SCENES = 200
const FILE = /^[\w-]{1,64}\.(png|jpg|webp)$/
const ENTRY = /^[\w-]{1,40}$/
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A name and its aliases as kept: trimmed, no repeats, no alias equal to the name. */
function cleanNames(name, aliases) {
  const clean = clip(name, 40)
  if (!clean) throw httpError(400, msg`场景要有名字`)
  const seen = new Set([normalizePlace(clean)])
  const list = []
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const value = clip(alias, 40)
    const key = normalizePlace(value)
    if (!value || seen.has(key) || list.length >= 12) continue
    seen.add(key)
    list.push(value)
  }
  return { name: clean, aliases: list }
}

/** The card's worldbook text about a place (the card creator writes <place name="…"> entries). */
export function placeLore(books, place) {
  const want = normalizePlace(place)
  if (want.length < 2) return ''
  let best = null
  let bestScore = 0
  for (const book of books) {
    for (const entry of book.entries ?? []) {
      if (entry.enabled === false) continue
      let score = 0
      for (const key of [...(entry.keys ?? []), entry.comment]) {
        const k = normalizePlace(key)
        if (k.length < 2) continue
        if (k === want) score = Math.max(score, 3)
        else if (k.includes(want) || want.includes(k)) score = Math.max(score, 1)
      }
      if (!score) continue
      if (/<place\s+name=/i.test(entry.content)) score += 2
      if (score > bestScore) {
        best = entry
        bestScore = score
      }
    }
  }
  if (!best) return ''
  return entryText(best).replace(/<\/?place[^>]*>/gi, '').trim().slice(0, 1200)
}

/** @param media - createMedia(): drawScenery draws a background. */
export function createScenes(store, { media }) {
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'scenes.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'scenes')
  const spriteFile = cardId => path.join(store.dirs.cards, cardId, 'sprites.json')
  const spriteDir = cardId => path.join(store.dirs.cards, cardId, 'sprites')
  // One change at a time per card; one picture being drawn per card.
  const locks = new Map()
  const drawing = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    try {
      const value = JSON.parse(await readFile(listFile(cardId), 'utf8'))
      return Array.isArray(value.scenes) ? value.scenes : []
    } catch {
      return []
    }
  }

  /** fn(scenes) → { scenes, result }: run alone for this card, the list saved after. */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const { scenes, result } = await fn(await read(cardId))
      await writeFile(listFile(cardId), JSON.stringify({ scenes }, null, 1), 'utf8')
      return result
    })
    locks.set(cardId, run.catch(() => {}))
    return run
  }

  async function writeImage(cardId, sceneId, buffer, folder = dir(cardId)) {
    const kind = imageKind(buffer)
    if (!kind) throw httpError(400, msg`场景图要是 PNG、JPG 或 WebP`)
    if (buffer.length > MAX_BYTES) throw httpError(400, msg`场景图太大（最多 12MB）`)
    const file = `${sceneId}-${randomBytes(3).toString('hex')}.${kind}`
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, file), buffer)
    return file
  }

  const dropFile = async (cardId, file, folder = dir(cardId)) => {
    if (file && FILE.test(file)) await rm(path.join(folder, file), { force: true })
  }

  /** Draws one picture for the card, or answers 409 while another is being drawn. */
  async function alone(cardId, label, fn) {
    if (drawing.has(cardId)) throw httpError(409, msg`这张卡正在画「${drawing.get(cardId)}」，等它画完`)
    drawing.set(cardId, label)
    try {
      return await fn()
    } finally {
      drawing.delete(cardId)
    }
  }

  const view = async cardId => ({ scenes: await read(cardId), drawing: drawing.get(cardId) ?? null })

  /**
   * A picture for a place, or a new one for a scene (sceneId). A place whose
   * name or alias is already a scene returns that scene without drawing.
   * @param options.prompt - draw from this prompt instead of asking the helper.
   * @param options.rewrite - a scene drawn again gets a new prompt (else it keeps its own).
   * @param options.passage - 画这一轮的场景: the helper reads this reply and names the place;
   *   always a new scene, the place given (if any) its alias, so it is the one used there from now on.
   */
  async function draw(cardId, { place = '', sceneId = '', prompt = '', rewrite = false, passage = '' } = {}, signal) {
    const scenes = await read(cardId)
    const existing = sceneId ? scenes.find(s => s.id === sceneId) : null
    if (sceneId && !existing) throw httpError(404, msg`没有这个场景`)
    const given = clip(place, 40)
    const story = existing ? '' : clip(passage, 4000)
    const name = existing?.name ?? given
    if (!name && !story) throw httpError(400, msg`要画哪个地点？`)
    if (!existing) {
      const same = !story && scenes.find(s => placeKeys(s).includes(normalizePlace(name)))
      if (same) return { scene: same, scenes, drawn: false }
      if (scenes.length >= MAX_SCENES) throw httpError(400, msg`场景太多了（最多 ${MAX_SCENES} 个），先删掉一些`)
    }
    return alone(cardId, name || msg`这一轮的场景`, async () => {
      const card = await store.getCard(cardId)
      const lore = name ? placeLore(await booksForCard(store, card), name) : ''
      const picture = await media.drawScenery({ cardId, place: name, lore, passage: story, prompt: clip(prompt, 2000) || (existing && !rewrite ? existing.prompt : '') }, signal)
      const id = existing?.id ?? newId()
      const file = await writeImage(cardId, id, picture.buffer)
      const now = new Date().toISOString()
      const result = await change(cardId, async list => {
        const before = list.find(s => s.id === id)
        let fresh = { id, name, aliases: [], at: now }
        if (!before && story) {
          // The helper's name for the place; a second picture of a place gets a number.
          const base = clip(picture.place, 40) || name || msg`这一轮的场景`
          const taken = new Set(list.flatMap(placeKeys))
          let named = base
          for (let n = 2; taken.has(normalizePlace(named)); n++) named = `${base}（${n}）`
          fresh = { id, ...cleanNames(named, given ? [given] : []), at: now }
        }
        const scene = { ...(before ?? fresh), file, prompt: picture.prompt, backend: picture.backend, source: 'drawn', updatedAt: now }
        if (before) await dropFile(cardId, before.file)
        return { scenes: before ? list.map(s => (s.id === id ? scene : s)) : [...list, scene], result: scene }
      })
      return { scene: result, scenes: await read(cardId), drawn: true, ...(picture.note ? { note: picture.note } : {}) }
    })
  }

  /** A scene added by hand, with a picture from the page (a data URL) or none yet. */
  function add(cardId, { name, aliases, image } = {}) {
    const names = cleanNames(name, aliases)
    return change(cardId, async list => {
      if (list.length >= MAX_SCENES) throw httpError(400, msg`场景太多了（最多 ${MAX_SCENES} 个），先删掉一些`)
      const id = newId()
      const now = new Date().toISOString()
      const file = image ? await writeImage(cardId, id, decode(image)) : ''
      const scene = { id, ...names, file, prompt: '', backend: '', source: file ? 'upload' : '', at: now, updatedAt: now }
      return { scenes: [...list, scene], result: scene }
    }).then(async scene => ({ scene, ...(await view(cardId)) }))
  }

  function update(cardId, sceneId, { name, aliases } = {}) {
    return change(cardId, async list => {
      const before = list.find(s => s.id === sceneId)
      if (!before) throw httpError(404, msg`没有这个场景`)
      const scene = { ...before, ...cleanNames(name ?? before.name, aliases ?? before.aliases), updatedAt: new Date().toISOString() }
      return { scenes: list.map(s => (s.id === sceneId ? scene : s)), result: scene }
    }).then(async scene => ({ scene, ...(await view(cardId)) }))
  }

  function setImage(cardId, sceneId, image) {
    const buffer = decode(image)
    return change(cardId, async list => {
      const before = list.find(s => s.id === sceneId)
      if (!before) throw httpError(404, msg`没有这个场景`)
      const file = await writeImage(cardId, sceneId, buffer)
      await dropFile(cardId, before.file)
      const scene = { ...before, file, source: 'upload', updatedAt: new Date().toISOString() }
      return { scenes: list.map(s => (s.id === sceneId ? scene : s)), result: scene }
    }).then(async scene => ({ scene, ...(await view(cardId)) }))
  }

  function remove(cardId, sceneId) {
    return change(cardId, async list => {
      const before = list.find(s => s.id === sceneId)
      if (before) await dropFile(cardId, before.file)
      return { scenes: list.filter(s => s.id !== sceneId), result: null }
    }).then(() => view(cardId))
  }

  /** → { data, type }, or null. */
  async function readPicture(cardId, file) {
    if (!FILE.test(file)) return null
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  // ─── 立绘: one picture per cast member ───────────────────────────────

  /** { entryId: { file, backend, source, updatedAt } } for members still on the roster. */
  async function readSprites(cardId) {
    const card = await store.getCard(cardId)
    const ids = new Set((card.media?.roster ?? []).map(entry => entry.id))
    try {
      const value = JSON.parse(await readFile(spriteFile(cardId), 'utf8')).sprites ?? {}
      return Object.fromEntries(Object.entries(value).filter(([id, sprite]) => ids.has(id) && FILE.test(sprite?.file ?? '')))
    } catch {
      return {}
    }
  }

  function changeSprites(cardId, fn) {
    const key = `${cardId}:sprites`
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const sprites = await readSprites(cardId)
      const result = await fn(sprites)
      await writeFile(spriteFile(cardId), JSON.stringify({ sprites }, null, 1), 'utf8')
      return result
    })
    locks.set(key, run.catch(() => {}))
    return run
  }

  const spriteView = async cardId => ({ sprites: await readSprites(cardId), drawing: drawing.get(cardId) ?? null })

  async function memberOf(cardId, entryId) {
    if (!ENTRY.test(String(entryId))) throw httpError(404, msg`名单里没有这个角色`)
    const entry = ((await store.getCard(cardId)).media?.roster ?? []).find(item => item.id === entryId)
    if (!entry) throw httpError(404, msg`名单里没有这个角色`)
    return entry
  }

  async function putSprite(cardId, entryId, buffer, extra) {
    const file = await writeImage(cardId, entryId, buffer, spriteDir(cardId))
    await changeSprites(cardId, async sprites => {
      await dropFile(cardId, sprites[entryId]?.file, spriteDir(cardId))
      sprites[entryId] = { file, ...extra, updatedAt: new Date().toISOString() }
    })
    return spriteView(cardId)
  }

  /** A half-body picture of a cast member on a plain background (media.drawSprite). */
  async function drawSprite(cardId, entryId, signal) {
    const entry = await memberOf(cardId, entryId)
    return alone(cardId, msg`${entry.name}的立绘`, async () => {
      const picture = await media.drawSprite(cardId, entryId, signal)
      return { ...(await putSprite(cardId, entryId, picture.buffer, { backend: picture.backend, source: 'drawn' })), ...(picture.note ? { note: picture.note } : {}) }
    })
  }

  async function setSprite(cardId, entryId, image) {
    await memberOf(cardId, entryId)
    return putSprite(cardId, entryId, decode(image), { backend: '', source: 'upload' })
  }

  async function removeSprite(cardId, entryId) {
    await changeSprites(cardId, async sprites => {
      await dropFile(cardId, sprites[entryId]?.file, spriteDir(cardId))
      delete sprites[entryId]
    })
    return spriteView(cardId)
  }

  async function readSprite(cardId, file) {
    if (!FILE.test(file)) return null
    try {
      return { data: await readFile(path.join(spriteDir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  /** A newer version of a card takes the older one's scenes and sprites (http.mjs, as inheritCardMedia). */
  async function inherit(fromId, toId) {
    const copy = async (from, to, list, write) => {
      await mkdir(to, { recursive: true })
      for (const name of await readdir(from).catch(() => [])) {
        if (FILE.test(name)) await copyFile(path.join(from, name), path.join(to, name))
      }
      await write(list)
    }
    const scenes = await read(fromId).catch(() => [])
    if (scenes.length) await copy(dir(fromId), dir(toId), scenes, list => writeFile(listFile(toId), JSON.stringify({ scenes: list }, null, 1), 'utf8'))
    // Roster entries keep their ids in the new version (inheritCardMedia), so the sprites still belong.
    let sprites = {}
    try {
      sprites = JSON.parse(await readFile(spriteFile(fromId), 'utf8')).sprites ?? {}
    } catch {}
    if (Object.keys(sprites).length) await copy(spriteDir(fromId), spriteDir(toId), sprites, list => writeFile(spriteFile(toId), JSON.stringify({ sprites: list }, null, 1), 'utf8'))
  }

  return {
    list: view, draw, add, update, setImage, remove, readPicture, inherit,
    sprites: spriteView, drawSprite, setSprite, removeSprite, readSprite,
  }
}

/** A picture from the page: a data URL. */
function decode(image) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!match) throw httpError(400, msg`场景图要是 PNG、JPG 或 WebP`)
  return Buffer.from(match[1], 'base64')
}
