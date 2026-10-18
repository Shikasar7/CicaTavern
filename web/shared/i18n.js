// The interface's languages (设置 → 界面语言), shared by the page and the server.
// Chinese is the source: text is written in Chinese behind a tag (t`…` on the
// page, msg`…` on the server) and English is looked up by that text, each ${…}
// part as {0}, {1}… An entry is a string, or a function of the parts (plurals).
// Text with no entry stays Chinese.

export const LANGUAGES = ['zh', 'en']

/** The lookup key of a tagged template: its text with each ${…} as {0}, {1}… */
export const keyOf = strings => strings.reduce((key, part, i) => key + (i ? `{${i - 1}}` : '') + part, '')

/** The template's own text with its parts put back: the Chinese as written. */
export const joined = (strings, args) => strings.reduce((text, part, i) => text + (i ? String(args[i - 1]) : '') + part, '')

/** An English entry with its {n} filled in. */
export function fill(entry, args) {
  if (typeof entry === 'function') return String(entry(...args))
  return args.length ? entry.replace(/\{(\d+)\}/g, (all, i) => (i < args.length ? String(args[i]) : all)) : entry
}

/** A tag for one language: dict = null is the Chinese as written. */
export function createTag(dict) {
  const entries = new WeakMap() // template strings arrays are one object per call site
  return function t(strings, ...args) {
    // t(text) for text that is not a literal here (a table of labels, a message from elsewhere).
    if (typeof strings === 'string') return dict && Object.hasOwn(dict, strings) ? fill(dict[strings], []) : strings
    if (!dict) return joined(strings, args)
    let entry = entries.get(strings)
    if (entry === undefined) {
      const key = keyOf(strings)
      entry = Object.hasOwn(dict, key) ? dict[key] : null
      entries.set(strings, entry)
    }
    return entry === null ? joined(strings, args) : fill(entry, args)
  }
}

/**
 * The language to show for a setting ('zh', 'en', anything else = follow the
 * browser) and the browser's preferred languages, best first: whichever of
 * Chinese and English comes first; a list with neither is English, no list Chinese.
 */
export function pickLanguage(setting, preferred = []) {
  if (LANGUAGES.includes(setting)) return setting
  const tags = preferred.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag && tag !== '*')
  if (!tags.length) return 'zh'
  const first = tags.find(tag => /^(zh|en)\b/.test(tag))
  return first?.startsWith('zh') ? 'zh' : 'en'
}

/** An Accept-Language header as a list, best first. */
export function acceptedLanguages(header = '') {
  return String(header)
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';')
      const q = Number(/q=([\d.]+)/.exec(params.join(';'))?.[1] ?? 1)
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, i }
    })
    .filter(item => item.tag && item.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map(item => item.tag)
}

// ─── Static HTML (index.html) ───────────────────────────────────────────

// Han characters, CJK punctuation (、。「」) and full-width forms (（）：！).
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/
/** Whether text is (partly) Chinese: what an English page must not show. */
export const hasCjk = text => CJK.test(text)

// Attributes a person reads.
const SHOWN_ATTRS = /(\s(?:title|placeholder|aria-label|alt|label)=")([^"]*)(")/g
const MARKUP = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<[^>]*>/gi

const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = text => escapeText(text).replace(/"/g, '&quot;')

/**
 * Every piece of shown text in an HTML page: text between tags (trimmed) and
 * the attributes above. Comments, scripts and styles are not shown.
 * @returns {{ text, kind: 'text'|'attr', start, end, line }[]} start/end of the trimmed text
 */
export function htmlTexts(html) {
  const out = []
  const lineAt = index => html.slice(0, index).split('\n').length
  const addText = (from, to) => {
    const raw = html.slice(from, to)
    const text = raw.trim()
    if (!text) return
    const start = from + raw.indexOf(text)
    out.push({ text, kind: 'text', start, end: start + text.length, line: lineAt(start) })
  }
  let last = 0
  for (const match of html.matchAll(MARKUP)) {
    addText(last, match.index)
    last = match.index + match[0].length
    if (match[0].startsWith('<!--') || /^<(script|style)\b/i.test(match[0])) continue
    for (const attr of match[0].matchAll(SHOWN_ATTRS)) {
      const start = match.index + attr.index + attr[1].length
      if (attr[2].trim()) out.push({ text: attr[2], kind: 'attr', start, end: start + attr[2].length, line: lineAt(start) })
    }
  }
  addText(last, html.length)
  return out
}

/** The page in another language: each shown text with an entry replaced, and <html lang> set. */
export function translateHtml(html, dict, lang) {
  let out = ''
  let last = 0
  if (dict) {
    for (const piece of htmlTexts(html)) {
      if (!hasCjk(piece.text) || !Object.hasOwn(dict, piece.text)) continue
      const english = fill(dict[piece.text], [])
      out += html.slice(last, piece.start) + (piece.kind === 'attr' ? escapeAttr(english) : escapeText(english))
      last = piece.end
    }
  }
  out += html.slice(last)
  return out.replace(/<html\b[^>]*>/i, `<html lang="${lang === 'en' ? 'en' : 'zh-CN'}" data-ui-lang="${lang}">`)
}
