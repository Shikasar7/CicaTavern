// 更新了什么: which notes show after an update, and the notes themselves are whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, notesToShow } from '../web/shared/whatsnew.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('versions compare part by part', () => {
  assert.ok(compareVersions('1.10.0', '1.9.2') > 0)
  assert.ok(compareVersions('1.8.0', '1.8.0') === 0)
  assert.ok(compareVersions('1.8', '1.8.1') < 0)
  assert.ok(compareVersions('', '0.0.1') < 0)
})

test('after an update: the versions since the one seen, up to the one running, newest first', () => {
  const versions = ['1.6.0', '1.7.0', '1.8.0', '1.9.0'].map(version => ({ version, items: [{ zh: { title: version } }] }))
  const shown = (options) => notesToShow(versions, options).map(entry => entry.version)
  assert.deepEqual(shown({ current: '1.8.0', seen: '1.6.0' }), ['1.8.0', '1.7.0'])
  assert.deepEqual(shown({ current: '1.8.0', seen: '1.8.0' }), [])
  // Seen nothing yet: someone who already played gets this version's; a new player nothing.
  assert.deepEqual(shown({ current: '1.8.0', returning: true }), ['1.8.0'])
  assert.deepEqual(shown({ current: '1.8.0', returning: false }), [])
  // A version without notes, or without pages, shows nothing.
  assert.deepEqual(notesToShow([{ version: '1.8.0', items: [] }], { current: '1.8.0', seen: '1.7.0' }), [])
})

test('the shipped notes: both languages on every page, every picture there', () => {
  const notes = JSON.parse(readFileSync(path.join(ROOT, 'web', 'whatsnew', 'notes.json'), 'utf8'))
  assert.ok(notes.versions.length > 0)
  for (const entry of notes.versions) {
    assert.match(entry.version, /^\d+\.\d+\.\d+$/)
    for (const item of entry.items) {
      for (const lang of ['zh', 'en']) {
        assert.ok(item[lang]?.title && item[lang]?.text, `${entry.version}: ${lang} title and text`)
      }
      assert.doesNotMatch(item.en.title + item.en.text, /[一-鿿]/, `${entry.version}: English page without Chinese`)
      if (item.image) {
        assert.match(item.image, /^[\w.-]+\.(webp|png|jpg)$/)
        assert.ok(existsSync(path.join(ROOT, 'web', 'whatsnew', item.image)), `${item.image} is there`)
      } else assert.ok(item.icon, 'a page without a picture has an icon')
    }
  }
})
