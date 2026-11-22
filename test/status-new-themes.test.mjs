// 晨笺, 天光云影 and 钴蓝: the themes are offered and kept, their rules and SillyTavern copies are there, and
// 天光云影's sky follows the story's time of day.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { barStyle, statusBarHtml, statusLines } from '../server/forge/status.mjs'
import { STATUS_THEMES, cleanStatusSpec, skyOf } from '../web/shared/status.js'

const FIELDS = [{ path: '体力', label: '体力', show: 'meter', min: 0, max: 100 }]
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8')

test('晨笺, 天光云影 and 钴蓝 are themes a bar keeps, each with its rules and its pictures and font', () => {
  for (const theme of ['daybreak', 'aquarelle', 'cobalt']) {
    assert.ok(STATUS_THEMES.includes(theme))
    assert.equal(cleanStatusSpec({ fields: FIELDS, theme }).theme, theme)
    assert.match(css, new RegExp(`\\.status-bar\\.theme-${theme} \\{`))
    assert.match(barStyle(theme), new RegExp(`\\.theme-${theme}\\{`))
    assert.doesNotMatch(barStyle(theme), /\.theme-(?:editorial|meadow|sigil)\b/, 'only its own rules go along')
  }
  assert.match(statusLines(cleanStatusSpec({ fields: FIELDS, theme: 'aquarelle' })), /天光云影/)
  assert.match(statusBarHtml(cleanStatusSpec({ fields: FIELDS, theme: 'daybreak' })), /class="bar theme-daybreak"/)
  for (const file of ['dawn', 'day', 'dusk', 'night', 'sprig']) assert.ok(existsSync(new URL(`../web/themes/aquarelle/${file}.webp`, import.meta.url)), file)
  assert.ok(existsSync(new URL('../web/fonts/pinyon.woff2', import.meta.url)))
  assert.ok(existsSync(new URL('../web/fonts/OFL-pinyonscript.txt', import.meta.url)))
})

test('天光云影 paints the sky of the story\'s time: words first, then an hour; none said is noon', () => {
  const rows = (label, text) => [{ name: '世界', rows: [{ path: `世界.${label}`, label, show: 'text', text }] }]
  const cases = [
    ['时间', '第三日 · 黄昏', 'dusk'], ['时间', '清晨', 'dawn'], ['时间', '拂晓前', 'dawn'], ['时间', '正午', 'day'], ['时间', '下午三点', 'day'],
    ['时间', '深夜', 'night'], ['时间', '午夜', 'night'], ['时辰', '酉时', 'dusk'], ['time', 'Day 3, evening', 'dusk'], ['时间', '18:30', 'dusk'],
    ['时间', '06:10', 'dawn'], ['时间', '23点', 'night'], ['时间', '14：05', 'day'], ['地点', '黄昏小镇', 'day'], ['时间', '第三日', 'day'],
  ]
  for (const [label, text, sky] of cases) assert.equal(skyOf(rows(label, text)), sky, `${label} ${text}`)
  assert.equal(skyOf([]), 'day')
  assert.equal(skyOf([{ name: '', rows: [{ path: '时间', label: '时间', show: 'number', words: '7:00' }] }]), 'dawn', 'a gauge\'s words too')
})

test('放课后, 线稿, 信号, 流银, 赤墨 and 万华 are themes a bar keeps, each with its rules, its SillyTavern copy and a place among the starting points of a look', async () => {
  const { cleanBase } = await import('../server/forge/skin.mjs')
  for (const theme of ['afterschool', 'lineart', 'signal', 'mercury', 'redink', 'kaleido']) {
    assert.ok(STATUS_THEMES.includes(theme))
    assert.equal(cleanStatusSpec({ fields: FIELDS, theme }).theme, theme)
    assert.match(css, new RegExp(`\\.status-bar\\.theme-${theme} \\{`))
    assert.match(barStyle(theme), new RegExp(`\\.theme-${theme}\\{`))
    assert.doesNotMatch(barStyle(theme), /\.theme-(?:editorial|cobalt)\b/, 'only its own rules go along')
    assert.equal(cleanBase(theme), theme)
    assert.equal(cleanStatusSpec({ fields: FIELDS, skin: { css: '.status-title { color: #123 }', base: theme } }).theme, theme)
  }
})
