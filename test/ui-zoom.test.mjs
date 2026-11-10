// 界面大小 on a computer zooms the page with CSS and moves every media query with it (web/theme.js fitInterface).
// A user who set it found, on the next start, no cards, no chats and no settings: the web font's stylesheet is
// another site's, reading its rules throws, and that stopped app.js before it loaded anything. Behaviour needs a
// browser; these are the rules a later edit could break without anyone noticing at 100%.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const read = file => readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n')
const theme = read('theme.js')

/** The body of a function in theme.js, up to the next top-level closing brace. */
function body(name) {
  const at = theme.search(new RegExp(`\\nfunction ${name}\\(|\\nexport function ${name}\\(`))
  assert.ok(at >= 0, `no function ${name}`)
  return theme.slice(at, theme.indexOf('\n}\n', at))
}

test('the page loads a stylesheet from another site, whose rules it may not read', () => {
  assert.match(read('index.html'), /<link rel="stylesheet" href="https:\/\//)
})

test('zooming the media queries reads each stylesheet through a guard', () => {
  const fit = body('fitInterface')
  assert.doesNotMatch(fit, /sheet\.cssRules/, 'a cross-origin sheet throws on cssRules')
  assert.match(fit, /zoomQueries\(rulesOf\(sheet\), ui\)/)
  const guard = body('rulesOf')
  assert.match(guard, /try \{\n\s+return sheet\.cssRules/)
  assert.match(guard, /catch \{\n\s+return \[\]/)
})

test('a look that fails to apply at start does not stop the page', () => {
  const init = body('initTheme')
  assert.match(init, /try \{\n\s+applyReading\(currentReading\(\)\)\n\s+\} catch/)
})
