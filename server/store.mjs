// Plain JSON-file storage under one data root. Every write goes through a
// temp file + rename so a crash mid-write never leaves a half-written JSON.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { cleanProxySetting } from './proxy.mjs'

/** @param dir - the edition's folder under the home directory (edition.mjs dataDir). */
export function defaultDataRoot(dir = '.agent-tavern') {
  return process.env.AGENT_TAVERN_HOME || path.join(homedir(), dir)
}

export function newId() {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/

function checkId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw httpError(400, '无效的 ID')
  return id
}

export function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
  await rename(tmp, file)
}

async function listJson(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = await readJson(path.join(dir, name), null)
    if (value) items.push(value)
  }
  return items
}

export const DEFAULT_SETTINGS = Object.freeze({
  model: 'sonnet',
  effort: 'low',
  thinking: 'off',
  language: '简体中文',
  writingRules: '',
  scanDepth: 4,
  reinjectAfter: 6,
  stateRefreshEvery: 5,
  dynamicStrip: 'rare', // when piled-up <动态设定> copies are stripped: 'often' | 'rare' | 'off' (dynamic.mjs)
  replyLength: 0, // target reply length in characters; 0 = no requirement
  presetId: '', // SillyTavern preset for new chats; empty = built-in rules
  listen: 'local', // 'local' or 'lan'; applied on the next start
  subscription: 'on', // 'off' hides the Claude subscription models (API providers only)
  proxy: null, // 'none' | 'system' | an http(s) URL; null = the edition's default (proxy.mjs)
  media: null, // pictures and voice (media.mjs cleanMedia); written through /api/media/settings only
})

export const DEFAULT_PERSONA = Object.freeze({ name: '你', description: '' })

/**
 * @param subscription - false in builds without Claude Code (release, Android):
 *   the subscription stays off and the default model must come from a provider.
 * @param lan - false where the server only listens on loopback (Android).
 */
export function createStore(root = defaultDataRoot(), { subscription = true, lan = true } = {}) {
  const lockSettings = settings => {
    let locked = settings
    if (!subscription) locked = { ...locked, subscription: 'off', model: String(locked.model ?? '').includes('/') ? locked.model : '' }
    if (!lan) locked = { ...locked, listen: 'local' }
    return locked
  }
  const dirs = {
    root,
    cards: path.join(root, 'cards'),
    books: path.join(root, 'worldbooks'),
    chats: path.join(root, 'chats'),
    presets: path.join(root, 'presets'),
  }
  const cardFile = id => path.join(dirs.cards, checkId(id), 'card.json')
  const bookFile = id => path.join(dirs.books, `${checkId(id)}.json`)
  const chatFile = id => path.join(dirs.chats, `${checkId(id)}.json`)
  const presetFile = id => path.join(dirs.presets, `${checkId(id)}.json`)

  return {
    dirs,
    async init() {
      for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    },

    async getSettings() {
      return lockSettings({ ...DEFAULT_SETTINGS, ...(await readJson(path.join(root, 'settings.json'), {})) })
    },
    async saveSettings(patch) {
      const next = { ...(await this.getSettings()) }
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (patch[key] !== undefined) next[key] = patch[key]
      }
      if (next.listen !== 'lan') next.listen = 'local'
      if (next.subscription !== 'off') next.subscription = 'on'
      next.proxy = cleanProxySetting(next.proxy)
      if (!['often', 'rare', 'off'].includes(next.dynamicStrip)) next.dynamicStrip = 'rare'
      const saved = lockSettings(next)
      await writeJson(path.join(root, 'settings.json'), saved)
      return saved
    },
    async ensureAccessToken() {
      const file = path.join(root, 'access.json')
      const current = await readJson(file, {})
      if (typeof current.token === 'string' && /^[a-f0-9]{24,}$/.test(current.token)) return current.token
      const token = randomBytes(18).toString('hex')
      await writeJson(file, { token })
      return token
    },
    /** Custom API providers, keys included (see providers.mjs publicProvider for what the UI gets). */
    async getProviders() {
      const value = await readJson(path.join(root, 'providers.json'), {})
      return Array.isArray(value.providers) ? value.providers : []
    },
    async saveProviders(providers) {
      await writeJson(path.join(root, 'providers.json'), { providers })
      return providers
    },
    async getPersona() {
      return { ...DEFAULT_PERSONA, ...(await readJson(path.join(root, 'persona.json'), {})) }
    },
    async savePersona(patch) {
      const next = { ...(await this.getPersona()), ...pick(patch, ['name', 'description']) }
      await writeJson(path.join(root, 'persona.json'), next)
      return next
    },

    async listCards() {
      let names = []
      try {
        names = await readdir(dirs.cards)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const cards = []
      for (const name of names) {
        if (!SAFE_ID.test(name)) continue
        const card = await readJson(path.join(dirs.cards, name, 'card.json'), null)
        if (card) cards.push(card)
      }
      return cards.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    },
    async getCard(id) {
      const card = await readJson(cardFile(id), null)
      if (!card) throw httpError(404, '角色卡不存在')
      return card
    },
    async saveCard(card, avatar) {
      await writeJson(cardFile(card.id), card)
      if (avatar) await writeFile(path.join(dirs.cards, card.id, 'avatar.png'), avatar)
      return card
    },
    avatarPath(id) {
      return path.join(dirs.cards, checkId(id), 'avatar.png')
    },
    async deleteCard(id) {
      await rm(path.join(dirs.cards, checkId(id)), { recursive: true, force: true })
    },

    async listBooks() {
      return (await listJson(dirs.books)).sort((a, b) => a.name.localeCompare(b.name))
    },
    async getBook(id) {
      const book = await readJson(bookFile(id), null)
      if (!book) throw httpError(404, '世界书不存在')
      return book
    },
    async saveBook(book) {
      await writeJson(bookFile(book.id), book)
      return book
    },
    async deleteBook(id) {
      await rm(bookFile(id), { force: true })
    },

    async listPresets() {
      return (await listJson(dirs.presets)).sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    },
    async getPreset(id) {
      const preset = await readJson(presetFile(id), null)
      if (!preset) throw httpError(404, '预设不存在')
      return preset
    },
    async savePreset(preset) {
      await writeJson(presetFile(preset.id), preset)
      return preset
    },
    async deletePreset(id) {
      await rm(presetFile(id), { force: true })
    },

    async listChats(cardId) {
      const chats = await listJson(dirs.chats)
      return chats
        .filter(chat => !cardId || chat.cardId === cardId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    async getChat(id) {
      const chat = await readJson(chatFile(id), null)
      if (!chat) throw httpError(404, '对话不存在')
      return chat
    },
    async saveChat(chat) {
      chat.updatedAt = new Date().toISOString()
      await writeJson(chatFile(chat.id), chat)
      return chat
    },
    async deleteChat(id) {
      await rm(chatFile(id), { force: true })
    },
  }
}

function pick(object, keys) {
  const out = {}
  for (const key of keys) if (typeof object?.[key] === 'string') out[key] = object[key]
  return out
}
