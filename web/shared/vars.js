// Variable lookup and variable macros, shared by the server (prompts) and the
// web UI (display). Variables are `{ stat_data: <chat state> }`, matching the
// paths MVU cards use (`stat_data.角色.好感度`).

/** Split `a.b[0].c` or `/a/b/0/c` into keys. */
export function splitPath(path) {
  const text = String(path ?? '').trim()
  if (text.startsWith('/')) return text.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
  return text.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
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
    if (v.every(x => x === null || typeof x !== 'object')) return v.map(x => String(x)).join('、')
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

const VAR_MACRO = /\{\{\s*(get|format)_(?:message|chat|global)_variable::([^}]*?)\s*\}\}|\{\{\s*getvar::([^}]*?)\s*\}\}/gi

export function hasVariableMacros(text) {
  VAR_MACRO.lastIndex = 0
  return VAR_MACRO.test(String(text ?? ''))
}

/** Resolve {{get_message_variable::p}}, {{format_message_variable::p}}, {{getvar::p}}. */
export function replaceVariableMacros(text, state) {
  const vars = variablesOf(state)
  return String(text ?? '').replace(VAR_MACRO, (_, kind, path, getvarPath) => {
    const value = getPath(vars, path ?? getvarPath)
    if (kind?.toLowerCase() === 'format') return formatValue(value)
    const v = unwrap(value)
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}
