// What the page draws around a reply on its own, in the app's look (no card
// HTML, no frames): the built-in preset's time box and choices, and the status
// bar (web/shared/status.js decides what goes in it).
import { t } from '/i18n.js'
import { statusGroups } from '/shared/status.js'

const COLLAPSED = 'statusBarCollapsed'

function remembered() {
  try {
    return localStorage.getItem(COLLAPSED) === '1'
  } catch {
    return false
  }
}

function remember(collapsed) {
  try {
    localStorage.setItem(COLLAPSED, collapsed ? '1' : '0')
  } catch {
    // Private windows: it just opens again next time.
  }
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

function statusRow(el, row) {
  const label = el('span', { class: 'status-label', text: row.label, title: row.path })
  const change = row.delta ? el('span', { class: `status-delta ${row.delta > 0 ? 'up' : 'down'}`, text: delta(row.delta) }) : null
  if (row.show === 'meter') {
    const bar = el('span', { class: 'status-meter', role: 'meter', 'aria-valuenow': String(row.value), 'aria-label': row.label }, el('i', { style: `width:${row.percent.toFixed(1)}%` }))
    return el('div', { class: 'status-row' }, [label, bar, el('span', { class: 'status-value' }, [el('span', { text: shown(row.value) }), change])])
  }
  if (row.show === 'number') {
    return el('div', { class: 'status-row' }, [label, el('span', { class: 'status-text' }, [el('span', { text: shown(row.value) }), change])])
  }
  if (row.show === 'tags') {
    const tags = row.tags.length ? row.tags.map(tag => el('span', { class: 'status-tag', text: tag })) : [el('span', { class: 'status-none', text: t`无` })]
    return el('div', { class: 'status-row' }, [label, el('span', { class: 'status-tags' }, tags)])
  }
  if (row.show === 'flag') {
    return el('div', { class: 'status-row' }, [label, el('span', { class: `status-flag${row.on ? ' on' : ''}`, text: row.on ? t`是` : t`否` })])
  }
  return el('div', { class: 'status-row' }, [label, el('span', { class: 'status-text', text: row.text || '—' })])
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
  const named = groups.filter(g => g.name).length
  const title = spec.title || (named === 1 && groups.length === 1 ? groups[0].name : '') || t`状态`
  const head = el('div', { class: 'status-head' }, [el('span', { class: 'status-title', text: title }), note ? el('span', { class: 'status-note', text: note }) : null])
  const body = el('div', { class: 'status-body' })
  for (const group of groups) {
    const showName = group.name && group.name !== title
    body.append(el('div', { class: 'status-group' }, [showName ? el('div', { class: 'status-group-name', text: group.name }) : null, ...group.rows.map(row => statusRow(el, row))]))
  }
  if (collapsible) {
    const toggle = el('button', { type: 'button', class: 'status-toggle' })
    const set = collapsed => {
      box.classList.toggle('collapsed', collapsed)
      toggle.textContent = collapsed ? t`展开` : t`收起`
      toggle.setAttribute('aria-expanded', String(!collapsed))
    }
    set(remembered())
    toggle.addEventListener('click', () => {
      const collapsed = !box.classList.contains('collapsed')
      set(collapsed)
      remember(collapsed)
    })
    head.append(toggle)
  }
  box.append(head, body)
  return box
}

/**
 * The four choices under the latest reply. Tapping one puts it in the input box
 * to edit; its arrow sends it as it is.
 */
export function choiceList(el, items, { onFill, onSend, disabled = false }) {
  return el('div', { class: 'choices', role: 'group', 'aria-label': t`行动选项` }, items.map((text, i) => {
    const letter = 'ABCD'[i]
    return el('div', { class: 'choice-item' }, [
      el('button', { type: 'button', class: 'choice-fill', disabled, title: t`填进输入框，可以改了再发`, onclick: () => onFill(text) }, [
        el('span', { class: 'choice-letter', text: letter }),
        el('span', { class: 'choice-text', text }),
      ]),
      el('button', { type: 'button', class: 'choice-send', disabled, title: t`直接发送`, 'aria-label': t`直接发送：${text}`, html: SEND, onclick: () => onSend(text) }),
    ])
  }))
}
