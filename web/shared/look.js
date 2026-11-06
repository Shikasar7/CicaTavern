// 界面主题: how the visual novel, the fights and the rolls look. What is pure about it is here, for the tests; the page's part is web/game-look.js.

export const LOOKS = ['plain', 'ink', 'console', 'bold']
export const PALETTES = { plain: [], ink: ['ink', 'qing'], console: ['blue', 'teal', 'plum'], bold: ['gold', 'ice', 'night'] }
/** 场景滤镜 (酷炫): how much of the scene its colour wash takes, in percent. */
export const STRENGTH = 45

// What is solid in a cut-out picture, and how much of a row counts as the figure starting.
const SOLID = 40
const TOP_BAND = 0.2
// Where to look for a face: the upper part of the figure. A head is about this many times as wide as what shows of the face.
const FACE_REACH = 0.5
const HEAD_PER_FACE = 2.3
const FACE_ROWS = 1.25
const NEAR_BEST = 0.55
const WIDEST_FACE = 0.75
const MIN_FACE = 6
const SMALLEST_HEAD = 0.42
// Without a face to go by: the taller a figure is for its width, the smaller its head.
const HEAD_BY_SHAPE = 0.6

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/** What was kept, made safe: a look it knows, a palette of that look, a strength in range. */
export function cleanLook(saved) {
  const look = LOOKS.includes(saved?.look) ? saved.look : 'plain'
  const palettes = PALETTES[look]
  const palette = palettes.includes(saved?.palette) ? saved.palette : palettes[0] ?? ''
  const strength = Number.isFinite(saved?.strength) ? clamp(Math.round(saved.strength), 0, 100) : STRENGTH
  return { look, palette, strength }
}

/** Skin as pictures draw it: warm, neither grey nor the yellow of fair hair. `dark` lets in browner skin, and browner hair with it. */
function isSkin(r, g, b, dark) {
  return r > 140 && r - g > 5 && r - g < 75 && g - b > 2 && r - b > 16 && (dark ? r - b < 110 : r - b < 82 && b > 118)
}

/** The rows and columns the figure takes. → { top, bottom, left, right }, or null with nothing solid in it. */
function figureBox({ data, width, height }) {
  const enough = Math.max(2, width * 0.01)
  let [top, bottom, left, right] = [-1, -1, width, -1]
  for (let y = 0; y < height; y++) {
    let count = 0
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= SOLID) continue
      count++
      if (x < left) left = x
      if (x > right) right = x
    }
    if (count < enough) continue
    if (top < 0) top = y
    bottom = y
  }
  return top < 0 ? null : { top, bottom, left, right }
}

/** Patches of skin in the rows given, each as { top, left, right, cells, rows (row → [from, to]) }. */
function skinPatches({ data, width }, top, end, dark) {
  const seen = new Uint8Array(width * end)
  const skin = i => data[i * 4 + 3] > 128 && isSkin(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], dark)
  const patches = []
  for (let y = top; y < end; y++) for (let x = 0; x < width; x++) {
    const start = y * width + x
    if (seen[start] || !skin(start)) continue
    seen[start] = 1
    const patch = { top: y, left: x, right: x, cells: 0, rows: new Map() }
    const waiting = [start]
    while (waiting.length) {
      const at = waiting.pop()
      const [cx, cy] = [at % width, Math.floor(at / width)]
      patch.cells++
      patch.left = Math.min(patch.left, cx)
      patch.right = Math.max(patch.right, cx)
      const row = patch.rows.get(cy)
      patch.rows.set(cy, row ? [Math.min(row[0], cx), Math.max(row[1], cx), row[2] + 1] : [cx, cx, 1])
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (nx < 0 || nx >= width || ny < top || ny >= end) continue
        const next = ny * width + nx
        if (seen[next] || !skin(next)) continue
        seen[next] = 1
        waiting.push(next)
      }
    }
    patches.push(patch)
  }
  return patches
}

/** The sides of a patch, row by row from its top, as far down as a face that wide goes: a neck and shoulders may hang on. → { top, left, right, width, score } */
function asFace(patch, box) {
  let [left, right, rows, cells] = [Infinity, -1, 0, 0]
  for (const y of [...patch.rows.keys()].sort((a, b) => a - b)) {
    if (rows > MIN_FACE && y - patch.top > (right - left + 1) * FACE_ROWS) break
    const [from, to, count] = patch.rows.get(y)
    left = Math.min(left, from)
    right = Math.max(right, to)
    rows++
    cells += count
  }
  const width = right - left + 1
  const depth = (patch.top - box.top) / ((box.bottom - box.top + 1) * FACE_REACH)
  const fill = cells / (width * rows)
  return { top: patch.top, bottom: patch.top + rows, left, right, width, score: cells * fill ** 2 * (Math.min(width, rows) / Math.max(width, rows)) * (1 - depth) ** 3 }
}

/** The face among the patches, as its top and sides; undefined with none like one. */
function pickFace(patches, box) {
  const all = patches.map(patch => asFace(patch, box))
  const widest = (box.right - box.left + 1) * WIDEST_FACE
  const likely = all.filter(face => face.width >= MIN_FACE && face.width < widest)
  if (!likely.length) return undefined
  const best = Math.max(...likely.map(face => face.score))
  // Of those near the best, the highest: under a face come a neck and a chest, as big and often bigger.
  const first = likely.filter(item => item.score >= best * NEAR_BEST).sort((a, b) => a.top - b.top)[0]
  const face = { ...first }
  // What eyes, hair and shadows cut off it: under it, or beside it at the same height.
  for (const other of all) {
    if (other === first || other.width > first.width * 1.8 || other.top > first.top + first.width * FACE_ROWS) continue
    const shared = Math.min(other.right, first.right) - Math.max(other.left, first.left) + 1
    const under = other.top >= first.top && shared >= other.width * 0.6
    const gap = Math.max(other.left - first.right, first.left - other.right)
    const beside = Math.abs(other.top - first.top) < first.width * 0.4 && gap < first.width * 0.25 && other.width >= first.width * 0.4
    if (!under && !beside) continue
    face.left = Math.min(face.left, other.left)
    face.right = Math.max(face.right, other.right)
    face.bottom = Math.max(face.bottom, other.bottom)
  }
  face.width = Math.min(face.right - face.left + 1, first.width * 1.8)
  face.bottom = Math.min(face.bottom, face.top + face.width * FACE_ROWS)
  return face
}

/**
 * Where a figure's head is in a cut-out picture, by its face, or by its outline where no face shows.
 * @param image - { data: RGBA bytes, width, height }, as canvas gives it
 * → { x, y (its middle), side (how big it is) }: x as a share of the width, y and side of the height. null with nothing solid in it.
 */
export function faceOf(image) {
  const { data, width, height } = image
  const box = figureBox(image)
  if (!box) return null
  const tall = box.bottom - box.top + 1
  const end = Math.min(height, box.top + Math.ceil(tall * FACE_REACH))
  const face = pickFace(skinPatches(image, box.top, end, false), box) ?? pickFace(skinPatches(image, box.top, end, true), box)
  if (face) {
    // What shows of a face may be only its brow: a head is never much smaller than the figure's own shape says.
    const side = Math.min(Math.max(face.width * HEAD_PER_FACE, (box.right - box.left + 1) * SMALLEST_HEAD), tall)
    return { x: (face.left + face.right + 1) / 2 / width, y: Math.max(box.top + side / 2, (face.top + face.bottom) / 2 - side * 0.04) / height, side: side / height }
  }
  let sum = 0
  let count = 0
  for (let y = box.top; y < Math.min(height, box.top + Math.ceil(tall * TOP_BAND)); y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= SOLID) continue
    sum += x
    count++
  }
  const side = clamp((HEAD_BY_SHAPE * (box.right - box.left + 1)) / tall, 0.2, 0.7) * tall
  return { x: sum / count / width, y: (box.top + side / 2) / height, side: side / height }
}

/**
 * The square of a picture around the head, as background-size and background-position in percent, so it fits a frame of any size.
 * @param face - faceOf's answer
 */
export function headCrop(face, width, height) {
  const side = Math.min(face.side * height, width, height)
  const left = clamp(face.x * width - side / 2, 0, width - side)
  const top = clamp(face.y * height - side / 2, 0, height - side)
  return { size: (width / side) * 100, x: width > side ? (left / (width - side)) * 100 : 0, y: height > side ? (top / (height - side)) * 100 : 0 }
}
