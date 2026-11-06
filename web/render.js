// Message display: the card's display regex, variable macros, and HTML
// (status bars, beautified update blocks) in sandboxed iframes. The frames get
// `allow-scripts` but never `allow-same-origin`, so card code runs in an
// opaque origin: it cannot read this page, its storage, or call the local API.
import { applyScripts, PLACEMENT } from './shared/regex.js'
import { replaceVariableMacros, UPDATE_BLOCK } from './shared/vars.js'
import { CHOICES_BLOCK, SELF_CHECK_BLOCK, TIME_BOX_BLOCK } from './shared/basic.js'
import { frameShim, libraryTags, replaceViewportHeight } from './compat.js'

const PLACEHOLDER = /<StatusPlaceHolderImpl\s*\/>/i
const HIDDEN = [
  // Closed with another update block's tag, or left open at the end, still hidden.
  UPDATE_BLOCK,
  /<StatusPlaceHolderImpl\s*\/>/gi,
  // The built-in preset's time box and choices: the page draws them (status.js), not as text.
  TIME_BOX_BLOCK,
  CHOICES_BLOCK,
  SELF_CHECK_BLOCK,
]
// Reasoning tags (<thinking>, <思考>…) are not among them: app.js folds those (思考中… while one is still open).
const OPEN_HIDDEN = /<(state|update(?:variable)?|time_box|choices)>(?![\s\S]*<\/\1>)[\s\S]*$/i
const FENCE = /```([\w-]*)[^\n]*\n?([\s\S]*?)```/g
// A chunk with any of these is shown in a frame of its own, styles kept (regex.js's trial shows it the same way).
export const HTML_LIKE = /<(!doctype|html|head|body|style|script|div|table|section|details|svg|canvas|link|iframe|form|button)\b/i

export function nameMacros(text, names) {
  return String(text ?? '')
    .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
    .replace(/\{\{char\}\}|<BOT>/gi, names.char)
    .replace(/\{\{user\}\}|<USER>/gi, names.user)
}

function stripHidden(text) {
  let out = text
  for (const re of HIDDEN) out = out.replace(re, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// 屏蔽词 (设置 → 屏蔽词) that change what is shown, with their matcher (web/shared/blockwords.js
// blockText), handed over by app.js: it loads that file on its own, so a server started before
// the file existed still serves the page.
let shownWords = { words: [], block: null }

export function useBlockWords(words, block) {
  shownWords = { words, block }
}

// 游戏规则's marks, in a chat that has them: { strip, cut } (web/game-play.js). Handed over by app.js as the 屏蔽词
// are: only a card with rules loads those files.
let shownMarks = null

export function useGameMarks(marks) {
  shownMarks = marks
}

/** Text as shown: the 屏蔽词 applied. `partial` for text still streaming. */
export function blockShown(text, partial = false) {
  const { words, block } = shownWords
  return block && words.length ? block(text, words, { target: 'display', partial }) : String(text ?? '')
}

/** Text streamed so far, with finished bookkeeping blocks removed and an unfinished one hidden. */
export function streamingText(text) {
  const written = stripHidden(String(text ?? '')).replace(OPEN_HIDDEN, '').trimEnd()
  // What comes after a stop will not be kept: it does not show on the way either.
  return blockShown(shownMarks ? shownMarks.strip(shownMarks.cut(written)) : written, true)
}

export function usesStatusPlaceholder(scripts) {
  return scripts.some(s => !s.disabled && /StatusPlaceHolderImpl/.test(s.findRegex))
}

// The SillyTavern copy of a card creator status bar (server/forge/status.mjs). This page
// draws that bar itself, from the layout the card carries.
export const OWN_STATUS_SCRIPT = 'cicatavern-status-bar'

export function withoutOwnStatus(scripts) {
  return scripts.filter(s => !s.id.startsWith(OWN_STATUS_SCRIPT))
}

/**
 * Display text of one message after the 屏蔽词 and the card's display regex.
 * @param node - { role, raw, text, state }.
 * @param depth - 0 for the latest message.
 * @param withStatus - append the MVU status placeholder (the latest reply only).
 * @param variables - { local, global }: the chat's and the app's variables, for {{getvar::…}} and the like.
 */
export function displayOf(node, { scripts, names, depth, withStatus, variables = {} }) {
  // Before the regex: the words come out of what was written, not out of the HTML a card's regex builds.
  let text = blockShown(node.raw ?? node.text ?? '')
  if (node.role === 'user' && !scripts.length) return text
  if (shownMarks && node.role !== 'user') text = shownMarks.strip(text)
  // The status bar always goes after the story: models often write the placeholder first,
  // or before their variable-update block.
  if (withStatus || PLACEHOLDER.test(text)) text = `${text.replace(/<StatusPlaceHolderImpl\s*\/>/gi, '').trimEnd()}\n\n<StatusPlaceHolderImpl/>`
  const macros = text => nameMacros(replaceVariableMacros(text, node.state, variables), names)
  if (scripts.length) {
    const placement = node.role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT
    text = applyScripts(text, scripts, { placement, target: 'display', depth, macros })
  }
  return stripHidden(macros(text))
}

const BLOCK_TAG = /<(\/?)(html|head|body|style|script|div|table|section|details|svg|canvas|form|iframe)\b[^>]*?(\/?)>/gi

/** Net count of open block-level tags in a chunk (opening +1, closing -1). */
function openBlocks(chunk) {
  let depth = 0
  for (const [, closing, , selfClosing] of chunk.matchAll(BLOCK_TAG)) {
    if (selfClosing) continue
    depth += closing ? -1 : 1
  }
  return depth
}

/**
 * Split non-fenced text into prose and HTML by paragraph. A paragraph that
 * opens a block tag keeps absorbing the following paragraphs until the tags
 * balance, so a <details> spanning blank lines stays one frame; prose around
 * it stays prose.
 */
function splitProse(text, out) {
  const paragraphs = text.split(/\n{2,}/)
  let story = []
  let html = null
  let depth = 0
  const flushStory = () => {
    if (story.length) out.push({ kind: 'story', body: story.join('\n\n') })
    story = []
  }
  for (const paragraph of paragraphs) {
    if (html !== null) {
      html.push(paragraph)
      depth += openBlocks(paragraph)
      if (depth <= 0) {
        out.push({ kind: 'html', body: html.join('\n\n') })
        html = null
      }
    } else if (HTML_LIKE.test(paragraph)) {
      flushStory()
      depth = openBlocks(paragraph)
      if (depth > 0) html = [paragraph]
      else {
        const previous = out.at(-1)
        if (previous?.kind === 'html' && previous.fromProse) previous.body += `\n\n${paragraph}`
        else out.push({ kind: 'html', body: paragraph, fromProse: true })
      }
    } else if (paragraph.trim()) {
      story.push(paragraph)
    }
  }
  if (html !== null) out.push({ kind: 'html', body: html.join('\n\n') })
  flushStory()
}

const escaped = text => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** A line of Markdown as HTML: code, links to the web, bold and italics; everything else is text. */
function inlineMarkdown(text) {
  const codes = []
  return escaped(text)
    .replace(/`([^`\n]+)`/g, (_, code) => `\uE030${codes.push(code) - 1}\uE030`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/\uE030(\d+)\uE030/g, (_, i) => `<code>${codes[i]}</code>`)
}

const LIST_LINE = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/
const CODE_MARK = /^\s*```/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inlineMarkdown(cell.trim()))
const isTable = (lines, i) => lines[i].includes('|') && lines[i + 1]?.includes('-') && TABLE_RULE.test(lines[i + 1] ?? '')
const startsBlock = (lines, i) => CODE_MARK.test(lines[i]) || /^#{1,6}\s/.test(lines[i]) || /^\s*>/.test(lines[i]) || LIST_LINE.test(lines[i]) || RULE.test(lines[i]) || isTable(lines, i)

/** The list starting at line `start`, with the lists under it: { html, next }. Blank lines between items keep it one list. */
function listHtml(lines, start) {
  const [, indent, marker] = LIST_LINE.exec(lines[start])
  const ordered = /\d/.test(marker)
  const items = []
  let i = start
  while (i < lines.length) {
    const item = LIST_LINE.exec(lines[i])
    if (item && item[1].length < indent.length) break
    if (item && item[1].length === indent.length) {
      if (/\d/.test(item[2]) !== ordered) break
      items.push({ words: [item[3]], under: '' })
      i++
    } else if (item) {
      const nested = listHtml(lines, i)
      items.at(-1).under += nested.html
      i = nested.next
    } else if (/^\s+\S/.test(lines[i])) {
      items.at(-1).words.push(lines[i].trim())
      i++
    } else if (!lines[i].trim() && (/^\s+\S/.test(lines[i + 1] ?? '') || LIST_LINE.test(lines[i + 1] ?? ''))) i++
    else break
  }
  const tag = ordered ? 'ol' : 'ul'
  const first = ordered ? parseInt(marker, 10) : 1
  const body = items.map(item => `<li>${inlineMarkdown(item.words.join(' '))}${item.under}</li>`).join('')
  return { html: `<${tag}${first > 1 ? ` start="${first}"` : ''}>${body}</${tag}>`, next: i }
}

/**
 * A reply of 直连对话 as HTML: the Markdown an assistant writes, safe for the page: all that came from the model is
 * escaped first, and only web links become links. A code fence still open reads to the end, for a reply being written.
 */
export function markdownHtml(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\uE030/g, '').split('\n')
  const out = []
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!line.trim()) i++
    else if (CODE_MARK.test(line)) {
      const start = ++i
      while (i < lines.length && !CODE_MARK.test(lines[i])) i++
      out.push(`<pre class="code"><code>${escaped(lines.slice(start, i).join('\n'))}</code></pre>`)
      i++
    } else if (heading) {
      const level = Math.min(heading[1].length + 2, 6)
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      i++
    } else if (RULE.test(line)) {
      out.push('<hr>')
      i++
    } else if (/^\s*>/.test(line)) {
      const start = i
      while (i < lines.length && /^\s*>/.test(lines[i])) i++
      out.push(`<blockquote>${markdownHtml(lines.slice(start, i).map(quoted => quoted.replace(/^\s*>\s?/, '')).join('\n'))}</blockquote>`)
    } else if (LIST_LINE.test(line)) {
      const list = listHtml(lines, i)
      out.push(list.html)
      i = list.next
    } else if (isTable(lines, i)) {
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]))
      out.push(`<div class="answer-table"><table><thead><tr>${head.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
    } else {
      const start = i++
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) i++
      out.push(`<p>${lines.slice(start, i).map(inlineMarkdown).join('<br>')}</p>`)
    }
  }
  return out.join('')
}

/** Split display text into story text, HTML (for frames) and plain code. */
export function segments(text) {
  const out = []
  const pushText = part => {
    if (part.trim()) splitProse(part, out)
  }
  let last = 0
  for (const match of text.matchAll(FENCE)) {
    pushText(text.slice(last, match.index))
    const [, lang, body] = match
    out.push(HTML_LIKE.test(body) || /^html?$/i.test(lang) ? { kind: 'html', body } : { kind: 'code', body })
    last = match.index + match[0].length
  }
  pushText(text.slice(last))
  return mergeInvisible(out)
}

const invisible = body => !body.replace(/<(style|script)\b[\s\S]*?<\/\1>|<link\b[^>]*>/gi, '').trim()

/**
 * A chunk holding only <style>/<script> (regex replacements often put the
 * style after its markup, separated by a blank line) belongs to the adjacent
 * HTML chunk: on its own it would be an empty frame and style nothing.
 */
function mergeInvisible(parts) {
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.kind !== 'html' || !invisible(part.body)) {
      out.push(part)
      continue
    }
    const previous = out.at(-1)
    const next = parts[i + 1]
    if (previous?.kind === 'html') previous.body += `\n${part.body}`
    else if (next?.kind === 'html') next.body = `${part.body}\n${next.body}`
    // Otherwise it styles nothing visible: drop it.
  }
  return out
}

// ─── Sandboxed frames ───────────────────────────────────────────────────
const heights = new Map() // content → last measured height, so re-renders do not jump
let frameCounter = 0
// The tallest a card frame is made (a page that keeps growing, 100vh inside 100vh, stops here); taller content scrolls.
const FRAME_MAX = 4000

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `${text.length}:${h}`
}

// A chunk that is a whole document: <html> first, after a doctype and comments only.
const FULL_DOCUMENT = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html(?:\s[^>]*)?>/i

/**
 * The text of a frame's page, a line per block, for 复制 (app.js copyMenu): what is drawn and what is folded away
 * (a status bar's closed <details>), not its scripts, styles or what it hides. Runs inside the frame too (frameDocument
 * puts its source there), so it uses nothing from outside itself.
 */
export function readableText(root) {
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|SVG|CANVAS|IFRAME|BUTTON|SELECT|TEXTAREA)$/i
  // Laid out (a frame, the page): blocks as drawn, and a flex or grid row's items side by side on one line. Parsed
  // only (a frame not loaded yet): blocks by their tags.
  const view = root.ownerDocument && root.ownerDocument.defaultView
  let out = ''
  const walk = (node, inRow) => {
    if (node.nodeType === 3) out += node.nodeValue
    if (node.nodeType !== 1 || SKIP.test(node.tagName) || node.hidden) return
    const style = view ? view.getComputedStyle(node) : null
    if (style && style.display === 'none') return
    if (node.tagName === 'BR') out += '\n'
    const block = !inRow && (style ? /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)$/.test(style.display) : BLOCK.test(node.tagName))
    const row = Boolean(style) && /flex|grid/.test(style.display) && !/column/.test(style.flexDirection)
    const start = out.length
    if (block) out += '\n'
    let seen = false
    let last = null
    for (const child of node.childNodes) {
      // A row that wraps: a new line where an item starts below the one before it.
      if (row && child.nodeType === 1) {
        const box = child.getBoundingClientRect()
        if (seen) out += last && box.height && box.top >= last.bottom - 1 ? '\n' : ' '
        seen = true
        if (box.height) last = box
      }
      walk(child, row)
    }
    if (/^T[DH]$/.test(node.tagName)) out += ' '
    // An empty block (a meter's bar) breaks no line.
    if (block) out = out.slice(start).trim() ? `${out}\n` : out.slice(0, start)
  }
  walk(root, false)
  return out.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

/** `context`: what the Tavern Helper stand-in needs (see compat.js); without it the frame gets plain HTML. */
function frameDocument(body, id, context) {
  const css = getComputedStyle(document.documentElement)
  const color = css.getPropertyValue('--ink').trim() || '#222'
  // Tavern Helper's frame name: TH-message--<floor>--<n>.
  const compat = context ? frameShim({ ...context, frame: id, frameName: `TH-message--${context.messageId}--${id.replace(/\D/g, '')}` }) + libraryTags(body) : ''
  if (context) body = replaceViewportHeight(body)
  // Measure the content, not the document: the document is never shorter than the frame, so a
  // block that collapses (a folded thinking panel, a re-render at a cached height) left a gap.
  // The frame says how tall it is; past FRAME_MAX (the most the page gives it) it scrolls inside itself
  // instead of cutting the rest off (a long reply wrapped whole by a card's display regex).
  const report = `<script>(()=>{const b=document.body;const height=()=>{let h=b.scrollHeight;for(const el of b.children){const r=el.getBoundingClientRect();if(r.height||r.width)h=Math.max(h,r.bottom+scrollY+(parseFloat(getComputedStyle(el).marginBottom)||0))}return Math.ceil(h)};const post=()=>{const h=height();document.documentElement.style.overflowY=h>${FRAME_MAX}?'auto':'';parent.postMessage({agentTavernFrame:${JSON.stringify(id)},height:h},'*')};addEventListener('load',post);const ro=new ResizeObserver(post);ro.observe(b);for(const el of b.children)ro.observe(el);setTimeout(post,60);setTimeout(post,600);addEventListener('message',e=>{if(e.data&&e.data.agentTavernText===${JSON.stringify(id)})parent.postMessage({agentTavernFrame:${JSON.stringify(id)},text:(${readableText})(b)},'*')})})()<\/script>`
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>html,body{margin:0;padding:0;background:transparent;color:${color};font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}</style>${compat}`
  // A full document only when it opens with <html> (after a doctype or comments): one written inside a script's
  // string (a card's export that opens a window) is not where the stand-in goes.
  const opening = FULL_DOCUMENT.exec(body)
  if (!opening) return `<!doctype html><html><head>${head}</head><body>${body}${report}</body></html>`
  // A full document: our head goes first so the stand-in exists before the card's own scripts,
  // into its own <head> when that comes before any script or the body.
  const start = opening[0].length
  const rest = body.slice(start)
  const ownHead = /^(?:\s|<!--[\s\S]*?-->)*<head[^>]*>/i.exec(rest)
  const withHead = ownHead
    ? body.slice(0, start) + ownHead[0] + head + rest.slice(ownHead[0].length)
    : `${body.slice(0, start)}<head>${head}</head>${rest}`
  return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${report}</body>`) : `${withHead}${report}`
}

export function htmlFrame(body, context = null) {
  const id = `f${++frameCounter}`
  const frame = document.createElement('iframe')
  frame.className = 'card-frame'
  frame.dataset.frame = id
  frame.dataset.key = hash(body)
  // Whose frame it is: the page keeps its localStorage under that card (compat.js storedFrameStorage).
  if (context?.cardId) frame.dataset.card = context.cardId
  // And whose floor: a card may change its own message or the latest (compat.js setMessage, app.js editMessage).
  if (context?.nodeId) frame.dataset.node = context.nodeId
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('loading', 'lazy')
  frame.style.height = `${heights.get(frame.dataset.key) ?? 80}px`
  frame.srcdoc = frameDocument(body, id, context)
  return frame
}

const textAsked = new Map() // frame id → resolve, while 复制 waits for its text

/**
 * A frame's text as it shows (its scripts may have drawn it from the variables), asked of the frame itself; read from
 * its HTML when it does not answer in time (not loaded yet: the frames load lazily).
 */
export function frameText(frame, wait = 800) {
  const id = frame.dataset.frame
  return new Promise(resolve => {
    const timer = setTimeout(() => answer(readableText(new DOMParser().parseFromString(frame.srcdoc, 'text/html').body)), wait)
    const answer = text => {
      clearTimeout(timer)
      textAsked.delete(id)
      resolve(text)
    }
    textAsked.set(id, answer)
    frame.contentWindow?.postMessage({ agentTavernText: id }, '*')
  })
}

/** Resize frames from their height reports (and hand over the text 复制 asked for); ignore messages that did not come from one of our frames. */
export function listenForFrameHeights() {
  window.addEventListener('message', event => {
    const id = event.data?.agentTavernFrame
    if (typeof id !== 'string') return
    const frame = document.querySelector(`iframe[data-frame="${CSS.escape(id)}"]`)
    if (!frame || event.source !== frame.contentWindow) return
    if (typeof event.data.text === 'string') return textAsked.get(id)?.(event.data.text)
    const height = Math.min(Math.max(Number(event.data.height) || 0, 20), FRAME_MAX)
    frame.style.height = `${height}px`
    heights.set(frame.dataset.key, height)
  })
}
