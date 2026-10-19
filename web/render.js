// Message display: the card's display regex, variable macros, and HTML
// (status bars, beautified update blocks) in sandboxed iframes. The frames get
// `allow-scripts` but never `allow-same-origin`, so card code runs in an
// opaque origin: it cannot read this page, its storage, or call the local API.
import { applyScripts, PLACEMENT } from './shared/regex.js'
import { replaceVariableMacros } from './shared/vars.js'
import { frameShim, libraryTags, replaceViewportHeight } from './compat.js'

const PLACEHOLDER = /<StatusPlaceHolderImpl\s*\/>/i
const HIDDEN = [
  /<state>[\s\S]*?<\/state>/gi,
  /<(update(?:variable)?)>[\s\S]*?<\/\1>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<think>[\s\S]*?<\/think>/gi,
  /<StatusPlaceHolderImpl\s*\/>/gi,
  // The built-in preset's time box and choices: the page draws them (status.js), not as text.
  /<time_box>[\s\S]*?<\/time_box>/gi,
  /<choices>[\s\S]*?<\/choices>/gi,
]
const OPEN_HIDDEN = /<(state|update(?:variable)?|thinking|think|time_box|choices)>(?![\s\S]*<\/\1>)[\s\S]*$/i
const FENCE = /```([\w-]*)[^\n]*\n?([\s\S]*?)```/g
const HTML_LIKE = /<(!doctype|html|head|body|style|script|div|table|section|details|svg|canvas|link|iframe|form|button)\b/i

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

/** Text streamed so far, with finished bookkeeping blocks removed and an unfinished one hidden. */
export function streamingText(text) {
  return stripHidden(String(text ?? '')).replace(OPEN_HIDDEN, '').trimEnd()
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
 * Display text of one message after the card's display regex.
 * @param node - { role, raw, text, state }.
 * @param depth - 0 for the latest message.
 * @param withStatus - append the MVU status placeholder (the latest reply only).
 */
export function displayOf(node, { scripts, names, depth, withStatus }) {
  let text = String(node.raw ?? node.text ?? '')
  if (node.role === 'user' && !scripts.length) return text
  // The status bar always goes after the story: models often write the placeholder first,
  // or before their variable-update block.
  if (withStatus || PLACEHOLDER.test(text)) text = `${text.replace(/<StatusPlaceHolderImpl\s*\/>/gi, '').trimEnd()}\n\n<StatusPlaceHolderImpl/>`
  const macros = text => nameMacros(replaceVariableMacros(text, node.state), names)
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

function hash(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return `${text.length}:${h}`
}

/** `context`: what the Tavern Helper stand-in needs (see compat.js); without it the frame gets plain HTML. */
function frameDocument(body, id, context) {
  const css = getComputedStyle(document.documentElement)
  const color = css.getPropertyValue('--ink').trim() || '#222'
  const compat = context ? frameShim({ ...context, frame: id, frameName: `TH-message--${context.messageId}--${id}` }) + libraryTags(body) : ''
  if (context) body = replaceViewportHeight(body)
  // Measure the content, not the document: the document is never shorter than the frame, so a
  // block that collapses (a folded thinking panel, a re-render at a cached height) left a gap.
  const report = `<script>(()=>{const b=document.body;const height=()=>{let h=b.scrollHeight;for(const el of b.children){const r=el.getBoundingClientRect();if(r.height||r.width)h=Math.max(h,r.bottom+scrollY+(parseFloat(getComputedStyle(el).marginBottom)||0))}return Math.ceil(h)};const post=()=>parent.postMessage({agentTavernFrame:${JSON.stringify(id)},height:height()},'*');addEventListener('load',post);const ro=new ResizeObserver(post);ro.observe(b);for(const el of b.children)ro.observe(el);setTimeout(post,60);setTimeout(post,600)})()<\/script>`
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>html,body{margin:0;padding:0;background:transparent;color:${color};font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;overflow:hidden}</style>${compat}`
  if (!/<html[\s>]/i.test(body)) return `<!doctype html><html><head>${head}</head><body>${body}${report}</body></html>`
  // A full document: our head goes first so the stand-in exists before the card's own scripts.
  const withHead = /<head[\s>]/i.test(body) ? body.replace(/<head[^>]*>/i, m => `${m}${head}`) : body.replace(/<html[^>]*>/i, m => `${m}<head>${head}</head>`)
  return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${report}</body>`) : `${withHead}${report}`
}

export function htmlFrame(body, context = null) {
  const id = `f${++frameCounter}`
  const frame = document.createElement('iframe')
  frame.className = 'card-frame'
  frame.dataset.frame = id
  frame.dataset.key = hash(body)
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('loading', 'lazy')
  frame.style.height = `${heights.get(frame.dataset.key) ?? 80}px`
  frame.srcdoc = frameDocument(body, id, context)
  return frame
}

/** Resize frames from their height reports; ignore messages that did not come from one of our frames. */
export function listenForFrameHeights() {
  window.addEventListener('message', event => {
    const id = event.data?.agentTavernFrame
    if (typeof id !== 'string') return
    const frame = document.querySelector(`iframe[data-frame="${id}"]`)
    if (!frame || event.source !== frame.contentWindow) return
    const height = Math.min(Math.max(Number(event.data.height) || 0, 20), 4000)
    frame.style.height = `${height}px`
    heights.set(frame.dataset.key, height)
  })
}
