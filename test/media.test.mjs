import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { baseName, normalizeCard, previousVersion } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { deflateRawSync } from 'node:zlib'
import { checkWorkflow, cleanCardMedia, cleanMedia, cleanNaiToken, cleanPrompt, createMedia, fillWorkflow, imagePromptRequest, imageSize, unzipFirst, withLora, withTrigger } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const KEY = 'sk-media-test-0000'
const NAI_TOKEN = 'pst-media-test-token-abcd'

/** A one-file zip as NovelAI sends it: stored (method 0) or deflated (8). */
function zipOf(name, data, method = 0) {
  const body = method === 8 ? deflateRawSync(data) : data
  const fileName = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  central.writeUInt32LE(0, 42)
  const centralAt = local.length + fileName.length + body.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fileName.length, 12)
  end.writeUInt32LE(centralAt, 16)
  return Buffer.concat([local, fileName, body, central, fileName, end])
}

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: '林雪', description: '{{char}}，短黑发，浅蓝警服。', first_mes: '站住。' },
}

/** One fake server for every backend: images API + helper chat, ComfyUI, the voice bridge. */
async function fakeBackends(t) {
  const seen = []
  let history = null
  // The V5 allowance /user/subscription reports; null leaves it out (an account before V5).
  const nai = { usage: null, anlas: 10000 }
  const bridge = { current: 'jok', model: 'drama-3' }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const type = req.headers['content-type'] ?? ''
    const json = type.includes('json') && raw.length ? JSON.parse(raw) : null
    seen.push({ method: req.method, url: req.url, type, json, size: raw.length, auth: req.headers.authorization })
    const send = (status, body, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    if (req.url === '/v1/chat/completions') {
      const asked = json.messages.at(-1).content
      if (asked.includes('TASK: list the recurring characters')) {
        const cast = '[{"name":"林雪","kind":"girl","looks":"short black hair, blue eyes","outfit":"light blue police uniform"},{"name":"主角","kind":"boy","player":true,"looks":"short brown hair"}]'
        return send(200, { model: json.model, choices: [{ message: { content: `好的\n${cast}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      }
      if (asked.includes('<cast>')) {
        return send(200, { model: json.model, choices: [{ message: { content: '场景: office, night\n[林雪] saluting, serious | left\n[阿明] nodding | right' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      }
      return send(200, { model: json.model, choices: [{ message: { content: 'Prompt: "a girl with short black hair in a light blue uniform, saluting"' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    }
    if (req.url === '/v1/images/generations') return send(200, { data: [{ b64_json: PNG.toString('base64') }] })
    if (req.url === '/v1/images/edits') {
      // grok2api: JSON only, the reference as a data URL.
      if (!type.includes('json')) return send(415, { error: { message: '图片编辑仅支持 application/json' } })
      if (!/^data:image\/png;base64,/.test(json.image?.url ?? '')) return send(400, { error: { message: 'bad image url' } })
      // grok2api with only a Web account: 2.0 generates but has no edit route.
      if (json.model === 'gen-only') return send(404, { error: { message: '模型不存在' } })
      // grok2api relays a Grok Web moderation refusal as 503.
      if (json.prompt === 'refused') return send(503, { error: { message: 'Grok Web 媒体上游返回 403: 响应正文不可解析' } })
      return send(200, { data: [{ url: '/files/out.png' }] })
    }
    if (req.url === '/form/v1/images/edits') {
      // Classic OpenAI: multipart only.
      if (!type.includes('multipart')) return send(400, { error: { message: "Invalid 'image': expected a file upload (multipart/form-data)" } })
      if (!raw.includes('name="image"; filename="reference.png"')) return send(400, { error: { message: 'no image part' } })
      return send(200, { data: [{ b64_json: PNG.toString('base64') }] })
    }
    if (req.url === '/files/out.png') return send(200, PNG, 'image/png')
    if (req.url === '/prompt') {
      history = json.prompt
      return send(200, { prompt_id: 'p1' })
    }
    if (req.url === '/history/p1') return send(200, { p1: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } })
    if (req.url.startsWith('/view?')) return send(200, PNG, 'image/png')
    if (req.url === '/upload/image') return send(200, { name: 'tavern-ref.png' })
    if (req.url === '/ai/generate-image') {
      if (req.headers.authorization !== `Bearer ${NAI_TOKEN}`) return send(401, { statusCode: 401, message: 'Invalid accessToken.' })
      if (json.model === 'nai-diffusion-9-full') return send(400, { statusCode: 400, message: 'Invalid model' })
      if (json.input.includes('broke') && json.parameters.director_reference_images) return send(402, { statusCode: 402, message: 'Not enough Anlas. Required: 5, Available: 0' })
      if (json.model.startsWith('nai-diffusion-5-') && nai.usage?.percent === 0 && !nai.anlas) return send(402, { statusCode: 402, message: 'Not enough Anlas.' })
      return send(200, zipOf('image_0.png', PNG, 8), 'application/x-zip-compressed')
    }
    if (req.url === '/user/subscription') {
      if (req.headers.authorization !== `Bearer ${NAI_TOKEN}`) return send(401, { statusCode: 401, message: 'Invalid accessToken.' })
      return send(200, { tier: 3, active: true, expiresAt: 1792613215, trainingStepsLeft: { fixedTrainingStepsLeft: Math.max(0, nai.anlas - 200), purchasedTrainingSteps: Math.min(200, nai.anlas) }, ...(nai.usage ? { usage: nai.usage } : {}) })
    }
    if (req.url === '/models/loras') return send(200, ['linxue.safetensors'])
    if (req.url === '/api/persona/list') return send(200, { voices: [{ name: 'jok' }, { name: '南晚' }], cloud_voices: [{ name: 'fish:abc', label: '南晚 · abc', provider: 'Fish Audio · 云端', model: bridge.model, tags: true }], current: { voice: bridge.current } })
    if (req.url === '/api/tts') return send(200, Buffer.from('RIFF....WAVE'), 'audio/wav')
    send(404, { error: 'no' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}`, workflowSent: () => history, nai, bridge }
}

async function setup(t) {
  const fake = await fakeBackends(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard(CARD)
  await store.saveCard(card, PNG)
  card.hasAvatar = true
  await store.saveCard(card)
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: KEY, models: ['helper'] })
  await store.saveProviders([provider])
  await store.saveSettings({ media: cleanMedia({ helperModel: `${provider.id}/helper`, imageProvider: provider.id, imageModel: 'grok-imagine-image-2.0', comfyUrl: fake.base, ttsUrl: fake.base }) })
  const chat = await createChat(store, card.id)
  return { fake, store, chat, card, media: createMedia(store, { novelai: { imageUrl: fake.base } }), provider }
}

test('media helpers: settings validation, prompt request, prompt cleanup, workflow placeholders', () => {
  const media = cleanMedia({ imageShape: 'portrait', imageBackend: 'comfy', autoRead: true, ttsUrl: 'http://127.0.0.1:8765/', bogus: 1 })
  assert.equal(media.imageShape, 'portrait')
  assert.equal(imageSize('comfy', 'portrait'), '832x1216')
  assert.equal(imageSize('openai', 'portrait'), '1024x1536', 'images APIs take only their three sizes')
  assert.equal(cleanMedia({}, { imageSize: '1216x832' }).imageShape, 'landscape', 'old pixel sizes become shapes')
  assert.equal(cleanMedia({}, { imageSize: '1216x832' }).imageSize, undefined)
  assert.equal(media.ttsUrl, 'http://127.0.0.1:8765')
  assert.equal(media.bogus, undefined)
  assert.equal(cleanMedia({ imageShape: 'big' }).imageShape, 'square')
  assert.throws(() => cleanMedia({ comfyUrl: 'not a url' }), /ComfyUI/)

  const request = imagePromptRequest({ card: { description: '短黑发', personality: '' }, names: { char: '林雪', user: '我' }, reply: '她敬了个礼。', input: '我看着她', state: { 场景: '客厅' }, style: '日系动画', promptStyle: 'tags' })
  assert.match(request.system, /comma-separated/)
  assert.match(request.messages[0].content, /<character name="林雪">[\s\S]*短黑发[\s\S]*<variables>[\s\S]*客厅[\s\S]*<art_style>日系动画[\s\S]*<latest_passage>\n她敬了个礼。[\s\S]*TASK: write an image-generation prompt/, 'the task comes last, after the story')
  assert.equal(request.maxTokens, 400)
  assert.equal(cleanPrompt('Prompt: "a cat"'), 'a cat')
  assert.equal(cleanPrompt('<think>hmm</think>Here is the prompt:\n\na girl saluting\n\nThis captures the moment when…'), 'a girl saluting', 'thinking, preamble and commentary go')
  const rambling = cleanPrompt(`${'word '.repeat(60)}end. ${'more '.repeat(60)}`)
  assert.ok(rambling.split(' ').length <= 90)
  assert.equal(cleanPrompt('a, b, c, d', 'tags'), 'a, b, c, d')

  const filled = fillWorkflow({ 3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', width: '{{width}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{prompt}}' } } }, { prompt: 'a cat', seed: 42, width: 832 })
  assert.equal(filled[3].inputs.seed, 42)
  assert.equal(filled[3].inputs.width, 832)
  assert.equal(filled[6].inputs.text, 'masterpiece, a cat')
  assert.throws(() => checkWorkflow({ 1: { class_type: 'X', inputs: {} } }), /\{\{prompt\}\}/)
  assert.throws(() => checkWorkflow({ nodes: [], links: [] }), /API 格式/)
})

test('image prompt from the helper model, then images through the OpenAI images API (plain and with the avatar)', async t => {
  const { fake, store, chat, media } = await setup(t)
  const root = chat.nodes.root
  const { prompt, model } = await media.writeImagePrompt(chat, root, { reply: '林雪敬了个礼。', input: '' })
  assert.equal(prompt, 'a girl with short black hair in a light blue uniform, saluting')
  assert.match(model, /helper/)
  const helperCall = fake.seen.find(r => r.url === '/v1/chat/completions')
  assert.equal(helperCall.auth, `Bearer ${KEY}`)
  assert.match(helperCall.json.messages.at(-1).content, /浅蓝警服[\s\S]*林雪敬了个礼/)

  const image = await media.generateImage(chat, 'root', prompt)
  assert.match(image.file, /\.png$/)
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  const generation = fake.seen.find(r => r.url === '/v1/images/generations')
  assert.equal(generation.json.model, 'grok-imagine-image-2.0')
  assert.equal(generation.json.response_format, 'b64_json')

  assert.equal(generation.json.size, '1024x1024')
  await store.saveSettings({ media: cleanMedia({ imageReference: true, imageShape: 'portrait' }, (await store.getSettings()).media) })
  const edited = await media.generateImage(chat, 'root', prompt)
  assert.deepEqual(await media.readImage(chat.id, edited.file), PNG, 'a URL answer is downloaded')
  const edits = fake.seen.filter(r => r.url === '/v1/images/edits')
  assert.equal(edits.length, 1, 'JSON went through the first time')
  assert.equal(edits[0].json.size, '1024x1536')

  // A generate-only model: the edit fails with 404, the picture is drawn without the reference.
  await store.saveSettings({ media: cleanMedia({ imageModel: 'gen-only' }, (await store.getSettings()).media) })
  const fallback = await media.generateImage(chat, 'root', prompt)
  assert.match(fallback.note, /gen-only 用不了参考图[\s\S]*grok-imagine-image-edit/)
  assert.equal(fallback.backend, 'gen-only')
  assert.equal(fake.seen.at(-1).url, '/v1/images/generations')
  assert.equal(fake.seen.at(-1).json.model, 'gen-only')
  // With a separate edit model the reference goes to that one.
  await store.saveSettings({ media: cleanMedia({ imageEditModel: 'grok-imagine-image-edit' }, (await store.getSettings()).media) })
  const withEditModel = await media.generateImage(chat, 'root', prompt)
  assert.equal(withEditModel.note, undefined)
  assert.equal(withEditModel.backend, 'grok-imagine-image-edit')
  assert.equal(fake.seen.filter(r => r.url === '/v1/images/edits').at(-1).json.model, 'grok-imagine-image-edit')
  await assert.rejects(media.generateImage(chat, 'root', 'refused'), /拒绝画这张：多半是提示词或参考图没过它的内容审核/, 'a refusal says why, not "服务出错"')
  await store.saveSettings({ media: cleanMedia({ imageModel: 'grok-imagine-image-2.0', imageEditModel: '' }, (await store.getSettings()).media) })

  // A server that only takes the multipart form gets it on the second try.
  const formProvider = normalizeProvider({ name: '表单', api: 'openai-completions', baseURL: `${fake.base}/form/v1`, apiKey: KEY, models: ['x'] }, null, new Set((await store.getProviders()).map(p => p.id)))
  await store.saveProviders([...(await store.getProviders()), formProvider])
  await store.saveSettings({ media: cleanMedia({ imageProvider: formProvider.id }, (await store.getSettings()).media) })
  const viaForm = await media.generateImage(chat, 'root', prompt)
  assert.deepEqual(await media.readImage(chat.id, viaForm.file), PNG)
  assert.deepEqual(fake.seen.filter(r => r.url === '/form/v1/images/edits').map(r => r.type.split(';')[0]), ['application/json', 'multipart/form-data'])
  await media.removeImage(chat.id, edited.file)
  await assert.rejects(media.readImage(chat.id, edited.file))
  await assert.rejects(media.readImage(chat.id, '../settings.json'), /文件名/)
})

test('ComfyUI: workflow saved, placeholders filled, avatar uploaded as reference, output downloaded', async t => {
  const { fake, store, chat, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', imageShape: 'portrait' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /工作流/)
  const info = await media.saveWorkflow({
    3: { class_type: 'KSampler', inputs: { seed: '{{seed}}' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    10: { class_type: 'LoadImage', inputs: { image: '{{reference}}' } },
  })
  assert.deepEqual(info.placeholders, ['prompt', 'seed', 'width', 'height', 'reference'])
  const image = await media.generateImage(chat, 'root', 'a girl saluting')
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  const sent = fake.workflowSent()
  assert.equal(sent[6].inputs.text, 'a girl saluting')
  assert.equal(sent[5].inputs.width, 832)
  assert.equal(sent[5].inputs.height, 1216)
  assert.equal(typeof sent[3].inputs.seed, 'number')
  assert.equal(sent[10].inputs.image, 'tavern-ref.png')
  assert.ok(fake.seen.some(r => r.url === '/upload/image'))
  assert.equal(image.backend, 'ComfyUI')

  // A card LoRA: inserted after the checkpoint loader, everything rewired through it, trigger word first.
  await media.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{prompt}}', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', model: ['4', 0], positive: ['6', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  })
  const card = await store.getCard(chat.cardId)
  card.media = cleanCardMedia({ lora: 'linxue.safetensors', loraTrigger: 'linxue', loraStrength: 0.9 })
  await store.saveCard(card)
  await media.generateImage(chat, 'root', '1girl, saluting')
  const withLoraSent = fake.workflowSent()
  assert.deepEqual(withLoraSent[9], { class_type: 'LoraLoader', _meta: { title: 'Card LoRA' }, inputs: { lora_name: 'linxue.safetensors', strength_model: 0.9, strength_clip: 0.9, model: ['4', 0], clip: ['4', 1] } })
  assert.deepEqual(withLoraSent[3].inputs.model, ['9', 0])
  assert.deepEqual(withLoraSent[6].inputs.clip, ['9', 1])
  assert.deepEqual(withLoraSent[8].inputs.vae, ['4', 2], 'the VAE still comes from the checkpoint')
  assert.equal(withLoraSent[6].inputs.text, 'masterpiece, linxue, 1girl, saluting')
  assert.equal(withTrigger('linxue, smile', 'linxue'), 'linxue, smile')
  assert.throws(() => withLora({ 1: { class_type: 'KSampler', inputs: {} } }, { name: 'x.safetensors' }), /Load Checkpoint/)
  assert.throws(() => cleanCardMedia({ lora: '../../secret.safetensors' }), /LoRA/)
  assert.throws(() => cleanCardMedia({ lora: 'notes.txt' }), /LoRA/)
  assert.equal(cleanCardMedia({ loraStrength: 9 }).loraStrength, 2)
  assert.deepEqual(await media.loras(), { ok: true, loras: ['linxue.safetensors'] })
})

test('NovelAI: token kept server-side, V4-style body, zip unpacked, errors explained', async t => {
  const { fake, store, chat, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'novelai', imageShape: 'portrait' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /令牌/)
  assert.throws(() => cleanNaiToken('has space inside token'), /令牌格式/)
  assert.equal(cleanNaiToken(`Bearer ${NAI_TOKEN}`), NAI_TOKEN)

  assert.deepEqual(await media.setNaiToken(NAI_TOKEN), { hasToken: true, tokenHint: '…abcd' })
  assert.ok(!JSON.stringify(await store.getSettings()).includes(NAI_TOKEN), 'the token is not in settings.json')
  assert.deepEqual(await media.naiCheck(''), { tier: 'Opus', active: true, anlas: 10000, v5: null, renewsAt: '2026-10-21T20:06:55.000Z' })

  const image = await media.generateImage(chat, 'root', '1girl, short black hair, saluting, ')
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  assert.equal(image.backend, 'NovelAI · nai-diffusion-5-full')
  const sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.model, 'nai-diffusion-5-full')
  assert.equal(sent.action, 'generate')
  assert.equal(sent.input, '1girl, short black hair, saluting, very aesthetic, masterpiece, no text')
  assert.equal(sent.parameters.v4_prompt.caption.base_caption, sent.input)
  assert.equal(sent.parameters.v4_negative_prompt.caption.base_caption, sent.parameters.negative_prompt)
  assert.equal(sent.parameters.width, 832)
  assert.equal(sent.parameters.height, 1216)
  assert.ok(sent.parameters.width * sent.parameters.height <= 1024 * 1024 && sent.parameters.steps <= 28, 'inside Opus free generation')

  assert.deepEqual(unzipFirst(zipOf('a.png', PNG, 0)), PNG)
  assert.deepEqual(unzipFirst(PNG), PNG)
  assert.throws(() => unzipFirst(Buffer.from('not an image or zip at all, really')), /zip/)

  await store.saveSettings({ media: cleanMedia({ naiModel: 'nai-diffusion-9-full' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /不认模型 nai-diffusion-9-full/)
  assert.throws(() => cleanMedia({ naiModel: 'gpt-image-1' }), /NovelAI 模型名/)

  // The V5 allowance: plenty → as asked; low → a note; empty → V4.5, or Anlas when the settings say so and there are some.
  const v5Turn = async () => {
    const picture = await media.generateImage(chat, 'root', '1girl')
    return { model: fake.seen.findLast(r => r.url === '/ai/generate-image').json.model, note: picture.note ?? '' }
  }
  await store.saveSettings({ media: cleanMedia({ naiModel: 'nai-diffusion-5-full' }, (await store.getSettings()).media) })
  fake.nai.usage = { percent: 53, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 7888 }
  assert.deepEqual((await media.naiCheck('')).v5, { percent: 53, purchasedPercent: 0, empty: false, nextPercentMinutes: 131 })
  assert.deepEqual(await v5Turn(), { model: 'nai-diffusion-5-full', note: '' })
  fake.nai.usage = { percent: 7, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 1500 }
  const low = await v5Turn()
  assert.equal(low.model, 'nai-diffusion-5-full')
  assert.match(low.note, /V5 额度只剩 7%，25 分钟后回 1%。用完后自动改用 V4.5/)
  fake.nai.usage = { percent: 0, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 7200 }
  const empty = await v5Turn()
  assert.equal(empty.model, 'nai-diffusion-4-5-full', 'free on Opus instead of spending Anlas')
  assert.match(empty.note, /V5 额度用完了，2 小时后回 1%，这张改用 V4.5 画/)
  await store.saveSettings({ media: cleanMedia({ naiV5Empty: 'anlas' }, (await store.getSettings()).media) })
  const spend = await v5Turn()
  assert.equal(spend.model, 'nai-diffusion-5-full')
  assert.match(spend.note, /扣 Anlas 画（还剩 10000）/)
  fake.nai.anlas = 0
  const broke = await v5Turn()
  assert.equal(broke.model, 'nai-diffusion-4-5-full')
  assert.match(broke.note, /Anlas 也没了，这张改用 V4.5/)
  assert.equal(cleanMedia({ naiV5Empty: 'whatever' }).naiV5Empty, 'v45')
  fake.nai.usage = null
  fake.nai.anlas = 10000

  await media.setNaiToken('pst-someone-elses-token-0000')
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /不认这个令牌/)
  assert.deepEqual(await media.setNaiToken(''), { hasToken: false, tokenHint: '' })
})

test('cast: drafted from the card, cast-format prompt, per-character NovelAI prompts, the lead\'s reference on V4.5', async t => {
  const { fake, store, chat, card, media } = await setup(t)
  await store.saveCard({ ...(await store.getCard(card.id)), media: cleanCardMedia({ lora: 'linxue.safetensors', loraTrigger: 'linxue' }) })
  const draft = await media.draftRoster(card.id)
  assert.deepEqual(draft.roster.map(e => [e.name, e.player]), [['林雪', false], ['主角', true]])
  assert.equal(draft.roster[0].lora, 'linxue.safetensors', 'the card LoRA goes to the character the card is named after')

  const saved = await media.saveCardMedia(card.id, { roster: draft.roster })
  const [linxue, hero] = saved.roster
  assert.equal(linxue.ref, false)
  await assert.rejects(media.saveRosterRef(card.id, linxue.id, 'data:text/plain;base64,AAAA'), /PNG/)
  await media.saveRosterRef(card.id, linxue.id, `data:image/png;base64,${PNG.toString('base64')}`)
  await media.saveRosterRef(card.id, 'gone000001', `data:image/png;base64,${PNG.toString('base64')}`)
  assert.equal((await media.cardMediaView(card.id)).roster[0].ref, true)

  // The helper answers in the cast format; the player is named as the chat names them.
  const written = await media.writeImagePrompt(chat, chat.nodes.root, { reply: '林雪敬了个礼。', input: '' })
  assert.equal(written.prompt, '场景: office, night\n[林雪] saluting, serious | left\n[阿明] nodding | right')
  assert.match(fake.seen.findLast(r => r.url === '/v1/chat/completions').json.messages.at(-1).content, /\[林雪\] girl; usual outfit: light blue police uniform/)

  await media.setNaiToken(NAI_TOKEN)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'novelai', imageShape: 'portrait' }, (await store.getSettings()).media) })
  const userName = chat.names.user
  const two = await media.generateImage(chat, 'root', `场景: office, night\n[林雪] saluting | left\n[${userName}] nodding | right`)
  let sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  // Her and the player: her picture goes along (V4.5 takes it).
  assert.equal(sent.model, 'nai-diffusion-4-5-full')
  assert.equal(sent.input, '1girl, 1boy, office, night, very aesthetic, masterpiece, no text')
  assert.deepEqual(sent.parameters.v4_prompt.caption.char_captions.map(c => c.char_caption), ['girl, short black hair, blue eyes, saluting', 'boy, short brown hair, nodding'])
  assert.deepEqual(sent.parameters.director_reference_images, [PNG.toString('base64')])
  assert.equal(two.backend, 'NovelAI · nai-diffusion-4-5-full · 人设图：林雪')

  const one = await media.generateImage(chat, 'root', '场景: office\n[林雪] saluting')
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.model, 'nai-diffusion-4-5-full')
  assert.deepEqual(sent.parameters.director_reference_images, [PNG.toString('base64')])
  assert.equal(one.backend, 'NovelAI · nai-diffusion-4-5-full · 人设图：林雪')

  // A model picked for one picture is used as picked: V5 draws without the reference, a V4.5 keeps it.
  const picked = await media.generateImage(chat, 'root', '场景: office\n[林雪] saluting', undefined, { model: 'nai-diffusion-5-curated' })
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.model, 'nai-diffusion-5-curated')
  assert.equal(sent.parameters.director_reference_images, undefined)
  assert.equal(picked.backend, 'NovelAI · nai-diffusion-5-curated')
  await media.generateImage(chat, 'root', '[林雪] saluting', undefined, { model: 'nai-diffusion-4-5-curated' })
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.model, 'nai-diffusion-4-5-curated')
  assert.equal(sent.parameters.director_reference_images.length, 1)
  await assert.rejects(media.generateImage(chat, 'root', 'x', undefined, { model: 'gpt-image-1' }), /模型名/)

  // The card's look goes first on every NovelAI picture, weighted up and once; its negative after the shared one.
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), style: 'anime style, soft lighting', styleNegative: 'realistic, 3d' })
  await media.generateImage(chat, 'root', '场景: office\n[林雪] saluting')
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.input, '{{anime style, soft lighting}}, 1girl, office, very aesthetic, masterpiece, no text')
  assert.match(sent.parameters.negative_prompt, /blank page, realistic, 3d$/)
  await media.generateImage(chat, 'root', '场景: anime style, soft lighting, office\n[林雪] saluting')
  assert.equal(fake.seen.findLast(r => r.url === '/ai/generate-image').json.input, '{{anime style, soft lighting}}, 1girl, office, very aesthetic, masterpiece, no text')
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), style: '', styleNegative: '' })

  // No Anlas for the reference: drawn without it, and said so.
  const broke = await media.generateImage(chat, 'root', '场景: broke\n[林雪] saluting')
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.parameters.director_reference_images, undefined)
  assert.equal(sent.model, 'nai-diffusion-5-full')
  assert.equal(broke.backend, 'NovelAI · nai-diffusion-5-full')
  assert.match(broke.note, /Anlas 不够.*林雪/)
  await media.drawPortrait(card.id, { ...linxue }, undefined, { model: 'nai-diffusion-5-full' })
  assert.equal(fake.seen.findLast(r => r.url === '/ai/generate-image').json.model, 'nai-diffusion-5-full')

  // A portrait for a member without a picture: alone, plain background, never off another reference.
  const portrait = await media.drawPortrait(card.id, { ...hero, looks: 'short brown hair', outfit: 'grey hoodie' })
  assert.match(portrait.image, /^data:image\/png;base64,/)
  sent = fake.seen.findLast(r => r.url === '/ai/generate-image').json
  assert.equal(sent.model, 'nai-diffusion-5-full')
  assert.equal(sent.parameters.director_reference_images, undefined)
  assert.equal(sent.parameters.height, 1216)
  assert.match(sent.input, /^1boy, solo, upper body/)
  assert.equal(sent.parameters.v4_prompt.caption.char_captions[0].char_caption, 'boy, short brown hair, grey hoodie, standing')
  assert.match(sent.parameters.negative_prompt, /nsfw/)
  await assert.rejects(media.drawPortrait(card.id, { name: '无名' }), /长相/)

  await store.saveSettings({ media: cleanMedia({ naiReference: false }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', '[林雪] saluting')
  assert.equal(fake.seen.findLast(r => r.url === '/ai/generate-image').json.model, 'nai-diffusion-5-full')

  // ComfyUI: a lone member's own LoRA and trigger; two people, no LoRA at all.
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', promptStyle: 'tags' }, (await store.getSettings()).media) })
  await media.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  })
  await media.generateImage(chat, 'root', '[林雪] saluting')
  assert.equal(fake.workflowSent()[7]?.class_type, 'LoraLoader')
  assert.equal(fake.workflowSent()[6].inputs.text, 'linxue, 1girl, short black hair, blue eyes, saluting')
  await media.generateImage(chat, 'root', `[林雪] saluting\n[${userName}] nodding`)
  assert.equal(fake.workflowSent()[7], undefined)

  // Saving the roster without a member removes that member's picture (and strays).
  await media.saveCardMedia(card.id, { roster: [hero] })
  await assert.rejects(media.readRosterRef(card.id, linxue.id), /人设图/)
  await assert.rejects(media.readRosterRef(card.id, 'gone000001'), /人设图/)
})

test('voice: voices listed, speech proxied and cached, a dead bridge explained', async t => {
  const { fake, store, media } = await setup(t)
  assert.deepEqual(await media.voices(), { ok: true, voices: ['jok', '南晚'], cloud: [{ name: 'fish:abc', label: '南晚 · abc', provider: 'Fish Audio · 云端', model: 'drama-3', tags: true }], current: 'jok', remote: false })
  const first = await media.speak({ text: '站住。', voice: '南晚', stable: true })
  assert.equal(first.toString(), 'RIFF....WAVE')
  const call = fake.seen.find(r => r.url === '/api/tts')
  assert.deepEqual(call.json, { text: '站住。', voice: '南晚', stable: true })
  await media.speak({ text: '站住。', voice: '南晚', stable: true })
  assert.equal(fake.seen.filter(r => r.url === '/api/tts').length, 1, 'the second time comes from the cache')
  assert.equal((await readdir(path.join(store.dirs.root, 'media', 'tts'))).length, 1)
  const ttsCalls = () => fake.seen.filter(r => r.url === '/api/tts').length
  await media.speak({ text: '站住。', voice: '南晚', stable: true, fresh: true })
  assert.equal(ttsCalls(), 2, 'fresh synthesises again')
  assert.equal((await readdir(path.join(store.dirs.root, 'media', 'tts'))).length, 1, 'and replaces the cached take')
  // A card on the bridge's current voice: switching it there is a different voice.
  await media.speak({ text: '走吧。', voice: '' })
  await media.speak({ text: '走吧。', voice: '' })
  assert.equal(ttsCalls(), 3)
  fake.bridge.current = '南晚'
  const now = Date.now
  Date.now = () => now() + 11_000 // past the 10 s the current voice is remembered
  try {
    await media.speak({ text: '走吧。', voice: '' })
  } finally {
    Date.now = now
  }
  assert.equal(ttsCalls(), 4, 'switched on the bridge: synthesised again')

  // Cloud voices act on [emotion] tags; local ones would read them out, so they are dropped.
  const lastText = () => fake.seen.filter(r => r.url === '/api/tts').at(-1).json
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: 'fish:abc' })
  assert.deepEqual(lastText(), { text: '[害羞地小声] 你来啦。', voice: 'fish:abc', stable: false })
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: 'jok' })
  assert.deepEqual(lastText(), { text: '你来啦。', voice: 'jok', stable: false })
  // Another model in the cloud settings is another voice.
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: 'fish:abc' })
  assert.equal(ttsCalls(), 6)
  fake.bridge.model = 's2.1-pro'
  Date.now = () => now() + 22_000
  try {
    await media.speak({ text: '[害羞地小声] 你来啦。', voice: 'fish:abc' })
  } finally {
    Date.now = now
  }
  assert.equal(ttsCalls(), 7, 'new model: synthesised again')

  await store.saveSettings({ media: cleanMedia({ ttsUrl: 'http://127.0.0.1:9' }, (await store.getSettings()).media) })
  assert.match((await media.voices()).error, /小雅一键启动/)
  await assert.rejects(media.speak({ text: '别的话', voice: 'jok' }), /小雅一键启动/)
})

test('speech chunks: quoted speech vs narration, cleanup, ~100-character blocks', async () => {
  const { speechChunks, cleanForSpeech } = await import('../web/shared/speech.js')
  // 小白X: a voice tag repeats the quoted line, and the options block is not story.
  assert.deepEqual(
    speechChunks(['她笑了：“太好了！”[voice:happy:太好了！]', '', '<small>', '请选择：', '1️⃣ 抱住她', '</small>'].join('\n')),
    [{ kind: 'narration', text: '她笑了：' }, { kind: 'dialogue', text: '太好了！' }],
  )
  assert.equal(cleanForSpeech('“走吧。”[voice::走吧。]'), '“走吧。”')
  const text = '　　林雪抬起眼，**冷冷地**说：“站住。你是谁？”\n\n　　——\n\n她把证件拍在桌上。「坐下。」'
  assert.deepEqual(speechChunks(text), [
    { kind: 'narration', text: '林雪抬起眼，冷冷地说：' },
    { kind: 'dialogue', text: '站住。你是谁？' },
    { kind: 'narration', text: '她把证件拍在桌上。' },
    { kind: 'dialogue', text: '坐下。' },
  ])
  assert.deepEqual(speechChunks(text, { narration: false }), [{ kind: 'dialogue', text: '站住。你是谁？坐下。' }], 'without a narrator the lines join')
  const long = '这是一句很长的旁白。'.repeat(30)
  const chunks = speechChunks(long)
  assert.ok(chunks.length >= 3 && chunks.every(c => c.text.length <= 100))
  assert.equal(chunks.map(c => c.text).join(''), long)
  assert.equal(cleanForSpeech('<b>你好</b>{{user}}【系统】———'), '你好系统')
  assert.deepEqual(speechChunks('“……”'), [], 'nothing speakable')
  // A voice tag's emotion goes before its line as a delivery tag, when asked for.
  const tagged = '她笑了：“太好了！”[voice:开心地:太好了！]他说“嗯。”[voice::嗯]“走吧，”[voice:害羞，小声:走吧]'
  assert.deepEqual(speechChunks(tagged, { tags: true }), [
    { kind: 'narration', text: '她笑了：' },
    { kind: 'dialogue', text: '[开心地] 太好了！' },
    { kind: 'narration', text: '他说' },
    { kind: 'dialogue', text: '嗯。[害羞、小声] 走吧，' },
  ])
  assert.deepEqual(speechChunks(tagged).map(c => c.text), ['她笑了：', '太好了！', '他说', '嗯。走吧，'], 'off by default')
})

test('a newer version of a card takes over the older one\'s picture settings, cast and reference pictures', async t => {
  const { store, card, media } = await setup(t)
  const named = name => normalizeCard({ ...CARD, data: { ...CARD.data, name } })
  const old = { ...(await store.getCard(card.id)), name: '林雪-异能抽奖系统-v1.1' }
  await store.saveCard(old)
  const saved = await media.saveCardMedia(card.id, { lora: 'linxue.safetensors', roster: [{ name: '林雪', looks: 'short black hair' }] })
  await media.saveRosterRef(card.id, saved.roster[0].id, `data:image/png;base64,${PNG.toString('base64')}`)

  const other = named('白芷-v1.5')
  await store.saveCard(other)
  const newer = named('林雪-异能抽奖系统-v1.2')
  await store.saveCard(newer)
  const cards = await store.listCards()
  assert.equal(previousVersion(cards, newer)?.id, card.id)
  assert.equal(previousVersion(cards, other), null)
  assert.equal(baseName('顾念念-武当抽奖系统-v1.3'), '顾念念-武当抽奖系统')

  await media.inheritCardMedia(card.id, newer.id)
  const view = await media.cardMediaView(newer.id)
  assert.equal(view.lora, 'linxue.safetensors')
  assert.deepEqual(view.roster.map(e => [e.name, e.ref]), [['林雪', true]])
  // The old card can go now.
  await store.deleteCard(card.id)
  assert.deepEqual(await media.readRosterRef(newer.id, saved.roster[0].id), PNG)
})
