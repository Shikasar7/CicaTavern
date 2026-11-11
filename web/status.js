// What the page draws around a reply on its own, in the app's look (no card
// HTML, no frames): the built-in preset's time box and choices, and the status
// bar (web/shared/status.js decides what goes in it).
import { t } from '/i18n.js'
import { onPage, paletteColors, phoneApps, scopedSkinCss, skinClass, statusGroups, statusPages } from '/shared/status.js'

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

/** A card's own colors over the bar's (and over its 开场页, web/cover.js). */
export function paint(box, colors) {
  const names = { surface: '--surface', ink: '--ink', accent: '--accent', muted: '--muted', faint: '--faint', line: '--line-soft', track: '--meter-track', soft: '--accent-soft', ok: '--ok', bad: '--bad' }
  for (const [key, name] of Object.entries(names)) box.style.setProperty(name, colors[key])
}

// 定制外观: a sheet for each look on the page, loaded once and shared by every bar that wears it.
const skinSheets = new Map()

/** Dress a bar (or the card's 开场页, web/cover.js) in the card's own look: its rules reach only what wears this class. */
export function wear(box, skin) {
  const scope = skinClass(skin.css)
  if (!skinSheets.get(scope)?.isConnected) {
    const sheet = document.createElement('style')
    sheet.dataset.skin = scope
    sheet.textContent = scopedSkinCss(skin.css, scope)
    document.head.append(sheet)
    skinSheets.set(scope, sheet)
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
 * 立绘 and 场景图 on top of a bar. The pictures are the app's own (角色名册的立绘和表情、视觉小说的场景), found by
 * whoever draws the bar: `art` is { portrait, zoom (a whole figure: show its upper half), scene, name, mood, place }.
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

// 小手机: what the bar keeps off its face (web/shared/status.js phoneApps) is a row of icons under it; one opens as the
// screen of a small phone standing in the bar. An icon is picked by what the app is called.
const ICON = body => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const APP_ICONS = [
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
  const count = rows.reduce((sum, row) => sum + (row.items?.length ?? 0) + (row.table?.rows.length ?? 0), 0)
  const changed = groups.some(group => group.changed) || rows.some(row => row.changed || row.added?.length || row.table?.rows.some(line => line.changed))
  return { count, changed }
}

/** Whether an app has nothing in it yet (lists and tables with no line, a paragraph with no word): then it has no icon. */
const appEmpty = groups => groups.every(group => group.rows.every(row => (row.show === 'list' && !row.items.length) || (row.show === 'table' && !row.table.rows.length) || (row.show === 'long' && !row.text) || (row.show === 'tags' && !row.tags.length)))

// The app the reader left open: open again in the next bar drawn (the reply after), till it is closed by hand.
let appOpen = ''

/** The icons and the phone they open in: [dock, phone]. `apps` are [{ name, groups }]. `remembers`: as for the bar's page. */
function phoneBlock(el, apps, remembers = true) {
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
    screen.replaceChildren(...app.groups.map(group => groupBlock(el, group, app.name)))
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

function statusTable(el, table) {
  const head = table.columns.length ? el('thead', {}, el('tr', {}, [table.named ? el('th', {}) : null, ...table.columns.map(text => el('th', { text }))])) : null
  const body = el('tbody', {}, table.rows.map(row => el('tr', { class: row.changed ? 'changed' : '' }, [
    table.named ? el('th', { scope: 'row', text: row.name }) : null,
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

function statusRow(el, row) {
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
  if (row.show === 'table') return block(statusTable(el, row.table))
  return line(el('span', { class: 'status-text', text: row.text || '—' }))
}

/** One person's rows, a line above each section of them. */
function groupBlock(el, group, title) {
  const rows = el('div', { class: `status-rows${group.rows.length >= WIDE_AT ? ' wide' : ''}` })
  let section = ''
  for (const row of group.rows) {
    if ((row.section ?? '') !== section) {
      section = row.section ?? ''
      if (section) rows.append(el('div', { class: 'status-section', text: section }))
    }
    rows.append(statusRow(el, row))
  }
  return el('div', { class: 'status-group', 'data-name': group.name }, [group.name && group.name !== title ? el('div', { class: 'status-group-name', text: group.name }) : null, rows])
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

/**
 * The status bar for one reply, or null when nothing in it has a value.
 * @param previous - the state before this reply, for the +/− marks.
 * @param note - a line under the title (the card creator's preview says what it shows).
 * @param remembers - whether the page opened is the one last picked, and a pick is kept (not when a look is being tried out).
 * @param art - the pictures on top of the bar (artBlock), when the bar asks for them and there are any.
 * @param seen - a name for this drawing (the reply it is under): its gauges fill once, not each time it is drawn again.
 */
export function statusBar(el, whole, state, { previous = null, note = '', collapsible = true, remembers = true, art = null, seen = '' } = {}) {
  // 小手机: lists, tables and the pages after the first are kept off the bar's face, each an app to open.
  const cut = whole.phone ? phoneApps(whole) : null
  const spec = cut?.bar ?? whole
  const apps = (cut?.apps ?? []).map(app => ({ name: app.name, groups: statusGroups(app.spec, state, previous) })).filter(app => app.groups.length && !appEmpty(app.groups))
  const groups = statusGroups(spec, state, previous)
  if (!groups.length && !apps.length) return null
  filling = !seen || !filled.has(seen)
  if (seen) {
    if (filled.size > 200) filled.clear()
    filled.add(seen)
  }
  const box = el('section', { class: spec.theme ? `status-bar theme-${spec.theme}` : 'status-bar' })
  if (spec.palette) paint(box, paletteColors(spec.palette))
  if (spec.skin) wear(box, spec.skin)
  const fx = spec.effect ? effectLayer(el, spec.effect) : null
  if (fx) {
    box.classList.add('has-drift')
    barWatch?.observe(box)
  }
  const pictures = artBlock(el, art)
  const named = groups.filter(g => g.name).length
  const title = spec.title || (named === 1 && groups.length === 1 ? groups[0].name : '') || t`状态`
  const head = el('div', { class: 'status-head' }, [el('span', { class: 'status-title', text: title }), note ? el('span', { class: 'status-note', text: note }) : null])
  const body = el('div', { class: `status-body${groups.length > 1 ? ' multi' : ''}` })
  const fill = shown => {
    const blocks = shown.map(group => groupBlock(el, group, title))
    const switcher = shown.length >= SWITCH_AT ? groupSwitch(el, shown, blocks, body) : []
    body.replaceChildren(...switcher, ...blocks)
    body.classList.toggle('multi', shown.length > 1)
  }
  const pages = statusPages(spec)
  if (pages.length) {
    const open = page => {
      for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.page === page))
      const shown = statusGroups(onPage(spec, page, pages), state, previous)
      fill(shown)
      // Its variables are nowhere in this state yet (a chat from before the bar had them): said, rather than a blank.
      if (!shown.length) body.replaceChildren(el('p', { class: 'status-empty', text: t`这一页要显示的变量现在还没有` }))
      if (remembers) remember(PICKED_PAGE, page)
    }
    const tabs = el('div', { class: 'status-pages', role: 'tablist' }, pages.map(page => el('button', { type: 'button', role: 'tab', class: 'status-page', 'data-page': page, text: page, onclick: () => open(page) })))
    box.append(tabs)
    const picked = remembers ? recalled(PICKED_PAGE) : ''
    open(pages.includes(picked) ? picked : pages[0])
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
      set(collapsed)
      remember(COLLAPSED, collapsed ? '1' : '0')
    })
    head.append(toggle)
  }
  box.prepend(...[fx, head, pictures].filter(Boolean))
  box.append(body, ...(apps.length ? phoneBlock(el, apps, remembers) : []))
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
