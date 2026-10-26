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
// only when the frame's code looks like it uses them. `always`: also for a
// frame that pulls its page in from elsewhere (REMOTE_PAGE), whose code cannot
// be looked through beforehand.
const LIBRARIES = [
  { always: true, test: /\$\(|\$\.|jQuery/, tags: ['<script src="https://testingcf.jsdelivr.net/npm/jquery/dist/jquery.min.js"></script>'] },
  {
    test: /\.(draggable|sortable|resizable|droppable|selectable)\(/,
    tags: [
      '<script src="https://testingcf.jsdelivr.net/npm/jquery-ui/dist/jquery-ui.min.js"></script>',
      '<link rel="stylesheet" href="https://testingcf.jsdelivr.net/npm/jquery-ui/themes/base/theme.min.css">',
    ],
  },
  { always: true, test: /\b_\.[a-zA-Z]+\(/, tags: ['<script src="https://testingcf.jsdelivr.net/npm/lodash/lodash.min.js"></script>'] },
  { always: true, test: /\bVue\./, tags: ['<script src="https://testingcf.jsdelivr.net/npm/vue/dist/vue.global.prod.min.js"></script>'] },
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

// A card's UI kept on GitHub or a CDN: $('body').load(url), or fetching a page.
const REMOTE_PAGE = /\.load\(\s*["'`]https?:\/\/|fetch\(\s*["'`]https?:\/\/[^"'`]+\.html?\b/

/** `<script>`/`<link>` tags for the libraries a frame body seems to use. */
export function libraryTags(body) {
  if (!librariesAllowed) return ''
  const remote = REMOTE_PAGE.test(body)
  return LIBRARIES.filter(lib => lib.test.test(body) || (remote && lib.always)).flatMap(lib => lib.tags).join('')
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

/**
 * A card's frames' localStorage as kept in this browser: each card its own ({ cards: { [cardId]: { key: value } } }),
 * so one card cannot read what another saved (an API key, say). The map all cards once shared goes to none of them.
 */
export function storedFrameStorage(cardId) {
  const own = readJson(STORAGE_KEY).cards?.[cardId]
  return own && typeof own === 'object' ? own : {}
}

function saveFrameStorage(cardId, key, value) {
  const all = readJson(STORAGE_KEY)
  const own = { ...storedFrameStorage(cardId) }
  if (value === null) delete own[key]
  else own[String(key)] = String(value)
  writeJson(STORAGE_KEY, { ...all, cards: { ...(all.cards ?? {}), [cardId]: own } })
}

/**
 * The script that goes first into a message frame. `ctx` is plain JSON:
 * { frame, frameName, messageId, lastId, chatId, cardId, names, vars: { message, latest, global, preset, character },
 *   messages: [{ message_id, name, role, message, state }], storage, viewport: { width, height } }
 */
export function frameShim(ctx) {
  // `<` escaped so a `</script>` inside the story text cannot end the tag.
  const json = JSON.stringify(ctx).replace(/</g, '\\u003c')
  return `<script>(${shimMain.toString()})(${json}, ${frameFetch.toString()})<\/script>`
}

/**
 * The frame's `fetch`. Straight out first, as in SillyTavern. A call the browser
 * cannot make (an API that does not let pages call it, the browser's own proxy,
 * an address on this computer a sandboxed frame may not reach) is offered to the
 * page, which makes it from the app once the player allows this card and address
 * (web/app.js frameHandlers.fetch) and passes the answer back as it comes:
 * `fetches.get(id)` gets head({ status, statusText, headers }), chunk(bytes), done().
 * Only GET and HEAD are sent again that way: any other call may have reached the
 * API before the browser refused the page its answer, so the player is asked
 * (frameHandlers.fetchAllow) and the call fails saying to try again, which then
 * goes through the app. Addresses relayed before go that way at once; this app's
 * own address never.
 * Runs inside the frame. Self-contained: it is serialised with toString().
 * @param deps - { direct (the browser's fetch), post(op, args), call(op, args) → Promise, fetches: Map,
 *   frame, appOrigin, relayed: origins allowed before }
 */
export function frameFetch({ direct, post, call, fetches, frame, appOrigin, relayed: allowed }) {
  const relayed = new Set(Array.isArray(allowed) ? allowed : [])
  const NULL_BODY = [101, 103, 204, 205, 304]
  // Calls that do nothing twice when sent twice.
  const RESENT = ['GET', 'HEAD']
  let seq = 0
  function relay(request, url, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('The user aborted a request.', 'AbortError'))
      const id = `${frame}-${++seq}`
      let stream = null
      let answered = false
      const body = new ReadableStream({ start: controller => { stream = controller }, cancel: () => post('fetchCancel', { id }) })
      const fail = error => {
        if (!fetches.has(id)) return
        fetches.delete(id)
        if (!answered) return reject(error)
        try {
          stream.error(error)
        } catch {
          // Read to the end already.
        }
      }
      fetches.set(id, {
        head: head => {
          answered = true
          relayed.add(url.origin)
          try {
            resolve(new Response(NULL_BODY.includes(head.status) || request.method === 'HEAD' ? null : body, { status: head.status, statusText: head.statusText, headers: head.headers }))
          } catch (error) {
            answered = false
            fail(new TypeError(error.message))
          }
        },
        chunk: bytes => stream.enqueue(bytes),
        done: () => {
          fetches.delete(id)
          try {
            stream.close()
          } catch {
            // Cancelled by the reader.
          }
        },
        fail,
      })
      signal?.addEventListener('abort', () => {
        post('fetchCancel', { id })
        fail(new DOMException('The user aborted a request.', 'AbortError'))
      }, { once: true })
      ;(RESENT.includes(request.method) ? Promise.resolve(null) : request.arrayBuffer())
        .then(buffer => call('fetch', { id, url: url.href, method: request.method, headers: [...request.headers], body: buffer }))
        .catch(error => fail(new TypeError(error.message)))
    })
  }
  const relayedFetch = async (input, init) => {
    const request = new Request(input, init)
    // The caller's own signal, listened to as it is: a Request's (a clone's above all) follows it through links
    // Node's fetch keeps weakly, so once the first Request was let go a cancel no longer came through.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : request.signal)
    let url = null
    try {
      url = new URL(request.url)
    } catch {
      return direct(request)
    }
    // Not http(s), or this app's own address: as it is.
    if (!/^https?:$/.test(url.protocol) || url.origin === appOrigin) return direct(request)
    if (relayed.has(url.origin)) return relay(request, url, signal)
    const spare = RESENT.includes(request.method) ? request.clone() : null
    try {
      return await direct(request)
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error
      if (spare) return relay(spare, url, signal)
      const note = await call('fetchAllow', { url: url.href }).catch(refusal => {
        throw new TypeError(refusal.message)
      })
      relayed.add(url.origin)
      throw new TypeError(note)
    }
  }
  // Addresses the player allowed after this frame was made (web/app.js askRelay → broadcastRelay).
  relayedFetch.allow = origins => {
    for (const origin of Array.isArray(origins) ? origins : []) if (typeof origin === 'string') relayed.add(origin)
  }
  return relayedFetch
}

/* Runs inside the frame. Self-contained: it is serialised with toString(). `makeFetch` is frameFetch. */
function shimMain(ctx, makeFetch) {
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
    // The chat's state changed (a card saved it, or 编辑状态): the latest floor and the chat variables follow.
    if (data && data.agentTavernState && typeof data.agentTavernState === 'object') {
      ctx.vars.latest = data.agentTavernState.state || {}
      messageVars.set(ctx.lastId, mvuShape(ctx.vars.latest))
      buckets.chat = chatShape()
      eventEmit('mag_variable_update_ended', messageVars.get(ctx.lastId)).catch(() => {})
    }
    // A model call this frame asked for (generate): the text so far, then the end.
    if (data && data.agentTavernStream && data.agentTavernStream.frame === ctx.frame) {
      const { id, full, delta, done } = data.agentTavernStream
      if (delta) {
        eventEmit('js_stream_token_received_incrementally', delta, id).catch(() => {})
        eventEmit('js_stream_token_received_fully', full, id).catch(() => {})
      }
      if (done) eventEmit('js_generation_ended', full, id).catch(() => {})
    }
    // Addresses this card may now reach through the app (see fetch below).
    if (data && Array.isArray(data.agentTavernRelay)) relayedFetch.allow(data.agentTavernRelay)
    // An API call the page made for this frame (see fetch below): its status and headers, the body in pieces, the end.
    if (data && data.agentTavernFetch && data.agentTavernFetch.frame === ctx.frame) {
      const { id, head, chunk, done } = data.agentTavernFetch
      const entry = fetches.get(id)
      if (entry && head) entry.head(head)
      if (entry && chunk) entry.chunk(chunk)
      if (entry && done) entry.done()
    }
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
  const MVU_KEYS = ['stat_data', 'display_data', 'delta_data', 'initialized_lorebooks']
  const mvuShape = state => ({ ...clone(state || {}), stat_data: clone(state || {}), display_data: clone(state || {}), delta_data: {}, initialized_lorebooks: {} })
  const messageVars = new Map((ctx.messages || []).map(m => [m.message_id, mvuShape(m.state)]))
  messageVars.set(ctx.messageId, mvuShape(ctx.vars.message))
  messageVars.set(ctx.lastId, mvuShape(ctx.vars.latest))
  // Chat variables: the latest state (as MVU cards read it there too) under what the card saved for this chat.
  let chatExtras = clone(ctx.vars.chat || {})
  const chatShape = () => merge(mvuShape(ctx.vars.latest), chatExtras)
  const buckets = {
    chat: chatShape(),
    global: clone(ctx.vars.global || {}),
    preset: clone(ctx.vars.preset || {}),
    character: clone(ctx.vars.character || {}),
    script: {},
    extension: {},
  }
  /**
   * The story state a message-variable write means: MVU's `stat_data` when the card
   * changed it, else the plain keys it changed (a card that keeps its variables at
   * the top). null when nothing of the state changed.
   */
  const stateOf = (before, after) => {
    if (!isObject(after)) return null
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    if (isObject(after.stat_data) && !same(after.stat_data, before.stat_data)) return clone(after.stat_data)
    const plain = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !MVU_KEYS.includes(key)))
    return same(plain(after), plain(before)) ? null : plain(after)
  }
  // Saving the latest state waits a moment, so a card writing field by field saves once.
  let pendingState = null
  let stateTimer = 0
  const saveState = state => {
    pendingState = state
    clearTimeout(stateTimer)
    stateTimer = setTimeout(() => {
      const next = pendingState
      pendingState = null
      call('state', { state: next }).catch(error => console.warn('[酒馆] 变量没有保存：', error.message)) // i18n-ignore: for the card's scripts, inside its frame
    }, 250)
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
    if (type === 'message') {
      const id = messageIdOf(option.message_id)
      const before = messageVars.get(id) || {}
      messageVars.set(id, value)
      // The latest floor's state is the chat's state: saved (as 编辑状态 does). Earlier floors have moved on.
      const state = stateOf(before, value)
      if (state && id === ctx.lastId) saveState(state)
      else if (state) console.warn(`[酒馆] 只有最新一楼的变量会保存，第 ${id} 楼的改动只在这个界面里有效`) // i18n-ignore: for the card's scripts, inside its frame
      return
    }
    buckets[type] = value
    if (type === 'chat') {
      // What the card keeps for this chat, without the state mirrored into it.
      const mirrored = new Set([...MVU_KEYS, ...Object.keys(ctx.vars.latest || {})])
      chatExtras = Object.fromEntries(Object.entries(value || {}).filter(([key]) => !mirrored.has(key)))
      post('chatVars', { value: chatExtras })
      return
    }
    // Kept in this browser between renders.
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
        // The opening of a chat nobody has played yet has the card's other openings as its swipes (setChatMessage below).
        const swipes = m.message_id === 0 && ctx.openings > 1 ? Array.from({ length: ctx.openings }, (_x, i) => (i === 0 ? m.message : '')) : [m.message]
        if (option.include_swipes || option.include_swipe) Object.assign(out, { swipe_id: 0, swipes, swipes_data: swipes.map(() => out.data), swipes_info: swipes.map(() => ({})) })
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
  // SillyTavern's event names, as Tavern Helper lists them (cards look them up by key; few ever fire here).
  const tavern_events = Object.fromEntries(
    'APP_READY EXTRAS_CONNECTED MESSAGE_SWIPED MESSAGE_SENT MESSAGE_RECEIVED MESSAGE_EDITED MESSAGE_DELETED MESSAGE_UPDATED MESSAGE_FILE_EMBEDDED MESSAGE_REASONING_EDITED MESSAGE_REASONING_DELETED MESSAGE_SWIPE_DELETED MORE_MESSAGES_LOADED IMPERSONATE_READY GENERATION_STARTED GENERATION_STOPPED GENERATION_ENDED SD_PROMPT_PROCESSING EXTENSIONS_FIRST_LOAD EXTENSION_SETTINGS_LOADED SETTINGS_LOADED SETTINGS_UPDATED MOVABLE_PANELS_RESET SETTINGS_LOADED_BEFORE SETTINGS_LOADED_AFTER CHATCOMPLETION_SOURCE_CHANGED CHATCOMPLETION_MODEL_CHANGED OAI_PRESET_CHANGED_BEFORE OAI_PRESET_CHANGED_AFTER OAI_PRESET_EXPORT_READY OAI_PRESET_IMPORT_READY WORLDINFO_SETTINGS_UPDATED WORLDINFO_UPDATED CHARACTER_EDITOR_OPENED CHARACTER_EDITED CHARACTER_PAGE_LOADED USER_MESSAGE_RENDERED CHARACTER_MESSAGE_RENDERED FORCE_SET_BACKGROUND CHAT_DELETED CHAT_CREATED GENERATE_BEFORE_COMBINE_PROMPTS GENERATE_AFTER_COMBINE_PROMPTS GENERATE_AFTER_DATA WORLD_INFO_ACTIVATED TEXT_COMPLETION_SETTINGS_READY CHAT_COMPLETION_SETTINGS_READY CHAT_COMPLETION_PROMPT_READY CHARACTER_FIRST_MESSAGE_SELECTED CHARACTER_DUPLICATED CHARACTER_RENAMED CHARACTER_RENAMED_IN_PAST_CHAT STREAM_REASONING_DONE FILE_ATTACHMENT_DELETED WORLDINFO_FORCE_ACTIVATE OPEN_CHARACTER_LIBRARY ONLINE_STATUS_CHANGED IMAGE_SWIPED CONNECTION_PROFILE_LOADED CONNECTION_PROFILE_CREATED CONNECTION_PROFILE_DELETED CONNECTION_PROFILE_UPDATED TOOL_CALLS_PERFORMED TOOL_CALLS_RENDERED SECRET_WRITTEN SECRET_DELETED SECRET_ROTATED SECRET_EDITED PRESET_CHANGED PRESET_DELETED PRESET_RENAMED PRESET_RENAMED_BEFORE MAIN_API_CHANGED WORLDINFO_ENTRIES_LOADED WORLDINFO_SCAN_DONE MEDIA_ATTACHMENT_DELETED'
      .split(' ')
      .map(key => [key, key.toLowerCase()]),
  )
  Object.assign(tavern_events, { CHAT_CHANGED: 'chat_id_changed', SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received', STREAM_TOKEN_RECEIVED: 'stream_token_received' })
  const iframe_events = {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_REQUESTED: 'js_generation_requested', GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', REASONING_TOKEN_RECEIVED_FULLY: 'js_reasoning_token_received_fully',
    REASONING_TOKEN_RECEIVED_INCREMENTALLY: 'js_reasoning_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended',
  }

  // ── Toasts, errors, slash commands ──
  const toast = level => (message, title) => post('toast', { level, text: String(message ?? ''), title: title ? String(title) : '' })
  const toastr = { success: toast('success'), info: toast('info'), warning: toast('warning'), error: toast('error'), clear() {}, remove() {}, options: {} }
  const report = error => {
    console.error(error)
    toastr.error(String((error && error.message) || error))
  }
  // As Tavern Helper: show the error, then throw it on to the caller.
  const errorCatched = fn => (...args) => {
    try {
      const result = fn(...args)
      return result && typeof result.catch === 'function'
        ? result.catch(error => {
            report(error)
            throw error
          })
        : result
    } catch (error) {
      report(error)
      throw error
    }
  }
  // Rejects on a command this app does not run, so the card takes its own way round.
  const triggerSlash = command => call('slash', { command: String(command ?? '') })

  // ── Writing messages ──
  // { message_id, message?, data?, swipe_id? }: an unplayed chat's opening switched to another of the
  // card's (a welcome page's swipe), a message's text (this frame's floor or the latest), the latest floor's variables.
  const setMessage = async (item = {}) => {
    const id = messageIdOf(item.message_id)
    if (id === 0 && Number.isInteger(item.swipe_id)) {
      if (item.swipe_id >= ctx.openings) throw new Error(`没有第 ${item.swipe_id} 个开场白，或者对话已经开始`) // i18n-ignore: for the card's scripts, inside its frame
      return call('opening', { index: item.swipe_id })
    }
    if (isObject(item.data)) write({ type: 'message', message_id: id }, clone(item.data))
    if (typeof item.message === 'string') {
      if (id !== ctx.messageId && id !== ctx.lastId) throw new Error('只能改这个界面所在的楼层或最新一楼') // i18n-ignore: for the card's scripts, inside its frame
      await call('editMessage', { messageId: id, text: item.message })
    }
  }

  // ── Worldbooks ──
  const books = { own: '', mounted: [], global: [], ...(ctx.books || {}) }
  const bookNames = () => [...new Set([books.own, ...books.mounted, ...books.global].filter(Boolean))]
  const getWorldbook = async name => call('worldbook', { action: 'get', name: String(name ?? '') })
  const replaceWorldbook = async (name, entries) => call('worldbook', { action: 'replace', name: String(name ?? ''), entries: clone(entries || []) })
  const updateWorldbookWith = async (name, updater) => {
    const entries = await getWorldbook(name)
    const next = (await updater(clone(entries))) ?? entries
    return replaceWorldbook(name, next)
  }
  const createWorldbookEntries = async (name, partials) => {
    const entries = await getWorldbook(name)
    let uid = entries.reduce((max, e) => Math.max(max, Number(e.uid) || 0), -1)
    const fresh = (partials || []).map(p => ({ ...clone(p), uid: ++uid }))
    const worldbook = await replaceWorldbook(name, [...entries, ...fresh])
    const added = new Set(fresh.map(e => e.uid))
    return { worldbook, new_entries: worldbook.filter(e => added.has(e.uid)) }
  }
  const deleteWorldbookEntries = async (name, predicate) => {
    const entries = await getWorldbook(name)
    const marks = entries.map(e => Boolean(predicate(e)))
    const worldbook = await replaceWorldbook(name, entries.filter((_e, i) => !marks[i]))
    return { worldbook, deleted_entries: entries.filter((_e, i) => marks[i]) }
  }
  const deepMerge = (base, change) => {
    const out = clone(base)
    for (const [key, value] of Object.entries(change || {})) out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : clone(value)
    return out
  }
  // The older lorebook entry shape ⇄ today's worldbook entry.
  const legacyOf = (e, index) => ({
    uid: e.uid, display_index: index, comment: e.name, enabled: e.enabled, type: e.strategy?.type ?? 'selective',
    position: e.position?.type ?? 'before_character_definition', depth: e.position?.type === 'at_depth' ? e.position.depth : null, order: e.position?.order ?? 100,
    probability: e.probability ?? 100, keys: e.strategy?.keys ?? [], logic: e.strategy?.keys_secondary?.logic ?? 'and_any', filters: e.strategy?.keys_secondary?.keys ?? [],
    scan_depth: e.strategy?.scan_depth ?? 'same_as_global', case_sensitive: 'same_as_global', match_whole_words: 'same_as_global', use_group_scoring: 'same_as_global',
    automation_id: null, exclude_recursion: Boolean(e.recursion?.prevent_incoming), prevent_recursion: Boolean(e.recursion?.prevent_outgoing), delay_until_recursion: e.recursion?.delay_until ?? false,
    content: e.content ?? '', group: '', group_prioritized: false, group_weight: 100, sticky: e.effect?.sticky ?? null, cooldown: e.effect?.cooldown ?? null, delay: e.effect?.delay ?? null,
  })
  const fromLegacy = l => {
    const out = {}
    if (l.uid !== undefined) out.uid = Number(l.uid)
    if (l.comment !== undefined) out.name = l.comment
    if (l.enabled !== undefined) out.enabled = l.enabled
    if (l.content !== undefined) out.content = l.content
    if (l.probability !== undefined) out.probability = l.probability
    const strategy = {}
    if (l.type !== undefined) strategy.type = l.type
    if (l.keys !== undefined) strategy.keys = l.keys
    if (l.scan_depth !== undefined) strategy.scan_depth = l.scan_depth
    if (l.logic !== undefined || l.filters !== undefined) strategy.keys_secondary = { ...(l.logic !== undefined ? { logic: l.logic } : {}), ...(l.filters !== undefined ? { keys: l.filters } : {}) }
    if (Object.keys(strategy).length) out.strategy = strategy
    const position = {}
    if (l.position !== undefined) position.type = l.position
    if (l.depth !== undefined && l.depth !== null) position.depth = l.depth
    if (l.order !== undefined) position.order = l.order
    if (Object.keys(position).length) out.position = position
    return out
  }

  // ── Model calls ──
  let generations = 0
  const generate = async (config = {}, raw = false) => {
    if (config.custom_api && (config.custom_api.apiurl || config.custom_api.proxy_preset || config.custom_api.key)) throw new Error('酒馆不支持 custom_api：只用你在酒馆里选的模型') // i18n-ignore: for the card's scripts, inside its frame
    if (config.tools || config.json_schema || config.image) throw new Error('酒馆的 generate 不支持 tools、json_schema 和图片') // i18n-ignore: for the card's scripts, inside its frame
    const id = String(config.generation_id || `cica-${Date.now().toString(36)}-${++generations}`)
    await eventEmit('js_generation_requested', id, raw ? 'generateRaw' : 'generate', config)
    eventEmit('js_generation_started', id).catch(() => {})
    const strings = value => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) : {})
    return call('generate', {
      id,
      raw,
      config: {
        user_input: typeof config.user_input === 'string' ? config.user_input : '',
        should_stream: config.should_stream === true,
        max_chat_history: Number.isInteger(config.max_chat_history) ? config.max_chat_history : null,
        ordered_prompts: raw && Array.isArray(config.ordered_prompts) ? config.ordered_prompts.map(p => (typeof p === 'string' ? p : { role: String(p?.role ?? 'system'), content: String(p?.content ?? '') })) : null,
        overrides: strings(config.overrides),
      },
    })
  }

  // ── Direct API calls: straight out first, the page as a way round (frameFetch) ──
  const fetches = new Map()
  const relayedFetch = makeFetch({ direct: window.fetch.bind(window), post, call, fetches, frame: ctx.frame, appOrigin: ctx.appOrigin, relayed: ctx.relay })
  window.fetch = relayedFetch

  // ── MVU ──
  const Mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData: option => getVariables(option || { type: 'message', message_id: 'latest' }),
    replaceMvuData: async (data, option) => replaceVariables(data, option || { type: 'message', message_id: 'latest' }),
    // The update commands in `message` applied to `oldData`, by the app's own parser; nothing is saved.
    parseMessage: async (message, oldData) => {
      const before = isObject(oldData?.stat_data) ? oldData.stat_data : oldData || {}
      const { state } = await call('mvuParse', { text: String(message ?? ''), state: before })
      return { ...clone(oldData || {}), stat_data: state, display_data: clone(state), delta_data: {} }
    },
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
    // ── Messages the card writes: this chat only ──
    setChatMessages: async list => {
      for (const item of Array.isArray(list) ? list : []) await setMessage(item)
    },
    setChatMessage: (values, messageId, option = {}) =>
      setMessage({ ...(typeof values === 'string' ? { message: values } : values || {}), message_id: messageId, ...(Number.isInteger(option?.swipe_id) ? { swipe_id: option.swipe_id } : {}) }),
    // The player's messages (a creation screen's sheet, a fight log) go into the input box, for the card's
    // /trigger to send as the turn; messages from the character are added to the chat as they are.
    createChatMessages: async messages => {
      const list = (Array.isArray(messages) ? messages : []).filter(m => m && typeof m.message === 'string')
      if (!list.length) return
      if (list.every(m => m.role === 'user')) return call('input', { text: list.map(m => m.message).join('\n\n') })
      return call('createMessages', { messages: list.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.message })) })
    },
    // Only the last messages, folded away as 回滚 does (they can be brought back).
    deleteChatMessages: async ids => call('deleteMessages', { ids: (Array.isArray(ids) ? ids : [ids]).map(id => messageIdOf(id)) }),
    rotateChatMessages: unsupported('rotateChatMessages'),

    // ── Worldbooks: the books this chat uses; what a card writes is kept for this chat ──
    getWorldbookNames: () => bookNames(),
    getGlobalWorldbookNames: () => [...books.global],
    getCharWorldbookNames: () => ({ primary: books.own || null, additional: [...books.mounted] }),
    getChatWorldbookName: () => null,
    getWorldbook,
    replaceWorldbook: async (name, entries) => void (await replaceWorldbook(name, entries)),
    updateWorldbookWith,
    createWorldbookEntries,
    deleteWorldbookEntries,
    createWorldbook: unsupported('createWorldbook'),
    createOrReplaceWorldbook: unsupported('createOrReplaceWorldbook'),
    deleteWorldbook: unsupported('deleteWorldbook'),
    rebindGlobalWorldbooks: unsupported('rebindGlobalWorldbooks'),
    rebindCharWorldbooks: unsupported('rebindCharWorldbooks'),
    rebindChatWorldbook: unsupported('rebindChatWorldbook'),
    getOrCreateChatWorldbook: unsupported('getOrCreateChatWorldbook'),
    // The older lorebook names for the same books.
    getLorebooks: () => bookNames(),
    getCharLorebooks: () => ({ primary: books.own || null, additional: [...books.mounted] }),
    getCurrentCharPrimaryLorebook: () => books.own || null,
    getChatLorebook: () => null,
    getLorebookEntries: async name => (await getWorldbook(name)).map(legacyOf),
    replaceLorebookEntries: async (name, entries) => void (await replaceWorldbook(name, (entries || []).map(fromLegacy))),
    updateLorebookEntriesWith: async (name, updater) => (await updateWorldbookWith(name, async list => ((await updater(list.map(legacyOf))) || []).map(fromLegacy))).map(legacyOf),
    setLorebookEntries: async (name, entries) => {
      const changes = new Map((entries || []).filter(e => e && e.uid !== undefined).map(e => [Number(e.uid), fromLegacy(e)]))
      await updateWorldbookWith(name, list => list.map(e => (changes.has(e.uid) ? deepMerge(e, changes.get(e.uid)) : e)))
    },
    createLorebookEntries: async (name, entries) => {
      const { worldbook, new_entries } = await createWorldbookEntries(name, (entries || []).map(fromLegacy))
      return { entries: worldbook.map(legacyOf), new_uids: new_entries.map(e => e.uid) }
    },
    deleteLorebookEntries: async (name, uids) => {
      const drop = new Set((uids || []).map(Number))
      const { worldbook, deleted_entries } = await deleteWorldbookEntries(name, e => drop.has(e.uid))
      return { entries: worldbook.map(legacyOf), delete_occurred: deleted_entries.length > 0 }
    },

    // ── Model calls the card asks for (the user allows each card once) ──
    generate: config => generate(config, false),
    generateRaw: config => generate(config, true),
    stopGenerationById: id => call('stopGenerate', { id: String(id) }).then(() => true, () => false),
    stopAllGeneration: () => call('stopGenerate', {}).then(() => true, () => false),

    // ── Who is playing: read-only ──
    getCharacterNames: () => [ctx.names.char],
    getCharacterIds: () => [ctx.cardId],
    getCurrentCharacterName: () => ctx.names.char,
    getCurrentCharacterId: () => ctx.cardId,
    getCharAvatarPath: () => ctx.card?.avatar || '',
    getCharacter: async () => ({ name: ctx.names.char, avatar: ctx.card?.avatar || '' }),
    getCharData: () => ({ name: ctx.names.char, avatar: ctx.card?.avatar || '', data: { name: ctx.names.char } }),
    getPersonaNames: () => [ctx.names.user],
    getPersonaIds: () => ['user'],
    getCurrentPersonaName: () => ctx.names.user,
    getCurrentPersonaId: () => 'user',
    getPersona: async () => ({ name: ctx.names.user, title: '', description: ctx.persona?.description || '' }),
    getPersonaAvatarPath: () => '',
    createPersona: unsupported('createPersona'),
    createOrReplacePersona: unsupported('createOrReplacePersona'),
    replacePersona: unsupported('replacePersona'),
    updatePersonaWith: unsupported('updatePersonaWith'),
    deletePersona: unsupported('deletePersona'),

    triggerSlashWithResult: triggerSlash,
    getAllEnabledScriptButtons: () => ({}),
    getScriptTrees: () => [],
    builtin: {
      uuidv4: () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`),
      parseRegexFromString: text => {
        const match = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(String(text))
        try {
          return match ? new RegExp(match[1], match[2]) : null
        } catch {
          return null
        }
      },
      duringGenerating: () => false,
    },
  }
  // Floor ids as indexes, as SillyTavern's chat array has them (floors not handed to this frame stay empty).
  const chat = []
  for (const m of ctx.messages || []) chat[m.message_id] = { name: m.name, is_user: m.role === 'user', is_system: false, mes: m.message }
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
  // 提示词模板 (ST-Prompt-Template): the app runs the same templates (world book entries and presets before a
  // turn, a reply once written, what messages show), so a card looking for the plugin finds it. Code is rendered
  // by the app with this floor's variables; a context passed in is not used. Features are what the app does.
  const EJS_FEATURES = {
    enabled: true, generate_enabled: true, generate_loader_enabled: false, inject_loader_enabled: false,
    render_enabled: true, render_loader_enabled: false, raw_message_evaluation_enabled: true, filter_message_enabled: false,
    code_blocks_enabled: false, depth_limit: -1, preload_worldinfo_enabled: true, preload_only: true, invert_enabled: true,
    autosave_enabled: true, with_context_disabled: false, sandbox: true, compile_workers: false,
    cache_enabled: 0, cache_size: 64, cache_hasher: 'h32ToString', debug_enabled: false, code_editor: false,
  }
  let ejsFeatures = { ...EJS_FEATURES }
  const allVariables = () => merge(merge(clone(buckets.global), clone(buckets.chat)), clone(messageVars.get(ctx.messageId) || {}))
  const EjsTemplate = {
    evalTemplate: async code => (await call('ejs', { code: String(code ?? ''), messageId: ctx.messageId })).text,
    getSyntaxErrorInfo: async code => (await call('ejs', { code: String(code ?? ''), check: true })).error || '',
    prepareContext: async context => ({ ...allVariables(), ...(isObject(context) ? context : {}) }),
    allVariables,
    saveVariables: async () => {}, // variable writes are saved as they happen
    getFeatures: () => ({ ...ejsFeatures }),
    setFeatures: features => { ejsFeatures = { ...ejsFeatures, ...(isObject(features) ? features : {}) } }, // this frame only
    resetFeatures: () => { ejsFeatures = { ...EJS_FEATURES } },
  }
  // Which app this is, for cards that want to know; no Tavern Helper version is claimed (it would promise all of it).
  const CicaTavern = { compat: { app: ctx.app || '', target: 'Tavern Helper 4.x, in part', functions: Object.keys(helper).sort() } }
  Object.assign(window, helper, { TavernHelper, SillyTavern, Mvu, EjsTemplate, toastr, tavern_events, iframe_events, CicaTavern })
  // Tavern Helper's avatar classes.
  if (ctx.card?.avatar) {
    const style = document.createElement('style')
    style.textContent = `.char_avatar,.char-avatar{background-image:url(${JSON.stringify(ctx.card.avatar)})}`
    document.head?.append(style)
  }

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
  // `parent.$('#send_textarea')`: cards that drive SillyTavern's input with its jQuery get our
  // input box and send button; any other selector is this frame's own jQuery.
  const hostQuery = selector => {
    const found = typeof selector === 'string' ? hostElement(selector) : null
    if (!found) return typeof window.jQuery === 'function' ? window.jQuery(selector) : { length: 0, val: () => '', trigger() { return this }, prop: () => undefined, focus() { return this } }
    const wrapped = {
      length: 1,
      0: found,
      val(value) {
        if (value === undefined) return found.value ?? ''
        found.value = value
        return wrapped
      },
      trigger(type) {
        if (type === 'click') found.click()
        return wrapped
      },
      click() {
        found.click()
        return wrapped
      },
      prop: name => (name === 'disabled' ? false : found[name]),
      attr: name => found.getAttribute(name),
      focus: () => wrapped,
      blur: () => wrapped,
      on: () => wrapped,
      off: () => wrapped,
      each(fn) {
        fn.call(found, 0, found)
        return wrapped
      },
    }
    return wrapped
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
      if (key === '$' || key === 'jQuery') return hostQuery
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
  // A page the card brings in later ($('body').load(url)) has its own `height: 100vh`: in a
  // frame that grows with its content, that is the frame itself, so it would grow without end.
  // Pin those to the page's viewport, as the message's own HTML is (replaceViewportHeight).
  const pinVh = css =>
    css.replace(/((?:^|[;{\s"'])(?:min-)?height\s*:\s*)([^;{}"']*?\d(?:\.\d+)?vh\b[^;{}"']*)/gi, (_, prefix, value) =>
      prefix + value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (_m, n) => (parseFloat(n) === 100 ? 'var(--TH-viewport-height)' : `calc(var(--TH-viewport-height) * ${parseFloat(n) / 100})`)))
  const pinTree = node => {
    if (node.nodeType !== 1) return
    for (const el of [node, ...node.querySelectorAll('style, [style]')]) {
      if (el.tagName === 'STYLE') {
        const next = pinVh(el.textContent)
        if (next !== el.textContent) el.textContent = next
      } else if (el.hasAttribute('style')) {
        const style = el.getAttribute('style')
        const next = pinVh(style)
        if (next !== style) el.setAttribute('style', next)
      }
    }
  }
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) pinTree(node)
  }).observe(document.documentElement, { childList: true, subtree: true })
}

/**
 * Host side: answers frames that are ours. `handlers.slash(command, context)` runs a
 * slash command (resolves to its output), `handlers.input(text)` fills the
 * input box, `handlers.send(context)` sends it, `handlers.toast(level, text)` shows a
 * toast, `handlers.opening(index)` switches an unplayed chat to another opening;
 * `ids()` returns the current { presetId, cardId } for saving variables. `context`
 * is { frame, window, card, clicked }: who asked, and whether right after a click in it.
 */
export function installFrameBridge(handlers) {
  // What the frames may ask the page for, each answered with its result (handlers in web/app.js).
  const ANSWERED = ['state', 'chatVars', 'mvuParse', 'editMessage', 'createMessages', 'deleteMessages', 'worldbook', 'generate', 'stopGenerate', 'ejs', 'fetch', 'fetchCancel', 'fetchAllow']
  window.addEventListener('message', async event => {
    const data = event.data
    const id = data?.agentTavernCall
    if (typeof id !== 'string') return
    const frame = document.querySelector(`iframe[data-frame="${CSS.escape(id)}"]`)
    if (!frame || event.source !== frame.contentWindow) return
    const reply = (ok, value) => data.id && event.source.postMessage({ agentTavernReply: id, id: data.id, ok, value: ok ? value : undefined, error: ok ? undefined : String(value) }, '*')
    const args = data.args ?? {}
    // Who asks: the frame's id and window, the card it was made for (render.js htmlFrame), never one it names
    // itself, and whether the player just clicked in it: the click's activation reaches this page and the frame
    // has the focus (a click on the page's own buttons takes it away). Taken now, before a step such as /setinput
    // moves the focus. What a card may do without a click is asked per card (web/shared/frame-permissions.js).
    const clicked = navigator.userActivation?.isActive === true && document.activeElement === frame
    const context = { frame: id, window: event.source, card: frame.dataset.card || null, clicked }
    try {
      if (data.op === 'toast') handlers.toast(args.level, [args.title, args.text].filter(Boolean).join('：')) // i18n-ignore: a card script's own toast
      else if (data.op === 'input') {
        handlers.input(String(args.text ?? ''))
        reply(true)
      } else if (data.op === 'send') {
        await handlers.send(context)
        reply(true)
      } else if (data.op === 'slash') reply(true, await handlers.slash(String(args.command ?? ''), context))
      else if (data.op === 'opening') reply(true, await handlers.opening(Number(args.index)))
      else if (ANSWERED.includes(data.op)) reply(true, await handlers[data.op](args, context))
      else if (data.op === 'storage') {
        // Kept under the card the frame was made for (render.js htmlFrame), never one it names itself.
        if (frame.dataset.card) saveFrameStorage(frame.dataset.card, args.key, args.value)
      } else if (data.op === 'vars') {
        const value = args.value && typeof args.value === 'object' ? args.value : {}
        // Global variables are the app's (templates share them); preset and character ones stay in this browser.
        if (args.type === 'global') await handlers.globalVars(value)
        else saveVariables(args.type, handlers.ids(), value)
      }
    } catch (error) {
      reply(false, error?.message ?? error)
    }
  })
}

/** Tell every card frame the chat's state changed, so the latest floor's variables and MVU listeners follow. */
export function broadcastState(state) {
  for (const frame of document.querySelectorAll('iframe.card-frame')) frame.contentWindow?.postMessage({ agentTavernState: { state } }, '*')
}

/** Tell every card frame the addresses its card may now reach through the app (frameFetch's `allow`). */
export function broadcastRelay(origins) {
  for (const frame of document.querySelectorAll('iframe.card-frame')) frame.contentWindow?.postMessage({ agentTavernRelay: origins }, '*')
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
