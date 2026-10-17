// EJS worldbook templates (ST-Prompt-Template style) evaluated inside a
// QuickJS WebAssembly sandbox: no filesystem, network, process or host objects,
// a time limit and a memory limit. Card code never runs in the Node process.
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

const TIME_LIMIT_MS = 200
const MEMORY_LIMIT = 16 * 1024 * 1024
let quickjs = null

export async function initTemplates() {
  quickjs ??= await getQuickJS()
}

export function hasTemplate(text) {
  return /<%[\s\S]*?%>/.test(String(text ?? '')) || splitDecorators(text).condition !== null
}

/**
 * ST-Prompt-Template decorators: `@@name …` lines at the top of an entry.
 * `@@if <expr>` becomes a condition on the whole entry; the rest (`@@private`
 * etc.) only matter to its shared scope, and each entry here renders in its own.
 */
export function splitDecorators(text) {
  const lines = String(text ?? '').split('\n')
  const conditions = []
  while (lines.length && /^\s*@@\w/.test(lines[0])) {
    const condition = /^\s*@@if\s+(.+?)\s*$/.exec(lines.shift())
    if (condition) conditions.push(`(${condition[1]})`)
  }
  return { body: lines.join('\n'), condition: conditions.length ? conditions.join(' && ') : null }
}

/**
 * Compile EJS into a JS function body that returns the rendered string.
 * Supports <% %>, <%_ _%> / -%> whitespace control, <%= %> and <%- %> output
 * (both unescaped: the output is prompt text, not HTML), <%# %> comments and <%% literals.
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

// Read-only helpers exposed to templates. `setvar` and friends are accepted
// but ignored: prompt templates must not change game state.
const PRELUDE = `
const __get = (root, path) => {
  const keys = String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.').filter(Boolean);
  let c = root;
  for (const k of keys) { if (c === null || typeof c !== 'object') return undefined; c = c[k]; }
  return c;
};
const __unwrap = v => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && (typeof v[0] === 'number' || typeof v[0] === 'boolean') ? v[0] : v;
const __str = v => v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const variables = __vars;
const stat_data = __vars.stat_data;
function getvar(path, options) {
  const v = path === undefined || path === null || path === '' ? __vars : __unwrap(__get(__vars, path));
  return v === undefined && options && 'defaults' in options ? options.defaults : v;
}
const getMessageVariable = getvar, getChatVariable = getvar, getGlobalVariable = getvar, getLocalVar = getvar, getGlobalVar = getvar;
function setvar() {} const setMessageVariable = setvar, setChatVariable = setvar, setLocalVar = setvar, setGlobalVar = setvar, incvar = setvar, decvar = setvar;
const _ = {
  get: (o, p, d) => { const v = __get(o, p); return v === undefined ? d : v; },
  has: (o, p) => __get(o, p) !== undefined,
  isNil: v => v === undefined || v === null,
  isNumber: v => typeof v === 'number',
  isString: v => typeof v === 'string',
  clamp: (n, lo, hi) => Math.min(Math.max(n, lo), hi),
};
`

/**
 * Render an EJS template against the chat variables. Returns the template's
 * output, or null (with `error`) when it fails to compile or run.
 * @param names - { char, user } for the `char` / `user` globals.
 */
export function renderTemplate(template, { variables, names }) {
  const { body, condition } = splitDecorators(template)
  if (!hasTemplate(template)) return { text: body, error: null }
  if (!quickjs) throw new Error('templates not initialised')
  const source = condition ? `<% if (${condition}) { %>${body}<% } %>` : body
  const program = `(() => {
    const __vars = ${JSON.stringify(variables ?? {})};
    const char = ${JSON.stringify(names?.char ?? '')}, user = ${JSON.stringify(names?.user ?? '')};
    ${PRELUDE}
    return (() => { ${compileEjs(source)} })();
  })()`
  try {
    const text = quickjs.evalCode(program, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + TIME_LIMIT_MS),
      memoryLimitBytes: MEMORY_LIMIT,
    })
    return { text: typeof text === 'string' ? text : String(text ?? ''), error: null }
  } catch (error) {
    return { text: null, error: String(error?.message ?? error).slice(0, 200) }
  }
}
