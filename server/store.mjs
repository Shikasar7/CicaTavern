// Plain JSON-file storage under one data root. Every write goes through a
// temp file + rename so a crash mid-write never leaves a half-written JSON.
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { cleanProxySetting } from './proxy.mjs'
import { cleanBasic } from '../web/shared/basic.js'
import { cleanAppearance } from '../web/shared/appearance.js'
import { cleanList, DEFAULT_ITEM, defaultOf } from '../web/shared/personas.js'

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

/**
 * A list a feature keeps in a file of its own (存档, scenes, sprites, the prompt library): `fallback` when there
 * is none yet. One that no longer parses (cut off by a write that was not atomic) is moved aside to
 * <file>.bad-<time> and read as `fallback`, as before, but kept to recover by hand instead of being written
 * over by the next save. Any other read error (Windows: a scanner holding the file) is thrown, so nothing
 * overwrites the list on the strength of a failed read.
 */
export async function readJsonFile(file, fallback) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    await rename(file, `${file}.bad-${Date.now()}`).catch(() => {})
    return fallback
  }
}

// Writes to one file, one after another: two at once would race each other's rename.
const writing = new Map() // file → its latest write

/** `value` as JSON into `file` through a temp file and a rename, so a write cut off never leaves half a file. */
export function writeJson(file, value) {
  const text = JSON.stringify(value, null, 1)
  const write = (writing.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    // A name of its own: two writes in one millisecond once shared one and mixed their bytes.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, text, 'utf8')
      await renameOver(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  })
  writing.set(file, write)
  write.finally(() => {
    if (writing.get(file) === write) writing.delete(file)
  }).catch(() => {})
  return write
}

// Windows refuses a rename onto a file someone is reading (EPERM, EACCES, EBUSY): tried again for a moment.
const RENAME_REFUSED = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameOver(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      if (attempt >= 8 || !RENAME_REFUSED.has(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * attempt))
    }
  }
}

/**
 * Read-change-save, one at a time per key: two at once, each saving what it read, lost the other's change.
 * A section already holding the key (a helper it calls) goes straight on, so nesting never waits on itself.
 */
function createLocks() {
  const tails = new Map() // key → the latest section's promise
  const held = new AsyncLocalStorage() // the keys the running code holds
  return function locked(key, fn) {
    const holding = held.getStore()
    if (holding?.has(key)) return fn()
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => held.run(new Set([...(holding ?? []), key]), fn))
    tails.set(key, run)
    run.finally(() => {
      if (tails.get(key) === run) tails.delete(key)
    }).catch(() => {})
    return run
  }
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
  language: '简体中文', // the language the model writes the story in
  uiLanguage: 'auto', // the page's own language (界面语言): 'zh' | 'en' | 'auto' = the browser's (server/i18n.mjs)
  scanDepth: 4,
  reinjectAfter: 6,
  stateRefreshEvery: 5,
  dynamicStrip: 'rare', // when piled-up <动态设定> copies are stripped: 'often' | 'rare' | 'off' (dynamic.mjs)
  replyLength: 0, // target reply length in characters; 0 = no requirement
  presetId: '', // SillyTavern preset for new chats; empty = the built-in preset (basic.mjs)
  basic: null, // the built-in preset's options (web/shared/basic.js); null = their defaults
  listen: 'local', // 'local' or 'lan'; applied on the next start
  subscription: 'on', // 'off' hides the Claude subscription models (API providers only)
  proxy: null, // 'none' | 'system' | an http(s) URL; null = the edition's default (proxy.mjs)
  // Connections nobody configured (隐私与网络; the public builds ask once, privacyNotice = the notice's version seen):
  webFonts: true, // the body font from Google Fonts
  cdnLibraries: true, // jQuery, Vue, Tailwind… from jsDelivr for cards built for Tavern Helper (web/compat.js)
  privacyNotice: 0,
  media: null, // pictures and voice (media.mjs cleanMedia); written through /api/media/settings only
  appearance: null, // colour style and background picture (web/shared/appearance.js); the picture itself through /api/appearance/backdrop only
  globalBookIds: [], // 全局世界书: imported books every chat uses, mounted or not (chats.mjs booksForCard); set through PUT /api/worldbooks/:id/global
  globalVars: {}, // app-wide variables: the template `global` scope (template.mjs), Tavern Helper's global variables
})

/** Book ids as settings keep them: strings that can name a file, each once. */
const cleanIds = ids => [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)))]

/** Variables as settings keep them: a plain object. */
const cleanVars = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
// The app-wide variables, as JSON, at most: card scripts and templates write them, settings.json is read on most
// requests, and they go into every template's sandbox (26 MB of them once broke every other card's templates).
const GLOBAL_VARS_MAX = 1_000_000

/** The 隐私与网络 notice's version: settings.privacyNotice below it means not seen yet. */
export const PRIVACY_NOTICE = 1

export const DEFAULT_PERSONA = Object.freeze({ name: '你', description: '' })

// 你的角色 and 文风 as lists (web/shared/personas.js), each in a file of its own.
const LIST_FILES = { persona: 'personas.json', style: 'styles.json' }

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
  const locked = createLocks()

  return {
    dirs,
    /** Run `fn` (its getChat … saveChat of chat `id`) with no other such section on that chat meanwhile. */
    withChat(id, fn) {
      return locked(`chat:${id}`, fn)
    },
    async init() {
      for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    },

    async getSettings() {
      const saved = { ...DEFAULT_SETTINGS, ...(await readJson(path.join(root, 'settings.json'), {})) }
      return lockSettings({ ...saved, basic: cleanBasic(saved.basic), appearance: cleanAppearance(saved.appearance), globalBookIds: cleanIds(saved.globalBookIds), globalVars: cleanVars(saved.globalVars) })
    },
    /** Settings worked out from the saved ones and saved, with no other save in between (template global writes). */
    updateSettings(change, options) {
      return locked('settings', async () => this.saveSettings(await change(await this.getSettings()), options))
    },
    // One at a time: each starts from what the last one saved.
    saveSettings(patch, { backdrop } = {}) {
      return locked('settings', async () => {
        // Only a save that writes them: settings already that big still save everything else.
        if (patch.globalVars !== undefined && JSON.stringify(cleanVars(patch.globalVars)).length > GLOBAL_VARS_MAX) throw httpError(400, '全局变量太大')
        const current = await this.getSettings()
        const next = { ...current }
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (patch[key] !== undefined) next[key] = patch[key]
        }
        if (next.listen !== 'lan') next.listen = 'local'
        if (next.subscription !== 'off') next.subscription = 'on'
        next.proxy = cleanProxySetting(next.proxy)
        if (!['often', 'rare', 'off'].includes(next.dynamicStrip)) next.dynamicStrip = 'rare'
        if (!['auto', 'zh', 'en'].includes(next.uiLanguage)) next.uiLanguage = 'auto'
        next.webFonts = next.webFonts !== false
        next.cdnLibraries = next.cdnLibraries !== false
        next.privacyNotice = Math.max(0, Math.floor(Number(next.privacyNotice) || 0))
        next.basic = cleanBasic(next.basic)
        next.globalBookIds = cleanIds(next.globalBookIds)
        next.globalVars = cleanVars(next.globalVars)
        // The picture's file name only changes with the picture (setBackdrop below).
        next.appearance = cleanAppearance({ ...current.appearance, ...next.appearance, backdrop: backdrop ?? current.appearance.backdrop })
        const saved = lockSettings(next)
        await writeJson(path.join(root, 'settings.json'), saved)
        return saved
      })
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
    /**
     * 你的角色 or 文风 (`kind` persona | style): { defaultId, items, cards }. Until the list is first saved it is the one
     * setting there was before (persona.json, settings.writingRules) as its only item, the default; those files are
     * left as they were.
     */
    async getList(kind) {
      const saved = await readJsonFile(path.join(root, LIST_FILES[kind]), null)
      if (saved) return cleanList(kind, saved)
      const before = kind === 'persona'
        ? { ...DEFAULT_PERSONA, ...(await readJson(path.join(root, 'persona.json'), {})) }
        : { text: (await readJson(path.join(root, 'settings.json'), {})).writingRules }
      return cleanList(kind, { defaultId: DEFAULT_ITEM, items: [{ ...before, id: DEFAULT_ITEM }] })
    },
    /** `change` (the list → the list to keep) over the list as saved, with no other change in between. */
    updateList(kind, change) {
      return locked(`list:${kind}`, async () => {
        const list = cleanList(kind, await change(await this.getList(kind)))
        await writeJson(path.join(root, LIST_FILES[kind]), list)
        return list
      })
    },
    getPersonas() {
      return this.getList('persona')
    },
    getStyles() {
      return this.getList('style')
    },
    /** The default persona ({ id, name, title, description }): the player in new chats on cards that picked none. */
    async getPersona() {
      return defaultOf(await this.getPersonas())
    },
    /** The default persona's name and description changed (the old single setting's route). */
    async savePersona(patch) {
      const list = await this.updateList('persona', list => ({
        ...list,
        items: list.items.map(item => (item.id === list.defaultId ? { ...item, ...pick(patch, ['name', 'description']) } : item)),
      }))
      return defaultOf(list)
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
    /** Regex scripts for every chat (regex.mjs, which cleans them before they are saved). */
    async getRegex() {
      const value = await readJson(path.join(root, 'regex.json'), {})
      return Array.isArray(value.scripts) ? value.scripts : []
    },
    async saveRegex(scripts) {
      await writeJson(path.join(root, 'regex.json'), { scripts })
      return scripts
    },
    /** 正则集: named lists of scripts, each for the cards ticked for it (regex.mjs). In run order. */
    async getRegexSets() {
      const value = await readJson(path.join(root, 'regex-sets.json'), {})
      return Array.isArray(value.sets) ? value.sets : []
    },
    /** `change` (the sets → the sets to keep) over the sets as saved, with no other change in between. */
    updateRegexSets(change) {
      return locked('regex-sets', async () => {
        const sets = await change(await this.getRegexSets())
        await writeJson(path.join(root, 'regex-sets.json'), { sets })
        return sets
      })
    },
    /** 屏蔽词 for every chat (blockwords.mjs, which cleans them before they are saved). */
    async getBlockWords() {
      const value = await readJson(path.join(root, 'blockwords.json'), {})
      return Array.isArray(value.words) ? value.words : []
    },
    async saveBlockWords(words) {
      await writeJson(path.join(root, 'blockwords.json'), { words })
      return words
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
