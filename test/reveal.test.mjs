// 出字效果: the pace a reply being written is shown at (web/shared/reveal.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REVEAL_DEFAULT, REVEAL_MODES, createPacer, sentenceEnd, stepAt, topLevel } from '../web/shared/reveal.js'
import { cleanReading } from '../web/shared/appearance.js'
import { FOLD_TAG } from '../web/shared/vn.js'

const FOLDS = new RegExp(`^(?:${FOLD_TAG})$`, 'i')
const FRAME = 16

/** Plays `lumps` ([time, text so far]) into a pacer frame by frame; ends at `endAt`. Returns what each frame showed. */
function play(mode, lumps, { endAt = Infinity, until = 60000, folds = null } = {}) {
  const pacer = createPacer({ mode, folds })
  const frames = []
  const queue = lumps.slice()
  for (let now = 0; now < until; now += FRAME) {
    while (queue.length && queue[0][0] <= now) pacer.push(queue.shift()[1], now)
    if (now >= endAt && !pacer.ended) pacer.end()
    frames.push({ now, shown: pacer.tick(now, FRAME), length: pacer.source.length })
    if (pacer.done) break
  }
  return { pacer, frames }
}

const TEXT = '雨是从黄昏开始下的。林雪把伞收在门边，抖了抖袖口上的水，抬头看见柜台后面那盏旧灯还亮着。'.repeat(12)

/** A relay: lumps of 60 characters every 500 ms. */
function relay(text = TEXT, size = 60, every = 500) {
  const lumps = []
  for (let at = size, time = 0; at < text.length + size; at += size, time += every) lumps.push([time, text.slice(0, Math.min(at, text.length))])
  return lumps
}

test('the modes, and the setting kept with the reading settings (default 淡入)', () => {
  assert.deepEqual(REVEAL_MODES, ['fade', 'ink', 'type', 'sentence', 'none'])
  assert.equal(REVEAL_DEFAULT, 'fade')
  assert.equal(cleanReading(null).reveal, 'fade')
  assert.equal(cleanReading({ reveal: 'ink' }).reveal, 'ink')
  assert.equal(cleanReading({ reveal: 'sparkle' }).reveal, 'fade')
})

test('markup costs no time: tags, 【name|look】 marks, the stars of bold; a half-written mark is waited for', () => {
  assert.deepEqual(stepAt('<b>雨', 0), { next: 3, cost: 0 })
  assert.deepEqual(stepAt('【林雪|微笑】“你来了。”', 0), { next: 7, cost: 0 })
  assert.deepEqual(stepAt('**雨**', 0), { next: 1, cost: 0 })
  assert.deepEqual(stepAt('雨', 0), { next: 1, cost: 1 })
  assert.deepEqual(stepAt('😀', 0), { next: 2, cost: 1 }, 'a character outside the BMP is not split')
  assert.equal(stepAt('<fon', 0), null, 'a tag still being written')
  assert.equal(stepAt('【林雪|', 0), null, 'a name mark still being written')
  assert.deepEqual(stepAt('3 < 5 and 6 > 4', 2), { next: 3, cost: 1 }, 'a < that is not a tag is a character')
  assert.deepEqual(stepAt('<think>想一想</think>雨', 0, FOLDS), { next: 18, cost: 0 }, "a fold's insides are passed over")
})

test('sentences end at their stop and the closing marks after it', () => {
  const s = '“你来了。”她说。还没'
  assert.equal(sentenceEnd(s, 0), 6)
  assert.equal(sentenceEnd(s, 6), 9)
  assert.equal(sentenceEnd(s, 9), -1, 'a sentence not ended yet')
})

test('a relay\'s lumps come out evenly: a few characters a frame, never the whole lump at once', () => {
  const { frames } = play('fade', relay(), { endAt: relay().at(-1)[0] + 50 })
  const steps = frames.slice(1).map((frame, i) => frame.shown - frames[i].shown)
  assert.ok(Math.max(...steps) <= 6, `at most a few characters a frame (was ${Math.max(...steps)})`)
  // Once going, the reply is not left standing still while there is text waiting.
  const waiting = frames.filter(frame => frame.now > 600 && frame.length > frame.shown + 2)
  let still = 0
  let longest = 0
  for (let i = 1; i < frames.length; i++) {
    still = frames[i].shown === frames[i - 1].shown && waiting.includes(frames[i]) ? still + FRAME : 0
    longest = Math.max(longest, still)
  }
  assert.ok(longest <= 3 * FRAME, `no stalls with text waiting (longest ${longest} ms)`)
})

test('it never falls far behind, and is all shown soon after the reply ends', () => {
  const lumps = relay()
  const endAt = lumps.at(-1)[0] + 50
  const { frames } = play('fade', lumps, { endAt })
  for (const frame of frames) {
    const arrived = lumps.filter(([time]) => time <= frame.now - 1200).at(-1)?.[1].length ?? 0
    assert.ok(frame.shown >= arrived, `at ${frame.now} ms what came 1.2 s ago is shown (${frame.shown} < ${arrived})`)
  }
  const done = frames.at(-1)
  assert.equal(done.shown, TEXT.length)
  assert.ok(done.now - endAt <= 400, `done ${done.now - endAt} ms after the end`)
})

test('a fast model is not held back', () => {
  // 400 characters a second, in crumbs every frame.
  const lumps = []
  for (let time = 0, at = 0; at < TEXT.length; time += FRAME) lumps.push([time, TEXT.slice(0, (at = Math.min(TEXT.length, at + 6.4)) | 0)])
  const endAt = lumps.at(-1)[0] + 20
  const { frames } = play('type', lumps, { endAt })
  assert.ok(frames.at(-1).now - endAt <= 350, `done ${frames.at(-1).now - endAt} ms after the end`)
})

test('when the model pauses, the rest runs out at a slowing pace instead of stopping dead', () => {
  const lumps = [[0, TEXT.slice(0, 200)]]
  const { frames } = play('fade', lumps, { until: 4000 })
  const rate = (from, to) => (frames.find(f => f.now >= to).shown - frames.find(f => f.now >= from).shown) / ((to - from) / 1000)
  assert.ok(rate(100, 400) > rate(700, 1000), 'slower later')
  assert.equal(frames.at(-1).shown, 200, 'and all of it shown in the end')
})

test('直接显示 shows everything at once', () => {
  const { frames } = play('none', relay(), { endAt: 10000 })
  for (const frame of frames) assert.equal(frame.shown, frame.length)
})

test('逐句 shows whole sentences, and an unfinished one after a while', () => {
  const text = '雨还没停。她把伞靠在门边。“你也是来避雨的？”她问。'
  const { frames } = play('sentence', [[0, text]], { endAt: 100 })
  const shown = [...new Set(frames.map(frame => frame.shown))]
  assert.deepEqual(shown.map(at => text.slice(0, at)).filter(Boolean), ['雨还没停。', '雨还没停。她把伞靠在门边。', '雨还没停。她把伞靠在门边。“你也是来避雨的？”', text])
  const half = play('sentence', [[0, '她低头看着自己的手，看了很久']], { until: 3000 }).frames
  assert.equal(half.at(-1).shown, '她低头看着自己的手，看了很久'.length, 'a sentence still being written shows after a wait')
  assert.equal(half.find(frame => frame.now === 400).shown, 0, 'but not at once')
})

test('a fold still being written is passed over, up to its closing tag', () => {
  const pacer = createPacer({ mode: 'fade', folds: FOLDS })
  pacer.push('<think>先想一想这一段怎么写', 0)
  for (let now = 0; now < 500; now += FRAME) pacer.tick(now, FRAME)
  assert.equal(pacer.shown, pacer.source.length)
  pacer.push('<think>先想一想这一段怎么写，再动笔</think>雨停了。', 500)
  pacer.tick(516, FRAME)
  assert.ok(pacer.shown <= '<think>先想一想这一段怎么写，再动笔</think>雨'.length, 'the story after it is paced, the thinking is not')
  assert.ok(pacer.shown >= '<think>先想一想这一段怎么写，再动笔</think>'.length)
})

test('reset starts from nothing (the reply asked for again)', () => {
  const pacer = createPacer({ mode: 'fade' })
  pacer.push(TEXT, 0)
  for (let now = 0; now < 1000; now += FRAME) pacer.tick(now, FRAME)
  assert.ok(pacer.shown > 0)
  pacer.reset()
  assert.equal(pacer.shown, 0)
  pacer.push('雨', 1000)
  assert.equal(pacer.source, '雨')
})

test("a reply's HTML cut at the top level: a redraw parses only the pieces that changed", () => {
  assert.deepEqual(topLevel('<p>雨<br>停了</p><p>“<span class="q">走吧</span>”</p>'), ['<p>雨<br>停了</p>', '<p>“<span class="q">走吧</span>”</p>'])
  assert.deepEqual(topLevel('<details class="fold"><summary>思考</summary><div>a</div></details><p>b</p>'), ['<details class="fold"><summary>思考</summary><div>a</div></details>', '<p>b</p>'])
  assert.deepEqual(topLevel('前面<hr>后面'), ['前面', '<hr>', '后面'])
  assert.deepEqual(topLevel('<button type="button" class="choice" data-choice="a > b"><b>1</b></button>'), ['<button type="button" class="choice" data-choice="a > b"><b>1</b></button>'])
  assert.deepEqual(topLevel('<p>a<!-- </p> --></p>'), ['<p>a<!-- </p> --></p>'])
  assert.equal(topLevel('<p>a</div>'), null, 'tags that do not pair up')
  assert.equal(topLevel('<p>a'), null)
  assert.deepEqual(topLevel(''), [])
})
