// Game state updates written by the model at the end of a reply. Formats:
//   <state>{ "好感": 12, "位置": "茶馆" }</state>                 JSON merge patch (null deletes)
//   <UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感","value":12}]</JSONPatch></UpdateVariable>
//                                                               MVU (zod) JSON Patch
//   <UpdateVariable> _.set('好感', 10, 12); </UpdateVariable>    MVU (classic) calls
// The tag may also be spelled <update>; a block closed with another one's tag, or
// left open at the end of a cut-off reply, still counts (UPDATE_BLOCK). Model
// output is parsed as data by JSON/YAML parsers and a small literal parser — never evaluated.
import YAML from 'yaml'
// Old MVU values are [value, "description"]; reads and writes target the value slot.
import { isDescribed, splitPath, UPDATE_BLOCK, writablePath } from '../web/shared/vars.js'
import { CHOICES_BLOCK, SELF_CHECK_BLOCK, TIME_BOX_BLOCK } from '../web/shared/basic.js'
import { FOLD_TAG } from '../web/shared/vn.js'

const HIDDEN_BLOCKS = [
  UPDATE_BLOCK,
  // Reasoning in its own tag (<thinking>, <思考>…): folded on the page, not story for summaries or pictures.
  new RegExp(`<(${FOLD_TAG})>[\\s\\S]*?</\\1>`, 'gi'),
  /<StatusPlaceHolderImpl\s*\/>/gi,
  /<CreationPage\s*\/>/gi,
  // The built-in preset's time box and choices (web/shared/basic.js): the page draws them itself.
  TIME_BOX_BLOCK,
  CHOICES_BLOCK,
  SELF_CHECK_BLOCK,
  // 裁判表's judgment: a card shows it as it likes, but it is no story.
  /<judge>[\s\S]*?(?:<\/judge>|$)/gi,
]

// What a reply cut off may end in. The update and choices blocks run to the end of the text when unclosed, so a half
// one would be read as a whole one.
const OPEN_BLOCK = new RegExp(`<(state|update(?:variable)?|time_box|choices|self_check|judge|${FOLD_TAG})>(?![\\s\\S]*</\\1>)[\\s\\S]*$`, 'i')

/** A reply that stopped partway, without what it was in the middle of: a block, a template, a tag or a speaker's mark. */
export function withoutOpenEnd(text) {
  return String(text ?? '')
    .replace(OPEN_BLOCK, '')
    .replace(/<%(?![\s\S]*%>)[\s\S]*$/, '')
    .replace(/(?:<[^<>\n]*|【[^】\n]*)$/, '')
    .trimEnd()
}

/** Reply text as shown to the player when the card has no display regex: bookkeeping removed. */
export function displayText(text) {
  let out = String(text ?? '')
  for (const re of HIDDEN_BLOCKS) out = out.replace(re, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * What the update blocks in `text` make of `state`.
 * @returns { state, changes }, and `unread: true` when the reply has an update block and nothing in it could be read.
 */
export function applyStateUpdates(state, text) {
  const read = readUpdates(state, text)
  const changes = runCommands(read.state, read.commands)
  return { state: read.state, changes: [...new Set([...read.changes, ...changes])], ...(read.unread ? { unread: true } : {}) }
}

// MVU's names for what a JSON Patch operation does (its commands, as card scripts see them at COMMAND_PARSED).
const COMMAND_OF = { replace: 'set', delta: 'add', add: 'insert', insert: 'insert', remove: 'delete', move: 'move', copy: 'copy' }

/**
 * A reply's update blocks read the way MVU reads them, without running them yet: card scripts may change the
 * commands in between (card-scripts.mjs, MVU's COMMAND_PARSED), then applyCommands runs them.
 * @returns { state, commands, changes, unread }: `state` a copy of `state` with the reply's <state> patches merged in
 *   (they are no MVU commands), `changes` what those patches set; each command is { type, args, full_match, reason }
 *   as MVU makes it (args are the source of each argument), with `exact` (not enumerable): the operation as read,
 *   run as it was when a script left the command alone.
 */
export function readUpdates(state, text) {
  let next = structuredClone(state ?? {})
  const changes = []
  const commands = []
  let wrote = false
  let read = false
  const command = (type, args, fullMatch, exact) => Object.defineProperty({ type, args, full_match: fullMatch, reason: '' }, 'exact', { value: exact })
  const blocks = [...String(text ?? '').matchAll(UPDATE_BLOCK)]
  const isState = match => match[1].toLowerCase() === 'state'
  // <state> patches first, then MVU's updates.
  for (const match of blocks.filter(isState)) {
    const patch = parseLoose(match[2])
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      next = mergePatch(next, patch)
      changes.push(...Object.keys(patch).filter(key => writablePath([key])))
    }
  }
  for (const match of blocks.filter(match => !isState(match))) {
    const body = match[2]
    if (body.trim()) wrote = true
    for (const ops of jsonPatches(body)) {
      read = true
      for (const op of ops) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue
        const args = op.op === 'move' || op.op === 'copy' ? [String(op.from ?? ''), op.path] : op.op === 'remove' ? [op.path] : [op.path, JSON.stringify(op.value ?? null)]
        commands.push(command(COMMAND_OF[op.op] ?? String(op.op), args, JSON.stringify(op), { op }))
      }
    }
    for (const call of body.matchAll(/_\.(set|add)\s*\(([\s\S]*?)\)\s*;/g)) {
      let args
      try {
        args = parseArgs(call[2])
      } catch {
        continue
      }
      read = true
      const [pathArg] = args
      if (typeof pathArg !== 'string') continue
      const keys = statKeys(pathArg)
      if (!keys.length) continue
      commands.push(command(call[1], args.map(arg => JSON.stringify(arg ?? null)), call[0], { call: call[1], keys, args, label: pathArg }))
    }
  }
  return { state: next, commands, changes, unread: wrote && !read }
}

/**
 * `commands` (readUpdates, maybe changed by card scripts) run on a copy of `state`.
 * @returns { state, changes }: `changes` the paths they set.
 */
export function applyCommands(state, commands) {
  const next = structuredClone(state ?? {})
  return { state: next, changes: [...new Set(runCommands(next, commands))] }
}

/** Runs `commands` on `next` itself. → the paths they set. */
function runCommands(next, commands) {
  const changes = []
  for (const command of commands ?? []) {
    const exact = command?.exact
    if (exact?.op) {
      const changed = applyPatchOp(next, exact.op)
      if (changed) changes.push(changed)
    } else if (exact?.call) {
      // As _.set and _.add have always been played: their path counts as set even when the value could not be added.
      const { keys, args } = exact
      if (exact.call === 'set') {
        setPath(next, keys, args.length >= 3 ? args[2] : args[1])
      } else {
        const current = Number(readValue(next, keys) ?? 0)
        const delta = Number(args[1])
        if (Number.isFinite(current) && Number.isFinite(delta)) setPath(next, keys, current + delta)
      }
      changes.push(exact.label)
    } else {
      const changed = runScriptCommand(next, command)
      if (changed) changes.push(changed)
    }
  }
  return changes
}

/** One argument of a command a card script wrote or changed: JSON, a JS literal, else the text as it is. */
function argValue(source) {
  if (typeof source !== 'string') return source
  const text = source.trim()
  try {
    return JSON.parse(text)
  } catch {
    try {
      const [value] = parseArgs(text)
      return value === undefined ? text : value
    } catch {
      return text
    }
  }
}

/**
 * A command in MVU's own shape, as a card script made or changed it: set, add, insert (assign), delete (remove),
 * move and copy, with MVU's arguments (_.set takes the new value last, insert and delete may name a key).
 * → the path it set, or null.
 */
function runScriptCommand(next, command) {
  if (!command || typeof command !== 'object' || !Array.isArray(command.args)) return null
  const values = command.args.map(argValue)
  const keysOf = value => (typeof value === 'string' ? statKeys(value) : [])
  const keys = keysOf(values[0])
  if (!keys.length) return null
  const label = keys.join('.')
  switch (command.type) {
    case 'set':
      return values.length >= 2 && setPath(next, keys, values.length >= 3 ? values[2] : values[1]) ? label : null
    case 'add': {
      const target = readRaw(next, keys)
      if (Array.isArray(target)) return insertPath(next, [...keys, '-'], values[1]) ? label : null
      const current = Number(readValue(next, keys) ?? 0)
      const delta = Number(values[1])
      return Number.isFinite(current) && Number.isFinite(delta) && setPath(next, keys, current + delta) ? label : null
    }
    case 'insert':
    case 'assign': {
      if (values.length >= 3) return insertPath(next, [...keys, String(values[1])], values[2]) ? label : null
      const target = readRaw(next, keys)
      if (Array.isArray(target)) return insertPath(next, [...keys, '-'], values[1]) ? label : null
      if (isPlainObject(target) && isPlainObject(values[1])) {
        for (const [key, value] of Object.entries(values[1])) if (writablePath([key])) target[key] = value
        return label
      }
      return insertPath(next, keys, values[1]) ? label : null
    }
    case 'delete':
    case 'remove': {
      if (values.length < 2) return removePath(next, keys) ? label : null
      const target = readRaw(next, keys)
      // A list loses the item named (or at the index given); anything else the key.
      if (Array.isArray(target)) {
        const found = typeof values[1] === 'number' ? values[1] : target.findIndex(item => JSON.stringify(item) === JSON.stringify(values[1]))
        return found >= 0 && found < target.length && removePath(next, [...keys, String(found)]) ? label : null
      }
      return removePath(next, [...keys, String(values[1])]) ? label : null
    }
    case 'move':
    case 'copy':
      return applyPatchOp(next, { op: command.type, from: values[0], path: values[1] })
    default:
      return null
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Variable writes from templates (template.mjs diffWrites: replace/remove on
 * JSON-pointer paths) played back on a copy of `state`. Values land as written:
 * no `stat_data` prefix to drop and no old-MVU value slot, since the paths come
 * from the state itself.
 */
export function applyWrites(state, writes) {
  if (!Array.isArray(writes) || !writes.length) return state ?? {}
  let next = structuredClone(state ?? {})
  for (const write of writes) {
    if (!write || typeof write.path !== 'string') continue
    const keys = splitPath(write.path)
    if (!writablePath(keys)) continue
    if (!keys.length) {
      if (write.op === 'replace' && write.value && typeof write.value === 'object' && !Array.isArray(write.value)) next = structuredClone(write.value)
      continue
    }
    const last = keys.at(-1)
    if (write.op === 'remove') {
      const parent = readRaw(next, keys.slice(0, -1))
      if (parent !== null && typeof parent === 'object') delete parent[last]
    } else if (write.op === 'replace') {
      parentOf(next, keys)[last] = structuredClone(write.value)
    }
  }
  return next
}

/**
 * What turned `before` into `after`, as writes applyWrites plays back (a top-level key replaced or removed): how a
 * change made outside the update blocks (a card script at a turn's start) is kept with the turn and played back.
 */
export function stateWrites(before, after) {
  const pointer = key => `/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
  const was = before ?? {}
  const now = after ?? {}
  const writes = []
  for (const [key, value] of Object.entries(now)) if (JSON.stringify(value) !== JSON.stringify(was[key])) writes.push({ op: 'replace', path: pointer(key), value: structuredClone(value) })
  for (const key of Object.keys(was)) if (!Object.hasOwn(now, key)) writes.push({ op: 'remove', path: pointer(key) })
  return writes
}

/** The variables template writes touch, as dotted paths (for a turn's stateChanges). */
export function writeLabels(writes) {
  return (Array.isArray(writes) ? writes : []).map(write => splitPath(write?.path ?? '').join('.')).filter(Boolean)
}

/** JSON first; YAML accepts the trailing commas and single quotes models sometimes write. */
function parseLoose(text) {
  const source = String(text ?? '').trim()
  try {
    return JSON.parse(source)
  } catch {
    try {
      return YAML.parse(source)
    } catch {
      return null
    }
  }
}

/**
 * A `"` inside a string that nothing valid could follow is part of the text, as is a line break:
 * what models leave unescaped in the story text they put in a value.
 */
function mendStrings(source) {
  let out = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (!inString) {
      inString = ch === '"'
      out += ch
    } else if (ch === '\\') {
      out += ch + (source[++i] ?? '')
    } else if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ''
    } else if (ch === '"') {
      const after = /\S/.exec(source.slice(i + 1, i + 80))?.[0] ?? ''
      if (!after || ',}]:'.includes(after)) {
        inString = false
        out += ch
      } else out += '\\"'
    } else out += ch
  }
  return out
}

const CLOSER = { '{': '}', '[': ']' }

/**
 * Brackets in `text` from `from`, outside its strings.
 * @returns { end, kept, wanted, inString }: `end` just past the one closing the first (-1 when none does);
 *   `kept` the text without closers that close nothing; `wanted` the closers it still needs, innermost last.
 */
function balance(text, from = 0) {
  const wanted = []
  let kept = ''
  let end = -1
  let inString = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') kept += ch + (text[++i] ?? '')
      else {
        inString = ch !== '"'
        kept += ch
      }
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') wanted.push(CLOSER[ch])
    else if (ch === '}' || ch === ']') {
      if (wanted.at(-1) !== ch) continue
      wanted.pop()
      if (!wanted.length && end < 0) end = i + 1
    }
    kept += ch
  }
  return { end, kept, wanted, inString }
}

const isOp = value => value !== null && typeof value === 'object' && typeof value.op === 'string' && typeof value.path === 'string'
const OP_START = /\{\s*"(?:op|path)"\s*:/g

function nextOp(text, from) {
  OP_START.lastIndex = from
  return OP_START.exec(text)?.index ?? -1
}

/**
 * The operations that can be read in a patch that does not parse as a whole, each on its own: a stray or
 * missing bracket in one (measured: about one patch in twelve) costs that one at most, not the turn's whole
 * update. An operation cut off by the end of a reply is left out, not guessed at.
 */
function salvagePatch(source) {
  const text = mendStrings(source)
  const mended = parseLoose(text)
  if (Array.isArray(mended)) return mended
  const finished = text.trimEnd().endsWith(']')
  const ops = []
  for (let start = nextOp(text, 0); start >= 0;) {
    const { end } = balance(text, start)
    const whole = end > 0 ? parseLoose(text.slice(start, end)) : null
    if (isOp(whole)) {
      ops.push(whole)
      start = nextOp(text, end)
      continue
    }
    const after = nextOp(text, start + 1)
    if (after >= 0 || finished) {
      const piece = balance(text.slice(start, after < 0 ? text.length : after))
      const repaired = piece.inString ? null : parseLoose(piece.kept.replace(/[\s,]+$/, '') + piece.wanted.reverse().join(''))
      if (isOp(repaired)) ops.push(repaired)
    }
    start = after
  }
  return ops
}

/** Every JSON Patch array inside an update block: <JSONPatch> tags (a cut-off reply may not close them), else a bare top-level array. */
function jsonPatches(body) {
  const tagged = [...body.matchAll(/<JSONPatch>([\s\S]*?)(?:<\/JSONPatch>|$)/gi)].map(m => m[1])
  const sources = tagged.length ? tagged : (/^\s*\[[\s\S]*\]\s*$/m.test(body) ? [body.slice(body.indexOf('['), body.lastIndexOf(']') + 1)] : [])
  return sources.flatMap(source => {
    const whole = parseLoose(source)
    if (Array.isArray(whole)) return [whole]
    const ops = salvagePatch(source)
    return ops.length ? [ops] : []
  })
}

/**
 * Apply one RFC 6902 operation (plus MVU's `delta` and `insert`) to `root`.
 * Paths are JSON Pointers relative to the state; a leading `/stat_data` is accepted.
 * @returns the path that changed, or null.
 */
function applyPatchOp(root, op) {
  if (!op || typeof op !== 'object' || typeof op.path !== 'string') return null
  const keys = statKeys(op.path)
  const label = keys.join('.')
  switch (op.op) {
    case 'replace':
      return setPath(root, keys, op.value) ? label : null
    case 'add':
    case 'insert':
      return insertPath(root, keys, op.value) ? label : null
    case 'remove':
      return removePath(root, keys) ? label : null
    case 'delta': {
      const current = Number(readValue(root, keys) ?? 0)
      const delta = Number(op.value)
      return Number.isFinite(current) && Number.isFinite(delta) && setPath(root, keys, current + delta) ? label : null
    }
    case 'move':
    case 'copy': {
      if (typeof op.from !== 'string') return null
      const from = statKeys(op.from)
      if (!from.length) return null
      const value = structuredClone(readRaw(root, from))
      if (value === undefined) return null
      if (op.op === 'move') removePath(root, from)
      return insertPath(root, keys, value) ? label : null
    }
    default:
      return null
  }
}

/**
 * Path keys relative to the state; a leading `stat_data` (as cards often write) is dropped. None for a
 * path that reaches a prototype (`__proto__`…): model output and card scripts must not change the server's objects.
 */
function statKeys(path) {
  const keys = splitPath(path)
  if (keys[0] === 'stat_data') keys.shift()
  return writablePath(keys) ? keys : []
}

function mergePatch(target, patch) {
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (!writablePath([key])) continue
    if (value === null) delete out[key]
    else if (typeof value === 'object' && !Array.isArray(value)) out[key] = mergePatch(out[key], value)
    else out[key] = value
  }
  return out
}


// The state's own values only, never what objects inherit (toString…).
function readRaw(object, keys) {
  let cursor = object
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function readValue(object, keys) {
  const value = readRaw(object, keys)
  return isDescribed(value) ? value[0] : value
}

/** Parent container of the last key, creating plain objects on the way. */
function parentOf(object, keys) {
  let cursor = object
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  return cursor
}

/** `value` at a dotted path of `state`, the objects on the way made as needed; a path that is not a variable's is left. */
export function setStatePath(state, path, value) {
  const keys = splitPath(path)
  if (writablePath(keys)) setPath(state, keys, value)
}

/** The paths in `written` that `kept` no longer has (variable rules drop what they do not name), the shortest of each. */
export function lostPaths(written, kept, keys = []) {
  const lost = []
  for (const [key, value] of Object.entries(written ?? {})) {
    if (key.startsWith('$')) continue
    const path = [...keys, key]
    if (!Object.hasOwn(kept ?? {}, key)) lost.push(path.join('.'))
    else if (value && typeof value === 'object' && !Array.isArray(value) && kept[key] && typeof kept[key] === 'object') lost.push(...lostPaths(value, kept[key], path))
  }
  return lost
}

function setPath(object, keys, value) {
  const last = keys.at(-1)
  if (last === undefined) return false
  const parent = parentOf(object, keys)
  if (isDescribed(parent[last]) && !Array.isArray(value)) parent[last][0] = value
  else parent[last] = value
  return true
}

function insertPath(object, keys, value) {
  const last = keys.at(-1)
  if (last === undefined) return false
  // `-` appends to a list. Where none is yet (a chat older than the variable, or one value written in its place), start
  // one with what was there: as an object, each later add would overwrite its one key "-" and the earlier item be lost.
  if (last === '-' && keys.length > 1) {
    const holder = parentOf(object, keys.slice(0, -1))
    const was = holder[keys.at(-2)]
    const earlier = was && typeof was === 'object' && !Array.isArray(was) && Object.keys(was).join() === '-' ? [was['-']] : null
    if (was === undefined || was === null) holder[keys.at(-2)] = []
    else if (earlier) holder[keys.at(-2)] = earlier
    else if (typeof was !== 'object') holder[keys.at(-2)] = [was]
  }
  const parent = parentOf(object, keys)
  if (Array.isArray(parent)) {
    const index = last === '-' ? parent.length : Number(last)
    if (!Number.isInteger(index) || index < 0 || index > parent.length) return false
    parent.splice(index, 0, value)
    return true
  }
  parent[last] = value
  return true
}

function removePath(object, keys) {
  const last = keys.at(-1)
  if (last === undefined) return false
  const parent = readRaw(object, keys.slice(0, -1))
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, last)) return false
  if (Array.isArray(parent)) parent.splice(Number(last), 1)
  else delete parent[last]
  return true
}

/** Parse a comma-separated list of JS literals (strings, numbers, bools, null, arrays, objects). */
export function parseArgs(source) {
  const p = { src: source.replace(/\/\/[^\n]*/g, ''), pos: 0 }
  const values = []
  skip(p)
  while (p.pos < p.src.length) {
    values.push(parseValue(p))
    skip(p)
    if (p.src[p.pos] !== ',') break
    p.pos++
    skip(p)
  }
  return values
}

function skip(p) {
  while (/\s/.test(p.src[p.pos] ?? '')) p.pos++
}

function parseValue(p) {
  skip(p)
  const ch = p.src[p.pos]
  if (ch === '"' || ch === "'" || ch === '`') return parseString(p, ch)
  if (ch === '[') return parseList(p, ']', () => parseValue(p), [], (acc, v) => acc.push(v))
  if (ch === '{') {
    return parseList(p, '}', () => {
      const q = p.src[p.pos]
      const key = q === '"' || q === "'" ? parseString(p, q) : parseIdent(p)
      skip(p)
      if (p.src[p.pos++] !== ':') throw new Error('expected :')
      return [key, parseValue(p)]
    }, {}, (acc, [k, v]) => { acc[k] = v })
  }
  const word = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null|undefined)/i.exec(p.src.slice(p.pos))
  if (!word) throw new Error(`unexpected token at ${p.pos}`)
  p.pos += word[0].length
  const w = word[0].toLowerCase()
  if (w === 'true') return true
  if (w === 'false') return false
  if (w === 'null' || w === 'undefined') return null
  return Number(word[0])
}

function parseList(p, close, item, acc, add) {
  p.pos++
  skip(p)
  while (p.src[p.pos] !== close) {
    if (p.pos >= p.src.length) throw new Error('unterminated literal')
    add(acc, item())
    skip(p)
    if (p.src[p.pos] === ',') p.pos++
    skip(p)
  }
  p.pos++
  return acc
}

// Unquoted keys: letters of any script, digits, _ and $. Without ICU (the Android
// app's Node) \p{…} is a syntax error, so it is built at run time, and there any
// non-ASCII character outside the space and punctuation blocks counts as a letter.
export const IDENT_WITHOUT_ICU =
  /^[A-Za-z_$À-ÖØ-öø-῿⁰-⿿぀-︯ﹰ-﻿Ａ-Ｚａ-ｚｦ-￯\u{10000}-\u{10FFFF}][0-9A-Za-z_$À-ÖØ-öø-῿⁰-⿿぀-︯ﹰ-﻿０-９Ａ-Ｚａ-ｚｦ-￯\u{10000}-\u{10FFFF}]*/u
const IDENT = (() => {
  try {
    return new RegExp('^[\\p{L}_$][\\p{L}\\p{N}_$]*', 'u')
  } catch {
    return IDENT_WITHOUT_ICU
  }
})()

function parseIdent(p) {
  const m = IDENT.exec(p.src.slice(p.pos))
  if (!m) throw new Error('expected key')
  p.pos += m[0].length
  return m[0]
}

function parseString(p, quote) {
  p.pos++
  let out = ''
  while (p.pos < p.src.length && p.src[p.pos] !== quote) {
    if (p.src[p.pos] === '\\') {
      const next = p.src[++p.pos]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
    } else out += p.src[p.pos]
    p.pos++
  }
  if (p.src[p.pos] !== quote) throw new Error('unterminated string')
  p.pos++
  return out
}
