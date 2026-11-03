// STscript, SillyTavern's slash command language, as card interfaces send it
// (triggerSlash, or a `/…` typed into the input box and sent): commands joined
// by `|`, named arguments (`key=value`, `"quoted"`, `{: closures :}`, `[lists]`),
// the pipe (each command's result, `{{pipe}}`, and the next command's unnamed
// argument when it has none), scoped variables (/let, /var), /if, /while,
// /times, /run, /return, /abort, math and text. What reaches the chat (sending,
// messages, chat and global variables, the model, dialogs) is the host's
// (web/app.js). A command neither knows is skipped: host.unknown hears of it and
// the rest still runs, as a card's script keeps going past one SillyTavern
// would not have either.
// No imports: tested under node (test/stscript.test.mjs).

/** A closure: commands run when called, in a scope of their own under the one it was written in. */
class Closure {
  constructor(commands) {
    this.commands = commands
  }
}

/** /abort: the whole script stops. */
class Abort {}
/** /return in a closure (or the script): its value is the closure's result. */
class Return {
  constructor(value) {
    this.value = value
  }
}
/** /break in a /while or /times. */
class Break {
  constructor(value) {
    this.value = value
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────

/** Where a command line ends: `|` before the next command (`| /…`), or the end. A `|` in plain text stays in it. */
const SEPARATOR = /^\|\s*(?=\/)/

/**
 * The commands in a script: [{ name, named: { key: text | Closure }, unnamed: text | Closure | null }].
 * Lenient where SillyTavern is strict: a `|` not followed by a command is part of the text (`/setinput A|B`),
 * and text before the first command is left out.
 */
export function parseScript(text) {
  const parser = { src: String(text ?? ''), at: 0 }
  return parseCommands(parser, false)
}

function parseCommands(p, inClosure) {
  const commands = []
  for (;;) {
    // Up to the next command (or the closure's end).
    while (p.at < p.src.length && !p.src.startsWith('/', p.at) && !(inClosure && p.src.startsWith(':}', p.at))) p.at++
    if (p.at >= p.src.length) return commands
    if (inClosure && p.src.startsWith(':}', p.at)) {
      p.at += 2
      return commands
    }
    p.at++ // the slash
    // `//` and `/#` are comments, to the end of the command.
    if (p.src[p.at] === '/' || p.src[p.at] === '#') {
      readText(p, inClosure)
      continue
    }
    const name = /^[^\s|]+/.exec(p.src.slice(p.at))?.[0] ?? ''
    p.at += name.length
    const command = { name: name.replace(/:}$/, '').toLowerCase(), named: {}, unnamed: null }
    if (name.endsWith(':}')) p.at -= 2
    // Named arguments, then the rest is the unnamed one.
    for (;;) {
      skipSpace(p)
      const arg = /^([A-Za-z_][\w-]*)=/.exec(p.src.slice(p.at))
      if (!arg) break
      p.at += arg[0].length
      command.named[arg[1].toLowerCase()] = readValue(p, inClosure)
    }
    skipSpace(p)
    if (p.src.startsWith('{:', p.at)) {
      p.at += 2
      command.unnamed = new Closure(parseCommands(p, true))
      trailingNamed(p, command, inClosure)
    } else if (p.src[p.at] === '"') {
      const quoted = readQuoted(p)
      const rest = readText(p, inClosure)
      command.unnamed = rest ? `${quoted} ${rest}`.trim() : quoted
    } else {
      // Words, then perhaps a closure (`/times 3 {: … :}`, `/let name {: … :}`): the words are its lead.
      const text = readText(p, inClosure, true)
      if (p.src.startsWith('{:', p.at)) {
        p.at += 2
        command.lead = text
        command.unnamed = new Closure(parseCommands(p, true))
        trailingNamed(p, command, inClosure)
      } else command.unnamed = text === '' ? null : text
    }
    commands.push(command)
  }
}

/** After a closure, named arguments cards often write there (`{: … :} else={: … :}`); the rest up to the separator is dropped. */
function trailingNamed(p, command, inClosure) {
  for (;;) {
    skipSpace(p)
    const arg = /^([A-Za-z_][\w-]*)=/.exec(p.src.slice(p.at))
    if (!arg) break
    p.at += arg[0].length
    const value = readValue(p, inClosure)
    command.named[arg[1].toLowerCase()] ??= value
  }
  readText(p, inClosure)
}

function skipSpace(p) {
  while (p.at < p.src.length && /\s/.test(p.src[p.at])) p.at++
}

/** A named argument's value: quoted, a closure, a [list] or {object}, or a word. */
function readValue(p, inClosure) {
  const c = p.src[p.at]
  if (c === '"') return readQuoted(p)
  if (p.src.startsWith('{:', p.at)) {
    p.at += 2
    return new Closure(parseCommands(p, true))
  }
  if (c === '[' || c === '{') return readBalanced(p)
  const start = p.at
  while (p.at < p.src.length && !/\s/.test(p.src[p.at]) && !SEPARATOR.test(p.src.slice(p.at)) && !(inClosure && p.src.startsWith(':}', p.at))) p.at++
  return p.src.slice(start, p.at)
}

function readQuoted(p) {
  p.at++ // the opening quote
  let out = ''
  while (p.at < p.src.length && p.src[p.at] !== '"') {
    if (p.src[p.at] === '\\' && p.at + 1 < p.src.length) {
      out += p.src[p.at + 1]
      p.at += 2
    } else out += p.src[p.at++]
  }
  p.at++ // the closing quote
  return out
}

/** `[…]` or `{…}` (JSON as cards write it), brackets in quotes not counted. */
function readBalanced(p) {
  const start = p.at
  let depth = 0
  let quoted = false
  for (; p.at < p.src.length; p.at++) {
    const c = p.src[p.at]
    if (quoted) {
      if (c === '\\') p.at++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        p.at++
        break
      }
    }
  }
  return p.src.slice(start, p.at)
}

/**
 * The unnamed text, up to the separator (or the closure's end); `\|` is a `|`, a nested closure is kept whole,
 * or, with `toClosure`, ends the text (left at its `{:`).
 */
function readText(p, inClosure, toClosure = false) {
  let out = ''
  let depth = 0
  while (p.at < p.src.length) {
    const rest = p.src.slice(p.at, p.at + 2)
    if (depth === 0 && SEPARATOR.test(p.src.slice(p.at, p.at + 64))) {
      p.at++
      break
    }
    if (depth === 0 && inClosure && rest === ':}') break
    if (depth === 0 && toClosure && rest === '{:') break
    if (p.src[p.at] === '\\' && (p.src[p.at + 1] === '|' || p.src[p.at + 1] === '\\')) {
      out += p.src[p.at + 1]
      p.at += 2
      continue
    }
    if (rest === '{:') depth++
    else if (rest === ':}' && depth > 0) depth--
    out += p.src[p.at++]
  }
  return out.trim()
}

// ─── Running ────────────────────────────────────────────────────────────

/** A command's value as text: numbers and objects as SillyTavern's variables hold them. */
export function asText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Closure) return '[closure]'
  return JSON.stringify(value)
}

/** A variable's text read back as a value: a number or JSON where it is one. */
export function asValue(text) {
  if (typeof text !== 'string') return text
  const trimmed = text.trim()
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed)
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // not JSON: the text
    }
  }
  return text
}

const number = value => {
  const n = Number(typeof value === 'string' ? value.trim() : value)
  return Number.isFinite(n) ? n : 0
}

// Rules /if and /while compare by.
const RULES = {
  eq: (a, b) => a == b, // eslint-disable-line eqeqeq -- SillyTavern compares "5" and 5 as equal
  neq: (a, b) => a != b, // eslint-disable-line eqeqeq
  lt: (a, b) => number(a) < number(b),
  gt: (a, b) => number(a) > number(b),
  lte: (a, b) => number(a) <= number(b),
  gte: (a, b) => number(a) >= number(b),
  not: a => !truthy(a),
  in: (a, b) => asText(b).toLowerCase().includes(asText(a).toLowerCase()),
  nin: (a, b) => !asText(b).toLowerCase().includes(asText(a).toLowerCase()),
}
const truthy = value => !['', '0', 'false', 'off', 'null', 'undefined'].includes(asText(value).trim().toLowerCase())

// Commands that only arrange SillyTavern's own window (background, theme, layout, its quick-reply bar…): nothing
// to do here, and nothing wrong in asking.
const COSMETIC = new Set([
  'bg', 'lockbg', 'unlockbg', 'autobg', 'theme', 'movingui', 'css-var', 'bubble', 'flat', 'single', 'panels',
  'resetpanels', 'vn', 'closechat', 'forcesave', 'beep', 'hideme', 'expression-set', 'expression-last',
  'tempchat', 'scroll', 'chat-render', 'chat-reload', 'instruct-on', 'instruct-off', 'tokenizer', 'stop-strings',
])

/**
 * Run a script; its result is the last pipe. `host` answers what reaches the app:
 * - `command(name, { named, unnamed, text })`: a command it knows, its result the pipe; `undefined` for one it does not.
 * - `getVar(key)` / `setVar(key, value)` / `deleteVar(key)`: the chat's variables; `getGlobal` / `setGlobal` / `deleteGlobal` the app's.
 * - `macro(name)`: `{{user}}`, `{{char}}`, `{{lastMessage}}`… (undefined: the macro stays as written).
 * - `unknown(name)`: a command neither knows (skipped).
 * - `toast(text)`, `sleep(ms)`.
 */
export async function runScript(text, host, { pipe = '' } = {}) {
  const run = { host, steps: 0 }
  try {
    const result = await runBlock(run, parseScript(text), { vars: new Map(), parent: null }, pipe)
    return asText(result)
  } catch (signal) {
    if (signal instanceof Abort) return ''
    if (signal instanceof Return || signal instanceof Break) return asText(signal.value)
    throw signal
  }
}

// A script that loops without end would hold the page: past this many steps it stops.
const MAX_STEPS = 20000

async function runBlock(run, commands, scope, pipe) {
  let first = true
  for (const command of commands) {
    if (++run.steps > MAX_STEPS) throw new Error('STscript: too many steps')
    pipe = await runCommand(run, command, scope, pipe, first)
    first = false
  }
  return pipe
}

/** Read a scoped variable (/let, /var), from this closure's scope out. */
function scopedHas(scope, key) {
  for (let s = scope; s; s = s.parent) if (s.vars.has(key)) return s
  return null
}

async function substitute(run, text, scope, pipe) {
  if (typeof text !== 'string' || !text.includes('{{')) return text
  const host = run.host
  const parts = []
  let last = 0
  for (const m of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    parts.push(text.slice(last, m.index))
    last = m.index + m[0].length
    const [rawName, ...args] = m[1].split('::')
    const name = rawName.trim()
    const lower = name.toLowerCase()
    let value
    if (lower === 'pipe') value = asText(pipe)
    else if (lower === 'var') {
      const owner = scopedHas(scope, args[0])
      value = owner ? owner.vars.get(args[0]) : ''
      if (args[1] !== undefined && value && typeof value === 'object') value = value[args[1]]
    } else if (lower === 'getvar') value = await host.getVar(args[0])
    else if (lower === 'getglobalvar') value = await host.getGlobal(args[0])
    else if (lower === 'setvar') {
      await host.setVar(args[0], args.slice(1).join('::'))
      value = ''
    } else if (lower === 'addvar') {
      const old = await host.getVar(args[0])
      await host.setVar(args[0], typeof asValue(asText(old)) === 'number' || old === undefined || old === '' ? number(old) + number(args[1]) : asText(old) + args[1])
      value = ''
    } else if (lower === 'incvar' || lower === 'decvar') {
      const next = number(await host.getVar(args[0])) + (lower === 'incvar' ? 1 : -1)
      await host.setVar(args[0], next)
      value = next
    } else if (lower === 'timesindex') value = scopedHas(scope, 'timesIndex')?.vars.get('timesIndex') ?? ''
    else if (lower === 'newline') value = '\n'
    else if (lower === 'trim') value = ''
    else if (lower === 'noop') value = ''
    else value = await host.macro?.(name, args)
    parts.push(value === undefined ? m[0] : asText(value))
  }
  parts.push(text.slice(last))
  return parts.join('')
}

/** A closure to call: one written in place, or a scoped variable holding one (`/run name`). */
function closureOf(value, scope) {
  if (value instanceof Closure) return value
  const owner = typeof value === 'string' ? scopedHas(scope, value.trim()) : null
  const held = owner?.vars.get(value.trim())
  return held instanceof Closure ? held : null
}

async function callClosure(run, closure, scope, pipe, vars = {}) {
  const inner = { vars: new Map(Object.entries(vars)), parent: scope }
  try {
    return await runBlock(run, closure.commands, inner, pipe)
  } catch (signal) {
    if (signal instanceof Return) return signal.value
    throw signal
  }
}

/** /if and /while: left and right are values, or the names of variables (scoped, then the chat's). */
async function operand(run, value, scope) {
  if (value === undefined) return undefined
  const text = asText(value)
  const owner = scopedHas(scope, text)
  if (owner) return owner.vars.get(text)
  if (/^[A-Za-z_][\w.]*$/.test(text)) {
    const held = await run.host.getVar(text)
    if (held !== undefined && held !== '') return held
  }
  return text
}

async function test(run, named, scope) {
  const rule = String(named.rule ?? 'eq').toLowerCase()
  const left = await operand(run, named.left, scope)
  const right = await operand(run, named.right, scope)
  // Only one side: whether it holds something.
  if (named.right === undefined && !('rule' in named)) return truthy(left)
  return (RULES[rule] ?? RULES.eq)(left, right)
}

async function runCommand(run, command, scope, pipe, first) {
  const { host } = run
  const { name } = command
  // Arguments: macros filled (closures run later, their own macros then).
  const named = {}
  for (const [key, value] of Object.entries(command.named)) named[key] = value instanceof Closure ? value : await substitute(run, value, scope, pipe)
  let unnamed = command.unnamed instanceof Closure ? command.unnamed : await substitute(run, command.unnamed, scope, pipe)
  // No unnamed argument: the previous command's result is it.
  if ((unnamed === null || unnamed === undefined) && !first) unnamed = pipe
  const text = unnamed instanceof Closure ? '' : asText(unnamed)
  // The words before a closure (`/times 3 {: … :}`).
  const lead = String(await substitute(run, command.lead ?? '', scope, pipe)).trim()
  const words = () => text.split(/\s+/).filter(Boolean)
  const values = async () => Promise.all(words().map(async word => number(await operand(run, word, scope))))
  switch (name) {
    // Flow.
    case 'pass':
      return text
    case 'return':
      throw new Return(text)
    case 'abort':
      // Its own reason only, not what the pipe held.
      if (!/^(true|on)$/i.test(String(named.quiet ?? '')) && command.unnamed !== null && text) host.toast?.(text)
      throw new Abort()
    case 'break':
      throw new Break(text || pipe)
    case 'if': {
      const branch = (await test(run, named, scope)) ? unnamed : named.else
      const closure = closureOf(branch, scope)
      if (closure) return callClosure(run, closure, scope, pipe)
      return branch instanceof Closure || branch === undefined ? '' : asText(branch)
    }
    case 'while': {
      const closure = closureOf(unnamed, scope)
      if (!closure) return ''
      const unguarded = /^(off|false)$/i.test(String(named.guard ?? ''))
      let result = ''
      for (let i = 0; unguarded || i < 100; i++) {
        if (!(await test(run, named, scope))) break
        try {
          result = await callClosure(run, closure, scope, pipe)
        } catch (signal) {
          if (signal instanceof Break) return signal.value
          throw signal
        }
      }
      return result
    }
    case 'times': {
      // `/times 3 {: … :}`: the count, then the closure (or a variable holding one).
      const count = Math.min(Math.max(0, Math.floor(number(await operand(run, lead || words()[0] || '0', scope)))), 10000)
      const closure = closureOf(unnamed, scope) ?? closureOf(words()[1] ?? '', scope)
      if (!closure) return ''
      let result = ''
      for (let i = 0; i < count; i++) {
        try {
          result = await callClosure(run, closure, scope, pipe, { timesIndex: i })
        } catch (signal) {
          if (signal instanceof Break) return signal.value
          throw signal
        }
      }
      return result
    }
    case 'run': {
      // `/run who=小雪 greet`, or with the arguments after the name (`/run greet who=小雪`).
      const [target = '', ...rest] = unnamed instanceof Closure ? [] : words()
      const args = { ...Object.fromEntries(rest.map(word => word.split('=')).filter(pair => pair.length === 2)), ...named }
      const closure = closureOf(unnamed instanceof Closure ? unnamed : target, scope)
      if (closure) return callClosure(run, closure, scope, pipe, args)
      break
    }
    // Scoped variables.
    case 'let': {
      const key = String(named.key ?? (lead || words()[0] || ''))
      const value = named.key !== undefined || lead ? unnamed : text.slice(key.length).trim()
      scope.vars.set(key, value instanceof Closure ? value : asValue(value))
      return asText(value)
    }
    case 'var': {
      const key = String(named.key ?? (lead || words()[0] || ''))
      const given = named.key !== undefined || lead ? unnamed : text.slice(key.length).trim()
      const owner = scopedHas(scope, key) ?? scope
      if (given === '' || given === null || given === undefined) return asText(owner.vars.get(key))
      owner.vars.set(key, given instanceof Closure ? given : asValue(given))
      return asText(given)
    }
    // Chat variables (Tavern Helper's chat scope) and the app's global ones.
    case 'setvar':
    case 'setglobalvar': {
      const global = name === 'setglobalvar'
      const key = String(named.key ?? '')
      let value = asValue(text)
      if (named.index !== undefined) {
        const old = asValue(asText(global ? await host.getGlobal(key) : await host.getVar(key)))
        const holder = old && typeof old === 'object' ? old : /^\d+$/.test(named.index) ? [] : {}
        holder[named.index] = value
        value = holder
      }
      await (global ? host.setGlobal(key, value) : host.setVar(key, value))
      return asText(value)
    }
    case 'getvar':
    case 'getglobalvar': {
      const key = String(named.key ?? text)
      let value = name === 'getglobalvar' ? await host.getGlobal(key) : await host.getVar(key)
      if (named.index !== undefined) value = asValue(asText(value))?.[named.index]
      return asText(value)
    }
    case 'addvar':
    case 'addglobalvar': {
      const global = name === 'addglobalvar'
      const key = String(named.key ?? '')
      const old = asValue(asText(global ? await host.getGlobal(key) : await host.getVar(key)))
      const add = asValue(text)
      const value = Array.isArray(old) ? [...old, add] : typeof add === 'number' && (typeof old === 'number' || old === '' || old === undefined) ? number(old) + add : asText(old) + text
      await (global ? host.setGlobal(key, value) : host.setVar(key, value))
      return asText(value)
    }
    case 'incvar':
    case 'decvar':
    case 'incglobalvar':
    case 'decglobalvar': {
      const global = name.includes('global')
      const key = String(named.key ?? text)
      const value = number(global ? await host.getGlobal(key) : await host.getVar(key)) + (name.startsWith('inc') ? 1 : -1)
      await (global ? host.setGlobal(key, value) : host.setVar(key, value))
      return String(value)
    }
    case 'flushvar':
    case 'flushglobalvar':
      await (name === 'flushglobalvar' ? host.deleteGlobal(String(named.key ?? text)) : host.deleteVar(String(named.key ?? text)))
      return ''
    // Math and text.
    case 'add':
      return String((await values()).reduce((a, b) => a + b, 0))
    case 'mul':
      return String((await values()).reduce((a, b) => a * b, 1))
    case 'sub':
    case 'div':
    case 'mod':
    case 'pow': {
      const [a = 0, ...rest] = await values()
      const op = { sub: (x, y) => x - y, div: (x, y) => (y === 0 ? 0 : x / y), mod: (x, y) => (y === 0 ? 0 : x % y), pow: (x, y) => x ** y }[name]
      return String(rest.reduce(op, a))
    }
    case 'max':
    case 'min': {
      const list = await values()
      return list.length ? String(Math[name](...list)) : ''
    }
    case 'abs':
    case 'sqrt':
    case 'round':
    case 'floor':
    case 'ceil':
    case 'sin':
    case 'cos':
    case 'log': {
      const [a = 0] = await values()
      return String(Math[name](a))
    }
    case 'rand': {
      const from = number(named.from ?? 0)
      const to = number(named.to ?? (text ? text : 1))
      const value = from + Math.random() * (to - from)
      const how = String(named.round ?? '').toLowerCase()
      return String(how === 'round' ? Math.round(value) : how === 'ceil' ? Math.ceil(value) : how === 'floor' ? Math.floor(value) : value)
    }
    case 'len':
    case 'length': {
      const value = asValue(text)
      return String(Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : text.length)
    }
    case 'trim':
      return text.trim()
    case 'upper':
      return text.toUpperCase()
    case 'lower':
      return text.toLowerCase()
    case 'substr': {
      const start = number(named.start ?? 0)
      return named.end !== undefined ? text.slice(start, number(named.end)) : text.slice(start)
    }
    case 'replace': {
      const mode = String(named.mode ?? 'literal')
      const pattern = String(named.pattern ?? '')
      const replacer = String(named.replacer ?? '')
      if (mode === 'regex') {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern)
        try {
          return text.replace(m ? new RegExp(m[1], m[2]) : new RegExp(pattern, 'g'), replacer)
        } catch {
          return text
        }
      }
      return text.split(pattern).join(replacer)
    }
    case 'echo':
      host.toast?.(text)
      return text
    case 'delay':
    case 'wait':
      await host.sleep?.(Math.min(Math.max(0, number(text)), 10000))
      return ''
  }
  if (COSMETIC.has(name)) return ''
  const answered = await host.command?.(name, { named, unnamed, text })
  if (answered !== undefined) return answered
  host.unknown?.(name)
  return ''
}
