// 定制外观的风格 (server/forge/skin-styles.mjs): a style picked on the page goes to the model as what it is made of.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { skinRequest } from '../server/forge/skin.mjs'
import { SKIN_STYLE_KEYS, cleanStyle, styleBlock, styleExample, styleName } from '../server/forge/skin-styles.mjs'
import { cleanSkinCss, cleanStatusSpec } from '../web/shared/status.js'

const FIELDS = [
  { path: '林小雨.好感', label: '好感', show: 'meter', min: 0, max: 100 },
  { path: '林小雨.心情', label: '心情', show: 'badge' },
]
const card = { name: '林小雨', description: '只在雨夜出现的女孩。', statusBar: cleanStatusSpec({ title: '雨宿', fields: FIELDS }) }
const state = { 林小雨: { 好感: 10, 心情: '平静' } }
const ask = options => skinRequest(card, card.statusBar, state, options).messages[0].content
const CSS = '.status-bar { border-radius: 4px }'

test('each style is a picture it is known by, the stuff it is made of, every part of the bar, and nothing a look may not have', () => {
  assert.deepEqual(SKIN_STYLE_KEYS, ['fresh', 'metal', 'journal', 'pixel', 'cel', 'ink', 'neon', 'storybook'])
  const parts = ['招牌画面', '质感', '各部分', '动起来', '不要']
  const barParts = ['标题', '进度条', '标签', '星级', '长文']
  const names = new Set()
  for (const key of SKIN_STYLE_KEYS) {
    const block = styleBlock(key)
    names.add(styleName(key))
    assert.match(block, new RegExp(`^<style name="${styleName(key)}">\n`))
    assert.match(block, /<\/style>$/)
    for (const part of parts) assert.match(block, new RegExp(`^${part}：`, 'm'), `${key} says ${part}`)
    for (const part of barParts) assert.ok(block.includes(part), `${key} says ${part}`)
    // What the program takes out of a look is not asked for: the only pictures are drawn ones.
    assert.doesNotMatch(block.replace(/url\("data:image\/svg\+xml,[^"]*"\)/g, '').replace(/url\(%23\w+\)/g, ''), /url\(|@import|@font-face|!important|position: ?(?:fixed|sticky)/, key)
    // 动效 is one the program can draw; the pointer is used with a fallback.
    assert.match(/动效：([^。]+)。/.exec(block)[1], /雨|雪|花瓣|火星|萤火|星光|浮尘/, key)
    assert.match(block, /var\(--p[fx]{1,2}, [\d.%]+\)/, key)
    assert.ok(block.length > 1500 && block.length < 4200, `${key} is ${block.length} long`)
  }
  assert.equal(names.size, SKIN_STYLE_KEYS.length)
  // 赛博霓虹's cut corners: no rounding left under them, and a line along the cut.
  assert.match(styleBlock('neon'), /切了角的块把 border-radius 写成 0/)
  assert.match(styleBlock('neon'), /linear-gradient\(225deg, transparent 50%, 边线色 50%/)
  assert.equal(cleanStyle('nope'), '')
  assert.equal(cleanStyle('constructor'), '')
  assert.equal(styleBlock(''), '')
})

test('the ways of writing a style names are kept by the program', () => {
  // The values the briefs spell out are ones cleanSkinCss leaves in.
  const css = [
    '.status-bar { clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px)) }',
    '.status-bar { box-shadow: 0 -4px 0 0 #222, 0 4px 0 0 #222, -4px 0 0 0 #222, 4px 0 0 0 #222 }',
    '.status-bar { background-image: repeating-conic-gradient(#111 0 25%, #151515 0 50%); background-size: 8px 8px }',
    '.status-group::after { mask-image: linear-gradient(90deg, #000, transparent) }',
    '.status-title { text-decoration: underline wavy #e06040 }',
    '.status-long::first-letter { font-size: 2em }',
    '.status-list li:nth-child(2n)::marker { color: #3a8f5a }',
    '.status-row.changed { animation: blink 0.6s steps(2) 3 }',
    '.status-meter > i { filter: drop-shadow(0 0 4px #3ff) }',
    '.status-bar { border-radius: 18px 22px 16px 24px / 20px 16px 24px 18px }',
  ].join('\n')
  assert.equal(cleanSkinCss(css), css)
})

test('a style picked goes with the request, under what the user wrote', () => {
  assert.doesNotMatch(ask({ wish: '像一张借书卡' }), /<style/)
  // Alone: the look goes the style's way, by the card.
  const alone = ask({ style: 'pixel' })
  assert.match(alone, /<style name="像素风">\n用户选了「像素风」这种风格。/)
  assert.match(alone, /用户没有另外写要求：照 <style> 里的「像素风」风格，按这张卡的气氛定。$/)
  assert.ok(alone.indexOf('<status_bar>') < alone.indexOf('<style'))
  assert.doesNotMatch(alone, /<base_theme>：在主题的底子上/)
  // With words of the user's own: theirs are said last, and go over the style.
  const both = ask({ style: 'ink', wish: '印章刻一个「雨」字' })
  assert.match(both, /和这份说明不一样的地方照用户写的。\n<\/style>/)
  assert.match(both, /用户想要的样子：印章刻一个「雨」字\n风格照 <style> 里的「水墨留白」。$/)
  // From a look: changed over to the style, or changed as written in it.
  const previous = { name: '雨夜橱窗', palette: { bg: '#101820', ink: '#f2f2f2', accent: '#e0a030' }, css: CSS }
  assert.match(ask({ style: 'neon', previous }), /<\/style>\n\n<current name="雨夜橱窗">[\s\S]*用户想把它改成 <style> 里的「赛博霓虹」风格：/)
  assert.match(ask({ style: 'neon', previous, wish: '边框细一点' }), /用户想在它的基础上改：边框细一点\n风格照 <style> 里的「赛博霓虹」。$/)
  // Put right: the look keeps the way it went, the style is not said again.
  const mended = ask({ style: 'neon', previous, problems: ['宽 340 像素时，.status-tag 横向伸出了状态栏'] })
  assert.doesNotMatch(mended, /<style/)
  // Over a theme: toward the style, on the theme.
  assert.match(ask({ style: 'journal', base: 'daybreak' }), /这次有 <base_theme>：在主题的底子上往这种风格靠/)
  // A style there is none of is no style.
  assert.match(ask({ style: 'nope' }), /用户没有说想要什么样子，按这张卡的气氛定。$/)
})

test('the page picks from the styles the server has', async () => {
  const page = (await readFile(new URL('../web/card-check.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const list = /const SKIN_STYLES = \(\) => \[\n([\s\S]*?)\n\]/.exec(page)[1]
  const rows = [...list.matchAll(/^ {2}\['(\w+)', t`([^`]+)`, t`([^`：]+)：/gm)]
  assert.deepEqual(rows.map(row => row[1]), SKIN_STYLE_KEYS)
  for (const [, key, name, lead] of rows) {
    assert.equal(name, styleName(key))
    assert.equal(lead, name)
  }
  assert.match(page, /send\(\{ wish: look\.wish\.trim\(\), style: look\.style, previous \}\)/)
})
