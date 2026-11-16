// The page has to start on old Android system WebViews (国产机, Chrome 80 and up): a script one of them cannot parse
// stops every other script of the page, and nothing answers a tap. These are the ways that happened.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const WEB = path.join(import.meta.dirname, '..', 'web')
const scripts = dir => readdirSync(dir).flatMap(name => {
  const file = path.join(dir, name)
  if (statSync(file).isDirectory()) return name === 'fonts' || name === 'whatsnew' ? [] : scripts(file)
  return name.endsWith('.js') ? [file] : []
})

/** The code of a line, without what is in its strings and after a `//`. */
const codeOf = line => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '')

test('no script uses syntax an old WebView cannot read', () => {
  const found = []
  for (const file of scripts(WEB)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const code = codeOf(line)
      const where = `${path.relative(WEB, file)}:${i + 1}`
      // ??= ||= &&= (Chrome 85): write a = a ?? b.
      if (/(\?\?|\|\||&&)=/.test(code)) found.push(`${where} logical assignment`)
      // Top-level await (Chrome 89): a statement of the module itself, not indented, waiting.
      if (/^(?:export\s+)?(?:const|let|var|[\w$.]+\s*=|\(|await)[^]*\bawait\b/.test(code) && !/^\s/.test(line) && !/=>|function|async/.test(code)) found.push(`${where} top-level await`)
    })
  }
  assert.deepEqual(found, [])
})

test('the page loads its English words before app.js, and says so when it cannot start', () => {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8')
  assert.doesNotMatch(html, /<script src="\/app\.js"/, 'app.js comes in through the loader')
  assert.match(html, /import\('\/app\.js'\)[\s\S]*\.catch\(failed\)/)
  assert.match(readFileSync(path.join(WEB, 'i18n.js'), 'utf8'), /globalThis\.cicatavernWords/)
  // Polyfilled before any script uses them.
  for (const name of ['replaceChildren', 'replaceAll', 'hasOwn', 'structuredClone', 'findLast']) assert.match(html, new RegExp(`'${name}'`))
})
