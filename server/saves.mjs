// 存档 (视觉小说模式): save slots per card, as in a game. A save is a spot in a
// chat — the reply (node) and the line in it — with where and when, the line
// itself and a small picture of the stage. Eighteen slots (three pages of six),
// one quick save (F5 / F9) and the last ten auto saves (one each turn). Loading
// one (http.mjs) shows that reply: later turns are rolled back and kept as a
// branch, never deleted. cards/<id>/saves.json, pictures cards/<id>/saves/<id>.jpg.
// Nothing sent to the model changes.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageKind } from './appearance.mjs'
import { httpError, readJsonFile, writeJson } from './store.mjs'
import { msg } from './i18n.mjs'

export const SAVE_SLOTS = 18
const AUTO_KEEP = 10
const MAX_PICTURE = 2 * 1024 * 1024
const PICTURE = /^[\w-]{1,64}\.(jpg|png|webp)$/
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** '1' … '18' or 'quick': the slot a save goes into by name. */
function slotName(slot) {
  const value = String(slot ?? '')
  if (value === 'quick') return value
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > SAVE_SLOTS || String(n) !== value) throw httpError(404, msg`没有这个存档位`)
  return value
}

export function createSaves(store) {
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'saves.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'saves')
  const locks = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    const value = await readJsonFile(listFile(cardId), null)
    return Array.isArray(value?.saves) ? value.saves : []
  }

  /** fn(saves) → { saves, result }: alone for this card, the list written after (whole, never half a file). */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const { saves, result } = await fn(await read(cardId))
      await writeJson(listFile(cardId), { saves })
      return result
    })
    locks.set(cardId, run.catch(() => {}))
    return run
  }

  const dropPicture = (cardId, file) => (PICTURE.test(file ?? '') ? rm(path.join(dir(cardId), file), { force: true }) : null)

  /**
   * The saves, newest first, each marked `gone` when its chat or reply no
   * longer exists. → { saves, slots }
   */
  async function list(cardId) {
    const saves = await read(cardId)
    const chats = new Map()
    const out = []
    for (const save of saves) {
      if (!chats.has(save.chatId)) chats.set(save.chatId, await store.getChat(save.chatId).catch(() => null))
      const chat = chats.get(save.chatId)
      out.push({ ...save, gone: !chat?.nodes?.[save.nodeId] })
    }
    out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    return { saves: out, slots: SAVE_SLOTS }
  }

  async function get(cardId, saveId) {
    const save = (await read(cardId)).find(item => item.id === saveId)
    if (!save) throw httpError(404, msg`没有这个存档`)
    return save
  }

  /** What the page sends, checked against the chat: a reply of a chat on this card. */
  async function cleanSave(cardId, body) {
    const chat = await store.getChat(String(body?.chatId ?? '')).catch(() => null)
    if (!chat || chat.cardId !== cardId) throw httpError(400, msg`这个对话不是这张卡的`)
    const node = chat.nodes[String(body?.nodeId ?? '')]
    if (!node || node.role !== 'assistant') throw httpError(400, msg`只能存在一条叙述上`)
    const line = Number(body?.line)
    return {
      chatId: chat.id,
      chatTitle: clip(body?.chatTitle, 80) || clip(chat.title, 80),
      nodeId: node.id,
      line: Number.isInteger(line) && line >= 0 && line < 100_000 ? line : 0,
      place: clip(body?.place, 40),
      time: clip(body?.time, 60),
      text: clip(body?.text, 120),
      note: clip(body?.note, 60),
    }
  }

  /** The stage picture from the page (a JPEG data URL), written under the save's id; '' when there is none. */
  async function writePicture(cardId, id, image) {
    const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(image ?? ''))
    if (!match) return ''
    const buffer = Buffer.from(match[1], 'base64')
    const kind = imageKind(buffer)
    if (!kind || buffer.length > MAX_PICTURE) return ''
    const file = `${id}.${kind}`
    await mkdir(dir(cardId), { recursive: true })
    await writeFile(path.join(dir(cardId), file), buffer)
    return file
  }

  const newSaveId = () => `s${Date.now().toString(36)}${randomBytes(3).toString('hex')}`

  /** Into a slot ('1' … '18', 'quick'): what was there goes. */
  async function put(cardId, slot, body) {
    const name = slotName(slot)
    const save = await cleanSave(cardId, body)
    const id = newSaveId()
    const picture = await writePicture(cardId, id, body?.image)
    await change(cardId, async saves => {
      for (const old of saves.filter(item => item.slot === name)) await dropPicture(cardId, old.picture)
      return { saves: [...saves.filter(item => item.slot !== name), { id, slot: name, ...save, picture, savedAt: new Date().toISOString() }], result: null }
    })
    return list(cardId)
  }

  /** An auto save (a turn just finished): the oldest beyond ten goes. */
  async function auto(cardId, body) {
    const save = await cleanSave(cardId, body)
    const id = newSaveId()
    const picture = await writePicture(cardId, id, body?.image)
    await change(cardId, async saves => {
      const autos = saves.filter(item => item.slot === 'auto').sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
      const dropped = autos.slice(AUTO_KEEP - 1)
      for (const old of dropped) await dropPicture(cardId, old.picture)
      const kept = saves.filter(item => !dropped.includes(item))
      return { saves: [...kept, { id, slot: 'auto', ...save, picture, savedAt: new Date().toISOString() }], result: null }
    })
    return list(cardId)
  }

  async function setNote(cardId, saveId, note) {
    await change(cardId, async saves => {
      const save = saves.find(item => item.id === saveId)
      if (!save) throw httpError(404, msg`没有这个存档`)
      save.note = clip(note, 60)
      return { saves, result: null }
    })
    return list(cardId)
  }

  async function remove(cardId, saveId) {
    await change(cardId, async saves => {
      const save = saves.find(item => item.id === saveId)
      if (save) await dropPicture(cardId, save.picture)
      return { saves: saves.filter(item => item.id !== saveId), result: null }
    })
    return list(cardId)
  }

  /** → { data, type }, or null. */
  async function readPicture(cardId, file) {
    if (!PICTURE.test(file)) return null
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  return { list, get, put, auto, setNote, remove, readPicture }
}
