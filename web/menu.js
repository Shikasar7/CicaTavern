// The settings windows' layout (设置, 配图与朗读): a menu of panels whose rows
// each open one part on its own page, or run an action (another window). The
// title row and the save row stay in place while the middle scrolls. From a
// page, 返回 (the close button there), a click outside the window or Esc goes
// back to the menu; on the menu, or on a page the window was opened straight
// to, they close it, asking first when something typed is not saved. Everything stays
// in one form, so one 保存 saves every part.
import { t } from '/i18n.js'

// Line icons in the app's stroke style (style.css draws them).
export const MENU_ICONS = {
  picture: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="7.6" cy="8.4" r="1.4"/><path d="m3.6 14.6 4.1-4 3.1 3 2.1-2 3.5 3.3"/></svg>',
  voice: '<svg viewBox="0 0 20 20"><path d="M3.5 8.2v3.6h2.8L10 15V5L6.3 8.2z"/><path d="M13.2 7.4a3.6 3.6 0 0 1 0 5.2M15.4 5.2a6.8 6.8 0 0 1 0 9.6"/></svg>',
  mic: '<svg viewBox="0 0 20 20"><rect x="7.4" y="2.8" width="5.2" height="9.2" rx="2.6"/><path d="M4.6 9.6a5.4 5.4 0 0 0 10.8 0M10 15v2.4"/></svg>',
  model: '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="2.5"/><path d="M8 2.8v2.2M12 2.8v2.2M8 15v2.2M12 15v2.2M2.8 8h2.2M2.8 12h2.2M15 8h2.2M15 12h2.2"/></svg>',
  write: '<svg viewBox="0 0 20 20"><path d="M4 16h3.2l8.4-8.4a1.9 1.9 0 0 0-2.7-2.7L4.5 13.3z"/><path d="m11.8 6 2.7 2.7"/></svg>',
  book: '<svg viewBox="0 0 20 20"><path d="M10 5.6C8.6 4.5 6.6 4 4 4v11c2.6 0 4.6.5 6 1.6 1.4-1.1 3.4-1.6 6-1.6V4c-2.6 0-4.6.5-6 1.6z"/><path d="M10 5.6v11"/></svg>',
  link: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13M10 3.5c1.8 1.8 2.7 4 2.7 6.5s-.9 4.7-2.7 6.5c-1.8-1.8-2.7-4-2.7-6.5s.9-4.7 2.7-6.5"/></svg>',
  tools: '<svg viewBox="0 0 20 20"><path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></svg>',
}
const ICON_NEXT = '<svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5"/></svg>'
const ICON_OPEN = '<svg viewBox="0 0 20 20"><path d="M9 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h8a1.5 1.5 0 0 0 1.5-1.5v-3"/><path d="M11.5 4.5h4v4M15.5 4.5 9.5 10.5"/></svg>'
const ICON_BACK = '<svg viewBox="0 0 20 20"><path d="m12 5-5 5 5 5"/></svg>'

/** A change that waits for 保存: a named field, not a file picker, not a key field (those save at once). */
const countsAsEdit = target => Boolean(target?.name) && target.type !== 'file' && !/Key$/.test(target.name)

/**
 * The line in a panel that says whose settings follow: a card's picture (or its
 * first letter), its name and a note.
 */
export function whoLine(el, { cardId, name, note }) {
  const letter = el('span', { class: 'menu-who-mark letter', text: (name || t`卡`).slice(0, 1) })
  let mark = letter
  if (cardId) {
    mark = el('img', { class: 'menu-who-mark', src: `/api/cards/${cardId}/avatar`, alt: '' })
    mark.addEventListener('error', () => mark.replaceWith(letter), { once: true })
  }
  return el('div', { class: 'menu-who' }, [mark, el('span', { class: 'menu-who-name', text: name || t`这张卡` }), el('span', { class: 'menu-who-note', text: note })])
}

let comboCount = 0

/**
 * A text box with a list to pick from, the name still typed by hand when it is not listed: a model a service offers, say.
 * Not <input list>: a browser offers only what matches the text already in the box, so a filled box offers nothing,
 * and an Android system WebView may draw no list at all. This list opens under the box inside the page, not as a popup,
 * so a window that scrolls scrolls to it, on any screen.
 * @param el - the page's element helper.
 * @param input - the text box; its name, form and change handlers stay as they are.
 * @param options - () => the names, read each time the list opens.
 * @param empty - what the arrow says while there are none.
 * @returns box to place instead of the input; open() to show the list once there is something new in it.
 */
export function comboBox(el, { input, options, empty = '' }) {
  const id = `combo-${++comboCount}`
  const list = el('span', { id, class: 'combo-list', role: 'listbox', hidden: true })
  const arrow = el('button', { type: 'button', class: 'combo-arrow', tabindex: '-1', title: t`展开列表`, 'aria-label': t`展开列表`, html: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 8 4.5 4.5L14.5 8" /></svg>' })
  const box = el('span', { class: 'combo' }, [input, arrow, list])
  for (const [name, value] of Object.entries({ role: 'combobox', autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id })) input.setAttribute(name, value)
  const names = () => [...new Set(options().filter(Boolean))]
  // A finger's keyboard would cover the list: only a mouse gets the box focused for it.
  const focusBox = () => { if (matchMedia('(hover: hover) and (pointer: fine)').matches) input.focus({ preventScroll: true }) }
  let rows = []
  let active = -1
  let picking = false

  const outside = event => { if (!box.contains(event.target)) close() }
  function close() {
    if (list.hidden) return
    list.hidden = true
    box.classList.remove('open')
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    document.removeEventListener('pointerdown', outside, true)
  }

  function mark(index) {
    list.querySelector('.active')?.classList.remove('active')
    active = index
    const row = list.children[index]
    if (!row) return input.removeAttribute('aria-activedescendant')
    row.classList.add('active')
    input.setAttribute('aria-activedescendant', row.id)
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
  }

  function pick(name) {
    input.value = name
    picking = true
    input.dispatchEvent(new Event('input', { bubbles: true }))
    picking = false
    input.dispatchEvent(new Event('change', { bubbles: true }))
    close()
    focusBox()
  }

  /** Every name for an empty query; what has all its words otherwise, or no list when nothing does. */
  function show(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = names()
    const current = input.value.trim()
    rows = all.filter(name => terms.every(term => name.toLowerCase().includes(term)))
    if (!rows.length && (all.length || !empty || query)) return close()
    list.replaceChildren(...(rows.length
      ? rows.map((name, i) => el('button', { type: 'button', id: `${id}-${i}`, class: `combo-option${name === current ? ' current' : ''}`, role: 'option', 'aria-selected': String(name === current), text: name, onclick: () => pick(name) }))
      : [el('span', { class: 'combo-empty', text: empty })]))
    if (list.hidden) document.addEventListener('pointerdown', outside, true)
    list.hidden = false
    box.classList.add('open')
    input.setAttribute('aria-expanded', 'true')
    list.scrollTop = 0
    mark(terms.length ? -1 : rows.indexOf(current))
    list.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('input', () => { if (!picking) show(input.value) })
  input.addEventListener('click', () => { if (list.hidden && names().length) show('') })
  input.addEventListener('keydown', event => {
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (list.hidden) show('')
      else if (rows.length) mark((active + (event.key === 'ArrowDown' ? 1 : rows.length - (active < 0 ? 0 : 1))) % rows.length)
    } else if (event.key === 'Tab') close()
    else if (list.hidden) return
    else if (event.key === 'Enter') {
      // Not the form's Enter while the list is what is being answered: what was typed stays when no row is lit.
      event.preventDefault()
      if (active >= 0) pick(rows[active])
      else close()
    } else if (event.key === 'Escape') {
      // Only the list: the window it is in stays open.
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  })
  box.addEventListener('focusout', event => { if (!box.contains(event.relatedTarget)) close() })
  // A press on the arrow or a row must not take the focus from the box and close the list before the click lands.
  for (const node of [arrow, list]) node.addEventListener('mousedown', event => event.preventDefault())
  arrow.addEventListener('click', () => {
    if (!list.hidden) return close()
    show('')
    focusBox()
  })
  return {
    box,
    open() {
      show('')
      focusBox()
    },
  }
}

/**
 * @param dialog - the <dialog>; it gets the menu-dialog look.
 * @param form - the form inside it that holds every part.
 * @param el - the page's element helper.
 * @param title - the menu's own title.
 * @param edits - target => whether a change to it waits for 保存.
 * @param onPage - (shown, left) after the page changes; a page's id, or null for the menu.
 */
export function createMenu({ dialog, form, el, title: menuTitle, edits = countsAsEdit, onPage = () => {} }) {
  dialog.classList.add('menu-dialog')
  form.classList.add('menu-form')
  let sections = []
  let current = null
  let dirty = false
  let only = null // the one panel this opening shows as the menu (a window of its own), else every panel
  let view = null // the mounted layout's parts

  const setDirty = value => {
    dirty = value
    if (!view) return
    view.dirtyNote.hidden = !dirty
    view.saveButton?.classList.toggle('pending', dirty)
  }
  form.addEventListener('input', event => edits(event.target) && setDirty(true))
  form.addEventListener('change', event => edits(event.target) && setDirty(true))

  // The page the window was opened on (start), when it was opened straight to one: the level
  // above that page is whatever opened the window, not this menu.
  let entered = null
  const goesBack = () => Boolean(current) && current !== entered
  /** One level up: from a page to the menu, from the menu (or a page opened directly) out. */
  const up = () => (goesBack() ? show(null, 'back') : close())

  dialog.addEventListener('click', event => {
    if (event.target !== dialog || !goesBack()) return
    const box = dialog.getBoundingClientRect()
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
    if (outside) show(null, 'back')
  })
  // Esc is caught as a key, before it becomes a close request: a second Esc in a row is a close request
  // the page can't refuse (Chrome's close-watcher rule), and 有改动还没保存 → 取消 would close it anyway.
  dialog.addEventListener('keydown', event => {
    // Not one meant for a window opened over this one (its own Esc closes it).
    if (event.key !== 'Escape' || event.isComposing || event.target.closest?.('dialog') !== dialog) return
    event.preventDefault()
    up()
  })
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    up()
  })

  function entry(section) {
    const summary = el('span', { class: 'menu-entry-sub' })
    const status = el('span', { class: 'menu-pill', hidden: true })
    const button = el('button', {
      type: 'button',
      class: `menu-entry ${section.look ?? 'own'}${section.action ? ' action' : ''}`,
      hidden: section.hidden,
      onclick: () => (section.action ? section.action() : show(section.id, 'forward')),
    }, [
      el('span', { class: 'menu-entry-main' }, [
        el('span', { class: 'menu-entry-title' }, [section.title, section.tag ? el('span', { class: 'menu-tag', text: section.tag }) : null]),
        summary,
      ]),
      status,
      el('span', { class: 'menu-entry-go', 'aria-hidden': 'true', html: section.action ? ICON_OPEN : ICON_NEXT }),
    ])
    return { section, button, summary, status }
  }

  /**
   * Lay the window out (again). Keeps the page shown if it is still there.
   * @param panels - [{ id, title, icon, aside, rows: (section id | Node)[] }]
   * @param sections - [{ id, title, crumb, tag, look: 'own' | 'shared', summary(), status() → [kind, text] | null,
   *   body: Node[] | pane: Element (a page), or action() (another window), hidden }]
   * @param footStart / footEnd - buttons at the start / before 保存 in the save row.
   * @param save - { text, onClick } for the primary button.
   * @param search - { find: query → [[category, [{ title, place, go }]]], snippet: (item, query) → why it matched, parts: (text, query) → [{ text, hit }] }:
   *   a search box in the title row, what it finds under each category with the words searched for marked.
   */
  function mount({ panels, sections: list, note = '', footStart = [], footEnd = [], save = null, search = null }) {
    sections = list
    const entries = new Map()
    const panelNodes = panels.map(panel =>
      el('section', { class: 'menu-panel', 'data-panel': panel.id }, [
        el('header', { class: 'menu-panel-head' }, [el('span', { class: 'menu-panel-icon', 'aria-hidden': 'true', html: panel.icon }), el('h3', { text: panel.title }), panel.aside ?? null]),
        ...panel.rows.map(row => {
          if (typeof row !== 'string') return row
          const section = sections.find(s => s.id === row)
          if (!section) return null
          // A page says where it sits: its panel, unless it says more itself.
          section.crumb ??= section.tag ? `${panel.title} · ${section.tag}` : panel.title
          const made = entry(section)
          entries.set(row, made)
          return made.button
        }),
      ]),
    )
    const home = el('div', { class: 'menu-home' }, [...panelNodes, note ? el('p', { class: 'menu-home-note', text: note }) : null])
    const homeTitle = panels.find(panel => panel.id === only)?.title ?? menuTitle
    const panes = sections
      .filter(section => !section.action)
      .map(section => {
        const pane = section.pane ?? el('div', {}, section.body ?? [])
        pane.classList.add('menu-pane')
        pane.dataset.section = section.id
        pane.hidden = true
        return pane
      })
    const back = el('button', { type: 'button', class: 'btn ghost icon menu-back', 'aria-label': t`回到菜单`, title: t`回到菜单（也可以点窗口外面，或按 Esc）`, html: ICON_BACK, onclick: () => show(null, 'back') })
    const crumb = el('span', { class: 'menu-crumb', hidden: true })
    const title = el('h2', { text: homeTitle })
    const found = el('div', { class: 'menu-found', hidden: true })
    const finder = search ? el('input', { type: 'search', class: 'menu-search', placeholder: t`搜索设置`, 'aria-label': t`搜索设置` }) : null
    finder?.addEventListener('input', () => drawFound(search))
    finder?.addEventListener('keydown', event => {
      // Enter would send the form; Esc clears the box first.
      if (event.key === 'Enter') {
        event.preventDefault()
        found.querySelector('button')?.click()
      } else if (event.key === 'Escape' && finder.value) {
        event.preventDefault()
        event.stopPropagation()
        finder.value = ''
        drawFound(search)
      }
    })
    const body = el('div', { class: 'menu-body' }, [home, ...panes, found])
    const dirtyNote = el('span', { class: 'menu-dirty', hidden: true, text: t`有改动还没保存` })
    const saveButton = save ? el('button', { type: 'button', class: 'btn primary', text: save.text ?? t`保存`, onclick: save.onClick }) : null
    const closeButton = el('button', { type: 'button', class: 'btn', text: t`关闭`, onclick: () => up() })
    form.replaceChildren(
      el('div', { class: 'menu-head' }, [back, el('div', { class: 'menu-titles' }, [crumb, title]), finder]),
      body,
      el('div', { class: 'menu-foot' }, [
        el('div', { class: 'row' }, footStart),
        el('div', { class: 'row' }, [dirtyNote, ...footEnd, closeButton, saveButton]),
      ]),
    )
    view = { home, homeTitle, panels: panelNodes, panes, back, crumb, title, body, found, finder, entries, dirtyNote, saveButton, closeButton }
    setDirty(dirty)
    show(sections.some(s => s.id === current && !s.action) ? current : null)
  }

  /** What the box found, in place of the menu or the page; with nothing typed they come back. */
  function drawFound({ find, snippet, parts }) {
    const query = view.finder.value.trim()
    view.found.hidden = !query
    view.home.hidden = Boolean(query || current)
    for (const pane of view.panes) pane.hidden = Boolean(query) || pane.dataset.section !== current
    if (!query) return
    const marked = text => parts(text, query).map(part => (part.hit ? el('mark', { text: part.text }) : part.text))
    const row = item => el('button', { type: 'button', class: 'menu-entry shared action', onclick: () => {
      view.finder.value = ''
      view.found.hidden = true
      show(current)
      item.go()
    } }, [
      el('span', { class: 'menu-entry-main' }, [
        el('span', { class: 'menu-entry-title' }, el('span', {}, marked(item.title))),
        el('span', { class: 'menu-entry-sub' }, marked([item.place, snippet(item, query)].filter(Boolean).join(' · '))),
      ]),
      el('span', { class: 'menu-entry-go', 'aria-hidden': 'true', html: ICON_NEXT }),
    ])
    const groups = find(query)
    view.found.replaceChildren(...(groups.length ? groups.map(([name, items]) => el('section', { class: 'menu-panel' }, [
      el('header', { class: 'menu-panel-head' }, [el('h3', { text: name })]),
      ...items.map(row),
    ])) : [el('p', { class: 'menu-found-none', text: t`没有找到「${query}」` })]))
    view.body.scrollTop = 0
  }

  /** One page ('forward' from the menu), or the menu (null, 'back'). Typed values stay. */
  function show(id = null, direction = '') {
    if (!view) return
    if (view.finder) {
      view.finder.value = ''
      view.found.hidden = true
    }
    const section = sections.find(s => s.id === id && !s.action) ?? null
    const was = current
    current = section?.id ?? null
    // Once on the menu, every page is one level below it.
    if (!section) entered = null
    view.closeButton.textContent = goesBack() ? t`返回` : t`关闭`
    view.home.hidden = Boolean(section)
    for (const pane of view.panes) pane.hidden = pane.dataset.section !== current
    view.back.hidden = !section
    view.crumb.hidden = !section?.crumb
    view.crumb.textContent = section?.crumb ?? ''
    view.title.textContent = section ? section.title : view.homeTitle
    if (!section) refresh()
    view.body.scrollTop = 0
    // The row clicked (or the page left) is hidden now: focus stays in the window, so its next Esc is the
    // menu's one level up rather than the browser closing the window from the page behind it.
    const focused = document.activeElement
    if (!dialog.contains(focused) || focused.closest('[hidden]')) (section ? view.back : view.entries.get(was)?.button)?.focus({ preventScroll: true })
    const shown = section ? view.panes.find(pane => pane.dataset.section === current) : view.home
    if (direction && shown && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.classList.remove('enter-forward', 'enter-back')
      void shown.offsetWidth
      shown.classList.add(`enter-${direction}`)
    }
    if (was !== current) onPage(current, was)
  }

  /** Each row's summary and status, as the form shows the settings now. */
  function refresh() {
    for (const { section, button, summary, status } of view?.entries.values() ?? []) {
      button.hidden = Boolean(typeof section.hidden === 'function' ? section.hidden() : section.hidden)
      summary.textContent = section.summary?.() ?? ''
      // 'need': nothing usable set up yet; the whole row stands out.
      const [kind, text] = section.status?.() ?? []
      status.hidden = !kind
      status.className = `menu-pill ${kind ?? ''}`
      status.textContent = text ?? ''
      button.classList.toggle('need', kind === 'need')
    }
    // A panel with every row hidden goes too (the phone app has nothing under 连接).
    for (const panel of view?.panels ?? []) {
      panel.hidden = (only && panel.dataset.panel !== only) || [...panel.children].slice(1).every(row => row.hidden)
      // On its own under its own title: its head needn't say the name again.
      panel.classList.toggle('alone', only === panel.dataset.panel)
    }
  }

  /** Close; with unsaved changes, ask first. */
  function close() {
    if (dirty && !confirm(t`有改动还没保存，关掉就不要了？`)) return false
    setDirty(false)
    dialog.close()
    return true
  }

  return {
    mount,
    show,
    refresh,
    close,
    /**
     * Before showing the dialog: start on a page, or on the menu.
     * @param panel - a panel's id: the menu is that panel alone, under its title.
     */
    start(id = null, panel = null) {
      current = id
      entered = id
      only = panel
      setDirty(false)
    },
    get current() {
      return current
    },
    get dirty() {
      return dirty
    },
    markClean: () => setDirty(false),
  }
}
