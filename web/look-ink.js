// 古风's brush work, drawn here so that no pictures ship: strokes, a circle in one breath, the wash a painting fades into the paper by,
// paper grain, and ink dropped on wet paper for a fight opening. Loaded only by that look (web/game-look.js).

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noiseOf(seed) {
  const rand = rng(seed)
  const grid = Array.from({ length: 64 * 64 }, rand)
  const at = (x, y) => grid[((y & 63) << 6) | (x & 63)]
  const smooth = t => t * t * (3 - 2 * t)
  const value = (x, y) => {
    const [ix, iy] = [Math.floor(x), Math.floor(y)]
    const [fx, fy] = [smooth(x - ix), smooth(y - iy)]
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx
    const low = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx
    return top + (low - top) * fy
  }
  return (x, y) => value(x, y) * 0.55 + value(x * 2.1, y * 2.1) * 0.3 + value(x * 4.3, y * 4.3) * 0.15
}

const clamp = value => Math.min(1, Math.max(0, value))
const sheet = (width, height) => Object.assign(document.createElement('canvas'), { width, height })

/** One pass of a loaded brush, drying out towards its end. */
function stroke(width, height, { color = '#1d1b19', seed = 1, dry = 0.55, bristles = 120 } = {}) {
  const canvas = sheet(width, height)
  const context = canvas.getContext('2d')
  const rand = rng(seed)
  context.strokeStyle = color
  context.lineCap = 'round'
  for (let i = 0; i < bristles; i++) {
    const lane = (rand() + rand() + rand()) / 3
    const end = width * (1 - rand() * rand() * dry * 0.5)
    let y = height * (0.12 + lane * 0.76)
    const thick = (0.7 + rand() * 2.2) * (height / 70)
    for (let x = rand() * width * 0.05; x < end;) {
      const step = 5 + rand() * 18
      const share = x / width
      const drift = (rand() - 0.5) * 1.1
      if (rand() >= share * share * dry * 1.5) {
        context.globalAlpha = 0.55 + rand() * 0.45
        context.lineWidth = thick * (Math.sin(share * Math.PI) * 0.35 + 0.75)
        context.beginPath()
        context.moveTo(x, y)
        context.lineTo(x + step, y + drift)
        context.stroke()
      }
      y += drift
      x += step
    }
  }
  return canvas.toDataURL()
}

/** A circle in one breath, a little open where the brush left the paper. */
function ring(size, { color = '#1d1b19', seed = 3 } = {}) {
  const canvas = sheet(size, size)
  const context = canvas.getContext('2d')
  const rand = rng(seed)
  context.strokeStyle = color
  context.lineCap = 'round'
  const radius = size * 0.4
  for (let i = 0; i < 46; i++) {
    const lane = (rand() + rand()) / 2 - 0.5
    const from = -2.2 + rand() * 0.14
    const to = -2.2 + 5.75 - rand() * rand() * 0.9
    for (let angle = from; angle < to;) {
      const step = 0.05 + rand() * 0.14
      const share = (angle - from) / 5.75
      if (rand() > share * share * 0.65) {
        const width = size * (0.09 + 0.05 * Math.sin(share * 3)) * (1 - share * 0.5)
        context.globalAlpha = 0.5 + rand() * 0.5
        context.lineWidth = 0.8 + rand() * size * 0.012
        context.beginPath()
        context.arc(size / 2, size / 2, radius + lane * width, angle, angle + step)
        context.stroke()
      }
      angle += step
    }
  }
  return canvas.toDataURL()
}

/** Where a painting fades into the paper: bare at the edges, uneven as a wash is. */
function wash({ seed = 5, bottom = 0.74 } = {}) {
  const canvas = sheet(256, 144)
  const context = canvas.getContext('2d')
  const image = context.createImageData(256, 144)
  const noise = noiseOf(seed)
  for (let y = 0; y < 144; y++) for (let x = 0; x < 256; x++) {
    const [u, v] = [x / 255, y / 143]
    const edge = (Math.min(u, 1 - u) - 0.012) * 2.2
    const low = (bottom - v) * 1.9
    const high = (v - 0.02) * 2.6
    const wobble = (noise(x * 0.05, y * 0.05) - 0.5) * 0.5
    image.data[(y * 256 + x) * 4 + 3] = clamp((Math.min(edge, low, high) + wobble) * 6.4) * 255
  }
  context.putImageData(image, 0, 0)
  return canvas.toDataURL()
}

function grain() {
  const canvas = sheet(220, 220)
  const context = canvas.getContext('2d')
  const rand = rng(11)
  const image = context.createImageData(220, 220)
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 120 + rand() * 100
    image.data[i] = value
    image.data[i + 1] = value * 0.96
    image.data[i + 2] = value * 0.86
    image.data[i + 3] = 18 + rand() * 14
  }
  context.putImageData(image, 0, 0)
  context.strokeStyle = 'rgb(120 100 70 / .16)'
  context.lineWidth = 0.5
  for (let i = 0; i < 50; i++) {
    const [x, y] = [rand() * 220, rand() * 220]
    context.beginPath()
    context.moveTo(x, y)
    context.quadraticCurveTo(x + rand() * 30 - 15, y + rand() * 30 - 15, x + rand() * 44 - 22, y + rand() * 44 - 22)
    context.stroke()
  }
  return canvas.toDataURL()
}

/** What the look's style sheet draws with, as variables on the page; and the rough edge a seal has. */
export function paintTextures(root) {
  if (root.dataset.inkReady) return
  root.dataset.inkReady = '1'
  const url = value => `url(${value})`
  const set = (name, value) => root.style.setProperty(name, url(value))
  set('--ink-grain', grain())
  set('--ink-wash', wash({ bottom: 0.76 }))
  set('--ink-wash-tall', wash({ bottom: 0.6 }))
  set('--ink-wash-fight', wash({ seed: 9, bottom: 0.82 }))
  set('--ink-wash-fight-tall', wash({ seed: 9, bottom: 0.72 }))
  set('--ink-red', stroke(620, 42, { color: '#b3362a', seed: 21, bristles: 80 }))
  set('--ink-jade', stroke(620, 42, { color: '#3f6a5c', seed: 22, bristles: 80 }))
  set('--ink-blue', stroke(620, 42, { color: '#3d5470', seed: 23, bristles: 80 }))
  set('--ink-stroke', stroke(1200, 90, { seed: 24, dry: 0.7 }))
  set('--ink-enso', ring(240))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  svg.innerHTML = '<filter id="ink-rough"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>'
    + '<filter id="ink-rough-fine"><feTurbulence type="fractalNoise" baseFrequency=".09" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="3.2"/></filter>'
  document.body.append(svg)
}

// Where each spot of the page is reached by the ink, from three drops.
const DROPS = [[0.5, 0.5, 1], [0.16, 0.3, 0.6], [0.84, 0.66, 0.7]]
const DROPS_TALL = [[0.5, 0.42, 1], [0.15, 0.2, 0.7], [0.8, 0.72, 0.8]]

function reachOf(width, height) {
  const noise = noiseOf(31)
  const drops = height > width ? DROPS_TALL : DROPS
  const field = new Float32Array(width * height)
  const far = Math.hypot(width, height) * 0.5
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let near = 9
    for (const [cx, cy, power] of drops) near = Math.min(near, Math.hypot(x - cx * width, y - cy * height) / far / power)
    field[y * width + x] = near * 0.8 + (noise(x * 0.04, y * 0.04) - 0.5) * 0.5 + (noise(x * 0.19, y * 0.19) - 0.5) * 0.2
  }
  return field
}

/** Ink spreading over a canvas until it covers it (share 1), or drawing back. → a promise, when it has got there. */
export function bleed(canvas, from, to, ms) {
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  if (!canvas.reach) canvas.reach = reachOf(width, height)
  const image = context.createImageData(width, height)
  const paint = share => {
    const level = -0.3 + share * 1.72
    for (let i = 0; i < width * height; i++) {
      // The dark of the drop, and ahead of it the thin water it spreads on.
      const spread = clamp((level - canvas.reach[i]) / 0.2)
      image.data[i * 4] = 24
      image.data[i * 4 + 1] = 22
      image.data[i * 4 + 2] = 20
      image.data[i * 4 + 3] = (spread < 0.5 ? spread * 0.72 : 0.36 + (spread - 0.5) * 1.28) * 255
    }
    context.putImageData(image, 0, 0)
  }
  const began = performance.now()
  return new Promise(done => {
    const frame = now => {
      const share = clamp((now - began) / ms)
      paint(from + (to - from) * share ** 1.5)
      if (share < 1) requestAnimationFrame(frame)
      else done()
    }
    paint(from)
    requestAnimationFrame(frame)
  })
}
