// What the model that writes a picture's prompt is told: the default rules
// (framing, Danbooru tags, no names, the art style), 提示词详细程度, the user's
// 写提示词的额外要求 (every card's, then the card's own), and the 画风预设.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { cleanCardMedia, cleanMedia, cleanPrompt, contextImageInstruction, createMedia, imagePromptRequest, promptRulesOf } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { cleanFrame, frameFormat } from '../server/roster.mjs'
import { createStore } from '../server/store.mjs'
import { STYLE_PRESETS, stylePresetOf } from '../web/shared/draw.js'

const CARD = { description: '短黑发，浅蓝警服。' }
const NAMES = { char: '林雪', user: '我' }
const ROSTER = [{ id: 'a1', name: '林雪', kind: 'girl', looks: 'short black hair', outfit: 'light blue police uniform', player: false }]
const ask = options => imagePromptRequest({ card: CARD, names: NAMES, reply: '她敬了个礼。', input: '', state: {}, style: '', promptStyle: 'natural', ...options })
const taskOf = request => request.messages[0].content.slice(request.messages[0].content.indexOf('TASK:'))

test('the default rules: framing first, no names, Danbooru tags for tag prompts, the art style', () => {
  const natural = taskOf(ask({ style: 'watercolor' }))
  assert.match(natural, /framing \(close-up, upper body, full body or wide shot\) and camera angle/)
  assert.match(natural, /Never use character names/)
  assert.match(natural, /Format: one English paragraph of 60-100 words\./)
  assert.match(natural, /Start the prompt with the art style in <art_style>, word for word/, 'image APIs only get the style as the helper writes it')
  const tags = taskOf(ask({ style: 'watercolor', promptStyle: 'tags' }))
  assert.match(tags, /Danbooru-style tags[\s\S]*1girl, solo/)
  assert.match(tags, /Format: 30-50 comma-separated English tags, no sentences\./)
  assert.match(tags, /Leave out the art style in <art_style>: it is added on its own/, 'withStyle puts it first for tag prompts')
  assert.doesNotMatch(taskOf(ask({})), /art_style/, 'no style, no rule about it')
  // A cast names its people in [Name] lines: no "never use names", and the style starts the 场景 line.
  const cast = taskOf(ask({ roster: ROSTER, style: 'watercolor' }))
  assert.doesNotMatch(cast, /Never use character names/)
  assert.match(cast, /Start the 场景 line with the art style/)
  assert.match(cast, /场景: one or two English sentences for the shot \(close-up/)
})

test('提示词详细程度 changes the length asked for, the hint, the token room and where an answer is cut', () => {
  const brief = ask({ detail: 'brief' })
  const standard = ask({ detail: 'standard' })
  const detailed = ask({ detail: 'detailed' })
  assert.match(taskOf(brief), /Format: one English paragraph of 25-45 words\./)
  assert.match(taskOf(brief), /Keep it short/)
  assert.match(taskOf(detailed), /Format: one English paragraph of 120-180 words\./)
  assert.match(taskOf(detailed), /Be thorough: clothing details/)
  assert.doesNotMatch(taskOf(standard), /Keep it short|Be thorough/)
  assert.match(brief.system, /25-45 words/, 'the system part says the same format')
  assert.deepEqual([brief.maxTokens, standard.maxTokens, detailed.maxTokens], [400, 400, 640])
  assert.equal(ask({ detail: 'bogus' }).maxTokens, 400, 'an unknown level is the standard one')
  assert.match(taskOf(ask({ detail: 'detailed', promptStyle: 'tags' })), /50-80 comma-separated English tags/)
  assert.match(taskOf(ask({ detail: 'brief', promptStyle: 'tags' })), /15-30 comma-separated English tags/)
  // A cast's lines grow too.
  assert.match(frameFormat('tags', 'detailed'), /场景: 25-45 comma-separated English tags[\s\S]*\[Name\] 20-35 comma-separated/)
  assert.match(frameFormat('tags', 'brief'), /场景: 8-15 comma-separated English tags[\s\S]*\[Name\] 6-12 comma-separated/)
  assert.match(taskOf(ask({ roster: ROSTER, detail: 'detailed' })), /two or three English sentences/)
  assert.equal(ask({ roster: ROSTER, detail: 'detailed' }).maxTokens, 1120)

  // The answer is cut where its level ends, not at the standard length.
  const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ')
  assert.equal(cleanPrompt(long, 'natural', 'brief').split(' ').length, 60)
  assert.equal(cleanPrompt(long, 'natural').split(' ').length, 120)
  assert.equal(cleanPrompt(long, 'natural', 'detailed').split(' ').length, 200)
  const tags = Array.from({ length: 120 }, (_, i) => `t${i}`).join(', ')
  assert.deepEqual([40, 70, 100], ['brief', 'standard', 'detailed'].map(detail => cleanPrompt(tags, 'tags', detail).split(', ').length))
  const frame = `场景: ${'x '.repeat(150)}\n[林雪] ${'y '.repeat(150)}`
  const words = (answer, detail) => cleanFrame(answer, detail).split('\n').map(line => line.split(' ').length)
  assert.deepEqual(words(frame, 'brief'), [40, 30])
  assert.deepEqual(words(frame), [70, 50])
  assert.deepEqual(words(frame, 'detailed'), [110, 80])
})

test("写提示词的额外要求: every card's, then the card's own, last before the reply, winning over the defaults", () => {
  assert.equal(promptRulesOf({ promptRules: ' Start with masterpiece. ' }, { promptRules: 'She wears a red ribbon.' }), 'Start with masterpiece.\n\nShe wears a red ribbon.')
  assert.equal(promptRulesOf({ promptRules: '' }, { promptRules: 'Only hers.' }), 'Only hers.')
  assert.equal(promptRulesOf({}, {}), '')
  const task = taskOf(ask({ rules: 'Start with masterpiece.\n\nShe wears a red ribbon.' }))
  assert.match(task, /Format: [^\n]+\nThe user's own rules for these prompts \(they win where they differ from the above[^\n]*\n<user_rules>\nStart with masterpiece\.\n\nShe wears a red ribbon\.\n<\/user_rules>\nReply with the prompt only\.$/)
  assert.doesNotMatch(taskOf(ask({})), /user_rules/)

  // Asked inside the conversation: the same options, in Chinese.
  const inChat = contextImageInstruction({ promptStyle: 'natural', style: 'watercolor', passage: '', detail: 'detailed', rules: '多写光影' })
  assert.match(inChat, /提示词以这段画风开头，原样照抄：watercolor/)
  assert.match(inChat, /写细一点/)
  assert.match(inChat, /一段 120-180 个英文单词/)
  assert.match(inChat, /用户自己定的写法[^\n]*\n<user_rules>\n多写光影\n<\/user_rules>\n只输出提示词本身/)
  const short = contextImageInstruction({ promptStyle: 'tags', style: '', passage: '', detail: 'brief' })
  assert.match(short, /15-30 个英文标签[\s\S]*Danbooru/)
  assert.match(short, /写短一点/)
  assert.doesNotMatch(short, /user_rules|画风/)
})

test('settings: 详细程度 one of three, 额外要求 kept with their line breaks and capped', () => {
  assert.equal(cleanMedia({}).promptDetail, 'standard')
  assert.equal(cleanMedia({}).promptRules, '')
  assert.equal(cleanMedia({ promptDetail: 'detailed' }).promptDetail, 'detailed')
  assert.equal(cleanMedia({ promptDetail: 'huge' }, { promptDetail: 'brief' }).promptDetail, 'brief', 'an unknown level keeps the saved one')
  assert.equal(cleanMedia({ promptRules: '  a\r\nb  ' }).promptRules, 'a\nb')
  assert.equal(cleanMedia({ promptRules: 'x'.repeat(5000) }).promptRules.length, 4000)
  assert.equal(cleanMedia({}, { promptRules: 'kept' }).promptRules, 'kept', 'a save without the field keeps them')
  assert.equal(cleanCardMedia({ promptRules: ' red ribbon ' }).promptRules, 'red ribbon')
  assert.equal(cleanCardMedia({ promptRules: 'y'.repeat(3000) }).promptRules.length, 2000)
  assert.equal(cleanCardMedia({ style: 'x' }, { promptRules: 'kept' }).promptRules, 'kept')
})

test('画风预设: words for tags and for sentences, a NovelAI negative, a name in the page', async () => {
  const ids = STYLE_PRESETS.map(preset => preset.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(STYLE_PRESETS.length >= 6)
  const page = await readFile(new URL('../web/media.js', import.meta.url), 'utf8')
  const names = /const STYLE_PRESET_NAMES = \{([^\n]+)\}/.exec(page)[1]
  for (const preset of STYLE_PRESETS) {
    for (const key of ['tags', 'natural', 'negative']) {
      assert.ok(preset[key] && !/[一-鿿]/.test(preset[key]), `${preset.id}.${key} is English`)
      assert.ok(preset[key].length <= 600, 'fits a card 画风')
    }
    assert.notEqual(preset.tags, preset.natural)
    assert.match(names, new RegExp(`\\b${preset.id}: t\``), `${preset.id} has a name`)
    assert.equal(stylePresetOf(preset.tags), preset)
    assert.equal(stylePresetOf(` ${preset.natural} `), preset)
  }
  assert.equal(stylePresetOf('my own watercolor look'), null)
  assert.equal(stylePresetOf(''), null)
})

test('writing a prompt: the saved 详细程度 and both sets of 额外要求 reach the helper model', async t => {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    seen.push(JSON.parse(Buffer.concat(chunks)))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'A girl salutes in a quiet office at night.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-prompt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '林雪', description: CARD.description, first_mes: '站住。' } })
  await store.saveCard(card, Buffer.from('89504e470d0a1a0a', 'hex'))
  const helper = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-prompt-test', models: ['helper'] })
  await store.saveProviders([helper])
  await store.saveSettings({ media: cleanMedia({ helperModel: `${helper.id}/helper`, promptDetail: 'detailed', promptRules: 'Start with masterpiece.' }) })
  const media = createMedia(store)
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), promptRules: 'She wears a red ribbon.' })
  const chat = await createChat(store, card.id)

  await media.writeImagePrompt(chat, chat.nodes.root, { reply: '林雪敬了个礼。', input: '' })
  const sent = seen.at(-1)
  const content = sent.messages.at(-1).content
  assert.match(content, /120-180 words/)
  assert.match(content, /<user_rules>\nStart with masterpiece\.\n\nShe wears a red ribbon\.\n<\/user_rules>/)
  assert.equal(sent.max_tokens, 640)

  await store.saveSettings({ media: cleanMedia({ promptDetail: 'brief', promptRules: '' }, (await store.getSettings()).media) })
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), promptRules: '' })
  await media.writeImagePrompt(chat, chat.nodes.root, { reply: '林雪敬了个礼。', input: '' })
  const plain = seen.at(-1).messages.at(-1).content
  assert.match(plain, /25-45 words/)
  assert.doesNotMatch(plain, /user_rules/)
  assert.equal(seen.at(-1).max_tokens, 400)
})
