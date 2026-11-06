// 背景音乐 (游戏规则): the player's own tracks for a card. cards/<id>/music.json, the files in cards/<id>/music/. Nothing
// of it ships with the app and nothing of it leaves with the card: what a player uploads is theirs to have the rights to.
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { httpError, readJsonFile, writeJson } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_TRACKS = 30
const FILE = /^[\w-]{1,64}\.(mp3|ogg|wav|m4a|flac|aac)$/
const DATA = /^data:audio\/([\w.+-]+);base64,([A-Za-z0-9+/=]+)$/
const EXT = { mpeg: 'mp3', mp3: 'mp3', ogg: 'ogg', wav: 'wav', 'x-wav': 'wav', mp4: 'm4a', 'x-m4a': 'm4a', m4a: 'm4a', flac: 'flac', 'x-flac': 'flac', aac: 'aac' }
const TYPES = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac' }
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export function createMusic(store) {
  const listFile = cardId => path.join(store.dirs.cards, cardId, 'music.json')
  const dir = cardId => path.join(store.dirs.cards, cardId, 'music')
  const locks = new Map()

  async function read(cardId) {
    await store.getCard(cardId)
    const value = await readJsonFile(listFile(cardId), null)
    return Array.isArray(value?.tracks) ? value.tracks : []
  }

  /** fn(tracks) → { tracks, result }: alone for this card, the list written after. */
  function change(cardId, fn) {
    const run = (locks.get(cardId) ?? Promise.resolve()).then(async () => {
      const { tracks, result } = await fn(await read(cardId))
      await writeJson(listFile(cardId), { tracks })
      return result
    })
    locks.set(cardId, run.catch(() => {}))
    return run
  }

  const list = async cardId => ({ tracks: await read(cardId) })

  /** { name, use, data: a data: URL }. `use`: 'story', 'battle', or a place's name. */
  function add(cardId, { name, use, data }) {
    const match = DATA.exec(String(data ?? ''))
    const ext = match ? EXT[match[1].toLowerCase()] : null
    if (!ext) throw httpError(400, msg`这个音频格式用不了，换成 mp3、ogg、wav、m4a 或 flac 试试`)
    return change(cardId, async tracks => {
      if (tracks.length >= MAX_TRACKS) throw httpError(400, msg`这张卡的音乐太多了，删掉一些再传`)
      const id = randomBytes(8).toString('hex')
      const file = `${id}.${ext}`
      await mkdir(dir(cardId), { recursive: true })
      await writeFile(path.join(dir(cardId), file), Buffer.from(match[2], 'base64'))
      const track = { id, name: clip(name, 80) || file, use: clip(use, 40) || 'story', file }
      return { tracks: [...tracks, track], result: track }
    })
  }

  function update(cardId, trackId, { name, use }) {
    return change(cardId, async tracks => {
      const track = tracks.find(item => item.id === trackId)
      if (!track) throw httpError(404, msg`没有这首音乐`)
      const next = { ...track, name: clip(name, 80) || track.name, use: clip(use, 40) || track.use }
      return { tracks: tracks.map(item => (item === track ? next : item)), result: next }
    })
  }

  function remove(cardId, trackId) {
    return change(cardId, async tracks => {
      const track = tracks.find(item => item.id === trackId)
      if (track && FILE.test(track.file)) await rm(path.join(dir(cardId), track.file), { force: true })
      return { tracks: tracks.filter(item => item !== track), result: { ok: true } }
    })
  }

  async function readTrack(cardId, file) {
    if (!FILE.test(file)) return null
    try {
      return { data: await readFile(path.join(dir(cardId), file)), type: TYPES[file.split('.').pop()] }
    } catch {
      return null
    }
  }

  /** A newer version of a card takes the older one's tracks, as it does its scenes (http.mjs). */
  async function inherit(fromId, toId) {
    const tracks = (await read(fromId)).filter(track => FILE.test(track.file))
    if (!tracks.length) return
    await mkdir(dir(toId), { recursive: true })
    for (const track of tracks) await copyFile(path.join(dir(fromId), track.file), path.join(dir(toId), track.file))
    await change(toId, async () => ({ tracks, result: null }))
  }

  return { list, add, update, remove, readTrack, inherit }
}
