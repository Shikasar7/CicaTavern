// 骰子: a twenty-sided die turning in the air inside a ring of the numbers, coming to rest on the roll it was given. Whether the
// roll is good is game-play.js's to say; this only draws it. Everything goes by the clock, so a window out of sight loses nothing.

const PHI = (1 + Math.sqrt(5)) / 2
const VERTICES = [[0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI], [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0], [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1]]
const CAMERA = 7
const DIE_SIDE = 0.168
const RING_SIDE = 0.385
const SWEEP = (150 * Math.PI) / 180
const LIGHT = unit([-0.45, 0.6, 0.75])
const REST_MS = 420
const RAY_MS = 900
const RAYS = 48
// Numbers on faces turned further away than this would only be scratches.
const GLANCING = 0.42

/** A colour of the page's, as [r, g, b]. */
function pageColour(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (value.startsWith('#')) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
  return value.split(/\s+/).map(Number)
}

function unit(v) {
  const size = Math.hypot(...v)
  return v.map(item => item / size)
}
const minus = (a, b) => a.map((item, i) => item - b[i])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const apply = (m, v) => m.map(row => dot(row, v))
const times = (a, b) => a.map(row => [0, 1, 2].map(i => row[0] * b[0][i] + row[1] * b[1][i] + row[2] * b[2][i]))
const mix = (a, b, share) => a.map((item, i) => Math.round(item + (b[i] - item) * share))
const paint = (color, alpha = 1) => `rgb(${color[0]} ${color[1]} ${color[2]} / ${alpha})`

/** Turning `angle` round `axis`. */
function turning([x, y, z], angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const k = 1 - c
  return [[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s], [z * x * k - y * s, z * y * k + x * s, c + z * z * k]]
}

/** The twenty faces, corners anticlockwise from outside, numbered so that opposite faces add up to 21. */
const FACES = (() => {
  const faces = []
  const touching = (a, b) => Math.abs(Math.hypot(...minus(VERTICES[a], VERTICES[b])) - 2) < 1e-6
  for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) for (let c = b + 1; c < 12; c++) {
    if (!touching(a, b) || !touching(b, c) || !touching(a, c)) continue
    const out = dot(cross(minus(VERTICES[b], VERTICES[a]), minus(VERTICES[c], VERTICES[a])), VERTICES[a]) > 0
    const corners = out ? [a, b, c] : [a, c, b]
    const middle = [0, 1, 2].map(i => corners.reduce((sum, corner) => sum + VERTICES[corner][i], 0) / 3)
    faces.push({ corners, middle, normal: unit(middle), number: 0 })
  }
  let next = 1
  for (const face of faces) {
    if (face.number) continue
    face.number = next
    faces.find(other => dot(other.normal, face.normal) < -0.999).number = 21 - next
    next += 1
  }
  return faces
})()

/** How the die lies with `number` facing the viewer, the right way up. */
function restingOn(number) {
  const face = FACES.find(item => item.number === number) ?? FACES[0]
  const up = unit(minus(VERTICES[face.corners[0]], face.middle))
  return [cross(up, face.normal), up, face.normal]
}

/** A face's corners on the page → the canvas turned so that a number written at the origin lies on the face. */
function liftOnto(context, [a, b, c], scale) {
  // On a flat face with its middle at the origin and its first corner straight up, the corners are at these places.
  const [fx, fy] = [-Math.sqrt(3) / 2, 1.5]
  const [gx, gy] = [Math.sqrt(3) / 2, 1.5]
  const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]]
  const det = fx * gy - gx * fy
  const m = [(ux * gy - vx * fy) / det, (uy * gy - vy * fy) / det, (vx * fx - ux * gx) / det, (vy * fx - uy * gx) / det]
  context.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, a[0] + m[2], a[1] + m[3])
}

/**
 * The die at (x, y), `lit` from 0 to 1 as the face that came up takes its colour.
 * @param look - { shaded, lit, edge, far, number, face, onFace, font, weight, alpha, line, through }: its colours as [r, g, b], and how it is drawn
 */
function paintDie(context, x, y, scale, lying, roll, lit, look) {
  const corners = VERTICES.map(vertex => {
    const [px, py, pz] = apply(lying, vertex)
    const depth = CAMERA / (CAMERA - pz)
    return [x + px * scale * depth, y - py * scale * depth]
  })
  const faces = FACES.map(face => ({ face, turned: apply(lying, face.normal) }))
  const outline = ({ corners: [a, b, c] }) => {
    context.beginPath()
    context.moveTo(...corners[a])
    context.lineTo(...corners[b])
    context.lineTo(...corners[c])
    context.closePath()
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.lineJoin = 'round'
  context.lineWidth = look.line ?? Math.max(1, scale * 0.0155)
  // The far side, seen through it.
  if (look.through) for (const { face, turned } of faces) {
    if (turned[2] > 0) continue
    outline(face)
    context.strokeStyle = paint(look.edge, look.through)
    context.stroke()
  }
  for (const { face, turned } of faces) {
    if (turned[2] <= 0) continue
    const facing = face.number === roll ? lit : 0
    const light = Math.max(0, dot(turned, LIGHT))
    outline(face)
    context.fillStyle = paint(mix(mix(look.shaded, look.lit, light ** 1.6), look.face, facing), look.alpha ?? 0.93)
    context.fill()
    context.strokeStyle = paint(mix(look.edge, look.face, facing), 0.5 + turned[2] * 0.5)
    context.stroke()
  }
  for (const { face, turned } of faces) {
    if (turned[2] <= GLANCING) continue
    const facing = face.number === roll ? lit : 0
    // Small enough to stay inside its face; the one that came up reads from across the room.
    const size = (face.number > 9 ? 0.52 : 0.62) + 0.26 * facing
    context.save()
    liftOnto(context, face.corners.map(corner => corners[corner]), size / 64)
    context.font = `${look.weight ?? 600} 64px ${look.font}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = paint(mix(mix(look.far ?? look.number, look.number, turned[2]), look.onFace, facing), Math.min(1, (turned[2] - GLANCING) * 3.2))
    context.fillText(String(face.number), 0, 8)
    context.restore()
  }
  context.setTransform(1, 0, 0, 1, 0, 0)
}

const spinAxes = () => [unit([Math.random() - 0.5, Math.random() - 0.5, 0.2]), unit([0.2, Math.random() - 0.5, Math.random() - 0.5])]
const spunBy = (axes, left, target) => times(times(turning(axes[0], Math.PI * 7 * left), turning(axes[1], Math.PI * 4 * left)), target)

/** A canvas at its own size on this screen. → [context, side] */
function fitted(canvas) {
  const side = canvas.clientWidth * (window.devicePixelRatio || 1)
  canvas.width = side
  canvas.height = side
  return [canvas.getContext('2d'), side]
}

/**
 * The die alone, for the looks with a frame of their own round it.
 * @param options - { duration, still, look (paintDie's), steps (how many positions it turns through; none for smooth) }
 */
export function turnBare(canvas, { roll }, { duration, still = false, look, steps = 0 }) {
  const [context, side] = fitted(canvas)
  const target = restingOn(roll)
  const axes = spinAxes()
  const began = performance.now()
  let restedAt = still ? began - REST_MS : 0
  let frame = 0
  function draw(now) {
    const passed = Math.min(1, (now - began) / duration)
    const turning = restedAt ? 0 : (1 - passed) ** 4
    const left = steps ? Math.round(turning * steps) / steps : turning
    const lit = restedAt ? 1 - (1 - Math.min(1, (now - restedAt) / REST_MS)) ** 3 : 0
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, side, side)
    paintDie(context, side / 2, side / 2, side * 0.235, left ? spunBy(axes, left, target) : target, roll, lit, { line: side * 0.006, ...look })
    frame = restedAt && now - restedAt >= REST_MS ? 0 : requestAnimationFrame(draw)
  }
  draw(performance.now())
  return {
    rest() {
      if (!restedAt) restedAt = performance.now()
      if (!frame) draw(performance.now())
    },
    stop: () => cancelAnimationFrame(frame),
  }
}

const TRIGRAMS = [[1, 1, 1], [0, 1, 1], [1, 0, 1], [0, 0, 1], [1, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]]
const PAN_SPOTS = 20

/**
 * 古风's roll: a compass whose ring of numbers turns under the pointer, on past the roll to the total.
 * @param options - { duration, still, font, word (a number as the page writes it), told (what it stands at now) }
 */
export function turnPan(canvas, { roll, total, dc }, { duration, still = false, font, word, told }) {
  const [context, side] = fitted(canvas)
  const ink = alpha => `rgb(29 27 25 / ${alpha})`
  const red = alpha => `rgb(179 54 42 / ${alpha})`
  const sector = (Math.PI * 2) / PAN_SPOTS
  const began = performance.now()
  let restedAt = still ? began - 900 : 0
  let frame = 0
  let shown = 0
  function ringOf() {
    context.strokeStyle = ink(0.8)
    for (const [radius, width] of [[0.485, 3], [0.468, 1], [0.335, 1.4], [0.235, 1.4], [0.225, 0.8]]) {
      context.lineWidth = width
      context.beginPath()
      context.arc(0, 0, side * radius, 0, Math.PI * 2)
      context.stroke()
    }
    for (let i = 0; i < 8; i++) {
      context.save()
      context.rotate((i * Math.PI) / 4)
      TRIGRAMS[i].forEach((solid, row) => {
        const y = -side * (0.255 + row * 0.022)
        context.fillStyle = ink(0.78)
        if (solid) context.fillRect(-side * 0.04, y, side * 0.08, side * 0.0115)
        else {
          context.fillRect(-side * 0.04, y, side * 0.033, side * 0.0115)
          context.fillRect(side * 0.007, y, side * 0.033, side * 0.0115)
        }
      })
      context.restore()
    }
  }
  function numbers() {
    for (let n = 1; n <= PAN_SPOTS; n++) {
      context.save()
      context.rotate((n - 1) * sector)
      if (n >= dc) {
        context.strokeStyle = red(0.6)
        context.lineWidth = side * 0.052
        context.beginPath()
        context.arc(0, 0, side * 0.402, -Math.PI / 2 - sector / 2 + 0.008, -Math.PI / 2 + sector / 2 - 0.008)
        context.stroke()
      }
      context.strokeStyle = ink(0.7)
      context.lineWidth = 1.2
      context.beginPath()
      context.rotate(sector / 2)
      context.moveTo(0, -side * 0.468)
      context.lineTo(0, -side * 0.335)
      context.stroke()
      context.rotate(-sector / 2)
      context.fillStyle = n >= dc ? 'rgb(240 232 214)' : ink(0.92)
      const text = word(n)
      const size = side * (text.length > 2 ? 0.032 : text.length > 1 ? 0.04 : 0.05)
      context.font = `${size}px ${font}`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      ;[...text].forEach((letter, i) => context.fillText(letter, 0, -side * 0.402 + (i - (text.length - 1) / 2) * size * 0.96))
      context.restore()
    }
  }
  function draw(now) {
    const passed = Math.min(1, (now - began) / duration)
    const left = restedAt ? 0 : (1 - passed) ** 3
    const after = restedAt ? Math.min(1, (now - restedAt - 200) / 520) : 0
    const eased = 1 - (1 - Math.max(0, after)) ** 3
    const value = roll + (total - roll) * eased
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, side, side)
    context.translate(side / 2, side / 2)
    ringOf()
    context.save()
    context.rotate(-(value - 1) * sector + left * 19)
    numbers()
    context.restore()
    context.fillStyle = red(1)
    context.beginPath()
    context.moveTo(0, -side * 0.44)
    context.lineTo(side * 0.02, -side * 0.495)
    context.lineTo(-side * 0.02, -side * 0.495)
    context.fill()
    const now2 = left ? 1 + (Math.floor(Math.abs(left * 300)) % PAN_SPOTS) : Math.round(value)
    if (now2 !== shown) told((shown = now2))
    frame = restedAt && after >= 1 ? 0 : requestAnimationFrame(draw)
  }
  draw(performance.now())
  return {
    rest() {
      if (!restedAt) restedAt = performance.now()
      if (!frame) draw(performance.now())
    },
    stop: () => cancelAnimationFrame(frame),
  }
}

/**
 * The ring and the die on `canvas`, turning until `duration` is up unless `rest()` comes first.
 * @param roll - { roll, total, dc, tier }, as a check's result
 * → { rest() the die down at once, stop() }
 */
export function turnDie(canvas, { roll, total, dc, tier }, { duration, still = false, font = 'serif' }) {
  const context = canvas.getContext('2d')
  const ratio = window.devicePixelRatio || 1
  const side = canvas.clientWidth * ratio
  canvas.width = side
  canvas.height = side
  const middle = side / 2
  const GOLD = pageColour('--gold-c')
  const BONE = pageColour('--bone-c')
  const PAPER = pageColour('--night-c')
  const light = document.documentElement.dataset.lookTone === 'light'
  const SHADED = light ? [226, 219, 202] : [22, 31, 54]
  const LIT = light ? [255, 253, 246] : [66, 82, 122]
  const colour = { crit: pageColour('--gold-hi'), success: GOLD, close: pageColour('--gold-soft'), fail: pageColour('--cinnabar') }[tier] ?? GOLD
  const top = Math.max(20, dc, total)
  const place = value => -SWEEP + ((Math.min(top, Math.max(1, value)) - 1) / (top - 1)) * SWEEP * 2
  const target = restingOn(roll)
  const axes = [unit([Math.random() - 0.5, Math.random() - 0.5, 0.2]), unit([0.2, Math.random() - 0.5, Math.random() - 0.5])]
  const turns = [Math.PI * (6 + Math.random() * 2), Math.PI * (3 + Math.random() * 2)]
  const began = performance.now()
  let restedAt = still ? began - RAY_MS : 0
  let frame = 0

  const point = (ring, angle) => [middle + Math.sin(angle) * ring, middle - Math.cos(angle) * ring]

  function drawRing(left, settled) {
    const ring = side * RING_SIDE
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.lineCap = 'round'
    // The circle around it, its dashes running down with the die.
    context.save()
    context.translate(middle, middle)
    context.rotate(left * 7)
    context.setLineDash([side * 0.004, side * 0.018])
    context.strokeStyle = paint(GOLD, 0.34)
    context.lineWidth = Math.max(1, side * 0.0022)
    context.beginPath()
    context.arc(0, 0, ring * 1.2, 0, Math.PI * 2)
    context.stroke()
    context.restore()
    // The numbers it can come to, the ones that do it lit.
    for (let n = 1; n <= top; n++) {
      const angle = place(n)
      const long = n === 1 || n === top || n % 5 === 0
      const [x1, y1] = point(ring, angle)
      const [x2, y2] = point(ring - side * (long ? 0.03 : 0.016), angle)
      context.strokeStyle = n >= dc ? paint(mix(GOLD, colour, settled), 0.95) : paint(BONE, 0.42)
      context.lineWidth = Math.max(1, side * (long ? 0.0036 : 0.0026))
      context.beginPath()
      context.moveTo(x1, y1)
      context.lineTo(x2, y2)
      context.stroke()
    }
    // The round numbers, except where the mark's own number stands.
    context.font = `${Math.round(side * 0.03)}px ${font}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = paint(BONE, 0.5)
    for (let n = 5; n <= top; n += 5) {
      if (Math.abs(n - dc) < 2) continue
      context.fillText(String(n), ...point(ring + side * 0.04, place(n)))
    }
    context.strokeStyle = paint(GOLD, 0.5)
    context.lineWidth = Math.max(1, side * 0.0024)
    context.beginPath()
    context.arc(middle, middle, ring + side * 0.008, place(dc) - Math.PI / 2, place(top) - Math.PI / 2)
    context.stroke()
    // What it takes: a diamond on the ring, the number beside it.
    const [mx, my] = point(ring + side * 0.008, place(dc))
    const mark = side * 0.013
    context.fillStyle = paint(GOLD)
    context.beginPath()
    context.moveTo(mx, my - mark)
    context.lineTo(mx + mark, my)
    context.lineTo(mx, my + mark)
    context.lineTo(mx - mark, my)
    context.fill()
    const [lx, ly] = point(ring + side * 0.056, place(dc))
    context.font = `500 ${Math.round(side * 0.04)}px ${font}`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(String(dc), lx, ly)
    // Where the roll came to: from the die's number on to the total, with what the stat adds.
    if (!settled) return
    const value = roll + (total - roll) * settled
    const [bx, by] = point(ring - side * 0.015, place(value))
    context.fillStyle = paint(colour)
    context.shadowColor = paint(colour, 0.9)
    context.shadowBlur = side * 0.03
    context.beginPath()
    context.arc(bx, by, side * 0.0125, 0, Math.PI * 2)
    context.fill()
    context.shadowBlur = 0
  }

  function drawRays(share) {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.lineWidth = Math.max(1, side * 0.0022)
    context.strokeStyle = paint(colour, 0.8 * (1 - share))
    const from = side * (RING_SIDE * 1.22 + 0.03 * share)
    for (let i = 0; i < RAYS; i++) {
      const angle = (i / RAYS) * Math.PI * 2
      const [x1, y1] = point(from, angle)
      const [x2, y2] = point(from + side * (0.012 + 0.05 * share) * (i % 2 ? 0.6 : 1), angle)
      context.beginPath()
      context.moveTo(x1, y1)
      context.lineTo(x2, y2)
      context.stroke()
    }
  }

  function draw(now) {
    const passed = Math.min(1, (now - began) / duration)
    const left = restedAt ? 0 : (1 - passed) ** 4
    const lying = left ? times(times(turning(axes[0], turns[0] * left), turning(axes[1], turns[1] * left)), target) : target
    const since = restedAt ? now - restedAt : 0
    const settled = restedAt ? Math.min(1, since / REST_MS) : 0
    const eased = 1 - (1 - settled) ** 3
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, side, side)
    drawRing(left, eased)
    if (tier === 'crit' && since && since < RAY_MS) drawRays(since / RAY_MS)
    paintDie(context, middle, middle, (side * DIE_SIDE) / 1.05, lying, roll, eased, { shaded: SHADED, lit: LIT, edge: GOLD, far: GOLD, number: BONE, face: colour, onFace: PAPER, font, through: 0.14 })
    frame = since < RAY_MS ? requestAnimationFrame(draw) : 0
  }

  draw(performance.now())
  return {
    rest() {
      if (!restedAt) restedAt = performance.now()
      if (!frame) draw(performance.now())
    },
    stop: () => cancelAnimationFrame(frame),
  }
}
