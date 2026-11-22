// 手机上的下拉框: a phone's own list for a <select> (Android's is a plain system dialog in a large font) gives way to
// a sheet that slides up from the bottom in the page's own look. A tap on a select is caught as the finger lifts
// (touchend, default prevented: no click, so the system list does not open); a drag that scrolls the page is left
// alone. Picking sets the select's value and fires input and change, as the system list would. A select with
// `multiple`, a size, or data-native keeps the system's.
import { t } from '/i18n.js'

const TAP_SLOP = 10 // px a finger may move and still tap
let installed = false

/** Catch taps on selects from now on (touch screens only). */
export function installSelectSheet() {
  if (installed) return
  installed = true
  let start = null
  document.addEventListener('touchstart', event => {
    const select = ownSelect(event.target)
    start = select && event.touches.length === 1 ? { select, x: event.touches[0].clientX, y: event.touches[0].clientY } : null
  }, { passive: true, capture: true })
  document.addEventListener('touchend', event => {
    const begun = start
    start = null
    if (!begun || ownSelect(event.target) !== begun.select) return
    const touch = event.changedTouches[0]
    if (!touch || Math.hypot(touch.clientX - begun.x, touch.clientY - begun.y) > TAP_SLOP) return
    event.preventDefault()
    openSheet(begun.select)
  }, { passive: false, capture: true })
}

function ownSelect(target) {
  const select = target?.closest?.('select')
  if (!select || select.disabled || select.multiple || select.size > 1 || select.hasAttribute('data-native')) return null
  return select
}

/** What the select is for: its label's own words (not the options inside it), else its aria-label or title. */
function nameOf(select) {
  const label = select.labels?.[0]
  if (label) {
    const copy = label.cloneNode(true)
    for (const inner of copy.querySelectorAll('select, input, textarea, button, .hint, small')) inner.remove()
    // A note in brackets after the name (「这个对话用的模型（缓存按模型区分…）」) stays on the page.
    const text = copy.textContent.replace(/\s*[（(][^（）()]*[）)]/g, '').replace(/\s+/g, ' ').trim()
    if (text) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  return (select.getAttribute('aria-label') || select.title || '').replace(/\s*[（(][^（）()]*[）)]/g, '').trim()
}

const CHECK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>'

function openSheet(select) {
  const sheet = document.createElement('dialog')
  sheet.className = 'select-sheet'
  const name = nameOf(select)
  const head = document.createElement('div')
  head.className = 'select-sheet-head'
  const grip = document.createElement('span')
  grip.className = 'select-sheet-grip'
  head.append(grip)
  if (name) {
    const title = document.createElement('p')
    title.className = 'select-sheet-title'
    title.textContent = name
    head.append(title)
  }
  const list = document.createElement('div')
  list.className = 'select-sheet-list'
  list.setAttribute('role', 'listbox')
  if (name) list.setAttribute('aria-label', name)
  let chosen = null
  const option = item => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'select-sheet-option'
    button.setAttribute('role', 'option')
    const selected = item.index === select.selectedIndex
    button.setAttribute('aria-selected', String(selected))
    button.disabled = item.disabled
    const text = document.createElement('span')
    text.textContent = item.label || item.text
    const mark = document.createElement('span')
    mark.className = 'select-sheet-check'
    mark.innerHTML = selected ? CHECK : ''
    button.append(text, mark)
    button.addEventListener('click', () => {
      chosen = item.index
      close()
    })
    return button
  }
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      const group = document.createElement('p')
      group.className = 'select-sheet-group'
      group.textContent = child.label
      list.append(group, ...[...child.children].filter(o => !o.hidden).map(option))
    } else if (child.tagName === 'OPTION' && !child.hidden) {
      list.append(option(child))
    }
  }
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'select-sheet-cancel'
  cancel.textContent = t`取消`
  cancel.addEventListener('click', () => close())
  sheet.append(head, list, cancel)

  let closing = false
  function close() {
    if (closing) return
    closing = true
    sheet.classList.add('leaving')
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      if (sheet.open) sheet.close()
      sheet.remove()
      if (chosen !== null && chosen !== select.selectedIndex) {
        select.selectedIndex = chosen
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      select.focus({ preventScroll: true })
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
    sheet.addEventListener('animationend', done, { once: true })
    // In case the animation never runs (a page in the background).
    setTimeout(done, 400)
  }
  // A tap on the dimmed page above the sheet, the phone's Back or Esc: nothing picked.
  sheet.addEventListener('click', event => {
    if (event.target === sheet) close()
  })
  sheet.addEventListener('cancel', event => {
    event.preventDefault()
    close()
  })
  document.body.append(sheet)
  sheet.showModal()
  // The sheet's own first button would take the focus: the list starts at the chosen one instead, in sight.
  const current = list.querySelector('[aria-selected="true"]')
  if (current) {
    current.focus({ preventScroll: true })
    const top = current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2
    list.scrollTop = Math.max(0, top)
  }
}
