// Pictures a story or an opening shows by their address (web/render.js takePictures): as SillyTavern shows them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownHtml, pictureHtml, takePictures } from '../web/render.js'

test('pictures by address: Markdown, an <img>, an address alone on its line; not one inside a sentence or a link', () => {
  const found = []
  const mark = (src, alt) => {
    found.push([src, alt])
    return '[P]'
  }
  const text = [
    '雨停了。',
    '![宅邸](https://files.example.com/a.jpg "门前")',
    '<img src="https://files.example.com/b.png" alt="小雪" width="300">',
    '  https://files.example.com/c.webp?x=1  ',
    '她说起 https://files.example.com/d.jpg 这张照片。',
    '[看看](https://files.example.com/e.jpg)',
    '<img src="/local.png">',
  ].join('\n')
  assert.equal(takePictures(text, mark), ['雨停了。', '[P]', '[P]', '  [P]', '她说起 https://files.example.com/d.jpg 这张照片。', '[看看](https://files.example.com/e.jpg)', '<img src="/local.png">'].join('\n'))
  assert.deepEqual(found, [['https://files.example.com/a.jpg', '宅邸'], ['https://files.example.com/b.png', '小雪'], ['https://files.example.com/c.webp?x=1', '']])
})

test('a picture as a story shows it: its address and words escaped', () => {
  assert.equal(pictureHtml('https://x.example/p.png?a=1&b=2', 'a"<b>'), '<img class="story-picture" src="https://x.example/p.png?a=1&amp;b=2" alt="a&quot;&lt;b&gt;" loading="lazy" referrerpolicy="no-referrer">')
})

test('直连对话 (Markdown answers) fetches no picture by itself: a link to open, the bare address as text', () => {
  const html = markdownHtml('看这张：![图](https://x.example/p.png?q=secret)\n\nhttps://x.example/q.png\n\n<img src="https://x.example/r.png">')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /<a href="https:\/\/x\.example\/p\.png\?q=secret"/)
})
