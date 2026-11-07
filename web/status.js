// What the page draws around a reply on its own, in the app's look (no card
// HTML, no frames): the built-in preset's time box and choices, and the status
// bar (web/shared/status.js decides what goes in it).
import { t } from '/i18n.js'
import { onPage, paletteColors, statusGroups, statusPages } from '/shared/status.js'

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

/** A card's own colors over the bar's. */
function paint(box, colors) {
  const names = { surface: '--surface', ink: '--ink', accent: '--accent', muted: '--muted', faint: '--faint', line: '--line-soft', track: '--meter-track', soft: '--accent-soft' }
  for (const [key, name] of Object.entries(names)) box.style.setProperty(name, colors[key])
}

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
  const line = (...parts) => el('div', { class: `status-row${row.changed ? ' changed' : ''}` }, [label, ...parts])
  const block = content => el('div', { class: 'status-row block' }, [label, content])
  if (row.show === 'meter') {
    const bar = el('span', { class: 'status-meter', role: 'meter', 'aria-valuenow': String(row.value), 'aria-label': row.label }, el('i', { style: `width:${row.percent.toFixed(1)}%` }))
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
    const items = row.items.map(text => el('li', { text }))
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
  return el('div', { class: 'status-group' }, [group.name && group.name !== title ? el('div', { class: 'status-group-name', text: group.name }) : null, rows])
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
 */
export function statusBar(el, spec, state, { previous = null, note = '', collapsible = true } = {}) {
  const groups = statusGroups(spec, state, previous)
  if (!groups.length) return null
  const box = el('section', { class: spec.theme ? `status-bar theme-${spec.theme}` : 'status-bar' })
  if (spec.palette) paint(box, paletteColors(spec.palette))
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
      remember(PICKED_PAGE, page)
    }
    const tabs = el('div', { class: 'status-pages', role: 'tablist' }, pages.map(page => el('button', { type: 'button', role: 'tab', class: 'status-page', 'data-page': page, text: page, onclick: () => open(page) })))
    box.append(tabs)
    const picked = recalled(PICKED_PAGE)
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
  box.prepend(head)
  box.append(body)
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
