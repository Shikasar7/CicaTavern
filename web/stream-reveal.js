// 出字效果: a reply being written, put on the page a frame at a time (the pace is shared/reveal.js).
// - Drawn once a frame at most, not once for every piece the model sends; on a slow device less often (the
//   time a draw takes decides), in bigger steps, so the page stays free to scroll.
// - Only what changed is put in again: the paragraphs before the one being written stay the same nodes, so
//   they neither flash nor lay out again, and a selection in them holds.
// - Characters just shown are wrapped for their animation, a span for each frame's few, with a negative delay
//   so a paragraph drawn again carries on where it was; once the animation is over they are plain text again
//   at the next draw. However long the reply, only the last fraction of a second is wrapped.
// - The transcript follows the reply down smoothly (eased, not a jump), only while the reader is at the bottom.
// The visual novel types its lines its own way (vn.js, 打字速度): this is for the transcript.
import { createPacer, topLevel } from '/shared/reveal.js'

// How long the animation of each effect runs (style.css .rv uses --rv-ms).
const ANIMATION_MS = { fade: 380, ink: 520, sentence: 700, type: 0, none: 0, whole: 420 }
// A draw that takes longer than this is done less often: every DRAW_GAP times its own cost.
const CHEAP_DRAW_MS = 4
const DRAW_GAP = 2.5
const FOLLOW_MS = 110
// Characters shown this close together share one span (and one start).
const MARK_MS = 50
const FINISH_CAP_MS = 1000
// At the end the finished reply is drawn once the last characters are this far into their animation (the rest of
// it is too faint a change to wait for).
const SETTLE_MS = 250
// A device that cannot keep up (frames slower than SLOW_FRAME_MS for SLOW_FOR_MS) keeps the pace and drops the
// animation for the rest of the reply: smooth before pretty.
const SLOW_FRAME_MS = 34
const SLOW_FOR_MS = 1000

const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * @param options.target - () => the element the reply is drawn in (.msg-body), or null when it is not on screen.
 * @param options.html - text → the reply's HTML (liveHtml).
 * @param options.source - the whole text so far → the text as it will show (streamingText), what is paced.
 * @param options.scroller - the transcript.
 * @param options.following - () => whether to keep the reply's end in sight.
 * @param options.mode - one of shared/reveal.js REVEAL_MODES.
 * @param options.folds - a RegExp for the tags whose insides are folded (their text costs no time).
 * @param options.timer - () => a function to call when done: each draw is timed with it (性能记录's 'live'), or null.
 */
export function createReveal({ target, html, source, scroller, following, mode, folds = null, timer = null }) {
  const pacer = createPacer({ mode, folds })
  const still = stillMotion()
  let animationMs = still ? 0 : ANIMATION_MS[mode] || 0
  let slowSince = 0
  let frameMs = 0 // frame time, averaged
  const template = document.createElement('template')
  let node = null // the element drawn in
  // What is in it, a piece of the HTML at a time (shared/reveal.js topLevel): { html, nodes, length }.
  // A draw compares the new pieces with these as strings and parses only the ones that changed.
  let blocks = []
  let drawnHtml = null
  let drawnTotal = 0
  let drawnShown = -1 // how far the last draw showed
  let marks = [] // { from, at }: from this character on, shown at this time (still animating)
  let caret = null
  let frame = 0
  let last = 0
  let lastDraw = 0
  let drawCost = 0
  let finishing = null
  let stopped = false

  function adopt(element) {
    node = element
    blocks = []
    // Drawn again from the start in this same frame (liveNodes put the reply there as far as it had come).
    node.textContent = ''
    lastDraw = 0
    drawnHtml = null
    marks = []
    drawnTotal = -1
    drawnShown = -1
    if (animationMs) node.style.setProperty('--rv-ms', `${animationMs}ms`)
    node.dataset.reveal = mode
  }

  /** The characters shown since `marks` began, in `nodes` (the first starting at offset `base`), wrapped. */
  function wrap(nodes, base) {
    if (!marks.length || !animationMs) return
    const now = performance.now()
    const from = marks[0].from
    for (const top of nodes) {
      const length = top.textContent.length
      if (base + length <= from) {
        base += length
        continue
      }
      const texts = []
      const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) texts.push(walker.currentNode)
      for (const text of texts) {
        const value = text.nodeValue
        const start = base
        base += value.length
        if (base <= from || !value) continue
        if (text.parentNode && text.parentNode.closest && text.parentNode.closest('details:not([open])')) continue
        const parts = document.createDocumentFragment()
        let at = 0
        if (from > start) {
          at = from - start
          parts.append(value.slice(0, at))
        }
        for (let k = 0; k < marks.length && at < value.length; k++) {
          const end = k + 1 < marks.length ? marks[k + 1].from - start : value.length
          if (end <= at) continue
          const piece = document.createElement('span')
          piece.className = 'rv'
          piece.style.animationDelay = `${Math.round(marks[k].at - now)}ms`
          piece.textContent = value.slice(at, Math.min(end, value.length))
          parts.append(piece)
          at = Math.min(end, value.length)
        }
        text.replaceWith(parts)
      }
    }
  }

  /** The 打字机 caret, after the last character shown. */
  function placeCaret() {
    if (mode !== 'type') return
    if (!caret) {
      caret = document.createElement('span')
      caret.className = 'rv-caret'
      caret.setAttribute('aria-hidden', 'true')
    }
    caret.remove()
    const text = lastText(node)
    if (text) text.after(caret)
    else node.append(caret)
  }

  /** The last text with something in it, looked for from the end (a reply's start is never walked); not in a fold. */
  function lastText(root) {
    for (let child = root.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()) return child
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== 'DETAILS') {
        const found = lastText(child)
        if (found) return found
      }
    }
    return null
  }

  function draw(now) {
    const timing = timer ? timer() : null
    try {
      paint(now)
    } finally {
      if (timing) timing()
    }
  }

  /** 写完再显示: a loading mark where the reply will be, until it comes whole. */
  function placeWait() {
    if (node.querySelector(':scope > .rv-wait')) return
    const wait = document.createElement('div')
    wait.className = 'rv-wait'
    wait.setAttribute('aria-hidden', 'true')
    wait.innerHTML = '<i></i><i></i><i></i>'
    node.append(wait)
    // Nothing of the reply is on the page yet: when it comes, all of it is new and fades in.
    drawnTotal = 0
  }

  function paint(now) {
    const started = performance.now()
    if (mode === 'whole') {
      if (!pacer.ended) return placeWait()
      const wait = node.querySelector(':scope > .rv-wait')
      if (wait) wait.remove()
    }
    const markup = html(pacer.source.slice(0, pacer.shown))
    if (markup === drawnHtml) return
    drawnHtml = markup
    const pieces = topLevel(markup) || [markup]
    let same = 0
    const shared = Math.min(pieces.length, blocks.length)
    while (same < shared && blocks[same].html === pieces[same]) same++
    for (let i = blocks.length - 1; i >= same; i--) for (const old of blocks[i].nodes) old.remove()
    if (caret) caret.remove()
    let base = 0
    for (let i = 0; i < same; i++) base += blocks[i].length
    let total = base
    const added = []
    blocks.length = same
    for (let i = same; i < pieces.length; i++) {
      template.innerHTML = pieces[i]
      // Text at the top is held in a span: wrapping its characters must not take away the node the block keeps.
      const nodes = Array.from(template.content.childNodes, item => {
        if (item.nodeType !== Node.TEXT_NODE) return item
        const holder = document.createElement('span')
        item.replaceWith(holder)
        holder.append(item)
        return holder
      })
      const length = nodes.reduce((sum, item) => sum + item.textContent.length, 0)
      blocks.push({ html: pieces[i], nodes, length })
      total += length
      for (const item of nodes) added.push(item)
      node.append(template.content)
    }
    if (drawnTotal >= 0 && animationMs) {
      marks = marks.filter(mark => mark.from < total && now - mark.at < animationMs)
      // Characters shown within MARK_MS of each other come in together: fewer spans to paint, the same look.
      const latest = marks[marks.length - 1]
      if (total > drawnTotal && !(latest && now - latest.at < MARK_MS)) marks.push({ from: drawnTotal, at: now })
      wrap(added, base)
    }
    drawnTotal = total
    placeCaret()
    const cost = performance.now() - started
    drawCost = drawCost ? drawCost * 0.8 + cost * 0.2 : cost
  }

  /** Eases the transcript down to the reply's end. Returns true while it still has some way to go. */
  function follow(dt) {
    if (!following()) return false
    const bottom = scroller.scrollHeight - scroller.clientHeight
    const top = scroller.scrollTop
    const gap = bottom - top
    if (gap <= 1) return false
    const step = still ? gap : Math.max(1, gap * (1 - Math.exp(-dt / FOLLOW_MS)))
    scroller.scrollTop = Math.min(bottom, top + step)
    return true
  }

  function tick(now) {
    frame = 0
    if (stopped) return
    const dt = last ? Math.min(100, now - last) : 16
    if (last) frameMs = frameMs ? frameMs * 0.9 + dt * 0.1 : dt
    if (animationMs && last && frameMs > SLOW_FRAME_MS) {
      slowSince = slowSince || now
      if (now - slowSince > SLOW_FOR_MS) {
        animationMs = 0
        marks = []
      }
    } else slowSince = 0
    last = now
    const element = target()
    if (!element || document.hidden) pacer.skip()
    pacer.tick(now, dt)
    let moving = false
    if (element) {
      if (element !== node) adopt(element)
      const gap = drawCost > CHEAP_DRAW_MS ? drawCost * DRAW_GAP : 0
      const behind = drawnHtml === null || pacer.shown !== drawnShown
      if (behind && (now - lastDraw >= gap || pacer.done)) {
        draw(now)
        drawnShown = pacer.shown
        lastDraw = now
      }
      moving = follow(dt)
      if (mode === 'type' && caret) caret.classList.toggle('waiting', pacer.shown >= pacer.source.length && !pacer.ended)
    }
    const youngest = marks.length ? now - marks[marks.length - 1].at : Infinity
    const animating = youngest < animationMs
    // 写完再显示 has nothing more to draw until the reply ends (finish wakes it).
    const allShown = (mode === 'whole' && !pacer.ended && drawnShown === 0) || (pacer.shown >= pacer.source.length && pacer.shown === drawnShown)
    if (finishing && allShown && pacer.ended && (youngest >= Math.min(animationMs, SETTLE_MS) || !element)) return finishing.resolve()
    if (!allShown || moving || animating || finishing) frame = requestAnimationFrame(tick)
    else {
      last = 0
      frameMs = 0
    }
  }

  function wake() {
    if (!frame && !stopped) frame = requestAnimationFrame(tick)
  }

  return {
    mode,
    /** The reply so far (the whole text, before streamingText). */
    push(text) {
      pacer.push(source(text), performance.now())
      wake()
    },
    /** The reply starts from text already there (继续生成), shown at once. */
    begin(text) {
      pacer.begin(source(text), performance.now())
      drawnShown = -1
      wake()
    },
    /** The reply is being asked for again: from nothing. */
    reset() {
      pacer.reset()
      drawnShown = -1
      wake()
    },
    /** Something else in the reply grew (its thinking): keep its end in sight. */
    nudge: wake,
    /** What is on the page so far, for drawing the reply again (switching back to this chat). */
    text: () => pacer.source.slice(0, pacer.shown),
    /** It is all there: show the rest (quickly) and settle. Resolves when done, or after a cap. */
    finish() {
      pacer.end()
      if (finishing) return finishing.promise
      let resolve
      const promise = new Promise(done => { resolve = done })
      const timer = setTimeout(() => finishing && finishing.resolve(), FINISH_CAP_MS)
      finishing = {
        promise,
        resolve() {
          clearTimeout(timer)
          stopped = true
          cancelAnimationFrame(frame)
          frame = 0
          resolve()
        },
      }
      if (document.hidden) finishing.resolve()
      else wake()
      return promise
    },
    /** Stops at once (the turn failed or was stopped): what is drawn stays. */
    stop() {
      if (finishing) return finishing.resolve()
      stopped = true
      cancelAnimationFrame(frame)
      frame = 0
    },
  }
}
