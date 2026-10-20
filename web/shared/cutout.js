// 立绘 for the visual novel mode (web/vn.js): a character drawn on a plain
// background, the background made see-through. The background is what the
// edges mostly are; it is cleared from the edges inwards as far as it reaches,
// so a white collar inside the outline stays. Pixel data as canvas gives it
// ({ data: RGBA bytes, width, height }); shared with the tests.

/** The largest difference in any channel between pixel `i` and a colour. */
const distance = (data, i, [r, g, b]) => Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b))

/**
 * The colour most of the edge is (to within 16 per channel), and how much of
 * the edge it is. Only the top and the upper sides: a half-body picture is cut
 * off at the bottom, and wide sleeves can fill the lower sides.
 */
function edgeColour(data, width, height, cleared) {
  const counts = new Map()
  let total = 0
  const look = (x, y) => {
    const p = y * width + x
    if (cleared[p]) return
    const i = p * 4
    if (data[i + 3] < 16) return
    total++
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    entry.n++
    entry.r += data[i]
    entry.g += data[i + 1]
    entry.b += data[i + 2]
    counts.set(key, entry)
  }
  // Just inside any bars: the first pixel down each column, in from each side of the upper rows.
  for (let x = 0; x < width; x++) {
    let y = 0
    while (y < height - 1 && cleared[y * width + x]) y++
    look(x, y)
  }
  for (let y = 0; y < height * 0.55; y++) {
    let left = 0
    while (left < width - 1 && cleared[y * width + left]) left++
    let right = width - 1
    while (right > 0 && cleared[y * width + right]) right--
    if (left > right) continue
    look(left, y)
    look(right, y)
  }
  let best = null
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry
  if (!best || !total) return null
  return { colour: [best.r / best.n, best.g / best.n, best.b / best.n], share: best.n / total }
}

/**
 * Letterbox bars: flat rows at both top and bottom (or columns at both sides)
 * of the same colour, marked as background. One flat edge alone is not a bar
 * (a robe of one flat colour can fill the bottom row).
 */
function clearBars(data, width, height, cleared) {
  const limit = Math.floor(Math.min(width, height) / 4)
  // How many lines in from an edge are each one flat colour (a bar may fade a little line by line), and the outermost colour.
  const run = (count, at) => {
    let n = 0
    let colour = null
    let previous = null
    for (; n < limit; n++) {
      const first = at(n, 0)
      const own = [data[first], data[first + 1], data[first + 2]]
      let flat = true
      for (let k = 1; k < count && flat; k++) flat = distance(data, at(n, k), own) <= 6
      if (!flat) break
      // A flat line of another colour ends the bar, and goes with it (the blend between bar and picture).
      if (previous && distance(data, first, previous) > 12) {
        n++
        break
      }
      colour ??= own
      previous = own
    }
    return { n, colour }
  }
  const pair = (a, b, clearA, clearB) => {
    if (!a.n || !b.n || Math.max(...a.colour.map((c, i) => Math.abs(c - b.colour[i]))) > 12) return
    for (let n = 0; n < a.n; n++) clearA(n)
    for (let n = 0; n < b.n; n++) clearB(n)
  }
  pair(
    run(width, (n, k) => (n * width + k) * 4),
    run(width, (n, k) => ((height - 1 - n) * width + k) * 4),
    n => cleared.fill(1, n * width, (n + 1) * width),
    n => cleared.fill(1, (height - 1 - n) * width, (height - n) * width),
  )
  pair(
    run(height, (n, k) => (k * width + n) * 4),
    run(height, (n, k) => (k * width + width - 1 - n) * 4),
    n => { for (let y = 0; y < height; y++) cleared[y * width + n] = 1 },
    n => { for (let y = 0; y < height; y++) cleared[y * width + width - 1 - n] = 1 },
  )
}

/**
 * Clears the background of `image` in place.
 * @param options.tolerance - how far (per channel) a pixel may be from the background colour and still be background.
 * @returns {{ ok: boolean, box: { x, y, width, height }, removed: number }} ok when there was a
 *   plain background to clear and a figure left; box is what is not see-through.
 */
export function cutOut(image, { tolerance = 28 } = {}) {
  const { data, width, height } = image
  const size = width * height
  const cleared = new Uint8Array(size)
  // A picture that is already cut out: keep it.
  let seeThrough = 0
  for (let x = 0; x < width; x++) if (data[x * 4 + 3] < 16) seeThrough++
  if (seeThrough > width / 2) return { ok: true, box: boundsOf(data, width, height), removed: 0 }
  clearBars(data, width, height, cleared)
  const edge = edgeColour(data, width, height, cleared)
  // Not a plain background (a scene behind the character): nothing to clear.
  if (!edge || edge.share < 0.4) return { ok: false, box: { x: 0, y: 0, width, height }, removed: 0 }
  const bg = edge.colour
  const queue = new Int32Array(size)
  let head = 0
  let tail = 0
  const seed = p => {
    if (cleared[p] === 2 || distance(data, p * 4, bg) > tolerance) return
    cleared[p] = 2
    queue[tail++] = p
  }
  for (let p = 0; p < size; p++) if (cleared[p] === 1) {
    cleared[p] = 2
    queue[tail++] = p
  }
  for (let x = 0; x < width; x++) {
    seed(x)
    seed((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    seed(y * width)
    seed(y * width + width - 1)
  }
  while (head < tail) {
    const p = queue[head++]
    const x = p % width
    if (x > 0) seed(p - 1)
    if (x < width - 1) seed(p + 1)
    if (p >= width) seed(p - width)
    if (p < size - width) seed(p + width)
  }
  let removed = 0
  for (let p = 0; p < size; p++) {
    if (cleared[p] !== 2) continue
    data[p * 4 + 3] = 0
    removed++
  }
  // The figure's rim: a pixel next to the cleared background, partly background-coloured, is partly see-through.
  for (let p = 0; p < size; p++) {
    if (cleared[p] === 2) continue
    const x = p % width
    const touches = (x > 0 && cleared[p - 1] === 2) || (x < width - 1 && cleared[p + 1] === 2) || (p >= width && cleared[p - width] === 2) || (p < size - width && cleared[p + width] === 2)
    if (!touches) continue
    const i = p * 4
    const alpha = Math.min(1, distance(data, i, bg) / (tolerance * 3))
    if (alpha >= 1) continue
    data[i + 3] = Math.round(255 * Math.max(alpha, 0.25))
  }
  const share = removed / size
  return { ok: share > 0.08 && share < 0.92, box: boundsOf(data, width, height), removed: share }
}

/** The smallest box holding every pixel that is not see-through. */
function boundsOf(data, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
