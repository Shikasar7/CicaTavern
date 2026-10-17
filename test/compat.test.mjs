import { test } from 'node:test'
import assert from 'node:assert/strict'
import { frameShim, libraryTags, parseSlash, replaceViewportHeight } from '../web/compat.js'
import { editPreset } from '../server/presets.mjs'

test('slash pipes split into commands with named arguments', () => {
  assert.deepEqual(parseSlash('/send 你好|/trigger'), [
    { name: 'send', text: '你好', named: {} },
    { name: 'trigger', text: '', named: {} },
  ])
  assert.deepEqual(parseSlash('/setinput A|B 两个选项'), [{ name: 'setinput', text: 'A|B 两个选项', named: {} }], 'a pipe not followed by a command stays in the text')
  assert.deepEqual(parseSlash('/echo severity=warning title="提 示" 注意'), [{ name: 'echo', text: '注意', named: { severity: 'warning', title: '提 示' } }])
})

test('frames load only the libraries their code uses', () => {
  assert.equal(libraryTags('<div>plain</div>'), '')
  assert.match(libraryTags('<script>$(".a").hide()</script>'), /jquery\.min\.js/)
  assert.doesNotMatch(libraryTags('<script>$(".a").hide()</script>'), /lodash|vue/)
  assert.match(libraryTags('<script>_.get(a, "b")</script>'), /lodash/)
  assert.match(libraryTags('<i class="fa-solid fa-heart"></i>'), /fontawesome/)
  assert.match(libraryTags('<div class="flex items-center gap-2"></div>'), /tailwind/)
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
