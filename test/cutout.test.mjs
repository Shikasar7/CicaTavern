// 立绘 cut-out (web/shared/cutout.js): the plain background goes, the figure and what is inside it stay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cutOut } from '../web/shared/cutout.js'

/** A width × height picture filled by paint(x, y) → [r, g, b]. */
function picture(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y)
      data.set([r, g, b, 255], (y * width + x) * 4)
    }
  }
  return { data, width, height }
}
const alphaAt = (image, x, y) => image.data[(y * image.width + x) * 4 + 3]

const WHITE = [252, 251, 253]
const ROBE = [40, 43, 47]

test('a figure on white: the white around it goes, a white collar inside its outline stays', () => {
  // A dark robe from the middle to the bottom edge, wide at the bottom, a white collar in it.
  const image = picture(60, 80, (x, y) => {
    const half = 8 + y / 4
    if (y < 15 || Math.abs(x - 30) > half) return WHITE
    return y > 30 && y < 34 && Math.abs(x - 30) < 3 ? WHITE : ROBE
  })
  const result = cutOut(image)
  assert.equal(result.ok, true)
  assert.equal(alphaAt(image, 2, 2), 0)
  assert.equal(alphaAt(image, 30, 50), 255)
  assert.equal(alphaAt(image, 30, 32), 255, 'the collar is enclosed by the robe')
  assert.deepEqual(result.box, { x: 3, y: 15, width: 55, height: 65 })
})

test('wide sleeves fill the lower edges: the background is still told from the top', () => {
  const image = picture(60, 80, (x, y) => (y < 20 || (y < 40 && Math.abs(x - 30) > 10) ? WHITE : ROBE))
  assert.equal(cutOut(image).ok, true)
  assert.equal(alphaAt(image, 0, 79), 255, 'the robe at the bottom corner stays')
  assert.equal(alphaAt(image, 0, 0), 0)
})

test('letterbox bars go with the background; a scenic picture is left alone; a cut-out one is kept', () => {
  const barred = picture(60, 80, (x, y) => (y < 4 || y > 75 ? [0, 0, 0] : Math.abs(x - 30) < 10 && y > 20 ? ROBE : WHITE))
  assert.equal(cutOut(barred).ok, true)
  assert.equal(alphaAt(barred, 30, 1), 0)
  assert.equal(alphaAt(barred, 5, 40), 0)
  const scenic = picture(60, 80, (x, y) => [(x * 37) % 255, (y * 53) % 255, ((x + y) * 11) % 255])
  assert.equal(cutOut(scenic).ok, false)
  assert.equal(alphaAt(scenic, 0, 0), 255, 'untouched')
  const clear = picture(10, 10, () => ROBE)
  for (let x = 0; x < 10; x++) clear.data[x * 4 + 3] = 0
  assert.equal(cutOut(clear).ok, true)
})
