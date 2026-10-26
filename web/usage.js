// Usage dashboard: stat tiles, per-turn prompt composition (stacked columns),
// cache hit rate and subscription quota over time (lines), per-model and
// per-chat tables. Hand-written SVG, one y-axis per chart, hover on every mark.
import { locale, t } from '/i18n.js'

const SVG = 'http://www.w3.org/2000/svg'
const SERIES = {
  cacheRead: { label: t`缓存读取`, color: 'var(--series-1)' },
  cacheWrite: { label: t`缓存写入`, color: 'var(--series-2)' },
  input: { label: t`未缓存输入`, color: 'var(--series-3)' },
}

// ─── helpers ────────────────────────────────────────────────────────────
function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'style') node.style.cssText = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function s(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v)
  return node
}

export function compact(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`
  return v.toLocaleString(locale)
}
const full = n => (Number(n) || 0).toLocaleString(locale)
const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`)
const money = v => (v >= 1 ? `$${v.toFixed(2)}` : `$${(v ?? 0).toFixed(3)}`)
const clock = ms => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
const stamp = ms => new Date(ms).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Clean axis maximum and ticks: 1/2/5 × 10^k steps. */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] }
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw)
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v)
  return { max: top, ticks }
}

/** Column with a 4px rounded data end, square at the baseline. */
function columnPath(x, y, w, height, round) {
  if (height <= 0) return ''
  const r = round ? Math.min(4, w / 2, height) : 0
  return `M${x},${y + height}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + height}Z`
}

function tooltip(card) {
  const tip = h('div', { class: 'viz-tip', hidden: true })
  card.append(tip)
  return {
    show(rows, clientX, clientY) {
      tip.replaceChildren(...rows)
      tip.hidden = false
      const box = card.getBoundingClientRect()
      const x = clientX - box.left
      const y = clientY - box.top
      const width = tip.offsetWidth
      tip.style.left = `${Math.min(Math.max(8, x + 14), box.width - width - 8)}px`
      tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`
    },
    hide() {
      tip.hidden = true
    },
  }
}

const tipRow = (label, value, color) => h('div', { class: 'row' }, [h('span', {}, [color ? h('i', { style: `background:${color}` }) : null, label]), h('b', { text: value })])

// ─── charts ─────────────────────────────────────────────────────────────
function stackedTurns(turns) {
  const card = h('div', { class: 'chart-card' }, [
    h('div', { class: 'chart-title', text: t`每轮输入构成` }),
    h('div', { class: 'chart-sub', text: t`最近 ${turns.length} 轮。缓存读取越多，这一轮越快、越省额度。` }),
    h('div', { class: 'legend' }, Object.values(SERIES).map(sr => h('span', {}, [h('i', { style: `background:${sr.color}` }), sr.label]))),
  ])
  if (!turns.length) {
    card.append(h('div', { class: 'empty-chart', text: t`这个时间段还没有生成记录` }))
    return card
  }
  const W = 960, H = 220, L = 52, R = 10, T = 8, B = 24
  const plotW = W - L - R, plotH = H - T - B
  const totals = turns.map(turn => turn.cacheRead + turn.cacheWrite + turn.input)
  const { max, ticks } = niceTicks(Math.max(...totals))
  const y = v => T + plotH - (v / max) * plotH
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t`每轮输入 token 构成的堆叠柱状图` })
  for (const tick of ticks) {
    svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(tick), y2: y(tick) }))
    const label = s('text', { x: L - 6, y: y(tick) + 4, 'text-anchor': 'end' })
    label.textContent = compact(tick)
    svg.append(label)
  }
  const band = plotW / turns.length
  const barW = Math.max(3, Math.min(24, band * 0.62))
  const tip = tooltip(card)
  const labelEvery = Math.max(1, Math.ceil(turns.length / 8))
  turns.forEach((turn, i) => {
    const x = L + i * band + (band - barW) / 2
    let base = 0
    const parts = ['cacheRead', 'cacheWrite', 'input'].filter(k => turn[k] > 0)
    parts.forEach((key, index) => {
      const top = base + turn[key]
      const yTop = y(top)
      // 2px surface gap between stacked segments: trim the segment's lower edge.
      const gap = index > 0 ? 2 : 0
      const height = y(base) - yTop - gap
      if (height > 0) svg.append(s('path', { d: columnPath(x, yTop, barW, height, index === parts.length - 1), fill: SERIES[key].color }))
      base = top
    })
    if (i % labelEvery === 0 || i === turns.length - 1) {
      const label = s('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle' })
      label.textContent = clock(turn.at)
      svg.append(label)
    }
    const hit = s('rect', { class: 'hit', x: L + i * band, y: T, width: band, height: plotH })
    hit.addEventListener('mousemove', event =>
      tip.show([
        h('div', { text: `${stamp(turn.at)} · ${turn.chatTitle ?? ''}`.slice(0, 60) }),
        h('div', { class: 'row', style: 'color:var(--muted)' }, [h('span', { text: turn.modelLabel ?? turn.model ?? '' }), h('span', { text: turn.forked ? t`分支` : t`续接` })]),
        tipRow(t`缓存读取`, full(turn.cacheRead), SERIES.cacheRead.color),
        tipRow(t`缓存写入`, full(turn.cacheWrite), SERIES.cacheWrite.color),
        tipRow(t`未缓存输入`, full(turn.input), SERIES.input.color),
        tipRow(t`输出`, full(turn.output)),
        tipRow(t`缓存命中`, pct(turn.hit)),
        tipRow(t`首字`, turn.firstTokenMs ? t`${(turn.firstTokenMs / 1000).toFixed(1)} 秒` : '—'),
        tipRow(t`等价成本`, money(turn.cost)),
      ], event.clientX, event.clientY),
    )
    hit.addEventListener('mouseleave', () => tip.hide())
    svg.append(hit)
  })
  card.append(svg)
  card.append(turnTable(turns))
  return card
}

/**
 * Line chart on one 0–100% axis. `series` = [{ key, label, color, points: [{ x, y }] }];
 * x is a timestamp or an index (with `xLabel` to format it).
 */
function percentLines({ title, sub, series, xLabel, ariaLabel }) {
  const visible = series.filter(sr => sr.points.length)
  const card = h('div', { class: 'chart-card' }, [h('div', { class: 'chart-title', text: title }), h('div', { class: 'chart-sub', text: sub })])
  if (visible.length > 1) card.append(h('div', { class: 'legend' }, visible.map(sr => h('span', {}, [h('i', { class: 'line', style: `background:${sr.color}` }), sr.label]))))
  if (!visible.length) {
    card.append(h('div', { class: 'empty-chart', text: t`这个时间段还没有数据` }))
    return card
  }
  const W = 960, H = 180, L = 52, R = visible.length > 1 ? 70 : 16, T = 10, B = 24
  const plotW = W - L - R, plotH = H - T - B
  const xs = visible.flatMap(sr => sr.points.map(p => p.x))
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const x = v => (x1 === x0 ? L + plotW / 2 : L + ((v - x0) / (x1 - x0)) * plotW)
  const y = v => T + plotH - v * plotH
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel })
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: L, x2: L + plotW, y1: y(tick), y2: y(tick) }))
    const label = s('text', { x: L - 6, y: y(tick) + 4, 'text-anchor': 'end' })
    label.textContent = `${tick * 100}%`
    svg.append(label)
  }
  for (const [value, anchor] of [[x0, 'start'], [x1, 'end']]) {
    const label = s('text', { x: x(value), y: H - 6, 'text-anchor': anchor })
    label.textContent = xLabel(value)
    svg.append(label)
  }
  for (const sr of visible) {
    const d = sr.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join('')
    svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }))
    const last = sr.points.at(-1)
    svg.append(s('circle', { cx: x(last.x), cy: y(last.y), r: 4, fill: sr.color, stroke: 'var(--bg)', 'stroke-width': 2 }))
    if (visible.length > 1) {
      const label = s('text', { x: x(last.x) + 8, y: y(last.y) + 4 })
      label.textContent = `${sr.label} ${pct(last.y)}`
      svg.append(label)
    }
  }
  const cross = s('line', { class: 'crosshair', y1: T, y2: T + plotH, visibility: 'hidden' })
  const dots = visible.map(sr => s('circle', { r: 4, fill: sr.color, stroke: 'var(--bg)', 'stroke-width': 2, visibility: 'hidden' }))
  svg.append(cross, ...dots)
  const tip = tooltip(card)
  const overlay = s('rect', { class: 'hit', x: L, y: T, width: plotW, height: plotH })
  overlay.addEventListener('mousemove', event => {
    const box = svg.getBoundingClientRect()
    const vx = x0 + ((((event.clientX - box.left) / box.width) * W - L) / plotW) * (x1 - x0)
    const rows = []
    let anchorX = null
    visible.forEach((sr, i) => {
      const nearest = sr.points.reduce((best, p) => (Math.abs(p.x - vx) < Math.abs(best.x - vx) ? p : best), sr.points[0])
      anchorX ??= nearest.x
      dots[i].setAttribute('cx', x(nearest.x))
      dots[i].setAttribute('cy', y(nearest.y))
      dots[i].setAttribute('visibility', 'visible')
      rows.push(tipRow(sr.label, pct(nearest.y), sr.color))
    })
    cross.setAttribute('x1', x(anchorX))
    cross.setAttribute('x2', x(anchorX))
    cross.setAttribute('visibility', 'visible')
    tip.show([h('div', { text: xLabel(anchorX, true) }), ...rows], event.clientX, event.clientY)
  })
  overlay.addEventListener('mouseleave', () => {
    tip.hide()
    cross.setAttribute('visibility', 'hidden')
    for (const dot of dots) dot.setAttribute('visibility', 'hidden')
  })
  svg.append(overlay)
  card.append(svg)
  return card
}

// ─── tables & tiles ─────────────────────────────────────────────────────
function table(headers, rows) {
  return h('table', { class: 'usage-table' }, [
    h('thead', {}, h('tr', {}, headers.map(text => h('th', { text })))),
    h('tbody', {}, rows.map(cells => h('tr', {}, cells.map((text, i) => h('td', { text: String(text), 'data-label': headers[i] }))))),
  ])
}

const SUM_HEADERS = [t`轮数`, t`未缓存输入`, t`缓存读取`, t`缓存写入`, t`输出`, t`命中率`, t`等价成本`]
const sumCells = r => [r.turns, compact(r.input), compact(r.cacheRead), compact(r.cacheWrite), compact(r.output), pct(r.hit), money(r.cost)]

function turnTable(turns) {
  return h('details', { class: 'turn-table' }, [
    h('summary', { text: t`查看每轮数据表` }),
    table([t`时间`, t`对话`, t`模型`, t`缓存读取`, t`缓存写入`, t`未缓存输入`, t`输出`, t`命中率`, t`首字`], [...turns].reverse().map(turn => [
      stamp(turn.at), (turn.chatTitle ?? '').slice(0, 24), turn.modelLabel ?? turn.model ?? '', full(turn.cacheRead), full(turn.cacheWrite), full(turn.input), full(turn.output), pct(turn.hit),
      turn.firstTokenMs ? `${(turn.firstTokenMs / 1000).toFixed(1)}s` : '—',
    ])),
  ])
}

function tile(label, value, sub, meter) {
  const children = [h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: value })]
  if (meter !== undefined && meter !== null) {
    children.push(h('div', { class: `meter ${meter >= 0.9 ? 'bad' : meter >= 0.7 ? 'warn' : ''}`, role: 'meter', 'aria-valuenow': Math.round(meter * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${Math.min(100, meter * 100)}%` })))
  }
  if (sub) children.push(h('div', { class: 'tile-sub', text: sub }))
  return h('div', { class: 'tile' }, children)
}

function quotaTile(label, value, resetsAt) {
  if (typeof value !== 'number') return tile(label, '—', t`生成一轮后更新`)
  const status = value >= 0.9 ? t`⛔ 接近上限` : value >= 0.7 ? t`⚠ 偏高` : ''
  const reset = resetsAt ? t`${new Date(resetsAt * (resetsAt < 1e12 ? 1000 : 1)).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置` : ''
  return tile(label, pct(value), [status, reset].filter(Boolean).join(' · '), value)
}

/**
 * Render the dashboard into `root`.
 * @param data - /api/usage response.
 * @param rateLimit - the latest rate-limit info from /api/status (for reset times).
 * @param labelOf - model id → display label.
 */
/** @param subscription - false in the Android app: no quota tiles or quota chart. */
export function renderUsage(root, data, rateLimit, labelOf, { subscription = true } = {}) {
  const turns = data.turns.map(turn => ({ ...turn, modelLabel: labelOf(turn.model) }))
  // The turns the hit-rate chart draws (those that reported usage): its x is a place in this list.
  const hitTurns = turns.filter(turn => turn.hit !== null)
  const today = data.today
  const windows = rateLimit?.unifiedWindows ?? {}
  const five = windows.five_hour?.utilization ?? data.latestRate?.five
  const seven = windows.seven_day?.utilization ?? data.latestRate?.seven
  const period = data.period
  // filter: sections left out (null) must not become the text "null".
  root.replaceChildren(...[
    h('div', { class: 'tiles' }, [
      tile(t`今日 token`, compact(today.input + today.cacheRead + today.cacheWrite + today.output), t`${today.turns} 轮 · 输出 ${compact(today.output)}`),
      tile(t`今日缓存命中率`, pct(today.hit), t`缓存读取 ${compact(today.cacheRead)}`),
      tile(t`今日等价成本`, money(today.cost), subscription ? t`按 API 单价估算，订阅不按此计费` : t`按 Anthropic API 公开单价估算，实际以供应商账单为准`),
      tile(t`首字中位数（${data.days} 天）`, period.medianFirstTokenMs ? t`${(period.medianFirstTokenMs / 1000).toFixed(1)} 秒` : '—', t`${period.turns} 轮 · 命中 ${pct(period.hit)}`),
      subscription ? quotaTile(t`5 小时额度`, five, windows.five_hour?.resetsAt) : null,
      subscription ? quotaTile(t`7 天额度`, seven, windows.seven_day?.resetsAt) : null,
    ]),
    stackedTurns(turns),
    percentLines({
      title: t`缓存命中率`,
      sub: t`每轮的缓存读取占输入的比例。换模型、改前缀或隔太久（缓存过期）会让它掉下来。`,
      series: [{ key: 'hit', label: t`命中率`, color: 'var(--series-1)', points: hitTurns.map((turn, i) => ({ x: i, y: turn.hit, at: turn.at })) }],
      xLabel: (i, long) => (hitTurns[Math.round(i)] ? (long ? stamp(hitTurns[Math.round(i)].at) : clock(hitTurns[Math.round(i)].at)) : ''),
      ariaLabel: t`每轮缓存命中率折线图`,
    }),
    !subscription ? null : percentLines({
      title: t`订阅额度使用率`,
      sub: t`来自 Claude 订阅的额度事件；每次生成后记录一次。`,
      series: [
        { key: 'five', label: t`5 小时`, color: 'var(--series-1)', points: data.rate.filter(r => typeof r.five === 'number').map(r => ({ x: r.at, y: r.five })) },
        { key: 'seven', label: t`7 天`, color: 'var(--series-2)', points: data.rate.filter(r => typeof r.seven === 'number').map(r => ({ x: r.at, y: r.seven })) },
      ],
      xLabel: (at, long) => (long ? stamp(at) : new Date(at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit' })),
      ariaLabel: t`订阅额度使用率随时间变化的折线图`,
    }),
    h('div', { class: 'usage-tables' }, [
      h('div', { class: 'chart-card' }, [h('div', { class: 'chart-title', text: t`按模型` }), table([t`模型`, ...SUM_HEADERS], data.byModel.map(r => [labelOf(r.model), ...sumCells(r)]))]),
      h('div', { class: 'chart-card' }, [h('div', { class: 'chart-title', text: t`按对话（等价成本前 12）` }), table([t`对话`, ...SUM_HEADERS], data.byChat.map(r => [`${r.title}${r.deleted ? t`（已删除）` : ''}`, ...sumCells(r)]))]),
    ]),
    h('div', { class: 'usage-note', text: t`等价成本按 Anthropic API 公开单价估算（缓存写入按 5 分钟 / 1 小时两档计价），仅用于比较${subscription ? t`；订阅额度的实际消耗以上面的额度使用率为准` : ''}。` }),
  ].filter(Boolean))
}
