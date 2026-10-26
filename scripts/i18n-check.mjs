// Checks the interface's English (设置 → 界面语言; web/shared/i18n.js): every
// Chinese text in web/*.js is behind t`…` (or zh`…`, or on a line marked
// i18n-ignore), every one of those and every Chinese text in index.html has an
// entry in web/i18n/en.js, and every server message behind msg`…` has one in
// server/i18n/en.mjs. Entries must be English, fill the same {n}, and still be used.
//
//   node scripts/i18n-check.mjs          list the problems
//   node scripts/i18n-check.mjs --keys   also print missing keys as JSON
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hasCjk, htmlTexts, keyOf } from '../web/shared/i18n.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The string and template literals of a script, comments and regex literals
 * skipped. tag is the identifier right before a template (t, zh…); a string
 * passed straight to t(…) has tag 't'. cooked holds the text as the program
 * sees it (a template's parts between its ${…}).
 */
export function scanJs(src) {
  const out = []
  const n = src.length
  const lineAt = index => src.slice(0, index).split('\n').length
  const cook = (raw, quote) => {
    try {
      return Function(`return ${quote}${raw}${quote}`)()
    } catch {
      return raw
    }
  }
  const KEYWORDS_BEFORE_REGEX = /^(return|typeof|case|in|of|new|delete|void|throw|instanceof|yield|await|else|do)$/

  function readString(start) {
    const quote = src[start]
    let j = start + 1
    while (j < n && src[j] !== quote && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    const raw = src.slice(start + 1, j)
    const before = src.slice(Math.max(0, start - 40), start)
    out.push({ kind: 'string', tag: /(?:^|[^\w$.])t\(\s*$/.test(before) ? 't' : '', start, end: j + 1, line: lineAt(start), raw: [raw], cooked: [cook(raw, quote)] })
    return j + 1
  }

  function readTemplate(start, tag) {
    const raw = []
    let j = start + 1
    let partStart = j
    const literal = { kind: 'template', tag, start, end: 0, line: lineAt(start), raw, cooked: [] }
    out.push(literal)
    while (j < n) {
      const c = src[j]
      if (c === '\\') { j += 2; continue }
      if (c === '`') break
      if (c === '$' && src[j + 1] === '{') {
        raw.push(src.slice(partStart, j))
        j = scan(j + 2, true) + 1
        partStart = j
        continue
      }
      j++
    }
    raw.push(src.slice(partStart, j))
    literal.end = j + 1
    literal.cooked = raw.map(part => cook(part, '`'))
    return j + 1
  }

  /** Scans from i; inside a ${…} it stops at the closing brace and returns its index. */
  function scan(i, inExpression) {
    let prev = ''
    let depth = 0
    while (i < n) {
      const c = src[i]
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue }
      if (/\s/.test(c)) { i++; continue }
      if (c === "'" || c === '"') { i = readString(i); prev = 'literal'; continue }
      if (c === '`') { i = readTemplate(i, /^[\w$]+$/.test(prev) && !KEYWORDS_BEFORE_REGEX.test(prev) ? prev : ''); prev = 'literal'; continue }
      if (c === '/') {
        const division = prev === 'literal' || /^[)\]}]$/.test(prev) || (/^[\w$]+$/.test(prev) && !KEYWORDS_BEFORE_REGEX.test(prev))
        if (!division) {
          let j = i + 1
          let inClass = false
          while (j < n && src[j] !== '\n') {
            if (src[j] === '\\') { j += 2; continue }
            if (src[j] === '[') inClass = true
            else if (src[j] === ']') inClass = false
            else if (src[j] === '/' && !inClass) break
            j++
          }
          j++
          while (j < n && /[a-z]/i.test(src[j])) j++
          i = j
          prev = 'literal'
          continue
        }
      }
      if (/[\w$]/.test(c)) {
        let j = i
        while (j < n && /[\w$]/.test(src[j])) j++
        prev = src.slice(i, j)
        i = j
        continue
      }
      if (inExpression) {
        if (c === '{') depth++
        if (c === '}' && depth-- === 0) return i
      }
      prev = c
      i++
    }
    return i
  }

  scan(0, false)
  return out.sort((a, b) => a.start - b.start)
}

const lineOf = (src, index) => {
  const from = src.lastIndexOf('\n', index - 1) + 1
  const to = src.indexOf('\n', index)
  return src.slice(from, to < 0 ? src.length : to)
}

const DICTIONARY = /\/\/ i18n-dictionary-start\r?\n([\s\S]*?)\/\/ i18n-dictionary-end/

/** A file's own English table (between the i18n-dictionary markers), or null. */
export function inlineDictionary(src) {
  const block = DICTIONARY.exec(src)?.[1]
  if (!block) return null
  return Function(`return ${block.slice(block.indexOf('=') + 1)}`)()
}

/** The Chinese literals of a script, each with its key (null where none is looked up). */
export function chineseLiterals(src, { tags = ['t'] } = {}) {
  const table = DICTIONARY.exec(src)
  const inTable = index => table && index > table.index && index < table.index + table[0].length
  return scanJs(src)
    .filter(lit => lit.cooked.some(hasCjk))
    .map(lit => {
      const looked = tags.includes(lit.tag) && !inTable(lit.start)
      const kept = lit.tag === 'zh' || inTable(lit.start) || /i18n-ignore/.test(lineOf(src, lit.start))
      return { ...lit, key: looked ? keyOf(lit.cooked) : null, args: lit.cooked.length - 1, state: looked ? 'tagged' : kept ? 'kept' : 'bare' }
    })
}

const placeholders = text => [...text.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]))

/** Problems with one entry: it must be English and fill exactly the template's parts. */
export function entryProblems(key, value, args) {
  if (typeof value === 'function') {
    const samples = [[1], [2], [21]].map(([k]) => Array.from({ length: args }, (_, i) => (i === 0 ? k : `p${i}`)))
    for (const sample of samples) {
      let text
      try {
        text = value(...sample)
      } catch (error) {
        return [`throws: ${error.message}`]
      }
      if (typeof text !== 'string') return ['does not return text']
      if (hasCjk(text)) return ['still has Chinese']
    }
    return []
  }
  if (typeof value !== 'string') return ['is not text']
  const problems = []
  if (hasCjk(value)) problems.push('still has Chinese')
  if (!value.trim() && key.trim()) problems.push('is empty')
  const used = placeholders(value)
  for (let i = 0; i < args; i++) if (!used.includes(i)) problems.push(`leaves out {${i}}`)
  for (const i of used) if (i >= args) problems.push(`has {${i}}, the text has only ${args}`)
  return problems
}

const jsFiles = dir => readdirSync(dir).filter(name => /\.(m?js)$/.test(name)).map(name => path.join(dir, name))

// The subscription's page part (served as /subscription.js) is in this machine's own install only.
const SUBSCRIPTION_PAGE = path.join('server', 'subscription', 'page.js')

/** web/*.js, web/shared/*.js and the subscription's page part, without the dictionaries. */
export const webScripts = (root = ROOT) => [
  ...jsFiles(path.join(root, 'web')),
  ...jsFiles(path.join(root, 'web', 'shared')),
  ...(existsSync(path.join(root, SUBSCRIPTION_PAGE)) ? [path.join(root, SUBSCRIPTION_PAGE)] : []),
]

/** server/**\/*.mjs, without the dictionary. */
export function serverScripts(root = ROOT) {
  const dir = path.join(root, 'server')
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter(name => name.endsWith('.mjs') && !name.split(/[\\/]/).includes('i18n'))
    .map(name => path.join(dir, name))
}

/**
 * Every problem in the tree.
 * @returns {{ problems: { file, line, text, problem }[], missingWeb: object, missingServer: object }}
 */
export async function checkTree(root = ROOT) {
  const load = async file => import(pathToFileURL(path.join(root, file)).href)
  const webDict = (await load('web/i18n/en.js')).default
  const { default: serverDict, whole: wholeDict = {} } = await load('server/i18n/en.mjs')
  const problems = []
  const missingWeb = {}
  const missingServer = {}
  const rel = file => path.relative(root, file).split(path.sep).join('/')
  const usedWeb = new Map() // key → number of parts
  const usedServer = new Map()
  const bareServer = new Map() // keys of untagged server text, for the whole messages

  const ownTables = [] // files with their own English table (the subscription's page part)
  for (const file of webScripts(root)) {
    const src = readFileSync(file, 'utf8')
    const own = inlineDictionary(src)
    const dict = own ?? webDict
    const used = own ? new Map() : usedWeb
    if (own) ownTables.push([own, used, `${rel(file)} (its own table)`])
    for (const lit of chineseLiterals(src)) {
      const text = lit.cooked.join('${…}')
      if (lit.state === 'bare') problems.push({ file: rel(file), line: lit.line, text, problem: 'Chinese text not behind t`…` (zh`…` or // i18n-ignore if it stays Chinese)' })
      if (lit.state !== 'tagged') continue
      used.set(lit.key, lit.args)
      if (!Object.hasOwn(dict, lit.key)) {
        if (!own) missingWeb[lit.key] = rel(file)
        problems.push({ file: rel(file), line: lit.line, text, problem: own ? 'no English in its own table' : 'no English in web/i18n/en.js' })
      }
    }
  }
  const html = readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
  for (const piece of htmlTexts(html)) {
    if (!hasCjk(piece.text)) continue
    usedWeb.set(piece.text, 0)
    if (!Object.hasOwn(webDict, piece.text)) {
      missingWeb[piece.text] = 'web/index.html'
      problems.push({ file: 'web/index.html', line: piece.line, text: piece.text, problem: 'no English in web/i18n/en.js' })
    }
  }
  // Words the stylesheet shows (content: "…"): a Chinese one needs a :lang(en) rule for the same selector.
  const css = readFileSync(path.join(root, 'web', 'style.css'), 'utf8')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2], at: m.index }))
  const selectors = new Set(rules.map(rule => rule.selector))
  for (const rule of rules) {
    const shown = /content:\s*"([^"]*)"/.exec(rule.body)?.[1]
    if (!shown || !hasCjk(shown) || selectors.has(`:lang(en) ${rule.selector}`)) continue
    problems.push({ file: 'web/style.css', line: css.slice(0, rule.at).split('\n').length, text: shown, problem: 'Chinese in a CSS content with no :lang(en) rule for it' })
  }
  for (const file of serverScripts(root)) {
    const src = readFileSync(file, 'utf8')
    const own = inlineDictionary(src)
    const dict = own ?? serverDict
    const used = own ? new Map() : usedServer
    if (own) ownTables.push([own, used, `${rel(file)} (its own table)`])
    for (const lit of chineseLiterals(src, { tags: ['msg'] })) {
      if (lit.state !== 'tagged') {
        if (lit.state === 'bare') bareServer.set(keyOf(lit.cooked), lit.cooked.length - 1)
        continue
      }
      used.set(lit.key, lit.args)
      if (!Object.hasOwn(dict, lit.key)) {
        if (!own) missingServer[lit.key] = rel(file)
        problems.push({ file: rel(file), line: lit.line, text: lit.cooked.join('${…}'), problem: own ? 'no English in its own table' : 'no English in server/i18n/en.mjs' })
      }
    }
  }
  const dictionaries = [
    [webDict, usedWeb, 'web/i18n/en.js'],
    [serverDict, usedServer, 'server/i18n/en.mjs'],
    [wholeDict, bareServer, 'server/i18n/en.mjs (whole)'],
    ...ownTables,
  ]
  for (const [dict, used, name] of dictionaries) {
    for (const [key, value] of Object.entries(dict)) {
      if (!used.has(key)) {
        problems.push({ file: name, line: 0, text: key, problem: 'entry no longer used' })
        continue
      }
      for (const problem of entryProblems(key, value, used.get(key))) problems.push({ file: name, line: 0, text: key, problem: `entry ${problem}` })
    }
  }
  return { problems, missingWeb, missingServer }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, missingWeb, missingServer } = await checkTree()
  for (const p of problems) console.log(`${p.file}:${p.line}  ${p.problem}\n    ${p.text.replace(/\n/g, '\\n').slice(0, 160)}`)
  if (process.argv.includes('--keys')) console.log(JSON.stringify({ web: missingWeb, server: missingServer }, null, 1))
  console.log(problems.length ? `${problems.length} problem(s)` : 'English complete')
  process.exitCode = problems.length ? 1 : 0
}
