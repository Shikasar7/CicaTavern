// 备份与换设备 (设置 → 更多): everything movable in the data folder as one zip, by kind, and that zip merged into
// another device's data. The zip mirrors the folder under data/ (cards/<id>/…, chats/<id>.json, media/<chatId>/…),
// with cicatavern-backup.json saying what it holds. What stays on the device that has it: the access token, logs,
// the 朗读 cache, Codex's workspace, the proxy and listen settings, the local ComfyUI / SD / voice bridge addresses,
// and providers on this machine's own address (exportProviders). Keys go only when asked for.
//
// Import merges: what is not here is added under its own id (so a chat still finds its card, a card its books);
// what is here already is kept or replaced, as the player chose once for all of it. A unit that fails (one card,
// one chat) is reported and the rest go on. Each unit is written beside its place and moved in whole.
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createZipWriter, openZipFile } from './backup-zip.mjs'
import { createStore, writeJson } from './store.mjs'
import { exportProviders, importProviders, PROVIDERS_FORMAT } from './providers.mjs'
import { oldImageFiles, withoutOldImages } from './draw-history.mjs'
import { DIRECT_CARD, isBuiltinPreset } from '../web/shared/basic.js'
import { cleanMedia } from './media.mjs'
import { cleanList } from '../web/shared/personas.js'

export const BACKUP_FORMAT = 'cicatavern-backup'
export const BACKUP_MANIFEST = 'cicatavern-backup.json'
const VERSION = 1

/** The kinds, in the order the window lists them. history and keys are off unless ticked. */
export const CATEGORIES = ['cards', 'chats', 'history', 'books', 'presets', 'lists', 'settings', 'providers', 'keys', 'usage']
export const DEFAULT_OFF = new Set(['history', 'keys'])

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/
// Leftovers of earlier writes and hand repairs: never moved.
const JUNK = /\.tmp$|\.bak$|\.bak-|\.bad-\d+$|\.before-|\.importing-/
// A path segment a zip may name: no separators, no `..`, nothing Windows refuses.
const SEGMENT = /^(?!\.{1,2}$)[^\\/:*?"<>|\0-\x1f]{1,180}$/
const KEY_FILES = ['voice-keys.json', 'tts-key.json', 'novelai.json']
const LIST_FILES = { persona: 'personas.json', style: 'styles.json' }
// A header value under one of these names carries a key: left out with the keys.
const SECRET_NAME = /key|token|secret|pass|auth|cookie/i

// Settings by the kind they move with. Never: listen, proxy, subscription, privacyNotice (this device's own).
const SETTINGS_OF = {
  presets: ['presetId', 'basic', 'vn', 'basicEdits', 'vnEdits'],
  books: ['globalBookIds'],
  providers: ['model', 'media'],
}
const LOCAL_SETTINGS = new Set(['listen', 'proxy', 'subscription', 'privacyNotice'])
// 配图 and 朗读 settings that name this machine's own services.
const LOCAL_MEDIA = ['comfyUrl', 'sdUrl', 'ttsUrl']

const settingsKind = key => Object.keys(SETTINGS_OF).find(kind => SETTINGS_OF[kind].includes(key)) ?? 'settings'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Every file under `dir`, as paths relative to it with '/' ([] when there is no such folder). */
async function walk(dir, prefix = '') {
  let entries
  try {
    entries = await readdir(path.join(dir, prefix), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (JUNK.test(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await walk(dir, rel)))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

const sizeOf = async file => (await stat(file).catch(() => null))?.size ?? 0
const readJsonOr = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}
const exists = async file => Boolean(await stat(file).catch(() => null))

/** A provider without its key and the headers that carry one (导出 without 密钥). */
function keyless(provider) {
  const headers = isRecord(provider.headers) ? Object.fromEntries(Object.entries(provider.headers).filter(([name]) => !SECRET_NAME.test(name))) : provider.headers
  return { ...provider, apiKey: '', headers }
}

/** The ticked kinds as a set the rest can trust: known names only; 密钥 brings 供应商 (the keys are theirs). */
export function cleanInclude(include) {
  const picked = new Set((Array.isArray(include) ? include : []).filter(key => CATEGORIES.includes(key)))
  if (picked.has('keys')) picked.add('providers')
  return picked
}

/**
 * @param store - createStore()
 * @param info - { version, edition, platform }: what the manifest says the zip came from; storeOptions, the store's
 *   own ({ subscription, lan }), so this device's defaults are known.
 */
export function createBackup(store, { version = '0.0.0', edition = '', platform = process.platform, storeOptions = {} } = {}) {
  const root = store.dirs.root
  const at = (...parts) => path.join(root, ...parts)

  /**
   * What would go, by kind: { kind: [{ name (in the zip), file, bytes, strip? }] } (strip: a chat whose old pictures,
   * 抽图历史, come out of its file when they stay behind), plus the providers left out for their address.
   */
  async function plan() {
    const files = Object.fromEntries(CATEGORIES.map(kind => [kind, []]))
    const items = { cards: [], chats: [], books: [], presets: [] }
    const add = async (kind, rel, extra = {}) => {
      const file = at(...rel.split('/'))
      const bytes = extra.bytes ?? (await sizeOf(file))
      files[kind].push({ name: `data/${rel}`, file, bytes, ...extra })
    }
    const rootFile = async (kind, name) => {
      if (await exists(at(name))) await add(kind, name)
    }

    // 角色卡: each card's folder; its 抽图历史 apart.
    for (const id of (await readdir(store.dirs.cards).catch(() => [])).filter(name => SAFE_ID.test(name)).sort()) {
      const card = await readJsonOr(at('cards', id, 'card.json'), null)
      if (!card) continue
      if (!card.direct) items.cards.push({ id, name: String(card.name ?? '') })
      for (const rel of await walk(at('cards', id))) {
        const old = rel === 'history.json' || rel.startsWith('history/')
        await add(old ? 'history' : 'cards', `cards/${id}/${rel}`, { unit: id })
      }
    }
    for (const name of ['card-order.json', 'group-order.json', 'script-permissions.json']) await rootFile('cards', name)
    // 创作中的卡 (drafts): with the cards; a draft's old avatars (<id>.history/) are 抽图历史.
    for (const rel of await walk(at('forge'))) await add(/\.history\//.test(rel) ? 'history' : 'cards', `forge/${rel}`)

    // 对话: each chat, and its pictures; the old ones are 抽图历史.
    for (const name of (await readdir(store.dirs.chats).catch(() => [])).sort()) {
      const id = name.replace(/\.json$/, '')
      if (!name.endsWith('.json') || !SAFE_ID.test(id)) continue
      const chat = await readJsonOr(at('chats', name), null)
      if (!chat?.nodes) continue
      items.chats.push({ id, title: String(chat.title ?? ''), cardId: String(chat.cardId ?? '') })
      const old = new Set(oldImageFiles(chat))
      await add('chats', `chats/${name}`, { strip: old.size > 0 })
      for (const rel of await walk(at('media', id))) await add(old.has(rel) ? 'history' : 'chats', `media/${id}/${rel}`, { unit: id })
    }

    for (const name of (await readdir(store.dirs.books).catch(() => [])).filter(name => name.endsWith('.json')).sort()) {
      const book = await readJsonOr(at('worldbooks', name), null)
      if (!book) continue
      items.books.push({ id: name.slice(0, -5), name: String(book.name ?? '') })
      await add('books', `worldbooks/${name}`)
    }
    for (const name of (await readdir(store.dirs.presets).catch(() => [])).filter(name => name.endsWith('.json')).sort()) {
      const preset = await readJsonOr(at('presets', name), null)
      if (!preset) continue
      items.presets.push({ id: name.slice(0, -5), name: String(preset.name ?? '') })
      await add('presets', `presets/${name}`)
    }
    for (const rel of await walk(at('preset-scripts'))) if (rel.endsWith('.json')) await add('presets', `preset-scripts/${rel}`)

    for (const name of ['regex.json', 'regex-sets.json', 'personas.json', 'persona.json', 'styles.json', 'blockwords.json', 'prompt-library.json']) await rootFile('lists', name)
    for (const rel of await walk(at('prompt-library'))) await add('lists', `prompt-library/${rel}`)

    const settings = await store.getSettings()
    if (settings.appearance?.backdrop && SEGMENT.test(settings.appearance.backdrop)) await rootFile('settings', `ui/${settings.appearance.backdrop}`)
    await rootFile('settings', 'model-context.json')

    const { archive, skipped } = exportProviders(await store.getProviders(), settings.model)
    for (const name of (await readdir(root).catch(() => [])).filter(name => /^comfy-workflow(-[\w-]+)?\.json$/.test(name)).sort()) await rootFile('providers', name)
    for (const name of KEY_FILES) await rootFile('keys', name)
    await rootFile('usage', 'usage.jsonl')
    return { files, items, settings, providers: archive, skippedProviders: skipped }
  }

  /** The export window's rows: { kinds: [{ key, files, bytes, count }], skippedProviders, keyNames }. */
  async function survey() {
    const { files, items, settings, providers, skippedProviders } = await plan()
    const count = {
      cards: items.cards.length,
      chats: items.chats.length,
      books: items.books.length,
      presets: items.presets.length,
      providers: providers.providers.length,
      keys: providers.providers.filter(p => p.apiKey).length + files.keys.length,
      history: files.history.length,
      lists: files.lists.length,
      settings: 1,
      usage: files.usage.length ? 1 : 0,
    }
    const kinds = CATEGORIES.map(key => ({
      key,
      files: files[key].length,
      bytes: files[key].reduce((sum, file) => sum + file.bytes, 0) + (key === 'settings' ? JSON.stringify(settings).length : 0),
      count: count[key] ?? 0,
    }))
    return { kinds, skippedProviders, defaultOff: [...DEFAULT_OFF] }
  }

  /** The settings that go with the ticked kinds, this device's own taken out. */
  function portableSettings(settings, picked) {
    const out = {}
    for (const [key, value] of Object.entries(settings)) {
      if (LOCAL_SETTINGS.has(key) || !picked.has(settingsKind(key))) continue
      out[key] = value
    }
    if (isRecord(out.media)) out.media = Object.fromEntries(Object.entries(out.media).filter(([key]) => !LOCAL_MEDIA.includes(key)))
    return out
  }

  /**
   * The zip of the ticked kinds, written through `write(buffer)` (a promise: the response drained). `signal` stops it
   * between files. → { bytes, entries, counts }.
   */
  async function exportTo(include, write, { signal } = {}) {
    const picked = cleanInclude(include)
    const { files, items, settings, providers, skippedProviders } = await plan()
    const zip = createZipWriter(write)
    const history = picked.has('history')
    const counts = {}
    const oldPictures = []
    const stopped = () => {
      if (signal?.aborted) throw Object.assign(new Error('export stopped'), { code: 'ABORTED' })
    }
    for (const kind of CATEGORIES) {
      if (!picked.has(kind) || kind === 'history' || kind === 'keys') continue
      counts[kind] = 0
      for (const file of files[kind]) {
        stopped()
        // A chat without its old pictures says so in its file too.
        if (file.strip && !history) {
          const chat = await readJsonOr(file.file, null)
          if (!chat) continue
          await zip.addBuffer(file.name, Buffer.from(JSON.stringify({ ...chat, nodes: withoutOldImages(chat.nodes) }, null, 1), 'utf8'))
        } else if ((await zip.addFile(file.name, file.file)) < 0) continue
        counts[kind]++
      }
    }
    // 抽图历史 only where its card or chat goes.
    if (history) {
      counts.history = 0
      for (const file of files.history) {
        stopped()
        const chat = file.name.startsWith('data/media/')
        const forge = file.name.startsWith('data/forge/')
        if (!(forge ? picked.has('cards') : chat ? picked.has('chats') : picked.has('cards'))) continue
        if ((await zip.addFile(file.name, file.file)) < 0) continue
        counts.history++
        // A chat's old pictures sit in its folder with the others: the import window tells them apart by this list.
        if (chat) oldPictures.push(file.name)
      }
    }
    if (picked.has('keys')) {
      counts.keys = 0
      for (const file of files.keys) if ((await zip.addFile(file.name, file.file)) >= 0) counts.keys++
    }
    if (picked.has('providers')) {
      const archive = picked.has('keys') ? providers : { ...providers, providers: providers.providers.map(keyless) }
      await zip.addBuffer('data/providers.json', Buffer.from(JSON.stringify(archive, null, 1), 'utf8'))
    }
    const portable = portableSettings(settings, picked)
    if (Object.keys(portable).length) await zip.addBuffer('data/settings.json', Buffer.from(JSON.stringify(portable, null, 1), 'utf8'))
    const manifest = {
      format: BACKUP_FORMAT,
      version: VERSION,
      app: version,
      edition,
      platform,
      exportedAt: new Date().toISOString(),
      include: CATEGORIES.filter(kind => picked.has(kind)),
      keys: picked.has('keys'),
      counts,
      oldPictures,
      skippedProviders: picked.has('providers') ? skippedProviders : [],
      items: {
        cards: picked.has('cards') ? items.cards : [],
        chats: picked.has('chats') ? items.chats : [],
        books: picked.has('books') ? items.books : [],
        presets: picked.has('presets') ? items.presets : [],
      },
    }
    await zip.addBuffer(BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 1), 'utf8'))
    const done = await zip.finish()
    return { ...done, counts }
  }

  // ─── Import ─────────────────────────────────────────────────────────

  /**
   * A zip's entries sorted into what they are; anything else is counted and left alone.
   * → { manifest, cards: Map(id → [entry, rel]), chats: Map(id → entry), media: Map(chatId → [entry, rel]), forge:
   *   Map(group → [entry, rel]), books, presets, presetScripts: Map(id → entry), library: [entry, file], ui: Map, root:
   *   Map(name → entry), unknown }
   */
  async function sortEntries(zip) {
    const manifestEntry = zip.entries.find(entry => entry.name === BACKUP_MANIFEST)
    if (!manifestEntry) throw Object.assign(new Error('not a backup'), { status: 400, code: 'NOT_BACKUP' })
    let manifest
    try {
      manifest = JSON.parse((await zip.read(manifestEntry, 16 * 1024 * 1024)).toString('utf8'))
    } catch {
      manifest = null
    }
    if (manifest?.format !== BACKUP_FORMAT) throw Object.assign(new Error('not a backup'), { status: 400, code: 'NOT_BACKUP' })
    if (!(manifest.version <= VERSION)) throw Object.assign(new Error('newer backup'), { status: 400, code: 'NEWER' })
    const out = { manifest, cards: new Map(), chats: new Map(), media: new Map(), forge: new Map(), books: new Map(), presets: new Map(), presetScripts: new Map(), library: [], ui: new Map(), root: new Map(), unknown: 0 }
    const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value])
    for (const entry of zip.entries) {
      if (entry === manifestEntry) continue
      const parts = entry.name.split('/')
      if (parts[0] !== 'data' || parts.length < 2 || !parts.slice(1).every(part => SEGMENT.test(part)) || JUNK.test(entry.name)) {
        out.unknown++
        continue
      }
      const [, top, ...rest] = parts
      const jsonId = name => (name?.endsWith('.json') && SAFE_ID.test(name.slice(0, -5)) ? name.slice(0, -5) : null)
      if (top === 'cards' && rest.length >= 2 && SAFE_ID.test(rest[0])) push(out.cards, rest[0], [entry, rest.slice(1).join('/')])
      else if (top === 'chats' && rest.length === 1 && jsonId(rest[0])) out.chats.set(jsonId(rest[0]), entry)
      else if (top === 'media' && rest.length >= 2 && SAFE_ID.test(rest[0]) && !['codex-work', 'tts'].includes(rest[0])) push(out.media, rest[0], [entry, rest.slice(1).join('/')])
      else if (top === 'forge' && rest.length >= 1) {
        // A draft's files share the name before the first dot: <id>.json, <id>.avatar, <id>.history/…; edits/ likewise.
        const inEdits = rest[0] === 'edits' && rest.length >= 2
        const head = (inEdits ? rest[1] : rest[0]).split('.')[0]
        if (!SAFE_ID.test(head)) out.unknown++
        else push(out.forge, `${inEdits ? 'edits/' : ''}${head}`, [entry, rest.join('/')])
      } else if (top === 'worldbooks' && rest.length === 1 && jsonId(rest[0])) out.books.set(jsonId(rest[0]), entry)
      else if (top === 'presets' && rest.length === 1 && jsonId(rest[0])) out.presets.set(jsonId(rest[0]), entry)
      else if (top === 'preset-scripts' && rest.length === 1 && jsonId(rest[0])) out.presetScripts.set(jsonId(rest[0]), entry)
      else if (top === 'prompt-library' && rest.length === 1) out.library.push([entry, rest[0]])
      else if (top === 'ui' && rest.length === 1 && /^backdrop-[\w.-]+$/.test(rest[0])) out.ui.set(rest[0], entry)
      else if (rest.length === 0) out.root.set(top, entry)
      else out.unknown++
    }
    return out
  }

  const readJsonEntry = async (zip, entry, most = 64 * 1024 * 1024) => JSON.parse((await zip.read(entry, most)).toString('utf8'))

  /** The import window's rows: what the zip holds by kind, and how many of each are here already. */
  async function inspect(file) {
    const zip = await openZipFile(file)
    try {
      const sorted = await sortEntries(zip)
      const { manifest } = sorted
      // 直接聊天's card is on every device: never one the player has to choose for.
      const here = {
        cards: [...sorted.cards.keys()].filter(id => id !== DIRECT_CARD && sorted.cards.get(id).some(([, rel]) => rel === 'card.json')),
        chats: [...sorted.chats.keys()],
        books: [...sorted.books.keys()],
        presets: [...sorted.presets.keys()],
      }
      const conflicts = {}
      conflicts.cards = (await Promise.all(here.cards.map(id => exists(at('cards', id, 'card.json'))))).filter(Boolean).length
        + (await Promise.all([...sorted.forge.keys()].map(group => exists(at('forge', `${group}.json`))))).filter(Boolean).length
      conflicts.chats = (await Promise.all(here.chats.map(id => exists(at('chats', `${id}.json`))))).filter(Boolean).length
      conflicts.books = (await Promise.all(here.books.map(id => exists(at('worldbooks', `${id}.json`))))).filter(Boolean).length
      conflicts.presets = (await Promise.all(here.presets.map(id => exists(at('presets', `${id}.json`))))).filter(Boolean).length
      const providersEntry = sorted.root.get('providers.json')
      const archive = providersEntry ? await readJsonEntry(zip, providersEntry).catch(() => null) : null
      const saved = await store.getProviders()
      const fileProviders = Array.isArray(archive?.providers) ? archive.providers : []
      conflicts.providers = fileProviders.filter(p => saved.some(s => s.id === p?.id)).length
      conflicts.keys = KEY_FILES.filter(name => sorted.root.has(name)).length
        ? (await Promise.all(KEY_FILES.filter(name => sorted.root.has(name)).map(name => exists(at(name))))).filter(Boolean).length
        : 0
      conflicts.lists = await listConflicts(zip, sorted)
      const settingsEntry = sorted.root.get('settings.json')
      const fileSettings = settingsEntry ? await readJsonEntry(zip, settingsEntry).catch(() => ({})) : {}
      const changed = await settingsChanged(fileSettings)
      conflicts.settings = changed.filter(key => settingsKind(key) === 'settings').length ? 1 : 0
      for (const kind of ['presets', 'books', 'providers']) if (changed.some(key => settingsKind(key) === kind)) conflicts[kind] = (conflicts[kind] ?? 0) + 1
      const bytes = {}
      const files = {}
      const old = new Set(Array.isArray(manifest.oldPictures) ? manifest.oldPictures : [])
      const kindOf = entry => {
        const name = entry.name
        if (name.startsWith('data/cards/')) return /^data\/cards\/[^/]+\/history(\.json|\/)/.test(name) ? 'history' : 'cards'
        if (name.startsWith('data/forge/')) return /\.history\//.test(name) ? 'history' : 'cards'
        if (old.has(name)) return 'history'
        if (name.startsWith('data/chats/') || name.startsWith('data/media/')) return 'chats'
        if (name.startsWith('data/worldbooks/')) return 'books'
        if (name.startsWith('data/presets/') || name.startsWith('data/preset-scripts/')) return 'presets'
        if (name.startsWith('data/prompt-library') || /^data\/(regex|regex-sets|personas|persona|styles|blockwords)\.json$/.test(name)) return 'lists'
        if (name.startsWith('data/ui/') || name === 'data/model-context.json') return 'settings'
        if (name === 'data/providers.json' || /^data\/comfy-workflow/.test(name)) return 'providers'
        if (KEY_FILES.some(key => name === `data/${key}`)) return 'keys'
        if (name === 'data/usage.jsonl') return 'usage'
        // settings.json holds the settings of every kind ticked: no kind of its own (the manifest says which came).
        return ''
      }
      for (const entry of zip.entries) {
        const kind = kindOf(entry)
        if (!kind) continue
        bytes[kind] = (bytes[kind] ?? 0) + entry.size
        files[kind] = (files[kind] ?? 0) + 1
      }
      const withKeys = fileProviders.filter(p => typeof p?.apiKey === 'string' && p.apiKey).map(p => String(p.name ?? p.id))
      const kinds = CATEGORIES.filter(kind => (manifest.include ?? []).includes(kind) || files[kind]).map(key => ({
        key,
        files: files[key] ?? 0,
        bytes: bytes[key] ?? 0,
        count: key === 'cards' ? manifest.items?.cards?.length ?? 0
          : key === 'chats' ? sorted.chats.size
            : key === 'books' ? sorted.books.size
              : key === 'presets' ? sorted.presets.size
                : key === 'providers' ? fileProviders.length
                  : key === 'keys' ? withKeys.length + KEY_FILES.filter(name => sorted.root.has(name)).length
                    : key === 'history' ? files.history ?? 0
                      : manifest.counts?.[key] ?? files[key] ?? 0,
        here: conflicts[key] ?? 0,
      }))
      return {
        from: { app: String(manifest.app ?? ''), edition: String(manifest.edition ?? ''), platform: String(manifest.platform ?? ''), exportedAt: String(manifest.exportedAt ?? '') },
        kinds,
        keys: { providers: withKeys, files: KEY_FILES.filter(name => sorted.root.has(name)) },
        unknown: sorted.unknown,
        size: zip.size,
      }
    } finally {
      await zip.close()
    }
  }

  /** How many list items (正则, 正则集, 人设, 文风, 提示词库) the zip has that are here already. */
  async function listConflicts(zip, sorted) {
    let n = 0
    const ids = value => new Set((Array.isArray(value) ? value : []).map(item => item?.id).filter(Boolean))
    const overlap = (a, b) => [...a].filter(id => b.has(id)).length
    const pairs = [
      ['regex.json', async () => ids(await store.getRegex()), value => ids(value?.scripts)],
      ['regex-sets.json', async () => ids(await store.getRegexSets()), value => ids(value?.sets)],
      ['prompt-library.json', async () => ids((await readJsonOr(at('prompt-library.json'), {})).entries), value => ids(value?.entries)],
    ]
    for (const [kind, name] of Object.entries(LIST_FILES)) {
      pairs.push([name, async () => ((await exists(at(name))) ? ids((await store.getList(kind)).items) : new Set()), value => ids(value?.items)])
    }
    for (const [name, local, inFile] of pairs) {
      const entry = sorted.root.get(name)
      if (!entry) continue
      const value = await readJsonEntry(zip, entry).catch(() => null)
      n += overlap(inFile(value), await local())
    }
    return n
  }

  /** The defaults as this device would have them: settings never saved here. */
  const defaults = () => createStore(path.join(root, 'backup-defaults-never-written'), storeOptions).getSettings()

  /** The settings in `incoming` that this device has changed from the default and the file has otherwise. */
  async function settingsChanged(incoming) {
    const [current, base] = await Promise.all([store.getSettings(), defaults()])
    return Object.keys(isRecord(incoming) ? incoming : {}).filter(key => !LOCAL_SETTINGS.has(key) && key in current && !same(current[key], base[key]) && !same(current[key], incoming[key]))
  }

  // One import at a time; its state for the page to ask after.
  let job = null

  /**
   * Merge the zip at `file` into this device. `include`: the kinds to take; `conflict`: 'keep' (what is here stays)
   * or 'replace' (the file's wins). Runs in the background; status() says how far. `done` is told the report.
   */
  function startImport(file, { include, conflict = 'keep' } = {}, { done = () => {} } = {}) {
    if (job?.state === 'running') throw Object.assign(new Error('busy'), { status: 409, code: 'BUSY' })
    const picked = cleanInclude(include)
    const replace = conflict === 'replace'
    job = { state: 'running', done: 0, total: 0, step: '', report: null, error: null, startedAt: Date.now() }
    const current = job
    ;(async () => {
      try {
        current.report = await runImport(file, picked, replace, current)
        current.state = 'done'
        await done(current.report)
      } catch (error) {
        current.state = 'failed'
        current.error = error.message
        current.code = error.code ?? ''
      }
    })()
    return status()
  }

  function status() {
    if (!job) return { state: 'idle' }
    const { state, done, total, step, report, error, code } = job
    return { state, done, total, step, report, error, code }
  }

  async function runImport(file, picked, replace, progress) {
    const zip = await openZipFile(file)
    const stage = at('backup-import', randomBytes(6).toString('hex'))
    const report = { added: {}, replaced: {}, kept: {}, failed: [], skipped: [] }
    const count = (bucket, kind, n = 1) => {
      report[bucket][kind] = (report[bucket][kind] ?? 0) + n
    }
    const fail = (kind, what, error) => report.failed.push({ kind, what: String(what), error: String(error?.message ?? error).slice(0, 300) })
    try {
      const sorted = await sortEntries(zip)
      const history = picked.has('history')
      const take = kind => picked.has(kind)
      progress.total = (take('cards') ? sorted.cards.size + sorted.forge.size : 0) + (take('chats') ? sorted.chats.size : 0) + (take('books') ? sorted.books.size : 0) + (take('presets') ? sorted.presets.size : 0) + 6
      const tick = step => {
        progress.done++
        if (step) progress.step = step
      }

      /** Write `files` ([entry, rel]) into a fresh folder, then put it at `target` (the old one gone when replacing). */
      const placeFolder = async (files, target) => {
        const temp = path.join(stage, path.basename(target) + '-' + randomBytes(3).toString('hex'))
        await mkdir(temp, { recursive: true })
        for (const [entry, rel] of files) {
          const dest = path.join(temp, ...rel.split('/'))
          if (path.relative(temp, dest).startsWith('..')) throw new Error(`bad path ${rel}`)
          await mkdir(path.dirname(dest), { recursive: true })
          await zip.copyTo(entry, dest)
        }
        await mkdir(path.dirname(target), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await rename(temp, target)
      }
      /** One file from the zip to `target`, through a file beside it. */
      const placeFile = async (entry, target) => {
        await mkdir(path.dirname(target), { recursive: true })
        const temp = `${target}.importing-${randomBytes(3).toString('hex')}`
        try {
          await zip.copyTo(entry, temp)
          await rm(target, { force: true })
          await rename(temp, target)
        } catch (error) {
          await rm(temp, { force: true }).catch(() => {})
          throw error
        }
      }
      const jsonOf = entry => readJsonEntry(zip, entry)

      // 世界书 and 预设 first: the cards and chats coming after point at them.
      if (take('books')) {
        progress.step = 'books'
        for (const [id, entry] of sorted.books) {
          try {
            const book = await jsonOf(entry)
            // The list sorts by these: one without them would break the whole list here.
            if (!isRecord(book) || typeof book.name !== 'string') throw new Error('not a book')
            const target = at('worldbooks', `${id}.json`)
            const here = await exists(target)
            if (here && !replace) count('kept', 'books')
            else {
              await writeJson(target, { ...book, id })
              count(here ? 'replaced' : 'added', 'books')
            }
          } catch (error) {
            fail('books', id, error)
          }
          tick()
        }
      }
      if (take('presets')) {
        progress.step = 'presets'
        for (const [id, entry] of sorted.presets) {
          try {
            const preset = await jsonOf(entry)
            if (!isRecord(preset) || typeof preset.importedAt !== 'string') throw new Error('not a preset')
            const target = at('presets', `${id}.json`)
            const here = await exists(target)
            if (here && !replace) count('kept', 'presets')
            else {
              await writeJson(target, { ...preset, id })
              const scripts = sorted.presetScripts.get(id)
              await rm(at('preset-scripts', `${id}.json`), { force: true })
              if (scripts) await writeJson(at('preset-scripts', `${id}.json`), await jsonOf(scripts))
              count(here ? 'replaced' : 'added', 'presets')
            }
          } catch (error) {
            fail('presets', id, error)
          }
          tick()
        }
      }

      if (take('lists')) {
        progress.step = 'lists'
        await mergeLists(zip, sorted, replace, { count, fail, placeFile })
        tick()
      }

      if (take('providers')) {
        progress.step = 'providers'
        try {
          const entry = sorted.root.get('providers.json')
          if (entry) {
            const archive = await jsonOf(entry)
            const saved = await store.getProviders()
            const incoming = (Array.isArray(archive?.providers) ? archive.providers : [])
              .filter(p => replace || !saved.some(s => s.id === p?.id))
              // Keys only when 密钥 was ticked, whatever the file has.
              .map(p => (picked.has('keys') ? p : keyless(p)))
            const kept = (Array.isArray(archive?.providers) ? archive.providers.length : 0) - incoming.length
            if (kept) count('kept', 'providers', kept)
            if (incoming.length && archive?.format === PROVIDERS_FORMAT) {
              const merged = importProviders(saved, { ...archive, providers: incoming })
              await store.saveProviders(merged.list)
              if (merged.added.length) count('added', 'providers', merged.added.length)
              if (merged.updated.length) count('replaced', 'providers', merged.updated.length)
              for (const failed of merged.failed) fail('providers', failed, '')
              if (merged.keyless.length) report.keyless = merged.keyless
            }
          }
          for (const [name, entry] of sorted.root) {
            if (!/^comfy-workflow(-[\w-]+)?\.json$/.test(name)) continue
            const here = await exists(at(name))
            if (here && !replace) continue
            await placeFile(entry, at(name))
          }
        } catch (error) {
          fail('providers', 'providers.json', error)
        }
        tick()
      }
      if (take('keys')) {
        for (const name of KEY_FILES) {
          const entry = sorted.root.get(name)
          if (!entry) continue
          try {
            const here = await exists(at(name))
            if (here && !replace) count('kept', 'keys')
            else {
              JSON.parse((await zip.read(entry, 1024 * 1024)).toString('utf8'))
              await placeFile(entry, at(name))
              count(here ? 'replaced' : 'added', 'keys')
            }
          } catch (error) {
            fail('keys', name, error)
          }
        }
      }

      // 角色卡: each folder whole. The 抽图历史 in it only when ticked.
      if (take('cards')) {
        for (const [id, files] of sorted.cards) {
          progress.step = 'cards'
          try {
            const own = files.filter(([, rel]) => history || !(rel === 'history.json' || rel.startsWith('history/')))
            const cardEntry = own.find(([, rel]) => rel === 'card.json')?.[0]
            if (!cardEntry) throw new Error('no card.json')
            const card = await jsonOf(cardEntry)
            if (!isRecord(card) || card.id !== id || typeof card.importedAt !== 'string') throw new Error('card.json does not match its folder')
            const target = at('cards', id)
            const here = await exists(path.join(target, 'card.json'))
            // 直接聊天's card is on every device: taken or not as asked, never counted as a card.
            const counted = id !== DIRECT_CARD
            if (here && !replace) {
              if (counted) count('kept', 'cards')
            } else {
              await placeFolder(own, target)
              if (counted) count(here ? 'replaced' : 'added', 'cards')
            }
          } catch (error) {
            fail('cards', id, error)
          }
          tick()
        }
        for (const [group, files] of sorted.forge) {
          try {
            const own = files.filter(([, rel]) => history || !/\.history\//.test(rel))
            const main = own.find(([, rel]) => rel === `${group}.json`)
            const here = await exists(at('forge', `${group}.json`))
            if (here && !replace) count('kept', 'drafts')
            else {
              if (main) JSON.parse((await zip.read(main[0])).toString('utf8'))
              const base = path.basename(group)
              // The draft's own files and folder (<id>.history/), none of the others in forge/.
              const folder = path.dirname(at('forge', ...group.split('/')))
              for (const name of await readdir(folder).catch(() => [])) {
                if (name === `${base}.json` || name.startsWith(`${base}.`)) await rm(path.join(folder, name), { recursive: true, force: true })
              }
              for (const [entry, rel] of own) await placeFile(entry, at('forge', ...rel.split('/')))
              count(here ? 'replaced' : 'added', 'drafts')
            }
          } catch (error) {
            fail('cards', group, error)
          }
          tick()
        }
        await mergeOrders(zip, sorted, replace)
      }

      const cardIds = new Set([DIRECT_CARD, ...(await readdir(store.dirs.cards).catch(() => [])).filter(name => SAFE_ID.test(name))])
      const bookIds = new Set((await readdir(store.dirs.books).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)))
      const presetIds = new Set((await readdir(store.dirs.presets).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)))

      // The books a card mounts that this device has none of are let go of (they would be looked for every turn).
      if (take('cards')) {
        for (const id of sorted.cards.keys()) {
          const file = at('cards', id, 'card.json')
          const card = await readJsonOr(file, null)
          if (!Array.isArray(card?.worldbookIds)) continue
          const kept = card.worldbookIds.filter(bookId => bookIds.has(bookId))
          if (kept.length !== card.worldbookIds.length) await writeJson(file, { ...card, worldbookIds: kept })
        }
      }

      // 对话: each chat and its pictures; one whose card is on neither side is left out.
      if (take('chats')) {
        progress.step = 'chats'
        for (const [id, entry] of sorted.chats) {
          try {
            let chat = await jsonOf(entry)
            if (!isRecord(chat) || !isRecord(chat.nodes) || (chat.id && chat.id !== id) || typeof chat.updatedAt !== 'string') throw new Error('not a chat')
            if (!cardIds.has(String(chat.cardId))) {
              report.skipped.push({ kind: 'chats', what: String(chat.title || id), reason: 'no-card' })
              tick()
              continue
            }
            const target = at('chats', `${id}.json`)
            const here = await exists(target)
            if (here && !replace) {
              count('kept', 'chats')
              tick()
              continue
            }
            const old = new Set(history ? [] : oldImageFiles(chat))
            if (!history) chat = { ...chat, nodes: withoutOldImages(chat.nodes) }
            // What it points at that this device does not have: let go of, as when a preset or book is deleted.
            if (chat.presetId && !isBuiltinPreset(chat.presetId) && !presetIds.has(chat.presetId)) chat.presetId = null
            if (Array.isArray(chat.bookIds)) chat.bookIds = chat.bookIds.filter(bookId => bookIds.has(bookId))
            const pictures = (sorted.media.get(id) ?? []).filter(([, rel]) => !old.has(rel))
            await store.withChat(id, async () => {
              if (pictures.length || replace) {
                if (pictures.length) await placeFolder(pictures, at('media', id))
                else await rm(at('media', id), { recursive: true, force: true })
              }
              await writeJson(target, { ...chat, id })
            })
            count(here ? 'replaced' : 'added', 'chats')
          } catch (error) {
            fail('chats', id, error)
          }
          tick()
        }
      }

      if (take('settings') || take('presets') || take('books') || take('providers')) {
        progress.step = 'settings'
        try {
          await mergeSettings(zip, sorted, picked, replace, { bookIds, presetIds, placeFile, count })
        } catch (error) {
          fail('settings', 'settings.json', error)
        }
        tick()
      }
      if (take('settings')) {
        const entry = sorted.root.get('model-context.json')
        if (entry) {
          try {
            const heard = await jsonOf(entry)
            if (isRecord(heard)) {
              const local = await store.getModelContext()
              await store.learnModelContext(replace ? heard : Object.fromEntries(Object.entries(heard).filter(([key]) => !(key in local))))
            }
          } catch (error) {
            fail('settings', 'model-context.json', error)
          }
        }
      }
      if (take('usage')) {
        const entry = sorted.root.get('usage.jsonl')
        if (entry) {
          try {
            const lines = (await zip.read(entry, 256 * 1024 * 1024)).toString('utf8').split('\n').filter(line => line.trim())
            const file = at('usage.jsonl')
            const local = await readFile(file, 'utf8').catch(() => '')
            const have = new Set(local.split('\n'))
            const fresh = lines.filter(line => !have.has(line))
            if (fresh.length) await writeFile(file, `${local && !local.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`, { flag: 'a' })
            count('added', 'usage', fresh.length)
          } catch (error) {
            fail('usage', 'usage.jsonl', error)
          }
        }
        tick()
      }
      progress.done = progress.total
      return report
    } finally {
      await zip.close().catch(() => {})
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      await rmdir(at('backup-import')).catch(() => {})
    }
  }

  /** 正则, 正则集, 你的角色, 文风, 屏蔽词, 提示词库: item by item, by id. */
  async function mergeLists(zip, sorted, replace, { count, fail, placeFile }) {
    const read = async name => {
      const entry = sorted.root.get(name)
      return entry ? readJsonEntry(zip, entry).catch(error => {
        fail('lists', name, error)
        return null
      }) : null
    }
    /** `incoming` merged into `local` by id: new ones added, ones here kept or replaced. */
    const byId = (local, incoming, kind) => {
      const out = [...local]
      for (const item of incoming) {
        if (!isRecord(item)) continue
        const index = item.id ? out.findIndex(have => have?.id === item.id) : out.findIndex(have => same(have, item))
        if (index < 0) {
          out.push(item)
          count('added', kind)
        } else if (replace && !same(out[index], item)) {
          out[index] = item
          count('replaced', kind)
        } else count('kept', kind)
      }
      return out
    }
    const regex = await read('regex.json')
    if (Array.isArray(regex?.scripts)) await store.saveRegex(byId(await store.getRegex(), regex.scripts, 'regex'))
    const sets = await read('regex-sets.json')
    if (Array.isArray(sets?.sets)) await store.updateRegexSets(local => byId(local, sets.sets, 'regexSets'))
    for (const [kind, name] of Object.entries(LIST_FILES)) {
      const value = await read(name)
      if (!Array.isArray(value?.items)) continue
      const savedBefore = await exists(at(name))
      await store.updateList(kind, local => {
        const incoming = cleanList(kind, value)
        // Never set up here (only the item made from the old single setting): the file's list as it is.
        if (!savedBefore) {
          count('added', kind === 'persona' ? 'personas' : 'styles', incoming.items.length)
          return incoming
        }
        const items = byId(local.items, incoming.items, kind === 'persona' ? 'personas' : 'styles')
        const cards = replace ? { ...local.cards, ...incoming.cards } : { ...incoming.cards, ...local.cards }
        return { defaultId: local.defaultId, items, cards }
      })
    }
    const legacy = sorted.root.get('persona.json')
    if (legacy && !(await exists(at('persona.json'))) && !(await exists(at('personas.json')))) await placeFile(legacy, at('persona.json'))
    const words = await read('blockwords.json')
    if (Array.isArray(words?.words)) await store.saveBlockWords(byId(await store.getBlockWords(), words.words, 'blockwords'))
    const library = await read('prompt-library.json')
    if (Array.isArray(library?.entries)) {
      const file = at('prompt-library.json')
      const local = await readJsonOr(file, null)
      const entries = byId(Array.isArray(local?.entries) ? local.entries : [], library.entries, 'prompts')
      // The pictures saved with the library: each the file of an entry that is now the file's.
      const wanted = new Set(entries.map(entry => entry?.own).filter(Boolean))
      for (const [entry, name] of sorted.library) {
        if (!wanted.has(name)) continue
        const target = at('prompt-library', name)
        if ((await exists(target)) && !replace) continue
        await placeFile(entry, target)
      }
      await writeJson(file, { ...(isRecord(local) ? local : {}), entries })
    }
  }

  /** 拖拽排序 and 分组 order, and which cards may call the model from scripts. */
  async function mergeOrders(zip, sorted, replace) {
    const read = async name => (sorted.root.get(name) ? readJsonEntry(zip, sorted.root.get(name)).catch(() => null) : null)
    const order = await read('card-order.json')
    if (Array.isArray(order?.ids)) {
      const local = await store.getCardOrder()
      await store.saveCardOrder(local.length ? [...local, ...order.ids.filter(id => !local.includes(id))] : order.ids)
    }
    const groups = await read('group-order.json')
    if (Array.isArray(groups?.names)) {
      const local = await store.getGroupOrder()
      await store.saveGroupOrder([...local, ...groups.names.filter(name => !local.includes(name))])
    }
    const permissions = await read('script-permissions.json')
    if (isRecord(permissions)) {
      const file = at('script-permissions.json')
      const local = await readJsonOr(file, {})
      await writeFile(file, JSON.stringify(replace ? { ...local, ...permissions } : { ...permissions, ...(isRecord(local) ? local : {}) }))
    }
  }

  /**
   * The file's settings for the ticked kinds: on this device's defaults, or over what it has when replacing. Books
   * and presets this device does not have are let go of. The background picture comes with 外观.
   */
  async function mergeSettings(zip, sorted, picked, replace, { bookIds, presetIds, placeFile, count }) {
    const entry = sorted.root.get('settings.json')
    if (!entry) return
    const incoming = await readJsonEntry(zip, entry)
    if (!isRecord(incoming)) return
    const [current, base] = await Promise.all([store.getSettings(), defaults()])
    const patch = {}
    for (const [key, value] of Object.entries(incoming)) {
      if (LOCAL_SETTINGS.has(key) || !(key in current) || !picked.has(settingsKind(key))) continue
      if (!replace && !same(current[key], base[key])) continue
      if (same(current[key], value)) continue
      patch[key] = value
    }
    if (isRecord(patch.media)) {
      // This device's own addresses stay; a value this build would refuse leaves the 配图 and 朗读 settings as they are.
      const local = Object.fromEntries(LOCAL_MEDIA.filter(key => current.media?.[key] !== undefined).map(key => [key, current.media[key]]))
      patch.media = { ...current.media, ...patch.media, ...local }
      try {
        cleanMedia(patch.media)
      } catch {
        delete patch.media
      }
    } else delete patch.media
    if (Array.isArray(patch.globalBookIds)) patch.globalBookIds = [...new Set([...(replace ? [] : current.globalBookIds), ...patch.globalBookIds])].filter(id => bookIds.has(id))
    if (typeof patch.presetId === 'string' && patch.presetId && !isBuiltinPreset(patch.presetId) && !presetIds.has(patch.presetId)) delete patch.presetId
    let backdrop
    if (isRecord(patch.appearance)) {
      const name = patch.appearance.backdrop
      const picture = name ? sorted.ui.get(name) : null
      if (picture) {
        await placeFile(picture, at('ui', name))
        backdrop = name
      } else backdrop = current.appearance?.backdrop ?? ''
    }
    if (!Object.keys(patch).length) return
    await store.saveSettings(patch, backdrop === undefined ? {} : { backdrop })
    count(replace ? 'replaced' : 'added', 'settings', Object.keys(patch).length)
  }

  return { survey, exportTo, inspect, startImport, status }
}

/** A name for the zip: CicaTavern-backup-20261118-2130.zip. */
export function backupName(when = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `CicaTavern-backup-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}.zip`
}
