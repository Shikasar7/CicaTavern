// The image backends beside the images API: Gemini's own image models (with
// the cast's reference pictures), Stable Diffusion WebUI / Forge, gpt-image's
// answer format; and Gemini's speech models as a voice source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { cleanMedia, createMedia, imageFormat } from '../server/media.mjs'
import { googleBase, normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { geminiDefaultVoices, geminiSpeechText } from '../server/voice/gemini.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const KEY = 'AIza-backends-test-0000'
const FRAME = '场景: tea house, rain, evening\n[林雪] holding a teacup, smiling | center'

async function fake(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    seen.push({ url: req.url, json, key: req.headers['x-goog-api-key'], auth: req.headers.authorization })
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/v1beta/models/gemini-2.5-flash-image:generateContent') {
      if (json.contents[0].parts.at(-1).text.includes('refuse me')) return send(200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [{ text: 'I cannot draw that.' }] } }] })
      return send(200, { candidates: [{ content: { parts: [{ text: 'Here it is.' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] })
    }
    if (req.url === '/v1beta/models/gemini-2.5-flash-preview-tts:generateContent') {
      return send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] })
    }
    if (req.url === '/sdapi/v1/txt2img') return send(200, { images: [PNG.toString('base64')], parameters: {}, info: '{}' })
    send(404, { error: { message: 'not here' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function setup(t) {
  const server = await fake(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-backends-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '林雪', description: '短黑发。', first_mes: '站住。' } })
  await store.saveCard(card, PNG)
  // The Gemini template: Google's OpenAI-compatible address; images and speech go to the native one beside it.
  const google = normalizeProvider({ name: 'Gemini', api: 'openai-completions', baseURL: `${server.base}/v1beta/openai`, apiKey: KEY, models: ['gemini-3-flash-preview'] })
  await store.saveProviders([google])
  const media = createMedia(store)
  const chat = await createChat(store, card.id)
  return { server, store, card, chat, media, google }
}

test('Gemini images: Google\'s own API with its key, the cast\'s reference pictures first, the aspect ratio; a refusal explained', async t => {
  const { server, store, card, chat, media, google } = await setup(t)
  assert.equal(googleBase(google), `${server.base}/v1beta`)
  assert.equal(googleBase({ baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' }), 'https://generativelanguage.googleapis.com/v1beta')
  const saved = await media.saveCardMedia(card.id, { roster: [{ name: '林雪', looks: 'short black hair' }] })
  await media.saveRosterRef(card.id, saved.roster[0].id, `data:image/png;base64,${PNG.toString('base64')}`)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'gemini', geminiImageProvider: google.id, imageShape: 'portrait' }) })

  const image = await media.generateImage(chat, 'root', FRAME)
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  assert.equal(image.backend, 'gemini-2.5-flash-image')
  const call = server.seen.at(-1)
  assert.equal(call.key, KEY, 'the key as x-goog-api-key')
  assert.equal(call.auth, undefined)
  const parts = call.json.contents[0].parts
  assert.match(parts[0].text, /Reference picture of 林雪/)
  assert.deepEqual(Buffer.from(parts[1].inlineData.data, 'base64'), PNG)
  assert.match(parts.at(-1).text, /holding a teacup/)
  assert.equal(call.json.generationConfig.imageConfig.aspectRatio, '2:3')

  // Without references the prompt goes alone.
  await store.saveSettings({ media: cleanMedia({ geminiReference: false }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', FRAME)
  assert.equal(server.seen.at(-1).json.contents[0].parts.length, 1)
  await assert.rejects(media.generateImage(chat, 'root', 'refuse me'), /没有画出图（IMAGE_SAFETY）：I cannot draw that/)

  await store.saveSettings({ media: cleanMedia({ geminiImageProvider: '' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'a cat'), /Gemini 生图用的供应商/)
})

test('SD WebUI / Forge: txt2img with its settings, a lone cast member\'s LoRA in the prompt', async t => {
  const { server, store, card, chat, media } = await setup(t)
  await media.saveCardMedia(card.id, { roster: [{ name: '林雪', looks: 'short black hair', lora: 'linxue_v2.safetensors', loraTrigger: 'linxue', loraStrength: 0.7 }] })
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'sdwebui', sdUrl: `${server.base}/`, sdSteps: 20, sdCfg: 5.5, sdSampler: 'DPM++ 2M', imageShape: 'landscape' }) })
  const image = await media.generateImage(chat, 'root', FRAME)
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  assert.equal(image.backend, 'SD WebUI')
  const body = server.seen.at(-1).json
  assert.match(body.prompt, /^linxue, [\s\S]*<lora:linxue_v2:0\.7>$/)
  assert.deepEqual([body.width, body.height, body.steps, body.cfg_scale, body.sampler_name], [1216, 832, 20, 5.5, 'DPM++ 2M'])
  assert.match(body.negative_prompt, /worst quality/)
  // Nobody there: connection refused is explained.
  await store.saveSettings({ media: cleanMedia({ sdUrl: 'http://127.0.0.1:9' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'a cat'), /连不上 SD WebUI/)
})

test('settings: the new backends and their fields are checked', () => {
  const media = cleanMedia({ imageBackend: 'sdwebui', sdSteps: '500', sdCfg: '0', geminiImageModel: 'models/gemini-3-pro-image-preview', geminiTtsVoices: 'Kore 女主\nPuck' })
  assert.equal(media.imageBackend, 'sdwebui')
  assert.equal(media.sdSteps, 80)
  assert.equal(media.sdCfg, 1)
  assert.equal(media.geminiImageModel, 'gemini-3-pro-image-preview')
  assert.deepEqual(media.geminiTtsVoices, [{ id: 'Kore', name: '女主' }, { id: 'Puck', name: '' }])
  assert.equal(cleanMedia({ imageBackend: 'midjourney' }).imageBackend, 'openai')
  assert.throws(() => cleanMedia({ sdUrl: 'no url' }), /SD WebUI/)
  assert.throws(() => cleanMedia({ geminiTtsModel: 'bad model name!' }), /Gemini/)
  // gpt-image answers in base64 and refuses to be asked for it.
  assert.deepEqual(imageFormat('gpt-image-1'), {})
  assert.deepEqual(imageFormat('grok-imagine-image-2.0'), { response_format: 'b64_json' })
})

test('Gemini speech: a voice source through the Gemini provider; emotions become a spoken-style prompt; PCM becomes WAV', async t => {
  const { server, store, media, google } = await setup(t)
  assert.equal(geminiSpeechText('[开心地] 太好了！'), '用开心的语气说：太好了！')
  assert.equal(geminiSpeechText('走吧。'), '走吧。')
  assert.equal(geminiDefaultVoices().length, 30)
  await store.saveSettings({ media: cleanMedia({ ttsUrl: '', geminiTtsProvider: google.id }) })
  const listed = (await media.voices()).sources.find(source => source.id === 'gemini')
  assert.equal(listed.configured, true)
  assert.equal(listed.voices.length, 30)
  assert.equal(listed.voices.find(v => v.ref === 'gemini:Kore')?.label.startsWith('Kore（'), true)

  const audio = await media.speak({ text: '[开心地] 太好了！', voice: 'gemini:Kore' })
  assert.equal(audio.mime, 'audio/wav')
  assert.equal(audio.buffer.subarray(0, 4).toString(), 'RIFF')
  const call = server.seen.at(-1)
  assert.equal(call.url, '/v1beta/models/gemini-2.5-flash-preview-tts:generateContent')
  assert.equal(call.key, KEY)
  assert.equal(call.json.contents[0].parts[0].text, '用开心的语气说：太好了！')
  assert.equal(call.json.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore')
  // Read once: the second time comes from the cache.
  await media.speak({ text: '[开心地] 太好了！', voice: 'gemini:Kore' })
  assert.equal(server.seen.length, 1)
})
