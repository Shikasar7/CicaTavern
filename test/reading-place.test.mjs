// What keeps the reader's place and the way out of the CG 回廊. The behaviour needs a browser and a long chat;
// these are the rules a later edit could break without anyone noticing on a short one.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const read = file => readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n')

test('a message near the screen has its real height, or a fast wheel comes on a guess', () => {
  assert.match(read('style.css'), /\.transcript > \.msg\.near \{ content-visibility: visible; \}/)
  assert.match(read('app.js'), /new IntersectionObserver\([\s\S]{0,160}toggle\('near'[\s\S]{0,60}root: box/)
})

test('what loads late on screen is watched, and only pulls the page while the reader goes up', () => {
  const app = read('app.js')
  assert.match(app, /const LOADS_LATE = '\.card-frame, \.reply-image img'/)
  assert.match(app, /if \(!grew \|\| !goingUp\) continue/)
})

test('every way out of a picture goes through leaveCg, so one opened from the gallery goes back to it', () => {
  const vn = read('vn.js')
  assert.match(vn, /const leaveCg = \(\) => \(cgView\.dataset\.back \? openGallery\(state\.cgAt\) : closeCg\(\)\)/)
  assert.match(vn, /tagName === 'IMG'\) leaveCg\(\)/)
  assert.match(vn, /if \(!cgView\.hidden\) return leaveCg\(\)/)
  assert.match(vn, /control\(t`关闭`, t`Esc`, \(\) => leaveCg\(\)\)/)
})
