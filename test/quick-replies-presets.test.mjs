// 快捷回复 (settings.quickReplies, server/store.mjs) and 生图方案 (media.imagePresets, server/media.mjs) as they are kept.
import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanQuickReplies } from '../server/store.mjs'
import { IMAGE_PRESET_KEYS, cleanMedia, imagePresetOf } from '../server/media.mjs'
import { currentImagePreset } from '../web/shared/draw.js'

test('quick replies keep a label and what they do, and nothing half written', () => {
  assert.equal(cleanQuickReplies(null), null, 'never set up')
  assert.equal(cleanQuickReplies([]), null)
  const kept = cleanQuickReplies({
    show: false,
    items: [
      { id: 'abcd1234', label: '  隐藏旧楼层 ', text: ' /hideold 10 ', fill: 'yes' },
      { label: '', text: '/hide 1-2' },
      { label: '空的', text: '   ' },
      { id: 'abcd1234', label: '总结', text: '请总结', fill: true },
    ],
  })
  assert.equal(kept.show, false)
  assert.deepEqual(kept.items.map(item => [item.label, item.text, item.fill]), [['隐藏旧楼层', '/hideold 10', false], ['总结', '请总结', true]])
  assert.equal(kept.items[0].id, 'abcd1234')
  assert.notEqual(kept.items[1].id, 'abcd1234', 'ids stay apart')
  assert.equal(cleanQuickReplies({ items: Array.from({ length: 50 }, (_, i) => ({ label: `b${i}`, text: 'x' })) }).items.length, 30)
  assert.equal(cleanQuickReplies({ items: [{ label: 'x'.repeat(40), text: 'y' }] }).items[0].label.length, 24)
})

test('an image setup keeps the drawing settings, cleaned as they are, and is found again', () => {
  const nai = cleanMedia({ imageBackend: 'novelai', naiModel: 'nai-diffusion-4-5-full', imageShape: 'portrait' })
  const saved = cleanMedia({ imagePresets: [{ name: ' NAI 竖图 ', settings: { ...imagePresetOf(nai), ttsModel: 'kept-out', naiToken: 'secret' } }] }, nai)
  const [preset] = saved.imagePresets
  assert.equal(preset.name, 'NAI 竖图')
  assert.match(preset.id, /^[a-z0-9]{4,16}$/)
  assert.deepEqual(Object.keys(preset.settings).sort(), [...IMAGE_PRESET_KEYS].sort(), 'only the drawing settings, no key or voice')
  assert.equal(preset.settings.naiModel, 'nai-diffusion-4-5-full')
  assert.equal(currentImagePreset(saved)?.id, preset.id)
  // Switched elsewhere: none is current; switched back by applying it, it is again.
  const sd = cleanMedia({ imageBackend: 'sdwebui', sdUrl: 'http://127.0.0.1:7861' }, saved)
  assert.equal(sd.imagePresets.length, 1, 'a settings save keeps the setups')
  assert.equal(currentImagePreset(sd), null)
  assert.equal(currentImagePreset(cleanMedia(preset.settings, sd))?.id, preset.id)
  // One that no longer reads is dropped, not the whole save.
  const bad = cleanMedia({ imagePresets: [{ name: '坏的', settings: { naiModel: 'not-a-model' } }, { name: '', settings: {} }, { name: '好的', settings: imagePresetOf(nai) }] }, nai)
  assert.deepEqual(bad.imagePresets.map(p => p.name), ['好的'])
})
