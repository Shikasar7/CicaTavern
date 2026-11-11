// Message display: the card's display regex, variable macros, and HTML
// (status bars, beautified update blocks) in sandboxed iframes. The frames get
// `allow-scripts` but never `allow-same-origin`, so card code runs in an
// opaque origin: it cannot read this page, its storage, or call the local API.
import { applyScripts, PLACEMENT } from './shared/regex.js'
import { replaceVariableMacros, UPDATE_BLOCK } from './shared/vars.js'
import { CHOICES_BLOCK, REASONING, SELF_CHECK_BLOCK, TIME_BOX_BLOCK } from './shared/basic.js'
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

// What a card's page holds is not the story's bookkeeping: a fenced block or a script may well say <UpdateVariable>
// (a prompt it sends, a parser), and an update block's open-end match would take the rest of the message with it.
// So may the model's thinking (「结尾输出 <choices>…」): taken for a choices block, the mention would hide the story up to
// the real </choices>, and the thinking's closing tag with it (the story then folded away under 思考中…).
const GUARDED = new RegExp(`\`\`\`[\\s\\S]*?\`\`\`|<script\\b[\\s\\S]*?<\\/script>|${REASONING.source}`, 'gi')

/** A fenced block of nothing but the story's bookkeeping (a model that fenced its update block): no page's, so it goes. */
function onlyHidden(fence) {
  const body = fence.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
  if (!body.trim()) return false
  let rest = body
  for (const re of HIDDEN) rest = rest.replace(re, '')
  return !rest.trim()
}

/** `strip` run on `text` with its guarded pieces out of reach; a guarded piece inside a removed block goes with it. */
function guarded(text, strip) {
  const kept = []
  const out = strip(text.replace(GUARDED, match => (match.startsWith('```') && onlyHidden(match) ? '' : `\u0000${kept.push(match) - 1}\u0000`)))
  return kept.length ? out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]) : out
}

function stripHidden(text) {
  return guarded(text, out => {
    for (const re of HIDDEN) out = out.replace(re, '')
    return out.replace(/\n{3,}/g, '\n\n').trim()
  })
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
  const written = guarded(stripHidden(String(text ?? '')), out => out.replace(OPEN_HIDDEN, '')).trimEnd()
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
  // Text not yet split: a code block inside a block still open (a card's <details> folding its update block) stays
  // inside it, as the folded block's code, the way SillyTavern's Markdown shows it.
  let pending = ''
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(last, match.index)
    const [, lang, body] = match
    last = match.index + match[0].length
    const html = HTML_LIKE.test(body) || /^html?$/i.test(lang)
    if (!html && openBlocks(pending + before) > 0) {
      pending += `${before}<pre><code>${escaped(body.replace(/\n$/, ''))}</code></pre>`
      continue
    }
    pushText(pending + before)
    pending = ''
    out.push(html ? { kind: 'html', body } : { kind: 'code', body })
  }
  pushText(pending + text.slice(last))
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

// The frames drawn, by id, for their height reports (a long chat's frames each report a few times as they load).
const framesById = new Map()

export function htmlFrame(body, context = null) {
  const id = `f${++frameCounter}`
  const frame = document.createElement('iframe')
  if (framesById.size > 400) for (const [key, kept] of framesById) if (!kept.isConnected) framesById.delete(key)
  framesById.set(id, frame)
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

// A frame not near the screen yet: a box of its height, made a frame when it comes near (fillFrameSlots). A long chat
// drew hundreds of frames at each redraw, and a frame costs the page far more to put in or take out than a box.
const slotParts = new WeakMap() // slot → { body, context }

/** A frame's place: `context` is asked for when the frame is made, so it reads the chat as it is then. */
export function frameSlot(body, context = () => null) {
  const slot = document.createElement('div')
  slot.className = 'frame-slot'
  slot.dataset.key = hash(body)
  slot.style.height = `${heights.get(slot.dataset.key) ?? 80}px`
  slotParts.set(slot, { body, context })
  return slot
}

/** The frames in `root` still waiting as slots, made now. */
export function fillFrameSlots(root) {
  for (const slot of root.querySelectorAll('.frame-slot')) {
    const part = slotParts.get(slot)
    if (part) slot.replaceWith(htmlFrame(part.body, part.context()))
  }
}

/** What a slot will show, as text (复制 on a reply whose frame was not made yet). */
export function slotText(slot) {
  const part = slotParts.get(slot)
  return part ? readableText(new DOMParser().parseFromString(part.body, 'text/html').body) : ''
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
    const frame = framesById.get(id)
    if (!frame?.isConnected || event.source !== frame.contentWindow) return
    // Loaded: the frames told of changes (compat.js broadcast*) are the ones that can hear.
    frame.dataset.loaded = ''
    if (typeof event.data.text === 'string') return textAsked.get(id)?.(event.data.text)
    const height = Math.min(Math.max(Number(event.data.height) || 0, 20), FRAME_MAX)
    frame.style.height = `${height}px`
    heights.set(frame.dataset.key, height)
  })
}

// ─── 性能记录 ───────────────────────────────────────────────────────────
// 设置 → 更多 → 性能记录 (web/perf-panel.js shows it): how long what the page does takes, for a player to send us when a long chat feels
// slow. An action (切换角色卡, 打开对话, 一次回复) gathers the spans timed while it is open: the drawing and its parts
// (正则, Markdown, 状态栏, 视觉小说…), the requests and what the server says they cost it (server/perf.mjs), long
// tasks, and for a reply the frames while it streamed. Off (the default), start() and begin() give back a function
// that does nothing, and nothing else runs: no observer, no frame loop, no header on requests.
const NOOP = () => {}
const MAX_ACTIONS = 60
const perfState = { on: false, actions: [], open: [], observer: null, listeners: new Set() }

const roundMs = ms => Math.round(ms * 10) / 10

function addSpan(action, name, ms, detail) {
  const same = action.spans.find(item => item.name === name)
  if (same) {
    same.ms += ms
    same.count += 1
    same.max = Math.max(same.max, ms)
    if (detail) Object.assign(same, detail)
  } else {
    action.spans.push({ name, ms, count: 1, max: ms, ...detail })
  }
}

const perfChanged = () => {
  for (const listener of perfState.listeners) listener()
}

/** The action spans go to: the latest one still open. */
const openAction = () => perfState.open.at(-1) ?? null

function watchLongTasks(on) {
  if (!on) {
    perfState.observer?.disconnect()
    perfState.observer = null
    return
  }
  try {
    perfState.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        // A long task belongs to the actions open while it ran.
        for (const action of perfState.open) addSpan(action, 'longtask', entry.duration)
      }
    })
    perfState.observer.observe({ type: 'longtask' })
  } catch {
    // An old WebView without long tasks: the table goes without them.
    perfState.observer = null
  }
}

export const perf = {
  get on() {
    return perfState.on
  },
  /** Recording or not; turning it on starts an empty table. */
  setOn(on) {
    perfState.on = Boolean(on)
    perfState.open = []
    if (perfState.on) perfState.actions = []
    watchLongTasks(perfState.on)
    perfChanged()
  },
  clear() {
    perfState.actions = perfState.actions.filter(action => !action.done)
    perfChanged()
  },
  actions: () => perfState.actions,
  onChange(listener) {
    perfState.listeners.add(listener)
    return () => perfState.listeners.delete(listener)
  },

  /**
   * Starts an action (`kind`: switch, open, reply…; `label`: which card or chat). The function it gives ends it,
   * once the page has drawn what it did (the next frame). Inside another action of `within`, it is part of that one.
   */
  begin(kind, label = '', { within = [] } = {}) {
    if (!perfState.on) return NOOP
    if (within.includes(openAction()?.kind)) return NOOP
    const action = { kind, label, at: new Date().toISOString(), startedAt: performance.now(), total: 0, spans: [], server: [], done: false }
    perfState.actions.unshift(action)
    if (perfState.actions.length > MAX_ACTIONS) perfState.actions.length = MAX_ACTIONS
    perfState.open.push(action)
    let ended = false
    return (extra = {}) => {
      if (ended) return
      ended = true
      const finish = () => {
        action.total = performance.now() - action.startedAt
        Object.assign(action, extra, { done: true })
        perfState.open = perfState.open.filter(item => item !== action)
        perfChanged()
      }
      // After the browser has laid it out and painted: the time the player waited to see it.
      requestAnimationFrame(() => setTimeout(finish, 0))
    }
  },

  /** Times `name` in the open action; the function it gives ends it (`extra`: counts to show beside it). */
  start(name, detail) {
    if (!perfState.on) return NOOP
    const action = openAction()
    if (!action) return NOOP
    const startedAt = performance.now()
    return extra => addSpan(action, name, performance.now() - startedAt, detail || extra ? { ...detail, ...extra } : null)
  },

  /** A stretch of the open action from its start to now (e.g. 等到第一个字), once. */
  mark(name) {
    if (!perfState.on) return
    const action = openAction()
    if (action && !action.spans.some(item => item.name === name)) addSpan(action, name, performance.now() - action.startedAt)
  },

  /** What the server says a request cost it (its x-perf-trace, or a reply's `perf`), added to the open action. */
  server(path, report) {
    if (!perfState.on || !report) return
    const action = openAction()
    if (action) action.server.push({ path: String(path).replace(/[?#].*$/, ''), total: report.total, spans: report.spans ?? [] })
  },

  /** The gaps between frames until the function it gives is called (a reply streaming): how smooth it was. */
  watchFrames() {
    if (!perfState.on) return NOOP
    const action = openAction()
    if (!action) return NOOP
    const gaps = []
    let last = performance.now()
    let running = true
    const tick = now => {
      gaps.push(now - last)
      last = now
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      running = false
      const sorted = gaps.slice(1).sort((a, b) => a - b)
      if (!sorted.length) return
      action.frames = {
        count: sorted.length,
        p50: roundMs(sorted[Math.floor(sorted.length / 2)]),
        p95: roundMs(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
        max: roundMs(sorted.at(-1)),
        over50: sorted.filter(gap => gap > 50).length,
        over100: sorted.filter(gap => gap > 100).length,
      }
    }
  },
}

/** The headers a request carries while recording: the server times it then. */
export const perfHeaders = () => (perfState.on ? { 'x-perf': '1' } : null)

/** The table as JSON, for 导出 (the page's size and what it runs on, to read it by). */
export function perfReport(about = {}) {
  return {
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    cores: navigator.hardwareConcurrency ?? null,
    ...about,
    actions: perfState.actions.filter(action => action.done).map(action => ({
      ...action,
      startedAt: undefined,
      done: undefined,
      total: roundMs(action.total),
      spans: action.spans.map(item => ({ ...item, ms: roundMs(item.ms), max: roundMs(item.max) })),
    })),
  }
}

// ─── 导出文本 ──────────────────────────────────────────────────────────────
// A whole conversation as a .txt or .md file (the ⇩ on its row in the chat list). The page sorts each message into
// parts the way 复制 does (app.js replyParts: story, status, choices) and hands them here; this only picks and lays them
// out, so it runs in the tests as well.

/**
 * What a message keeps: with `storyOnly` (仅正文) its story parts, else all of them. A message with no story part at
 * all (a card that draws its whole reply in its own page) keeps what it has, as 复制 then offers only 全部.
 * @param parts - [{ kind: 'story' | 'status' | 'choices', text }]
 */
export function messageText(parts, storyOnly) {
  const story = parts.filter(part => part.kind === 'story')
  const kept = storyOnly && story.length ? story : parts
  return kept.map(part => String(part.text ?? '').trim()).filter(Boolean).join('\n\n')
}

const TEXT_MARKS = { name: name => `【${name}】`, note: text => `（${text}）` } // i18n-ignore: app.js passes the page's own

/**
 * The text of a chat's branch, from the opening to the latest reply, each message under its speaker's name.
 * Hidden rounds (隐藏这一轮: the player's message and the reply both carry `hidden`) are left out; deleted messages are
 * not in the path. A message with nothing left to show is skipped.
 * @param path - the branch on screen (the chat view's `path`).
 * @param options.format - 'txt' or 'md' (a title, **名字** lines, --- between turns).
 * @param options.nameOf - node → the speaker's name.
 * @param options.partsOf - node → its parts (see messageText).
 * @param options.notesOf - node → { before, after }: a line said about it (a compaction point), or nothing.
 * @param options.marks - in a .txt, { name, note }: how a speaker's name and a note are written (the page's language).
 */
export function chatText(path, { format = 'txt', storyOnly = true, title = '', date = '', nameOf, partsOf, notesOf = () => null, marks = TEXT_MARKS }) {
  const md = format === 'md'
  const blocks = []
  const note = text => blocks.push(md ? text.split('\n').map(line => `> ${line}`).join('\n') : marks.note(text))
  for (const node of path) {
    if (node.hidden) continue
    const { before, after } = notesOf(node) ?? {}
    if (before) note(before)
    const text = messageText(partsOf(node) ?? [], storyOnly)
    // Markdown joins lines that only a line break parts (a reply written a line at a time, a status list): kept apart
    // with a hard break (two spaces at the end of the line).
    if (text) blocks.push(md ? `**${nameOf(node)}**\n\n${text.replace(/([^\n])\n(?=[^\n])/g, '$1  \n')}` : `${marks.name(nameOf(node))}\n${text}`)
    if (after) note(after)
  }
  const head = md ? [title && `# ${title}`, date].filter(Boolean).join('\n\n') : [title, date].filter(Boolean).join('\n')
  const body = blocks.join(md ? '\n\n---\n\n' : '\n\n')
  return `${[head, body].filter(Boolean).join(md ? '\n\n---\n\n' : '\n\n\n')}\n`
}
