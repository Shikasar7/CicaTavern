// 版式: what a bar and a cover keep of the layout picked for them (web/shared/status.js, web/shared/cover.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_LAYOUTS, cleanStatusSpec, layoutFor } from '../web/shared/status.js'
import { COVER_LAYOUTS, cleanCover } from '../web/shared/cover.js'

const fields = [{ path: 'a.b', label: 'b', show: 'meter' }]

test('a bar keeps a layout it knows, and no other', () => {
  for (const layout of STATUS_LAYOUTS) assert.equal(cleanStatusSpec({ fields, layout }).layout, layout)
  for (const layout of ['', 'auto', 'grid', 5, null]) assert.equal('layout' in cleanStatusSpec({ fields, layout }), false, String(layout))
  assert.equal('layout' in cleanStatusSpec({ fields }), false)
})

test('the layout that goes with the theme (the card one), and one picked by hand over it', () => {
  assert.equal(layoutFor('auto'), 'card')
  assert.equal(layoutFor('rail'), 'rail')
  assert.equal(layoutFor('scroll'), 'scroll')
  assert.equal(layoutFor(''), '')
  assert.equal(layoutFor('nonsense'), '')
})

test('only the four themes there are stay on a bar; an older one gives the plain bar', () => {
  const fields = [{ path: 'a', label: 'A', show: 'number' }]
  for (const theme of ['editorial', 'meadow', 'sigil']) assert.equal(cleanStatusSpec({ fields, theme }).theme, theme)
  for (const theme of ['plain', 'paper', 'neon', 'parchment', 'gothic', 'nonsense']) assert.equal('theme' in cleanStatusSpec({ fields, theme }), false, theme)
})

test('a cover keeps a layout it knows, and no other', () => {
  for (const layout of COVER_LAYOUTS) assert.equal(cleanCover({ tagline: 'x', layout }).layout, layout)
  for (const layout of ['', 'card', 7]) assert.equal('layout' in cleanCover({ tagline: 'x', layout }), false, String(layout))
})
