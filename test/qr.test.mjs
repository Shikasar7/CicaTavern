// The QR codes of the phone links (server/qr.mjs). The fingerprints are of codes an independent reader (OpenCV) read back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { qrMatrix, qrSvg } from '../server/qr.mjs'

const LINK = 'http://192.168.0.178:8790/#k=0123456789abcdef0123456789abcdef0123'
const fingerprint = cells => createHash('sha256').update(cells.map(row => row.join('')).join('\n')).digest('hex').slice(0, 16)

test('a code comes out the same as the ones read back: small, a phone link, with version bits, with a long length field', () => {
  const cases = [
    ['HELLO WORLD', 21, '2d21897bf5a7ac60'],
    [LINK, 37, 'b2af0005ece08629'],
    ['http://x/#k='.padEnd(122, 'abcdefghij0123456789'), 45, '3f13883b3e4e2561'],
    ['http://x/#k='.padEnd(213, 'abcdefghij0123456789'), 57, '2b893deb03fd0ae1'],
  ]
  for (const [text, size, print] of cases) {
    const cells = qrMatrix(text)
    assert.equal(cells.length, size, text)
    assert.equal(fingerprint(cells), print, text)
  }
})

test('every code has its finder squares, its timing lines and level M', () => {
  const cells = qrMatrix(LINK)
  const size = cells.length
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    assert.deepEqual(cells[y].slice(x, x + 7), [1, 1, 1, 1, 1, 1, 1])
    assert.deepEqual(cells[y + 2].slice(x, x + 7), [1, 0, 1, 1, 1, 0, 1])
  }
  for (let i = 8; i < size - 8; i++) assert.equal(cells[6][i], i % 2 === 0 ? 1 : 0)
  const spots = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
  const format = spots.reduce((bits, [x, y], i) => bits | (cells[y][x] << i), 0) ^ 0x5412
  assert.equal(format >> 13, 0, 'level M')
})

test('a link too long for a code gives none, and the page then has no button to show', () => {
  assert.equal(qrMatrix('x'.repeat(412)).length, 77)
  assert.equal(qrMatrix('x'.repeat(413)), null)
  assert.equal(qrSvg('x'.repeat(413)), '')
})

test('the picture has the margin a scanner needs, and the text only as dark modules', () => {
  const svg = qrSvg(LINK)
  assert.match(svg, /^<svg [^>]*viewBox="0 0 45 45"/)
  assert.match(svg, /<path fill="#000" d="M4 4h7v1h-7z/)
  assert.ok(!svg.includes('192.168'), 'the link is not written out in it')
})
