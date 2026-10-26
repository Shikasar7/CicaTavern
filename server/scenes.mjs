// 场景图库 (视觉小说模式): a card's backgrounds, one per place, drawn once and
// reused in every chat on the card. cards/<id>/scenes.json lists them; the
// pictures are cards/<id>/scenes/<sceneId>-<6 hex>.<ext>, renamed with each new
// picture so the page can keep them cached for good. They stay out of
// card.media and roster/, which the media settings clean up on save.
// 立绘 the same way: one half-body picture per cast member (the roster entry's
// id), cards/<id>/sprites.json and cards/<id>/sprites/<entryId>-<6 hex>.<ext>;
// the page cuts the plain background out. Its expressions (表情差分) sit beside
// it in sprites.json under expressions: { entryId: { smile: {…} } }, pictures
// sprites/<entryId>-<expression>-<6 hex>.<ext>; they may exist for someone
// shown from their reference picture, with no 立绘 of their own. One picture is
// drawn at a time per card, scene, sprite or expression.
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizePlace, placeKeys } from '../web/shared/vn.js'
import { EXPRESSIONS } from '../web/shared/stage.js'
import { imageKind } from './appearance.mjs'
import { booksForCard } from './chats.mjs'
import { entryText } from './worldbook.mjs'
import { httpError, newId, readJsonFile, writeJson } from './store.mjs'
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

/**
 * @param media - createMedia(): drawScenery draws a background.
 * @param history - createDrawHistory() (抽图历史): a picture drawn or uploaded
 *   over another keeps that one there; without it, it is deleted.
 */
export function createScenes(store, { media, history = null }) {
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'scenes.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'scenes')
  const spriteFile = cardId => path.join(store.dirs.cards, cardId, 'sprites.json')
  const spriteDir = cardId => path.join(store.dirs.cards, cardId, 'sprites')
  // One change at a time per card; one picture being drawn per card.
  const locks = new Map()
  const drawing = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    const value = await readJsonFile(listFile(cardId), null)
    return Array.isArray(value?.scenes) ? value.scenes : []
  }

  /** fn(scenes) → { scenes, result }: run alone for this card, the list saved after (whole, never half a file). */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const { scenes, result } = await fn(await read(cardId))
      await writeJson(listFile(cardId), { scenes })
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

  /** A picture taken down for a new one: kept in 抽图历史 with what it was drawn with, else deleted. */
  async function keepOld(cardId, slot, before, folder = dir(cardId)) {
    if (!before?.file || !FILE.test(before.file)) return
    if (!history) return dropFile(cardId, before.file, folder)
    await history.push(cardId, slot, { from: path.join(folder, before.file), at: before.updatedAt ?? before.at, backend: before.backend, source: before.source, prompt: before.prompt })
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
    // A place with nothing to tell it by (???, ……) is none: a scene named so could never be found again.
    const given = normalizePlace(place) ? clip(place, 40) : ''
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
        if (before) await keepOld(cardId, `scene:${id}`, before)
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
      await keepOld(cardId, `scene:${sceneId}`, before)
      const scene = { ...before, file, source: 'upload', updatedAt: new Date().toISOString() }
      return { scenes: list.map(s => (s.id === sceneId ? scene : s)), result: scene }
    }).then(async scene => ({ scene, ...(await view(cardId)) }))
  }

  function remove(cardId, sceneId) {
    return change(cardId, async list => {
      const before = list.find(s => s.id === sceneId)
      if (before) await dropFile(cardId, before.file)
      return { scenes: list.filter(s => s.id !== sceneId), result: null }
    }).then(async () => {
      // Its old pictures go with it.
      await history?.drop(cardId, slot => slot === `scene:${sceneId}`)
      return view(cardId)
    })
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

  /**
   * sprites.json for members still on the roster: { sprites: { entryId: { file,
   * backend, source, updatedAt } }, expressions: { entryId: { smile: { … } } } }.
   */
  async function readSpriteFile(cardId) {
    const card = await store.getCard(cardId)
    const ids = new Set((card.media?.roster ?? []).map(entry => entry.id))
    const picture = value => FILE.test(value?.file ?? '')
    const value = await readJsonFile(spriteFile(cardId), null)
    const sprites = Object.fromEntries(Object.entries(value?.sprites ?? {}).filter(([id, sprite]) => ids.has(id) && picture(sprite)))
    const expressions = {}
    for (const [id, faces] of Object.entries(value?.expressions ?? {})) {
      if (!ids.has(id) || !faces || typeof faces !== 'object') continue
      const kept = Object.fromEntries(Object.entries(faces).filter(([name, face]) => EXPRESSIONS.includes(name) && name !== 'neutral' && picture(face)))
      if (Object.keys(kept).length) expressions[id] = kept
    }
    return { sprites, expressions }
  }

  const readSprites = async cardId => (await readSpriteFile(cardId)).sprites

  /** fn({ sprites, expressions }) changes them in place, alone for this card; the file is saved after. */
  function changeSprites(cardId, fn) {
    const key = `${cardId}:sprites`
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const all = await readSpriteFile(cardId)
      const result = await fn(all)
      await writeJson(spriteFile(cardId), all)
      return result
    })
    locks.set(key, run.catch(() => {}))
    return run
  }

  const spriteView = async cardId => ({ ...(await readSpriteFile(cardId)), drawing: drawing.get(cardId) ?? null })

  async function memberOf(cardId, entryId) {
    if (!ENTRY.test(String(entryId))) throw httpError(404, msg`名单里没有这个角色`)
    const entry = ((await store.getCard(cardId)).media?.roster ?? []).find(item => item.id === entryId)
    if (!entry) throw httpError(404, msg`名单里没有这个角色`)
    return entry
  }

  async function putSprite(cardId, entryId, buffer, extra) {
    const file = await writeImage(cardId, entryId, buffer, spriteDir(cardId))
    await changeSprites(cardId, async ({ sprites }) => {
      await keepOld(cardId, `sprite:${entryId}`, sprites[entryId], spriteDir(cardId))
      sprites[entryId] = { file, updatedAt: new Date().toISOString(), ...extra }
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
    await changeSprites(cardId, async ({ sprites }) => {
      await dropFile(cardId, sprites[entryId]?.file, spriteDir(cardId))
      delete sprites[entryId]
    })
    return spriteView(cardId)
  }

  // ─── 表情差分: the same 立绘 with another face ──────────────────────────

  function expressionName(expression) {
    if (!EXPRESSIONS.includes(expression) || expression === 'neutral') throw httpError(404, msg`没有这种表情`)
    return expression
  }

  async function putExpression(cardId, entryId, expression, buffer, extra) {
    const file = await writeImage(cardId, `${entryId}-${expression}`, buffer, spriteDir(cardId))
    await changeSprites(cardId, async ({ expressions }) => {
      await keepOld(cardId, `face:${entryId}:${expression}`, expressions[entryId]?.[expression], spriteDir(cardId))
      expressions[entryId] = { ...expressions[entryId], [expression]: { file, updatedAt: new Date().toISOString(), ...extra } }
    })
    return spriteView(cardId)
  }

  /** The 立绘 (else the reference picture) with only the face changed (media.drawExpression). */
  async function drawExpression(cardId, entryId, expression, signal) {
    const entry = await memberOf(cardId, entryId)
    expressionName(expression)
    return alone(cardId, msg`${entry.name}的表情`, async () => {
      const base = (await readSprites(cardId))[entryId]
      const buffer = base ? await readFile(path.join(spriteDir(cardId), base.file)).catch(() => null) : null
      const picture = await media.drawExpression(cardId, entryId, expression, buffer, signal)
      return { ...(await putExpression(cardId, entryId, expression, picture.buffer, { backend: picture.backend, source: 'drawn' })), ...(picture.note ? { note: picture.note } : {}) }
    })
  }

  async function setExpression(cardId, entryId, expression, image) {
    await memberOf(cardId, entryId)
    return putExpression(cardId, entryId, expressionName(expression), decode(image), { backend: '', source: 'upload' })
  }

  async function removeExpression(cardId, entryId, expression) {
    expressionName(expression)
    await changeSprites(cardId, async ({ expressions }) => {
      await dropFile(cardId, expressions[entryId]?.[expression]?.file, spriteDir(cardId))
      if (expressions[entryId]) delete expressions[entryId][expression]
      if (expressions[entryId] && !Object.keys(expressions[entryId]).length) delete expressions[entryId]
    })
    return spriteView(cardId)
  }

  /**
   * 抽图历史: a kept picture (history.take: `entry` says what it was drawn with)
   * back in its place, the one there now kept instead. → the sprites view for a
   * 立绘 or expression, the scenes view for a scene.
   */
  async function restore(cardId, slot, buffer, entry = {}) {
    const [kind, id, expression] = String(slot).split(':')
    const extra = { backend: entry.backend ?? '', source: entry.source || 'drawn', ...(entry.at ? { updatedAt: entry.at } : {}) }
    if (kind === 'sprite') {
      await memberOf(cardId, id)
      return putSprite(cardId, id, buffer, extra)
    }
    if (kind === 'face') {
      await memberOf(cardId, id)
      return putExpression(cardId, id, expressionName(expression), buffer, extra)
    }
    if (kind !== 'scene') throw httpError(400, msg`这张旧图不能在这里换回来`)
    return change(cardId, async list => {
      const before = list.find(s => s.id === id)
      if (!before) throw httpError(404, msg`没有这个场景`)
      const file = await writeImage(cardId, id, buffer)
      await keepOld(cardId, slot, before)
      // An uploaded one had no prompt of its own: the scene keeps its prompt for 重画.
      const scene = { ...before, file, updatedAt: new Date().toISOString(), ...extra, prompt: entry.prompt || before.prompt }
      return { scenes: list.map(s => (s.id === id ? scene : s)), result: scene }
    }).then(async scene => ({ scene, ...(await view(cardId)) }))
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
    if (scenes.length) await copy(dir(fromId), dir(toId), scenes, list => writeJson(listFile(toId), { scenes: list }))
    // Roster entries keep their ids in the new version (inheritCardMedia), so the sprites still belong.
    const sprites = (await readJsonFile(spriteFile(fromId), null).catch(() => null)) ?? {}
    if (Object.keys(sprites.sprites ?? {}).length || Object.keys(sprites.expressions ?? {}).length) {
      await copy(spriteDir(fromId), spriteDir(toId), sprites, all => writeJson(spriteFile(toId), { sprites: all.sprites ?? {}, expressions: all.expressions ?? {} }))
    }
  }

  return {
    list: view, draw, add, update, setImage, remove, readPicture, inherit,
    sprites: spriteView, drawSprite, setSprite, removeSprite, readSprite, drawExpression, setExpression, removeExpression,
    restore,
  }
}

/** A picture from the page: a data URL. */
function decode(image) {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
  if (!match) throw httpError(400, msg`场景图要是 PNG、JPG 或 WebP`)
  return Buffer.from(match[1], 'base64')
}
