// Edges and corners a floating panel is resized by (剧情向导, a card script's docked panel): pressed and dragged, the
// edge follows the pointer. The panel says what a new size does (its own way of keeping it, and of placing itself).

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** A kept size, or null for none (or one that is not a size). */
export function readSize(key) {
  try {
    const kept = JSON.parse(localStorage.getItem(key) || 'null')
    return kept && Number.isFinite(kept.w) && Number.isFinite(kept.h) && kept.w > 0 && kept.h > 0 ? kept : null
  } catch {
    return null
  }
}

export function keepSize(key, size) {
  try {
    if (size) localStorage.setItem(key, JSON.stringify({ w: Math.round(size.w), h: Math.round(size.h) }))
    else localStorage.removeItem(key)
  } catch {}
}

/**
 * The new box for a drag of `edge` by (dx, dy) from `start` (all in screen pixels), kept at least `min` and inside a
 * `view` of that width and height: the edge that does not move stays where it was.
 */
export function resizedBox(start, edge, dx, dy, min, view) {
  let { left, top } = start
  let right = start.left + start.width
  let bottom = start.top + start.height
  if (edge.includes('w')) left = Math.min(Math.max(0, start.left + dx), right - min.w)
  if (edge.includes('e')) right = Math.max(Math.min(view.w, right + dx), left + min.w)
  if (edge.includes('n')) top = Math.min(Math.max(0, start.top + dy), bottom - min.h)
  if (edge.includes('s')) bottom = Math.max(Math.min(view.h, bottom + dy), top + min.h)
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Puts the grips on `panel`. `allowed()` says whether it may be resized now (not as a phone's sheet, not as the big
 * window); `onResize(box, edge)` gets the new box: `left` and `top` in screen pixels, `w` and `h` in the page's own
 * (the screen's divided by the page zoom, what a width in CSS is); `onEnd()` when the pointer is let go, to keep it.
 */
export function addResizeGrips(panel, { el, min = { w: 280, h: 240 }, allowed = () => true, onStart = () => {}, onResize, onEnd = () => {} }) {
  const grips = EDGES.map(edge => el('div', { class: `rs-grip rs-${edge}`, 'data-edge': edge, 'aria-hidden': 'true' }))
  panel.append(...grips)
  for (const grip of grips) {
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !allowed()) return
      event.preventDefault()
      event.stopPropagation()
      const edge = grip.dataset.edge
      const rect = panel.getBoundingClientRect()
      const zoom = panel.offsetWidth ? rect.width / panel.offsetWidth : 1
      const start = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      const scaled = { w: min.w * zoom, h: min.h * zoom }
      grip.setPointerCapture?.(event.pointerId)
      panel.classList.add('resizing')
      onStart()
      const move = moved => {
        const box = resizedBox(start, edge, moved.clientX - event.clientX, moved.clientY - event.clientY, scaled, { w: window.innerWidth, h: window.innerHeight })
        onResize({ left: box.left, top: box.top, w: box.width / zoom, h: box.height / zoom }, edge)
      }
      const end = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', end)
        grip.removeEventListener('pointercancel', end)
        panel.classList.remove('resizing')
        onEnd()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', end)
      grip.addEventListener('pointercancel', end)
    })
    // A double click on an edge is not one on the title row (which puts the panel back).
    grip.addEventListener('dblclick', event => event.stopPropagation())
  }
}
