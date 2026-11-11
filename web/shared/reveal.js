// 出字效果 (主题 → 出字效果): how far a reply being written is shown, frame by frame.
// The pacing half, with no page in it (web/stream-reveal.js draws). A relay sends a reply in lumps with gaps
// between them, a fast model in a stream of crumbs; either way the reader sees it come at an even pace:
// - the pace follows how fast the text has been arriving (over the last WINDOW_MS), eased so it never lurches;
// - it never falls further behind than MAX_LAG_MS of that pace, so a fast model is not held back;
// - when the model pauses, what is left runs out at a slowing pace instead of stopping dead;
// - at the end, whatever is left is shown within FINISH_MS.
// 写完再显示 (whole) shows nothing until the reply has ended, then all of it.
// Positions are indexes into the text as the page will show it (streamingText): the markup in it (a tag, a
// 【name|look】 mark, the ** of bold) and a fold's insides (a model's thinking, shown folded) cost no time.
// Old Android WebViews run this: no \p{} and nothing newer than Chrome 80 here.

import { REVEAL_DEFAULT } from './appearance.js'

export { REVEAL_DEFAULT, REVEAL_MODES } from './appearance.js'

const MIN_CPS = 24
const WINDOW_MS = 1500
const MAX_LAG_MS = 900
const EASE_MS = 220
const FINISH_MS = 220
// 逐句: a sentence that has not ended after this long shows as far as it has come.
const SENTENCE_WAIT_MS = 1400
const SENTENCE_END = '。！？!?…\n' // i18n-ignore: punctuation
const SENTENCE_CLOSE = '”」』）)】*~～—' // i18n-ignore: punctuation
// A mark that is still being written (its closing part not come yet) is waited for, unless it runs this long.
const MARK_WAIT = 300
const NAME_MARK = 40

/** The name of the tag at i, if s has '<' there: { name, closing, end } with end just after its '>', or 'wait' or null. */
function tagAt(s, i) {
  const close = s.indexOf('>', i)
  const reopen = s.indexOf('<', i + 1)
  if (close < 0) return s.length - i <= MARK_WAIT ? 'wait' : null
  if (reopen >= 0 && reopen < close) return null
  const match = /^<(\/?)([A-Za-z一-鿿][\w~:.\-一-鿿]*)[^<>]*>$/.exec(s.slice(i, close + 1))
  return match ? { name: match[2], closing: Boolean(match[1]), end: close + 1 } : null
}

/**
 * One step on from i: { next, cost } (cost: how much of the pace it takes, 0 for markup), or null when what
 * comes next is a mark still being written (wait for the rest of it).
 * @param folds - a RegExp for the tags whose insides are folded away (shared/vn.js FOLD_TAG), or null.
 */
export function stepAt(s, i, folds = null) {
  const ch = s.charAt(i)
  if (ch === '<') {
    const tag = tagAt(s, i)
    if (tag === 'wait') return null
    if (tag) {
      if (!tag.closing && folds && folds.test(tag.name)) {
        const end = s.toLowerCase().indexOf(`</${tag.name.toLowerCase()}>`, tag.end)
        return end < 0 ? { next: s.length, cost: 0, fold: tag.name } : { next: end + tag.name.length + 3, cost: 0 }
      }
      return { next: tag.end, cost: 0 }
    }
  } else if (ch === '【') { // i18n-ignore: a name mark
    const close = s.indexOf('】', i) // i18n-ignore: a name mark
    const line = s.indexOf('\n', i)
    if (close >= 0 && close - i <= NAME_MARK && (line < 0 || line > close)) return { next: close + 1, cost: 0 }
    if (close < 0 && line < 0 && s.length - i <= NAME_MARK) return null
  } else if (ch === '*') {
    return { next: i + 1, cost: 0 }
  } else if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
    return { next: i + 1, cost: 0.25 }
  }
  const code = s.charCodeAt(i)
  return { next: code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1, cost: 1 }
}

/** Where the sentence from i ends (just after its closing marks), or -1 if it has not ended in s yet. */
export function sentenceEnd(s, i, folds = null) {
  let at = i
  let seen = false
  while (at < s.length) {
    const step = stepAt(s, at, folds)
    if (!step) return -1
    const ch = s.charAt(at)
    at = step.next
    if (step.cost >= 1) seen = true
    if (seen && SENTENCE_END.indexOf(ch) >= 0) {
      while (at < s.length && (SENTENCE_END.indexOf(s.charAt(at)) >= 0 || SENTENCE_CLOSE.indexOf(s.charAt(at)) >= 0)) at++
      return at
    }
  }
  return -1
}

/**
 * The pace for one reply. push() each time the text grows (the whole text so far), end() when it is all there,
 * tick() once a frame: it says how far to show.
 * @param mode - one of REVEAL_MODES.
 */
export function createPacer({ mode = REVEAL_DEFAULT, folds = null } = {}) {
  let source = ''
  let shown = 0
  let speed = 0
  let credit = 0
  let ended = false
  let finishSpeed = 0
  let fold = null // the fold the shown part ends inside (its closing tag not come yet)
  let lastShow = 0
  // [time, length]: the first is where the window starts (the last arrival before it), so a pause slows the rate.
  const arrivals = []

  /** Characters a second over the last WINDOW_MS, counted up to now (a model that went quiet drifts to 0). */
  function rate(now) {
    while (arrivals.length > 2 && now - arrivals[1][0] > WINDOW_MS) arrivals.shift()
    if (arrivals.length < 2) return 0
    const [since, from] = arrivals[0]
    const latest = arrivals[arrivals.length - 1][1]
    return (latest - from) / (Math.max(250, now - since) / 1000)
  }

  /** One step on, through a fold still being written: to its closing tag once it has come. */
  function step(at) {
    if (fold) {
      const closing = `</${fold.toLowerCase()}>`
      const end = source.toLowerCase().indexOf(closing, Math.max(0, at - closing.length))
      if (end < 0) return at < source.length ? { next: source.length, cost: 0 } : null
      fold = null
      return { next: Math.max(at, end + closing.length), cost: 0 }
    }
    const next = stepAt(source, at, folds)
    if (next && next.fold) fold = next.fold
    return next
  }

  return {
    get mode() {
      return mode
    },
    /** The whole text so far. */
    push(text, now) {
      source = String(text || '')
      if (shown > source.length) shown = source.length
      // The first lump counts as having taken a quarter second: a reply that starts with a big one starts quick.
      if (!arrivals.length) arrivals.push([now - 250, 0])
      arrivals.push([now, source.length])
      if (!speed) speed = Math.max(MIN_CPS, rate(now))
      if (!lastShow) lastShow = now
    },
    /** Starts from text already there (继续生成: the reply as it was), shown at once; the pace is what comes after it. */
    begin(text, now) {
      source = String(text || '')
      shown = source.length
      arrivals.length = 0
      arrivals.push([now - 250, source.length])
      lastShow = now
    },
    /** From the top again (the reply is being asked for again). */
    reset() {
      source = ''
      shown = 0
      speed = 0
      credit = 0
      fold = null
      lastShow = 0
      arrivals.length = 0
    },
    end() {
      ended = true
    },
    get ended() {
      return ended
    },
    /** Everything is shown (and nothing more is coming). */
    get done() {
      return ended && shown >= source.length
    },
    get source() {
      return source
    },
    get shown() {
      return shown
    },
    /** Shows everything at once (not on screen: there is nobody to pace for). */
    skip() {
      shown = source.length
      fold = null
      credit = 0
    },
    /** Moves on by a frame of dt ms; returns how far to show. */
    tick(now, dt) {
      if (mode === 'none') {
        shown = source.length
        return shown
      }
      if (mode === 'whole') {
        shown = ended ? source.length : 0
        return shown
      }
      const left = source.length - shown
      if (left <= 0) {
        credit = 0
        return shown
      }
      let wanted = Math.max(MIN_CPS, rate(now), left / (MAX_LAG_MS / 1000))
      if (ended) {
        finishSpeed = Math.max(finishSpeed, left / (FINISH_MS / 1000))
        wanted = Math.max(wanted, finishSpeed)
      }
      speed += (wanted - speed) * (1 - Math.exp(-dt / EASE_MS))
      if (ended) speed = Math.max(speed, finishSpeed)
      credit = Math.min(credit + (speed * dt) / 1000, Math.max(3, (speed * 120) / 1000))
      if (mode === 'sentence') {
        if (credit < 0) return shown
        let end = sentenceEnd(source, shown, folds)
        if (end < 0 && (ended || now - lastShow > SENTENCE_WAIT_MS)) end = source.length
        if (end < 0) return shown
        let cost = 0
        let at = shown
        while (at < end) {
          const next = step(at)
          if (!next) break
          cost += next.cost
          at = next.next
        }
        if (at === shown) return shown
        shown = at
        credit -= cost
        lastShow = now
        return shown
      }
      while (shown < source.length) {
        const next = step(shown)
        if (!next) break
        if (next.cost > credit) break
        credit -= next.cost
        shown = next.next
        lastShow = now
      }
      return shown
    },
  }
}

const VOID_TAG = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i
const TAG_OR_COMMENT = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g

/**
 * HTML cut into its top-level pieces (an element with all inside it, or the text between them), so a reply drawn
 * again need only parse the pieces that changed: '<p>a</p><p>b</p>' → ['<p>a</p>', '<p>b</p>'].
 * Null when the tags do not pair up (then it is drawn whole).
 */
export function topLevel(html) {
  const pieces = []
  const open = []
  let start = 0
  TAG_OR_COMMENT.lastIndex = 0
  let match
  while ((match = TAG_OR_COMMENT.exec(html))) {
    if (match[0].charAt(1) === '!') continue
    if (!open.length && match.index > start) {
      pieces.push(html.slice(start, match.index))
      start = match.index
    }
    const name = match[2].toLowerCase()
    if (match[1]) {
      if (open.pop() !== name) return null
    } else if (!match[3] && !VOID_TAG.test(name)) {
      open.push(name)
      continue
    }
    if (!open.length) {
      pieces.push(html.slice(start, TAG_OR_COMMENT.lastIndex))
      start = TAG_OR_COMMENT.lastIndex
    }
  }
  if (open.length) return null
  if (start < html.length) pieces.push(html.slice(start))
  return pieces
}
