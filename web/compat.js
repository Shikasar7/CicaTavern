// Tavern Helper (酒馆助手) compatibility for card and preset HTML.
//
// SillyTavern runs message HTML in same-origin iframes and hands them its own
// functions. Ours stay sandboxed (opaque origin, see render.js), so the frame
// gets a stand-in instead: the common Tavern Helper globals, storage that does
// not throw, and a `parent` whose `#send_textarea` is our input box. Anything
// that has to touch the app goes through postMessage and is checked here:
// filling or sending the input, toasts, and saving global variables / storage.
// Calling the model, editing messages or reaching the real page is not offered.

const STORAGE_KEY = 'agent-tavern:frame-storage'
const VARS_KEY = 'agent-tavern:th-vars'
const MAX_STORED = 1_000_000

// CDN copies of what Tavern Helper preloads into every message frame, loaded
// only when the frame's code looks like it uses them.
const LIBRARIES = [
  { test: /\$\(|\$\.|jQuery/, tags: ['<script src="https://testingcf.jsdelivr.net/npm/jquery/dist/jquery.min.js"></script>'] },
  {
    test: /\.(draggable|sortable|resizable|droppable|selectable)\(/,
    tags: [
      '<script src="https://testingcf.jsdelivr.net/npm/jquery-ui/dist/jquery-ui.min.js"></script>',
      '<link rel="stylesheet" href="https://testingcf.jsdelivr.net/npm/jquery-ui/themes/base/theme.min.css">',
    ],
  },
  { test: /\b_\.[a-zA-Z]+\(/, tags: ['<script src="https://testingcf.jsdelivr.net/npm/lodash/lodash.min.js"></script>'] },
  { test: /\bVue\./, tags: ['<script src="https://testingcf.jsdelivr.net/npm/vue/dist/vue.global.prod.min.js"></script>'] },
  { test: /\bVueRouter\b/, tags: ['<script src="https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js"></script>'] },
  { test: /\bYAML\./, tags: ['<script src="https://testingcf.jsdelivr.net/npm/yaml/browser/dist/index.min.js"></script>'] },
  { test: /class=["'][^"']*\bfa[srbl]?\s+fa-|\bfa-solid\b|\bfa-regular\b/, tags: ['<link rel="stylesheet" href="https://testingcf.jsdelivr.net/npm/@fortawesome/fontawesome-free/css/all.min.css">'] },
  {
    test: /class=["'][^"']*\b(?:flex|grid|p[xy]?-\d|m[xy]?-\d|bg-[a-z]+-\d{2,3}|text-(?:xs|sm|lg|[2-9]?xl)|rounded(?:-[a-z]+)?|gap-\d|w-full|items-center)\b/,
    tags: ['<script src="https://cdn.tailwindcss.com"></script>'],
  },
]

// 隐私与网络 → 酒馆助手脚本库 (and, in the public builds, not before the notice).
let librariesAllowed = true
export function allowLibraries(on) {
  librariesAllowed = Boolean(on)
}

/** `<script>`/`<link>` tags for the libraries a frame body seems to use. */
export function libraryTags(body) {
  if (!librariesAllowed) return ''
  return LIBRARIES.filter(lib => lib.test.test(body)).flatMap(lib => lib.tags).join('')
}

/**
 * Tavern Helper keeps `min-height: …vh` from growing with the frame by pinning
 * vh to the page's viewport; do the same.
 */
export function replaceViewportHeight(body) {
  const toVariable = value =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, n) => {
      const parsed = parseFloat(n)
      if (!isFinite(parsed)) return match
      return parsed === 100 ? 'var(--TH-viewport-height)' : `calc(var(--TH-viewport-height) * ${parsed / 100})`
    })
  return body
    .replace(/(min-height\s*:\s*)([^;{}"']*?\d+(?:\.\d+)?vh)/gi, (_, prefix, value) => prefix + toVariable(value))
    .replace(/(\.style\.minHeight\s*=\s*(["']))([^"']*?vh)(\2)/gi, (_, prefix, _q, value, suffix) => prefix + toVariable(value) + suffix)
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {}
  } catch {
    return {}
  }
}

function writeJson(key, value) {
  try {
    const text = JSON.stringify(value)
    if (text.length <= MAX_STORED) localStorage.setItem(key, text)
  } catch {
    // Quota or private mode: frames keep working from memory.
  }
}

/** Saved variables the frames may read: global, plus this preset's and card's. */
export function storedVariables({ presetId, cardId }) {
  const all = readJson(VARS_KEY)
  return { global: all.global ?? {}, preset: all.preset?.[presetId] ?? {}, character: all.character?.[cardId] ?? {} }
}

function saveVariables(type, ids, value) {
  const all = readJson(VARS_KEY)
  if (type === 'global') all.global = value
  else if (type === 'preset' && ids.presetId) all.preset = { ...all.preset, [ids.presetId]: value }
  else if (type === 'character' && ids.cardId) all.character = { ...all.character, [ids.cardId]: value }
  else return
  writeJson(VARS_KEY, all)
}

export function storedFrameStorage() {
  return readJson(STORAGE_KEY)
}

/**
 * The script that goes first into a message frame. `ctx` is plain JSON:
 * { frame, frameName, messageId, lastId, chatId, cardId, names, vars: { message, latest, global, preset, character },
 *   messages: [{ message_id, name, role, message, state }], storage, viewport: { width, height } }
 */
export function frameShim(ctx) {
  // `<` escaped so a `</script>` inside the story text cannot end the tag.
  const json = JSON.stringify(ctx).replace(/</g, '\\u003c')
  return `<script>(${shimMain.toString()})(${json})<\/script>`
}

/* Runs inside the frame. Self-contained: it is serialised with toString(). */
function shimMain(ctx) {
  const host = window.parent
  const post = (op, args) => host.postMessage({ agentTavernCall: ctx.frame, op, args }, '*')
  let seq = 0
  const pending = new Map()
  // What our input box holds, kept current by the host (see broadcastInput).
  let draft = String(ctx.input || '')
  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      host.postMessage({ agentTavernCall: ctx.frame, id, op, args }, '*')
    })
  window.addEventListener('message', event => {
    if (event.source !== host) return
    const data = event.data
    if (data && typeof data.agentTavernInput === 'string') draft = data.agentTavernInput
    if (data && data.agentTavernReply === ctx.frame && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.ok) resolve(data.value)
      else reject(new Error(data.error || '失败')) // i18n-ignore: for the card's scripts, inside its frame
    }
  })
  const unsupported = name => (..._args) => {
    console.warn(`[酒馆] ${name} 在这里不可用`) // i18n-ignore: for the card's scripts, inside its frame
    return Promise.reject(new Error(`酒馆不支持 ${name}`)) // i18n-ignore: for the card's scripts, inside its frame
  }

  // ── Storage: opaque-origin frames throw on localStorage / cookies ──
  function makeStorage(seed, persist) {
    const data = new Map(Object.entries(seed || {}))
    const save = (key, value) => persist && post('storage', { key, value })
    return {
      get length() {
        return data.size
      },
      key: index => [...data.keys()][index] ?? null,
      getItem: key => (data.has(String(key)) ? data.get(String(key)) : null),
      setItem: (key, value) => {
        data.set(String(key), String(value))
        save(String(key), String(value))
      },
      removeItem: key => {
        data.delete(String(key))
        save(String(key), null)
      },
      clear: () => {
        for (const key of data.keys()) save(key, null)
        data.clear()
      },
    }
  }
  for (const [name, seed, persist] of [['localStorage', ctx.storage, true], ['sessionStorage', {}, false]]) {
    try {
      void window[name].length
    } catch {
      try {
        Object.defineProperty(window, name, { value: makeStorage(seed, persist), configurable: true })
      } catch {}
    }
  }
  try {
    void document.cookie
  } catch {
    try {
      Object.defineProperty(document, 'cookie', { get: () => '', set: () => {}, configurable: true })
    } catch {}
  }

  // ── Small lodash-like helpers ──
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const toPath = path => (Array.isArray(path) ? path : String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean))
  const getPath = (object, path) => toPath(path).reduce((at, key) => (at == null ? undefined : at[key]), object)
  const hasPath = (object, path) => {
    const keys = toPath(path)
    let at = object
    for (const key of keys) {
      if (at == null || !Object.prototype.hasOwnProperty.call(at, key)) return false
      at = at[key]
    }
    return true
  }
  const setPath = (object, path, value) => {
    const keys = toPath(path)
    let at = object
    keys.slice(0, -1).forEach((key, i) => {
      if (at[key] == null || typeof at[key] !== 'object') at[key] = /^\d+$/.test(keys[i + 1]) ? [] : {}
      at = at[key]
    })
    at[keys.at(-1)] = value
    return object
  }
  const unsetPath = (object, path) => {
    const keys = toPath(path)
    const parent = keys.length > 1 ? getPath(object, keys.slice(0, -1)) : object
    if (parent == null || !(keys.at(-1) in Object(parent))) return false
    delete parent[keys.at(-1)]
    return true
  }
  const merge = (target, source, onlyMissing = false) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (isObject(value) && isObject(target[key])) merge(target[key], value, onlyMissing)
      else if (!onlyMissing || !(key in target)) target[key] = clone(value)
    }
    return target
  }

  // ── Variables ──
  // Our story state is MVU's `stat_data`. Message variables expose it both ways
  // (`vars.stat_data.x` and `vars.x`) so MVU and plain cards both find it.
  const mvuShape = state => ({ ...clone(state || {}), stat_data: clone(state || {}), display_data: clone(state || {}), delta_data: {}, initialized_lorebooks: {} })
  const messageVars = new Map((ctx.messages || []).map(m => [m.message_id, mvuShape(m.state)]))
  messageVars.set(ctx.messageId, mvuShape(ctx.vars.message))
  messageVars.set(ctx.lastId, mvuShape(ctx.vars.latest))
  const buckets = {
    chat: mvuShape(ctx.vars.latest),
    global: clone(ctx.vars.global || {}),
    preset: clone(ctx.vars.preset || {}),
    character: clone(ctx.vars.character || {}),
    script: {},
    extension: {},
  }
  const messageIdOf = id => {
    if (id === undefined || id === 'latest') return ctx.lastId
    const n = Number(id)
    return n < 0 ? ctx.lastId + 1 + n : n
  }
  const read = (option = {}) => {
    const type = (option && option.type) || 'chat'
    if (type === 'message') {
      const id = messageIdOf(option.message_id)
      if (id < 0 || id > ctx.lastId) throw new Error(`楼层 ${option.message_id} 不存在`) // i18n-ignore: for the card's scripts, inside its frame
      if (!messageVars.has(id)) messageVars.set(id, {})
      return messageVars.get(id)
    }
    return buckets[type] ?? (buckets[type] = {})
  }
  const write = (option = {}, value) => {
    const type = (option && option.type) || 'chat'
    if (type === 'message') messageVars.set(messageIdOf(option.message_id), value)
    else buckets[type] = value
    // Story state belongs to the turns; only these are kept between renders.
    if (type === 'global' || type === 'preset' || type === 'character') post('vars', { type, value })
  }
  const getVariables = option => clone(read(option))
  const replaceVariables = (variables, option) => write(option, clone(variables || {}))
  const updateVariablesWith = (updater, option) => {
    const current = getVariables(option)
    const result = updater(current)
    if (result && typeof result.then === 'function') {
      return result.then(next => {
        replaceVariables(next ?? current, option)
        return next ?? current
      })
    }
    replaceVariables(result ?? current, option)
    return result ?? current
  }
  const insertOrAssignVariables = (variables, option) => updateVariablesWith(current => merge(current, variables), option)
  const insertVariables = (variables, option) => updateVariablesWith(current => merge(current, variables, true), option)
  const deleteVariable = (path, option) => {
    const current = getVariables(option)
    const removed = unsetPath(current, path)
    replaceVariables(current, option)
    return { variables: current, delete_occurred: removed }
  }
  const getAllVariables = () =>
    merge(merge(merge(merge({}, buckets.global), buckets.character), buckets.chat), read({ type: 'message', message_id: ctx.messageId }))

  // ── Messages ──
  const messageOf = m => ({
    message_id: m.message_id,
    name: m.name,
    role: m.role,
    is_hidden: false,
    message: m.message,
    data: clone(messageVars.get(m.message_id) || mvuShape(m.state)),
    extra: {},
  })
  const substitudeMacros = text =>
    String(text ?? '')
      .replace(/\{\{user\}\}/gi, ctx.names.user)
      .replace(/\{\{char\}\}/gi, ctx.names.char)
      .replace(/\{\{lastMessageId\}\}/gi, String(ctx.lastId))
      .replace(/\{\{getvar::([^}]+)\}\}/gi, (_, key) => {
        const value = getPath(buckets.chat, key.trim())
        return value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
      })
  const getChatMessages = (range, option = {}) => {
    const text = substitudeMacros(range)
    const match = /^(-?\d+)(?:-(-?\d+))?$/.exec(text.trim())
    if (!match) return []
    let from = messageIdOf(match[1])
    let to = match[2] === undefined ? from : messageIdOf(match[2])
    if (from > to) [from, to] = [to, from]
    return (ctx.messages || [])
      .filter(m => m.message_id >= from && m.message_id <= to)
      .filter(m => !option.role || option.role === 'all' || m.role === option.role)
      .map(m => {
        const out = messageOf(m)
        if (option.include_swipes) Object.assign(out, { swipe_id: 0, swipes: [m.message], swipes_data: [out.data], swipes_info: [{}] })
        return out
      })
  }

  // ── Events: a local bus, so scripts that listen and emit among themselves work ──
  const listeners = new Map()
  const on = (type, fn, first = false) => {
    const list = listeners.get(type) || []
    if (!list.includes(fn)) first ? list.unshift(fn) : list.push(fn)
    listeners.set(type, list)
    return { stop: () => removeListener(type, fn) }
  }
  const removeListener = (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn))
  const eventOnce = (type, fn) => {
    const once = (...data) => {
      removeListener(type, once)
      return fn(...data)
    }
    return on(type, once)
  }
  const eventEmit = async (type, ...data) => {
    for (const fn of [...(listeners.get(type) || [])]) await fn(...data)
  }
  const tavern_events = {
    APP_READY: 'app_ready', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received', MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated', MESSAGE_SWIPED: 'message_swiped', CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started', GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended',
    USER_MESSAGE_RENDERED: 'user_message_rendered', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    STREAM_TOKEN_RECEIVED: 'stream_token_received', WORLD_INFO_ACTIVATED: 'world_info_activated', SETTINGS_UPDATED: 'settings_updated',
  }
  const iframe_events = {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended',
  }

  // ── Toasts, errors, slash commands ──
  const toast = level => (message, title) => post('toast', { level, text: String(message ?? ''), title: title ? String(title) : '' })
  const toastr = { success: toast('success'), info: toast('info'), warning: toast('warning'), error: toast('error'), clear() {}, remove() {}, options: {} }
  const report = error => {
    console.error(error)
    toastr.error(String((error && error.message) || error))
  }
  const errorCatched = fn => (...args) => {
    try {
      const result = fn(...args)
      return result && typeof result.catch === 'function' ? result.catch(report) : result
    } catch (error) {
      report(error)
    }
  }
  const triggerSlash = command => call('slash', { command: String(command ?? '') })

  // ── MVU ──
  const Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData: option => getVariables(option || { type: 'message', message_id: 'latest' }),
    replaceMvuData: async (data, option) => replaceVariables(data, option || { type: 'message', message_id: 'latest' }),
    parseMessage: async (_message, oldData) => clone(oldData),
    isDuringExtraAnalysis: () => false,
    getMvuVariable: (data, path, { default_value } = {}) => getPath(data && data.stat_data, path) ?? default_value,
    setMvuVariable: async (data, path, value) => {
      setPath(data.stat_data, path, value)
      return true
    },
  }
  const globals = { Mvu }

  const helper = {
    getVariables, replaceVariables, updateVariablesWith, insertOrAssignVariables, insertVariables, deleteVariable, getAllVariables,
    registerVariableSchema: () => {},
    getChatMessages,
    getLastMessageId: () => ctx.lastId,
    getCurrentMessageId: () => ctx.messageId,
    getMessageId: name => Number(/--(\d+)--/.exec(String(name))?.[1] ?? ctx.messageId),
    getIframeName: () => ctx.frameName,
    getScriptId: () => '',
    getScriptName: () => '',
    getScriptInfo: () => '',
    replaceScriptInfo: () => {},
    getScriptButtons: () => [],
    replaceScriptButtons: () => {},
    updateScriptButtonsWith: () => [],
    appendInexistentScriptButtons: () => {},
    getButtonEvent: name => String(name),
    substitudeMacros,
    errorCatched,
    triggerSlash,
    // 小白X (LittleWhiteBox) names the same bridge STscript() in its message frames.
    STscript: triggerSlash,
    reloadIframe: () => location.reload(),
    eventOn: (type, fn) => on(type, fn),
    eventMakeLast: (type, fn) => on(type, fn),
    eventMakeFirst: (type, fn) => on(type, fn, true),
    eventOnce,
    eventOnButton: () => {},
    eventEmit,
    eventEmitAndWait: (type, ...data) => void eventEmit(type, ...data),
    eventRemoveListener: removeListener,
    eventClearEvent: type => listeners.delete(type),
    eventClearListener: fn => listeners.forEach((list, type) => listeners.set(type, list.filter(f => f !== fn))),
    eventClearAll: () => listeners.clear(),
    initializeGlobal: (name, value) => {
      globals[name] = value
      window[name] = value
    },
    waitGlobalInitialized: async name => {
      for (let i = 0; i < 100 && !(name in globals) && !(name in window); i++) await new Promise(r => setTimeout(r, 100))
      return globals[name] ?? window[name]
    },
    generate: unsupported('generate'),
    generateRaw: unsupported('generateRaw'),
    setChatMessages: unsupported('setChatMessages'),
    setChatMessage: unsupported('setChatMessage'),
    createChatMessages: unsupported('createChatMessages'),
    deleteChatMessages: unsupported('deleteChatMessages'),
    rotateChatMessages: unsupported('rotateChatMessages'),
  }
  const chat = (ctx.messages || []).map(m => ({ name: m.name, is_user: m.role === 'user', is_system: false, mes: m.message }))
  const SillyTavern = {
    name1: ctx.names.user,
    name2: ctx.names.char,
    chatId: ctx.chatId,
    characterId: ctx.cardId,
    chat,
    chatMetadata: {},
    getCurrentChatId: () => ctx.chatId,
    substituteParams: substitudeMacros,
    eventSource: { on: helper.eventOn, once: eventOnce, emit: eventEmit, removeListener },
    eventTypes: tavern_events,
  }
  SillyTavern.getContext = () => SillyTavern
  const TavernHelper = { ...helper, Mvu }
  Object.assign(window, helper, { TavernHelper, SillyTavern, Mvu, toastr, tavern_events, iframe_events })

  // ── A stand-in `parent`: `#send_textarea` / `#send_but` are our input box and send button, the rest is this frame ──
  const element = extra => ({
    focus() {},
    blur() {},
    click() {},
    dispatchEvent: () => true,
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    ...extra,
  })
  const input = element({ id: 'send_textarea' })
  Object.defineProperty(input, 'value', {
    get: () => draft,
    set: text => {
      draft = String(text ?? '')
      post('input', { text: draft })
    },
  })
  const sendButton = element({ id: 'send_but', click: () => post('send', {}) })
  const hostElement = selector => {
    const text = String(selector)
    if (/#send_textarea\b/.test(text)) return input
    if (/#send_but\b/.test(text)) return sendButton
    return null
  }
  const fakeDocument = new Proxy(document, {
    get(target, key) {
      if (key === 'querySelector') return selector => hostElement(selector) ?? target.querySelector(selector)
      if (key === 'getElementById') return id => hostElement(`#${id}`) ?? target.getElementById(id)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const fakeParent = new Proxy(window, {
    get(target, key) {
      if (key === 'document') return fakeDocument
      if (key === 'postMessage') return (...args) => host.postMessage(...args)
      if (key === 'parent' || key === 'window' || key === 'self') return fakeParent
      if (key === 'innerHeight') return ctx.viewport.height
      if (key === 'innerWidth') return ctx.viewport.width
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set: () => true,
  })
  try {
    window.parent = fakeParent
  } catch {}
  document.documentElement.style.setProperty('--TH-viewport-height', `${ctx.viewport.height}px`)
}

/**
 * Host side: answers frames that are ours. `handlers.slash(command)` runs a
 * slash command (resolves to its output), `handlers.input(text)` fills the
 * input box, `handlers.toast(level, text)` shows a toast; `ids()` returns the
 * current { presetId, cardId } for saving variables.
 */
export function installFrameBridge(handlers) {
  window.addEventListener('message', async event => {
    const data = event.data
    const id = data?.agentTavernCall
    if (typeof id !== 'string') return
    const frame = document.querySelector(`iframe[data-frame="${CSS.escape(id)}"]`)
    if (!frame || event.source !== frame.contentWindow) return
    const reply = (ok, value) => data.id && event.source.postMessage({ agentTavernReply: id, id: data.id, ok, value: ok ? value : undefined, error: ok ? undefined : String(value) }, '*')
    const args = data.args ?? {}
    try {
      if (data.op === 'toast') handlers.toast(args.level, [args.title, args.text].filter(Boolean).join('：')) // i18n-ignore: a card script's own toast
      else if (data.op === 'input') handlers.input(String(args.text ?? ''))
      else if (data.op === 'send') await handlers.send()
      else if (data.op === 'slash') reply(true, await handlers.slash(String(args.command ?? '')))
      else if (data.op === 'storage') {
        const stored = storedFrameStorage()
        if (args.value === null) delete stored[args.key]
        else stored[String(args.key)] = String(args.value)
        writeJson(STORAGE_KEY, stored)
      } else if (data.op === 'vars') saveVariables(args.type, handlers.ids(), args.value && typeof args.value === 'object' ? args.value : {})
    } catch (error) {
      reply(false, error?.message ?? error)
    }
  })
}

/** Tell every card frame what the input box now holds, so `#send_textarea.value` reads true. */
export function broadcastInput(text) {
  for (const frame of document.querySelectorAll('iframe.card-frame')) frame.contentWindow?.postMessage({ agentTavernInput: String(text) }, '*')
}

/**
 * Split a STscript pipe into commands: `/send hi|/trigger` → [{ name: 'send', text: 'hi' }, …].
 * Named arguments (`key=value`) before the text are collected into `named`.
 */
export function parseSlash(command) {
  const out = []
  for (const part of String(command).split(/\|(?=\s*\/)/)) {
    const match = /^\s*\/(\S+)\s*([\s\S]*)$/.exec(part)
    if (!match) continue
    let text = match[2]
    const named = {}
    for (;;) {
      const arg = /^(\w+)=("([^"]*)"|\S+)\s*/.exec(text)
      if (!arg) break
      named[arg[1]] = arg[3] ?? arg[2]
      text = text.slice(arg[0].length)
    }
    out.push({ name: match[1].toLowerCase(), text: text.trim(), named })
  }
  return out
}
