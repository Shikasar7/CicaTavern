// The card's 画风 on every ComfyUI and SD WebUI picture, whatever the prompt
// style (it used to reach them only as far as a tag prompt or the helper model
// wrote it in), and MOSS-Image through the images API (answers with a link only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeCard } from '../server/cards.mjs'
import { createChat } from '../server/chats.mjs'
import { cleanMedia, createMedia, editsImages, imageFormat, styleFirst } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
const KEY = 'sk-style-test-0000'
const STYLE = 'anime style, delicate lineart, soft cel shading'
// What a helper model writes for a sentence prompt: the <art_style> it was shown left out.
const SENTENCE = 'A girl with short black hair in a light blue uniform salutes in a quiet office at night.'

async function fake(t) {
  const seen = []
  let workflow = null
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const json = String(req.headers['content-type'] ?? '').includes('json') && raw.length ? JSON.parse(raw) : null
    seen.push({ url: req.url, json })
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    if (req.url === '/v1/chat/completions') return send(200, { model: json.model, choices: [{ message: { content: SENTENCE } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    if (req.url === '/prompt') {
      workflow = json.prompt
      return send(200, { prompt_id: 'p1' })
    }
    if (req.url === '/history/p1') return send(200, { p1: { status: { completed: true }, outputs: { 9: { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } })
    if (req.url.startsWith('/view?')) return send(200, PNG, 'image/png')
    if (req.url === '/sdapi/v1/txt2img') return send(200, { images: [PNG.toString('base64')] })
    // MOSS-Image on api.mosi.cn: a link only (b64_json is refused), no edits endpoint.
    if (req.url === '/mosi/v1/images/generations') {
      if (json.response_format !== 'url') return send(400, { error: { message: 'response_format only supports url' } })
      return send(200, { created: 1, data: [{ url: '/files/moss.png' }], usage: { output_width: 1024, output_height: 1536 } })
    }
    if (req.url === '/files/moss.png') return send(200, PNG, 'image/png')
    send(404, { error: { message: 'not here' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}`, workflowSent: () => workflow }
}

async function setup(t, style = STYLE) {
  const server = await fake(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-style-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '林雪', description: '短黑发，浅蓝警服。', first_mes: '站住。' } })
  await store.saveCard(card, PNG)
  const helper = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${server.base}/v1`, apiKey: KEY, models: ['helper'] })
  const mosi = normalizeProvider({ name: 'MOSI', api: 'openai-completions', baseURL: `${server.base}/mosi/v1`, apiKey: KEY, models: ['moss-image-sft-1.0'] })
  await store.saveProviders([helper, mosi])
  await store.saveSettings({ media: cleanMedia({ helperModel: `${helper.id}/helper`, imageBackend: 'comfy', comfyUrl: server.base, sdUrl: server.base, imageProvider: mosi.id, imageModel: 'moss-image-sft-1.0' }) })
  const media = createMedia(store)
  await media.saveWorkflow({
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %prompt%', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  })
  if (style) await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), style })
  const chat = await createChat(store, card.id)
  return { server, store, card, chat, media }
}

test('styleFirst: the style once, at the front', () => {
  assert.equal(styleFirst('a cat', ''), 'a cat')
  assert.equal(styleFirst('a cat on a roof', 'watercolor'), 'watercolor, a cat on a roof')
  assert.equal(styleFirst('watercolor, a cat', 'watercolor'), 'watercolor, a cat', 'a tag prompt the style went into already')
  assert.equal(styleFirst('1girl, watercolor, solo', 'watercolor'), 'watercolor, 1girl, solo', 'written further in: moved to the front')
  assert.equal(styleFirst('watercolor. A cat sleeps.', 'watercolor'), 'watercolor, A cat sleeps.')
  assert.equal(styleFirst('', 'watercolor'), 'watercolor')
})

test("ComfyUI: the card's 画风 reaches the positive prompt with sentence prompts and prompts typed by hand", async t => {
  const { server, store, card, chat, media } = await setup(t)
  const positive = () => server.workflowSent()[6].inputs.text

  // The reported case: sentence prompts (the default); the helper was shown the style and left it out.
  const { prompt } = await media.writeImagePrompt(chat, chat.nodes.root, { reply: '林雪敬了个礼。', input: '' })
  assert.equal(prompt, SENTENCE)
  await media.generateImage(chat, 'root', prompt)
  assert.equal(positive(), `masterpiece, ${STYLE}, ${SENTENCE}`)

  // A prompt typed or edited by hand.
  await media.generateImage(chat, 'root', 'a quiet street at dusk')
  assert.equal(positive(), `masterpiece, ${STYLE}, a quiet street at dusk`)

  // Tag prompts already start with it (withStyle): not twice.
  await store.saveSettings({ media: cleanMedia({ promptStyle: 'tags' }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', `${STYLE}, 1girl, office, night`)
  assert.equal(positive(), `masterpiece, ${STYLE}, 1girl, office, night`)

  // The card's LoRA trigger word still goes first.
  await media.saveCardMedia(card.id, { ...(await media.cardMediaView(card.id)), lora: 'styleA.safetensors', loraTrigger: 'stA' })
  await media.generateImage(chat, 'root', 'a quiet street at dusk')
  assert.equal(positive(), `masterpiece, stA, ${STYLE}, a quiet street at dusk`)

  // 简单模式 the same.
  await store.saveSettings({ media: cleanMedia({ comfyMode: 'simple', comfyModel: 'base.safetensors' }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', 'a quiet street at dusk')
  assert.equal(server.workflowSent()[4].inputs.text, `stA, ${STYLE}, a quiet street at dusk`)
})

test('ComfyUI: a card without a 画风 draws the prompt as it is', async t => {
  const { server, chat, media } = await setup(t, '')
  await media.generateImage(chat, 'root', 'a quiet street at dusk')
  assert.equal(server.workflowSent()[6].inputs.text, 'masterpiece, a quiet street at dusk')
})

test("SD WebUI: the card's 画风 first in the prompt too", async t => {
  const { server, store, chat, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'sdwebui' }, (await store.getSettings()).media) })
  await media.generateImage(chat, 'root', SENTENCE)
  assert.equal(server.seen.findLast(r => r.url === '/sdapi/v1/txt2img').json.prompt, `${STYLE}, ${SENTENCE}`)
})

test('MOSS-Image: asked for a link without a watermark, the link downloaded; no reference picture (no edits endpoint)', async t => {
  assert.deepEqual(imageFormat('moss-image-sft-1.0'), { response_format: 'url', output_watermark: { enabled: false } })
  assert.deepEqual(imageFormat('moss-image-base-1.0-2026-10-09'), { response_format: 'url', output_watermark: { enabled: false } })
  assert.equal(editsImages('moss-image-sft-1.0'), false)
  assert.equal(editsImages('grok-imagine-image-2.0'), true)

  const { server, store, chat, media } = await setup(t)
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'openai', imageShape: 'portrait', imageReference: true }, (await store.getSettings()).media) })
  const image = await media.generateImage(chat, 'root', SENTENCE)
  assert.deepEqual(await media.readImage(chat.id, image.file), PNG)
  assert.equal(image.backend, 'moss-image-sft-1.0')
  assert.equal(image.note, undefined, 'no "cannot take the reference" note: it was never tried')
  const body = server.seen.find(r => r.url === '/mosi/v1/images/generations').json
  assert.deepEqual(body, { model: 'moss-image-sft-1.0', prompt: SENTENCE, n: 1, size: '1024x1536', response_format: 'url', output_watermark: { enabled: false } })
  assert.equal(server.seen.some(r => r.url.includes('/images/edits')), false)
})
