import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { baseName, normalizeCard, previousVersion } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { deflateRawSync } from 'node:zlib'
import { checkWorkflow, cleanCardMedia, cleanMedia, cleanNaiToken, cleanPrompt, clipTypeOf, comfyFailure, comfyRefusal, createMedia, fillWorkflow, fitSize, imagePromptRequest, imageSize, loraFor, modelFamily, pictureSize, simpleWorkflow, sizeNodes, unzipFirst, withLora, withNegative, withTrigger } from '../server/media.mjs'
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
    seen.push({ method: req.method, url: req.url, type, json, size: raw.length, auth: req.headers.authorization, form: type.includes('multipart') ? raw.toString('latin1') : '' })
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
      // 从对话里补充: one newcomer, someone the list already has under another name, and a nickname for her.
      if (asked.includes('are NOT on the cast list under any name')) {
        const found = { new: [{ name: '老周', aliases: '船夫', kind: 'boy', looks: 'old man, grey beard', outfit: 'straw hat' }, { name: '雪儿', aliases: '林雪', kind: 'girl', looks: 'short black hair' }], fix: [{ name: '林雪', aliases: '林警官', rename: '' }] }
        return send(200, { model: json.model, choices: [{ message: { content: JSON.stringify(found) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
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
  assert.ok(rambling.split(' ').length <= 120)
  assert.equal(cleanPrompt('a, b, c, d', 'tags'), 'a, b, c, d')

  const filled = fillWorkflow({ 3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', width: '{{width}}' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{prompt}}' } } }, { prompt: 'a cat', seed: 42, width: 832 })
  assert.equal(filled[3].inputs.seed, 42)
  assert.equal(filled[3].inputs.width, 832)
  assert.equal(filled[6].inputs.text, 'masterpiece, a cat')
  assert.throws(() => checkWorkflow({ 1: { class_type: 'X', inputs: {} } }), /\{\{prompt\}\}/)
  assert.throws(() => checkWorkflow({ nodes: [], links: [] }), /API 格式/)
  // ComfyUI's own "Export (API)" writes {{prompt}} out as "prompt" (its dynamic prompts); SillyTavern's %prompt% comes through.
  assert.throws(() => checkWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, prompt' } } }), /%prompt%/)
  const kept = checkWorkflow({
    3: { class_type: 'KSampler', inputs: { seed: '%seed%', steps: 25 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, %negative_prompt%' } },
    10: { class_type: 'LoadImage', inputs: { image: '%char_avatar%' } },
  })
  assert.deepEqual([kept[3].inputs.seed, kept[6].inputs.text, kept[7].inputs.text, kept[10].inputs.image], ['{{seed}}', 'masterpiece, {{prompt}}', 'lowres, {{negative}}', '{{reference}}'])
  assert.equal(fillWorkflow(kept, { prompt: 'a cat', seed: 42 })[3].inputs.seed, 42)
  assert.throws(() => checkWorkflow({ 3: { class_type: 'KSampler', inputs: { steps: '%steps%', cfg: '%scale%' } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%' } } }), /%steps% %scale%/)
  // No {{seed}} (ComfyUI's number fields take none): the samplers' own seeds, a new one each time.
  const reseeded = fillWorkflow({ 3: { class_type: 'KSampler', inputs: { seed: 7 } }, 9: { class_type: 'SamplerCustom', inputs: { noise_seed: 7 } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }, { prompt: 'a cat', seed: 42 })
  assert.deepEqual([reseeded[3].inputs.seed, reseeded[9].inputs.noise_seed, reseeded[6].inputs.text], [42, 42, 'a cat'])
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
  assert.throws(() => withLora({ 1: { class_type: 'KSampler', inputs: {} } }, { name: 'x.safetensors' }), /找不到采样器用的模型/)
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

  // 从对话里补充: the newcomers in the chat's turns, none the list has under any name, nobody the player;
  // the names the list's people go by in the story now, for the one on the page.
  const path = [{ role: 'assistant', display: '码头上，船夫老周把缆绳一甩。' }, { role: 'user', text: '上船' }]
  const page = [...saved.roster, { id: 'bbbbbb01', name: '阿明', aliases: '', player: false }]
  const found = await media.draftRosterFromChat(card.id, { path, user: chat.names.user }, page)
  assert.deepEqual(found.roster.map(e => [e.name, e.player]), [['老周', false]])
  assert.deepEqual(found.fixes, [{ id: linxue.id, name: '林雪', rename: '', aliases: ['林警官', '雪儿'] }])
  const asked = fake.seen.findLast(r => r.url === '/v1/chat/completions').json.messages.at(-1).content
  assert.ok(asked.includes('- 林雪\n- 主角 = the player character') && asked.includes('- 阿明\n'), 'the list as the page has it')
  assert.equal((await media.draftRosterFromChat(card.id, { path, user: chat.names.user })).fixes[0].id, linxue.id, 'the saved list when the page sends none')
  assert.ok(asked.includes('<reply>\n码头上，船夫老周把缆绳一甩。\n</reply>\n\n<player>\n上船\n</player>'), 'the turns, oldest first')
  await assert.rejects(media.draftRosterFromChat(card.id, { path: [], user: '' }), /还没有内容/)
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
  const [external, ...own] = (await media.voices()).sources
  assert.deepEqual(external, { id: 'bridge', label: '本地语音桥接', chunkMax: 100, configured: true, ok: true, voices: ['jok', '南晚'], cloud: [{ name: 'fish:abc', label: '南晚 · abc', provider: 'Fish Audio · 云端', model: 'drama-3', tags: true }], current: 'jok', remote: false })
  assert.deepEqual(own.map(s => [s.id, s.configured]), [['openai', false], ['fish', false], ['minimax', false], ['gemini', false]])
  const first = await media.speak({ text: '站住。', voice: '南晚', stable: true })
  assert.deepEqual([first.buffer.toString(), first.mime], ['RIFF....WAVE', 'audio/wav'])
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
  assert.match((await media.voices()).sources[0].error, /小雅一键启动/)
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
  // Told who says each quote: two people's lines stay apart, one person's still join.
  const talk = '林雪说：“站住。”沈梨答：“不。”“偏不。”“坐下。”'
  const speakerOf = quote => ({ '站住。': '林雪', '坐下。': '林雪' })[quote] ?? '沈梨'
  assert.deepEqual(speechChunks(talk, { narration: false, speakerOf }), [
    { kind: 'dialogue', text: '站住。', speaker: '林雪' },
    { kind: 'dialogue', text: '不。偏不。', speaker: '沈梨' },
    { kind: 'dialogue', text: '坐下。', speaker: '林雪' },
  ])
})

test('a cast member keeps the voice picked for them; none means the card\'s dialogue voice', async () => {
  const { cleanRoster } = await import('../server/roster.mjs')
  const [lin, shen] = cleanRoster([{ name: '林雪', voice: ' fish:abc 林雪 ' }, { name: '沈梨' }])
  assert.equal(lin.voice, 'fish:abc 林雪')
  assert.equal(shen.voice, '')
  assert.equal(cleanRoster([{ name: '长', voice: 'x'.repeat(400) }])[0].voice.length, 250)
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

test('scenery (视觉小说 backgrounds): landscape, nobody in it, no reference picture or card LoRA', async t => {
  const { fake, store, card, media } = await setup(t)
  // OpenAI-compatible with references on: still a plain generation, landscape; the helper hears the place and its lore.
  await store.saveSettings({ media: cleanMedia({ imageReference: true }, (await store.getSettings()).media) })
  const drawn = await media.drawScenery({ cardId: card.id, place: '旧城茶馆二楼', lore: '临窗的雅座，挂着竹帘' })
  assert.deepEqual(drawn.buffer, PNG)
  assert.equal(fake.seen.some(r => r.url === '/v1/images/edits'), false)
  const generated = fake.seen.findLast(r => r.url === '/v1/images/generations').json
  assert.equal(generated.size, '1536x1024')
  const asked = fake.seen.findLast(r => r.url === '/v1/chat/completions').json.messages.at(-1).content
  assert.match(asked, /<place name="旧城茶馆二楼">\n临窗的雅座/)
  assert.match(asked, /no people/i)
  assert.match(drawn.prompt, /No people\.$/)

  // ComfyUI with a card LoRA: no LoRA or trigger for a background, but the card's style; the negative keeps people out.
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', promptStyle: 'tags' }, (await store.getSettings()).media) })
  await media.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
  })
  const withLora = await store.getCard(card.id)
  withLora.media = cleanCardMedia({ lora: 'linxue.safetensors', loraTrigger: 'linxue', style: 'watercolor' })
  await store.saveCard(withLora)
  const comfy = await media.drawScenery({ cardId: card.id, place: '码头', prompt: 'scenery, no humans, a pier at dusk' })
  const sent = fake.workflowSent()
  assert.equal(Object.values(sent).some(node => node.class_type === 'LoraLoader'), false)
  assert.equal(sent[6].inputs.text, 'watercolor, scenery, no humans, a pier at dusk')
  assert.match(sent[7].inputs.text, /people/)
  assert.doesNotMatch(comfy.note, /人物/, 'no reference picture, so no one in the background')

  // The helper's tags start with scenery, no humans; the card's style goes first.
  const tagged = await media.drawScenery({ cardId: card.id, place: '码头' })
  assert.match(tagged.prompt, /^watercolor, scenery, no humans, /)
})

test('reference pictures: someone other than the card\'s character is never drawn from its avatar', async t => {
  const { fake, store, chat, card, media } = await setup(t)
  await media.saveCardMedia(card.id, { roster: [
    { id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair' },
    { id: 'aming001', name: '阿明', kind: 'boy', looks: 'short hair' },
    { id: 'laozhou1', name: '老周', kind: 'boy', looks: 'grey beard' },
  ] })
  await store.saveSettings({ media: cleanMedia({ imageReference: true }, (await store.getSettings()).media) })
  const edits = () => fake.seen.filter(r => r.url === '/v1/images/edits').length
  // The OpenAI images API: her own picture is the avatar; 阿明 has none, so his is drawn without one.
  await media.generateImage(chat, 'root', '[林雪] saluting')
  assert.equal(edits(), 1)
  await media.generateImage(chat, 'root', '[阿明] nodding')
  assert.equal(edits(), 1, 'a side character is not edited from her face')
  assert.equal(fake.seen.at(-1).url, '/v1/images/generations')
  await media.generateImage(chat, 'root', 'a quiet street')
  assert.equal(edits(), 2, 'nobody named: the avatar still goes along')

  // This install's own backend: two other people get no reference; with her in the group, hers.
  const calls = []
  const own = { id: 'local', status: async () => ({ id: 'local', name: '本机', ready: true, models: [] }), draw: async input => (calls.push(input), { buffer: PNG, label: '本机', note: '' }) }
  const local = createMedia(store, { ownBackends: [own] })
  await store.saveSettings({ media: local.cleanSettings({ imageBackend: 'local' }, await local.settings()) })
  await local.generateImage(chat, 'root', '[阿明] talking\n[老周] rowing')
  assert.equal(calls.at(-1).references.length, 0)
  await local.generateImage(chat, 'root', '[林雪] talking\n[老周] rowing')
  assert.equal(calls.at(-1).references.length, 1)
})

test("ComfyUI: a workflow with its size written in draws at the 画幅 asked for; 人设图 and 立绘 upright, with the card's LoRA, style and negatives", async t => {
  const { fake, store, chat, card, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', imageShape: 'landscape', promptStyle: 'tags' }, (await store.getSettings()).media) })
  // As ComfyUI exports it: the size and the negative are number and text fields, only the prompt a placeholder.
  await media.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 1216, height: 832, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad anatomy', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    11: { class_type: 'LatentUpscale', inputs: { upscale_method: 'nearest-exact', width: 1824, height: 1248, crop: 'disabled', samples: ['3', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  })
  await media.saveCardMedia(card.id, {
    style: 'watercolor',
    lora: 'styleA.safetensors',
    loraTrigger: 'stA',
    loraStrength: 0.7,
    roster: [
      { id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair', outfit: 'police uniform' },
      { id: 'aming001', name: '阿明', kind: 'boy', looks: 'short brown hair', lora: 'aming.safetensors', loraTrigger: 'aming' },
    ],
  })
  const sent = () => fake.workflowSent()
  const size = () => [sent()[5].inputs.width, sent()[5].inputs.height]
  const lora = () => Object.values(sent()).find(node => node.class_type === 'LoraLoader')?.inputs.lora_name ?? null

  // 正文配图 at each 画幅: the workflow's own number of pixels, at the shape picked; the hires pass follows.
  await media.generateImage(chat, 'root', 'a quiet street')
  assert.deepEqual(size(), [1216, 832])
  await store.saveSettings({ media: cleanMedia({ imageShape: 'portrait' }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', 'a quiet street')
  assert.deepEqual(size(), [832, 1216])
  assert.deepEqual([sent()[11].inputs.width, sent()[11].inputs.height], [1248, 1824])
  await store.saveSettings({ media: cleanMedia({ imageShape: 'square' }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', 'a quiet street')
  assert.deepEqual(size(), [1024, 1024])
  assert.equal(lora(), 'styleA.safetensors')
  assert.equal(sent()[7].inputs.text, 'lowres, bad anatomy', 'a picture of the story adds nothing to the negative')

  // A 立绘 of someone without a LoRA of their own: upright whatever the 画幅, the card's LoRA, trigger and style,
  // and its negative after the workflow's.
  await store.saveSettings({ media: cleanMedia({ imageShape: 'landscape' }, (await store.getSettings()).media) })
  await media.drawSprite(card.id, 'linxue01')
  assert.deepEqual(size(), [832, 1216])
  assert.equal(lora(), 'styleA.safetensors')
  assert.match(sent()[6].inputs.text, /^masterpiece, stA, watercolor, 1girl, solo, upper body, .*white background.*short black hair, police uniform/)
  assert.match(sent()[7].inputs.text, /^lowres, bad anatomy, multiple views, text, scenery, detailed background/)
  // Someone with their own LoRA: theirs instead.
  await media.drawSprite(card.id, 'aming001')
  assert.equal(lora(), 'aming.safetensors')
  assert.match(sent()[6].inputs.text, /^masterpiece, aming, /)
  // 人设图 and a 表情: the same.
  await media.drawPortrait(card.id, { id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair' })
  assert.deepEqual(size(), [832, 1216])
  assert.equal(lora(), 'styleA.safetensors')
  assert.match(sent()[6].inputs.text, /watercolor/)
  assert.match(sent()[7].inputs.text, /nsfw, multiple views, text, detailed background, gradient background, indoors, window, .*head out of frame$/, 'a 人设图 is cut out too: nothing pulling it off white')
  await media.drawExpression(card.id, 'linxue01', 'smile', PNG)
  assert.deepEqual([size(), lora()], [[832, 1216], 'styleA.safetensors'])
  assert.match(sent()[6].inputs.text, /watercolor/)
  assert.match(sent()[7].inputs.text, /detailed background/)

  // Two people in a frame: the card's LoRA as its 画风 (none of theirs: they would bleed).
  await media.generateImage(chat, 'root', '场景: office\n[林雪] saluting\n[阿明] nodding')
  assert.equal(lora(), 'styleA.safetensors')
  // A card LoRA that is someone's own is their face: not on anybody else.
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), lora: 'aming.safetensors', loraTrigger: 'aming' })
  await media.drawSprite(card.id, 'linxue01')
  assert.equal(lora(), null)
  await media.generateImage(chat, 'root', '场景: office\n[林雪] saluting\n[阿明] nodding')
  assert.equal(lora(), null)
  await media.drawSprite(card.id, 'aming001')
  assert.equal(lora(), 'aming.safetensors')
})

test('fitSize, withNegative and loraFor', () => {
  // SD 1.5 stays small; the Efficient Loader's own fields; a workflow with placeholders is left as it is.
  const sd15 = { 5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } } }
  assert.deepEqual(fitSize(sd15, 1216, 832)[5].inputs, { width: 768, height: 512, batch_size: 1 })
  assert.deepEqual(fitSize(sd15, 1024, 1024)[5].inputs, { width: 640, height: 640, batch_size: 1 })
  assert.deepEqual(fitSize(sd15, 832, 1216)[5].inputs, { width: 512, height: 768, batch_size: 1 }, 'already upright: its own size kept')
  const efficient = { 1: { class_type: 'Efficient Loader', inputs: { empty_latent_width: 1024, empty_latent_height: 1024 } } }
  assert.deepEqual(fitSize(efficient, 832, 1216)[1].inputs, { empty_latent_width: 832, empty_latent_height: 1216 })
  const placed = { 5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } } }
  assert.deepEqual(fitSize(placed, 832, 1216), placed, 'filled with the size as it is')
  assert.deepEqual(fitSize({ 2: { class_type: 'ImageScale', inputs: { width: 512, height: 512 } } }, 832, 1216)[2].inputs, { width: 512, height: 512 }, 'not a latent: left alone')

  const sampled = { 3: { class_type: 'KSampler', inputs: { negative: ['7', 0] } }, 7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, ' } } }
  assert.equal(withNegative(sampled, 'scenery')[7].inputs.text, 'lowres, scenery')
  assert.equal(withNegative(sampled, '')[7].inputs.text, 'lowres, ')
  const own = { ...sampled, 7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}' } } }
  assert.equal(withNegative(own, 'scenery'), own, '{{negative}} is filled instead')

  const card = cleanCardMedia({ lora: 'style.safetensors', roster: [{ id: 'aaaa0001', name: '甲', looks: 'x' }, { id: 'bbbb0001', name: '乙', looks: 'y', lora: 'yi.safetensors' }] })
  const [jia, yi] = card.roster
  const castOf = (...people) => ({ characters: people.map(entry => ({ entry })), solo: people.length === 1 ? people[0] : null })
  assert.equal(loraFor(card, null).lora, 'style.safetensors')
  assert.equal(loraFor(card, castOf(jia)).lora, 'style.safetensors')
  assert.equal(loraFor(card, castOf(yi)).lora, 'yi.safetensors')
  assert.equal(loraFor(card, castOf(jia, yi)).lora, 'style.safetensors')
  assert.equal(loraFor(card, castOf(jia), { scenery: true }), null)
  assert.equal(loraFor({ ...card, lora: 'yi.safetensors' }, castOf(jia)), null)
})

test('ComfyUI: each reference picture is uploaded under a name of its own', async t => {
  const { fake, store, chat, card, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy' }, (await store.getSettings()).media) })
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, 10: { class_type: 'LoadImage', inputs: { image: '{{reference}}' } } })
  await media.saveCardMedia(card.id, { roster: [{ id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair' }, { id: 'aming001', name: '阿明', kind: 'boy', looks: 'short hair' }] })
  const other = Buffer.concat([PNG, Buffer.from('another picture')])
  await media.saveRosterRef(card.id, 'aming001', `data:image/png;base64,${other.toString('base64')}`)
  await media.generateImage(chat, 'root', '[林雪] saluting')
  await media.generateImage(chat, 'root', '[阿明] nodding')
  await media.generateImage(chat, 'root', '[林雪] smiling')
  const names = fake.seen.filter(r => r.url === '/upload/image').map(r => /filename="([^"]+)"/.exec(r.form)?.[1])
  assert.match(names[0], new RegExp(`^tavern-${card.id}-[0-9a-f]{16}\\.png$`))
  assert.notEqual(names[0], names[1], 'two pictures never share a name')
  assert.equal(names[0], names[2], 'the same picture keeps its name')
})

test('ComfyUI: a 人设图 or a picture with no card never takes the old 人设图 as reference; a LoRA goes after a diffusion-model loader, or is left out with a note', async t => {
  const { fake, store, chat, card, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', promptStyle: 'tags' }, (await store.getSettings()).media) })
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, 10: { class_type: 'LoadImage', inputs: { image: '{{reference}}' } } })
  await media.saveCardMedia(card.id, { roster: [{ id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair' }] })
  await media.saveRosterRef(card.id, 'linxue01', `data:image/png;base64,${Buffer.concat([PNG, Buffer.from('old portrait')]).toString('base64')}`)
  const lastUpload = () => fake.seen.filter(r => r.url === '/upload/image').at(-1)
  // Drawn again from new looks: a white picture goes along, not the 人设图 it replaces, and the page is told.
  const portrait = await media.drawPortrait(card.id, { id: 'linxue01', name: '林雪', kind: 'girl', looks: 'long silver hair' })
  assert.equal(lastUpload().form.includes('old portrait'), false)
  assert.match(/filename="([^"]+)"/.exec(lastUpload().form)[1], new RegExp(`^tavern-${card.id}-[0-9a-f]{16}\\.png$`))
  assert.match(portrait.note, /白图/)
  // A picture of her in the story still keeps her face.
  await media.generateImage(chat, 'root', '[林雪] saluting')
  assert.ok(lastUpload().form.includes('old portrait'))
  // No card at all (a page's background, a card being created): drawn, with the white picture.
  const backdrop = await media.drawBackdrop('a quiet street')
  assert.match(/filename="([^"]+)"/.exec(lastUpload().form)[1], /^tavern-blank-[0-9a-f]{16}\.png$/)
  assert.deepEqual(backdrop.buffer, PNG)
  await media.drawCardArt({ name: '新角色', looks: 'short red hair' })

  // Flux and the like: the model loaded on its own, a model-only LoRA after it; the text encoder untouched.
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), lora: 'styleA.safetensors', loraTrigger: 'stA' })
  await media.saveWorkflow({
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl.safetensors', type: 'flux' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['2', 0] } },
    3: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['6', 0] } },
  })
  await media.drawSprite(card.id, 'linxue01')
  const flux = fake.workflowSent()
  assert.deepEqual(flux[7], { class_type: 'LoraLoaderModelOnly', _meta: { title: 'Card LoRA' }, inputs: { lora_name: 'styleA.safetensors', strength_model: 0.8, model: ['1', 0] } })
  assert.deepEqual(flux[3].inputs.model, ['7', 0])
  assert.deepEqual(flux[6].inputs.clip, ['2', 0])
  assert.match(flux[6].inputs.text, /^stA, /)
  // Nothing that loads a model: drawn as it is, the LoRA left out and said so.
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  const plain = await media.generateImage(chat, 'root', 'a quiet street')
  assert.equal(Object.values(fake.workflowSent()).some(node => /Lora/.test(node.class_type)), false)
  assert.match(plain.note, /没带 LoRA「styleA\.safetensors」/)
})

test('ComfyUI: why it refused a workflow, or failed running it, is passed on', async t => {
  // As ComfyUI answers POST /prompt for a LoRA it does not have.
  const missing = {
    error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
    node_errors: { 10: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "lora_name: 'gone.safetensors' not in ['linxue.safetensors']", extra_info: { input_name: 'lora_name', received_value: 'gone.safetensors' } }], dependent_outputs: ['9'], class_type: 'LoraLoader' } },
  }
  assert.match(comfyRefusal(JSON.stringify(missing)), /^ComfyUI 里没有 LoRA「gone\.safetensors」/)
  const checkpoint = structuredClone(missing)
  Object.assign(checkpoint.node_errors[10], { class_type: 'CheckpointLoaderSimple' })
  Object.assign(checkpoint.node_errors[10].errors[0].extra_info, { input_name: 'ckpt_name', received_value: 'old.safetensors' })
  assert.equal(comfyRefusal(JSON.stringify(checkpoint)), 'ComfyUI 里没有「old.safetensors」（CheckpointLoaderSimple 节点 10 的 ckpt_name）：把工作流里的文件名改成 ComfyUI 里有的，再导入')
  assert.equal(comfyRefusal(JSON.stringify({ error: { type: 'prompt_no_outputs', message: 'Prompt has no outputs', details: '' }, node_errors: {} })), 'ComfyUI 不接受这个工作流：Prompt has no outputs')
  assert.equal(comfyRefusal('<html>'), '')
  // Its history when a node fails while running.
  const oom = { status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'Allocation on device \n' }]] } }
  assert.match(comfyFailure(oom), /^ComfyUI 执行出错：KSampler 节点 3：Allocation on device（显存不够/)
  assert.equal(comfyFailure({ status: { status_str: 'error' } }), 'ComfyUI 执行出错，去 ComfyUI 界面看看是哪个节点')

  const { store, chat, media } = await setup(t)
  let refuse = true
  const comfy = await tinyServer(t, {
    '/prompt': (req, res) => (refuse ? res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(missing)) : res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ prompt_id: 'p1' }))),
    '/history/p1': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ p1: oom })),
  })
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', comfyUrl: comfy.base }, (await store.getSettings()).media) })
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /ComfyUI 里没有 LoRA「gone\.safetensors」/)
  refuse = false
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /KSampler 节点 3：Allocation on device/)
})

test('ComfyUI: a LoRA of another family than the model is said so; SDXL text encoders take the negative; waiting in the queue is not drawing time', async t => {
  assert.equal(modelFamily({ 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora', ss_base_model_version: 'sdxl_base_v1-0' }, 'linxue.safetensors'), 'sdxl')
  assert.equal(modelFamily({ ss_sd_model_name: 'runwayml/stable-diffusion-v1-5', ss_v2: 'False' }, 'Moxin_Shukezouma11.safetensors'), 'sd1')
  assert.equal(modelFamily({}, 'waiIllustriousSDXL_v170.safetensors'), 'sdxl')
  assert.equal(modelFamily({}, 'flux1-dev-fp8.safetensors'), 'flux')
  assert.equal(modelFamily({}, 'pixel_art.safetensors'), '', 'not told by a name that only happens to hold the letters')
  const sdxl = { 3: { class_type: 'KSampler', inputs: { negative: ['7', 0] } }, 7: { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'lowres', text_l: 'lowres' } } }
  assert.deepEqual(withNegative(sdxl, 'scenery')[7].inputs, { text_g: 'lowres, scenery', text_l: 'lowres, scenery' })

  const { store, chat, card, media: plain } = await setup(t)
  const state = { pendingUntil: 0, doneAt: 0 }
  const json = (res, body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const comfy = await tinyServer(t, {
    '/view_metadata/loras': (req, res) => json(res, { ss_sd_model_name: 'runwayml/stable-diffusion-v1-5' }),
    '/view_metadata/checkpoints': (req, res) => res.writeHead(404).end(),
    '/prompt': (req, res) => json(res, { prompt_id: 'p1' }),
    '/queue': (req, res) => json(res, { queue_running: [], queue_pending: Date.now() < state.pendingUntil ? [[1, 'p1', {}, {}, []]] : [] }),
    '/history/p1': (req, res) => json(res, Date.now() >= state.doneAt ? { p1: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } } : {}),
    '/view': (req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG),
  })
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', comfyUrl: comfy.base }, (await store.getSettings()).media) })
  await plain.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  })
  await plain.saveCardMedia(card.id, { lora: 'Moxin_Shukezouma11.safetensors' })
  const drawn = await plain.generateImage(chat, 'root', 'a quiet street')
  assert.match(drawn.note, /LoRA「Moxin_Shukezouma11\.safetensors」是 SD 1\.5 的，工作流的底模「waiIllustriousSDXL_v170\.safetensors」是 SDXL/)
  await plain.generateImage(chat, 'root', 'a quiet street')
  assert.equal(comfy.seen.filter(r => r.url.startsWith('/view_metadata/loras')).length, 1, 'asked once')

  // A picture that waits its turn longer than it may run is still drawn; one that runs too long is given up.
  const media = createMedia(store, { comfyTimes: { poll: 10, run: 150, queue: 3000 } })
  state.pendingUntil = Date.now() + 600
  state.doneAt = Date.now() + 700
  assert.deepEqual(await media.readImage(chat.id, (await media.generateImage(chat, 'root', 'x')).file), PNG)
  state.pendingUntil = 0
  state.doneAt = Date.now() + 60_000
  await assert.rejects(media.generateImage(chat, 'root', 'x'), /十分钟还没出图/)
  const short = createMedia(store, { comfyTimes: { poll: 10, run: 100, queue: 300 } })
  state.pendingUntil = Date.now() + 60_000
  await assert.rejects(short.generateImage(chat, 'root', 'x'), /一小时还没轮到这张/)
})

/** A PNG's first bytes as ComfyUI sends them: enough for its size to be read. */
function pngOf(width, height) {
  const head = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(head)
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

test('ComfyUI 简单模式: a workflow built from the model picked, what ComfyUI has to pick from, drawn with the card LoRA', async t => {
  // A checkpoint: its own text encoder and VAE, the tavern's placeholders in it.
  const checkpoint = simpleWorkflow({ ...cleanMedia({ comfyMode: 'simple', comfyModel: 'wai.safetensors' }) })
  assert.deepEqual(checkpoint[1], { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } })
  assert.deepEqual([checkpoint[8].inputs.vae, checkpoint[3]], [['1', 2], undefined])
  assert.deepEqual(describeOf(checkpoint), ['prompt', 'negative', 'seed', 'width', 'height'])
  assert.deepEqual(checkpoint[7].inputs, { seed: '{{seed}}', steps: 24, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] })
  // A diffusion model: encoder and VAE apart, the encoder type told from its name; Flux's two encoders.
  const krea = simpleWorkflow(cleanMedia({ comfyTemplate: 'unet', comfyModel: 'krea2_turbo_fp8_scaled.safetensors', comfyClip: 'qwen3vl_4b.safetensors', comfyVae: 'qwen_image_vae.safetensors', comfyCfg: 1, comfySteps: 8 }))
  assert.deepEqual(krea[2], { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b.safetensors', type: 'krea2' } })
  assert.deepEqual([krea[8].inputs.vae, krea[7].inputs.cfg, krea[7].inputs.steps], [['3', 0], 1, 8])
  const flux = simpleWorkflow(cleanMedia({ comfyTemplate: 'unet', comfyModel: 'flux1-dev.safetensors', comfyClip: 't5xxl.safetensors', comfyClip2: 'clip_l.safetensors', comfyVae: 'ae.safetensors' }))
  assert.deepEqual(flux[2].inputs, { clip_name1: 't5xxl.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' })
  assert.equal(clipTypeOf('mystery.safetensors'), '')
  assert.throws(() => simpleWorkflow(cleanMedia({ comfyTemplate: 'unet', comfyModel: 'mystery.safetensors', comfyClip: 'x', comfyVae: 'y' })), /编码器类型/)
  assert.throws(() => simpleWorkflow(cleanMedia({ comfyTemplate: 'unet', comfyModel: 'flux1-dev.safetensors' })), /文本编码器/)
  assert.equal(simpleWorkflow(cleanMedia({})), null)
  assert.throws(() => cleanMedia({ comfyModel: '../../secret.safetensors' }), /模型文件名/)
  assert.equal(cleanMedia({ comfyModel: 'SDXL\\wai.safetensors' }).comfyModel, 'SDXL\\wai.safetensors')
  assert.deepEqual([cleanMedia({ comfySteps: 900, comfyCfg: -3 }).comfySteps, cleanMedia({ comfyCfg: -3 }).comfyCfg], [150, 0])

  const { store, chat, media } = await setup(t)
  const json = (res, body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const comfy = await tinyServer(t, {
    // The classic form ([[names], {}]) and the newer one (['COMBO', { options }]).
    '/object_info/CheckpointLoaderSimple': (req, res) => json(res, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['wai.safetensors', 'SDXL\\pony.safetensors'], {}] } } } }),
    '/object_info/UNETLoader': (req, res) => json(res, { UNETLoader: { input: { required: { unet_name: ['COMBO', { options: ['krea2_turbo.safetensors'] }], weight_dtype: [['default'], {}] } } } }),
    '/object_info/CLIPLoader': (req, res) => json(res, { CLIPLoader: { input: { required: { clip_name: [['qwen.safetensors'], {}], type: [['stable_diffusion', 'krea2'], {}] } } } }),
    '/object_info/DualCLIPLoader': (req, res) => json(res, { DualCLIPLoader: { input: { required: { clip_name1: [['qwen.safetensors', 't5xxl.safetensors'], {}], type: [['flux'], {}] } } } }),
    '/object_info/VAELoader': (req, res) => json(res, { VAELoader: { input: { required: { vae_name: [['ae.safetensors'], {}] } } } }),
    '/object_info/KSampler': (req, res) => json(res, { KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m'], {}], scheduler: [['normal', 'simple'], {}] } } } }),
    '/prompt': (req, res) => json(res, { prompt_id: 'p1' }),
    '/history/p1': (req, res) => json(res, { p1: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } }),
    '/view': (req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG),
  })
  assert.deepEqual(await media.comfyModels(comfy.base), {
    checkpoints: ['wai.safetensors', 'SDXL\\pony.safetensors'],
    unets: ['krea2_turbo.safetensors'],
    clips: ['qwen.safetensors', 't5xxl.safetensors'],
    clipTypes: ['stable_diffusion', 'krea2', 'flux'],
    vaes: ['ae.safetensors'],
    samplers: ['euler', 'dpmpp_2m'],
    schedulers: ['normal', 'simple'],
  })
  await assert.rejects(media.comfyModels('http://127.0.0.1:9'), /连不上 ComfyUI/)

  // Simple mode with no model: says so, not "import a workflow".
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', comfyUrl: comfy.base, comfyMode: 'simple' }, (await store.getSettings()).media) })
  await assert.rejects(media.generateImage(chat, 'root', 'a quiet street'), /简单模式还没选模型/)
  // A model picked: drawn with the built workflow, the card's LoRA after the checkpoint, nothing imported.
  await store.saveSettings({ media: cleanMedia({ comfyModel: 'wai.safetensors', comfyCfg: 5 }, (await store.getSettings()).media) })
  const card = await store.getCard(chat.cardId)
  card.media = cleanCardMedia({ lora: 'linxue.safetensors' })
  await store.saveCard(card)
  await media.generateImage(chat, 'root', '1girl, saluting')
  const sent = comfy.seen.findLast(request => request.url === '/prompt').json.prompt
  assert.equal(sent[1].inputs.ckpt_name, 'wai.safetensors')
  assert.equal(sent[10].class_type, 'LoraLoader')
  assert.deepEqual([sent[7].inputs.cfg, typeof sent[7].inputs.seed, sent[6].inputs.width > 0], [5, 'number', true])
  assert.match(sent[4].inputs.text, /1girl, saluting/)
  assert.equal(await media.loadWorkflow(), null, 'the imported workflow is left as it was')
  // A file ComfyUI doesn't have: pick again in simple mode.
  const refusal = JSON.stringify({ node_errors: { 1: { class_type: 'CheckpointLoaderSimple', errors: [{ type: 'value_not_in_list', message: 'x', extra_info: { input_name: 'ckpt_name', received_value: 'gone.safetensors' } }] } } })
  assert.match(comfyRefusal(refusal, { simple: true }), /简单模式里点「读取模型」/)
})

/** The placeholders a workflow has, as describeWorkflow lists them. */
function describeOf(workflow) {
  const text = JSON.stringify(workflow)
  return ['prompt', 'negative', 'seed', 'width', 'height', 'reference'].filter(key => text.includes(`{{${key}}}`))
}

test("ComfyUI: a player's own workflow — custom loaders, no %prompt%, prompts behind text and ControlNet nodes, four at a time", () => {
  // A Krea 2 workflow a player sent: Josia's loader (model, text encoder and VAE in one) and LoRA stack, a zeroed negative.
  const josia = {
    72: { class_type: 'JosiaCheckpointPlus', inputs: { main_model: 'Krea2.safetensors', clip_name: 'qwen.safetensors', clip_type: 'krea2', vae_name: 'qwen_image_vae.safetensors' } },
    84: { class_type: 'JosiaLoraStack', inputs: { lora_count: 1, lora_name_1: 'turbo.safetensors', model: ['72', 0], clip: ['72', 1] } },
    86: { class_type: 'CLIPTextEncode', inputs: { text: '%prompt%', clip: ['84', 1] } },
    89: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['86', 0] } },
    54: { class_type: 'KSampler', inputs: { seed: 5, cfg: 1, model: ['84', 0], positive: ['86', 0], negative: ['89', 0], latent_image: ['53', 0] } },
    53: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 4 } },
  }
  // The card LoRA goes on the model the sampler takes, after their own stack.
  const lora = withLora(josia, { name: 'linxue.safetensors', strength: 0.8 })
  assert.deepEqual(lora[90], { class_type: 'LoraLoaderModelOnly', _meta: { title: 'Card LoRA' }, inputs: { lora_name: 'linxue.safetensors', strength_model: 0.8, model: ['84', 0] } })
  assert.deepEqual(lora[54].inputs.model, ['90', 0])
  // The zeroed negative has no text to add to: nothing is written into the prompt instead.
  assert.deepEqual(withNegative(checkWorkflow(josia), 'scenery'), checkWorkflow(josia))
  assert.equal(fillWorkflow(checkWorkflow(josia), { prompt: 'a girl', seed: 9 })[53].inputs.batch_size, 1)

  // No %prompt%: the words come from a text node feeding the encoder, through a ControlNet; the negative is behind one too.
  const plain = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'wai.safetensors' } },
    10: { class_type: 'PrimitiveStringMultiline', _meta: { title: '正向' }, inputs: { value: 'a test girl in a garden' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: ['10', 0], clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres, bad hands', clip: ['4', 1] } },
    11: { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['6', 0], negative: ['7', 0], strength: 1, control_net: ['12', 0], image: ['13', 0] } },
    3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0], positive: ['11', 0], negative: ['11', 1] } },
  }
  const imported = checkWorkflow(plain)
  assert.equal(imported[10].inputs.value, '{{prompt}}')
  assert.equal(imported[7].inputs.text, 'lowres, bad hands')
  assert.equal(withNegative(imported, 'scenery')[7].inputs.text, 'lowres, bad hands, scenery')
  // Flux's encoder and a string joined after a separator.
  const flux = {
    6: { class_type: 'CLIPTextEncodeFlux', inputs: { clip_l: 'x', t5xxl: 'x', guidance: 3.5 } },
    14: { class_type: 'StringConcatenate', inputs: { string_a: 'masterpiece', string_b: 'x', delimiter: ', ' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: ['14', 0] } },
    3: { class_type: 'KSampler', inputs: { positive: ['6', 0], negative: ['7', 0] } },
  }
  assert.deepEqual([checkWorkflow(flux)[6].inputs.clip_l, checkWorkflow(flux)[6].inputs.t5xxl], ['{{prompt}}', '{{prompt}}'])
  assert.equal(withNegative(flux, 'scenery')[14].inputs.string_b, 'x, scenery')
  // Nothing linked to a sampler's positive: still asked for.
  assert.throws(() => checkWorkflow({ 1: { class_type: 'KSampler', inputs: {} } }), /%prompt%/)
})

test('ComfyUI: sizes from linked Int nodes, nodes that set a size the tavern leaves alone, and a picture that came out the wrong shape', async t => {
  // Width and height linked from Int nodes: written in as numbers, at the shape asked for.
  const linked = {
    5: { class_type: 'EmptyLatentImage', inputs: { width: ['12', 0], height: ['13', 0], batch_size: 1 } },
    12: { class_type: 'PrimitiveInt', inputs: { value: 1344 } },
    13: { class_type: 'PrimitiveInt', inputs: { value: 768 } },
  }
  assert.deepEqual(fitSize(linked, 832, 1216)[5].inputs, { width: 768, height: 1344, batch_size: 1 })
  // {{width}} on one node no longer keeps the others from being sized.
  const placed = { 5: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } }, 11: { class_type: 'LatentUpscale', inputs: { width: 1824, height: 1248 } } }
  assert.deepEqual(fitSize(placed, 832, 1216)[11].inputs, { width: 1248, height: 1824 })
  // ComfyUI's Resolution Selector set to 16:9: the latent takes its size turned upright, as numbers.
  const picker = {
    49: { class_type: 'ResolutionSelector', inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 1, multiple: 8 } },
    53: { class_type: 'EmptyLatentImage', inputs: { width: ['49', 0], height: ['49', 1], batch_size: 1 } },
  }
  assert.deepEqual(fitSize(picker, 832, 1216)[53].inputs, { width: 768, height: 1368, batch_size: 1 })
  assert.deepEqual(fitSize(picker, 1216, 832)[53].inputs, { width: 1368, height: 768, batch_size: 1 })
  assert.deepEqual(sizeNodes(picker), { set: ['EmptyLatentImage 53'], other: [] })
  const others = {
    ...linked,
    7: { class_type: 'CLIPTextEncodeSDXL', inputs: { width: 1024, height: 1024, text_g: 'x', text_l: 'x' } },
    20: { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 1216, height: 832, crop: 'center', image: ['8', 0] } },
    21: { class_type: 'CR SDXL Aspect Ratio', inputs: { width: 1024, height: 1024, aspect_ratio: '3:2 landscape 1216x832', swap_dimensions: 'Off' } },
  }
  assert.deepEqual(sizeNodes(others), { set: ['EmptyLatentImage 5'], other: ['ImageScale 20', 'CR SDXL Aspect Ratio 21'] })
  // The Efficient Loader writes the prompts itself: the negative goes into its own.
  const efficient = { 3: { class_type: 'KSampler (Efficient)', inputs: { positive: ['1', 1], negative: ['1', 2] } }, 1: { class_type: 'Efficient Loader', inputs: { positive: '{{prompt}}', negative: 'lowres', empty_latent_width: 1216, empty_latent_height: 832 } } }
  assert.equal(withNegative(efficient, 'scenery')[1].inputs.negative, 'lowres, scenery')
  assert.deepEqual(pictureSize(pngOf(1216, 832)), [1216, 832])
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108043004c003012200021101031101', 'hex')
  assert.deepEqual(pictureSize(jpeg), [1216, 1072])
  assert.equal(pictureSize(Buffer.from('not a picture at all, no')), null)

  const { store, chat, card, media } = await setup(t)
  const json = (res, body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const comfy = await tinyServer(t, {
    '/prompt': (req, res) => json(res, { prompt_id: 'p1' }),
    '/history/p1': (req, res) => json(res, { p1: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } }),
    '/view': (req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(pngOf(1216, 832)),
  })
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', comfyUrl: comfy.base }, (await store.getSettings()).media) })
  // On import: what it can change, and what it can't.
  const info = await media.saveWorkflow({ ...others, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  assert.deepEqual(info.size, { set: ['EmptyLatentImage 5'], other: ['ImageScale 20', 'CR SDXL Aspect Ratio 21'] })
  assert.equal(info.negative, false, 'no sampler takes a negative there')
  assert.equal(info.unguided, false)
  await media.saveCardMedia(card.id, { roster: [{ id: 'linxue01', name: '林雪', kind: 'girl', looks: 'short black hair' }] })
  // A 立绘 asked upright that came out wide says which node decided it.
  const sprite = await media.drawSprite(card.id, 'linxue01')
  assert.match(sprite.note, /^ComfyUI 画出来是 1216×832，不是竖图：工作流里 ImageScale 20、CR SDXL Aspect Ratio 21 也定了尺寸/)
  // Nothing it could size at all.
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  assert.match((await media.drawSprite(card.id, 'linxue01')).note, /找不到酒馆能改的宽高/)
  // A turbo model at CFG 1 with a zeroed negative: nothing to add a negative to, and it would be left out anyway.
  const turbo = await media.saveWorkflow({
    ...picker,
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    7: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
    3: { class_type: 'KSampler', inputs: { cfg: 1, positive: ['6', 0], negative: ['7', 0], latent_image: ['53', 0] } },
  })
  assert.deepEqual([turbo.size, turbo.negative, turbo.unguided], [{ set: ['EmptyLatentImage 53'], other: [] }, false, true])
  // Asked wide and drawn wide: nothing to say.
  await store.saveSettings({ media: cleanMedia({ imageShape: 'landscape' }, (await store.getSettings()).media) })
  assert.equal((await media.generateImage(chat, 'root', 'a quiet street')).note, undefined)
})

/** A server answering each path with `routes[path](req, res)`, every request noted. */
async function tinyServer(t, routes) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    seen.push({ url: req.url, auth: req.headers.authorization, json: raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null })
    const route = routes[req.url.split('?')[0]]
    if (route) return route(req, res)
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

test('an image answer\'s link: a data: URL, or one that redirects on to the picture', async t => {
  const cdn = await tinyServer(t, { '/out.png': (req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG) })
  const answers = []
  const relay = await tinyServer(t, {
    '/v1/images/generations': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [answers.shift()] })),
    '/v1/files/abc': (req, res) => res.writeHead(302, { location: '/v1/files/abc/content' }).end(),
    '/v1/files/abc/content': (req, res) => res.writeHead(307, { location: `${cdn.base}/out.png` }).end(),
    '/v1/files/loop': (req, res) => res.writeHead(302, { location: '/v1/files/loop' }).end(),
  })
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-media-link-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard(CARD)
  await store.saveCard(card)
  const provider = normalizeProvider({ name: '中转', api: 'openai-completions', baseURL: `${relay.base}/v1`, apiKey: KEY, models: ['img'] })
  await store.saveProviders([provider])
  await store.saveSettings({ media: cleanMedia({ imageProvider: provider.id, imageModel: 'img' }) })
  const chat = await createChat(store, card.id)
  const media = createMedia(store)

  answers.push({ url: `data:image/png;base64,${PNG.toString('base64')}` })
  assert.deepEqual(await media.readImage(chat.id, (await media.generateImage(chat, 'root', 'x')).file), PNG)
  answers.push({ url: '/v1/files/abc' })
  assert.deepEqual(await media.readImage(chat.id, (await media.generateImage(chat, 'root', 'x')).file), PNG, 'two redirects, onto another host')
  assert.equal(cdn.seen.at(-1).auth, undefined)
  answers.push({ url: '/v1/files/loop' })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), error => error.status === 502 && /302/.test(error.message))
  answers.push({ url: 'ftp://example.invalid/out.png' })
  await assert.rejects(media.generateImage(chat, 'root', 'x'), error => error.status === 502 && /http/.test(error.message))
})

test('a stopped ComfyUI or SD WebUI picture is stopped there too', async t => {
  let running = false
  const comfy = await tinyServer(t, {
    '/prompt': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ prompt_id: 'p9' })),
    '/history/p9': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
    '/queue': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(running ? { queue_running: [[0, 'p9']], queue_pending: [] } : { queue_running: [[0, 'other']], queue_pending: [[1, 'p9']] })),
    '/interrupt': (req, res) => res.writeHead(200).end(),
    // Drawing: never answers on its own.
    '/sdapi/v1/txt2img': () => {},
    '/sdapi/v1/interrupt': (req, res) => res.writeHead(200).end(),
  })
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-media-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard(CARD)
  await store.saveCard(card)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'comfy', comfyUrl: comfy.base, sdUrl: comfy.base }) })
  const chat = await createChat(store, card.id)
  const media = createMedia(store)
  await media.saveWorkflow({ 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } })
  const until = async check => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(check())
  }
  const stopAfter = async (ms, run) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), ms)
    await assert.rejects(run(controller.signal))
  }

  // Still waiting in the queue: deleted from it, and someone else's running prompt left alone.
  await stopAfter(200, signal => media.generateImage(chat, 'root', 'x', signal))
  await until(() => comfy.seen.some(r => r.url === '/queue' && r.json))
  assert.deepEqual(comfy.seen.find(r => r.url === '/queue' && r.json).json, { delete: ['p9'] })
  assert.equal(comfy.seen.some(r => r.url === '/interrupt'), false)
  // Running: interrupted, by its id.
  running = true
  await stopAfter(200, signal => media.generateImage(chat, 'root', 'x', signal))
  await until(() => comfy.seen.some(r => r.url === '/interrupt'))
  assert.deepEqual(comfy.seen.find(r => r.url === '/interrupt').json, { prompt_id: 'p9' })

  await store.saveSettings({ media: cleanMedia({ imageBackend: 'sdwebui' }, (await store.getSettings()).media) })
  await stopAfter(200, signal => media.generateImage(chat, 'root', 'x', signal))
  await until(() => comfy.seen.some(r => r.url === '/sdapi/v1/interrupt'))
})
