// 定制外观's 起点: a look written over one of the themes (skin.base) keeps that theme under it, its rules weigh more
// than the theme's, the model is given the theme and writes only what it changes, and a layout written again keeps it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCard } from '../server/cards.mjs'
import { readEdit } from '../server/forge/edit.mjs'
import { readSkin, skinRequest } from '../server/forge/skin.mjs'
import { skinnedFrame, themeRules } from '../server/forge/status-frame.mjs'
import { statusLines, statusPart } from '../server/forge/status.mjs'
import { cleanSkin, cleanStatusSpec, scopedSkinCss, skinClass } from '../web/shared/status.js'

const FIELDS = [{ path: '体力', label: '体力', show: 'meter', min: 0, max: 100 }]
const CSS = '.status-title { color: #3a6 }\n.status-bar { border-radius: 8px }'
const OVER = { title: '野餐', fields: FIELDS, skin: { name: '春游', css: CSS, base: 'meadow' } }
const card = (statusBar = cleanStatusSpec(OVER)) => Object.assign(normalizeCard({ spec: 'chara_card_v2', data: { name: '小麦', description: '去春游的女孩。', first_mes: '出发啦。' } }), { statusBar })

test('a look over a theme keeps the theme under it; one from nothing has none', () => {
  const over = cleanStatusSpec({ ...OVER, theme: 'sigil' })
  assert.equal(over.theme, 'meadow', 'the theme is the look\'s base, whatever else was said')
  assert.equal(over.skin.base, 'meadow')
  assert.equal(over.palette, undefined, 'the theme\'s own colors')
  const fresh = cleanStatusSpec({ ...OVER, theme: 'meadow', skin: { css: CSS } })
  assert.equal(fresh.theme, undefined)
  assert.equal(fresh.skin.base, undefined)
  for (const base of ['plain', 'paper', 'nonsense', 3]) assert.equal('base' in cleanSkin({ css: CSS, base }), false, String(base))
})

test('over a theme, each of the look\'s rules weighs more than the theme\'s', () => {
  const scope = skinClass(CSS)
  const plain = scopedSkinCss(CSS, scope)
  const over = scopedSkinCss(CSS, scope, true)
  assert.match(plain, new RegExp(`^\\.${scope} \\.status-title`, 'm'))
  const heavy = `.${scope}`.repeat(6)
  assert.ok(over.includes(`${heavy} .status-title`), over)
  assert.ok(over.includes(`${heavy}.status-bar {`), over)
  // A theme's longest selectors weigh seven classes: the look's lightest one is no less.
  const weight = selector => (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!not\b)[\w-]+/g) ?? []).length
  assert.ok(weight(`${heavy} .status-title`) >= 7)
})

test('the model is given the theme it goes over, and may leave the colors to it', () => {
  const spec = cleanStatusSpec(OVER)
  const asked = skinRequest(card(), spec, { 体力: 50 }, { base: 'meadow', wish: '更像春游' }).messages[0].content
  assert.match(asked, /<base_theme name="晴野">/)
  assert.match(asked, /只写要改和要加的/)
  assert.doesNotMatch(asked, /\.theme-meadow|data:image|\/themes\//, 'the theme\'s rules as any bar\'s, pictures left out')
  assert.ok(asked.includes(themeRules('meadow')))
  assert.doesNotMatch(skinRequest(card(), spec, { 体力: 50 }).messages[0].content, /<base_theme/, 'from nothing: no theme')
  assert.doesNotMatch(skinRequest(card(), spec, { 体力: 50 }, { base: 'paper' }).messages[0].content, /<base_theme/, 'no theme by that name')
  const answer = `<reply>x</reply><name>春游</name><css>\n${CSS}\n</css>`
  const read = readSkin(answer, { base: 'meadow' })
  assert.deepEqual([read.base, read.palette], ['meadow', null])
  assert.equal(readSkin(answer).palette.bg, '#f7f8f5', 'from nothing, colors to start from')
  assert.equal(readSkin(answer, { base: 'paper' }).base, undefined)
})

test('a layout written again keeps the look over its theme; another theme takes its place', () => {
  const part = statusPart(card())
  assert.doesNotMatch(part, /"theme"/, 'the theme is the look\'s, not one to write')
  assert.match(part, /叠在主题 meadow 上/)
  assert.match(statusLines(card().statusBar), /叠在 晴野 上/)
  const again = readEdit('<status_bar>{"theme": "meadow", "fields": [{"path": "体力", "label": "体力", "show": "number"}]}</status_bar>', card()).changes[0].spec
  assert.equal(cleanStatusSpec(again).skin?.base, 'meadow')
  const other = readEdit('<status_bar>{"theme": "editorial", "fields": [{"path": "体力", "show": "number"}]}</status_bar>', card()).changes[0].spec
  assert.deepEqual([cleanStatusSpec(other).skin, cleanStatusSpec(other).theme], [undefined, 'editorial'])
})

test('in SillyTavern the theme goes along under the look, and the look weighs more', () => {
  const spec = cleanStatusSpec(OVER)
  const { style } = skinnedFrame(spec, { load: 'function load(){}' })
  assert.match(style, /\.status-bar\.theme-meadow/)
  assert.doesNotMatch(style, /\.theme-editorial|\.theme-sigil/)
  assert.ok(style.includes(`.${skinClass(spec.skin.css)}`.repeat(6)))
})
