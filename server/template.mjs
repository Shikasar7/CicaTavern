// EJS templates (ST-Prompt-Template style) evaluated inside a QuickJS
// WebAssembly sandbox: no filesystem, network, process or host objects, a time
// limit and a memory limit. Card code never runs in the Node process.
//
// A turn renders its templates in one session (templateSession): one sandbox
// where `define()` and variable writes carry from one template to the next, as
// they do in SillyTavern. Variables are read as the plugin merges them (global,
// initial, chat-wide, the chat state, then this session's own) and the writes
// come back out (writes()), for the caller to save. Templates run async, so
// `await getwi(…)` pulls another entry in (rendered as a template too); an
// entry's text, a message's text and the card's fields come from the host on
// demand, while matching titles (patterns, as ST-Prompt-Template matches them)
// stays in the sandbox under the time limit.
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

const TIME_LIMIT_MS = 200
const MEMORY_LIMIT = 32 * 1024 * 1024
// How much of each message getChatMessages / matchChatMessages hand a template.
const MESSAGE_CHARS = 20000
// Rounds of getPromptsInjected placeholders inside injected text.
const OUTLET_ROUNDS = 10
let quickjs = null

export async function initTemplates() {
  quickjs ??= await getQuickJS()
}

const EJS = /<%[\s\S]*?%>/

/** Whether a message or prompt text holds EJS (no decorators: those belong to worldbook entries). */
export function hasEjs(text) {
  return EJS.test(String(text ?? ''))
}

export function hasTemplate(text) {
  return hasEjs(text) || splitDecorators(text).condition !== null
}

/** Text with its EJS taken out: what is kept when a template fails. */
export function stripTemplates(text) {
  return String(text ?? '').replace(/<%[\s\S]*?%>/g, '')
}

/**
 * ST-Prompt-Template decorators: `@@name …` lines at the top of an entry.
 * `@@if <expr>` becomes a condition on the whole entry; the others are dropped
 * here (decoratorsOf says which an entry has). A line starting `@@@` ends the
 * decorators and stays as text with one `@` less.
 * Also runs inside the sandbox (as source text): it uses nothing from outside.
 */
export function splitDecorators(text) {
  const lines = String(text ?? '').split('\n')
  const conditions = []
  while (lines.length) {
    if (/^\s*@@@/.test(lines[0])) {
      lines[0] = lines[0].replace('@@@', '@@')
      break
    }
    if (!/^\s*@@\w/.test(lines[0])) break
    const condition = /^\s*@@if\s+(.+?)\s*$/.exec(lines.shift())
    if (condition) conditions.push(`(${condition[1]})`)
  }
  return { body: lines.join('\n'), condition: conditions.length ? conditions.join(' && ') : null }
}

/** The decorator names at the top of an entry (`@@activate`, `@@preload`…), without their arguments. */
export function decoratorsOf(text) {
  const names = new Set()
  const source = String(text ?? '')
  if (!/^\s*@@/.test(source)) return names
  for (const line of source.split('\n')) {
    if (/^\s*@@@/.test(line) || !/^\s*@@\w/.test(line)) break
    names.add(line.trim().split(/\s/)[0])
  }
  return names
}

/**
 * Template text inside reasoning blocks (<thinking>, <think>, <reasoning>) is
 * kept as written, as ST-Prompt-Template keeps it when it runs a message.
 */
export function escapeReasoning(text) {
  return String(text ?? '').replace(/<(thinking|think|reasoning)>[\s\S]*?<\/\1>/gi, block => block.replace(/<%(?!%)/g, '<%%'))
}

/**
 * Compile EJS into a JS function body that returns the rendered string.
 * Supports <% %>, <%_ _%> / -%> whitespace control, <%= %> and <%- %> output
 * (both unescaped: the output is prompt text, not HTML), <%# %> comments and <%% literals.
 * Also runs inside the sandbox (as source text).
 */
export function compileEjs(template) {
  const code = ['let __out = "";', 'const print = (...a) => { __out += a.join(""); };']
  const re = /<%(%|#|_|=|-)?([\s\S]*?)([-_])?%>/g
  let last = 0
  let trimNext = null
  const pushText = text => {
    if (trimNext === '-') text = text.replace(/^\r?\n/, '')
    if (trimNext === '_') text = text.replace(/^[ \t]*\r?\n?/, '')
    trimNext = null
    if (text) code.push(`__out += ${JSON.stringify(text)};`)
  }
  for (const match of template.matchAll(re)) {
    const [whole, kind, body, closer] = match
    let text = template.slice(last, match.index)
    if (kind === '_') text = text.replace(/[ \t]+$/, '')
    pushText(text)
    last = match.index + whole.length
    if (kind === '%') {
      code.push(`__out += ${JSON.stringify(`<%${body}${closer ?? ''}%>`)};`)
    } else if (kind === '=' || kind === '-') {
      code.push(`__out += __str(${body.trim()});`)
    } else if (kind !== '#') {
      code.push(body)
    }
    trimNext = closer ?? null
  }
  pushText(template.slice(last))
  code.push('return __out;')
  return code.join('\n')
}

const AsyncFunction = (async () => {}).constructor

/** What is wrong with a template's code ('' when it compiles); only parsed, never run (EjsTemplate.getSyntaxErrorInfo). */
export function templateSyntaxError(template) {
  try {
    AsyncFunction(compileEjs(String(template ?? '')))
    return ''
  } catch (error) {
    return error instanceof SyntaxError ? error.message : String(error?.message ?? error)
  }
}

// ST-Prompt-Template's DEFAULT_CHAR_DEFINE: how getchar lays a card out by default.
const DEFAULT_CHAR_DEFINE = [
  '<% if (name) { %><<%- name %>>',
  '<% if (system_prompt) { %>System: <%- system_prompt %>',
  '<% } %>name: <%- name %>',
  '<% if (personality) { %>personality: <%- personality %>',
  '<% } %><% if (description) { %>description: <%- description %>',
  '<% } %><% if (message_example) { %>example:',
  '<%- message_example %>',
  '<% } %><% if (depth_prompt) { %>System: <%- depth_prompt %>',
  '<% } %></<%- name %>><% } %>',
].join('\n')

/**
 * What a template can call, under ST-Prompt-Template's names. It runs inside
 * the sandbox (turned into source text), so it uses only what the setup script
 * defines (__in, __books, __msgCount, __msgRoles, __names, __ctx, __presetNames)
 * and the host functions (__wi, __msg, __kw, __card, __pp). What only
 * SillyTavern itself can do (slash commands, regex switches, quick replies)
 * does nothing.
 */
function prelude(DEFAULT_CHAR_DEFINE) {
  const __plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && !(v instanceof Date) && !(v instanceof Map) && !(v instanceof Set)
  const __clone = v => (Array.isArray(v) ? v.map(__clone) : __plain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, __clone(x)])) : v)
  const __own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
  const __keys = path => (Array.isArray(path) ? path.map(String) : typeof path === 'number' ? [String(path)] : String(path).replace(/\[["']?([^\]"']*)["']?\]/g, '.$1').split('.').filter(Boolean))
  const __get = (root, path) => {
    let c = root
    for (const k of __keys(path)) {
      if (c === null || c === undefined || (typeof c !== 'object' && typeof c !== 'function' && typeof c !== 'string')) return undefined
      c = c[k]
    }
    return c
  }
  const __set = (root, path, value) => {
    const keys = __keys(path)
    if (!keys.length) return value
    let c = root
    keys.slice(0, -1).forEach((k, i) => {
      if (c[k] === null || typeof c[k] !== 'object') c[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}
      c = c[k]
    })
    c[keys[keys.length - 1]] = value
    return value
  }
  const __has = (root, path) => {
    const keys = __keys(path)
    let c = root
    for (const k of keys) {
      if (!__own(c, k)) return false
      c = c[k]
    }
    return keys.length > 0
  }
  const __unset = (root, path) => {
    const keys = __keys(path)
    const parent = keys.length > 1 ? __get(root, keys.slice(0, -1)) : root
    if (parent !== null && typeof parent === 'object' && keys.length) delete parent[keys[keys.length - 1]]
  }
  // The chat state answers both at the root and under `stat_data` (MVU's
  // paths): one object, so `getvar('好感度')` and `getvar('stat_data.好感度')`
  // read and write the same value. Not enumerable, so printing it does not loop.
  const __alias = obj => {
    if (!__own(obj, 'stat_data')) {
      Object.defineProperty(obj, 'stat_data', {
        get: () => obj,
        set: v => {
          for (const k of Object.keys(obj)) delete obj[k]
          if (__plain(v)) Object.assign(obj, v)
        },
        enumerable: false,
        configurable: true,
      })
    }
    return obj
  }
  const __scopes = { message: __alias(__in.message), local: __in.local, global: __in.global, initial: __in.initial }
  // What reads see: the stores merged as the plugin merges them, plus this session's writes.
  const __cache = __alias(Object.assign({}, __clone(__in.global), __clone(__in.initial), __clone(__in.local), __clone(__in.message)))
  let __writable = true

  const __opts = o => {
    if (typeof o === 'string') {
      if (['old', 'new', 'fullcache'].includes(o)) return { results: o }
      if (['nx', 'xx', 'nxs', 'xxs', 'n'].includes(o)) return { flags: o }
      if (['cache', 'global', 'local', 'message', 'initial'].includes(o)) return { scope: o, inscope: o, outscope: o }
      return {}
    }
    if (typeof o === 'boolean') return { dryRun: o }
    return o !== null && typeof o === 'object' ? o : {}
  }
  const __root = scope => (scope && scope !== 'cache' && __scopes[scope] ? __scopes[scope] : __cache)
  const __at = (root, key) => (key === undefined || key === null || key === '' ? root : __get(root, key))
  const __put = (root, key, value) => {
    if (key === undefined || key === null || key === '') {
      if (value === undefined) for (const k of Object.keys(root)) delete root[k]
      else if (__plain(value)) Object.assign(root, value)
    } else if (value === undefined) __unset(root, key)
    else __set(root, key, value)
  }
  const __index = index => (Number.isNaN(Number(index)) ? index : [String(Number(index))])
  const __container = v => {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return undefined
    }
  }
  const __mergeValue = (old, value) =>
    (old === undefined || Array.isArray(old)) && Array.isArray(value) ? [...(old ?? []), ...value] : __mergeInto(__clone(__plain(old) ? old : {}), value)
  const __mergeInto = (target, source) => {
    if (!__plain(source)) return source
    for (const [k, v] of Object.entries(source)) target[k] = __plain(v) && __plain(target[k]) ? __mergeInto(target[k], v) : __clone(v)
    return target
  }

  function getvar(key, options) {
    const o = __opts(options)
    const root = __root(o.scope)
    let value = __at(root, key)
    if (o.index !== undefined && o.index !== null) {
      const data = __container(value)
      value = data !== null && typeof data === 'object' ? __get(data, __index(o.index)) : undefined
    }
    if (value === undefined) value = o.defaults
    return o.clone ? __clone(value) : value
  }

  function setvar(key, value, options) {
    const o = __opts(options)
    if (!__writable && !o.dryRun) return undefined
    // Writes during preload stay in this session only.
    let scope = o.scope === 'cache' ? 'cache' : o.scope && __scopes[o.scope] ? o.scope : 'message'
    if (!__writable) scope = 'cache'
    const exists = root => (key === undefined || key === null || key === '' ? Object.keys(root).length > 0 : __has(root, key))
    let old
    let next = value
    if (o.index !== undefined && o.index !== null) {
      const index = __index(o.index)
      const raw = __at(__cache, key)
      const data = __container(raw) ?? {}
      const has = data !== null && typeof data === 'object' && __has(data, index)
      if (o.flags === 'nx' && has) return undefined
      if (o.flags === 'xx' && !has) return undefined
      if (o.flags === 'nxs' && getvar(key, { scope: o.scope, index: o.index }) !== undefined) return undefined
      if (o.flags === 'xxs' && getvar(key, { scope: o.scope, index: o.index }) === undefined) return undefined
      old = __get(data, index)
      if (o.merge) next = __mergeValue(old, value)
      const write = root => {
        const before = __at(root, key)
        const box = __clone(__container(before) ?? {})
        __put(box, index, next)
        __put(root, key, typeof before === 'string' ? JSON.stringify(box) : box)
      }
      write(__cache)
      if (scope !== 'cache') write(__scopes[scope])
    } else {
      if (o.flags === 'nx' && exists(__cache)) return undefined
      if (o.flags === 'xx' && !exists(__cache)) return undefined
      if (o.flags === 'nxs' && getvar(key, { scope: o.scope }) !== undefined) return undefined
      if (o.flags === 'xxs' && getvar(key, { scope: o.scope }) === undefined) return undefined
      old = __at(__cache, key)
      if (o.merge) next = __mergeValue(old, value)
      __put(__cache, key, next)
      if (scope !== 'cache') __put(__scopes[scope], key, next)
    }
    return o.results === 'old' ? old : o.results === 'fullcache' ? __cache : next
  }

  function incvar(key, value = 1, options) {
    const o = __opts(options)
    const read = { index: o.index, scope: o.inscope }
    const there = getvar(key, read) !== undefined
    if ((o.flags === 'nx' || o.flags === 'nxs') && there) return undefined
    if ((o.flags === 'xx' || o.flags === 'xxs') && !there) return undefined
    let next = (Number(getvar(key, { ...read, defaults: o.defaults || 0 })) || 0) + Number(value)
    if (o.min !== undefined && o.min !== null) next = Math.max(next, o.min)
    if (o.max !== undefined && o.max !== null) next = Math.min(next, o.max)
    return setvar(key, next, { index: o.index, results: o.results, dryRun: o.dryRun, scope: o.outscope, flags: 'n' })
  }
  const decvar = (key, value = 1, options) => incvar(key, -Number(value), options)

  // Without an index the variable goes; with one, that element, key or substring.
  function delvar(key, index, options) {
    const o = __opts(options)
    if (index === undefined || index === null) return setvar(key, undefined, o)
    const value = __clone(getvar(key, o))
    if (Array.isArray(value)) {
      const at = value.indexOf(index)
      if (at < 0) return undefined
      value.splice(at, 1)
    } else if (value !== null && typeof value === 'object') {
      delete value[String(index)]
    } else if (typeof value === 'string' && typeof index === 'string') {
      const at = value.indexOf(index)
      if (at < 0) return undefined
      return setvar(key, value.slice(0, at) + value.slice(at + index.length), o)
    } else return undefined
    return setvar(key, value, o)
  }

  function insvar(key, value, index, options) {
    const o = __opts(options)
    let current = __clone(getvar(key, o))
    if (Array.isArray(current)) {
      if (index === undefined || index === null) current.push(value)
      else current.splice(Number(index) < 0 ? current.length + Number(index) : Number(index), 0, value)
    } else if (current !== null && typeof current === 'object' && index !== undefined && index !== null) {
      const exists = __own(current, String(index))
      if (String(o.flags ?? '').includes('nx') && exists) return undefined
      if (String(o.flags ?? '').includes('xx') && !exists) return undefined
      current[String(index)] = value
    } else if (typeof current === 'string') {
      const text = String(value)
      if (index === undefined || index === null) current += text
      else if (typeof index === 'string') {
        const at = current.indexOf(index)
        if (at < 0) return undefined
        current = current.slice(0, at) + text + current.slice(at + text.length)
      } else {
        const at = Number(index) < 0 ? current.length + Number(index) : Number(index)
        current = current.slice(0, at) + text + current.slice(at)
      }
    } else return undefined
    return setvar(key, current, o)
  }

  const withScope = (scope, field = 'scope') => o => ({ ...__opts(o), [field]: scope })

  // RFC 6902 on a copy (ST-Prompt-Template's jsonPatch); a failed `test` returns the document unchanged.
  function jsonPatch(doc, patches) {
    let out = __clone(doc)
    const path = pointer => String(pointer ?? '').replace(/^\//, '').split('/').filter((k, i, all) => all.length > 1 || k !== '').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    for (const patch of Array.isArray(patches) ? patches : []) {
      if (!patch || typeof patch !== 'object') continue
      const keys = path(patch.path)
      if (!keys.length) {
        if (['add', 'replace', 'set', 'assign'].includes(patch.op)) out = __clone(patch.value)
        continue
      }
      switch (patch.op) {
        case 'set':
        case 'assign':
        case 'add':
        case 'replace': {
          if (keys[keys.length - 1] === '-') {
            const parent = __get(out, keys.slice(0, -1))
            if (Array.isArray(parent)) parent.push(__clone(patch.value))
          } else if (patch.op === 'add' && Array.isArray(__get(out, keys.slice(0, -1))) && /^\d+$/.test(keys[keys.length - 1])) {
            __get(out, keys.slice(0, -1)).splice(Number(keys[keys.length - 1]), 0, __clone(patch.value))
          } else __set(out, keys, __clone(patch.value))
          break
        }
        case 'remove': {
          const parent = __get(out, keys.slice(0, -1))
          if (Array.isArray(parent)) parent.splice(Number(keys[keys.length - 1]), 1)
          else __unset(out, keys)
          break
        }
        case 'move':
        case 'copy': {
          const from = path(patch.from)
          const value = __clone(__get(out, from))
          if (value === undefined) break
          if (patch.op === 'move') __unset(out, from)
          __set(out, keys, value)
          break
        }
        case 'test':
          if (JSON.stringify(__get(out, keys)) !== JSON.stringify(patch.value)) return doc
          break
      }
    }
    return out
  }

  // JSON as models and authors write it: comments, single quotes, bare keys,
  // trailing commas, Python's True/False/None, a missing close at the end, a code fence.
  function parseJSON(text) {
    if (typeof text !== 'string') return text ?? null
    try {
      return JSON.parse(text)
    } catch {
      // repaired below
    }
    const src = text.trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '')
    let out = ''
    const stack = []
    let i = 0
    const word = { true: 'true', false: 'false', null: 'null', True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null' }
    while (i < src.length) {
      const c = src[i]
      if (c === '"' || c === "'") {
        let j = i + 1
        let body = ''
        while (j < src.length && src[j] !== c) {
          if (src[j] === '\\' && j + 1 < src.length) {
            body += src[j + 1] === "'" ? "'" : src[j] + src[j + 1]
            j += 2
          } else {
            body += src[j] === '"' ? '\\"' : src[j] === '\n' ? '\\n' : src[j]
            j++
          }
        }
        out += `"${body}"`
        i = j + 1
      } else if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2)
        i = end < 0 ? src.length : end + 2
      } else if (c === '{' || c === '[') {
        stack.push(c === '{' ? '}' : ']')
        out += c
        i++
      } else if (c === '}' || c === ']') {
        out = out.replace(/,\s*$/, '')
        stack.pop()
        out += c
        i++
      } else if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) >= 0xc0) {
        // A bare word: a key when a colon follows, else a literal or a string.
        let j = i
        while (j < src.length && (/[\w$-]/.test(src[j]) || src.charCodeAt(j) >= 0xc0)) j++
        const token = src.slice(i, j)
        let k = j
        while (k < src.length && /\s/.test(src[k])) k++
        out += src[k] === ':' ? JSON.stringify(token) : (word[token] ?? JSON.stringify(token))
        i = j
      } else {
        out += c
        i++
      }
    }
    out = out.replace(/,\s*$/, '')
    while (stack.length) out += stack.pop()
    try {
      return JSON.parse(out)
    } catch {
      return null
    }
  }

  function patchVariables(key, change, options) {
    const ops = typeof change === 'string' ? parseJSON(change) : change
    return setvar(key, jsonPatch(getvar(key, options), ops), options)
  }

  // A function kept with define() runs with the template globals as `this`
  // (this.variables, this.getvar, this._), as the plugin binds it.
  const __bind = v => (typeof v === 'function' ? v.bind(globalThis) : Array.isArray(v) ? v.map(__bind) : __plain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, __bind(x)])) : v)
  function define(name, value, merge = false) {
    const old = __get(globalThis, name)
    let next = value
    if (merge) {
      if ((old === undefined || Array.isArray(old)) && Array.isArray(value)) next = [...(old ?? []), ...value]
      else if ((old === undefined || __plain(old)) && __plain(value)) next = __mergeInto(old ?? {}, value)
    }
    __set(globalThis, name, __bind(next))
    return old
  }

  // ── lodash, the parts templates use ──
  const __it = f => (typeof f === 'function' ? f : typeof f === 'string' ? o => __get(o, f)
    : Array.isArray(f) ? o => __get(o, f[0]) === f[1]
    : f && typeof f === 'object' ? o => Object.keys(f).every(k => o != null && o[k] === f[k]) : x => x)
  const __list = c => (c == null ? [] : Array.isArray(c) ? c : typeof c === 'string' ? [...c] : typeof c === 'object' ? Object.values(c) : [])
  const __cmp = (a, b) => (a > b) - (a < b)
  const _ = {
    get: (o, p, d) => { const v = __get(o, p); return v === undefined ? d : v },
    has: (o, p) => __has(o, p),
    set: (o, p, v) => { __set(o, p, v); return o },
    unset: (o, p) => { __unset(o, p); return true },
    isNil: v => v === undefined || v === null, isNull: v => v === null, isUndefined: v => v === undefined,
    isNumber: v => typeof v === 'number', isString: v => typeof v === 'string', isBoolean: v => typeof v === 'boolean',
    isArray: Array.isArray, isObject: v => v !== null && (typeof v === 'object' || typeof v === 'function'), isPlainObject: __plain,
    isFunction: v => typeof v === 'function', isInteger: Number.isInteger, isFinite: Number.isFinite, isNaN: v => typeof v === 'number' && isNaN(v),
    isEmpty: v => v == null || (typeof v === 'string' || Array.isArray(v) ? v.length === 0 : typeof v === 'object' ? Object.keys(v).length === 0 : true),
    isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    clamp: (n, lo, hi) => Math.min(Math.max(n, lo), hi), inRange: (n, a, b) => (b === undefined ? n >= 0 && n < a : n >= Math.min(a, b) && n < Math.max(a, b)),
    includes: (c, v) => (typeof c === 'string' ? c.includes(v) : __list(c).includes(v)),
    find: (c, f) => __list(c).find(__it(f)), findIndex: (a, f) => (a ?? []).findIndex(__it(f)), findLast: (c, f) => __list(c).findLast(__it(f)),
    filter: (c, f) => __list(c).filter(__it(f)), reject: (c, f) => __list(c).filter(x => !__it(f)(x)),
    map: (c, f) => (__plain(c) ? Object.entries(c).map(([k, v]) => __it(f)(v, k)) : __list(c).map(__it(f))),
    mapValues: (o, f) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, __it(f)(v, k)])),
    forEach: (c, f) => { __plain(c) ? Object.entries(c).forEach(([k, v]) => f(v, k)) : __list(c).forEach(f); return c },
    reduce: (c, f, init) => (__plain(c) ? Object.entries(c).reduce((acc, [k, v]) => f(acc, v, k), init) : __list(c).reduce(f, init)),
    some: (c, f) => __list(c).some(__it(f)), every: (c, f) => __list(c).every(__it(f)),
    sum: a => __list(a).reduce((s, x) => s + (Number(x) || 0), 0), sumBy: (a, f) => __list(a).reduce((s, x) => s + (Number(__it(f)(x)) || 0), 0),
    mean: a => { const l = __list(a); return l.length ? l.reduce((s, x) => s + Number(x), 0) / l.length : NaN },
    max: a => { const l = __list(a); return l.length ? l.reduce((m, x) => (x > m ? x : m)) : undefined },
    min: a => { const l = __list(a); return l.length ? l.reduce((m, x) => (x < m ? x : m)) : undefined },
    maxBy: (a, f) => { const g = __it(f); return __list(a).reduce((m, x) => (m === undefined || g(x) > g(m) ? x : m), undefined) },
    minBy: (a, f) => { const g = __it(f); return __list(a).reduce((m, x) => (m === undefined || g(x) < g(m) ? x : m), undefined) },
    uniq: a => [...new Set(__list(a))], uniqBy: (a, f) => { const g = __it(f), seen = new Set(); return __list(a).filter(x => { const k = g(x); return seen.has(k) ? false : seen.add(k) }) },
    compact: a => __list(a).filter(Boolean), flatten: a => __list(a).flat(), flattenDeep: a => __list(a).flat(Infinity),
    chunk: (a, n = 1) => { const l = __list(a), out = []; for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n)); return out },
    keys: o => Object.keys(o ?? {}), values: o => Object.values(o ?? {}), entries: o => Object.entries(o ?? {}), toPairs: o => Object.entries(o ?? {}), fromPairs: p => Object.fromEntries(p ?? []),
    pick: (o, ...k) => Object.fromEntries(k.flat().filter(x => o != null && x in o).map(x => [x, o[x]])),
    omit: (o, ...k) => { const drop = new Set(k.flat()); return Object.fromEntries(Object.entries(o ?? {}).filter(([x]) => !drop.has(x))) },
    merge: (target, ...sources) => { for (const s of sources) __mergeInto(target, s); return target },
    mergeWith: (target, ...rest) => { const sources = typeof rest[rest.length - 1] === 'function' ? rest.slice(0, -1) : rest; for (const s of sources) __mergeInto(target, s); return target },
    assign: Object.assign, defaults: (o, ...s) => { for (const x of s) for (const k of Object.keys(x ?? {})) if (o[k] === undefined) o[k] = x[k]; return o },
    cloneDeep: __clone, clone: v => (Array.isArray(v) ? [...v] : __plain(v) ? { ...v } : v),
    castArray: v => (Array.isArray(v) ? v : [v]), concat: (...a) => [].concat(...a),
    sortBy: (c, ...fs) => { const gs = fs.flat().map(__it); if (!gs.length) gs.push(x => x); return [...__list(c)].sort((a, b) => { for (const g of gs) { const r = __cmp(g(a), g(b)); if (r) return r } return 0 }) },
    orderBy: (c, fs, orders = []) => { const gs = [].concat(fs ?? [x => x]).map(__it); return [...__list(c)].sort((a, b) => { for (let i = 0; i < gs.length; i++) { const r = __cmp(gs[i](a), gs[i](b)) * (orders[i] === 'desc' ? -1 : 1); if (r) return r } return 0 }) },
    groupBy: (c, f) => __list(c).reduce((m, x) => { const k = __it(f)(x); (m[k] ??= []).push(x); return m }, {}),
    countBy: (c, f) => __list(c).reduce((m, x) => { const k = __it(f)(x); m[k] = (m[k] ?? 0) + 1; return m }, {}),
    keyBy: (c, f) => __list(c).reduce((m, x) => { m[__it(f)(x)] = x; return m }, {}),
    first: a => __list(a)[0], head: a => __list(a)[0], last: a => __list(a).at(-1), nth: (a, n = 0) => __list(a).at(n),
    take: (a, n = 1) => __list(a).slice(0, n), takeRight: (a, n = 1) => (n ? __list(a).slice(-n) : []), drop: (a, n = 1) => __list(a).slice(n), dropRight: (a, n = 1) => __list(a).slice(0, Math.max(0, __list(a).length - n)),
    difference: (a, ...o) => { const d = new Set(o.flat()); return __list(a).filter(x => !d.has(x)) },
    intersection: (a, ...o) => __list(a).filter(x => o.every(l => (l ?? []).includes(x))), union: (...a) => [...new Set(a.flat())],
    without: (a, ...v) => __list(a).filter(x => !v.includes(x)), size: c => (c == null ? 0 : typeof c === 'string' || Array.isArray(c) ? c.length : Object.keys(c).length),
    range: (a, b, step) => { if (b === undefined) { b = a; a = 0 } step ??= a < b ? 1 : -1; const out = []; if (!step) return out; for (let i = a; step > 0 ? i < b : i > b; i += step) out.push(i); return out },
    times: (n, f = i => i) => Array.from({ length: Math.max(0, n) }, (_x, i) => f(i)),
    random(lower, upper, floating) {
      if (typeof upper === 'boolean') { floating = upper; upper = undefined }
      if (upper === undefined) { upper = lower ?? 1; lower = 0 }
      const lo = Math.min(Number(lower) || 0, Number(upper) || 0), hi = Math.max(Number(lower) || 0, Number(upper) || 0)
      return floating || !Number.isInteger(lo) || !Number.isInteger(hi) ? lo + Math.random() * (hi - lo) : lo + Math.floor(Math.random() * (hi - lo + 1))
    },
    sample: c => { const l = __list(c); return l[Math.floor(Math.random() * l.length)] },
    shuffle: c => { const l = [...__list(c)]; for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]] } return l },
    sampleSize: (c, n = 1) => _.shuffle(c).slice(0, n),
    round: (n, p = 0) => Math.round(n * 10 ** p) / 10 ** p, floor: (n, p = 0) => Math.floor(n * 10 ** p) / 10 ** p, ceil: (n, p = 0) => Math.ceil(n * 10 ** p) / 10 ** p,
    toNumber: Number, toInteger: v => Math.trunc(Number(v)) || 0, toString: v => (v == null ? '' : String(v)), toArray: __list,
    escapeRegExp: s => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    startsWith: (s, t, p) => String(s ?? '').startsWith(t, p), endsWith: (s, t, p) => String(s ?? '').endsWith(t, p),
    trim: s => String(s ?? '').trim(), padStart: (s, n, c) => String(s ?? '').padStart(n, c), padEnd: (s, n, c) => String(s ?? '').padEnd(n, c),
    repeat: (s, n) => String(s ?? '').repeat(n), capitalize: s => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1).toLowerCase(),
    split: (s, sep, n) => String(s ?? '').split(sep, n), join: (a, sep = ',') => __list(a).join(sep), replace: (s, p, r) => String(s ?? '').replace(p, r),
    defaultTo: (v, d) => (v == null || Number.isNaN(v) ? d : v), noop: () => {}, identity: x => x, constant: x => () => x,
  }

  // Output as the plugin prints it: arrays joined with commas; a plain object as JSON (kept from before).
  const __str = v => (v === undefined || v === null ? '' : Array.isArray(v) ? String(v) : __plain(v) ? JSON.stringify(v) : String(v))

  // ── the chat (ST-Prompt-Template's chat.ts): floors by their number in the whole chat, the greeting is 0 ──
  const __roleChar = role => (role === 'user' ? 'u' : role === 'assistant' ? 'a' : role === 'system' ? 's' : '')
  const __ids = role => {
    const out = []
    const want = role && role !== 'any' ? __roleChar(role) : ''
    for (let i = 0; i < __msgCount; i++) if (!want || __msgRoles[i] === want) out.push(i)
    return out
  }
  const __texts = ids => ids.map(i => __msg(i))
  function getChatMessages(startOrCount = __msgCount, endOrRole, role) {
    const pick = (ids, n) => (n > 0 ? ids.slice(0, n) : n < 0 ? ids.slice(n) : [])
    if (endOrRole === undefined || endOrRole === null) return __texts(pick(__ids(), startOrCount))
    if (typeof endOrRole === 'string') return __texts(pick(__ids(endOrRole), startOrCount))
    return startOrCount === 0 ? [] : __texts(__ids(role).slice(startOrCount, endOrRole))
  }
  function getChatMessage(index, role) {
    const ids = __ids(role)
    const id = ids[index > -1 ? index : ids.length + index]
    return id === undefined ? '' : __msg(id)
  }
  const __match = (text, pattern) => {
    try {
      return Boolean(String(text).match(pattern))
    } catch {
      return String(text).includes(String(pattern))
    }
  }
  function matchChatMessages(pattern, options = {}) {
    const messages = getChatMessages(options.start ?? -2, options.end, options.role)
    const patterns = Array.isArray(pattern) ? pattern : [pattern]
    return messages.some(text => (options.and ? patterns.every(p => __match(text, p)) : patterns.some(p => __match(text, p))))
  }
  const __lastOf = role => { const ids = __ids(role); return ids.length ? ids[ids.length - 1] : -1 }

  // ── worldbook entries, by title (a string is also a pattern, as ST-Prompt-Template has it) or uid ──
  const __Async = (async () => {}).constructor
  let __depth = 0
  // Data keys that can be names: ASCII identifiers, or ones with letters past Latin-1 (Chinese keys).
  const __isName = k => [...k].every((ch, i) => /[A-Za-z_$]/.test(ch) || (i > 0 && /[0-9]/.test(ch)) || ch.charCodeAt(0) >= 0xc0)
  const __RESERVED = new Set(['this', 'arguments', 'eval', 'await', 'yield', 'let', 'static', 'class', 'const', 'var', 'function', 'if', 'else', 'for', 'while', 'do', 'return', 'new', 'delete', 'typeof', 'void', 'in', 'of', 'instanceof', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'with', 'import', 'export', 'extends', 'super', 'null', 'true', 'false', 'enum', 'debugger'])
  // Run already-split template source; `data` becomes names of its own.
  async function __run(source, data = {}) {
    if (!/<%[\s\S]*?%>/.test(source)) return source
    if (__depth >= 10) return ''
    const names = Object.keys(data ?? {}).filter(k => k && __isName(k) && !__RESERVED.has(k))
    const run = new __Async(...names, compileEjs(source))
    __depth++
    try {
      return await run.apply(globalThis, names.map(k => data[k]))
    } finally {
      __depth--
    }
  }
  async function __render(text, data = {}) {
    const { body, condition } = splitDecorators(text)
    return __run(condition ? '<% if (' + condition + ') { %>' + body + '<% } %>' : body, data)
  }
  const evalTemplate = (text, data = {}) => __run(String(text ?? ''), data)
  function __findEntry(book, title) {
    const books = book ? __books.filter(b => b.name === book) : __books.slice(0, 1)
    const exact = e => e.c === title || e.u === title
    const like = e => typeof title !== 'number' && title !== null && title !== undefined && __match(e.c, title)
    for (const test of [exact, like]) for (const b of books) { const hit = b.entries.find(test); if (hit) return hit }
    // As there: other books only when no book was named, and not by number.
    if (!book && typeof title !== 'number') for (const test of [exact, like]) for (const b of __books.slice(1)) { const hit = b.entries.find(test); if (hit) return hit }
    return null
  }
  const __info = hit => ({ comment: hit.c, uid: hit.u, world: hit.w })
  async function getwi(a, b, c) {
    const titleOnly = b === undefined || __plain(b)
    const book = titleOnly ? '' : a, title = titleOnly ? a : b, data = (titleOnly ? b : c) ?? {}
    const hit = __findEntry(book || '', title)
    if (!hit) return ''
    return __render(__wi(hit.i), { ...data, world_info: __info(hit) })
  }
  // Entries asked for while the turn renders join its keyword hits (the host reads the queue).
  const __activated = []
  async function activewi(a, b, c) {
    const titleOnly = b === undefined || b === null || typeof b === 'boolean'
    const book = titleOnly ? '' : a, title = titleOnly ? a : b, force = titleOnly ? b === true : c === true
    const hit = __findEntry(book || '', title)
    if (!hit) return null
    __activated.push({ i: hit.i, force })
    return { ...__info(hit), content: __wi(hit.i) }
  }
  async function activateWorldInfoByKeywords(keywords, condition = {}) {
    const found = JSON.parse(__kw(_.castArray(keywords).join('\n\n')))
    for (const i of found) __activated.push({ i, force: condition?.force === true })
    return found.map(i => { for (const b of __books) for (const e of b.entries) if (e.i === i) return { ...__info(e), content: __wi(i) }; return null }).filter(Boolean)
  }

  // ── prompts injected under a key; read anywhere in the turn, filled in once everything has rendered ──
  const __injected = new Map()
  function injectPrompt(key, prompt, order = 100, sticky = 0, uid = '') {
    if (!__injected.has(key)) __injected.set(key, new Map())
    __injected.get(key).set(uid || `${key}#${prompt}`, { prompt: String(prompt ?? ''), order: Number(order) || 0 })
  }
  const __joined = key => [...(__injected.get(key)?.values() ?? [])].sort((a, b) => a.order - b.order).map(p => p.prompt).join('\n')
  function getPromptsInjected(key, postprocess = []) {
    if (!Array.isArray(postprocess) || !postprocess.length) return `{{outletPromptsInjected:${key}}}`
    let text = __joined(key)
    for (const step of postprocess) if (step && step.search !== undefined) text = text.replace(step.search, step.replace ?? '')
    return text
  }
  const hasPromptsInjected = key => __injected.has(key)
  function __outlet(text, rounds) {
    let out = String(text)
    for (let i = 0; i < rounds && out.includes('{{outletPromptsInjected:'); i++) out = out.replace(/\{\{outletPromptsInjected:(.+?)\}\}/g, (_m, key) => __joined(key))
    return out
  }

  // ── the card and the chat's preset ──
  const __matchName = (name, wanted) => wanted === undefined || wanted === null || wanted === '' || typeof wanted === 'number' || name === wanted || __match(name, wanted)
  let __cardData = null
  const __theCard = () => (__cardData ??= JSON.parse(__card()))
  function getCharData(name) {
    const card = __theCard()
    return card && __matchName(card.name, name) ? __clone(card) : null
  }
  async function getchar(name, template = DEFAULT_CHAR_DEFINE, data = {}) {
    const card = getCharData(name)
    if (!card) return ''
    let example = String(card.mes_example ?? '').trim()
    if (example.startsWith('<START>')) example = example.slice(7).trim()
    example = example.replace('<START>', '```\n```')
    if (example.includes('```')) example += '\n```'
    const defs = {
      name: card.name, description: card.description, personality: card.personality, scenario: card.scenario,
      first_message: card.first_mes, message_example: example, creator_notes: card.data.creator_notes, creatorcomment: card.creatorcomment,
      system_prompt: card.data.system_prompt, post_history_instructions: card.data.post_history_instructions,
      alternate_greetings: card.data.alternate_greetings, depth_prompt: card.data.extensions.depth_prompt.prompt, creator: card.data.creator,
    }
    return __run(String(template ?? DEFAULT_CHAR_DEFINE), { ...data, ...defs, chara_name: defs.name })
  }
  async function getpreset(name, data = {}) {
    const index = __presetNames.findIndex(n => n === name || __match(n, name))
    if (index < 0) return ''
    return __run(__pp(index), { ...data, prompt_name: name })
  }

  const __quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {}, table() {}, group() {}, groupEnd() {} }
  const blank = async () => ''
  const getvarIn = scope => (key, options) => getvar(key, withScope(scope)(options))
  const setvarIn = scope => (key, value, options) => setvar(key, value, withScope(scope)(options))
  const incIn = (scope, fn) => (key, value = 1, options) => fn(key, value, withScope(scope, 'outscope')(options))
  const delIn = scope => (key, options) => delvar(key, undefined, withScope(scope)(options))
  const insIn = scope => (key, value, index, options) => insvar(key, value, index, withScope(scope)(options))

  const api = {
    variables: __cache, stat_data: __cache,
    getvar, setvar, incvar, decvar, delvar, insvar,
    getLocalVar: getvarIn('local'), getGlobalVar: getvarIn('global'), getMessageVar: getvarIn('message'),
    getChatVariable: getvarIn('local'), getGlobalVariable: getvarIn('global'), getMessageVariable: getvarIn('message'),
    setLocalVar: setvarIn('local'), setGlobalVar: setvarIn('global'), setMessageVar: setvarIn('message'),
    setChatVariable: setvarIn('local'), setGlobalVariable: setvarIn('global'), setMessageVariable: setvarIn('message'),
    incLocalVar: incIn('local', incvar), incGlobalVar: incIn('global', incvar), incMessageVar: incIn('message', incvar),
    decLocalVar: incIn('local', decvar), decGlobalVar: incIn('global', decvar), decMessageVar: incIn('message', decvar),
    delLocalVar: delIn('local'), delGlobalVar: delIn('global'), delMessageVar: delIn('message'),
    insertLocalVar: insIn('local'), insertGlobalVar: insIn('global'), insertMessageVar: insIn('message'),
    findVariables: key => (key === undefined || key === null || __has(__scopes.message, key) ? __scopes.message : __scopes.initial),
    patchVariables, jsonPatch, parseJSON, define, evalTemplate,
    getwi, getWorldInfo: getwi, activewi, activateWorldInfo: activewi, activateWorldInfoByKeywords,
    injectPrompt, getPromptsInjected, hasPromptsInjected,
    getchar, getChara: getchar, getchr: getchar, getCharData, getCharaData: getCharData,
    getpreset, getPresetPrompt: getpreset, getprp: getpreset,
    getqr: blank, getQuickReply: blank, execute: blank, activateRegex: () => {}, setVariableSchema: () => {},
    getChatMessages, getChatMessage, matchChatMessages,
    console: __quiet, toastr: { info() {}, success() {}, warning() {}, error() {}, clear() {} },
    _, char: __names.char, user: __names.user, charName: __names.char, assistantName: __names.char, userName: __names.user,
    lastMessageId: __msgCount - 1, lastUserMessageId: __lastOf('user'), lastCharMessageId: __lastOf('assistant'),
    ...__ctx,
  }
  Object.assign(globalThis, api)
  // The turn's input may be rendered first and change; these read the message as it is now.
  Object.defineProperty(globalThis, 'lastUserMessage', { get: () => (api.lastUserMessageId < 0 ? '' : __msg(api.lastUserMessageId)), enumerable: true, configurable: true })
  Object.defineProperty(globalThis, 'lastCharMessage', { get: () => (api.lastCharMessageId < 0 ? '' : __msg(api.lastCharMessageId)), enumerable: true, configurable: true })
  // For the host.
  Object.assign(globalThis, {
    __str, __run, __render, __outlet, __activated, __scopes,
    __lock: on => { __writable = !on },
  })
}

// Card fields as SillyTavern's character object has them (getCharData; getchar lays them out).
function stCard(card) {
  if (!card) return null
  const data = {
    name: card.name ?? '', description: card.description ?? '', personality: card.personality ?? '', scenario: card.scenario ?? '',
    first_mes: card.firstMes ?? '', mes_example: card.mesExample ?? '', creator_notes: card.creatorNotes ?? '', system_prompt: card.systemPrompt ?? '',
    post_history_instructions: card.postHistoryInstructions ?? '', alternate_greetings: card.alternateGreetings ?? [], tags: card.tags ?? [], creator: card.creator ?? '',
    extensions: { depth_prompt: { prompt: card.depthPrompt ?? '', depth: 4, role: 'system' } },
  }
  return { name: data.name, description: data.description, personality: data.personality, scenario: data.scenario, first_mes: data.first_mes, mes_example: data.mes_example, creatorcomment: data.creator_notes, tags: data.tags, data }
}

const plainObject = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

/**
 * One sandbox for a turn's templates, opened when the first one needs it. Each
 * render runs as an async function of its own (its `let` and `const` stay in
 * it); `define()` and variable writes carry over to the next. Dispose it when
 * the turn is built.
 * @param options.state - the chat state (MVU's stat_data): ST's message variables, where writes go by default.
 *   `variables: { stat_data: state }` (shared/vars.js variablesOf) is still read the old way.
 * @param options.local / options.global - the chat-wide and app-wide variables (the plugin's `local` and `global` scopes).
 * @param options.initial - [InitialVariables] values, or a function giving them when the sandbox opens.
 * @param options.names - { char, user } for the `char` / `user` globals.
 * @param options.books - the books getwi reads, the card's own first: [{ name, entries }].
 * @param options.messages - the chat so far, oldest first (the greeting is floor 0): [{ role: 'user'|'assistant', text }].
 * @param options.messageText - (message, index) => the text templates see (the card's prompt-side regex).
 * @param options.card / options.preset - for getchar / getCharData and getpreset.
 * @param options.preload - entries run first when the sandbox opens, their output dropped
 *   (@@preload / @@only_preload: their define()s exist for everything after). Variable writes
 *   there are dropped unless asked for with `dryRun`, as in the plugin's preload.
 * @param options.matchKeys - text => [{ book, entry }] whose keywords it matches (activateWorldInfoByKeywords).
 * @param options.runType - 'generate', 'render', 'render_permanent' or 'preparation', as the plugin names them.
 * @param options.context - more globals (a displayed message's message_id, is_user…).
 */
export function templateSession(options = {}) {
  let sandbox = null
  const messages = (options.messages ?? []).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text ?? '') }))
  const seen = new Map()
  const textOf = index => {
    if (!seen.has(index)) {
      const message = messages[index]
      const text = message ? String(options.messageText ? options.messageText(message, index) : message.text) : ''
      seen.set(index, text.slice(0, MESSAGE_CHARS))
    }
    return seen.get(index)
  }
  const open = () => (sandbox ??= openSandbox({ ...options, messages, textOf }))
  const state = options.state ?? legacyState(options.variables)
  return {
    /** Render one worldbook entry's template (decorators apply): its output, or null with `error` when it fails. */
    render(template, data = {}) {
      const { body, condition } = splitDecorators(template)
      if (!hasTemplate(template)) return { text: body, error: null }
      return open().run(condition ? `<% if (${condition}) { %>${body}<% } %>` : body, data)
    },
    /** Render a message or prompt text (no decorators; reasoning blocks kept as written). */
    renderText(text, data = {}) {
      const source = escapeReasoning(text)
      if (!hasEjs(source)) return { text: String(text ?? ''), error: null }
      return open().run(source, data)
    },
    /** A message's text changed after it was rendered (the turn's input). */
    setMessage(index, text) {
      if (!messages[index]) return
      messages[index].text = String(text ?? '')
      seen.delete(index)
    },
    /** Entries asked for with activewi since the last call: [{ book, entry, force }]. */
    activations() {
      return sandbox ? sandbox.activations() : []
    },
    /** getPromptsInjected placeholders in `text` filled with what was injected. */
    resolveInjected(text) {
      const value = String(text ?? '')
      if (!value.includes('{{outletPromptsInjected:')) return value
      return sandbox ? sandbox.outlet(value) : value.replace(/\{\{outletPromptsInjected:(.+?)\}\}/g, '')
    },
    /** The chat state as the templates have left it so far. */
    currentState() {
      return sandbox ? sandbox.stores().message : state ?? {}
    },
    /**
     * What the templates wrote: JSON-pointer replace/remove operations for the
     * chat state (`message`), the chat-wide (`local`) and app-wide (`global`)
     * variables, and the chat state after them.
     */
    writes() {
      if (!sandbox) return { message: [], local: [], global: [], state: state ?? {} }
      const after = sandbox.stores()
      return {
        message: diffWrites(state ?? {}, after.message),
        local: diffWrites(plainObject(options.local), after.local),
        global: diffWrites(plainObject(options.global), after.global),
        state: after.message,
      }
    },
    /** Errors of the @@preload entries run when the sandbox opened: ['title: error']. */
    preloadErrors() {
      return sandbox?.preloadErrors ?? []
    },
    dispose() {
      sandbox?.dispose()
      sandbox = null
    },
  }
}

function legacyState(variables) {
  const vars = plainObject(variables)
  return vars.stat_data && typeof vars.stat_data === 'object' && !Array.isArray(vars.stat_data) ? vars.stat_data : vars
}

function openSandbox(options) {
  if (!quickjs) throw new Error('templates not initialised')
  const { names = {}, books = [], messages, textOf, card = null, preset = null, preload = [], matchKeys = null, runType = 'generate', context = {} } = options
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT)
  runtime.setMaxStackSize(1024 * 1024)
  const vm = runtime.newContext()
  // Titles go in; an entry's text comes out by number when a template asks for it.
  const entries = []
  const shelf = books.filter(Boolean).map(book => ({
    name: String(book.name ?? ''),
    entries: (book.entries ?? []).map(entry => {
      entries.push({ book, entry })
      const uid = Number(entry.uid)
      return { i: entries.length - 1, c: String(entry.comment ?? ''), u: Number.isFinite(uid) ? uid : entry.uid, w: String(book.name ?? '') }
    }),
  }))
  const indexOf = new Map(entries.map((item, index) => [item.entry, index]))
  const prompts = (preset?.prompts ?? []).filter(p => !p.marker)
  const host = {
    __wi: index => vm.newString(String(entries[vm.getNumber(index)]?.entry.content ?? '')),
    __msg: index => vm.newString(textOf(vm.getNumber(index))),
    __kw: text => vm.newString(JSON.stringify((matchKeys ? matchKeys(vm.getString(text)) : []).map(hit => indexOf.get(hit.entry)).filter(i => i !== undefined))),
    __card: () => vm.newString(JSON.stringify(stCard(card))),
    __pp: index => vm.newString(String(prompts[vm.getNumber(index)]?.content ?? '')),
  }
  for (const [name, fn] of Object.entries(host)) {
    const handle = vm.newFunction(name, fn)
    vm.setProp(vm.global, name, handle)
    handle.dispose()
  }
  const initial = typeof options.initial === 'function' ? options.initial() : options.initial
  const stores = {
    message: options.state ?? legacyState(options.variables),
    local: plainObject(options.local),
    global: plainObject(options.global),
    initial: plainObject(initial),
  }
  const setup = [
    `globalThis.__in = ${JSON.stringify(stores)};`,
    `globalThis.__books = ${JSON.stringify(shelf)};`,
    `globalThis.__msgCount = ${messages.length}; globalThis.__msgRoles = ${JSON.stringify(messages.map(m => (m.role === 'user' ? 'u' : 'a')).join(''))};`,
    `globalThis.__names = ${JSON.stringify({ char: String(names?.char ?? ''), user: String(names?.user ?? '') })};`,
    `globalThis.__ctx = ${JSON.stringify({ generateType: 'normal', ...context, runType })};`,
    `globalThis.__presetNames = ${JSON.stringify(prompts.map(p => String(p.name ?? '')))};`,
    splitDecorators.toString(),
    compileEjs.toString(),
    `(${prelude.toString()})(${JSON.stringify(DEFAULT_CHAR_DEFINE)});`,
  ].join('\n')
  let broken = run(setup).error
  const preloadErrors = []
  if (!broken && preload.length) {
    run('__lock(true)')
    for (const entry of preload) {
      const book = entries[indexOf.get(entry)]?.book
      const data = { world_info: { comment: entry.comment, uid: Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : entry.uid, world: book?.name ?? '' } }
      const result = run(`__render(${JSON.stringify(String(entry.content ?? ''))}, ${JSON.stringify(data)})`, true)
      if (result.error) preloadErrors.push(`${entry.comment || entry.uid}: ${result.error}`)
      if (result.error && /out of memory/i.test(result.error)) broken = result.error
    }
    run('__lock(false)')
  }
  return {
    preloadErrors,
    run(source, data = {}) {
      if (broken) return { text: null, error: broken }
      const result = run(`__run(${JSON.stringify(source)}, ${JSON.stringify(data ?? {})})`, true)
      // Out of memory leaves the sandbox unusable; a template stopped for time does not.
      if (result.error && /out of memory/i.test(result.error)) broken = result.error
      return result
    },
    activations() {
      if (broken) return []
      const queued = evaluate('JSON.stringify(__activated.splice(0))')
      return (queued ?? []).map(({ i, force }) => (entries[i] ? { ...entries[i], force: force === true } : null)).filter(Boolean)
    },
    outlet(text) {
      const result = broken ? null : run(`__outlet(${JSON.stringify(text)}, ${OUTLET_ROUNDS})`)
      return result && !result.error ? result.text : text.replace(/\{\{outletPromptsInjected:(.+?)\}\}/g, '')
    },
    stores() {
      const value = broken ? null : evaluate('JSON.stringify(__scopes)')
      return value ?? { message: stores.message ?? {}, local: stores.local, global: stores.global }
    },
    dispose() {
      vm.dispose()
      runtime.dispose()
    },
  }

  /** A value out of the sandbox as JSON, or null when it fails. */
  function evaluate(code) {
    const result = run(code)
    if (result.error) return null
    try {
      return JSON.parse(result.text)
    } catch {
      return null
    }
  }

  /** Run code under the time limit; with `settle`, wait for the promise it gives. Returns its value as text. */
  function run(code, settle = false) {
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS))
    try {
      const result = vm.evalCode(code)
      if (result.error) return { text: null, error: failure(result.error) }
      if (!settle) {
        const value = vm.dump(result.value)
        result.value.dispose()
        return { text: typeof value === 'string' ? value : '', error: null }
      }
      const promise = result.value
      try {
        const jobs = runtime.executePendingJobs()
        if (jobs.error) return { text: null, error: failure(jobs.error) }
        const state = vm.getPromiseState(promise)
        if (state.type === 'pending') return { text: null, error: 'the template never finished (await on something that does not resolve)' }
        if (state.type === 'rejected') return { text: null, error: failure(state.error) }
        const value = vm.dump(state.value)
        state.value.dispose()
        return { text: typeof value === 'string' ? value : String(value ?? ''), error: null }
      } finally {
        promise.dispose()
      }
    } catch (error) {
      return { text: null, error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  function failure(handle) {
    const error = vm.dump(handle)
    handle.dispose()
    const text = error && typeof error === 'object' ? [error.name, error.message].filter(Boolean).join(': ') : String(error)
    return text.slice(0, 200)
  }
}

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pointer = keys => keys.map(key => `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')

/**
 * What turns `before` into `after`: replace/remove operations on JSON-pointer
 * paths (objects compared key by key, anything else as a whole). state.mjs
 * applyWrites plays them back.
 */
export function diffWrites(before, after) {
  const ops = []
  const walk = (a, b, keys) => {
    if (isPlain(a) && isPlain(b)) {
      for (const key of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, key)) ops.push({ op: 'remove', path: pointer([...keys, key]) })
      for (const [key, value] of Object.entries(b)) {
        if (!Object.prototype.hasOwnProperty.call(a, key)) ops.push({ op: 'replace', path: pointer([...keys, key]), value })
        else walk(a[key], value, [...keys, key])
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      ops.push(b === undefined ? { op: 'remove', path: pointer(keys) } : { op: 'replace', path: pointer(keys), value: b })
    }
  }
  walk(plainObject(before), plainObject(after), [])
  return ops
}

/**
 * Render one EJS template against the chat variables, in a session of its own.
 * Returns the template's output, or null (with `error`) when it fails.
 * @param options - as templateSession.
 */
export function renderTemplate(template, options = {}) {
  if (!hasTemplate(template)) return { text: splitDecorators(template).body, error: null }
  const session = templateSession(options)
  try {
    return session.render(template)
  } finally {
    session.dispose()
  }
}
