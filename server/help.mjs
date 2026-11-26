// 应用帮助 (直连对话): the assistant answers questions about CicaTavern itself from its help docs (docs/help, the
// same sections the QQ group's answer bot reads) and, when they do not say, from the app's own source.
//
// Two parts:
// - A turn's message gets the help sections its question finds (retrieve): keyword search (BM25 over Chinese
//   character pairs and Latin words, the title and aliases weighing most) and an error's own text matched
//   run by run. Only when the message plainly asks about the app (see FOUND): anything else costs nothing.
// - The model may look further before it answers (lookupOf / runLookup): one line, <lookup>{json}</lookup>, at
//   the very start of its reply: search the help or read sections, list, search or read the source. Plain
//   text rather than a provider's own tool calling, so every model the app can use can do it.
//
// The source tools only read, and only the app's own files: server/ and web/ under the app folder, text
// files of an app's own kind, never the subscription backend, never a path outside (no `..`, no links).
// The user's data folder, keys and chats live elsewhere and cannot be reached.
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callGate } from './tools/calls.mjs'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const FILES = ['overview.md', 'features.md', 'errors.md', 'faq.md', 'versions.md']
const FIELDS = ['也叫', '在哪', '平台', '版本', '原文', '英文', '出现在', '原因', '解决']
const HEADING = /^## (.+?) \{#([a-z0-9]+(?:-[a-z0-9]+)*)\}\s*$/
const FIELD_LINE = /^- ([^：:]{1,6})[：:]\s*(.*)$/
const INDEX_SECTION = 'feature-list'
const KIND = { 'overview.md': '简介', 'features.md': '功能', 'errors.md': '报错', 'faq.md': '常见问题', 'versions.md': '版本' }

// What a turn's message carries by itself: at most this many sections, this many characters in all.
const AUTO_SECTIONS = 4
const AUTO_CHARS = 6000
// Further candidates named (id and title) after them, for the model to read if it wants.
const AUTO_MORE = 6
// Sections go with a message by themselves only when it plainly asks about the app: it quotes one of the app's
// error messages, or names the app (NAMES) and finds a section scoring at least FOUND. The keyword score alone
// cannot tell: on the QQ group's questions and everyday ones (写个 Python 函数, React 和 Vue 有什么区别) a bar
// keeping 84% of the group's let 18 of 40 everyday ones through. Any other question about the app, the model
// looks up itself (search_help), so a question about anything else costs nothing.
export const FOUND = 8
// The app's own name, left out of a search's words.
const APP_NAME = /cicatavern|cica|tavern/gi
const NAMES = /cica|tavern|酒馆|这个(?:软件|应用|app|程序|工具)|本(?:软件|应用)|这软件|这应用/i
// 查资料 in a reply: at most this many lookups before the answer.
export const MAX_LOOKUPS = 6
const SEARCH_RESULTS = 8
// The first few of a search's results come whole, within this many characters.
const SEARCH_WHOLE = 2
const SEARCH_WHOLE_CHARS = 5000
const READ_SECTIONS = 4
const SUMMARY_CHARS = 100

// The source, read only.
const SOURCE_DIRS = ['server', 'web']
const SOURCE_EXT = /\.(m?js|css|html|json|md|txt)$/i
const MAX_FILE = 512 * 1024
// Not the app's to show: the subscription backend of the author's own install.
const PRIVATE_SOURCE = /^server\/subscription\//
const MATCHES = 40
const LINE_CHARS = 200
const READ_LINES = 200
const LIST_ENTRIES = 120
const RESULT_CHARS = 12000

// ── The help docs ──────────────────────────────────────────────────────────────────────────────

/** The sections of one help file, in order: { id, file, area, title, fields: { 也叫: [...] }, body }. */
export function parseHelp(text, file) {
  const sections = []
  let area = ''
  let current = null
  let inFields = false
  const close = () => {
    if (current && current.id !== INDEX_SECTION) sections.push({ ...current, body: current.body.join('\n').trim() })
  }
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(HEADING)
    if (heading) {
      close()
      current = { id: heading[2], file, area, title: heading[1].trim(), fields: {}, body: [] }
      inFields = true
      continue
    }
    if (line.startsWith('# ') || line.startsWith('## ')) {
      close()
      current = null
      if (line.startsWith('# ')) area = line.slice(2).trim()
      continue
    }
    if (!current) continue
    // The field list comes right after the heading; the first other line starts the body.
    if (inFields) {
      const field = line.match(FIELD_LINE)
      if (field && FIELDS.includes(field[1])) {
        ;(current.fields[field[1]] ??= []).push(field[2].trim())
        continue
      }
      if (!line.trim() && !Object.keys(current.fields).length) continue
      inFields = false
    }
    current.body.push(line)
  }
  close()
  // A file's own title is a level-1 heading too: it is not an area.
  const title = String(text).split(/\r?\n/).find(line => line.startsWith('# '))?.slice(2).trim() ?? ''
  return sections.map(section => (section.area === title ? { ...section, area: '' } : section))
}

/** The whole section as the model reads it. */
export function sectionText(section) {
  const lines = [`## ${section.title} {#${section.id}}`]
  for (const name of FIELDS) for (const value of section.fields[name] ?? []) lines.push(`- ${name}：${value}`)
  if (section.body) lines.push('', section.body)
  return lines.join('\n')
}

/** One line for a candidate: id, title, aliases, where, the body's start. */
function summary(section) {
  const aliases = (section.fields['也叫'] ?? []).join('、')
  const where = (section.fields['在哪'] ?? []).join('；')
  const body = section.body.split(/\s+/).join(' ').slice(0, SUMMARY_CHARS)
  return `[${section.id}] ${KIND[section.file] ?? ''}·${section.title}${aliases ? `（也叫：${aliases}）` : ''}${where ? `｜在哪：${where}` : ''}｜${body}`
}

const RUN = /[㐀-鿿豈-﫿]+|[a-z0-9]+/g
const CJK = /^[㐀-鿿豈-﫿]/

/** Words for searching: neighbouring character pairs in Chinese, whole words otherwise. */
export function tokens(text) {
  const out = []
  for (const run of String(text).toLowerCase().match(RUN) ?? []) {
    if (CJK.test(run)) {
      if (run.length === 1) out.push(run)
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    } else out.push(run)
  }
  return out
}

// How much a word counts, by where in the section it stands (a simple BM25F).
const WEIGHTS = { title: 3, 也叫: 3, 在哪: 2, 原文: 2, 英文: 2, body: 1 }
const K1 = 1.2
const B = 0.75

function fieldsOf(section) {
  const rest = ['平台', '版本', '出现在', '原因', '解决'].flatMap(name => section.fields[name] ?? [])
  return {
    title: section.title,
    也叫: (section.fields['也叫'] ?? []).join(' '),
    在哪: (section.fields['在哪'] ?? []).join(' '),
    原文: (section.fields['原文'] ?? []).join(' '),
    英文: (section.fields['英文'] ?? []).join(' '),
    body: [...rest, section.body].join('\n'),
  }
}

// An error the user pasted: runs of this many characters (spaces and punctuation dropped) shared with an
// error section's own text, at least MIN_RUNS of them.
const SHINGLE = 8
const MIN_RUNS = 2
const MIN_WHOLE = 6
const PLACEHOLDER = /\{\d+\}/g
// Spaces and punctuation; ranges rather than \p{…}, which the phone's Node (no ICU) lacks. The messages are Chinese and English.
const NOT_TEXT = /[^a-z0-9_㐀-鿿豈-﫿]+/g
const squash = text => String(text).replace(PLACEHOLDER, ' ').replace(APP_NAME, ' ').toLowerCase().replace(NOT_TEXT, '')
const shingles = text => {
  const out = new Set()
  for (let i = 0; i + SHINGLE <= text.length; i++) out.add(text.slice(i, i + SHINGLE))
  return out
}

/** The help docs, searchable. */
export function helpIndex(sections) {
  const byId = new Map(sections.map(section => [section.id, section]))
  const tf = []
  const lengths = []
  const df = new Map()
  for (const section of sections) {
    const counts = new Map()
    for (const [name, text] of Object.entries(fieldsOf(section))) {
      for (const term of tokens(text)) counts.set(term, (counts.get(term) ?? 0) + WEIGHTS[name])
    }
    tf.push(counts)
    lengths.push([...counts.values()].reduce((a, b) => a + b, 0))
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = sections.length
  const avg = n ? lengths.reduce((a, b) => a + b, 0) / n : 1
  const idf = new Map([...df].map(([term, d]) => [term, Math.log(1 + (n - d + 0.5) / (d + 0.5))]))
  const owners = new Map()
  // A short message quoted whole (模型没有返回正文) has too few runs: [its text, section index].
  const wholes = []
  sections.forEach((section, i) => {
    for (const line of [...(section.fields['原文'] ?? []), ...(section.fields['英文'] ?? [])]) {
      for (const part of line.split(PLACEHOLDER)) {
        const text = squash(part)
        if (text.length >= MIN_WHOLE) wholes.push([text, i])
        for (const shingle of shingles(text)) {
          if (!owners.has(shingle)) owners.set(shingle, new Set())
          owners.get(shingle).add(i)
        }
      }
    }
  })

  /** [{ section, score }], best first; 0 never comes back. */
  function search(query, k = 30) {
    const terms = new Map()
    for (const term of tokens(query)) terms.set(term, (terms.get(term) ?? 0) + 1)
    const scored = []
    tf.forEach((counts, i) => {
      const norm = K1 * (1 - B + (B * lengths[i]) / avg)
      let score = 0
      for (const [term, times] of terms) {
        const f = counts.get(term)
        if (f !== undefined) score += (times * idf.get(term) * f * (K1 + 1)) / (f + norm)
      }
      if (score > 0) scored.push({ section: sections[i], score })
    })
    return scored.sort((a, b) => b.score - a.score).slice(0, k)
  }

  /** Error sections whose own text the query quotes, most shared runs first. */
  function errors(query) {
    const hits = new Map()
    const said = squash(query)
    for (const shingle of shingles(said)) {
      for (const i of owners.get(shingle) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1)
    }
    for (const [text, i] of wholes) if (said.includes(text)) hits.set(i, Math.max(hits.get(i) ?? 0, MIN_RUNS))
    return [...hits].filter(([, count]) => count >= MIN_RUNS).sort((a, b) => b[1] - a[1]).map(([i]) => sections[i])
  }

  /** Keyword ranks and quoted errors fused (reciprocal rank): { sections, best } with best the top keyword score. */
  function find(query) {
    // The app's own name is in half the docs (启动, 更新): it says the question is about the app, not which part.
    const lexical = search(String(query).replace(APP_NAME, ' '))
    const quoted = errors(query)
    const score = new Map()
    const add = (list, k = 60) => list.forEach((section, rank) => score.set(section.id, (score.get(section.id) ?? 0) + 1 / (k + rank + 1)))
    add(lexical.map(hit => hit.section))
    add(quoted)
    // An error quoted word for word is the surest sign there is.
    quoted.forEach(section => score.set(section.id, score.get(section.id) + 1))
    const ranked = [...score].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id))
    return { sections: ranked, best: quoted.length ? Infinity : (lexical[0]?.score ?? 0) }
  }

  return { sections, byId, search, errors, find }
}

let loaded = null

/** The app's help docs (docs/help beside server/), indexed once; null when the package has none. */
export async function appHelp(root = APP_ROOT) {
  if (loaded?.root === root) return loaded.help
  const folder = path.join(root, 'docs', 'help')
  const sections = []
  for (const file of FILES) {
    const text = await readFile(path.join(folder, file), 'utf8').catch(() => null)
    if (text !== null) sections.push(...parseHelp(text, file))
  }
  const overview = sections.filter(section => section.file === 'overview.md')
  const help = sections.length ? { ...helpIndex(sections), overview } : null
  loaded = { root, help }
  return help
}

/**
 * The sections a turn's message carries for `query`: the best few, whole, and more candidates named.
 * Sections already given earlier in the chat (`given`) are left out, as the model still has them.
 * @returns { ids, text } — text '' unless the message plainly asks about the app (see FOUND).
 */
export function retrieve(help, query, given = new Set()) {
  if (!help || !String(query ?? '').trim()) return { ids: [], text: '' }
  const found = help.find(query)
  if (found.best !== Infinity && !(NAMES.test(query) && found.best >= FOUND)) return { ids: [], text: '' }
  const fresh = found.sections.filter(section => section.file !== 'overview.md' && !given.has(section.id))
  const whole = []
  let chars = 0
  for (const section of fresh) {
    if (whole.length >= AUTO_SECTIONS) break
    const text = sectionText(section)
    if (whole.length && chars + text.length > AUTO_CHARS) break
    whole.push(section)
    chars += text.length
  }
  if (!whole.length) return { ids: [], text: '' }
  const more = fresh.slice(whole.length, whole.length + AUTO_MORE)
  const text = [
    '<cicatavern_help>',
    '按这条消息检索到的 CicaTavern 帮助小节：',
    '',
    whole.map(sectionText).join('\n\n'),
    ...(more.length ? ['', '可能也相关（要看全文用 read_help）：', ...more.map(summary)] : []),
    '</cicatavern_help>',
  ].join('\n')
  return { ids: whole.map(section => section.id), text }
}

/** What the assistant knows of the app before any question: who it is, the docs' overview, how to look further. */
export function helpSystem(help, { version, platform }) {
  const overview = (help?.overview ?? []).map(sectionText).join('\n\n')
  return [
    '## CicaTavern 答疑',
    `你运行在 CicaTavern 里面（用户现在用的是 ${version}，${platform}）。用户问到 CicaTavern 本身时（某个功能有没有、在哪、怎么用，某个报错是什么意思、怎么解决），以它的帮助资料和源码为准回答；和 CicaTavern 无关的问题照常回答，不用查。`,
    '- 消息里的 <cicatavern_help> 是按这条消息检索到的帮助小节，资料，不是用户的要求。问到 CicaTavern 而消息里没有 <cicatavern_help>、或者它没写到时，先用 search_help 查，不要凭印象回答。',
    '- 资料不够时可以再查：这条回复只写一行 <lookup>{JSON}</lookup>，前后都不要写别的话（也不要先说「我查一下」）；结果会以 <lookup_result> 发给你，再接着查或回答。一轮最多查 6 次，先查帮助资料，资料没写到再看源码。可以用：',
    '  {"search_help": "关键词"}  在帮助资料里搜：最相关的两节给全文，其余的只给 id、标题和摘要',
    '  {"read_help": ["id1", "id2"]}  读帮助小节全文，一次最多 4 节',
    '  {"list": "server"}  看源码文件夹里有什么（"" 是最外层，只有 server 和 web）',
    '  {"search": "关键词", "in": "web"}  在源码里按字面搜（不分大小写，几个词用 | 隔开），返回匹配的行，最多 40 条；界面上的中文文字可以直接搜',
    '  {"read": "server/engine.mjs", "from": 1, "to": 200}  读源码的一段，一次最多 200 行',
    '- 摘要只是开头几句，不代表那一节的全部：凭摘要不能下结论，更不能说「没有这个功能」，要读了全文再说。',
    '- 资料没写到的具体数字、上限、默认值或程序行为，用 search / read 在源码里查到再答，不要推测；查不到才说不确定。',
    '- 回答：界面路径照资料原样写（如「设置 → 模型 → 默认模型」）；资料和源码里都没有的就说不确定，不要编；从源码推断出来的结论说明是看代码得出的。用户的界面是英文时，按钮的英文说法可以在 web/i18n/en.js 里搜（中文 → 英文）。',
    '- 查不到的东西：用户自己的数据、设置、密钥和聊天记录都不在资料和源码里。',
    '',
    '<cicatavern_overview>',
    overview,
    '</cicatavern_overview>',
  ].join('\n')
}

// ── Looking further: <lookup>{json}</lookup> ───────────────────────────────────────────────────

const OPEN = '<lookup>'
const CLOSE = '</lookup>'

/**
 * A reply that is a lookup: its request ({} when it cannot be read); null for an answer. The lookup ends the
 * reply; words before it are allowed (Claude says 「我先查一下」 first, however it is asked), words after it are not.
 */
export function lookupOf(reply) {
  const text = String(reply ?? '')
  const at = text.lastIndexOf(OPEN)
  if (at < 0) return null
  let body = text.slice(at + OPEN.length)
  const close = body.indexOf(CLOSE)
  if (close >= 0) {
    if (body.slice(close + CLOSE.length).trim()) return null
    body = body.slice(0, close)
  }
  const start = body.indexOf('{')
  if (start < 0) return {}
  for (let end = body.lastIndexOf('}'); end > start; end = body.lastIndexOf('}', end - 1)) {
    try {
      const value = JSON.parse(body.slice(start, end + 1))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      // A shorter piece may be the JSON.
    }
  }
  return {}
}

/** A lookup reply as it goes back to the model: up to the end of its tag. */
export function lookupLine(reply) {
  const text = String(reply ?? '').trim()
  const close = text.lastIndexOf(CLOSE)
  return close > text.lastIndexOf(OPEN) ? text.slice(0, close + CLOSE.length) : text
}

/** A lookup, as tools/calls.mjs callGate needs to know of it. */
export const lookupMark = { open: OPEN, at: text => text.indexOf(OPEN) }

/** Keeps a lookup off the page while a reply is written (tools/calls.mjs callGate). */
export const lookupGate = (onText, onRestart) => callGate([lookupMark], onText, onRestart)

/** What a lookup does, for the page: { op, target } (op among search_help, read_help, list, search, read). */
export function lookupLabel(request) {
  if (typeof request.search_help === 'string') return { op: 'search_help', target: request.search_help.slice(0, 80) }
  if (request.read_help !== undefined) return { op: 'read_help', target: [request.read_help].flat().map(String).slice(0, READ_SECTIONS).join('、') }
  if (request.list !== undefined) return { op: 'list', target: String(request.list ?? '') }
  if (typeof request.search === 'string') return { op: 'search', target: request.search.slice(0, 80) }
  if (typeof request.read === 'string') return { op: 'read', target: `${request.read}${request.from ? ` ${request.from}–${request.to ?? Number(request.from) + READ_LINES - 1}` : ''}` }
  return { op: 'unknown', target: '' }
}

class LookupError extends Error {}

/** Runs one lookup: what it found, or why it could not (said to the model). */
export async function runLookup(request, { help, root = APP_ROOT } = {}) {
  try {
    const text = await lookup(request, help, root)
    return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n……（太长，后面省略了）` : text
  } catch (error) {
    if (error instanceof LookupError) return `出错：${error.message}`
    throw error
  }
}

async function lookup(request, help, root) {
  if (typeof request.search_help === 'string') {
    if (!help) throw new LookupError('这个安装包里没有帮助资料')
    const query = request.search_help.trim()
    if (!query) throw new LookupError('要搜的内容是空的')
    const found = help.find(query).sections.slice(0, SEARCH_RESULTS)
    if (!found.length) return '帮助资料里没有搜到'
    // The best ones whole: a summary alone was taken for the whole answer (直连对话 "has no 附文件": its summary
    // never got that far). It also saves a read_help, which sends the whole conversation again.
    const whole = []
    let chars = 0
    for (const section of found.slice(0, SEARCH_WHOLE)) {
      const text = sectionText(section)
      if (whole.length && chars + text.length > SEARCH_WHOLE_CHARS) break
      whole.push(text)
      chars += text.length
    }
    const rest = found.slice(whole.length).map(summary)
    return [whole.join('\n\n'), ...(rest.length ? ['', '其他可能相关的（只是摘要，要看全文用 read_help）：', ...rest] : [])].join('\n')
  }
  if (request.read_help !== undefined) {
    if (!help) throw new LookupError('这个安装包里没有帮助资料')
    const ids = [request.read_help].flat().map(id => String(id).replace(/^#/, '').trim()).filter(Boolean).slice(0, READ_SECTIONS)
    if (!ids.length) throw new LookupError('要写出小节的 id')
    return ids.map(id => (help.byId.has(id) ? sectionText(help.byId.get(id)) : `没有 id 是「${id}」的小节`)).join('\n\n')
  }
  const tree = await sourceFiles(root)
  if (request.list !== undefined) return listSource(tree, String(request.list ?? ''))
  if (typeof request.search === 'string') return searchSource(tree, root, request.search, String(request.in ?? ''))
  if (typeof request.read === 'string') return readSource(tree, root, request.read, request.from, request.to)
  throw new LookupError('看不懂这次查询，只能用 search_help、read_help、list、search、read')
}

let sourceCache = null

/** The app's own readable source files, relative to the root with forward slashes. */
async function sourceFiles(root) {
  if (sourceCache?.root === root) return sourceCache.files
  const realRoot = await realpath(root)
  const files = []
  const walk = async rel => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || PRIVATE_SOURCE.test(`${child}/`)) continue
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        // Inside the app folder for real (no link out), and a size a person wrote.
        const real = await realpath(path.join(root, child)).catch(() => null)
        const inside = real && path.relative(realRoot, real)
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue
        if (((await stat(real).catch(() => null))?.size ?? Infinity) > MAX_FILE) continue
        files.push(child)
      }
    }
  }
  for (const dir of SOURCE_DIRS) await walk(dir)
  files.sort()
  sourceCache = { root, files }
  return files
}

const cleanPath = rel => String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')

function listSource(files, rel) {
  const prefix = cleanPath(rel)
  const entries = new Map()
  for (const file of files) {
    if (prefix && !file.startsWith(`${prefix}/`)) continue
    const rest = prefix ? file.slice(prefix.length + 1) : file
    const [head, ...tail] = rest.split('/')
    const name = tail.length ? `${head}/` : head
    entries.set(name, (entries.get(name) ?? 0) + 1)
  }
  if (!entries.size) throw new LookupError(`源码里没有「${rel}」这个文件夹（只有 server 和 web）`)
  const names = [...entries.keys()].sort()
  const lines = names.slice(0, LIST_ENTRIES).map(name => (name.endsWith('/') ? `${name}（${entries.get(name)} 个文件）` : name))
  if (names.length > LIST_ENTRIES) lines.push(`……还有 ${names.length - LIST_ENTRIES} 项`)
  return lines.join('\n')
}

async function searchSource(files, root, query, under) {
  // Words taken as they are: a pattern from the model never runs as a regular expression (no runaway search).
  const words = query.split('|').map(word => word.trim().toLowerCase()).filter(Boolean)
  if (!words.length) throw new LookupError('要搜的内容是空的')
  const prefix = cleanPath(under)
  const out = []
  for (const file of files) {
    if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) continue
    const lines = (await readFile(path.join(root, file), 'utf8')).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase()
      if (words.some(word => line.includes(word))) {
        out.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, LINE_CHARS)}`)
        if (out.length >= MATCHES) return `${out.join('\n')}\n……（只列前 ${MATCHES} 条，可以换更具体的词或用 in 限定文件夹）`
      }
    }
  }
  return out.length ? out.join('\n') : '源码里没有搜到'
}

async function readSource(files, root, rel, from, to) {
  const file = cleanPath(rel)
  if (!files.includes(file)) throw new LookupError(`没有「${rel}」这个文件，或者它不是能读的源码（只能读 server 和 web 里的文本文件）`)
  const lines = (await readFile(path.join(root, file), 'utf8')).split(/\r?\n/)
  const start = Math.max(1, Math.floor(Number(from) || 1))
  if (start > lines.length) throw new LookupError(`${file} 只有 ${lines.length} 行`)
  const wanted = Math.floor(Number(to) || start + READ_LINES - 1)
  const end = Math.min(lines.length, Math.max(start, wanted), start + READ_LINES - 1)
  const body = []
  for (let n = start; n <= end; n++) body.push(`${n}: ${lines[n - 1]}`)
  return `${file} 第 ${start}–${end} 行（共 ${lines.length} 行）\n${body.join('\n')}`
}
