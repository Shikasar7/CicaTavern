// The settings windows' layout (设置, 配图与朗读): a menu of panels whose rows
// each open one part on its own page, or run an action (another window). The
// title row and the save row stay in place while the middle scrolls. From a
// page, a click outside the window or Esc goes back to the menu; on the menu
// Esc closes, asking first when something typed is not saved. Everything stays
// in one form, so one 保存 saves every part.

// Line icons in the app's stroke style (style.css draws them).
export const MENU_ICONS = {
  picture: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="7.6" cy="8.4" r="1.4"/><path d="m3.6 14.6 4.1-4 3.1 3 2.1-2 3.5 3.3"/></svg>',
  voice: '<svg viewBox="0 0 20 20"><path d="M3.5 8.2v3.6h2.8L10 15V5L6.3 8.2z"/><path d="M13.2 7.4a3.6 3.6 0 0 1 0 5.2M15.4 5.2a6.8 6.8 0 0 1 0 9.6"/></svg>',
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
  const letter = el('span', { class: 'menu-who-mark letter', text: (name || '卡').slice(0, 1) })
  let mark = letter
  if (cardId) {
    mark = el('img', { class: 'menu-who-mark', src: `/api/cards/${cardId}/avatar`, alt: '' })
    mark.addEventListener('error', () => mark.replaceWith(letter), { once: true })
  }
  return el('div', { class: 'menu-who' }, [mark, el('span', { class: 'menu-who-name', text: name || '这张卡' }), el('span', { class: 'menu-who-note', text: note })])
}

/**
 * @param dialog - the <dialog>; it gets the menu-dialog look.
 * @param form - the form inside it that holds every part.
 * @param el - the page's element helper.
 * @param title - the menu's own title.
 * @param edits - target => whether a change to it waits for 保存.
 */
export function createMenu({ dialog, form, el, title: menuTitle, edits = countsAsEdit }) {
  dialog.classList.add('menu-dialog')
  form.classList.add('menu-form')
  let sections = []
  let current = null
  let dirty = false
  let view = null // the mounted layout's parts

  const setDirty = value => {
    dirty = value
    if (!view) return
    view.dirtyNote.hidden = !dirty
    view.saveButton?.classList.toggle('pending', dirty)
  }
  form.addEventListener('input', event => edits(event.target) && setDirty(true))
  form.addEventListener('change', event => edits(event.target) && setDirty(true))

  dialog.addEventListener('click', event => {
    if (event.target !== dialog || !current) return
    const box = dialog.getBoundingClientRect()
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
    if (outside) show(null, 'back')
  })
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    if (current) show(null, 'back')
    else close()
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
   */
  function mount({ panels, sections: list, note = '', footStart = [], footEnd = [], save = null }) {
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
    const panes = sections
      .filter(section => !section.action)
      .map(section => {
        const pane = section.pane ?? el('div', {}, section.body ?? [])
        pane.classList.add('menu-pane')
        pane.dataset.section = section.id
        pane.hidden = true
        return pane
      })
    const back = el('button', { type: 'button', class: 'btn ghost icon menu-back', 'aria-label': '回到菜单', title: '回到菜单（也可以点窗口外面，或按 Esc）', html: ICON_BACK, onclick: () => show(null, 'back') })
    const crumb = el('span', { class: 'menu-crumb', hidden: true })
    const title = el('h2', { text: menuTitle })
    const body = el('div', { class: 'menu-body' }, [home, ...panes])
    const dirtyNote = el('span', { class: 'menu-dirty', hidden: true, text: '有改动还没保存' })
    const saveButton = save ? el('button', { type: 'button', class: 'btn primary', text: save.text ?? '保存', onclick: save.onClick }) : null
    form.replaceChildren(
      el('div', { class: 'menu-head' }, [back, el('div', { class: 'menu-titles' }, [crumb, title])]),
      body,
      el('div', { class: 'menu-foot' }, [
        el('div', { class: 'row' }, footStart),
        el('div', { class: 'row' }, [dirtyNote, ...footEnd, el('button', { type: 'button', class: 'btn', text: '关闭', onclick: () => close() }), saveButton]),
      ]),
    )
    view = { home, panels: panelNodes, panes, back, crumb, title, body, entries, dirtyNote, saveButton }
    setDirty(dirty)
    show(sections.some(s => s.id === current && !s.action) ? current : null)
  }

  /** One page ('forward' from the menu), or the menu (null, 'back'). Typed values stay. */
  function show(id = null, direction = '') {
    if (!view) return
    const section = sections.find(s => s.id === id && !s.action) ?? null
    current = section?.id ?? null
    view.home.hidden = Boolean(section)
    for (const pane of view.panes) pane.hidden = pane.dataset.section !== current
    view.back.hidden = !section
    view.crumb.hidden = !section?.crumb
    view.crumb.textContent = section?.crumb ?? ''
    view.title.textContent = section ? section.title : menuTitle
    if (!section) refresh()
    view.body.scrollTop = 0
    const shown = section ? view.panes.find(pane => pane.dataset.section === current) : view.home
    if (direction && shown && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shown.classList.remove('enter-forward', 'enter-back')
      void shown.offsetWidth
      shown.classList.add(`enter-${direction}`)
    }
  }

  /** Each row's summary and status, as the form shows the settings now. */
  function refresh() {
    for (const { section, button, summary, status } of view?.entries.values() ?? []) {
      button.hidden = Boolean(typeof section.hidden === 'function' ? section.hidden() : section.hidden)
      summary.textContent = section.summary?.() ?? ''
      const [kind, text] = section.status?.() ?? []
      status.hidden = !kind
      status.className = `menu-pill ${kind ?? ''}`
      status.textContent = text ?? ''
    }
    // A panel with every row hidden goes too (the phone app has nothing under 连接).
    for (const panel of view?.panels ?? []) panel.hidden = [...panel.children].slice(1).every(row => row.hidden)
  }

  /** Close; with unsaved changes, ask first. */
  function close() {
    if (dirty && !confirm('有改动还没保存，关掉就不要了？')) return false
    setDirty(false)
    dialog.close()
    return true
  }

  return {
    mount,
    show,
    refresh,
    close,
    /** Before showing the dialog: start on a page, or on the menu. */
    start(id = null) {
      current = id
      setDirty(false)
    },
    get current() {
      return current
    },
    markClean: () => setDirty(false),
  }
}
