// 导入 Twine / Ink 的结构 (plans/22 十三·2): a story written in Twine (Twee 3, or the HTML Twine 2 publishes) or Ink
// taken as a plot: each passage or knot a scene, its links the ways on, one with none an ending. Only the shape and the
// words: no code of theirs is run. Shared by the page (剧本 → 导入…) and the tests. No \p{} here (old WebViews).
import { cleanPlot, MAX_EXITS, MAX_SCENES } from './plot.js'

const WHAT = 400

/** Story text as plain words: markup, code and macros out, spaces folded. */
function plainOf(text) {
  return String(text ?? '')
    .replace(/<<[\s\S]*?>>/g, ' ') // SugarCube / Harlowe-ish macros
    .replace(/\(\w+:[^)]*\)\[?/g, ' ') // Harlowe hooks
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ') // Ink conditionals and variables
    .replace(/^\s*(?:~|VAR|CONST|INCLUDE|#).*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * A plot from passages: [{ name, text, links: [{ to, label }] }], the first (or `start`) where it begins. Passages
 * the start never reaches are left out; the rest cut to the plot's limits.
 */
export function plotFromPassages(passages, { name = '', start = '' } = {}) {
  const byName = new Map()
  for (const passage of passages) if (passage.name && !byName.has(passage.name)) byName.set(passage.name, passage)
  const first = byName.has(start) ? start : passages[0]?.name
  if (!first) return null
  // From the start, in the order the links are written: what can be reached, the first MAX_SCENES of it.
  const order = []
  const seen = new Set([first])
  const queue = [first]
  while (queue.length && order.length < MAX_SCENES) {
    const passage = byName.get(queue.shift())
    order.push(passage)
    for (const link of passage.links) {
      if (byName.has(link.to) && !seen.has(link.to)) {
        seen.add(link.to)
        queue.push(link.to)
      }
    }
  }
  const ids = new Map(order.map((passage, index) => [passage.name, `s${index + 1}`]))
  const scenes = order.map(passage => {
    const links = []
    for (const link of passage.links) if (ids.has(link.to) && !links.some(item => item.to === link.to)) links.push(link)
    const exits = links.slice(0, MAX_EXITS).map(link => ({ to: ids.get(link.to), when: link.label && link.label !== link.to ? clip(link.label, 120) : '', hint: link.label && link.label !== link.to ? clip(link.label, 40) : '' }))
    return {
      id: ids.get(passage.name),
      title: clip(passage.name, 40),
      what: clip(plainOf(passage.text), WHAT),
      minTurns: 1,
      exits,
      ending: exits.length ? null : { kind: 'normal', text: '' },
    }
  })
  return cleanPlot({ name: clip(String(name || order[0].name), 40), scenes, start: 's1', source: 'imported' })
}

/** [[文字->目标]], [[目标<-文字]], [[文字|目标]], [[目标]] in a Twine passage. */
function twineLinks(text) {
  const links = []
  for (const match of String(text).matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    const inner = match[1].replace(/\]\[.*$/, '').trim()
    let to = inner
    let label = ''
    if (inner.includes('->')) [label, to] = [inner.slice(0, inner.lastIndexOf('->')), inner.slice(inner.lastIndexOf('->') + 2)]
    else if (inner.includes('<-')) [to, label] = [inner.slice(0, inner.indexOf('<-')), inner.slice(inner.indexOf('<-') + 2)]
    else if (inner.includes('|')) [label, to] = [inner.slice(0, inner.lastIndexOf('|')), inner.slice(inner.lastIndexOf('|') + 1)]
    to = to.trim()
    if (to) links.push({ to, label: label.trim() })
  }
  return links
}

const SPECIAL = new Set(['StoryTitle', 'StoryData', 'StoryInit', 'StoryCaption', 'StoryMenu', 'StoryBanner', 'StoryAuthor', 'StorySubtitle', 'PassageReady', 'PassageDone', 'PassageHeader', 'PassageFooter'])

/** Twee 3: `:: Name [tags] {metadata}` then the passage. */
export function fromTwee(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const passages = []
  let title = ''
  let start = ''
  for (const part of source.split(/^::/m).slice(1)) {
    const line = part.slice(0, part.indexOf('\n') < 0 ? part.length : part.indexOf('\n'))
    const body = part.slice(line.length + 1)
    const name = line.replace(/\{[^}]*\}\s*$/, '').replace(/\[[^\]]*\]\s*$/, '').trim()
    const tags = (line.match(/\[([^\]]*)\]/)?.[1] ?? '').split(/\s+/)
    if (name === 'StoryTitle') title = body.trim()
    if (name === 'StoryData') {
      try {
        start = JSON.parse(body).start ?? ''
      } catch {
        // no start of its own: the first passage
      }
    }
    if (SPECIAL.has(name) || tags.some(tag => ['script', 'stylesheet', 'widget'].includes(tag))) continue
    passages.push({ name, text: body, links: twineLinks(body) })
  }
  return passages.length ? plotFromPassages(passages, { name: title, start }) : null
}

const unescape = text => String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')

/** The HTML Twine 2 publishes (or its archive): <tw-storydata startnode> and its <tw-passagedata>. */
export function fromTwineHtml(text) {
  const source = String(text ?? '')
  const story = source.match(/<tw-storydata\b([^>]*)>/i)?.[1] ?? ''
  const attr = (attrs, key) => unescape(attrs.match(new RegExp(`\\b${key}="([^"]*)"`, 'i'))?.[1] ?? '')
  const passages = []
  let start = ''
  const startPid = attr(story, 'startnode')
  for (const match of source.matchAll(/<tw-passagedata\b([^>]*)>([\s\S]*?)<\/tw-passagedata>/gi)) {
    const name = attr(match[1], 'name')
    const tags = attr(match[1], 'tags').split(/\s+/)
    if (!name || SPECIAL.has(name) || tags.some(tag => ['script', 'stylesheet', 'widget'].includes(tag))) continue
    if (attr(match[1], 'pid') === startPid) start = name
    const body = unescape(match[2])
    passages.push({ name, text: body, links: twineLinks(body) })
  }
  return passages.length ? plotFromPassages(passages, { name: attr(story, 'name'), start }) : null
}

/**
 * Ink: `=== knot ===` and `= stitch` are scenes (a stitch by `knot.stitch`), `* [选项] -> 目标`, `+ 选项 -> 目标` and a
 * lone `-> 目标` the ways on; `-> END` / `-> DONE` (or nothing) ends the story there. Text before the first knot is
 * the start.
 */
export function fromInk(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const passages = []
  let current = { name: '', knot: '', text: '', links: [] }
  const close = () => {
    if (current.name || current.text.trim() || current.links.length) passages.push(current)
  }
  for (const line of source.split('\n')) {
    const knot = line.match(/^\s*={2,}\s*(?:function\s+)?([^\s=(]+)[^=]*={0,}\s*$/)
    const stitch = !knot && line.match(/^\s*=\s*([^\s=(]+)\s*$/)
    if (knot) {
      close()
      current = { name: knot[1], knot: knot[1], text: '', links: [] }
      continue
    }
    if (stitch) {
      close()
      current = { name: `${current.knot}.${stitch[1]}`, knot: current.knot, text: '', links: [] }
      continue
    }
    const divert = line.match(/->\s*([^\s\-<>(){}\[\]]+)/)
    const choice = line.match(/^\s*[*+]+\s*(?:\([\w]+\)\s*)?(?:\{[^}]*\}\s*)?(.*?)\s*(?:->.*)?$/)
    if (divert && !['END', 'DONE'].includes(divert[1])) {
      const label = choice ? choice[1].replace(/\[([^\]]*)\]/, '$1').replace(/\[.*$/, '').trim() : ''
      current.links.push({ to: divert[1], label })
    } else if (!/^\s*[*+-]/.test(line)) current.text += `${line}\n`
  }
  close()
  if (!passages.length) return null
  if (!passages[0].name) passages[0].name = passages[1] ? '开始' : 'start' // i18n-ignore: the scene's title, as the model reads it
  // A divert by a stitch's own name means the one in the same knot; one to a knot, its first part.
  const names = new Set(passages.map(passage => passage.name))
  for (const passage of passages) {
    passage.links = passage.links.map(link => {
      let to = link.to
      if (!names.has(to) && passage.knot && names.has(`${passage.knot}.${to}`)) to = `${passage.knot}.${to}`
      if (!names.has(to)) to = passages.find(item => item.knot === to)?.name ?? to
      return { ...link, to }
    })
  }
  return plotFromPassages(passages)
}

/** A file picked under 导入…: a plot of ours (.json), Twee, Twine's HTML or Ink, by its name and what is in it. */
export function plotFromFile(name, text) {
  const lower = String(name ?? '').toLowerCase()
  if (/\.(twee|tw)$/.test(lower) || /^::\s*\S/m.test(text) && !lower.endsWith('.ink')) return fromTwee(text)
  if (/\.html?$/.test(lower) || /<tw-storydata/i.test(text)) return fromTwineHtml(text)
  if (lower.endsWith('.ink') || /^\s*={2,}\s*\w+/m.test(text)) return fromInk(text)
  return null
}
