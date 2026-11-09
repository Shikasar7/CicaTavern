// A card's Tavern Helper scripts that follow the story's variables (helper-scripts.mjs, kind 'hooks'), run on the
// server as MVU runs them in SillyTavern: at a chat's start (VARIABLE_INITIALIZED), and around each reply's update
// (VARIABLE_UPDATE_STARTED, COMMAND_PARSED with the commands they may change, VARIABLE_UPDATE_ENDED with the new
// variables they may change, BEFORE_MESSAGE_UPDATE, then MESSAGE_RECEIVED and GENERATION_ENDED). A card frame's event of
// the card's own (web/compat.js eventEmit) reaches them too (emit). So they work the same on the computer, the phone and
// in the visual novel, with no page open.
//
// Each card with such scripts gets one QuickJS sandbox, each script a context of its own in it (its own globals, as
// each has its own frame in SillyTavern): no network, no files, no host objects; Tavern Helper's functions and MVU's
// work on copies the server hands in and reads back (variables, the latest floors, the chat's books as this chat
// changes them, the script's localStorage kept per chat). What a sandbox cannot do (call the model, change the chat's
// messages, SillyTavern's page) is refused or left undone, as a missing feature, never a crash. A script that fails
// is left out for the rest of the run and named in the error log; the turn goes on without it.
//
// A card without such scripts costs nothing: its list says so (card.helperList), and no file is read.
import { readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import { sandboxEngine } from './template.mjs'
import { createZ } from './schema-z.mjs'
import { createLodash } from './sandbox-lodash.mjs'
import { helperScriptsOf } from './schema.mjs'
import { helperSummary } from './helper-scripts.mjs'
import { rawOfPicture } from './cards.mjs'
import { applyCommands, applyStateUpdates, readUpdates } from './state.mjs'
import { bookByName, bookNames, chatBooks, thEntry, withChatChanges, writeChatBook } from './frames.mjs'
import { injectPrompts, uninjectPrompts } from './injections.mjs'
import { IFRAME_EVENTS, MVU_EVENTS, TAVERN_EVENTS, isHostEvent, olderLorebooks } from '../web/shared/th-api.js'

export { MVU_EVENTS, TAVERN_EVENTS }

// An event a page script listens for by name: eventOn('x'), eventOn(getButtonEvent('x')), eventOnButton('x').
const LISTENED = /\b(?:eventOn|eventOnce|eventMakeFirst|eventMakeLast|eventOnButton)\(\s*(?:getButtonEvent\(\s*)?(['"`])([^'"`$\n]{1,60})\1/g
// A whole card's scripts at most (bundles carry Zod and lodash: a big card's three came to 1.3 MB).
const MAX_SOURCE = 4_000_000
const MEMORY_LIMIT = 256 * 1024 * 1024
// A big card's guard takes 0.7 s of its own work in V8 and 2.8 s here; a phone is slower still.
const LOAD_MS = 20_000
// Tests set a shorter one (CARD_SCRIPTS_FIRE_MS) to see a script that never ends cut off.
const FIRE_MS = Number(process.env.CARD_SCRIPTS_FIRE_MS) || 20_000
const IDLE_MS = 5 * 60_000
// Sandboxes kept warm at once: a card switched back to does not load again.
const WARM_MAX = 2
// The floors a script sees, and the newest of them with their variables (older ones as text only).
const FLOORS = 40
const FLOORS_WITH_DATA = 6
// What a chat keeps for its scripts (their localStorage and script variables), at most.
const STORAGE_MAX = 200_000
const MVU_KEYS = ['stat_data', 'display_data', 'delta_data', 'initialized_lorebooks', 'schema']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const mvuData = state => ({ stat_data: structuredClone(state ?? {}), display_data: structuredClone(state ?? {}), delta_data: {}, initialized_lorebooks: {} })

/** The story state in what a script left as the variables: MVU's stat_data, else its plain keys. */
function stateOf(data, before) {
  if (!isObject(data)) return before
  if (isObject(data.stat_data)) return data.stat_data
  const plain = Object.fromEntries(Object.entries(data).filter(([key]) => !MVU_KEYS.includes(key)))
  return Object.keys(plain).length ? plain : before
}

let report = () => {}

/** `fn(script, message)` when a card's script cannot load or fails (the error log, server/http.mjs). */
export function onCardScriptProblem(fn) {
  report = fn
}

/** A card's scripts that run here, from its file's extensions: [{ name, content }], the author's enabled ones. */
export function hookScriptsOf(extensions) {
  const scripts = helperScriptsOf(extensions)
  const kinds = helperSummary(scripts)
  let room = MAX_SOURCE
  return scripts
    .map((script, i) => ({ script, info: kinds[i] }))
    .filter(({ script, info }) => info?.kind === 'hooks' && info.on && typeof script.content === 'string')
    .filter(({ script }) => (room -= script.content.length) >= 0)
    .map(({ script, info }) => ({ name: info.name || 'script', content: script.content }))
}

/**
 * A card's scripts for the page and the 脚本按钮 in a card's file's extensions: { page: [{ name, content, remote, buttons,
 * events }], server: [{ script, name }] }. Every enabled script that does not run here goes to the page, which starts
 * them all when the chat opens, as SillyTavern does (web/card-scripts.js).
 */
function buttonsFrom(extensions) {
  const scripts = helperScriptsOf(extensions)
  const kinds = helperSummary(scripts)
  const value = { page: [], server: [] }
  scripts.forEach((script, i) => {
    const info = kinds[i]
    if (!info?.on) return
    if (info.kind === 'hooks') value.server.push(...info.buttons.map(name => ({ script: info.name, name })))
    else if (info.kind === 'custom' && typeof script.content === 'string' && script.content.length <= MAX_SOURCE) {
      // The names it listens for, as written in its code: a button hidden from the bar, an event a card's frame emits.
      const events = [...new Set([...script.content.matchAll(LISTENED)].map(match => match[2]).filter(name => !isHostEvent(name)))]
      value.page.push({ name: info.name, content: script.content, remote: info.remote === true, buttons: info.buttons, events })
    }
  })
  return value
}

// ─── Inside the sandbox ─────────────────────────────────────────────────
// Put in as source text before each script: it uses nothing from outside itself but `__host` (hostCall below).
function sandboxSide() {
  const g = globalThis
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  // A call the server answers later (the model): a promise of its value.
  const hostLater = (op, data) => g.__hostAsync(op, JSON.stringify(data === undefined ? null : data)).then(text => {
    const answer = JSON.parse(text)
    if (answer && answer.error) throw new Error(answer.error)
    return answer ? answer.value : undefined
  })
  const host = (op, data) => {
    const answer = JSON.parse(g.__host(op, JSON.stringify(data === undefined ? null : data)))
    if (answer && answer.error) throw new Error(answer.error)
    return answer ? answer.value : undefined
  }
  const errors = []
  const say = (level, args) => {
    const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'object' ? (() => { try { return JSON.stringify(a) } catch { return String(a) } })() : String(a))).join(' ')
    if (level === 'error') errors.push(text.slice(0, 300))
  }
  g.console = { log() {}, info() {}, debug() {}, trace() {}, group() {}, groupEnd() {}, groupCollapsed() {}, table() {}, warn: (...a) => say('warn', a), error: (...a) => say('error', a) }
  g.structuredClone = value => clone(value)
  g.queueMicrotask = fn => Promise.resolve().then(fn)
  g.window = g
  g.self = g
  g.parent = g
  g.top = g
  g.globalThis = g

  // Timers run on a clock of their own: what a listener puts off a little (a debounce, a "next tick") runs before the
  // event is over; what it puts off further does not run.
  let now = 0
  let nextId = 0
  const timers = []
  g.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++nextId
    timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn, args })
    return id
  }
  g.clearTimeout = id => {
    const at = timers.findIndex(t => t.id === id)
    if (at >= 0) timers.splice(at, 1)
  }
  g.setInterval = () => ++nextId
  g.clearInterval = () => {}
  g.requestAnimationFrame = fn => g.setTimeout(fn, 16)
  g.cancelAnimationFrame = id => g.clearTimeout(id)
  let fireStart = 0
  g.__tick = () => {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at - fireStart > 3000) return false
    timers.shift()
    now = Math.max(now, next.at)
    try {
      if (typeof next.fn === 'function') next.fn(...next.args)
    } catch (error) {
      errors.push(String(error && error.message || error).slice(0, 300))
    }
    return true
  }

  // jQuery: only `$(fn)` (run it now) means anything here; the rest is a chain that does nothing.
  const inert = new Proxy(function () {}, { get: (_t, name) => (name === 'length' ? 0 : name === 'then' || typeof name === 'symbol' ? undefined : inert), apply: () => inert })
  g.$ = (what, ...rest) => {
    if (typeof what === 'function') {
      try {
        const result = what()
        if (result && typeof result.catch === 'function') result.catch(error => errors.push(String(error && error.message || error).slice(0, 300)))
      } catch (error) {
        errors.push(String(error && error.message || error).slice(0, 300))
      }
      return inert
    }
    return inert
  }
  g.jQuery = g.$

  // ── What one event hands in (set by __fire) ──
  let current = { stat_data: {}, display_data: {}, delta_data: {}, initialized_lorebooks: {} }
  let messages = []
  let lastId = 0
  let chatVars = {}
  let globalVars = {}
  let storage = { local: {}, vars: {} }
  let names = { user: '', char: '' }
  let books = { own: '', mounted: [], global: [], chat: [] }
  let chatId = ''

  const makeStorage = bucket => ({
    get length() {
      return Object.keys(storage[bucket]).length
    },
    key: i => Object.keys(storage[bucket])[i] ?? null,
    getItem: key => (Object.prototype.hasOwnProperty.call(storage[bucket], String(key)) ? storage[bucket][String(key)] : null),
    setItem: (key, value) => {
      storage[bucket][String(key)] = String(value)
    },
    removeItem: key => {
      delete storage[bucket][String(key)]
    },
    clear: () => {
      storage[bucket] = {}
    },
  })
  g.localStorage = makeStorage('local')
  g.sessionStorage = makeStorage('local')

  // ── Events: one bus for every script of the card is the server's; here, this script's listeners ──
  const listeners = {}
  g.__listeners = listeners
  const on = (type, fn, first = false) => {
    if (typeof fn !== 'function') return { stop() {} }
    const list = (listeners[String(type)] ||= [])
    if (!list.includes(fn)) first ? list.unshift(fn) : list.push(fn)
    return { stop: () => off(type, fn) }
  }
  const off = (type, fn) => {
    const list = listeners[String(type)]
    if (list) listeners[String(type)] = list.filter(f => f !== fn && f.__of !== fn)
  }
  const once = (type, fn) => {
    const wrapped = (...args) => {
      off(type, wrapped)
      return fn(...args)
    }
    wrapped.__of = fn
    return on(type, wrapped)
  }
  // An event a script emits itself: its own listeners hear it now (another script's, the next time the server fires it).
  const emit = async (type, ...args) => {
    for (const fn of [...(listeners[String(type)] || [])]) await fn(...args)
  }

  // ── Variables ──
  const messageIndex = id => {
    if (id === undefined || id === null || id === 'latest' || id === -1 || id === '-1') return lastId
    const n = Number(id)
    return Number.isInteger(n) ? (n < 0 ? lastId + 1 + n : n) : lastId
  }
  const floor = id => messages.find(m => m.message_id === messageIndex(id))
  const merge = (into, from) => {
    for (const key of Object.keys(from || {})) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (isObj(into[key]) && isObj(from[key])) merge(into[key], from[key])
      else into[key] = clone(from[key])
    }
    return into
  }
  const chatShape = () => merge(clone(chatVars), { stat_data: clone(current.stat_data || {}) })
  const getVariables = (option = {}) => {
    const type = option && option.type ? option.type : 'chat'
    if (type === 'message') {
      const at = messageIndex(option.message_id)
      return at === lastId ? current : clone(floor(at)?.data || {})
    }
    if (type === 'chat') return chatShape()
    if (type === 'global') return clone(globalVars)
    if (type === 'script') return clone(storage.vars)
    return {}
  }
  // The latest floor's variables are replaced in place: an event's own argument is that same object.
  const setCurrent = data => {
    const next = isObj(data) && isObj(data.stat_data) ? clone(data) : { ...clone(current), stat_data: clone(Object.fromEntries(Object.entries(data || {}).filter(([k]) => !['stat_data', 'display_data', 'delta_data', 'initialized_lorebooks', 'schema'].includes(k)))) }
    for (const key of Object.keys(current)) delete current[key]
    Object.assign(current, next)
  }
  const replaceVariables = (variables, option = {}) => {
    const type = option && option.type ? option.type : 'chat'
    if (type === 'message') {
      if (messageIndex(option.message_id) === lastId) setCurrent(variables)
      return
    }
    if (type === 'chat') {
      const value = isObj(variables) ? variables : {}
      if (isObj(value.stat_data) && JSON.stringify(value.stat_data) !== JSON.stringify(current.stat_data)) setCurrent({ ...current, stat_data: value.stat_data })
      chatVars = clone(Object.fromEntries(Object.entries(value).filter(([k]) => !['stat_data', 'display_data', 'delta_data', 'initialized_lorebooks', 'schema'].includes(k))))
      return
    }
    if (type === 'global') globalVars = clone(isObj(variables) ? variables : {})
    else if (type === 'script') storage.vars = clone(isObj(variables) ? variables : {})
  }
  const updateVariablesWith = (fn, option = {}) => {
    const variables = (option && option.type === 'message' && messageIndex(option.message_id) === lastId) ? clone(current) : getVariables(option)
    const result = fn(variables)
    const done = value => {
      replaceVariables(value === undefined ? variables : value, option)
      return getVariables(option)
    }
    return result && typeof result.then === 'function' ? result.then(done) : done(result)
  }
  const pathKeys = p => (Array.isArray(p) ? p.map(String) : String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean))
  g.getVariables = getVariables
  g.replaceVariables = replaceVariables
  g.updateVariablesWith = updateVariablesWith
  g.insertOrAssignVariables = (variables, option) => updateVariablesWith(v => merge(v, variables), option)
  g.insertVariables = (variables, option) => updateVariablesWith(v => {
    const add = (into, from) => {
      for (const key of Object.keys(from || {})) {
        if (into[key] === undefined) into[key] = clone(from[key])
        else if (isObj(into[key]) && isObj(from[key])) add(into[key], from[key])
      }
    }
    add(v, variables)
    return v
  }, option)
  g.deleteVariable = (path, option) => {
    let found = false
    updateVariablesWith(v => {
      const keys = pathKeys(path)
      const parent = keys.slice(0, -1).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), v)
      if (parent && typeof parent === 'object' && keys.length && Object.prototype.hasOwnProperty.call(parent, keys.at(-1))) {
        delete parent[keys.at(-1)]
        found = true
      }
      return v
    }, option)
    return { variables: getVariables(option), delete_occurred: found }
  }
  g.getAllVariables = () => merge(merge(clone(globalVars), chatShape()), clone(current))
  g.registerVariableSchema = () => {}

  // ── The chat: the latest floors, read only; the one being written is the last ──
  const stMessage = m => ({ name: m.name, is_user: m.role === 'user', is_system: false, mes: m.message, swipe_id: 0, swipes: [m.message], extra: {}, variables: [m.message_id === lastId ? current : m.data || {}] })
  const chatMessage = m => ({
    message_id: m.message_id, name: m.name, role: m.role, is_hidden: false, message: m.message,
    data: m.message_id === lastId ? current : clone(m.data || {}), extra: {},
    swipe_id: 0, swipes: [m.message], swipes_data: [m.message_id === lastId ? current : clone(m.data || {})], swipes_info: [{}],
  })
  g.getChatMessages = (range = 'latest', option = {}) => {
    let from = lastId
    let to = lastId
    if (typeof range === 'number') from = to = messageIndex(range)
    else if (typeof range === 'string' && /^-?\d+\s*-\s*-?\d+$/.test(range.trim())) {
      const [a, b] = range.split(/(?<=\d)\s*-\s*/).map(n => messageIndex(Number(n)))
      from = Math.min(a, b)
      to = Math.max(a, b)
    } else if (typeof range === 'string' && /^-?\d+$/.test(range.trim())) from = to = messageIndex(Number(range))
    const role = option && option.role && option.role !== 'all' ? option.role : null
    return messages.filter(m => m.message_id >= from && m.message_id <= to && (!role || m.role === role)).map(chatMessage)
  }
  g.getLastMessageId = () => lastId
  g.getCurrentMessageId = () => lastId
  g.getMessageId = () => lastId
  // Changing the chat's messages is not done here: a script's own variables on the latest floor are.
  g.setChatMessages = async list => {
    for (const item of Array.isArray(list) ? list : []) {
      if (item && isObj(item.data) && messageIndex(item.message_id) === lastId) setCurrent(item.data)
    }
  }
  g.setChatMessage = async (values, id) => g.setChatMessages([{ ...(typeof values === 'string' ? {} : values || {}), message_id: id }])
  g.createChatMessages = async () => {
    throw new Error('这里不能新建聊天消息')
  }
  g.deleteChatMessages = async () => {
    throw new Error('这里不能删除聊天消息')
  }
  g.rotateChatMessages = g.deleteChatMessages
  g.refreshOneMessage = async () => {}
  g.formatAsDisplayedMessage = text => String(text ?? '')
  // A script's own macros (registerMacroLike): over each turn's message (__applyMacros), and in substitudeMacros.
  const macroLikes = []
  const applyMacroLikes = (text, context) => {
    let out = String(text ?? '')
    for (const macro of macroLikes) {
      const regex = new RegExp(macro.regex.source, macro.regex.flags.includes('g') ? macro.regex.flags : `${macro.regex.flags}g`)
      out = out.replace(regex, (...found) => {
        try {
          return String(macro.replace(context, ...found))
        } catch (error) {
          errors.push(String(error && error.message || error).slice(0, 300))
          return found[0]
        }
      })
    }
    return out
  }
  g.registerMacroLike = (regex, replace) => {
    if (!(regex instanceof RegExp) || typeof replace !== 'function') return { unregister() {} }
    g.unregisterMacroLike(regex)
    macroLikes.push({ regex, replace })
    return { unregister: () => g.unregisterMacroLike(regex) }
  }
  g.unregisterMacroLike = regex => {
    const at = macroLikes.findIndex(macro => macro.regex === regex || String(macro.regex) === String(regex))
    if (at >= 0) macroLikes.splice(at, 1)
  }
  g.__macroCount = () => macroLikes.length
  g.__applyMacros = () => {
    const payload = JSON.parse(g.__payload)
    return JSON.stringify(applyMacroLikes(payload.text, { message_id: payload.messageId, role: payload.role }))
  }
  g.substitudeMacros = text => applyMacroLikes(String(text ?? '').replace(/\{\{user\}\}/gi, names.user).replace(/\{\{char\}\}/gi, names.char), { message_id: lastId, role: 'assistant' })
  g.substituteMacros = g.substitudeMacros

  // ── Books: the ones this chat uses, as this chat changed them ──
  const book = name => host('book.get', { name: String(name ?? '') })
  g.getWorldbookNames = () => [books.own, ...books.mounted, ...books.global, ...books.chat].filter(Boolean)
  g.getGlobalWorldbookNames = () => books.global.slice()
  g.getCharWorldbookNames = () => ({ primary: books.own || null, additional: books.mounted.slice() })
  g.getChatWorldbookName = () => null
  g.getWorldbook = async name => {
    const entries = book(name)
    if (!entries) throw new Error(`没有名为「${name}」的世界书`)
    return entries
  }
  g.replaceWorldbook = async (name, entries) => {
    host('book.replace', { name: String(name ?? ''), entries })
  }
  g.updateWorldbookWith = async (name, fn) => {
    const entries = await g.getWorldbook(name)
    const result = await fn(entries)
    const next = result === undefined ? entries : result
    await g.replaceWorldbook(name, next)
    return next
  }
  g.createWorldbookEntries = async (name, added) => {
    const entries = await g.getWorldbook(name)
    let uid = entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1)
    const fresh = (Array.isArray(added) ? added : []).map(e => ({ ...clone(e), uid: ++uid }))
    const next = [...entries, ...fresh]
    await g.replaceWorldbook(name, next)
    return { worldbook: next, new_entries: fresh }
  }
  g.deleteWorldbookEntries = async (name, test) => {
    const entries = await g.getWorldbook(name)
    const kept = entries.filter(e => !test(e))
    await g.replaceWorldbook(name, kept)
    return { worldbook: kept, deleted_entries: entries.filter(e => test(e)) }
  }
  g.createWorldbook = async () => false
  g.createOrReplaceWorldbook = async (name, entries) => {
    await g.replaceWorldbook(name, entries)
    return true
  }
  // The older lorebook names for the same books (web/shared/th-api.js).
  Object.assign(g, g.__olderLorebooks({
    getWorldbook: g.getWorldbook,
    replaceWorldbook: g.replaceWorldbook,
    updateWorldbookWith: g.updateWorldbookWith,
    createWorldbookEntries: g.createWorldbookEntries,
    deleteWorldbookEntries: g.deleteWorldbookEntries,
    createWorldbook: g.createWorldbook,
    names: g.getWorldbookNames,
    charBooks: g.getCharWorldbookNames,
  }))

  // ── Who is playing: read-only, as a card frame has them (compat.js) ──
  g.getCharacterNames = () => [names.char]
  g.getCurrentCharacterName = () => names.char
  g.getCharAvatarPath = () => ''
  g.getCharacter = async () => ({ name: names.char, avatar: '' })
  g.getCharData = () => ({ name: names.char, avatar: '', data: { name: names.char } })
  g.getPersonaNames = () => [names.user]
  g.getPersonaIds = () => ['user']
  g.getCurrentPersonaName = () => names.user
  g.getCurrentPersonaId = () => 'user'
  g.getPersona = async () => ({ name: names.user, title: '', description: '' })
  g.getPersonaAvatarPath = () => ''

  // ── Audio: played on the page after the event (with the notes, app.js); what the page plays is not known here ──
  const audio = (action, extra) => host('note', { level: 'audio', text: '', audio: { action, ...extra } })
  g.playAudio = (type, item) => audio('play', { type, audio: item })
  g.pauseAudio = type => audio('pause', { type })
  g.replaceAudioList = (type, list) => audio('replace', { type, list })
  g.appendAudioList = (type, list) => audio('append', { type, list })
  g.setAudioSettings = (type, settings) => audio('settings', { type, settings })
  g.getAudioList = () => []
  g.getAudioSettings = () => ({ enabled: true, mode: 'repeat_all', muted: false, volume: 100 })
  g.getCurrentAudio = () => ({ src: '', title: '', playing: false, progress: 0 })

  // ── Regex: the chat's, changed for this chat only (web/shared/regex.js) ──
  g.getTavernRegexes = (option = { type: 'character' }) => host('regex.get', { option }) || []
  g.replaceTavernRegexes = async (regexes, option = { type: 'character' }) => {
    host('regex.replace', { list: Array.isArray(regexes) ? regexes : [], option })
  }
  g.updateTavernRegexesWith = async (updater, option = { type: 'character' }) => {
    const list = g.getTavernRegexes(option)
    const result = await updater(list)
    const next = result === undefined ? list : result
    await g.replaceTavernRegexes(next, option)
    return g.getTavernRegexes(option)
  }
  g.isCharacterTavernRegexesEnabled = () => true
  g.formatAsTavernRegexedString = (text, source, destination, option = {}) => host('regex.format', { text: String(text ?? ''), source, destination, depth: option && option.depth })

  // ── Prompts for the next turns (injections.mjs): a `filter` cannot cross over, so such a prompt counts as on ──
  g.injectPrompts = (prompts, options = {}) => {
    const list = (Array.isArray(prompts) ? prompts : [prompts]).filter(p => p && p.id !== undefined && p.id !== null)
      .map(p => ({ id: String(p.id), position: p.position, depth: p.depth, role: p.role, content: String(p.content ?? ''), should_scan: p.should_scan === true }))
    host('inject', { prompts: list, once: Boolean(options && options.once) })
    return { uninject: () => g.uninjectPrompts(list.map(p => p.id)) }
  }
  g.uninjectPrompts = ids => {
    host('uninject', { ids: (Array.isArray(ids) ? ids : [ids]).map(String) })
  }

  // ── What a sandbox cannot do ──
  const refuse = what => async () => {
    throw new Error(`${what}在这里不运行`)
  }
  // The model, when the player has let this card's scripts call it (检查这张卡); the reply's text comes back.
  g.generate = config => hostLater('generate', { raw: false, config: config && typeof config === 'object' ? config : {} })
  g.generateRaw = config => hostLater('generate', { raw: true, config: config && typeof config === 'object' ? config : {} })
  g.stopGenerationById = () => false
  g.stopAllGeneration = () => false
  // Slash commands: the page's own runner (web/stscript.js, loaded as virtual:stscript), with what the server has.
  // Starting a turn (/send, /trigger) is the page's: such a command is skipped and said.
  const slashHost = {
    getVar: key => getVariables({ type: 'chat' })[key],
    setVar: (key, value) => updateVariablesWith(v => ({ ...v, [key]: value }), { type: 'chat' }),
    deleteVar: key => updateVariablesWith(v => {
      delete v[key]
      return v
    }, { type: 'chat' }),
    getGlobal: key => globalVars[key],
    setGlobal: (key, value) => {
      globalVars = { ...globalVars, [key]: value }
    },
    deleteGlobal: key => {
      globalVars = Object.fromEntries(Object.entries(globalVars).filter(([k]) => k !== key))
    },
    macro: name => {
      const lower = String(name).toLowerCase()
      if (lower === 'user') return names.user
      if (lower === 'char') return names.char
      if (lower === 'lastmessageid') return String(lastId)
      if (lower === 'lastmessage') return (messages.find(m => m.message_id === lastId) || {}).message || ''
      return undefined
    },
    command: async (name, { named, text }) => {
      if (name === 'inject') {
        const id = named.id || `slash-${Date.now()}`
        g.injectPrompts([{ id, position: named.position === 'none' ? 'none' : 'in_chat', depth: Number(named.depth) || 0, role: named.role, content: text, should_scan: String(named.scan) === 'true' }])
        return id
      }
      if (name === 'flushinject' || name === 'flushinjects') {
        if (text) g.uninjectPrompts([text])
        return ''
      }
      if (name === 'gen') return g.generate({ user_input: text })
      if (name === 'genraw') return g.generateRaw({ ordered_prompts: [{ role: 'user', content: text }] })
      return undefined
    },
    unknown: name => {
      host('note', { level: 'warning', text: `斜杠命令 /${name} 在这里不运行` })
    },
    toast: text => host('note', { level: 'info', text: String(text) }),
    sleep: () => undefined,
  }
  g.triggerSlash = command => g.__runScript(String(command ?? ''), slashHost)
  g.triggerSlashWithResult = g.triggerSlash
  g.STscript = g.triggerSlash
  g.fetch = refuse('联网')

  // ── Script buttons, globals, toasts ──
  g.getButtonEvent = name => String(name)
  g.eventOnButton = () => {}
  g.getScriptButtons = () => []
  g.replaceScriptButtons = () => {}
  g.appendInexistentScriptButtons = () => {}
  g.updateScriptButtonsWith = () => []
  g.getScriptId = () => g.__scriptName || ''
  g.getScriptName = () => g.__scriptName || ''
  g.getScriptInfo = () => ''
  g.replaceScriptInfo = () => {}
  g.getIframeName = () => `TH-script--${g.__scriptName || ''}`
  g.reloadIframe = () => {}
  g.getTavernHelperVersion = () => '4.0.0'
  g.initializeGlobal = (name, value) => {
    g[name] = value
  }
  g.waitGlobalInitialized = async name => g[name]
  g.errorCatched = fn => fn
  const toast = level => (message, title) => {
    host('note', { level, text: String(title ? `${title}：${message}` : message ?? '').slice(0, 300) })
  }
  g.toastr = { success: toast('success'), info: toast('info'), warning: toast('warning'), error: toast('error'), clear() {}, remove() {}, options: {} }

  g.eventOn = on
  g.eventMakeLast = on
  g.eventMakeFirst = (type, fn) => on(type, fn, true)
  g.eventOnce = once
  g.eventEmit = emit
  g.eventEmitAndWait = (type, ...args) => {
    emit(type, ...args)
  }
  g.eventRemoveListener = off
  g.eventClearEvent = type => {
    delete listeners[String(type)]
  }
  g.eventClearListener = fn => {
    for (const type of Object.keys(listeners)) off(type, fn)
  }
  g.eventClearAll = () => {
    for (const type of Object.keys(listeners)) delete listeners[type]
  }
  g.tavern_events = { ...g.__events.tavern }
  g.iframe_events = { ...g.__events.iframe }

  // ── MVU ──
  const getPathValue = (root, p) => pathKeys(String(p).replace(/^stat_data\./, '')).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), root)
  g.Mvu = {
    events: { ...g.__events.mvu },
    getMvuData: (option = { type: 'message', message_id: 'latest' }) => getVariables(option),
    replaceMvuData: async (data, option = { type: 'message', message_id: 'latest' }) => replaceVariables(data, option),
    parseMessage: async (message, oldData) => {
      const before = isObj(oldData && oldData.stat_data) ? oldData.stat_data : oldData || {}
      const state = host('parse', { state: before, text: String(message ?? '') })
      return { ...clone(oldData || {}), stat_data: state, display_data: clone(state), delta_data: {} }
    },
    isDuringExtraAnalysis: () => false,
    getMvuVariable: (data, p, { default_value } = {}) => getPathValue(data && data.stat_data, p) ?? default_value,
    setMvuVariable: async (data, p, value) => {
      const keys = pathKeys(String(p).replace(/^stat_data\./, ''))
      if (!keys.length || !data) return false
      data.stat_data ||= {}
      let cursor = data.stat_data
      keys.slice(0, -1).forEach(k => {
        if (!cursor[k] || typeof cursor[k] !== 'object') cursor[k] = {}
        cursor = cursor[k]
      })
      cursor[keys.at(-1)] = value
      return true
    },
    reloadInitVar: async () => false,
  }

  // ── SillyTavern ──
  g.SillyTavern = {
    get chat() {
      return messages.map(stMessage)
    },
    getContext: () => ({
      chat: messages.map(stMessage), name1: names.user, name2: names.char, characterId: 0, chatId, groupId: null,
      chatMetadata: { variables: chatShape() }, characters: [], substituteParams: g.substitudeMacros,
    }),
    substituteParams: g.substitudeMacros,
  }
  g.TavernHelper = new Proxy({}, { get: (_t, name) => g[name] })

  /**
   * One event to this script's listeners, in order, each awaited: what a listener throws is noted and the next one
   * still runs. The result is put in `__result` (the server runs the jobs and timers until it is there).
   */
  g.__fire = () => {
    const payload = JSON.parse(g.__payload)
    g.__payload = ''
    g.__result = undefined
    current = payload.current
    messages = payload.messages
    lastId = payload.lastId
    chatVars = payload.chatVars
    globalVars = payload.globalVars
    storage = { local: payload.storage.local || {}, vars: payload.storage.vars || {} }
    names = payload.names
    books = payload.books
    chatId = payload.chatId
    errors.length = 0
    fireStart = now
    const args = payload.args
    // The variables an MVU event hands over are the latest floor's: one object, however a listener reaches them.
    if (payload.currentAt === 0) args[0] = current
    else if (payload.currentAt === 'variables' && isObj(args[0])) args[0].variables = current
    ;(async () => {
      for (const fn of [...(listeners[payload.type] || [])]) {
        try {
          await fn(...args)
        } catch (error) {
          errors.push(String(error && error.message || error).slice(0, 300))
        }
      }
    })().then(() => {
      while (g.__tick()) {}
      timers.length = 0
      g.__result = JSON.stringify({ args, current, chatVars, globalVars, storage, errors })
    })
  }
  g.__listening = () => JSON.stringify(Object.keys(listeners).filter(type => listeners[type].length))
  g.__errors = () => JSON.stringify(errors.splice(0))
}

const PRELUDE = `globalThis.__olderLorebooks = (${olderLorebooks}); globalThis.__events = ${JSON.stringify({ tavern: TAVERN_EVENTS, iframe: IFRAME_EVENTS, mvu: MVU_EVENTS })}; globalThis._ = (${createLodash})(); globalThis.lodash = globalThis._; globalThis.z = (${createZ})(); (${sandboxSide})()`

// The page's slash command runner, as it is (it has no imports).
const STSCRIPT = readFileSync(new URL('../web/stscript.js', import.meta.url), 'utf8')

const VIRTUAL = {
  'virtual:stscript': STSCRIPT,
  'virtual:mvu': 'export const registerMvuSchema = () => {}; export default {}',
  'virtual:zod': 'export const z = globalThis.z; export default globalThis.z',
  'virtual:lodash': 'export default globalThis._',
}

function resolveModule(_base, name) {
  if (name === 'virtual:stscript') return name
  if (/mvu_zod|MagVarUpdate/i.test(name)) return 'virtual:mvu'
  if (/(^|\/)zod(@|\/|\.|$)/.test(name)) return 'virtual:zod'
  if (/(^|\/)lodash(@|\/|\.|$)/.test(name)) return 'virtual:lodash'
  return `virtual:unknown:${name}`
}

function loadModule(name) {
  if (VIRTUAL[name]) return VIRTUAL[name]
  throw new Error(`脚本引用了 ${name.slice('virtual:unknown:'.length)}，这里加载不了`)
}

function evaluate(vm, code, options) {
  const result = vm.evalCode(code, options?.file, options?.type ? { type: options.type } : undefined)
  if (result.error) {
    const error = vm.dump(result.error)
    result.error.dispose()
    throw new Error(String(error?.message ?? error).slice(0, 300))
  }
  return result.value
}

function evalJson(vm, code) {
  const handle = evaluate(vm, code)
  const value = vm.dump(handle)
  handle.dispose()
  return typeof value === 'string' ? JSON.parse(value) : value
}

function runJobs(vm, runtime) {
  const jobs = runtime.executePendingJobs()
  if (jobs.error) {
    const error = vm.dump(jobs.error)
    jobs.error.dispose()
    throw new Error(String(error?.message ?? error).slice(0, 300))
  }
}

/** Runs the jobs and timers a script left until `done()`, or until there is nothing more to run. */
function settle(vm, runtime, done) {
  for (let round = 0; round < 500; round++) {
    runJobs(vm, runtime)
    if (done()) return true
    if (!evalJson(vm, '__tick()')) {
      runJobs(vm, runtime)
      return done()
    }
  }
  return done()
}

// An event that waits for the server (a model call) is given up after this long, waiting included.
const WAIT_MS = 180_000

/**
 * settle, and while the script waits for a call the server answers later (box.pending), that answer: each stretch of
 * the script's own work has FIRE_MS, the whole event WAIT_MS.
 */
async function settleWaiting(vm, runtime, box, done) {
  const until = Date.now() + WAIT_MS
  for (let round = 0; round < 1000; round++) {
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FIRE_MS))
    if (settle(vm, runtime, done)) return true
    if (!box.pending.size || Date.now() > until) return done()
    await Promise.race([...box.pending, new Promise(resolve => setTimeout(resolve, until - Date.now()).unref?.())])
  }
  return done()
}

/** The cards' scripts for one store (one data folder): cardScriptsFor(store). */
const instances = new WeakMap()
export function cardScriptsFor(store) {
  if (!instances.has(store)) instances.set(store, createCardScripts(store))
  return instances.get(store)
}

function createCardScripts(store) {
  const sandboxes = new Map() // card id → { sign, runtime, scripts: [{ name, vm, broken, listens }], timer, active }

  // ─── Which scripts a card has ───
  const fileOf = cardId => path.join(store.dirs.cards, cardId, 'hook-scripts.json')

  /**
   * A card's scripts that run here, from its picture (kept beside the card until the picture changes), or as it was
   * imported (a JSON card has no picture to read them from). [] for nearly every card, read from nothing.
   */
  async function scriptsOf(card) {
    if (!card || card.direct || !(card.helperScripts > 0)) return []
    // Listed at import: nothing a sandbox runs (mvu, a schema, SillyTavern's own tools) means nothing to read.
    if (Array.isArray(card.helperList) && !card.helperList.some(item => item.on && (item.kind === 'hooks' || item.kind === 'custom'))) return []
    const picture = card.hasAvatar ? store.avatarPath(card.id) : null
    const info = picture ? await stat(picture).catch(() => null) : null
    const sign = info ? `${info.size}:${Math.round(info.mtimeMs)}` : ''
    const saved = await readFile(fileOf(card.id), 'utf8').then(JSON.parse).catch(() => null)
    if (saved && Array.isArray(saved.scripts) && (saved.sign === sign || (saved.imported && !sign))) return saved.scripts
    if (!info) return saved?.scripts ?? []
    const raw = rawOfPicture(await readFile(picture).catch(() => null))
    const scripts = hookScriptsOf((raw?.data ?? raw)?.extensions)
    // An imported card's own list stays when the picture set since carries no scripts at all.
    const kept = !scripts.length && saved?.imported && !helperScriptsOf((raw?.data ?? raw)?.extensions).length ? saved.scripts : scripts
    await writeFile(fileOf(card.id), JSON.stringify({ sign, scripts: kept, ...(kept === saved?.scripts ? { imported: true } : {}) })).catch(() => {})
    return kept
  }

  // 脚本按钮, by card: { sign, value } (read from the picture again when it changes).
  const buttonLists = new Map()

  /**
   * A card's scripts with buttons of their own (脚本按钮 above the input box, web/card-scripts.js), its picture read once
   * per change: `page` the ones run on the page in a frame of their own when a button is pressed ({ name, content,
   * buttons }), `server` the buttons of the ones run here (a press is their event, card-scripts emit).
   */
  async function buttonsOf(card) {
    const none = { page: [], server: [] }
    if (!card || card.direct || !(card.helperScripts > 0)) return none
    if (Array.isArray(card.helperList) && !card.helperList.some(item => item.on && (item.buttons?.length || item.kind === 'custom'))) return none
    const info = card.hasAvatar ? await stat(store.avatarPath(card.id)).catch(() => null) : null
    // A card without a picture (imported from a JSON): as it was imported.
    if (!info) return (await readFile(fileOf(card.id), 'utf8').then(JSON.parse).catch(() => null))?.buttons ?? none
    const sign = `${info.size}:${Math.round(info.mtimeMs)}`
    const kept = buttonLists.get(card.id)
    if (kept?.sign === sign) return kept.value
    const raw = rawOfPicture(await readFile(store.avatarPath(card.id)).catch(() => null))
    const value = buttonsFrom((raw?.data ?? raw)?.extensions)
    buttonLists.set(card.id, { sign, value })
    return value
  }

  /** A card just imported from `raw` (its SillyTavern JSON): its scripts kept now, a JSON card's included. */
  async function remember(cardId, raw) {
    const extensions = (raw?.data ?? raw)?.extensions
    const scripts = hookScriptsOf(extensions)
    const buttons = buttonsFrom(extensions)
    close(cardId)
    buttonLists.delete(cardId)
    await writeFile(fileOf(cardId), JSON.stringify({ sign: '', ...(scripts.length || buttons.page.length || buttons.server.length ? { imported: true } : {}), scripts, buttons })).catch(() => {})
  }

  // ─── Sandboxes ───
  function close(cardId) {
    const box = sandboxes.get(cardId)
    if (!box) return
    clearTimeout(box.timer)
    for (const script of box.scripts) {
      try {
        script.vm.dispose()
      } catch {
        // already gone with a broken runtime
      }
    }
    try {
      box.runtime.dispose()
    } catch {
      // a runtime that ran out of memory may not dispose cleanly
    }
    sandboxes.delete(cardId)
  }

  function keepWarm(cardId, box) {
    clearTimeout(box.timer)
    box.timer = setTimeout(() => close(cardId), IDLE_MS)
    box.timer.unref?.()
    sandboxes.delete(cardId)
    sandboxes.set(cardId, box)
    while (sandboxes.size > WARM_MAX) close(sandboxes.keys().next().value)
  }

  /** What a script asks of the server while an event runs (`box.active`: the chat it is about). */
  function hostCall(box, script, op, data) {
    const active = box.active
    if (op === 'note') {
      if (active) active.notes.push({ script: script.name, level: String(data?.level ?? 'info'), text: String(data?.text ?? ''), ...(isObject(data?.audio) ? { audio: data.audio } : {}) })
      return null
    }
    if (op === 'parse') return applyStateUpdates(isObject(data?.state) ? data.state : {}, String(data?.text ?? '')).state
    if (op.startsWith('regex.')) {
      if (!active?.regexes) return op === 'regex.format' ? String(data?.text ?? '') : null
      if (op === 'regex.get') return active.regexes.get(data?.option)
      if (op === 'regex.format') return active.regexes.format(data?.text, data?.source, data?.destination, data?.depth)
      active.regexes.replace(data?.list, data?.option)
      return null
    }
    if (op === 'inject' || op === 'uninject') {
      if (!active) return null
      if (op === 'inject') injectPrompts(active.chat, data?.prompts, { once: data?.once === true })
      else uninjectPrompts(active.chat, data?.ids)
      return null
    }
    if (op === 'book.get' || op === 'book.replace') {
      if (!active?.books) return null
      const base = bookByName(active.books.base, data?.name, active.card)
      if (!base) return null
      if (op === 'book.get') return withChatChanges([base], active.chat)[0].entries.map(thEntry)
      const written = writeChatBook(active.chat, base, data?.entries)
      if (written.prefix) active.prefix = true
      active.changed = true
      return null
    }
    throw new Error(`不认识的操作 ${op}`)
  }

  // The model for scripts the player has let call it (engine.mjs generateFor); none until the engine gives it.
  let model = null
  // Model calls a card's scripts made in the last minute, by card, and at most per event.
  const MODEL_PER_MINUTE = 6
  const MODEL_PER_EVENT = 3
  const modelCalls = new Map()

  async function hostLaterCall(box, script, op, data) {
    const active = box.active
    if (op !== 'generate') throw new Error(`不认识的操作 ${op}`)
    if (!active) throw new Error('这时没有对话，调用不了模型')
    if (!(await permissions(active.card.id)).model) {
      active.notes.push({ script: script.name, level: 'warning', text: `「${script.name}」想调用模型，没有被允许：在「检查这张卡」里可以允许` })
      throw new Error('这张卡的脚本没有被允许调用模型')
    }
    if (!model) throw new Error('这里调用不了模型')
    const now = Date.now()
    const times = (modelCalls.get(active.card.id) ?? []).filter(at => now - at < 60_000)
    if (times.length >= MODEL_PER_MINUTE || (active.modelCalls = (active.modelCalls ?? 0) + 1) > MODEL_PER_EVENT) throw new Error('调用模型太频繁')
    modelCalls.set(active.card.id, [...times, now])
    return model(active.chat, { raw: data?.raw === true, config: data?.config ?? {} }, active.signal)
  }

  function open(card, scripts, sign) {
    const runtime = sandboxEngine().newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT)
    runtime.setMaxStackSize(1024 * 1024)
    runtime.setModuleLoader(loadModule, resolveModule)
    // `queue`: the card's events, one after another (two chats of the card share its sandbox). `pending`: calls the server answers later.
    const box = { sign, runtime, scripts: [], timer: null, active: null, queue: Promise.resolve(), pending: new Set(), books: scripts.some(s => /Worldbook|Lorebook/.test(s.content)), regexes: scripts.some(s => /TavernRegex/.test(s.content)) }
    for (const source of scripts) {
      const vm = runtime.newContext()
      const script = { name: source.name, vm, broken: false, listens: new Set() }
      box.scripts.push(script)
      try {
        const fn = vm.newFunction('__host', (opHandle, dataHandle) => {
          let answer
          try {
            answer = { value: hostCall(box, script, vm.getString(opHandle), JSON.parse(vm.getString(dataHandle) || 'null')) }
          } catch (error) {
            answer = { error: String(error?.message ?? error).slice(0, 300) }
          }
          return vm.newString(JSON.stringify(answer ?? null))
        })
        vm.setProp(vm.global, '__host', fn)
        fn.dispose()
        const later = vm.newFunction('__hostAsync', (opHandle, dataHandle) => {
          const deferred = vm.newPromise()
          const op = vm.getString(opHandle)
          const data = JSON.parse(vm.getString(dataHandle) || 'null')
          const job = Promise.resolve()
            .then(() => hostLaterCall(box, script, op, data))
            .then(value => ({ value }), error => ({ error: String(error?.message ?? error).slice(0, 300) }))
            .then(answer => {
              // The sandbox may have gone meanwhile (closed, or the script cut off).
              if (!deferred.alive) return
              const text = vm.newString(JSON.stringify(answer ?? null))
              deferred.resolve(text)
              text.dispose()
            })
            .catch(() => {})
            .finally(() => box.pending.delete(job))
          box.pending.add(job)
          return deferred.handle
        })
        vm.setProp(vm.global, '__hostAsync', later)
        later.dispose()
        const name = vm.newString(source.name)
        vm.setProp(vm.global, '__scriptName', name)
        name.dispose()
        runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + LOAD_MS))
        evaluate(vm, PRELUDE).dispose()
        evaluate(vm, "import { runScript } from 'virtual:stscript'; globalThis.__runScript = runScript", { file: 'stscript.mjs', type: 'module' }).dispose()
        const loaded = evaluate(vm, source.content, { file: `${source.name}.mjs`, type: 'module' })
        // Scripts set up in `$(fn)` and after awaiting waitGlobalInitialized: that runs now.
        settle(vm, runtime, () => false)
        // A module that could not load (an import from the web) rejects its promise rather than throwing.
        const outcome = vm.getPromiseState(loaded)
        loaded.dispose()
        if (outcome.type === 'rejected') {
          const error = vm.dump(outcome.error)
          outcome.error.dispose()
          throw new Error(String(error?.message ?? error).slice(0, 300))
        }
        if (outcome.type === 'fulfilled' && !outcome.notAPromise) outcome.value.dispose()
        script.listens = new Set(evalJson(vm, '__listening()'))
        // What it logged setting up has no chat to go on (a book not found yet): not worth the error log.
        evalJson(vm, '__errors()')
      } catch (error) {
        script.broken = true
        report(source.name, String(error?.message ?? error))
      }
    }
    return box
  }

  /** The card's sandbox, opened when it has scripts that run here; null for a card without (nearly all). */
  async function sandboxOf(card) {
    const scripts = await scriptsOf(card)
    if (!scripts.length) {
      close(card?.id)
      return null
    }
    const sign = scripts.map(s => `${s.name}:${s.content.length}:${hash(s.content)}`).join('|')
    let box = sandboxes.get(card.id)
    if (box && box.sign !== sign) {
      close(card.id)
      box = null
    }
    if (!box) box = open(card, scripts, sign)
    keepWarm(card.id, box)
    return box
  }

  // ─── Firing an event ───
  /** The latest floors as a script sees them; the last is the floor being written, with `current` as its variables. */
  function floorsOf(chat, path, text) {
    const names = chat.names ?? { user: '', char: '' }
    const nodes = path.slice(-FLOORS)
    const offset = path.length - nodes.length
    return nodes.map((node, i) => ({
      message_id: offset + i,
      role: node.role === 'user' ? 'user' : 'assistant',
      name: node.role === 'user' ? names.user : names.char,
      message: i === nodes.length - 1 && text !== undefined ? text : String(node.display ?? node.text ?? ''),
      data: offset + i >= path.length - FLOORS_WITH_DATA ? mvuData(node.state ?? {}) : {},
    }))
  }

  /**
   * `type` to every script of the card listening for it, one after another (what one changes, the next sees).
   * @param ctx - { card, chat, current: MVU data of the latest floor, path: the floors (the last the latest), text?:
   *   the latest floor's text, currentAt: 0 or 'variables' when the event's arguments hold the latest floor's variables }
   * @returns { args, current } or null when no script listens.
   */
  function fire(box, type, args, ctx) {
    if (!box.scripts.some(script => !script.broken && script.listens.has(type))) return Promise.resolve(null)
    const run = box.queue.then(() => fireNow(box, type, args, ctx))
    box.queue = run.catch(() => {})
    return run
  }

  async function fireNow(box, type, args, ctx) {
    const listening = box.scripts.filter(script => !script.broken && script.listens.has(type))
    if (!listening.length) return null
    const { card, chat } = ctx
    const settings = await store.getSettings()
    const books = box.books ? await bookBases(card, chat, settings) : null
    const regexes = box.regexes ? await (await import('./chats.mjs')).chatRegexes(store, chat) : null
    box.active = { card, chat, books, regexes, notes: ctx.notes ?? [], prefix: false, changed: false, signal: ctx.signal ?? new AbortController().signal }
    const storageOf = name => structuredClone(chat.scriptStorage?.[name] ?? { local: {}, vars: {} })
    let current = ctx.current
    let chatVars = structuredClone(chat.frameVars ?? {})
    let globalVars = structuredClone(settings.globalVars ?? {})
    const before = { chatVars: JSON.stringify(chatVars), globalVars: JSON.stringify(globalVars) }
    const messages = floorsOf(chat, ctx.path, ctx.text)
    const lastId = messages.at(-1)?.message_id ?? 0
    const names = chat.names ?? { user: '', char: '' }
    const bookList = books ? bookNames(books.all, card, settings.globalBookIds ?? [], chat) : { own: '', mounted: [], global: [], chat: [] }
    try {
      for (const script of listening) {
        const { vm } = script
        const payload = vm.newString(JSON.stringify({ type, args, currentAt: ctx.currentAt ?? null, current, messages, lastId, chatVars, globalVars, storage: storageOf(script.name), names, books: bookList, chatId: chat.id ?? '' }))
        vm.setProp(vm.global, '__payload', payload)
        payload.dispose()
        try {
          box.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FIRE_MS))
          evaluate(vm, '__fire()').dispose()
          const done = await settleWaiting(vm, box.runtime, box, () => evalJson(vm, 'typeof __result === "string"'))
          if (!done) throw new Error('事件处理没有结束（在等联网或别的这里没有的东西）')
          const out = evalJson(vm, '__result')
          args = out.args
          current = out.current
          chatVars = out.chatVars
          globalVars = out.globalVars
          if (JSON.stringify(out.storage) !== JSON.stringify(storageOf(script.name))) {
            const next = { ...(chat.scriptStorage ?? {}), [script.name]: out.storage }
            if (JSON.stringify(next).length <= STORAGE_MAX) chat.scriptStorage = next
          }
          if (out.errors.length) report(script.name, out.errors.join('；'))
        } catch (error) {
          // Past its time or its memory: what it holds may be half-changed, so it does not run again this time.
          script.broken = true
          report(script.name, String(error?.message ?? error))
        }
      }
    } finally {
      const active = box.active
      box.active = null
      if (JSON.stringify(chatVars) !== before.chatVars && JSON.stringify(chatVars).length <= 200_000) chat.frameVars = chatVars
      if (JSON.stringify(globalVars) !== before.globalVars) await store.updateSettings(() => ({ globalVars })).catch(() => {})
      if (active.prefix) ctx.onPrefix?.()
    }
    return { args, current }
  }

  /** The chat's books as saved (writes are this chat's changes against them) and as it uses them. */
  async function bookBases(card, chat, settings) {
    const { booksForCard } = await import('./chats.mjs')
    const base = [...await booksForCard(store, card, settings), ...chatBooks(chat)]
    return { base, all: withChatChanges(base, chat) }
  }

  // ─── What the app asks ───
  async function prefixRebuilt(chat) {
    const { rebuildPrompt } = await import('./chats.mjs')
    await rebuildPrompt(store, chat)
  }

  // ─── What the player lets a card's scripts do (检查这张卡): { [cardId]: { model } } ───
  const permissionFile = path.join(store.dirs.root, 'script-permissions.json')
  async function readPermissions() {
    const value = await readFile(permissionFile, 'utf8').then(JSON.parse).catch(() => ({}))
    return isObject(value) ? value : {}
  }
  async function permissions(cardId) {
    const all = await readPermissions()
    return { model: all[cardId]?.model === true }
  }

  return {
    scriptsOf,
    buttonsOf,
    remember,
    permissions,
    /** Lets (or stops) a card's scripts calling the model. → its permissions. */
    async permit(cardId, { model: allowed }) {
      const all = await readPermissions()
      if (allowed) all[cardId] = { ...(all[cardId] ?? {}), model: true }
      else delete all[cardId]
      await writeFile(permissionFile, JSON.stringify(all))
      return permissions(cardId)
    },
    /** The engine's model call for scripts (engine.mjs generateFor). */
    useModel(fn) {
      model = fn
    },
    close,
    closeAll: () => [...sandboxes.keys()].forEach(close),

    /** Whether the card's scripts listen for `type` (a card frame's own event worth sending to the server). */
    async listens(card, type) {
      const box = await sandboxOf(card)
      return Boolean(box?.scripts.some(script => !script.broken && script.listens.has(type)))
    },

    /** The card's own event names its scripts listen for (none of SillyTavern's or MVU's): what a page sends on. */
    async ownEvents(card) {
      const box = await sandboxOf(card)
      if (!box) return []
      const names = box.scripts.filter(script => !script.broken).flatMap(script => [...script.listens])
      return [...new Set(names)].filter(type => !isHostEvent(type))
    },

    /**
     * A new chat's opening state through VARIABLE_INITIALIZED. → the state, the same one when nothing listens.
     * @param chat - the chat being made (its scripts' storage, chat variables and book changes land on it).
     */
    async initialized(card, chat, state) {
      const box = await sandboxOf(card)
      if (!box) return state
      const current = mvuData(state)
      let prefix = false
      const fired = await fire(box, MVU_EVENTS.VARIABLE_INITIALIZED, [current, 0], { card, chat, current, path: [{ role: 'assistant', text: chat.nodes?.root?.text ?? '', state }], currentAt: 0, onPrefix: () => (prefix = true) })
      if (prefix) await prefixRebuilt(chat)
      return fired ? stateOf(fired.current, state) : state
    },

    /**
     * A reply's update blocks with the card's scripts around them, as MVU runs them; null for a card without scripts
     * that run here (the caller applies the updates as it always has).
     * @param options - { before: the state the reply starts from, text: the reply, path: the floors before it,
     *   received: also MESSAGE_RECEIVED and GENERATION_ENDED (a new reply, not a refill) }
     * @returns { state, changes, unread, notes }
     */
    async update(card, chat, { before, text, path, received = false }) {
      const box = await sandboxOf(card)
      if (!box) return null
      const notes = []
      let prefix = false
      const read = readUpdates(before, text)
      const floors = [...path, { role: 'assistant', text, state: read.state }]
      const ctx = { card, chat, path: floors, text, notes, onPrefix: () => (prefix = true) }
      let current = mvuData(read.state)
      const step = async (type, args, currentAt) => {
        const fired = await fire(box, type, args, { ...ctx, current, currentAt })
        if (fired) current = fired.current
        return fired
      }
      await step(MVU_EVENTS.VARIABLE_UPDATE_STARTED, [current, false], 0)
      // The commands as MVU hands them over; one a script left as it was runs exactly as read.
      const parsed = await step(MVU_EVENTS.COMMAND_PARSED, [current, read.commands.map(c => ({ ...c })), text], 0)
      let commands = read.commands
      if (parsed && Array.isArray(parsed.args?.[1])) {
        const unused = read.commands.map(command => ({ command, key: JSON.stringify([command.type, command.args]) }))
        commands = parsed.args[1].filter(isObject).map(command => {
          const at = unused.findIndex(item => item.key === JSON.stringify([command.type, command.args]))
          return at >= 0 ? unused.splice(at, 1)[0].command : command
        })
      }
      const startState = stateOf(current, read.state)
      const applied = applyCommands(startState, commands)
      const old = mvuData(startState)
      current = mvuData(applied.state)
      await step(MVU_EVENTS.VARIABLE_UPDATE_ENDED, [current, old], 0)
      await step(MVU_EVENTS.BEFORE_MESSAGE_UPDATE, [{ variables: current, message_content: text }], 'variables')
      if (received) {
        const id = floors.length - 1
        await step(TAVERN_EVENTS.MESSAGE_RECEIVED, [id, 'normal'], null)
        await step(TAVERN_EVENTS.GENERATION_ENDED, [id], null)
      }
      if (prefix) await prefixRebuilt(chat)
      const state = stateOf(current, applied.state)
      return { state, changes: [...new Set([...read.changes, ...applied.changes])], unread: read.unread, notes }
    },

    /**
     * `text` (a turn's message) with the macros the card's scripts registered (registerMacroLike) put in; the same text
     * for a card whose scripts have none.
     * @param context - { role, messageId } as the macros' callbacks get it.
     */
    async applyMacros(card, text, context = {}) {
      const box = await sandboxOf(card)
      if (!box) return text
      const run = box.queue.then(() => {
        let out = text
        for (const script of box.scripts) {
          if (script.broken) continue
          const { vm } = script
          try {
            if (!evalJson(vm, '__macroCount()')) continue
            const payload = vm.newString(JSON.stringify({ text: out, role: context.role ?? 'user', messageId: context.messageId ?? 0 }))
            vm.setProp(vm.global, '__payload', payload)
            payload.dispose()
            box.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + FIRE_MS))
            out = evalJson(vm, '__applyMacros()')
          } catch (error) {
            script.broken = true
            report(script.name, String(error?.message ?? error))
          }
        }
        return out
      })
      box.queue = run.catch(() => {})
      return run
    },

    /**
     * A new turn about to be put together (SillyTavern's MESSAGE_SENT, GENERATION_STARTED and GENERATION_AFTER_COMMANDS,
     * in that order): scripts inject prompts for it, set variables it starts from, change the chat's books.
     * @param path - the floors up to the player's message (the last).
     * @returns { state, notes }: `state` the variables the turn starts from when a script changed them, else null.
     */
    async turnStarting(card, chat, path) {
      const box = await sandboxOf(card)
      const types = [TAVERN_EVENTS.MESSAGE_SENT, TAVERN_EVENTS.GENERATION_STARTED, TAVERN_EVENTS.GENERATION_AFTER_COMMANDS]
      if (!box || !box.scripts.some(script => !script.broken && types.some(type => script.listens.has(type)))) return { state: null, notes: [] }
      const notes = []
      let prefix = false
      const start = path.at(-1)?.state ?? {}
      let current = mvuData(start)
      const ctx = { card, chat, path, notes, onPrefix: () => (prefix = true) }
      const sent = path.length - 1
      for (const [type, args] of [[types[0], [sent]], [types[1], ['normal', {}, false]], [types[2], ['normal', {}, false]]]) {
        const fired = await fire(box, type, args, { ...ctx, current })
        if (fired) current = fired.current
      }
      if (prefix) await prefixRebuilt(chat)
      const state = stateOf(current, start)
      return { state: JSON.stringify(state) === JSON.stringify(start) ? null : state, notes }
    },

    /**
     * A card frame's own event (web/compat.js eventEmit with a name of the card's) to the scripts listening, with the
     * latest floor's variables. → { handled, state, notes }: `state` the latest floor's after it (unchanged: null).
     * @param path - the chat's floors, the latest last.
     */
    async emit(card, chat, type, args, path) {
      const box = await sandboxOf(card)
      if (!box || !box.scripts.some(script => !script.broken && script.listens.has(type))) return { handled: false, state: null, notes: [] }
      const notes = []
      let prefix = false
      const latest = path.at(-1)
      const current = mvuData(latest?.state ?? {})
      const fired = await fire(box, String(type), Array.isArray(args) ? args : [], { card, chat, current, path, notes, onPrefix: () => (prefix = true) })
      if (prefix) await prefixRebuilt(chat)
      const state = fired ? stateOf(fired.current, latest?.state ?? {}) : null
      const changed = state && JSON.stringify(state) !== JSON.stringify(latest?.state ?? {})
      return { handled: Boolean(fired), state: changed ? state : null, notes }
    },
  }
}

/** Every character of `text` (FNV-1a, two ways): a script edited anywhere opens its sandbox anew. */
function hash(text) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15)
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
}
