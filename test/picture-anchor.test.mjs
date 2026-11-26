// 配图放在画的那一句下面: the words a picture stands under, from the one who wrote its prompt to the picture as recorded, kept
// when it is drawn again; and the paragraph they are found in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorKey, findAnchor, picturesOnLines } from '../web/shared/draw.js'
import { cleanAnchor, cleanMedia, contextImageInstruction, imagePromptRequest, takeAnchor } from '../server/media.mjs'
import { dropOldImage, pickImage, redrawImage } from '../server/draw-history.mjs'

test('the anchor line is taken out of the answer, however it is written', () => {
  assert.deepEqual(takeAnchor('1girl, rain, street\n锚点: 她撑着伞跟出来，替你挡住斜吹的雨丝'), { text: '1girl, rain, street', anchor: '她撑着伞跟出来，替你挡住斜吹的雨丝' })
  for (const line of ['锚点：「她撑着伞跟出来」', '**锚点:** 她撑着伞跟出来', '- 锚点: “她撑着伞跟出来”', 'Anchor: 她撑着伞跟出来', '> 锚点： *她撑着伞跟出来*']) {
    assert.deepEqual(takeAnchor(`场景: street\n[沈岚] holding an umbrella\n${line}`), { text: '场景: street\n[沈岚] holding an umbrella', anchor: '她撑着伞跟出来' }, line)
  }
  // Thinking is not the answer; an empty one, or none, is none.
  assert.deepEqual(takeAnchor('<think>锚点: 想过的</think>1girl\n锚点:'), { text: '1girl', anchor: '' })
  assert.deepEqual(takeAnchor('1girl, anchor tattoo'), { text: '1girl, anchor tattoo', anchor: '' })
  assert.equal(cleanAnchor('字'.repeat(300)).length, 120)
  assert.equal(cleanAnchor(null), '')
})

test('found by its words: marks and spaces aside, then by ever shorter beginnings and ends', () => {
  const story = ['雨点落在旧木架上，发出细碎的声响。', '她撑着伞跟出来，替你挡住斜吹的雨丝。', '“这个时候，会是谁呢？”她低声问。', 'She looked up, and the rain had stopped.']
  assert.equal(findAnchor(story, '她撑着伞跟出来，替你挡住斜吹的雨丝'), 1)
  assert.equal(findAnchor(story, '她撑着伞跟出来 替你 挡住斜吹的雨丝……'), 1)
  assert.equal(findAnchor(story, '这个时候,会是谁呢?'), 2)
  assert.equal(findAnchor(story, 'she looked up and the rain'), 3)
  // A character dropped, or one changed at either end.
  assert.equal(findAnchor(story, '她撑着伞跟出来，替你挡斜吹的雨丝'), 1)
  assert.equal(findAnchor(story, '沈岚撑着伞跟出来，替你挡住'), 1)
  // Not there, or too little to go by.
  assert.equal(findAnchor(story, '月亮从云后面露出来照着巷子'), -1)
  assert.equal(findAnchor(story, '她低声'), -1)
  assert.equal(findAnchor(story, ''), -1)
  assert.equal(findAnchor([], '她撑着伞跟出来'), -1)
  assert.equal(anchorKey('「Hi，２人。」'), 'hi２人')
})

test('both ways of writing the prompt ask for it, 画 CG does not; more of a long reply is read', () => {
  const ask = anchored => imagePromptRequest({ card: { description: 'x' }, names: { char: '沈岚', user: '你' }, reply: `${'字'.repeat(3000)}末尾`, input: '', state: {}, style: '', promptStyle: 'tags', ...(anchored === undefined ? {} : { anchored }) }).messages[0].content
  assert.match(ask(), /as the last line, write 锚点: followed by 8 to 24 characters copied exactly/)
  assert.match(ask(), /末尾\n<\/latest_passage>/)
  assert.doesNotMatch(ask(false), /锚点/)
  assert.match(contextImageInstruction({ promptStyle: 'tags', style: '' }), /最后另起一行写「锚点: 」，后面照抄你上一条回复里/)
  assert.match(contextImageInstruction({ promptStyle: 'tags', style: '', passage: '她放下杯子。' }), /照抄上面这段里/)
  assert.doesNotMatch(contextImageInstruction({ promptStyle: 'tags', style: '', anchored: false }), /锚点/)
})

test('where a picture stands is the place\'s: kept when it is drawn again, replaced or an old one is taken back', () => {
  const images = [{ file: 'a.png', prompt: 'p', anchor: '她撑着伞跟出来' }, { file: 'x.png', prompt: 'q' }]
  const drawn = redrawImage(images, 'a.png', { file: 'b.png', prompt: 'p' }, 5).images
  assert.deepEqual([drawn[0].file, drawn[0].anchor, drawn[0].history[0].file], ['b.png', '她撑着伞跟出来', 'a.png'])
  assert.equal(redrawImage(images, 'a.png', { file: 'b.png', anchor: '新的一句话在这' }, 5).images[0].anchor, '新的一句话在这')
  assert.equal(redrawImage(images, 'x.png', { file: 'y.png' }, 5).images[1].anchor, undefined)
  const back = pickImage(drawn, 'b.png', 'a.png')
  assert.deepEqual([back[0].file, back[0].anchor], ['a.png', '她撑着伞跟出来'])
  assert.equal(dropOldImage(drawn, 'b.png', 'a.png').images[0].anchor, '她撑着伞跟出来')
})

test('配图放在: under the sentence unless set otherwise', () => {
  assert.equal(cleanMedia({}).picturePlace, 'inline')
  assert.equal(cleanMedia({ picturePlace: 'end' }).picturePlace, 'end')
  assert.equal(cleanMedia({ picturePlace: 'nowhere' }).picturePlace, 'inline')
})

test('视觉小说: which line each picture shows on; a second one on the same line waits for the next', () => {
  const lines = ['雨点落在旧木架上。', '', '沈岚撑着伞跟出来，替你挡雨。', '“会是谁呢？”她低声问。']
  const on = images => Object.fromEntries([...picturesOnLines(images.map(([file, anchor]) => ({ file, anchor })), lines)].map(([at, image]) => [at, image.file]))
  assert.deepEqual(on([['a', '沈岚撑着伞跟出来'], ['b', '雨点落在旧木架上'], ['c', ''], ['d', '故事里根本没有这句话']]), { 2: 'a', 0: 'b' })
  assert.deepEqual(on([['a', '雨点落在旧木架上'], ['b', '雨点落在旧木架上'], ['c', '沈岚撑着伞跟出来']]), { 0: 'a', 2: 'b', 3: 'c' })
  assert.deepEqual(on([['a', '会是谁呢她低声问'], ['b', '会是谁呢她低声问']]), { 3: 'a' }, 'no line left: in the corner only')
  assert.equal(picturesOnLines(undefined, lines).size, 0)
})
