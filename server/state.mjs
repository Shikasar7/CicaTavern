// Game state updates written by the model at the end of a reply. Formats:
//   <state>{ "好感": 12, "位置": "茶馆" }</state>                 JSON merge patch (null deletes)
//   <UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感","value":12}]</JSONPatch></UpdateVariable>
//                                                               MVU (zod) JSON Patch
//   <UpdateVariable> _.set('好感', 10, 12); </UpdateVariable>    MVU (classic) calls
// The tag may also be spelled <update>. Model output is parsed as data by
// JSON/YAML parsers and a small literal parser — never evaluated.
import YAML from 'yaml'
// Old MVU values are [value, "description"]; reads and writes target the value slot.
import { isDescribed, splitPath } from '../web/shared/vars.js'

const STATE_BLOCK = /<state>([\s\S]*?)<\/state>/gi
const MVU_BLOCK = /<(update(?:variable)?)>([\s\S]*?)<\/\1>/gi
const HIDDEN_BLOCKS = [
  STATE_BLOCK,
  MVU_BLOCK,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<think>[\s\S]*?<\/think>/gi,
  /<StatusPlaceHolderImpl\s*\/>/gi,
  // The built-in preset's time box and choices (web/shared/basic.js): the page draws them itself.
  /<time_box>[\s\S]*?<\/time_box>/gi,
  /<choices>[\s\S]*?<\/choices>/gi,
]

/** Reply text as shown to the player when the card has no display regex: bookkeeping removed. */
export function displayText(text) {
  let out = String(text ?? '')
  for (const re of HIDDEN_BLOCKS) out = out.replace(re, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function applyStateUpdates(state, text) {
  let next = structuredClone(state ?? {})
  const changes = []
  for (const match of String(text ?? '').matchAll(STATE_BLOCK)) {
    const patch = parseLoose(match[1])
    if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
      next = mergePatch(next, patch)
      changes.push(...Object.keys(patch))
    }
  }
  for (const match of String(text ?? '').matchAll(MVU_BLOCK)) {
    const body = match[2]
    for (const ops of jsonPatches(body)) {
      for (const op of ops) {
        const changed = applyPatchOp(next, op)
        if (changed) changes.push(changed)
      }
    }
    for (const call of body.matchAll(/_\.(set|add)\s*\(([\s\S]*?)\)\s*;/g)) {
      let args
      try {
        args = parseArgs(call[2])
      } catch {
        continue
      }
      const [pathArg] = args
      if (typeof pathArg !== 'string') continue
      const keys = statKeys(pathArg)
      if (call[1] === 'set') {
        setPath(next, keys, args.length >= 3 ? args[2] : args[1])
      } else {
        const current = Number(readValue(next, keys) ?? 0)
        const delta = Number(args[1])
        if (Number.isFinite(current) && Number.isFinite(delta)) setPath(next, keys, current + delta)
      }
      changes.push(pathArg)
    }
  }
  return { state: next, changes: [...new Set(changes)] }
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

/** Every JSON Patch array inside an update block: <JSONPatch> tags, else a bare top-level array. */
function jsonPatches(body) {
  const tagged = [...body.matchAll(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/gi)].map(m => m[1])
  const sources = tagged.length ? tagged : (/^\s*\[[\s\S]*\]\s*$/m.test(body) ? [body.slice(body.indexOf('['), body.lastIndexOf(']') + 1)] : [])
  return sources.map(parseLoose).filter(Array.isArray)
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
      const value = structuredClone(readRaw(root, from))
      if (value === undefined) return null
      if (op.op === 'move') removePath(root, from)
      return insertPath(root, keys, value) ? label : null
    }
    default:
      return null
  }
}

/** Path keys relative to the state; a leading `stat_data` (as cards often write) is dropped. */
function statKeys(path) {
  const keys = splitPath(path)
  if (keys[0] === 'stat_data') keys.shift()
  return keys
}

function mergePatch(target, patch) {
  const out = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else if (typeof value === 'object' && !Array.isArray(value)) out[key] = mergePatch(out[key], value)
    else out[key] = value
  }
  return out
}


function readRaw(object, keys) {
  let cursor = object
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object') return undefined
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
  if (parent === null || typeof parent !== 'object' || !(last in parent)) return false
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
