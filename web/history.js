// Looking back through a long chat: a round label on each of your messages,
// a scrub rail beside the transcript, a "where am I" pill, and a panel to
// search past rounds or jump straight to one by number.
import { t } from '/i18n.js'

const $ = id => document.getElementById(id)
const LONG_JUMP = 6 // viewports; farther than this jumps instead of gliding
const HIGHLIGHT_MS = 8000
// A long chat's rail spreads out only the rounds around the view (at the end, the latest); the rest
// fold into a band at each end, which shrinks or grows as you go, so the thumb still reaches both ends.
const FOLD_FROM = 16 // rounds; fewer than this, all spread out
const RECENT = 10 // rounds spread out at a time
const LEAD = 0.5 // of them above the top of the view, the rest below
const REFLOW_MS = 400

export function initHistory({ el, getChat }) {
  const box = $('transcript')
  const rail = $('rail')
  const track = rail.querySelector('.rail-track')
  const ticks = $('rail-ticks')
  const thumb = $('rail-thumb')
  const bubble = $('rail-bubble')
  const folds = [el('i', { class: 'rail-fold', hidden: '' }), el('i', { class: 'rail-fold', hidden: '' })]
  track.prepend(...folds)
  const where = $('whereabouts')
  const panel = $('history')
  const query = $('history-query')
  const list = $('history-list')
  const pages = $('history-pages')
  const count = $('history-count')
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

  const state = {
    rounds: [], // { n, input, reply, nodes: [article…], userId, top }
    current: 0,
    scope: 'all',
    active: -1, // index into shown rows
    shown: [], // rows currently in the list: { n, jump? }
    terms: [],
    height: 0,
    win: null, // { lo }: the rail's spread-out rounds start there, counted in rounds; null, all spread out
    stops: [], // the rail's scale: [page offset, track fraction] pairs, straight between
    reflowTimer: 0,
    hitTimer: 0,
    awakeTimer: 0,
    drag: null,
  }

  // ─── Rounds ───────────────────────────────────────────────────────
  const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim()
  /** What the message reads as: folded blocks (thinking and the like) left out. */
  const readable = body => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => (node.parentElement?.closest('details, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    return walker
  }
  const bodyText = article => {
    const body = article?.querySelector('.msg-body')
    if (!body) return ''
    const parts = []
    const walker = readable(body)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.data)
    return flat(parts.join(' '))
  }

  /** Round 0 is the opening; round n starts with your n-th message and holds the reply to it. */
  function collect(chat) {
    const articles = new Map([...box.querySelectorAll('.msg[data-id]')].map(a => [a.dataset.id, a]))
    const rounds = []
    for (const node of chat?.path ?? []) {
      const article = articles.get(node.id)
      if (!article) continue
      if (node.role === 'user') {
        rounds.push({ n: 0, input: bodyText(article) || flat(node.text), reply: '', nodes: [article], top: 0 })
      } else if (!rounds.length) {
        rounds.push({ n: 0, input: '', reply: bodyText(article), nodes: [article], top: 0, opening: node.compaction ? t`前情` : t`开场` })
      } else {
        const round = rounds.at(-1)
        round.reply ||= bodyText(article)
        round.nodes.push(article)
      }
    }
    // An opening-less chat starts at round 1; renumber so numbers are consecutive.
    let n = rounds[0]?.opening ? 0 : 1
    for (const round of rounds) round.n = n++
    return rounds
  }

  /** Pictures drawn for a round's replies, read from the page so ones added later count too. */
  function imagesOf(round) {
    return round.nodes.flatMap(article => [...article.querySelectorAll('.reply-images img')]).filter(img => img.getAttribute('src'))
  }

  function label(round) {
    return round.n === 0 ? round.opening : t`第 ${round.n} 轮`
  }

  /** A quiet "第 n 轮" at the right of each of your messages, including the one being sent. */
  function tagRounds() {
    for (const round of state.rounds) {
      if (round.n === 0) continue
      addTag(round.nodes[0], round.n)
    }
    const pending = box.querySelector('.msg[data-id="pending-user"]')
    if (pending) addTag(pending, (state.rounds.at(-1)?.n ?? 0) + 1)
  }

  function addTag(article, n) {
    const head = article.querySelector('.msg-head')
    if (!head || head.querySelector('.round-tag')) return
    head.append(el('span', { class: 'round-tag', text: t`第 ${n} 轮` }))
  }

  const last = () => state.rounds.at(-1)?.n ?? 0
  const roundAt = n => state.rounds.find(r => r.n === n)

  // ─── Geometry ─────────────────────────────────────────────────────
  function measure() {
    for (const round of state.rounds) round.top = round.nodes[0].offsetTop
    state.height = box.scrollHeight
    state.stops = scale()
  }

  /** A point counted in rounds (2.5: halfway through the third one) as a page offset. */
  function offsetOf(at) {
    const { rounds } = state
    const i = Math.min(Math.max(Math.floor(at), 0), rounds.length - 1)
    const next = rounds[i + 1]?.top ?? state.height
    return rounds[i].top + Math.min(Math.max(at - i, 0), 1) * (next - rounds[i].top)
  }

  /** A page offset counted in rounds. */
  function roundsAt(offset) {
    const { rounds } = state
    let [lo, hi] = [0, rounds.length - 1]
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (rounds[mid].top <= offset) lo = mid
      else hi = mid - 1
    }
    const next = rounds[lo + 1]?.top ?? state.height
    return lo + Math.min(Math.max((offset - rounds[lo].top) / Math.max(next - rounds[lo].top, 1), 0), 1)
  }

  /**
   * All spread out, the rail is the page by height, as a scrollbar is. Folded, it goes by rounds: the
   * spread-out ones share most of it, the folded ones a band at each end, the band above as big as its
   * share of them, so the bands trade size as you go and the thumb only ever moves the way you scroll.
   */
  function scale() {
    const { rounds, win } = state
    if (!win) return [[0, 0], [state.height || 1, 1]]
    const { folded, bands } = bandsOf(rounds.length)
    const above = (bands * win.lo) / folded
    return [[0, 0], [win.lo, above], [win.lo + RECENT, 1 - bands + above], [rounds.length, 1]]
  }
  function bandsOf(n) {
    const folded = n - RECENT
    return { folded, bands: Math.min(0.3, 0.06 + folded * 0.002) }
  }

  /**
   * Folded, where the thumb's top is depends only on where the view's top is, the same way down
   * from start to end: this is the way back, the page offset for a thumb top, for dragging it.
   */
  function dragTo(fraction) {
    if (!state.win || fraction <= 0) return toPage(fraction)
    const n = state.rounds.length
    const { folded, bands } = bandsOf(n)
    const spread = 1 - bands
    const head = LEAD * spread
    if (fraction <= head) return offsetOf((fraction / spread) * RECENT)
    if (fraction >= head + bands) return offsetOf(n - RECENT + ((fraction - bands) / spread) * RECENT)
    return offsetOf(RECENT * LEAD + ((fraction - head) / bands) * folded)
  }

  /** Along the rail's scale, from page (offset or rounds) to rail (0–1), or back. */
  function along(value, back = false) {
    const [x, y] = back ? [1, 0] : [0, 1]
    const stops = state.stops
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]
      const b = stops[i]
      if (value > b[x] && i < stops.length - 1) continue
      if (b[x] <= a[x]) return b[y]
      return a[y] + ((Math.min(Math.max(value, a[x]), b[x]) - a[x]) / (b[x] - a[x])) * (b[y] - a[y])
    }
    return 0
  }
  /** Where a page offset sits on the rail (0–1), and where on the page a point of the rail is. */
  const toTrack = offset => along(state.win ? roundsAt(offset) : offset)
  const toPage = fraction => (fraction <= 0 ? 0 : state.win ? offsetOf(along(fraction, true)) : along(fraction, true))

  /**
   * Which rounds the rail spreads out: RECENT of them around the top of the view (where the thumb's top
   * is), moving with it as you scroll, so the ones above unfold as you come to them; at the end, the latest ones.
   * Says how far (in rounds) that moved.
   */
  function settleWindow() {
    const n = state.rounds.length
    const before = state.win?.lo ?? -1
    if (n < FOLD_FROM) state.win = null
    else {
      state.win = { lo: Math.min(Math.max(roundsAt(box.scrollTop) - RECENT * LEAD, 0), n - RECENT) }
    }
    state.stops = scale()
    return Math.abs((state.win?.lo ?? -1) - before)
  }

  /** The round under the reading line, a third of the way down the view. */
  function roundAtOffset(offset) {
    let found = state.rounds[0]
    for (const round of state.rounds) {
      if (round.top <= offset) found = round
      else break
    }
    return found
  }

  function readingRound() {
    if (!state.rounds.length) return null
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) return state.rounds.at(-1)
    return roundAtOffset(box.scrollTop + box.clientHeight * 0.33)
  }

  const scrollable = () => state.rounds.length >= 2 && box.scrollHeight > box.clientHeight * 1.5

  function layoutRail() {
    measure()
    rail.hidden = !scrollable()
    rail.parentElement.classList.toggle('railed', !rail.hidden)
    if (rail.hidden) return
    // Kept while the rounds are the same, so a tick glides when the rail unfolds.
    const key = state.rounds.map(round => round.n).join()
    if (ticks.dataset.key !== key) {
      ticks.dataset.key = key
      const decade = state.rounds.length > 24
      ticks.replaceChildren(...state.rounds.map(round => el('i', { class: `tick${decade && round.n % 10 === 0 ? ' decade' : ''}`, 'data-n': round.n })))
    }
    settleWindow()
    placeTicks()
    paintRail()
  }

  function placeTicks() {
    const n = state.rounds.length
    const lo = state.win?.lo ?? 0
    const hi = state.win ? lo + RECENT : n
    // In a band only every tenth round (or fiftieth, hundredth, as it fills) keeps a mark.
    const every = n <= 130 ? 10 : n <= 610 ? 50 : 100
    state.rounds.forEach((round, index) => {
      const tick = ticks.children[index]
      const folded = index < lo - 0.01 || index > hi + 0.01
      tick.style.top = `${(toTrack(round.top) * 100).toFixed(3)}%`
      tick.classList.toggle('folded', folded)
      tick.classList.toggle('mark', folded && round.n % every === 0)
    })
    const [head, tail] = folds
    const from = toTrack(offsetOf(lo)) * 100
    const to = state.win ? toTrack(offsetOf(hi)) * 100 : 100
    head.hidden = from < 0.5
    tail.hidden = to > 99.5
    head.style.cssText = `top:0;height:${from.toFixed(3)}%`
    tail.style.cssText = `top:${to.toFixed(3)}%;height:${(100 - to).toFixed(3)}%`
  }

  /** The rail unfolding or folding: ticks, bands and thumb glide to their new places for a moment. */
  function reflow() {
    if (reducedMotion.matches) return placeTicks()
    rail.classList.add('reflow')
    placeTicks()
    clearTimeout(state.reflowTimer)
    state.reflowTimer = setTimeout(() => rail.classList.remove('reflow'), REFLOW_MS)
  }

  function paintRail() {
    if (rail.hidden) return
    const top = toTrack(box.scrollTop) * 100
    const size = Math.max(toTrack(box.scrollTop + box.clientHeight) * 100 - top, 4)
    thumb.style.top = `${Math.min(top, 100 - size)}%`
    thumb.style.height = `${size}%`
    for (const tick of ticks.children) tick.classList.toggle('here', Number(tick.dataset.n) === state.current)
  }

  // ─── Scrolling ────────────────────────────────────────────────────
  let frame = 0
  function onScroll() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (box.scrollHeight !== state.height) layoutRail()
      const round = readingRound()
      state.current = round?.n ?? 0
      if (!rail.hidden) {
        // Gliding along as you scroll; a jump far away glides there (a drag keeps up with the finger).
        const moved = settleWindow()
        if (moved > 2 && !state.drag) reflow()
        else if (moved) placeTicks()
      }
      paintRail()
      paintWhere()
    })
    wake()
  }

  /** On touch screens the rail only takes touches for a moment after you scroll, like a fast scroller. */
  function wake() {
    rail.classList.add('awake')
    clearTimeout(state.awakeTimer)
    state.awakeTimer = setTimeout(() => { if (!state.drag) rail.classList.remove('awake') }, 1400)
  }

  function paintWhere() {
    const away = box.scrollHeight - box.scrollTop - box.clientHeight > box.clientHeight * 0.8
    const show = Boolean(getChat()) && away && state.rounds.length > 1 && panel.hidden
    if (show && where.hidden) {
      where.hidden = false
      where.classList.remove('enter')
      void where.offsetWidth
      where.classList.add('enter')
    } else if (!show) where.hidden = true
    $('where-round').textContent = state.current === 0 ? (state.rounds[0]?.opening ?? t`开场`) : t`第 ${state.current} 轮`
    $('where-total').textContent = `/ ${last()}`
  }

  function jumpTo(n, { terms = [] } = {}) {
    const round = roundAt(n)
    if (!round) return
    measure()
    const target = Math.max(0, round.top - 12)
    const far = Math.abs(target - box.scrollTop) > box.clientHeight * LONG_JUMP
    box.scrollTo({ top: target, behavior: far || reducedMotion.matches ? 'instant' : 'smooth' })
    const land = () => {
      // Messages out of view were laid out at a guessed height: where the round really is now.
      const off = round.nodes[0].offsetTop - 12 - box.scrollTop
      if (Math.abs(off) > 4) box.scrollTop += off
      for (const article of round.nodes) {
        article.classList.remove('found')
        void article.offsetWidth
        article.classList.add('found')
      }
      highlight(round, terms)
    }
    // Already there (the round is in view at the bottom): no scroll, so no scrollend to wait for.
    const there = Math.abs(Math.min(target, box.scrollHeight - box.clientHeight) - box.scrollTop) < 1
    box.removeEventListener('scrollend', pendingLand)
    clearTimeout(landTimer)
    if (there) land()
    else if (far || reducedMotion.matches || !('onscrollend' in box)) landTimer = setTimeout(land, far ? 0 : 380)
    else {
      // Only this jump's landing, once: a later jump or a scroll by hand doesn't bring an old one back.
      pendingLand = () => {
        clearTimeout(landTimer)
        box.removeEventListener('scrollend', pendingLand)
        land()
      }
      box.addEventListener('scrollend', pendingLand)
      landTimer = setTimeout(pendingLand, 1000)
    }
  }
  let pendingLand = null
  let landTimer = null

  /** Marks what you searched for inside the round you jumped to, for a few seconds. */
  function highlight(round, terms) {
    if (!globalThis.CSS?.highlights || !terms.length) return
    const ranges = []
    for (const article of round.nodes) {
      const body = article.querySelector('.msg-body')
      if (!body) continue
      const walker = readable(body)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.data.toLowerCase()
        for (const term of terms) {
          for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) {
            const range = new Range()
            range.setStart(node, at)
            range.setEnd(node, at + term.length)
            ranges.push(range)
          }
        }
      }
    }
    CSS.highlights.set('history-hit', new Highlight(...ranges))
    clearTimeout(state.hitTimer)
    state.hitTimer = setTimeout(clearHits, HIGHLIGHT_MS)
  }

  function clearHits() {
    globalThis.CSS?.highlights?.delete('history-hit')
    for (const tick of ticks.querySelectorAll('.hit')) tick.classList.remove('hit')
  }

  // ─── Rail: hover to peek, click a round, drag to scrub ────────────
  const trackFraction = y => {
    const rect = track.getBoundingClientRect()
    return Math.min(1, Math.max(0, (y - rect.top) / rect.height))
  }

  function showBubble(y, round) {
    if (!round) return hideBubble()
    const rect = track.getBoundingClientRect()
    bubble.hidden = false
    bubble.style.top = `${Math.min(Math.max(y - rect.top, 18), rect.height - 18)}px`
    bubble.querySelector('b').textContent = label(round)
    bubble.querySelector('span').textContent = round.n === 0 ? round.reply.slice(0, 80) : round.input.slice(0, 120)
    const [image] = imagesOf(round)
    const picture = bubble.querySelector('img')
    picture.hidden = !image
    bubble.classList.toggle('with-image', Boolean(image))
    if (image && picture.getAttribute('src') !== image.getAttribute('src')) picture.src = image.getAttribute('src')
  }
  const hideBubble = () => { bubble.hidden = true }

  rail.addEventListener('pointermove', event => {
    if (state.drag) return
    if (event.pointerType !== 'mouse') return
    measure()
    showBubble(event.clientY, roundAtOffset(toPage(trackFraction(event.clientY))))
  })
  rail.addEventListener('pointerleave', () => { if (!state.drag) hideBubble() })

  rail.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    measure()
    const onThumb = event.target === thumb
    const thumbTop = thumb.getBoundingClientRect().top
    state.drag = {
      id: event.pointerId,
      moved: false,
      onThumb,
      startY: event.clientY,
      grab: onThumb ? event.clientY - thumbTop : thumb.offsetHeight / 2,
    }
    rail.setPointerCapture(event.pointerId)
    rail.classList.add('dragging', 'awake')
    if (!onThumb && event.pointerType !== 'mouse') scrub(event.clientY)
  })

  function scrub(y) {
    const rect = track.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (y - state.drag.grab - rect.top) / rect.height))
    box.scrollTop = dragTo(fraction)
    const centre = box.scrollTop + box.clientHeight * 0.33
    showBubble(y, roundAtOffset(centre))
  }

  rail.addEventListener('pointermove', event => {
    const drag = state.drag
    if (!drag || drag.id !== event.pointerId) return
    if (!drag.moved && Math.abs(event.clientY - drag.startY) < 3) return
    drag.moved = true
    scrub(event.clientY)
  })

  const endDrag = event => {
    const drag = state.drag
    if (!drag || drag.id !== event.pointerId) return
    state.drag = null
    rail.classList.remove('dragging')
    // A click (no drag) on the track goes to the round under the pointer.
    // (Captured, the pointerup is the rail's: where it went down says whether it was the thumb.)
    if (!drag.moved && event.type === 'pointerup' && !drag.onThumb) {
      const round = roundAtOffset(toPage(trackFraction(event.clientY)))
      if (round) jumpTo(round.n)
    }
    if (event.pointerType !== 'mouse') hideBubble()
    wake()
  }
  rail.addEventListener('pointerup', endDrag)
  rail.addEventListener('pointercancel', endDrag)

  // ─── Panel: search, jump by number, browse by section ─────────────
  const isOpen = () => !panel.hidden

  function open() {
    if (!getChat() || !state.rounds.length) return
    panel.hidden = false
    panel.classList.remove('enter')
    void panel.offsetWidth
    panel.classList.add('enter')
    where.hidden = true
    $('history-open').setAttribute('aria-expanded', 'true')
    renderList({ keepActive: true })
    query.focus()
    query.select()
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen()) return
    panel.hidden = true
    $('history-open').setAttribute('aria-expanded', 'false')
    for (const tick of ticks.querySelectorAll('.hit')) tick.classList.remove('hit')
    paintWhere()
    if (restoreFocus) $('history-open').focus()
  }

  const toggle = () => (isOpen() ? close({ restoreFocus: true }) : open())

  function termsOf(text) {
    return [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))]
  }

  function matches(round, terms) {
    const hay = (state.scope === 'input' ? round.input : `${round.input}\n${round.reply}`).toLowerCase()
    return terms.every(term => hay.includes(term))
  }

  /** Text with every term wrapped in <mark>, trimmed to a window around the first hit. */
  function marked(text, terms, { around = 0 } = {}) {
    let source = text
    if (around && terms.length) {
      const lower = source.toLowerCase()
      const first = Math.min(...terms.map(term => lower.indexOf(term)).filter(i => i >= 0))
      if (Number.isFinite(first) && first > around) source = `…${source.slice(first - around)}`
    }
    if (!terms.length) return [document.createTextNode(source)]
    const lower = source.toLowerCase()
    const spans = []
    for (const term of terms) {
      for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) spans.push([at, at + term.length])
    }
    spans.sort((a, b) => a[0] - b[0])
    const parts = []
    let cursor = 0
    for (const [start, end] of spans) {
      if (start < cursor) continue
      if (start > cursor) parts.push(document.createTextNode(source.slice(cursor, start)))
      parts.push(el('mark', { text: source.slice(start, end) }))
      cursor = end
    }
    if (cursor < source.length) parts.push(document.createTextNode(source.slice(cursor)))
    return parts
  }

  function renderList({ keepActive = false } = {}) {
    const text = query.value.trim()
    const terms = termsOf(text)
    state.terms = terms
    const number = /^\d+$/.test(text) ? Number(text) : null
    const hits = terms.length ? state.rounds.filter(r => matches(r, terms)) : state.rounds
    const rows = []
    if (number !== null && roundAt(number)) rows.push({ round: roundAt(number), jump: true })
    for (const round of hits) if (!(number !== null && round.n === number && rows.length)) rows.push({ round })
    state.shown = rows

    count.textContent = !terms.length
      ? t`共 ${last()} 轮`
      : number !== null && rows[0]?.jump
        ? t`回车跳到第 ${number} 轮`
        : hits.length ? t`${hits.length} 轮提到` : t`没有找到，换个词试试`

    const hitSet = new Set(hits.map(r => r.n))
    for (const tick of ticks.children) tick.classList.toggle('hit', terms.length > 0 && hitSet.has(Number(tick.dataset.n)))

    list.replaceChildren(
      ...rows.map((row, index) => {
        const { round } = row
        const showInput = round.n !== 0
        const replyHit = terms.length && !terms.every(term => round.input.toLowerCase().includes(term))
        const images = imagesOf(round)
        return el('li', {
          class: `hrow${round.n === state.current ? ' here' : ''}${row.jump ? ' jump' : ''}${images.length ? ' has-thumb' : ''}`,
          role: 'option',
          id: `hrow-${index}`,
          'data-index': index,
          'aria-selected': 'false',
        }, [
          el('span', { class: `hrow-n${round.n === 0 ? ' word' : ''}`, text: round.n === 0 ? round.opening : String(round.n) }),
          el('div', { class: 'hrow-text' }, [
            row.jump ? el('p', { class: 'hrow-kicker', text: t`跳到第 ${round.n} 轮` }) : null,
            showInput ? el('p', { class: 'hrow-in' }, marked(round.input || t`（空）`, terms)) : null,
            el('p', { class: `hrow-out${replyHit || !showInput ? ' open' : ''}` }, marked(round.reply || t`（还没有回复）`, state.scope === 'all' ? terms : [], { around: replyHit ? 18 : 0 })),
          ]),
          images.length
            ? el('span', { class: 'hrow-thumb', title: images.length > 1 ? t`这一轮配了 ${images.length} 张图` : t`这一轮配的图` }, [
                el('img', { src: images[0].getAttribute('src'), alt: '', loading: 'lazy', decoding: 'async' }),
                images.length > 1 ? el('b', { text: `${images.length}` }) : null,
              ])
            : null,
        ])
      }),
    )
    renderPages(terms.length > 0)

    let active = 0
    if (keepActive && !terms.length) active = Math.max(0, rows.findIndex(r => r.round.n === state.current))
    setActive(rows.length ? active : -1, { center: true })
  }

  function renderPages(searching) {
    const total = state.rounds.length
    if (searching || total <= 30) { pages.hidden = true; return }
    pages.hidden = false
    const size = total <= 200 ? 20 : 50
    const chips = []
    for (let from = 1; from <= last(); from += size) {
      const to = Math.min(from + size - 1, last())
      const holds = state.current >= (from === 1 ? 0 : from) && state.current <= to
      chips.push(el('button', {
        type: 'button',
        class: `page${holds ? ' on' : ''}`,
        text: `${from}–${to}`,
        onclick: () => {
          const index = from === 1 ? 0 : state.shown.findIndex(r => r.round.n >= from)
          setActive(index, { top: true })
          query.focus()
        },
      }))
    }
    pages.replaceChildren(...chips)
  }

  function setActive(index, { center = false, top = false } = {}) {
    const rows = list.children
    if (state.active >= 0 && rows[state.active]) rows[state.active].setAttribute('aria-selected', 'false')
    state.active = index
    if (index < 0 || !rows[index]) { query.removeAttribute('aria-activedescendant'); return }
    const row = rows[index]
    row.setAttribute('aria-selected', 'true')
    query.setAttribute('aria-activedescendant', row.id)
    if (top) list.scrollTop = row.offsetTop - list.offsetTop - 4
    else if (center) list.scrollTop = row.offsetTop - list.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2
    else row.scrollIntoView({ block: 'nearest' })
  }

  function choose(index) {
    const row = state.shown[index]
    if (!row) return
    const terms = row.jump ? [] : state.terms
    close()
    jumpTo(row.round.n, { terms })
    if (terms.length) {
      // Keep the rail's search marks while the highlights last.
      const hitSet = new Set(state.shown.filter(r => !r.jump).map(r => r.round.n))
      for (const tick of ticks.children) tick.classList.toggle('hit', hitSet.has(Number(tick.dataset.n)))
    }
  }

  query.addEventListener('input', () => renderList())
  query.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(Math.min(state.shown.length - 1, Math.max(0, state.active + step)))
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault()
      const step = (event.key === 'PageDown' ? 1 : -1) * 8
      setActive(Math.min(state.shown.length - 1, Math.max(0, state.active + step)))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(state.active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (query.value) { query.value = ''; renderList({ keepActive: true }) } else close({ restoreFocus: true })
    }
  })
  list.addEventListener('click', event => {
    const row = event.target.closest('.hrow')
    if (row) choose(Number(row.dataset.index))
  })
  list.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return
    const row = event.target.closest('.hrow')
    if (row && Number(row.dataset.index) !== state.active) setActive(Number(row.dataset.index))
  })
  panel.querySelector('.seg').addEventListener('click', event => {
    const button = event.target.closest('button[data-scope]')
    if (!button) return
    state.scope = button.dataset.scope
    for (const b of panel.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b === button))
    renderList()
    query.focus()
  })
  $('history-close').addEventListener('click', () => close({ restoreFocus: true }))
  $('history-open').addEventListener('click', toggle)
  $('where-open').addEventListener('click', open)
  $('where-latest').addEventListener('click', () => {
    const far = box.scrollHeight - box.scrollTop > box.clientHeight * LONG_JUMP
    box.scrollTo({ top: box.scrollHeight, behavior: far || reducedMotion.matches ? 'instant' : 'smooth' })
  })
  // A press anywhere outside the panel closes it.
  document.addEventListener('pointerdown', event => {
    if (isOpen() && !panel.contains(event.target) && !event.target.closest('#history-open, #where-open')) close()
  })
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      if (!getChat()) return
      event.preventDefault()
      toggle()
    }
  })

  box.addEventListener('scroll', onScroll, { passive: true })
  new ResizeObserver(() => {
    layoutRail()
    paintWhere()
  }).observe(box)
  finePointer.addEventListener?.('change', () => layoutRail())

  /** After the transcript is redrawn. */
  function refresh() {
    const chat = getChat()
    state.rounds = chat ? collect(chat) : []
    $('history-open').hidden = !chat || state.rounds.length < 2
    tagRounds()
    layoutRail()
    state.current = readingRound()?.n ?? 0
    paintRail()
    if (!chat || !state.rounds.length) close()
    else if (isOpen()) renderList({ keepActive: true })
    paintWhere()
  }

  return { refresh, open, close }
}
