// Drag a row by its handle to another place in its list (预设条目, 世界书条目): a mouse, a pen and a finger alike,
// by pointer events on the handle (touch-action: none there, so a finger on the rest of the row still scrolls).
// The list scrolls itself when the row is held near its top or bottom edge. Loaded when a list is first drawn
// (presets.js, books.js): a server started before this file existed leaves the lists without it, nothing else.

/** The nearest scrolling box around `node` (the dialog's body), or the page. */
function scrollerOf(node) {
  for (let box = node.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box)
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight) return box
  }
  return document.scrollingElement
}

/**
 * Rows of `list` (`rows`, a selector of its children, each with a data-key attribute… named by `key`) move by their
 * `handle`. Let go somewhere else: `onMove(keys)` with every row's key in the new order, the hidden ones (a search
 * that filters the list) where they were; it saves, and draws the list again from what was saved when that fails.
 * The handles show once this is set up (the list's can-sort class).
 */
export function sortRows(list, { rows, handle, key, onMove }) {
  list.classList.add('can-sort')
  const children = () => [...list.children].filter(child => child.matches(rows))
  list.addEventListener('pointerdown', event => {
    const grip = event.target.closest?.(handle)
    if (!grip || !list.contains(grip) || event.button > 0) return
    const row = grip.closest(rows)
    if (!row || row.parentElement !== list) return
    event.preventDefault()
    const before = children()
    const keys = before.map(child => child.dataset[key])
    const scroller = scrollerOf(list)
    let y = event.clientY
    let roll = 0
    // Every move comes to the handle, wherever the pointer goes (a pointer the browser no longer knows: as it is).
    try {
      grip.setPointerCapture(event.pointerId)
    } catch {}
    row.classList.add('dragging')
    list.classList.add('sorting')

    // The row goes in front of the first other row whose middle is below the pointer; past them all, last.
    const place = () => {
      const others = children().filter(child => child !== row && !child.hidden && child.getClientRects().length)
      const next = others.find(other => {
        const box = other.getBoundingClientRect()
        return y < box.top + box.height / 2
      })
      if (next) {
        if (row.nextElementSibling !== next) list.insertBefore(row, next)
      } else if (others.length && others.at(-1).nextElementSibling !== row) {
        others.at(-1).after(row)
      }
    }
    // Held near an edge of the scrolling box: it scrolls, a little more the closer.
    const edge = () => {
      const box = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect()
      const zone = 48
      const step = y < box.top + zone ? -Math.ceil((box.top + zone - y) / 6) : y > box.bottom - zone ? Math.ceil((y - box.bottom + zone) / 6) : 0
      if (step) {
        scroller.scrollTop += step
        place()
      }
      roll = requestAnimationFrame(edge)
    }
    roll = requestAnimationFrame(edge)

    const move = moved => {
      y = moved.clientY
      place()
    }
    const end = async done => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', cancel)
      cancelAnimationFrame(roll)
      row.classList.remove('dragging')
      list.classList.remove('sorting')
      const after = children().map(child => child.dataset[key])
      const putBack = () => list.append(...before)
      if (!done) return putBack()
      if (after.join('\n') === keys.join('\n')) return
      try {
        await onMove(after)
      } catch (error) {
        putBack()
        throw error
      }
    }
    const up = () => end(true)
    const cancel = () => end(false)
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', cancel)
  })
}

