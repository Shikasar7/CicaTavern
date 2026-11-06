import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOOKS, PALETTES, STRENGTH, cleanLook, faceOf, headCrop } from '../web/shared/look.js'

const SKIN = [250, 222, 200]
const HAIR = [40, 34, 38]
const CLOTH = [60, 100, 90]

/** A picture of `colour(x, y)`, see-through where that is null. */
function paint(width, height, colour) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = colour(x, y)
    if (rgb) data.set([...rgb, 255], (y * width + x) * 4)
  }
  return { data, width, height }
}

test('what was kept comes back as it was', () => {
  assert.deepEqual(cleanLook({ look: 'console', palette: 'plum', strength: 70 }), { look: 'console', palette: 'plum', strength: 70 })
})

test('nothing kept, or nonsense, is the plain look', () => {
  for (const saved of [null, undefined, {}, { look: 'neon' }, 'bold', 3]) assert.deepEqual(cleanLook(saved), { look: 'plain', palette: '', strength: STRENGTH })
})

test("a palette of another look falls to the look's first", () => {
  assert.equal(cleanLook({ look: 'bold', palette: 'plum' }).palette, 'gold')
  assert.equal(cleanLook({ look: 'plain', palette: 'gold' }).palette, '')
})

test('the strength stays in range and whole', () => {
  assert.equal(cleanLook({ strength: 140 }).strength, 100)
  assert.equal(cleanLook({ strength: -3 }).strength, 0)
  assert.equal(cleanLook({ strength: 33.6 }).strength, 34)
  assert.equal(cleanLook({ strength: '80' }).strength, STRENGTH)
})

test('every look has its palettes listed', () => {
  for (const look of LOOKS) assert.ok(Array.isArray(PALETTES[look]))
})

test('the face is the patch of skin high on the figure, not what is under it', () => {
  // Dark hair, a pale face, a neck and a larger patch of chest lower down.
  const figure = paint(200, 400, (x, y) => {
    if (y < 20 || x < 40 || x > 160) return null
    if (y < 50) return HAIR
    if (y < 90 && x > 75 && x < 125) return SKIN
    if (y < 200 && x > 60 && x < 140) return CLOTH
    if (y < 240) return SKIN
    return CLOTH
  })
  const face = faceOf(figure)
  assert.ok(Math.abs(face.x - 0.5) < 0.03, 'in the middle of the face')
  assert.ok(face.y * 400 > 20 && face.y * 400 < 90, 'at the height of the face')
})

test('the face is found wherever it stands across', () => {
  const figure = paint(300, 200, (x, y) => (y < 10 || x < 180 || x > 260 ? null : y < 60 && x > 200 && x < 240 ? SKIN : HAIR))
  assert.ok(Math.abs(faceOf(figure).x - 220 / 300) < 0.03)
})

test('a face fills its box: a streak of light in the hair is passed over', () => {
  const figure = paint(200, 400, (x, y) => {
    if (y < 10 || x < 40 || x > 160) return null
    if (y < 16 && x % 3 === 0) return SKIN
    if (y > 40 && y < 90 && x > 75 && x < 125) return SKIN
    return HAIR
  })
  assert.ok(faceOf(figure).y * 400 > 30)
})

test('no skin to go by: the head is taken from the outline', () => {
  const figure = paint(100, 300, (x, y) => (y >= 30 && x > 30 && x < 70 ? HAIR : null))
  const face = faceOf(figure)
  assert.ok(Math.abs(face.x - 0.5) < 0.02)
  assert.ok(face.y - face.side / 2 >= 0.09, 'from where the figure starts')
})

test('a picture with nothing in it has no face', () => {
  assert.equal(faceOf(paint(20, 20, () => null)), null)
})

test('a bigger figure of the same shape has its head in the same place', () => {
  const draw = scale => paint(100 * scale, 200 * scale, (x, y) => {
    const [u, v] = [x / scale, y / scale]
    return u < 20 || u > 80 ? null : v > 10 && v < 40 && u > 35 && u < 65 ? SKIN : HAIR
  })
  const [small, large] = [faceOf(draw(1)), faceOf(draw(2))]
  assert.ok(Math.abs(small.y - large.y) < 0.03)
  assert.ok(Math.abs(small.side - large.side) < 0.03)
})

test('the crop is a square around the head', () => {
  const crop = headCrop({ x: 0.6, y: 0.15, side: 0.3 }, 521, 980)
  assert.ok(Math.abs(crop.size - (521 / 294) * 100) < 0.01)
  assert.ok(crop.x > 50 && crop.x < 100, 'right of the middle, where the head is')
})

test('the crop stays on the picture', () => {
  for (const face of [{ x: 0, y: 0, side: 0.3 }, { x: 1, y: 1, side: 0.3 }]) {
    const crop = headCrop(face, 500, 1000)
    assert.ok(crop.x >= 0 && crop.x <= 100)
    assert.ok(crop.y >= 0 && crop.y <= 100)
  }
})

test('a picture narrower than a head takes its whole width', () => {
  const crop = headCrop({ x: 0.5, y: 0.1, side: 0.5 }, 100, 1000)
  assert.equal(crop.size, 100)
  assert.equal(crop.x, 0)
})
