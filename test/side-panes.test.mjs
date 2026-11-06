// What the page's layout must keep true on tablets and old WebViews. The behaviour itself needs a browser;
// these are the rules a later edit could break without anyone on a desktop noticing.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { READ_WIDTH } from '../web/shared/appearance.js'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const read = file => readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n')
const css = read('style.css')

/** The z-index a rule sets: the first rule with exactly this selector that has one. */
function zIndex(selector) {
  const start = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|[\\n,])\\s*${start}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'g')
  for (const [, body] of css.matchAll(rule)) {
    const z = body.match(/z-index:\s*(\d+)/)
    if (z) return Number(z[1])
  }
  assert.fail(`no z-index for ${selector}`)
}

test('an open drawer and its scrim are over everything on the stage', () => {
  const picture = zIndex('.vn')
  const input = zIndex('.stage.vn-on .composer')
  const scrim = zIndex('.scrim')
  assert.ok(scrim > picture, 'a tap on the picture reaches the scrim, so the drawer closes')
  assert.ok(scrim > input, 'the input box is dimmed with the rest')
  assert.ok(zIndex('.pane.left') > scrim, 'the left drawer is over its scrim')
  assert.ok(zIndex('.pane.right') > scrim, 'the right drawer is over its scrim')
})

test('the scrim has a size in a WebView without inset', () => {
  const rule = css.match(/\.scrim \{ display: block;[^}]*\}/)[0]
  assert.doesNotMatch(rule, /\binset:/)
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(rule, new RegExp(`\\b${side}: 0`))
})

test('no height depends on dvh in a browser without it', () => {
  // With var() in it, a line a browser cannot use is not skipped: it replaces the line above and leaves no height.
  // So dvh is written once, behind @supports, and everything else uses the variable.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(rules, /:root \{ --dvh: 1vh; \}/)
  assert.match(rules, /@supports \(height: 1dvh\) \{ :root \{ --dvh: 1dvh; \} \}/)
  assert.deepEqual(rules.match(/\d+dvh\b/g), ['1dvh', '1dvh'])
  assert.match(rules.match(/^\.app \{[^}]*\}/m)[0], /height: calc\(100 \* var\(--dvh\) \/ var\(--page-zoom\)\)/)
})

test('the story width is drawn before the first paint, within what is kept', () => {
  const bounds = read('index.html').match(/if \(w >= (\d+) && w <= (\d+)\) root\.style\.setProperty\('--read'/)
  assert.deepEqual([Number(bounds[1]), Number(bounds[2])], [READ_WIDTH.min, READ_WIDTH.max])
  // theme.js fitColumn stops at what the transcript has inside its padding: the same numbers as the edges.
  assert.match(css, /\.read-edge \{ --gutter: 48px;/)
  assert.match(css, /\.transcript \{ flex: 1; overflow-y: auto; padding: 18px 24px 28px; \}/)
  assert.match(css, /\.transcript \{ padding: 12px 16px 24px; \}\n\s*\.reader \.read-edge \{ --gutter: 32px; \}/)
})

test('a folded pane is drawn folded before the first paint', () => {
  // index.html reads what togglePane writes.
  assert.match(read('app.js'), /localStorage\.setItem\(`fold-\$\{side\}`/)
  assert.match(read('index.html'), /localStorage\.getItem\('fold-' \+ side\)/)
  assert.match(css, /:root\[data-fold-left\] \.pane\.left \{/)
  assert.match(css, /:root\[data-fold-right\] \.pane\.right \{/)
})

test('a drawer keeps showing while it slides shut', () => {
  for (const side of ['left', 'right']) {
    const rule = css.match(new RegExp(`\\.pane\\.${side}, :root\\[data-fold-${side}\\] \\.pane\\.${side} \\{[^}]*\\}`))[0]
    assert.match(rule, /visibility 0s linear \.32s/)
  }
})

test('no list is left to a browser to draw', () => {
  // <input list> offers only what matches the text in the box, and a WebView may draw nothing: web/menu.js comboBox.
  const pages = [...readdirSync(web), ...readdirSync(path.join(web, 'shared')).map(file => `shared/${file}`)].filter(file => /\.(js|html)$/.test(file))
  for (const file of pages) {
    const text = read(file)
    assert.doesNotMatch(text, /datalist/, file)
    assert.doesNotMatch(text, /el\('input',[^\n]*\blist:/, file)
    assert.doesNotMatch(text, /<input[^>]*\blist=/, file)
  }
})
