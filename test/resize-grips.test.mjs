import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resizedBox, readSize, keepSize } from '../web/resize-grips.js'

const start = { left: 500, top: 200, width: 400, height: 600 }
const min = { w: 300, h: 260 }
const view = { w: 1280, h: 900 }

test('a left or top edge moves that edge and keeps the opposite one', () => {
  assert.deepEqual(resizedBox(start, 'w', -100, 0, min, view), { left: 400, top: 200, width: 500, height: 600 })
  assert.deepEqual(resizedBox(start, 'n', 0, -50, min, view), { left: 500, top: 150, width: 400, height: 650 })
  assert.deepEqual(resizedBox(start, 'nw', 40, 40, min, view), { left: 540, top: 240, width: 360, height: 560 })
})

test('a right or bottom edge keeps the left and top', () => {
  assert.deepEqual(resizedBox(start, 'se', 80, 60, min, view), { left: 500, top: 200, width: 480, height: 660 })
  assert.deepEqual(resizedBox(start, 'e', -20, 999, min, view), { left: 500, top: 200, width: 380, height: 600 })
})

test('never smaller than the least size, never past the window', () => {
  assert.equal(resizedBox(start, 'w', 500, 0, min, view).width, 300)
  assert.equal(resizedBox(start, 'w', 500, 0, min, view).left, 600)
  assert.equal(resizedBox(start, 's', 0, -900, min, view).height, 260)
  assert.deepEqual(resizedBox(start, 'nw', -900, -900, min, view), { left: 0, top: 0, width: 900, height: 800 })
  assert.equal(resizedBox(start, 'se', 999, 999, min, view).width, 780)
  assert.equal(resizedBox(start, 'se', 999, 999, min, view).height, 700)
})

test('a kept size reads back; a broken one is none', () => {
  const store = new Map()
  globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  try {
    keepSize('k', { w: 420.6, h: 500.2 })
    assert.deepEqual(readSize('k'), { w: 421, h: 500 })
    keepSize('k', null)
    assert.equal(readSize('k'), null)
    store.set('k', '{"w":"wide","h":3}')
    assert.equal(readSize('k'), null)
    store.set('k', 'not json')
    assert.equal(readSize('k'), null)
  } finally {
    delete globalThis.localStorage
  }
})
