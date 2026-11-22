// 外观里的小图 (web/shared/status.js cleanSvg): a look may draw its own ornaments as SVG in its CSS; only shapes, paint
// and filters stay, nothing that loads or runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSkinCss, cleanSvg } from '../web/shared/status.js'
import { readSkin } from '../server/forge/skin.mjs'
import { SKIN_STYLE_KEYS, styleExample } from '../server/forge/skin-styles.mjs'

const SUN = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><radialGradient id='g'><stop offset='0' stop-color='#e1111c'/><stop offset='1' stop-color='#e1111c' stop-opacity='0'/></radialGradient><filter id='n'><feTurbulence baseFrequency='.8' numOctaves='2'/><feDisplacementMap in='SourceGraphic' scale='4'/></filter></defs><circle cx='50' cy='50' r='40' fill='url(#g)' filter='url(#n)'/><text x='10' y='20'>雨 &amp; 夜</text></svg>"
const pictures = css => (css.match(/data:image\/svg\+xml/g) ?? []).length

test('a drawn picture stays, however it was written, and is written back one way', () => {
  const ways = [
    `url("data:image/svg+xml,${encodeURIComponent(SUN)}")`,
    `url("data:image/svg+xml;base64,${Buffer.from(SUN).toString('base64')}")`,
    `url("data:image/svg+xml,${SUN.replace(/#/g, '%23')}")`,
    `url('data:image/svg+xml;charset=utf-8,${encodeURIComponent(SUN).replace(/'/g, '%27')}')`,
  ]
  const kept = ways.map(way => cleanSkinCss(`.status-bar { background: ${way} right top / 40% no-repeat, #111 }`))
  for (const css of kept) assert.equal(css, kept[0])
  assert.match(kept[0], /^\.status-bar \{ background: url\("data:image\/svg\+xml,%3Csvg xmlns=%22http:\/\/www\.w3\.org\/2000\/svg%22 viewBox=%220 0 100 100%22%3E/)
  assert.match(kept[0], /fill=%22url\(%23g\)%22/)
  assert.match(kept[0], /%3Ctext x=%2210%22 y=%2220%22%3E雨 &amp; 夜%3C\/text%3E/)
  assert.match(kept[0], /"\) right top \/ 40% no-repeat, #111 \}$/)
  // Nothing in it can end the string, the url or the rule.
  assert.doesNotMatch(kept[0].slice(kept[0].indexOf('url("') + 5, kept[0].lastIndexOf('")')), /["'\\{}<>#]/)
  assert.equal(cleanSkinCss(kept[0]), kept[0], 'the same when cleaned again')
  // Beside other things a value may have, in a pseudo-element, a mask.
  assert.equal(pictures(cleanSkinCss(`.status-title::before { content: ""; mask-image: ${ways[0]}; background: linear-gradient(red, blue) }`)), 1)
  // "url(" in words is words.
  assert.equal(cleanSkinCss('.status-title::after { content: "url(x)" }'), '.status-title::after { content: "url(x)" }')
})

test('a picture with anything a picture may not have goes, and with it the declaration', () => {
  const bad = [
    "<svg><script>alert(1)</script></svg>",
    "<svg><image href='https://example.com/a.png'/></svg>",
    "<svg><rect fill='url(https://example.com/a)'/></svg>",
    "<svg><use href='https://example.com/x.svg#a'/></svg>",
    "<svg><use href='data:image/svg+xml,x'/></svg>",
    "<svg><foreignObject><div/></foreignObject></svg>",
    "<svg><a href='https://example.com'><rect/></a></svg>",
    "<svg><style>rect { fill: url(https://example.com) }</style></svg>",
    "<svg><animate attributeName='href'/></svg>",
    "<!DOCTYPE svg [<!ENTITY a 'b'>]><svg>&a;</svg>",
    "<svg><![CDATA[x]]></svg>",
    "<svg><rect/></svg><svg/>",
    "<rect/>",
    "<svg><g>words where words are not drawn</g></svg>",
    "<svg><rect fill='javascript:x'/></svg>",
    "<svg><rect>",
    `<svg>${'<rect/>'.repeat(2000)}</svg>`,
  ]
  for (const markup of bad) {
    assert.equal(cleanSvg(markup), '', markup.slice(0, 60))
    assert.equal(cleanSkinCss(`.status-bar { background: url("data:image/svg+xml,${encodeURIComponent(markup)}"); color: red }`), '.status-bar { color: red }', markup.slice(0, 60))
  }
  // Handlers and styles are left out; the rest stays.
  assert.equal(cleanSvg("<svg onload='x()' style='fill:red'><title>t</title><use xlink:href='#a'/><rect width='2' onclick='y'/></svg>"), '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/><rect width="2"/></svg>')
  // Pictures of other kinds, and from elsewhere, are none of a look's.
  for (const way of ['url("data:image/png;base64,AAAA")', 'url(x.png)', 'url("https://example.com/a.svg")', 'image-set("a.png" 1x)']) {
    assert.equal(cleanSkinCss(`.status-bar { background: ${way}; color: red }`), '.status-bar { color: red }', way)
  }
  // One bad picture beside a good one: the declaration goes.
  assert.equal(cleanSkinCss(`.status-bar { background: url("data:image/svg+xml,${encodeURIComponent(SUN)}"), url(x.png); color: red }`), '.status-bar { color: red }')
})

test('the answer says when a picture was taken out, not when one stayed', () => {
  const answer = css => `<reply>好</reply>\n<name>图</name>\n<palette>{"bg":"#101820","ink":"#f2f2f2","accent":"#e0a030"}</palette>\n<css>\n${css}\n</css>`
  const good = `.status-bar { background: url("data:image/svg+xml,${SUN.replace(/#/g, '%23')}") }`
  assert.deepEqual(readSkin(answer(good)).cut, [])
  assert.equal(pictures(readSkin(answer(good)).css), 1)
  assert.deepEqual(readSkin(answer(`${good}\n.status-title { background: url("data:image/svg+xml,<svg><script/></svg>"); color: red }`)).cut, ['url'])
  assert.deepEqual(readSkin(answer(`${good}\n.status-title { background: url(x.png); color: red }`)).cut, ['url'])
})

test('every style\'s worked example is a picture a look may have', () => {
  for (const key of SKIN_STYLE_KEYS) {
    const example = styleExample(key)
    assert.ok(example, key)
    const lines = example.split('\n')
    const css = cleanSkinCss(example)
    assert.equal(css.split('\n').length, lines.length, key)
    assert.equal(pictures(css), pictures(example), key)
  }
})
