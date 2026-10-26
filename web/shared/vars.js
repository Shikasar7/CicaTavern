// Variable lookup and variable macros, shared by the server (prompts) and the
// web UI (display). Variables are `{ stat_data: <chat state> }`, matching the
// paths MVU cards use (`stat_data.角色.好感度`).

/**
 * A variable update in a reply: <state> (JSON merge patch) or MVU's
 * <UpdateVariable> (also spelled <update>); group 1 the tag, group 2 the body.
 * A block ends at its closing tag, at another update block's closing tag (some
 * models mix them up: <state>…</UpdateVariable>), or, cut off, at the reply's end.
 */
export const UPDATE_BLOCK = /<(state|update(?:variable)?)>([\s\S]*?)(?:<\/(?:state|update(?:variable)?)>|(?=<(?:state|update(?:variable)?)>)|$)/gi

/** Split `a.b[0].c` or `/a/b/0/c` into keys. */
export function splitPath(path) {
  const text = String(path ?? '').trim()
  if (text.startsWith('/')) return text.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
  return text.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
}

// Keys that lead to an object's prototype instead of a variable: a path with one is never written.
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether path keys stay among the variables themselves (none reaches a prototype). */
export const writablePath = keys => keys.every(key => !PROTOTYPE_KEYS.has(key))

/**
 * A card UI's change to a variable bucket applied to what is saved now: the top-level keys in `set` take their
 * values, those in `unset` go, every other key stays as saved (a turn's template or another frame may have
 * written it since the UI opened). → a new object.
 */
export function patchVars(current, patch) {
  const out = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) }
  const set = patch?.set && typeof patch.set === 'object' && !Array.isArray(patch.set) ? patch.set : {}
  for (const [key, value] of Object.entries(set)) if (!PROTOTYPE_KEYS.has(key)) out[key] = value
  for (const key of Array.isArray(patch?.unset) ? patch.unset : []) if (typeof key === 'string' && !PROTOTYPE_KEYS.has(key)) delete out[key]
  return out
}

export function getPath(root, path) {
  let cursor = root
  for (const key of splitPath(path)) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

/**
 * Old MVU stores `[value, "description"]`; readers want the value. Only
 * numeric/boolean values are unwrapped: `["伞", "钥匙"]` is indistinguishable
 * from a described string, and current MVU cards store plain values anyway.
 */
export function isDescribed(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string' && (typeof value[0] === 'number' || typeof value[0] === 'boolean')
}

export function unwrap(value) {
  return isDescribed(value) ? value[0] : value
}

export function variablesOf(state) {
  return { stat_data: state ?? {} }
}

/** Human-readable text of a variable: scalars as-is, structures as indented YAML-like lines. */
export function formatValue(value, indent = '') {
  const v = unwrap(value)
  if (v === undefined || v === null) return ''
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== 'object')) return v.map(x => String(x)).join('、') // i18n-ignore: state values, also sent to the model
    return v.map(x => `${indent}- ${formatValue(x, `${indent}  `).trimStart()}`).join('\n')
  }
  return Object.entries(v)
    .map(([k, x]) => {
      const inner = unwrap(x)
      return inner !== null && typeof inner === 'object' && !(Array.isArray(inner) && inner.every(y => typeof y !== 'object'))
        ? `${indent}${k}:\n${formatValue(inner, `${indent}  `)}`
        : `${indent}${k}: ${formatValue(inner)}`
    })
    .join('\n')
}

const VAR_MACRO = /\{\{\s*(get|format)_(message|chat|global)_variable::([^}]*?)\s*\}\}|\{\{\s*getvar::([^}]*?)\s*\}\}/gi

export function hasVariableMacros(text) {
  VAR_MACRO.lastIndex = 0
  return VAR_MACRO.test(String(text ?? ''))
}

/**
 * Resolve {{get_message_variable::p}}, {{format_message_variable::p}}, {{getvar::p}}
 * and the chat and global forms. As in SillyTavern, getvar and the chat forms read
 * the chat's own variables (`local`) and the global forms the app's (`global`);
 * a path not found there is read from the state ({stat_data}), as before.
 */
export function replaceVariableMacros(text, state, { local = null, global = null } = {}) {
  const vars = variablesOf(state)
  return String(text ?? '').replace(VAR_MACRO, (_, kind, scope, path, getvarPath) => {
    const where = getvarPath !== undefined || scope?.toLowerCase() === 'chat' ? local : scope?.toLowerCase() === 'global' ? global : null
    const own = where ? getPath(where, path ?? getvarPath) : undefined
    const value = own !== undefined ? own : getPath(vars, path ?? getvarPath)
    if (kind?.toLowerCase() === 'format') return formatValue(value)
    const v = unwrap(value)
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}
