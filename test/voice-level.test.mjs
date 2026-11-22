import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEVEL_TARGET_DB, applyGain, levelGain, loudnessDb, wavBytes } from '../web/shared/speech.js'
import { cleanRoster } from '../server/roster.mjs'

const RATE = 8000
/** A tone at `amplitude` for `seconds`, then as long again of silence (a pause between lines). */
function toneWithPause(amplitude, seconds = 1) {
  const data = new Float32Array(RATE * seconds * 2)
  for (let i = 0; i < RATE * seconds; i++) data[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return data
}

test('voice levelling: loudness leaves out the pauses, and a quiet voice is raised to the same level as a loud one', () => {
  const loud = toneWithPause(0.5)
  const quiet = toneWithPause(0.02)
  // A sine at amplitude a is a²/2 in power; the silent second does not pull it down.
  assert.ok(Math.abs(loudnessDb([loud], RATE) - 10 * Math.log10(0.125)) < 0.1)
  assert.equal(loudnessDb([new Float32Array(RATE)], RATE), null, 'silence has no loudness')
  for (const data of [loud, quiet]) {
    const after = loudnessDb([applyGain(data, levelGain(loudnessDb([data], RATE)))], RATE)
    assert.ok(Math.abs(after - LEVEL_TARGET_DB) < 0.5, `levelled to ${after}`)
  }
  // Raised by 20 dB at most, and a cast member's 音量 goes on top.
  assert.equal(levelGain(-80), 10)
  assert.equal(levelGain(LEVEL_TARGET_DB, 1.5), 1.5)
  assert.equal(levelGain(null, 0.5), 0.5)
  // Peaks are rounded off below full scale, not clipped; quiet samples are left as they are.
  const peaks = applyGain(Float32Array.from([0.5, -0.5, 0.1]), 4)
  assert.ok(peaks[0] < 1 && peaks[0] > 0.9 && peaks[1] === -peaks[0])
  assert.ok(Math.abs(peaks[2] - 0.4) < 1e-6)
})

test('voice levelling: the WAV it plays is 16-bit PCM of the samples', () => {
  const bytes = wavBytes([Float32Array.from([0, 1, -1])], RATE)
  const view = new DataView(bytes.buffer)
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF')
  assert.equal(view.getUint32(24, true), RATE)
  assert.equal(view.getUint32(40, true), 6)
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [0, 32767, -32768])
})

test('roster: a cast member\'s 音量 is kept in percent within 25–200, and 100 is left unsaid', () => {
  const [quiet, loud, plain, odd] = cleanRoster([
    { name: '莉莉丝', volume: 160 },
    { name: '伊芙琳', volume: 999 },
    { name: '莉瑟', volume: 100 },
    { name: '维拉', volume: 'loud' },
  ])
  assert.equal(quiet.volume, 160)
  assert.equal(loud.volume, 200)
  assert.equal('volume' in plain, false)
  assert.equal('volume' in odd, false)
  assert.equal(cleanRoster([{ name: '卡蜜拉', volume: 3 }])[0].volume, 25)
})

test('默认语气: a cast member\'s tone is said when the reply gives the line none; the reply\'s own tag wins; narration has none', async () => {
  const { speechChunks } = await import('../web/shared/speech.js')
  const { cleanTone } = await import('../server/roster.mjs')
  const tone = speaker => ({ 卡蜜拉: '拖长尾音，像在逗弄猎物', 莉娅: '' })[speaker] ?? ''
  const speakerOf = said => (said.startsWith('小少爷') ? '卡蜜拉' : said.startsWith('少爷') ? '莉娅' : '卡蜜拉')
  const text = '她笑了。“小少爷还真讲究。”又说：“先付茶钱。”[voice:压低声音:]“少爷，您回来了。”'
  const chunks = speechChunks(text, { narration: true, tags: true, speakerOf, tone })
  // Narration has no tone; the reply's own tag wins for its line; a speaker with no tone gets no tag.
  assert.deepEqual(chunks.map(c => c.text), ['她笑了。', '[拖长尾音、像在逗弄猎物] 小少爷还真讲究。', '又说：', '[压低声音] 先付茶钱。', '少爷，您回来了。'])
  // Without tags (voices that do not act on them) the tone is left out.
  assert.equal(speechChunks('“台词。”', { narration: false, tone: '软软地' })[0].text, '台词。')
  // Two lines said the same way: the tag is said once.
  assert.equal(speechChunks('“一。”“二。”', { narration: false, tags: true, tone: '软软地' })[0].text, '[软软地] 一。二。')
  // A long line cut into requests keeps its tone in each.
  const long = speechChunks(`“${'很长的一句话，'.repeat(30)}”`, { narration: false, tags: true, tone: '软软地', max: 60 })
  assert.ok(long.length > 1 && long.every(c => c.text.startsWith('[软软地] ')))
  // Stored without brackets or colons (they would break a tag), at most 40 characters, dropped when empty.
  assert.equal(cleanTone('[拖长尾音：像在逗弄猎物]\n'), '拖长尾音 像在逗弄猎物')
  assert.equal(cleanTone('长'.repeat(60)).length, 40)
  const [kept, empty] = cleanRoster([{ name: '卡蜜拉', tone: ' 软软地 ' }, { name: '莉娅', tone: '  ' }])
  assert.equal(kept.tone, '软软地')
  assert.equal('tone' in empty, false)
})
