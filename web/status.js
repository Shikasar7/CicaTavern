// What the page draws around a reply on its own, in the app's look (no card
// HTML, no frames): the built-in preset's time box and choices, and the status
// bar (web/shared/status.js decides what goes in it).
import { t } from '/i18n.js'
import { onPage, paletteColors, phoneApps, sameName, scopedSkinCss, skinClass, skyOf, statusGroups, statusPages } from '/shared/status.js'

const COLLAPSED = 'statusBarCollapsed'

function recalled(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows: it just opens again next time.
  }
}

/**
 * 收起 and 展开 carried over softly, for a look that asks for it with `--fold-ms` (a number of milliseconds; the
 * theme 文艺杂志 does): `foldFrom` before the class changes, `foldTo` after. Nothing moves when motion is turned
 * down on the system or for cards (主题 → 卡片动效).
 */
function foldFrom(box) {
  const ms = parseFloat(getComputedStyle(box).getPropertyValue('--fold-ms'))
  if (!(ms > 0) || typeof box.animate !== 'function' || document.documentElement.dataset.cardMotion === 'off') return null
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null
  return { ms, height: box.getBoundingClientRect().height }
}

function foldTo(box, from) {
  if (!from) return
  const height = box.getBoundingClientRect().height
  if (Math.abs(height - from.height) < 2) return
  const easing = 'cubic-bezier(.22, .61, .36, 1)'
  box.style.overflow = 'hidden'
  const grow = box.animate([{ height: `${from.height}px` }, { height: `${height}px` }], { duration: from.ms, easing })
  // Opening, what comes back fades in under the head as the bar grows.
  if (height > from.height) for (const part of box.children) if (!part.matches('.status-head, .drift')) part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: from.ms, easing })
  grow.finished.catch(() => {}).finally(() => box.style.removeProperty('overflow'))
}

/** A card's own colors over the bar's (and over its 开场页, web/cover.js). */
export function paint(box, colors) {
  const names = { surface: '--surface', ink: '--ink', accent: '--accent', muted: '--muted', faint: '--faint', line: '--line-soft', track: '--meter-track', soft: '--accent-soft', ok: '--ok', bad: '--bad' }
  for (const [key, name] of Object.entries(names)) box.style.setProperty(name, colors[key])
}

// 定制外观: a sheet for each look on the page, loaded once and shared by every bar that wears it.
const skinSheets = new Map()

// 外观的图 (web/shared/status.js LOOK_TOKEN): only the card's own, each a file of its look (or, in SillyTavern, set in
// the frame's own styles instead).
const LOOK_VAR = /^--pic-(?:avatar|cover|scene-[0-9a-f]{6}|sprite-[\w-]{1,40}|decor-(?:texture|corner|divider|emblem))$/
const LOOK_SRC = /^\/api\/look\/[\w-]+\/[\w-]+\.(?:png|jpg|webp)(?:\?v=\w+)?$/

/**
 * Dress a bar (or the card's 开场页, web/cover.js) in the card's own look: its rules reach only what wears this class.
 * @param pictures - { '--pic-…': address } the card's pictures the look may name (art.lookPictures)
 */
export function wear(box, skin, pictures = null) {
  for (const [token, src] of Object.entries(pictures ?? {})) if (LOOK_VAR.test(token) && LOOK_SRC.test(src)) box.style.setProperty(token, `url("${src}")`)
  const scope = skinClass(skin.css)
  // Worn over a theme, the same rules weigh more (a sheet of their own: the same look may be worn from nothing too).
  const over = Boolean(skin.base)
  const key = over ? `${scope}+` : scope
  if (!skinSheets.get(key)?.isConnected) {
    const sheet = document.createElement('style')
    sheet.dataset.skin = key
    sheet.textContent = scopedSkinCss(skin.css, scope, over)
    document.head.append(sheet)
    skinSheets.set(key, sheet)
  }
  box.classList.add('skinned', scope)
}

// 动效: what drifts over a bar, or over a card's 开场页 (rain, snow, petals…). Each piece gets its place and pace from
// where it stands in the row, so the same layer drawn again looks the same.
const FX_PIECES = { rain: 26, snow: 18, petals: 12, embers: 14, fireflies: 10, stars: 22, dust: 16 }

/** Whether this device has 卡片动效 turned off (主题 → 卡片动效): then nothing drifts, comes in or fills. */
export const motionOff = () => globalThis.document?.documentElement?.dataset?.cardMotion === 'off'

// A bar out of sight has its drifting layer stopped (.offstage); one taken off the page is let go of.
const barWatch = globalThis.IntersectionObserver ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    entry.target.classList.toggle('offstage', !entry.isIntersecting)
    if (!entry.target.isConnected) barWatch.unobserve(entry.target)
  }
}) : null

/** The layer for one kind of effect, or null. `scale`: more or fewer pieces (a page is larger than a bar). */
export function effectLayer(el, kind, scale = 1) {
  const count = motionOff() ? 0 : Math.round((FX_PIECES[kind] ?? 0) * scale)
  if (!count) return null
  const part = (i, step) => (i * step) % 1
  return el('div', { class: `drift drift-${kind}`, 'aria-hidden': 'true' }, Array.from({ length: count }, (_, i) => {
    const [a, b, c] = [part(i + 1, 0.618034), part(i + 1, 0.754878), part(i + 1, 0.56984)]
    return el('i', { style: `--x:${(a * 100).toFixed(1)}%;--y:${(b * 100).toFixed(1)}%;--d:${(c * -14).toFixed(2)}s;--s:${(0.6 + b * 0.8).toFixed(2)};--t:${(0.75 + c * 0.6).toFixed(2)}` })
  }))
}

/**
 * What a 版式 does with the bar's 顶上放立绘, 顶上放场景图 and 小手机 (statusBar below), for the editors to say beside
 * those boxes: { portrait, scene, phone }, each a line or ''. `off`: the ones it leaves without any effect.
 */
export function layoutTakes(layout) {
  if (!layout) return { portrait: '', scene: '', phone: '', off: [] }
  return {
    portrait: t`用了版式时，立绘放在第一个人的名字旁边，不在顶上。`,
    scene: layout === 'scroll' ? '' : t`卡片式和侧栏式不放场景图，只在标题旁写地名；要图就换卷轴式或简洁。`,
    phone: t`用了版式时，版式自己的页签代替小手机；改回「简洁」才有小手机。`,
    off: ['phone'],
  }
}

/**
 * 立绘 and 场景图 on top of a bar. The pictures are the app's own (角色名册的立绘和表情、视觉小说的场景), found by
 * whoever draws the bar: `art` is { portrait, zoom (a whole figure: show its upper half), scene, name, mood, place }.
 * It also says what the rest of the bar may draw from (each only where the card has it):
 *   face(name, words) → { src, zoom } or null: someone's picture (words: what their row says, for one who changes 形态);
 *   map: the picture of the card's map; types: { beats: { type: [beaten] }, of(name) → type };
 *   chain(name) → [{ name, stage, need }] or null: a companion's 形态, in order.
 */
function artBlock(el, art) {
  if (!art?.portrait && !art?.scene) return null
  const words = [
    art.name ? el('b', { class: 'status-art-name', text: art.name }) : null,
    art.mood ? el('span', { class: 'status-art-mood', text: art.mood }) : null,
  ]
  return el('div', { class: `status-art${art.scene ? ' has-scene' : ''}${art.portrait ? ' has-portrait' : ''}` }, [
    // With no scene to stand in front of, the portrait itself, out of focus, is what is behind it.
    art.scene ? el('img', { class: 'status-scene', src: art.scene, alt: '', draggable: 'false' }) : el('img', { class: 'status-scene soft', src: art.portrait, alt: '', draggable: 'false' }),
    el('span', { class: 'status-art-veil' }),
    art.portrait ? el('span', { class: `status-portrait${art.zoom ? ' zoom' : ''}` }, el('img', { src: art.portrait, alt: '', draggable: 'false' })) : null,
    words.some(Boolean) ? el('span', { class: 'status-art-words' }, words) : null,
    art.place ? el('span', { class: 'status-art-place', text: art.place }) : null,
  ])
}

/** A small round picture of someone, or null when the card has none of them. */
function faceOf(el, art, name, size, words) {
  const face = name && art?.face ? art.face(name, words ?? []) : null
  return face ? el('span', { class: `status-face ${size}${face.zoom ? ' zoom' : ''}` }, el('img', { src: face.src, alt: '', draggable: 'false', loading: 'lazy' })) : null
}

// 小手机: what the bar keeps off its face (web/shared/status.js phoneApps) is a row of icons under it; one opens as the
// screen of a small phone standing in the bar. An icon is picked by what the app is called.
const ICON = body => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const APP_ICONS = [
  [/传闻|流言|风声|见闻|rumou?rs?|gossip/i, '<path d="M4 6h16v10H10l-4 3.5V16H4z"/><path d="M8 10h8M8 13h5"/>'],
  [/武学|武功|功法|招式|法术|心法|martial|spells?|arts/i, '<path d="M5 19 17.5 6.5c1-1 2.2-1.5 3.5-1.5 0 1.3-.5 2.5-1.5 3.5L7 21"/><path d="m4 16 4 4M3.5 20.5l2-2"/>'],
  [/^(状态|概览|总览|主页|首页|近况|自己|status|overview|home|me)$/i, '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.600 3.400-5.500 7-5.500s6.200 1.900 7 5.500"/>'],
  [/背包|行囊|物品|道具|随身|库存|仓库|inventory|bag|items?/i, '<path d="M6 8h12l1.2 11.5a1 1 0 0 1-1 1.1H5.8a1 1 0 0 1-1-1.1z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'],
  [/任务|委托|待办|目标|约定|quests?|tasks?|todo|promises/i, '<path d="M10 6h9M10 12h9M10 18h9"/><path d="m4 6 1.2 1.2L7.5 5M4 12l1.2 1.200L7.500 11M4 18l1.200 1.200L7.500 17"/>'],
  [/情报|线索|消息|档案|笔记|记录|日志|日记|事件|clues?|intel|notes?|log|journal|events?/i, '<path d="M6 3.5h9l3.5 3.5V20a.5.5 0 0 1-.5.500H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14.5 3.5v4h4M8.500 12h7M8.500 16h5"/>'],
  [/关系|人物|好友|通讯|联系人|同伴|队伍|名册|relations?|contacts|party|friends|bonds?|cast/i, '<circle cx="9" cy="8.500" r="3"/><path d="M3.500 19.500c.6-3.200 2.700-5 5.500-5s4.900 1.800 5.500 5"/><circle cx="17" cy="9.500" r="2.300"/><path d="M16.500 14.600c2.200.2 3.600 1.700 4 4.400"/>'],
  [/地图|地点|去过|到过|足迹|map|places/i, '<path d="M12 21s6.500-6 6.500-11a6.500 6.500 0 0 0-13 0c0 5 6.500 11 6.500 11z"/><circle cx="12" cy="10" r="2.400"/>'],
  [/技能|能力|属性|数值|面板|stats?|skills?|abilities/i, '<path d="M5 20v-9M12 20V4M19 20v-6"/>'],
  [/金钱|钱包|账|商店|店铺|wallet|shop|money|ledger/i, '<circle cx="12" cy="12" r="8"/><path d="M12 7v10M14.500 9.500c-.5-.8-1.400-1.200-2.500-1.200-1.400 0-2.500.7-2.500 1.800 0 2.600 5.200 1.200 5.200 3.800 0 1.100-1.200 1.800-2.700 1.800-1.200 0-2.200-.5-2.700-1.300"/>'],
]
const GRID_ICON = '<rect x="4.500" y="4.500" width="6" height="6" rx="1.500"/><rect x="13.500" y="4.500" width="6" height="6" rx="1.500"/><rect x="4.500" y="13.500" width="6" height="6" rx="1.500"/><rect x="13.500" y="13.500" width="6" height="6" rx="1.500"/>'
const appIcon = name => ICON(APP_ICONS.find(([names]) => names.test(name))?.[1] ?? GRID_ICON)

/** How many things an app holds (lines, rows), and whether this reply changed any of them. */
function appNews(groups) {
  const rows = groups.flatMap(group => group.rows)
  const count = rows.reduce((sum, row) => sum + (row.items?.length ?? 0) + (row.table?.rows.length ?? 0) + (row.spots?.length ?? 0), 0)
  const changed = groups.some(group => group.changed) || rows.some(row => row.changed || row.added?.length || row.table?.rows.some(line => line.changed))
  return { count, changed }
}

/** Whether an app has nothing in it yet (lists and tables with no line, a paragraph with no word): then it has no icon. */
const appEmpty = groups => groups.every(group => group.rows.every(row => (row.show === 'list' && !row.items.length) || (row.show === 'table' && !row.table.rows.length) || (row.show === 'long' && !row.text) || (row.show === 'tags' && !row.tags.length) || (row.show === 'map' && !row.spots.length && !row.places.length)))

// The app the reader left open: open again in the next bar drawn (the reply after), till it is closed by hand.
let appOpen = ''

/** The icons and the phone they open in: [dock, phone]. `apps` are [{ name, groups }]. `remembers`: as for the bar's page. */
function phoneBlock(el, apps, remembers = true, art = null) {
  const screen = el('div', { class: 'status-phone-screen' })
  const heading = el('b', { class: 'status-phone-name' })
  const close = () => open('')
  const phone = el('div', { class: 'status-phone', hidden: true }, el('div', { class: 'status-phone-frame' }, [
    el('div', { class: 'status-phone-top', 'aria-hidden': 'true' }, [el('i', { class: 'status-phone-notch' })]),
    el('div', { class: 'status-phone-head' }, [el('button', { type: 'button', class: 'status-phone-back', 'aria-label': t`回到状态栏`, title: t`回到状态栏`, text: '‹', onclick: close }), heading]),
    screen,
    el('button', { type: 'button', class: 'status-phone-home', 'aria-label': t`关上`, title: t`关上`, onclick: close }),
  ]))
  const buttons = new Map()
  let shown = ''
  const open = (name, byHand = true) => {
    shown = name === shown ? '' : name
    if (byHand && remembers) appOpen = shown
    const app = apps.find(one => one.name === shown)
    for (const [key, button] of buttons) button.setAttribute('aria-expanded', String(key === shown))
    phone.hidden = !app
    if (!app) return
    heading.textContent = app.name
    screen.replaceChildren(...app.groups.map(group => groupBlock(el, group, app.name, art)))
    // An app that is one thing (a bag, a list of quests) needs no name over it again.
    screen.classList.toggle('single', app.groups.length === 1 && app.groups[0].rows.length === 1)
    screen.scrollTop = 0
    // Drawn again, so that it comes up each time one is opened.
    phone.firstChild.style.animation = 'none'
    void phone.firstChild.offsetWidth
    phone.firstChild.style.animation = ''
  }
  const dock = el('div', { class: 'status-dock', role: 'group', 'aria-label': t`小手机` }, apps.map(app => {
    const { count, changed } = appNews(app.groups)
    const button = el('button', { type: 'button', class: `status-app${changed ? ' changed' : ''}`, 'aria-expanded': 'false', title: changed ? t`这一轮有变化` : app.name, onclick: () => open(app.name) }, [
      el('span', { class: 'status-app-icon', html: appIcon(app.name) }),
      el('span', { class: 'status-app-name', text: app.name }),
      count ? el('i', { class: 'status-app-count', text: String(count) }) : null,
      changed ? el('i', { class: 'status-app-dot', 'aria-hidden': 'true' }) : null,
    ])
    buttons.set(app.name, button)
    return button
  }))
  if (remembers && appOpen && apps.some(app => app.name === appOpen)) {
    open(appOpen, false)
    // As it was left, not coming up anew.
    phone.firstChild.style.animation = 'none'
  }
  return [dock, phone]
}

// Bars whose gauges have already been seen filling (a chat's bar is drawn again whenever the page is).
const filled = new Set()
let filling = true

const CLOCK = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.4 1.6"/></svg>'
const SEND = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5.5 15.5 10 11 14.5"/></svg>'

/** The line above the story: time · place · weather. */
export function timeBox(el, parts) {
  return el('div', { class: 'time-box' }, [
    el('span', { class: 'time-box-icon', html: CLOCK }),
    ...parts.flatMap((part, i) => [i ? el('span', { class: 'time-box-dot', 'aria-hidden': 'true', text: '·' }) : null, el('span', { text: part })]),
  ])
}

const delta = n => (n > 0 ? `+${n}` : `−${Math.abs(n)}`)
const shown = n => String(Math.round(n * 100) / 100)
const deltaMark = (el, n) => (n ? el('span', { class: `status-delta ${n > 0 ? 'up' : 'down'}`, text: delta(n) }) : null)

// From this many people on, one shows at a time; from FIND_AT, they can be looked for by name.
const SWITCH_AT = 5
const FIND_AT = 12
// A group this long lays its rows out side by side where there is room.
const WIDE_AT = 6
// A paragraph longer than this opens on a tap.
const FOLD_AT = 120
const PICKED_GROUP = 'statusBarGroup'
const PICKED_PAGE = 'statusBarPage'
const ALL = '*'

function statusTable(el, table, art = null) {
  const head = table.columns.length ? el('thead', {}, el('tr', {}, [table.named ? el('th', {}) : null, ...table.columns.map(text => el('th', { text }))])) : null
  const body = el('tbody', {}, table.rows.map(row => el('tr', { class: row.changed ? 'changed' : '' }, [
    table.named ? el('th', { scope: 'row' }, [faceOf(el, art, row.name, 'small', row.cells), el('span', { text: row.name })]) : null,
    ...row.cells.map(text => el('td', { text })),
  ])))
  return el('div', { class: 'status-table-wrap' }, [
    el('table', { class: 'status-table' }, [head, body]),
    table.more ? el('p', { class: 'status-none', text: t`还有 ${table.more} 行` }) : null,
  ])
}

function longText(el, text) {
  const folded = text.length > FOLD_AT
  const words = el('p', { class: `status-long${folded ? ' clamped' : ''}`, text })
  if (!folded) return words
  const toggle = el('button', { type: 'button', class: 'status-more', text: t`展开全文`, onclick: () => {
    const open = words.classList.toggle('clamped')
    toggle.textContent = open ? t`展开全文` : t`收起全文`
  } })
  return el('div', {}, [words, toggle])
}

// 地图: the card's places as pins on its map. Where the card gave a place no spot of its own (or has no picture of the
// map), they stand in rows, those of one part of the world together.
export function laidOut(places) {
  const free = places.filter(place => place.x === undefined)
  const zones = [...new Set(free.map(place => place.zone ?? ''))]
  const ordered = zones.flatMap(zone => free.filter(place => (place.zone ?? '') === zone))
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.6)))
  const lines = Math.max(1, Math.ceil(ordered.length / columns))
  const spots = new Map(ordered.map((place, i) => {
    const line = Math.floor(i / columns)
    // Every other row stands half a step along, so the names under the pins do not run into each other.
    const along = (i % columns) + (line % 2 ? 0.75 : 0.25)
    return [place.name, { x: Math.round((along / columns) * 1000) / 10, y: Math.round(((line + 0.5) / lines) * 800) / 10 + 8 }]
  }))
  return places.map(place => ({ ...place, ...(spots.get(place.name) ?? {}) }))
}

const ZONE = /^(区域|地区|分区|zone|area|region)$/i
// The place the reader last looked at, and the type: shown again in the next bar drawn.
let placeOpen = ''
let typeOpen = ''

function mapBlock(el, row, art) {
  // A card that says where nothing is still has a map: of the places the variables name.
  const zoneOf = spot => spot.facts.find(([key]) => ZONE.test(key))?.[1].slice(0, 16) ?? ''
  const places = laidOut(row.places.length ? row.places : row.spots.map(spot => ({ name: spot.name, ...(zoneOf(spot) ? { zone: zoneOf(spot) } : {}) })))
  const spotOf = name => row.spots.find(spot => sameName(spot.name, name))
  const placeOf = name => places.find(place => sameName(place.name, name))
  const stage = el('div', { class: `status-map-stage${art?.map ? '' : ' plain'}` }, art?.map ? el('img', { class: 'status-map-img', src: art.map, alt: '', draggable: 'false' }) : null)
  const detail = el('div', { class: 'status-map-detail', 'aria-live': 'polite' })
  const pins = new Map()
  const show = (name, byHand) => {
    if (byHand) placeOpen = name
    const place = placeOf(name)
    const spot = spotOf(name)
    for (const [key, pin] of pins) pin.setAttribute('aria-pressed', String(key === place?.name))
    const title = spot?.name ?? place?.name ?? name
    const there = row.people.filter(one => sameName(one.where, title) || (place && sameName(one.where, place.name)))
    const zone = place?.zone ?? ''
    detail.replaceChildren(...[
      el('div', { class: 'status-map-head' }, [
        el('b', { class: 'status-map-name', text: spot ? title : t`还没探明的地方` }),
        zone ? el('span', { class: 'status-chip', text: zone }) : null,
        spot?.shut ? el('span', { class: 'status-chip warn', text: t`受限` }) : null,
        row.here && sameName(row.here, title) ? el('span', { class: 'status-chip here', text: t`你在这里` }) : null,
      ]),
      spot ? null : el('p', { class: 'status-map-text', text: t`只知道这一带有个去处，还没有去过，也没人说起过。` }),
      ...(spot?.facts ?? []).filter(([, words]) => words !== zone).map(([key, words]) => el('p', { class: 'status-map-text' }, [key ? el('span', { class: 'status-label', text: key }) : null, el('span', { text: words })])),
      there.length ? el('div', { class: 'status-map-people' }, [el('span', { class: 'status-label', text: t`在这里` }), ...there.map(one => el('span', { class: 'status-person' }, [faceOf(el, art, one.name, 'small'), el('b', { text: one.name })]))]) : null,
    ].filter(Boolean))
  }
  for (const place of places) {
    const spot = spotOf(place.name)
    const here = row.here && (sameName(row.here, place.name) || (spot && sameName(row.here, spot.name)))
    const pin = el('button', { type: 'button', class: `status-pin${spot ? '' : ' unknown'}${here ? ' here' : ''}${spot?.shut ? ' shut' : ''}${spot?.changed ? ' changed' : ''}`, style: `left:${place.x}%;top:${place.y}%`, title: spot ? place.name : t`还没探明`, 'aria-pressed': 'false', onclick: () => show(place.name, true) }, [
      el('i', { class: 'status-pin-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'status-pin-name', text: spot ? place.short || place.name : '?' }),
    ])
    pins.set(place.name, pin)
    stage.append(pin)
  }
  const others = row.spots.filter(spot => !placeOf(spot.name))
  const known = row.spots.length
  const box = el('div', { class: 'status-map' }, [
    stage,
    detail,
    others.length ? el('div', { class: 'status-map-others' }, [el('span', { class: 'status-label', text: t`图外的地方` }), ...others.map(spot => el('button', { type: 'button', class: 'status-chip pick', text: spot.name, onclick: () => show(spot.name, true) }))]) : null,
    el('div', { class: 'status-map-legend' }, [
      row.here ? el('span', { class: 'key here', text: t`所在` }) : null,
      el('span', { class: 'key', text: t`去过或听说过` }),
      row.spots.some(spot => spot.shut) ? el('span', { class: 'key shut', text: t`受限` }) : null,
      places.some(place => !spotOf(place.name)) ? el('span', { class: 'key unknown', text: t`还没探明` }) : null,
      el('span', { class: 'status-none', text: t`已知 ${known} 处，点地名看详情` }),
    ]),
  ])
  const first = [placeOpen, row.here, row.spots[0]?.name, places[0]?.name].find(name => name && (placeOf(name) || spotOf(name)))
  if (first) show(first, false)
  return box
}

// 类型克制: the card's types on a ring, an arrow from each to what it beats; the type of whoever is fielded is marked.
let ringCount = 0

function typesBlock(el, row, art) {
  const beats = art.types.beats
  const names = Object.keys(beats)
  const fielded = row.text
  const mine = names.includes(fielded) ? fielded : art.types.of(fielded) ?? ''
  const NS = 'http://www.w3.org/2000/svg'
  const id = `status-ring-${++ringCount}`
  const make = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    if (text) node.textContent = text
    return node
  }
  const svg = make('svg', { viewBox: '0 0 360 360', class: 'status-ring', role: 'group', 'aria-label': row.label })
  const at = i => {
    const angle = (Math.PI * 2 * i) / names.length - Math.PI / 2
    return [180 + Math.cos(angle) * 132, 180 + Math.sin(angle) * 132]
  }
  const hue = i => `hsl(${Math.round((i * 360) / names.length + 265) % 360} 48% 64%)`
  const defs = make('defs', {})
  for (const kind of ['', 'win', 'lose']) {
    const marker = make('marker', { id: `${id}${kind}`, class: `status-ring-tip ${kind}`, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })
    marker.append(make('path', { d: 'M0 0 L10 5 L0 10 z' }))
    defs.append(marker)
  }
  svg.append(defs)
  const edges = []
  names.forEach((from, i) => {
    for (const to of beats[from]) {
      const j = names.indexOf(to)
      if (j < 0) continue
      const [x1, y1] = at(i)
      const [x2, y2] = at(j)
      const length = Math.hypot(x2 - x1, y2 - y1) || 1
      const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length]
      // Bent a little to one side, so two types that beat each other show two lines.
      const line = make('path', { d: `M${x1 + ux * 30} ${y1 + uy * 30} Q${(x1 + x2) / 2 - uy * 14} ${(y1 + y2) / 2 + ux * 14} ${x2 - ux * 32} ${y2 - uy * 32}`, class: 'status-ring-edge', fill: 'none' })
      edges.push({ from, to, line })
      svg.append(line)
    }
  })
  const note = el('div', { class: 'status-types-note', 'aria-live': 'polite' })
  const nodes = names.map((name, i) => {
    const [x, y] = at(i)
    const node = make('g', { class: `status-ring-node${name === mine ? ' mine' : ''}`, transform: `translate(${x} ${y})`, tabindex: '0', role: 'button', 'aria-label': name, style: `--type:${hue(i)}` })
    node.append(make('circle', { r: '26' }), make('text', { 'text-anchor': 'middle', dy: '5' }, name))
    svg.append(node)
    return { name, node, color: hue(i) }
  })
  const pick = (name, byHand) => {
    if (byHand) typeOpen = name
    for (const edge of edges) {
      const kind = edge.from === name ? 'win' : edge.to === name ? 'lose' : ''
      edge.line.setAttribute('class', `status-ring-edge ${kind}`)
      edge.line.setAttribute('marker-end', `url(#${id}${kind})`)
    }
    for (const one of nodes) one.node.classList.toggle('on', one.name === name)
    const beaten = names.filter(other => beats[other].includes(name))
    note.replaceChildren(
      el('div', { class: 'status-types-head' }, [el('b', { text: name, style: `color:${nodes.find(one => one.name === name).color}` }), name === mine && fielded !== name ? el('span', { class: 'status-chip here', text: fielded }) : null]),
      el('p', {}, [el('span', { class: 'status-types-win', text: t`克制${''}` }) /* its own entry: 克制 alone is the intimacy level */, el('span', { text: beats[name].join(t`、`) || t`没有` })]),
      el('p', {}, [el('span', { class: 'status-types-lose', text: t`被克` }), el('span', { text: beaten.join(t`、`) || t`没有` })]),
    )
  }
  for (const one of nodes) {
    one.node.addEventListener('click', () => pick(one.name, true))
    one.node.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      pick(one.name, true)
    })
  }
  pick(names.includes(typeOpen) ? typeOpen : mine || names[0], false)
  return el('div', { class: 'status-types' }, [el('div', { class: 'status-ring-wrap' }, svg), el('div', { class: 'status-types-side' }, [note, el('p', { class: 'status-none', text: t`用克制对方的类型出手更重，被克制时吃亏。点一个类型看它克谁、被谁克。` })])])
}

/** Where in its chain a companion is, by what its row says of it: a form's name first, then a stage's. */
export function formIndex(chain, words) {
  const said = words.map(word => String(word))
  const byName = chain.findIndex(form => said.some(word => word === form.name))
  if (byName >= 0) return byName
  const byStage = chain.findIndex(form => form.stage && said.some(word => word === form.stage))
  return Math.max(0, byStage)
}

// 形态: each companion's chain as a row of pictures, the one it is in marked, those it has not come to as shadows.
function formsBlock(el, row, art) {
  const chains = row.lines.map(line => ({ line, chain: art?.chain?.(line.name) ?? null })).filter(one => one.chain)
  return el('div', { class: 'status-forms' }, [
    ...chains.map(({ line, chain }) => {
      const at = formIndex(chain, line.words)
      return el('div', { class: 'status-chain', 'data-name': line.name }, [
        el('b', { class: 'status-chain-name', text: line.name }),
        el('div', { class: 'status-chain-row' }, chain.flatMap((form, i) => {
          const face = art.face?.(form.name, [form.name]) ?? null
          const tile = el('div', { class: `status-form${i === at ? ' now' : i < at ? ' past' : ' later'}`, title: i > at ? form.need : '' }, [
            el('span', { class: 'status-form-pic' }, face ? el('img', { src: face.src, alt: '', draggable: 'false', loading: 'lazy' }) : el('i', { text: i > at ? '?' : form.name.slice(0, 1) })),
            form.stage ? el('span', { class: 'status-form-stage', text: form.stage }) : null,
            el('span', { class: 'status-form-name', text: i <= at ? form.name : '???' }),
            i > at && form.need ? el('span', { class: 'status-form-need', text: form.need }) : null,
          ])
          return i ? [el('span', { class: `status-chain-arrow${i <= at ? ' done' : ''}`, 'aria-hidden': 'true', text: '›' }), tile] : [tile]
        })),
      ])
    }),
    statusTable(el, row.table, art),
  ])
}

function statusRow(el, row, art = null) {
  const label = el('span', { class: 'status-label', text: row.label, title: row.path })
  // What a look of the card's own (定制外观) tells rows apart by.
  const marks = { 'data-show': row.show, 'data-label': row.label }
  const line = (...parts) => el('div', { class: `status-row${row.changed ? ' changed' : ''}`, ...marks }, [label, ...parts])
  const block = content => el('div', { class: 'status-row block', ...marks }, [label, content])
  if (row.show === 'meter') {
    const fill = el('i', { style: `width:${row.percent.toFixed(1)}%` })
    const bar = el('span', { class: 'status-meter', role: 'meter', 'aria-valuenow': String(row.value), 'aria-label': row.label }, fill)
    // A gauge this reply moved fills from where it stood.
    if (filling && row.from !== undefined && fill.animate && !motionOff() && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      fill.animate([{ width: `${row.from.toFixed(1)}%` }, { width: `${row.percent.toFixed(1)}%` }], { duration: 900, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    }
    return line(bar, el('span', { class: 'status-value' }, [el('span', { text: row.words ?? shown(row.value) }), deltaMark(el, row.delta)]))
  }
  if (row.show === 'number') return line(el('span', { class: 'status-text' }, [el('span', { text: row.words ?? shown(row.value) }), deltaMark(el, row.delta)]))
  if (row.show === 'rating') {
    return line(el('span', { class: 'status-stars', role: 'img', 'aria-label': t`${row.value} / ${row.max}`, text: '★'.repeat(row.value) + '☆'.repeat(row.max - row.value) }))
  }
  if (row.show === 'badge') return line(el('span', { class: 'status-tags' }, el('span', { class: 'status-badge', text: row.text || '—' })))
  if (row.show === 'tags') {
    const added = new Set(row.added ?? [])
    const tags = row.tags.length ? row.tags.map(tag => el('span', { class: `status-tag${added.has(tag) ? ' new' : ''}`, text: tag })) : [el('span', { class: 'status-none', text: t`无` })]
    return line(el('span', { class: 'status-tags' }, tags))
  }
  if (row.show === 'flag') return line(el('span', { class: `status-flag${row.on ? ' on' : ''}`, text: row.on ? t`是` : t`否` }))
  if (row.show === 'long') return block(row.text ? longText(el, row.text) : el('span', { class: 'status-none', text: '—' }))
  if (row.show === 'list') {
    const fresh = new Set(row.added ?? [])
    const items = row.items.map(text => el('li', { class: fresh.has(text) ? 'new' : '', text }))
    return block(items.length
      ? el('ul', { class: 'status-list' }, [...items, row.more ? el('li', { class: 'status-none', text: t`还有 ${row.more} 条` }) : null])
      : el('span', { class: 'status-none', text: t`无` }))
  }
  if (row.show === 'stats') {
    return block(el('div', { class: 'status-stats' }, row.stats.map(stat => el('div', { class: 'status-stat' }, [
      el('span', { class: 'status-label', text: stat.label }),
      el('span', { class: 'status-value' }, [el('span', { text: String(stat.value) }), deltaMark(el, stat.delta)]),
    ]))))
  }
  if (row.show === 'table') return block(statusTable(el, row.table, art))
  if (row.show === 'map') return block(mapBlock(el, row, art))
  if (row.show === 'forms') return block(formsBlock(el, row, art))
  if (row.show === 'types') return art?.types ? block(typesBlock(el, row, art)) : line(el('span', { class: 'status-tags' }, el('span', { class: 'status-badge', text: row.text || '—' })))
  return line(el('span', { class: 'status-text', text: row.text || '—' }))
}

/** One person's rows, a line above each section of them. */
function groupBlock(el, group, title, art = null) {
  const rows = el('div', { class: `status-rows${group.rows.length >= WIDE_AT ? ' wide' : ''}` })
  let section = ''
  for (const row of group.rows) {
    if ((row.section ?? '') !== section) {
      section = row.section ?? ''
      if (section) rows.append(el('div', { class: 'status-section', text: section }))
    }
    rows.append(statusRow(el, row, art))
  }
  return el('div', { class: 'status-group', 'data-name': group.name }, [group.name && group.name !== title ? el('div', { class: 'status-group-name' }, [faceOf(el, art, group.name, 'medium'), el('span', { text: group.name })]) : null, rows])
}

function rememberedGroup() {
  try {
    return localStorage.getItem(PICKED_GROUP) ?? ''
  } catch {
    return ''
  }
}

function rememberGroup(key) {
  try {
    localStorage.setItem(PICKED_GROUP, key)
  } catch {
    // Private windows: the first person shows next time.
  }
}

/** A chip per person, one showing at a time (or 全部); a dot on those this reply touched. */
function groupSwitch(el, groups, blocks, body) {
  const remembered = rememberedGroup()
  const chips = new Map()
  const show = key => {
    groups.forEach((group, i) => { blocks[i].hidden = key !== ALL && group.key !== key })
    body.classList.toggle('multi', key === ALL)
    for (const [chipKey, chip] of chips) chip.setAttribute('aria-pressed', String(chipKey === key))
  }
  const chip = (key, text, changed) => {
    const button = el('button', { type: 'button', class: 'status-tab', onclick: () => {
      show(key)
      rememberGroup(key)
    } }, [el('span', { text }), changed ? el('i', { class: 'status-tab-dot', title: t`这一轮有变化` }) : null])
    chips.set(key, button)
    return button
  }
  const row = el('div', { class: 'status-tabs', role: 'group', 'aria-label': t`看谁的状态` }, [
    chip(ALL, t`全部`, false),
    ...groups.map(group => chip(group.key, group.name || t`通用`, group.changed)),
  ])
  show(remembered === ALL || groups.some(group => group.key === remembered) ? remembered : (groups.find(group => group.changed) ?? groups[0]).key)
  if (groups.length < FIND_AT) return [row]
  const find = el('input', { type: 'search', class: 'status-find', placeholder: t`找角色`, 'aria-label': t`找角色`, oninput: () => {
    const words = find.value.trim().toLowerCase()
    groups.forEach(group => { chips.get(group.key).hidden = Boolean(words) && !group.name.toLowerCase().includes(words) })
  } })
  return [find, row]
}

// 版式 (web/shared/status.js STATUS_LAYOUTS): the bar laid out another way. What a person's first page holds is told
// apart by what it is: gauges, short facts, a line of what is on their mind, and the rest, which goes under the tabs.
// The three layouts are one structure (the head, a rail of people, the tabs and what they open); the sheet places it.
const FACT_MAX = 12
const QUOTE_MAX = 80

function groupParts(group, lead) {
  const parts = { pills: [], quote: null, gauges: [], facts: [], tags: [], rest: [] }
  for (const row of group.rows) {
    if (row.show === 'meter') parts.gauges.push(row)
    else if (row.show === 'number' || row.show === 'rating' || row.show === 'flag') parts.facts.push(row)
    else if (row.show === 'badge') (lead ? parts.pills : parts.facts).push(row)
    else if (row.show === 'tags') parts.tags.push(row)
    else if (row.show === 'text' && (row.text ?? '').length <= FACT_MAX) parts.facts.push(row)
    else if (lead && !parts.quote && (row.show === 'text' || row.show === 'long') && row.text && row.text.length <= QUOTE_MAX) parts.quote = row
    else parts.rest.push(row)
  }
  return parts
}

function gaugeBlock(el, row) {
  const fill = el('i', { style: `width:${row.percent.toFixed(1)}%` })
  if (filling && row.from !== undefined && fill.animate && !motionOff() && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    fill.animate([{ width: `${row.from.toFixed(1)}%` }, { width: `${row.percent.toFixed(1)}%` }], { duration: 900, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  }
  return el('div', { class: `status-gauge${row.changed ? ' changed' : ''}`, 'data-show': 'meter', 'data-label': row.label }, [
    el('span', { class: 'status-label', text: row.label, title: row.path }),
    el('span', { class: 'status-value' }, [el('span', { text: row.words ?? shown(row.value) }), !row.words && row.max !== undefined && row.max !== 100 ? el('small', { class: 'status-of', text: `/ ${shown(row.max)}` }) : null, deltaMark(el, row.delta)]),
    el('span', { class: 'status-meter', role: 'meter', 'aria-valuenow': String(row.value), 'aria-label': row.label }, fill),
  ])
}

function factBlock(el, row) {
  const value = row.show === 'number' ? [el('span', { text: row.words ?? shown(row.value) }), deltaMark(el, row.delta)]
    : row.show === 'rating' ? [el('span', { class: 'status-stars', role: 'img', 'aria-label': t`${row.value} / ${row.max}`, text: '★'.repeat(row.value) + '☆'.repeat(row.max - row.value) })]
      : row.show === 'flag' ? [el('span', { class: `status-flag${row.on ? ' on' : ''}`, text: row.on ? t`是` : t`否` })]
        : [el('span', { text: row.text || '—' })]
  return el('div', { class: `status-fact${row.changed ? ' changed' : ''}`, 'data-show': row.show, 'data-label': row.label }, [el('span', { class: 'status-label', text: row.label, title: row.path }), el('span', { class: 'status-fact-value' }, value)])
}

/**
 * One person in the rail, and what of theirs goes under the first tab: [node, rest (a group block, or null)].
 * `aside`: this one stands in a narrow column beside the tabs (侧栏式), so only their name and numbers are in it; what is
 * on their mind and their tags open with the first tab.
 */
function railGroup(el, group, lead, title, picture, aside, art = null) {
  const parts = groupParts(group, lead)
  const quote = parts.quote ? el('p', { class: 'status-quote', 'data-label': parts.quote.label, title: parts.quote.label, text: parts.quote.text }) : null
  const tags = parts.tags.length ? el('div', { class: 'status-rows' }, parts.tags.map(row => statusRow(el, row, art))) : null
  const name = group.name && group.name !== title ? group.name : ''
  const who = name || parts.pills.length
    ? el('div', { class: 'status-who' }, [picture ? null : faceOf(el, art, group.name, 'medium'), name ? el('b', { class: 'status-who-name', text: name }) : null, ...parts.pills.map(row => el('span', { class: `status-badge${row.changed ? ' changed' : ''}`, 'data-label': row.label, title: row.label, text: row.text || '—' }))])
    : null
  const main = el('div', { class: 'status-g-main' }, [
    who,
    aside ? null : quote,
    parts.gauges.length ? el('div', { class: 'status-gauges' }, parts.gauges.map(row => gaugeBlock(el, row))) : null,
    parts.facts.length ? el('div', { class: 'status-facts' }, parts.facts.map(row => factBlock(el, row))) : null,
    aside ? null : tags,
  ])
  const node = main.childElementCount || picture
    ? el('div', { class: `status-g${lead ? ' lead' : ''}${picture ? ' has-pic' : ''}`, 'data-name': group.name }, [picture, main])
    : null
  const more = parts.rest.length ? groupBlock(el, { ...group, rows: parts.rest }, title, art) : null
  if (!aside || (!quote && !tags)) return [node, more]
  // Their name is beside it in the rail already.
  const block = more ?? el('div', { class: 'status-group', 'data-name': group.name })
  block.querySelector('.status-rows')?.before(...[quote, tags].filter(Boolean)) ?? block.append(...[quote, tags].filter(Boolean))
  return [node, block]
}

/** The rail and what the first tab opens, for the people of the bar's first page: { rail, rest: [group block] }. */
function railOf(el, groups, title, art, aside) {
  const rail = el('div', { class: 'status-rail' })
  const rest = []
  groups.forEach((group, i) => {
    const picture = i === 0 && art?.portrait ? el('span', { class: `status-pic${art.zoom ? ' zoom' : ''}` }, el('img', { src: art.portrait, alt: '', draggable: 'false' })) : null
    const [node, more] = railGroup(el, group, i === 0, title, picture, aside && i === 0, art)
    // 侧栏式 keeps one person beside the tabs: with everyone there the rail runs long past a first tab with little in it.
    if (node && aside && i) rest.push(node)
    else if (node) rail.append(node)
    if (more) rest.push(more)
  })
  return { rail, rest }
}

// A bar in a theme, or wearing a look, knows where the pointer is over it, and the rules draw with that: --px and --py (px from
// its top left), --pxi and --pyi (the same as whole numbers, for counters), --pfx and --pfy (0 to 1), and .pointing
// while the pointer is over it. One write a frame; nothing with 动效 off.
function followPointer(box) {
  let last = null
  const put = () => {
    const event = last
    last = null
    const rect = box.getBoundingClientRect()
    if (!event || !rect.width || !rect.height) return
    // In the bar's own pixels, also when something draws it smaller or larger (a transform).
    const k = box.offsetWidth / rect.width || 1
    const x = Math.max(0, Math.min(box.offsetWidth, (event.clientX - rect.left) * k))
    const y = Math.max(0, Math.min(box.offsetHeight, (event.clientY - rect.top) * k))
    box.style.setProperty('--px', `${x.toFixed(1)}px`)
    box.style.setProperty('--py', `${y.toFixed(1)}px`)
    box.style.setProperty('--pxi', String(Math.round(x)))
    box.style.setProperty('--pyi', String(Math.round(y)))
    box.style.setProperty('--pfx', (x / (box.offsetWidth || 1)).toFixed(4))
    box.style.setProperty('--pfy', (y / (box.offsetHeight || 1)).toFixed(4))
  }
  box.addEventListener('pointermove', event => {
    if (motionOff()) return
    if (!last) requestAnimationFrame(put)
    last = event
    box.classList.add('pointing')
  })
  box.addEventListener('pointerleave', () => box.classList.remove('pointing'))
}

// What a theme draws with code rather than rules: theme → (box) => void. The picture goes in a canvas.status-fx
// behind everything; the theme's rules stand without it.
// 流银: liquid chrome drawn live (one WebGL context for the page, copied into each bar's canvas).
// 流银: the liquid chrome behind a bar, drawn live. One WebGL context for every 流银 bar on the page (mercuryShared);
// each bar has a plain 2D canvas.status-fx the frame is copied into. A height field of slow noise and rings gives a
// surface, its slope looks up a black-and-white studio (a bright sky over a hard dark horizon, two strips of light),
// and that is what reads as polished metal. The pointer presses a dent that follows it and lets go.
const MERCURY_VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}'
const MERCURY_FRAG = `precision highp float;
uniform vec2 u_size;uniform float u_k;uniform float u_t;uniform vec2 u_m;uniform float u_ms;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*f*(f*(f*6.-15.)+10.);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float height(vec2 w){
vec2 q=w+.55*vec2(noise(w*.62+vec2(0.,u_t*.05)),noise(w*.62+vec2(5.2,-u_t*.04)))-.27;
float h=.9*noise(q*.95+vec2(u_t*.03,-u_t*.02))+.32*noise(q*2.1-vec2(u_t*.045,0.));
vec2 c=vec2(u_size.x/230.*.74,.95);float d=length((q-c)*vec2(1.,1.25));
h+=.3*sin(d*6.-u_t*.42)*exp(-d*.42);
vec2 m=u_m/230.;float dm=length(w-m);
h+=u_ms*(-.3*exp(-dm*dm*5.)+.05*sin(dm*24.-u_t*3.4)*exp(-dm*2.6));
return h;}
float studio(vec3 r){
float y=r.y;
float sky=mix(1.,.16,smoothstep(0.,.75,y));
float ground=mix(.0,.5,smoothstep(-.04,-.95,y));
float v=mix(ground,sky,smoothstep(-.03,.04,y));
v+=.85*smoothstep(.07,.0,abs(y-.62))*smoothstep(.9,.1,abs(r.x));
v+=.55*smoothstep(.05,.0,abs(r.x+.58))*smoothstep(-.1,.3,y);
v+=.35*smoothstep(.04,.0,abs(y+.5));
return v;}
void main(){
vec2 p=vec2(gl_FragCoord.x,u_size.y/u_k-gl_FragCoord.y)*u_k;
vec2 w=p/230.;
float e=.014;float h=height(w);
vec2 g=vec2(height(w+vec2(e,0.))-h,height(w+vec2(0.,e))-h)/e;
vec3 n=normalize(vec3(-g*1.55,1.));
vec3 r=vec3(2.*n.z*n.x,-2.*n.z*n.y,2.*n.z*n.z-1.);
float v=studio(r)+.22*pow(1.-n.z,2.);
v=smoothstep(.03,.97,v);v=v*v*(3.-2.*v);
gl_FragColor=vec4(v*.965,v*.985,v*1.02,1.);}`

let mercuryShared = null

/** The one WebGL canvas and its program, or null where there is no WebGL. */
function mercuryContext() {
  if (mercuryShared) return mercuryShared.gl ? mercuryShared : null
  const canvas = document.createElement('canvas')
  const state = { canvas, gl: null, uniforms: null, bars: new Set(), raf: 0, lost: false, sizes: null, seen: null }
  mercuryShared = state
  const build = () => {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
    if (!gl) return false
    const shader = (type, source) => {
      const made = gl.createShader(type)
      gl.shaderSource(made, source)
      gl.compileShader(made)
      return gl.getShaderParameter(made, gl.COMPILE_STATUS) ? made : null
    }
    const vert = shader(gl.VERTEX_SHADER, MERCURY_VERT)
    const frag = shader(gl.FRAGMENT_SHADER, MERCURY_FRAG)
    if (!vert || !frag) return false
    const program = gl.createProgram()
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const at = gl.getAttribLocation(program, 'a')
    gl.enableVertexAttribArray(at)
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0)
    state.gl = gl
    state.uniforms = Object.fromEntries(['u_size', 'u_k', 'u_t', 'u_m', 'u_ms'].map(name => [name, gl.getUniformLocation(program, name)]))
    return true
  }
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    state.lost = true
  })
  canvas.addEventListener('webglcontextrestored', () => {
    state.lost = !build()
    for (const bar of state.bars) bar.stale = true
    mercuryRun()
  })
  if (!build()) return null
  // A bar is drawn while it is on the screen, and again when its size changes.
  state.seen = globalThis.IntersectionObserver ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const bar = [...state.bars].find(one => one.box === entry.target)
      if (bar) bar.onScreen = entry.isIntersecting
    }
    mercuryRun()
  }) : null
  state.sizes = globalThis.ResizeObserver ? new ResizeObserver(entries => {
    for (const entry of entries) {
      const bar = [...state.bars].find(one => one.box === entry.target)
      if (bar) bar.stale = true
    }
    mercuryRun()
  }) : null
  document.addEventListener('visibilitychange', () => { if (!document.hidden) mercuryRun() })
  return state
}

const mercuryStill = () => document.documentElement.dataset.cardMotion === 'off' || Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

/** One frame of a bar: the shader at a reduced size, copied into the bar's own canvas. */
function mercuryDraw(state, bar, seconds) {
  const { gl, canvas, uniforms } = state
  const width = bar.box.clientWidth
  const height = bar.box.clientHeight
  if (!width || !height) return false
  // Fewer pixels than the screen has: the metal is smooth, and the page stretches it.
  let scale = Math.min(globalThis.devicePixelRatio || 1, 1.5) * 0.8
  scale = Math.min(scale, Math.sqrt(520000 / (width * height)))
  const w = Math.max(2, Math.round(width * scale))
  const h = Math.max(2, Math.round(height * scale))
  if (canvas.width < w || canvas.height < h) {
    canvas.width = Math.max(canvas.width, w)
    canvas.height = Math.max(canvas.height, h)
  }
  if (bar.canvas.width !== w || bar.canvas.height !== h) {
    bar.canvas.width = w
    bar.canvas.height = h
  }
  gl.viewport(0, 0, w, h)
  gl.uniform2f(uniforms.u_size, width, height)
  gl.uniform1f(uniforms.u_k, width / w)
  gl.uniform1f(uniforms.u_t, seconds + bar.phase)
  gl.uniform2f(uniforms.u_m, bar.x, bar.y)
  gl.uniform1f(uniforms.u_ms, bar.press)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  bar.pen.drawImage(canvas, 0, canvas.height - h, w, h, 0, 0, w, h)
  bar.stale = false
  return true
}

function mercuryDrop(state, bar) {
  state.bars.delete(bar)
  state.seen?.unobserve(bar.box)
  state.sizes?.unobserve(bar.box)
  bar.box.removeEventListener('pointermove', bar.onMove)
  bar.box.removeEventListener('pointerleave', bar.onLeave)
  bar.canvas.remove()
}

/** The loop: thirty frames a second at most, only bars on the screen, nothing while the page is hidden. */
function mercuryRun() {
  const state = mercuryShared
  if (!state?.gl || state.raf || !state.bars.size) return
  let last = 0
  const tick = now => {
    state.raf = 0
    if (!state.bars.size) return
    const still = mercuryStill()
    let busy = false
    const due = now - last >= 33
    for (const bar of [...state.bars]) {
      // A bar that was on the page and is gone lets go of everything; one never put there gives up after a while.
      if (bar.box.isConnected) bar.placed = true
      else if (bar.placed || now - bar.born > 15000) { mercuryDrop(state, bar); continue }
      else { busy = true; continue }
      if (bar.canvas.parentNode !== bar.box) bar.box.prepend(bar.canvas)
      if (state.lost || document.hidden || !bar.onScreen) continue
      if (still) {
        if (bar.stale) mercuryDraw(state, bar, 40)
        continue
      }
      busy = true
      if (!due) continue
      bar.press += ((bar.over ? 1 : 0) - bar.press) * (bar.over ? 0.12 : 0.05)
      bar.x += (bar.tx - bar.x) * 0.14
      bar.y += (bar.ty - bar.y) * 0.14
      mercuryDraw(state, bar, now / 1000)
    }
    if (due) last = now
    if (busy && !document.hidden) state.raf = requestAnimationFrame(tick)
  }
  state.raf = requestAnimationFrame(tick)
}

function mercuryFx(box) {
  const state = mercuryContext()
  if (!state) return
  const canvas = document.createElement('canvas')
  canvas.className = 'status-fx'
  canvas.setAttribute('aria-hidden', 'true')
  const pen = canvas.getContext('2d')
  if (!pen) return
  const bar = { box, canvas, pen, onScreen: !state.seen, stale: true, placed: false, born: performance.now(), phase: (state.bars.size * 7.3) % 40, x: 0, y: 0, tx: 0, ty: 0, press: 0, over: false, onMove: null, onLeave: null }
  bar.onMove = event => {
    const rect = box.getBoundingClientRect()
    const k = rect.width ? box.offsetWidth / rect.width || 1 : 1
    bar.tx = (event.clientX - rect.left) * k
    bar.ty = (event.clientY - rect.top) * k
    if (!bar.over) {
      bar.over = true
      if (bar.press < 0.02) { bar.x = bar.tx; bar.y = bar.ty }
    }
    mercuryRun()
  }
  bar.onLeave = () => { bar.over = false }
  box.addEventListener('pointermove', bar.onMove)
  box.addEventListener('pointerleave', bar.onLeave)
  box.prepend(canvas)
  box.classList.add('has-fx')
  state.bars.add(bar)
  state.seen?.observe(box)
  state.sizes?.observe(box)
  mercuryRun()
}

const BAR_FX = { mercury: mercuryFx }

/**
 * The status bar for one reply, or null when nothing in it has a value.
 * @param previous - the state before this reply, for the +/− marks.
 * @param note - a line under the title (the card creator's preview says what it shows).
 * @param remembers - whether the page opened is the one last picked, and a pick is kept (not when a look is being tried out).
 * @param art - the pictures on top of the bar (artBlock), when the bar asks for them and there are any.
 * @param seen - a name for this drawing (the reply it is under): its gauges fill once, not each time it is drawn again.
 */
export function statusBar(el, whole, state, { previous = null, note = '', collapsible = true, remembers = true, art = null, seen = '', live = true } = {}) {
  // 小手机: lists, tables and the pages after the first are kept off the bar's face, each an app to open.
  // A 版式 has tabs of its own in the phone's place.
  const cut = whole.phone && !whole.layout ? phoneApps(whole) : null
  const spec = cut?.bar ?? whole
  const apps = (cut?.apps ?? []).map(app => ({ name: app.name, groups: statusGroups(app.spec, state, previous) })).filter(app => app.groups.length && !appEmpty(app.groups))
  const groups = statusGroups(spec, state, previous)
  if (!groups.length && !apps.length) return null
  filling = !seen || !filled.has(seen)
  if (seen) {
    if (filled.size > 200) filled.clear()
    filled.add(seen)
  }
  const pages = statusPages(spec)
  const first = pages.length ? statusGroups(onPage(spec, pages[0], pages), state, previous) : groups
  // So many people that one shows at a time: laid out the plain way, which has the switch for that.
  const layout = spec.layout && first.length < SWITCH_AT ? spec.layout : ''
  const box = el('section', { class: `status-bar${spec.theme ? ` theme-${spec.theme}` : ''}${layout ? ` layout-${layout}` : ''}` })
  // 天光云影: the sky painted on the bar is the story's time of day.
  if (spec.theme === 'aquarelle') box.dataset.sky = skyOf(groups)
  if (spec.theme || spec.skin) followPointer(box)
  // Drawn live unless asked not to (a small picture of the look, where the theme's still fallback does).
  if (live && BAR_FX[spec.theme]) BAR_FX[spec.theme](box)
  if (spec.palette) paint(box, paletteColors(spec.palette))
  if (spec.skin) wear(box, spec.skin, art?.lookPictures)
  const fx = spec.effect ? effectLayer(el, spec.effect) : null
  if (fx) {
    box.classList.add('has-drift')
    barWatch?.observe(box)
  }
  const pictures = layout ? null : artBlock(el, art)
  const named = groups.filter(g => g.name).length
  const title = spec.title || (named === 1 && groups.length === 1 ? groups[0].name : '') || t`状态`
  const head = el('div', { class: 'status-head' }, [el('span', { class: 'status-title', text: title }), note ? el('span', { class: 'status-note', text: note }) : null])
  if (layout && art?.place) head.append(el('span', { class: 'status-where', text: art.place }))
  // 卷轴式: where the story is, as a picture behind the title.
  if (layout === 'scroll' && art?.scene) {
    head.classList.add('has-banner')
    head.prepend(el('img', { class: 'status-banner', src: art.scene, alt: '', draggable: 'false' }))
  }
  const laid = layout ? railOf(el, first, title, art, layout === 'rail') : null
  const body = el('div', { class: `status-body${groups.length > 1 ? ' multi' : ''}` })
  const fill = shown => {
    const blocks = shown.map(group => groupBlock(el, group, title, art))
    const switcher = shown.length >= SWITCH_AT ? groupSwitch(el, shown, blocks, body) : []
    body.replaceChildren(...switcher, ...blocks)
    body.classList.toggle('multi', shown.length > 1)
  }
  if (pages.length) {
    const open = page => {
      for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.page === page))
      // In a 版式 the first page's people stand in the rail: its tab opens only what of theirs is not there.
      if (laid && page === pages[0]) {
        body.replaceChildren(...laid.rest)
        body.classList.remove('multi')
        body.hidden = !laid.rest.length
        if (remembers) remember(PICKED_PAGE, page)
        return
      }
      body.hidden = false
      const shown = statusGroups(onPage(spec, page, pages), state, previous)
      fill(shown)
      // Its variables are nowhere in this state yet (a chat from before the bar had them): said, rather than a blank.
      if (!shown.length) body.replaceChildren(el('p', { class: 'status-empty', text: t`这一页要显示的变量现在还没有` }))
      if (remembers) remember(PICKED_PAGE, page)
    }
    const tabs = el('div', { class: 'status-pages', role: 'tablist' }, pages.map(page => el('button', { type: 'button', role: 'tab', class: 'status-page', 'data-page': page, onclick: () => open(page) }, [layout ? el('span', { class: 'status-page-icon', html: appIcon(page) }) : null, el('span', { text: page })])))
    if (!laid) box.append(tabs)
    else laid.tabs = tabs
    const picked = remembers ? recalled(PICKED_PAGE) : ''
    open(pages.includes(picked) ? picked : pages[0])
  } else if (laid) {
    body.replaceChildren(...laid.rest)
    body.hidden = !laid.rest.length
  } else fill(groups)
  if (spec.more) body.append(el('p', { class: 'status-overflow', text: t`还有 ${spec.more} 项放不下，右栏「状态」里能看到全部。` }))
  if (collapsible) {
    const toggle = el('button', { type: 'button', class: 'status-toggle' })
    const set = collapsed => {
      box.classList.toggle('collapsed', collapsed)
      toggle.textContent = collapsed ? t`展开` : t`收起`
      toggle.setAttribute('aria-expanded', String(!collapsed))
    }
    set(recalled(COLLAPSED) === '1')
    toggle.addEventListener('click', () => {
      const collapsed = !box.classList.contains('collapsed')
      const from = foldFrom(box)
      set(collapsed)
      foldTo(box, from)
      remember(COLLAPSED, collapsed ? '1' : '0')
    })
    head.append(toggle)
  }
  box.prepend(...[fx, head, pictures].filter(Boolean))
  if (laid) box.append(laid.rail, el('div', { class: 'status-main', hidden: !laid.tabs && body.hidden }, [laid.tabs, body]))
  else box.append(body, ...(apps.length ? phoneBlock(el, apps, remembers, art) : []))
  return box
}

/**
 * The choices under the latest reply. Tapping one adds it to the input box (several
 * can go together; tapped again, it comes out); its arrow sends it as it is.
 */
export function choiceList(el, items, { onFill, onSend, disabled = false, noteOf = () => null }) {
  return el('div', { class: 'choices', role: 'group', 'aria-label': t`行动选项` }, items.map((text, i) => {
    const letter = String.fromCharCode(65 + i)
    const note = noteOf(text)
    return el('div', { class: 'choice-item' }, [
      el('button', { type: 'button', class: 'choice-fill', disabled, title: t`加进输入框，可以选好几个（再点一次去掉），改好再发`, onclick: () => onFill(text) }, [
        el('span', { class: 'choice-letter', text: letter }),
        el('span', { class: 'choice-text', text }),
        note ? el('span', { class: `choice-risk ${note.risk}`, text: note.text }) : null,
      ]),
      el('button', { type: 'button', class: 'choice-send', disabled, title: t`直接发送`, 'aria-label': t`直接发送：${text}`, html: SEND, onclick: () => onSend(text) }),
    ])
  }))
}
