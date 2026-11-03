import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameShim, libraryTags, replaceViewportHeight } from '../web/compat.js'
import { editPreset } from '../server/presets.mjs'

test('frames load only the libraries their code uses', () => {
  assert.equal(libraryTags('<div>plain</div>'), '')
  assert.match(libraryTags('<script>$(".a").hide()</script>'), /jquery\.min\.js/)
  assert.doesNotMatch(libraryTags('<script>$(".a").hide()</script>'), /lodash|vue/)
  assert.match(libraryTags('<script>_.get(a, "b")</script>'), /lodash/)
  assert.match(libraryTags('<i class="fa-solid fa-heart"></i>'), /fontawesome/)
  assert.match(libraryTags('<div class="flex items-center gap-2"></div>'), /tailwind/)
})

test('a frame that loads its page from elsewhere gets what Tavern Helper always has: jQuery, lodash, Vue', () => {
  const tags = libraryTags(`<body><script>$('body').load('https://raw.githubusercontent.com/a/b/main/dist/ui/index.html')</script></body>`)
  assert.match(tags, /jquery\.min\.js/)
  assert.match(tags, /lodash/)
  assert.match(tags, /vue\.global/)
  assert.doesNotMatch(tags, /tailwind|fontawesome/, 'only those three')
  assert.match(libraryTags(`<script>fetch('https://cdn.jsdelivr.net/gh/a/b/ui.html').then(r => r.text())</script>`), /lodash/)
})

test('min-height in vh is pinned to the page viewport, other vh is left alone', () => {
  assert.equal(replaceViewportHeight('.a{min-height:100vh}'), '.a{min-height:var(--TH-viewport-height)}')
  assert.equal(replaceViewportHeight('<div style="min-height: 50vh">'), '<div style="min-height: calc(var(--TH-viewport-height) * 0.5)">')
  assert.equal(replaceViewportHeight('.a{height:100vh}'), '.a{height:100vh}')
})

test('the frame shim cannot be closed early by story text', () => {
  const tag = frameShim({ names: { user: '你', char: 'x' }, note: '</script><img src=x onerror=alert(1)>' })
  assert.equal(tag.match(/<\/script>/g).length, 1)
  assert.ok(tag.endsWith('</script>'))
})

test('presets keep a quick-switch list of real, non-marker entries', () => {
  const preset = { prompts: [{ id: 'a' }, { id: 'b' }, { id: 'chatHistory', marker: true }] }
  editPreset(preset, { quick: ['b', 'a', 'b', 'chatHistory', 'gone'] })
  assert.deepEqual(preset.quick, ['b', 'a'])
})
