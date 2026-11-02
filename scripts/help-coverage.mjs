// Checks the user help in docs/help/ (.claude/skills/help-docs/SKILL.md has the
// format): every section has a well-formed, unique id and the fields its file
// needs; every error-like message the server or the page can show is quoted in
// an 原文 line or listed in docs/help/coverage-ignore.txt; every settings row is
// named in some 在哪 line. --write-list rebuilds the 功能清单 at the top of
// features.md from its sections.
//
//   node scripts/help-coverage.mjs               list the problems (exit 1 if any)
//   node scripts/help-coverage.mjs --write-list  rebuild the 功能清单 first
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELP = path.join(ROOT, 'docs', 'help')
const FILES = ['overview.md', 'features.md', 'errors.md', 'faq.md', 'versions.md']
const FIELDS = ['也叫', '在哪', '平台', '版本', '原文', '英文', '出现在', '原因', '解决']
// Fields a section must have, per file.
const REQUIRED = { 'features.md': ['在哪'], 'errors.md': ['原文', '原因', '解决'] }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEADING = /^## (.+?) \{#([^}]*)\}\s*$/
const LIST_START = '<!-- 功能清单 -->'
const LIST_END = '<!-- /功能清单 -->'
// Messages that read like something went wrong: these need an 原文 or an ignore line.
const ERROR_LIKE = /失败|错误|无法|不能|超时|连不上|找不到|不支持|拒绝|过期|太大|太长|不对|出错|没能|不可用|缺少|无效|报错|被占用|异常|中断|限制/
const BODY_LIMIT = 900

/**
 * The sections of one help file: title, id, fields (name → values), body, line, and area (the
 * level-1 heading above it; features.md groups its sections by area).
 */
export function parseSections(text, file) {
  const sections = []
  let current = null
  let inFields = false
  let area = ''
  text.split('\n').forEach((line, index) => {
    const heading = line.match(HEADING)
    if (heading) {
      current = { file, area, title: heading[1].trim(), id: heading[2], fields: {}, body: [], line: index + 1 }
      sections.push(current)
      inFields = true
      return
    }
    if (/^#{1,2} /.test(line)) {
      if (line.startsWith('# ')) area = line.slice(2).trim()
      current = null
      return
    }
    if (!current) return
    // The field list comes right after the heading; the first other line (or a blank line after a
    // field) starts the body.
    if (inFields) {
      const field = line.match(/^- ([^：:]{1,6})[：:]\s*(.*)$/)
      if (field && FIELDS.includes(field[1])) {
        ;(current.fields[field[1]] ??= []).push(field[2].trim())
        return
      }
      if (!line.trim() && !Object.keys(current.fields).length) return
      inFields = false
    }
    current.body.push(line)
  })
  for (const section of sections) section.body = section.body.join('\n').trim()
  return sections
}

/** A heading the parser would skip: ## without {#id}. */
function looseHeadings(text, file) {
  return text.split('\n').flatMap((line, index) =>
    /^## /.test(line) && !HEADING.test(line) ? [`${file}:${index + 1} 二级标题没有 {#id}：${line}`] : [])
}

const firstSentence = body => {
  const plain = body.replace(/^正文：/, '').replace(/[*`]/g, '').split('\n').find(line => line.trim()) ?? ''
  const end = plain.search(/[。！？]/)
  const sentence = end >= 0 ? plain.slice(0, end) : plain
  return sentence.length > 50 ? `${sentence.slice(0, 49)}…` : sentence
}

/** The 功能清单: one line per feature section, under a bold line per area. */
export function featureList(sections) {
  const lines = []
  let area = null
  for (const s of sections) {
    if (s.area !== area) {
      if (s.area) lines.push(`${lines.length ? '\n' : ''}**${s.area}**\n`)
      area = s.area
    }
    const where = s.fields['在哪']?.[0]
    const what = firstSentence(s.body)
    lines.push(`- [${s.title}](#${s.id})${what ? `：${what}` : ''}${where ? `（在哪：${where}）` : ''}`)
  }
  return lines.join('\n')
}

function writeList(text, sections) {
  const start = text.indexOf(LIST_START)
  const end = text.indexOf(LIST_END)
  if (start < 0 || end < start) throw new Error(`features.md 里没有 ${LIST_START} … ${LIST_END}`)
  return `${text.slice(0, start + LIST_START.length)}\n${featureList(sections)}\n${text.slice(end)}`
}

/** The settings rows (web/app.js sections) by title. */
function settingsRows() {
  const src = readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8')
  const start = src.indexOf('const sections = [')
  const end = src.indexOf('settingsMenu.mount(', start)
  if (start < 0 || end < 0) return []
  return [...src.slice(start, end).matchAll(/id: '([\w-]+)', title: t`([^`$]+)`/g)].map(m => ({ id: m[1], title: m[2] }))
}

function ignored() {
  const file = path.join(HELP, 'coverage-ignore.txt')
  if (!existsSync(file)) return new Set()
  return new Set(readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')))
}

async function messages() {
  const load = async rel => (await import(pathToFileURL(path.join(ROOT, rel)))).default
  // A message over several lines is matched (and listed) by its first line: 原文 lines and the
  // ignore file hold one line each.
  const first = key => key.split('\n')[0].trim()
  const server = Object.keys(await load('server/i18n/en.mjs')).map(key => ({ key: first(key), from: 'server' }))
  const web = Object.keys(await load('web/i18n/en.js')).map(key => ({ key: first(key), from: 'web' }))
  return [...server, ...web].filter(m => ERROR_LIKE.test(m.key))
}

export async function check({ write = false } = {}) {
  const problems = []
  const warnings = []
  const all = []
  for (const file of FILES) {
    const full = path.join(HELP, file)
    if (!existsSync(full)) {
      problems.push(`缺少 docs/help/${file}`)
      continue
    }
    let text = readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
    let sections = parseSections(text, file)
    if (file === 'features.md') {
      const features = sections.filter(s => s.id !== 'feature-list')
      if (write) {
        text = writeList(text, features)
        writeFileSync(full, text)
        sections = parseSections(text, file)
      } else if (text.includes(LIST_START) && !text.includes(featureList(features))) {
        problems.push('features.md 的功能清单和小节对不上：运行 node scripts/help-coverage.mjs --write-list')
      }
    }
    problems.push(...looseHeadings(text, file))
    for (const s of sections) {
      const where = `${file}:${s.line}「${s.title}」`
      if (!ID.test(s.id)) problems.push(`${where} 的 id「${s.id}」只能用小写字母、数字和 -`)
      const required = s.id === 'feature-list' ? [] : (REQUIRED[file] ?? [])
      for (const name of required) if (!s.fields[name]?.length) problems.push(`${where} 缺少「${name}」`)
      if (s.body.length > BODY_LIMIT && s.id !== 'feature-list') warnings.push(`${where} 正文 ${s.body.length} 字，超过 ${BODY_LIMIT}：考虑拆开`)
    }
    all.push(...sections)
  }
  const seen = new Map()
  for (const s of all) {
    if (seen.has(s.id)) problems.push(`id「${s.id}」重复：${seen.get(s.id)} 和 ${s.file}:${s.line}`)
    else seen.set(s.id, `${s.file}:${s.line}`)
  }

  // Links between help files ([…](features.md#id), [](#id)) must land on a section.
  for (const file of FILES) {
    const full = path.join(HELP, file)
    if (!existsSync(full)) continue
    for (const m of readFileSync(full, 'utf8').matchAll(/\]\(((?:[\w-]+\.md)?)#([^)\s]+)\)/g)) {
      const target = m[1] || file
      if (!all.some(s => s.file === target && s.id === m[2])) problems.push(`${file} 的链接 ${m[1]}#${m[2]} 指向的小节不存在`)
    }
  }

  const quoted = new Set(all.flatMap(s => s.fields['原文'] ?? []))
  const skip = ignored()
  const missing = (await messages()).filter(m => !quoted.has(m.key) && !skip.has(m.key))
  for (const m of missing) problems.push(`报错没写进 errors.md（也不在 coverage-ignore.txt）：[${m.from}] ${m.key}`)
  const stale = [...skip].filter(key => !ERROR_LIKE.test(key))
  for (const key of stale) warnings.push(`coverage-ignore.txt 里这条不算报错，可以删掉：${key}`)

  const paths = all.flatMap(s => s.fields['在哪'] ?? []).join('\n')
  for (const row of settingsRows()) if (!paths.includes(row.title)) problems.push(`设置项「${row.title}」（${row.id}）没有出现在任何「在哪」里`)

  return { problems, warnings, sections: all.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, warnings, sections } = await check({ write: process.argv.includes('--write-list') })
  for (const w of warnings) console.log(`提醒：${w}`)
  for (const p of problems) console.log(p)
  console.log(problems.length ? `\n${problems.length} 个问题（${sections} 节）` : `帮助资料没问题（${sections} 节）`)
  process.exitCode = problems.length ? 1 : 0
}
