// 自动压缩 (server/context.mjs): a model's context window, the threshold, what a reply's turn
// held, the limit a context-full error names; the wordings counted as context full; what an
// archive looks like (recap.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanCompaction, contextUsed, knownWindow, limitFromError, thresholdFor, windowOf } from '../server/context.mjs'
import { CONTEXT_FULL } from '../server/providers.mjs'
import { keptArchive, looksLikeArchive } from '../server/recap.mjs'

test('context windows: the table by model id (vendor prefixes ignored), what was learned, what the player set', () => {
  assert.equal(knownWindow('deepseek-flash'), 1_000_000)
  assert.equal(knownWindow('deepseek/deepseek-chat'), 1_000_000)
  assert.equal(knownWindow('anthropic/claude-sonnet-5-5'), 1_000_000)
  assert.equal(knownWindow('claude-haiku-4-5'), 200_000)
  assert.equal(knownWindow('gpt-5.4-mini'), 272_000)
  assert.equal(knownWindow('models/gemini-3.1-pro-preview'), 1_048_576)
  assert.equal(knownWindow('qwen-max'), 32 * 1024)
  assert.equal(knownWindow('ep-20260101-abc'), 0, 'an Ark endpoint id names no model')

  assert.deepEqual(windowOf('ds/deepseek-flash'), { tokens: 1_000_000, source: 'table' })
  assert.deepEqual(windowOf('relay/odd-model'), { tokens: 128_000, source: 'guess' })
  assert.deepEqual(windowOf('relay/odd-model', { learned: { 'odd-model': 64_000 } }), { tokens: 64_000, source: 'learned' })
  assert.deepEqual(windowOf('relay/odd-model', { learned: { 'relay/odd-model': 32_000, 'odd-model': 64_000 } }).tokens, 32_000, 'this provider first')
  const settings = { compaction: { windows: { 'relay/odd-model': 50_000 } } }
  assert.deepEqual(windowOf('relay/odd-model', { settings, learned: { 'odd-model': 64_000 } }), { tokens: 50_000, source: 'set' })
})

test('the threshold: 70 % of the window, at most 150K, always with room for one more turn and the archive', () => {
  assert.equal(thresholdFor(1_000_000, null), 150_000)
  assert.equal(thresholdFor(128_000, null), 89_600)
  assert.equal(thresholdFor(32_768, null), 22_938)
  // A small window keeps its reserve whatever the share says.
  assert.equal(thresholdFor(16_000, null), 8_000)
  assert.equal(thresholdFor(16_000, { percent: 95 }), 8_000)
  assert.equal(thresholdFor(1_000_000, { percent: 50, cap: 0 }), 500_000, 'no cap')
  assert.deepEqual(cleanCompaction(null), { auto: true, percent: 70, cap: 150_000, windows: {} })
  assert.deepEqual(cleanCompaction({ auto: false, percent: 120, cap: '0', windows: { a: 500, b: '64000' } }), { auto: false, percent: 95, cap: 0, windows: { b: 64_000 } })
})

test('what a reply\'s turn held: the whole input, cached or not, and the reply', () => {
  assert.equal(contextUsed({ usage: { input: 40, cacheRead: 60, cacheWrite: 0, output: 7 } }), 107)
  assert.equal(contextUsed({ usage: { input: 5, cacheRead: 70, cacheWrite5m: 20, cacheWrite1h: 10, output: 11 } }), 116)
  assert.equal(contextUsed({}), 0)
})

test('context-full errors: the wordings providers use, and the limit when they name it', () => {
  for (const said of [
    "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens",
    'prompt is too long: 1000500 tokens > 1000000 maximum',
    'The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).',
    'Input token length too long',
    'Prompt 超长',
    'Range of input length should be [1, 991808]',
    'Total message token length exceed model limit (10000000 tokens)',
    'error code: context_length_exceeded',
    '请求的上下文长度超过了模型的最大长度',
  ]) assert.match(said, CONTEXT_FULL, said)
  for (const said of ['max_tokens: 65536 > 8192, which is the maximum allowed number of output tokens', 'Rate limit reached', 'invalid api key']) {
    assert.doesNotMatch(said, CONTEXT_FULL, said)
  }
  assert.equal(limitFromError("This model's maximum context length is 131,072 tokens."), 131_072)
  assert.equal(limitFromError('prompt is too long: 1000500 tokens > 1000000 maximum'), 1_000_000)
  assert.equal(limitFromError('The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).'), 1_048_576)
  assert.equal(limitFromError('Range of input length should be [1, 991808]'), 991_808)
  assert.equal(limitFromError('Input token length too long'), 0)
})

test('an archive is in its tags or has its parts as headings; a story carried on is not one', () => {
  assert.ok(looksLikeArchive('<剧情存档>\n小雨……'))
  assert.ok(looksLikeArchive('1. 人物：小雨\n2. 经过：……\n3. 未完的线：……\n4. 当前场景：咖啡店'))
  assert.ok(looksLikeArchive('## 人物\n小雨\n## 关键事件\n……\n## 当前场景\n……'))
  assert.ok(!looksLikeArchive('小雨放下杯子，看了看窗外的人物剪影。现在的场景让她想起了过去的经过。'))
  const path = [{ role: 'assistant', compaction: { summary: '旧存档' } }, { role: 'user' }, { role: 'assistant' }]
  assert.match(keptArchive(path, 5), /^旧存档\n\n（此后又过了 5 轮/)
  assert.match(keptArchive(path.slice(1), 3), /前面的 3 轮没有写成存档/)
})
