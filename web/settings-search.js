// 设置里的搜索: what the settings hold, found by a word. The window (web/app.js) says what there is; this reads the words off
// its pages, ranks what matches, and marks the place once the player is taken there.

const MAX_FOUND = 40
const HIT_MS = 2800
const SNIPPET_BEFORE = 10
const SNIPPET_AFTER = 26
const WAIT_TRIES = 20
const WAIT_MS = 100
// What a word can sit in, in a window opened from the search.
const PLACES = '.basic-label, label, h3, .cp-title, .menu-entry-title'
const WHOLE = '.basic-field, label, .cp-row, .menu-entry'

const spaced = text => text.replace(/\s+/g, ' ').trim()

/** What a control is called: its first words, not what its options or hint go on to say. */
function ownWords(node) {
  for (const child of node.childNodes) {
    const words = spaced(child.textContent ?? '')
    if (words && (child.nodeType === 3 || child.tagName === 'SPAN' || child.tagName === 'B')) return words
  }
  return spaced(node.textContent ?? '')
}

/**
 * A page's controls and headings, each with all its words (a hint and the options count). `page` may be hidden.
 * A hint on its own has no name to go by: `hint` says so, and the page's is used.
 */
export function pageItems(page) {
  const items = []
  for (const node of page.querySelectorAll('label, h3, h4, legend, summary, .hint')) {
    if (node.matches('.hint') && node.closest('label')) continue
    const text = spaced(node.textContent ?? '')
    if (text) items.push({ title: ownWords(node).slice(0, 40), text, node, hint: node.matches('.hint') })
  }
  return items
}

const wordsOf = query => query.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * What matches every word of the query, its name first.
 * @param items - [{ title, group (the category it comes under), place (where in it, if deeper), text, go }]
 */
export function findSettings(items, query) {
  const words = wordsOf(query)
  if (!words.length) return []
  const seen = new Set()
  const found = []
  for (const item of items) {
    const title = item.title.toLowerCase()
    const all = `${title} ${item.group.toLowerCase()} ${item.place.toLowerCase()} ${item.text.toLowerCase()}`
    const key = `${item.group}|${item.place}|${item.title}`
    if (seen.has(key) || !words.every(word => all.includes(word))) continue
    seen.add(key)
    const named = words.every(word => title.includes(word))
    found.push({ ...item, rank: named ? (title.startsWith(words[0]) ? 0 : 1) : 2 })
  }
  return found.sort((a, b) => a.rank - b.rank).slice(0, MAX_FOUND)
}

/** What was found by category, the category of the best one first and the order kept within each. → [[group, items]] */
export function byGroup(found) {
  const groups = new Map()
  for (const item of found) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
  return [...groups]
}

/** A text in parts, those the query matches marked: [{ text, hit }]. */
export function markedParts(text, query) {
  const lower = text.toLowerCase()
  const hit = new Array(text.length).fill(false)
  for (const word of wordsOf(query)) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) hit.fill(true, at, at + word.length)
  }
  const parts = []
  for (let i = 0; i < text.length; i++) {
    if (parts.at(-1)?.hit === hit[i]) parts.at(-1).text += text[i]
    else parts.push({ text: text[i], hit: hit[i] })
  }
  return parts
}

/** The words around a match, for one found by more than its name. '' when its name says it. */
export function snippetOf(item, query) {
  const word = query.toLowerCase().split(/\s+/).find(part => part && !item.title.toLowerCase().includes(part))
  const at = word ? item.text.toLowerCase().indexOf(word) : -1
  if (at < 0) return ''
  const start = Math.max(0, at - SNIPPET_BEFORE)
  return `${start ? '…' : ''}${item.text.slice(start, at + word.length + SNIPPET_AFTER)}${at + word.length + SNIPPET_AFTER < item.text.length ? '…' : ''}`
}

/** The place the player was brought to: in view, and lit for a moment. */
export function markPlace(node) {
  node.scrollIntoView({ block: 'center' })
  node.classList.remove('menu-hit')
  void node.offsetWidth
  node.classList.add('menu-hit')
  setTimeout(() => node.classList.remove('menu-hit'), HIT_MS)
}

/** The same in a window just opened over the settings, by the words it shows: it may take a moment to draw. */
export function markWords(words, tries = WAIT_TRIES) {
  const windows = [...document.querySelectorAll('dialog[open]')].filter(item => item.id !== 'settings-dialog')
  const found = windows.flatMap(item => [...item.querySelectorAll(PLACES)]).find(node => node.offsetParent && spaced(node.textContent ?? '').startsWith(words))
  if (found) return markPlace(found.closest(WHOLE) ?? found)
  if (tries) setTimeout(() => markWords(words, tries - 1), WAIT_MS)
}
