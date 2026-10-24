// 这一张怎么画: the 画图方式 and model picked for one drawing (web/shared/draw.js
// for what the picker offers, server/media.mjs withDrawChoice for how a pick
// goes over the saved settings without changing them), and 修改角色卡 → 生成头像
// (media.drawAvatar): the card's own character, face and shoulders, square.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { normalizeCard } from '../server/cards.mjs'
import { cleanMedia, createMedia, drawChoiceOf, withDrawChoice } from '../server/media.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { choiceBody, drawChoices, startingChoice } from '../web/shared/draw.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

test('what the picker offers: the methods set up, each with its models; the rest say what they need', () => {
  const providers = [
    // As providers.mjs keeps them: { id, label? }.
    { id: 'img', name: '图片站', api: 'openai-completions', models: [{ id: 'gpt-image-1' }, { id: 'grok-imagine-image', label: 'Grok' }, { id: 'gpt-4o' }] },
    { id: 'goo', name: 'Gemini', api: 'openai-completions', models: [{ id: 'gemini-3-flash-preview' }, { id: 'gemini-3-pro-image-preview' }] },
    { id: 'ant', name: 'Claude', api: 'anthropic-messages', models: ['claude-x'] },
  ]
  const media = cleanMedia({ imageBackend: 'openai', imageProvider: 'img', imageModel: 'gpt-image-1', geminiImageProvider: 'goo' })
  const choices = drawChoices({ media, providers, workflow: null, novelai: { hasToken: false } })
  const by = Object.fromEntries(choices.map(c => [c.id, c]))
  assert.deepEqual(choices.map(c => c.id), ['openai', 'gemini', 'novelai', 'comfy', 'sdwebui'])
  assert.deepEqual([by.openai.saved, by.openai.ready, by.openai.provider, by.openai.models], [true, true, '图片站', ['gpt-image-1', 'grok-imagine-image']], 'drawing models only, when there are any')
  assert.deepEqual([by.gemini.ready, by.gemini.models], [true, ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview']])
  assert.deepEqual([by.novelai.ready, by.novelai.need], [false, 'token'])
  assert.deepEqual([by.comfy.ready, by.comfy.need, by.comfy.models], [false, 'workflow', []])
  assert.deepEqual([by.sdwebui.ready, by.sdwebui.need], [false, 'address'], 'the default address alone is not set up')
  assert.equal(drawChoices({ media: { ...media, sdUrl: 'http://192.168.1.5:7860' }, providers }).find(c => c.id === 'sdwebui').ready, true)
  assert.equal(drawChoices({ media: { ...media, imageProvider: 'ant' }, providers }).find(c => c.id === 'openai').need, 'provider', 'an Anthropic provider draws nothing')
  assert.deepEqual(drawChoices({ media, providers, workflow: { nodes: 9 }, novelai: { hasToken: true } }).filter(c => c.ready).map(c => c.id), ['openai', 'gemini', 'novelai', 'comfy'])

  // Starting where the settings are; a request says only what differs from them.
  assert.deepEqual(startingChoice(choices), { backend: 'openai', model: 'gpt-image-1' })
  assert.deepEqual(choiceBody({ backend: 'openai', model: 'gpt-image-1' }, choices), {})
  assert.deepEqual(choiceBody({ backend: 'openai', model: ' grok-imagine-image ' }, choices), { model: 'grok-imagine-image' })
  assert.deepEqual(choiceBody({ backend: 'gemini', model: 'gemini-2.5-flash-image' }, choices), { backend: 'gemini' })
  assert.deepEqual(choiceBody({ backend: 'gemini', model: 'gemini-3-pro-image-preview' }, choices), { backend: 'gemini', model: 'gemini-3-pro-image-preview' })
  assert.deepEqual(choiceBody({ backend: 'comfy', model: 'anything' }, choices), { backend: 'comfy' }, 'ComfyUI draws with its workflow')
  assert.deepEqual(choiceBody({ backend: 'nope' }, choices), {})
  assert.deepEqual(startingChoice(drawChoices({ media: { imageBackend: 'novelai' }, providers, novelai: { hasToken: false } })).backend, 'novelai', 'the saved one even when it is not set up: the picker says so')
})

test('a pick goes over the saved settings for one drawing only', () => {
  const media = cleanMedia({ imageBackend: 'openai', imageModel: 'gpt-image-1', naiModel: 'nai-diffusion-5-full' })
  assert.deepEqual(withDrawChoice(media, {}), media, 'nothing picked')
  assert.equal(withDrawChoice(media, { model: 'grok-imagine-image' }).imageModel, 'grok-imagine-image')
  const gemini = withDrawChoice(media, { backend: 'gemini', model: 'models/gemini-3-pro-image-preview' })
  assert.deepEqual([gemini.imageBackend, gemini.geminiImageModel, gemini.imageModel], ['gemini', 'gemini-3-pro-image-preview', 'gpt-image-1'])
  const nai = withDrawChoice(media, { backend: 'novelai', model: 'nai-diffusion-4-5-curated' })
  assert.deepEqual([nai.imageBackend, nai.naiModel, nai.naiModelPicked], ['novelai', 'nai-diffusion-4-5-curated', true])
  assert.deepEqual(withDrawChoice(media, { backend: 'sdwebui', model: 'ignored' }), { ...media, imageBackend: 'sdwebui' })
  assert.equal(withDrawChoice(media, { backend: 'midjourney' }).imageBackend, 'openai', 'an unknown method is the saved one')
  assert.throws(() => withDrawChoice(media, { backend: 'novelai', model: 'gpt-image-1' }), /NovelAI 模型名不对/)
  assert.throws(() => withDrawChoice(media, { model: 'bad model name!' }), /模型名不对/)
  // Pages before the picker sent a lone NovelAI model.
  assert.equal(withDrawChoice({ ...media, imageBackend: 'novelai' }, 'nai-diffusion-5-curated').naiModel, 'nai-diffusion-5-curated')
  assert.deepEqual(drawChoiceOf({ backend: ' gemini ', model: 7 }), { backend: 'gemini', model: '' })
  assert.deepEqual(drawChoiceOf(null), { backend: '', model: '' })
})

/** SD WebUI, an images API and a chat model (the helper), all on one port. */
async function fakeBackends(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const json = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    seen.push({ url: req.url, json })
    const send = body => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url === '/sdapi/v1/txt2img') return send({ images: [PNG.toString('base64')] })
    if (req.url === '/v1/images/generations') return send({ data: [{ b64_json: PNG.toString('base64') }] })
    if (req.url === '/v1/chat/completions') return send({ choices: [{ message: { content: '[{"name": "林青禾", "kind": "girl", "looks": "long black hair, brown eyes", "outfit": "green qipao"}]' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })
    res.writeHead(404)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function setup(t, { helper = false } = {}) {
  const fake = await fakeBackends(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-draw-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '本机', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: 'sk-test', models: ['gpt-image-1', 'writer'] })
  await store.saveProviders([provider])
  await store.saveSettings({ media: cleanMedia({ imageBackend: 'openai', imageProvider: provider.id, imageModel: 'gpt-image-1', sdUrl: fake.base, promptStyle: 'tags', helperModel: helper ? `${provider.id}/writer` : '' }) })
  const card = normalizeCard({ name: '林青禾', description: '茶馆掌柜，长发，常穿青色旗袍。', first_mes: '又下雨了。' })
  await store.saveCard(card, PNG)
  return { fake, store, card, media: createMedia(store), provider }
}

test('生成头像: the card\'s own cast entry, square, face and shoulders, in the card\'s style; drawn the way it was picked', async t => {
  const { fake, store, card, media } = await setup(t)
  const saved = await store.getCard(card.id)
  saved.media = { style: 'watercolor', roster: [{ id: 'aa11', name: '阿砚', kind: 'boy', looks: 'short hair' }, { id: 'bb22', name: '青禾', aliases: '林掌柜', kind: 'girl', looks: 'long black hair', outfit: 'green qipao' }] }
  await store.saveCard(saved)
  const drawn = await media.drawAvatar(card.id, undefined, { backend: 'sdwebui' })
  assert.match(drawn.image, /^data:image\/png;base64,/)
  assert.deepEqual([drawn.backend, drawn.from, drawn.note], ['SD WebUI', 'roster', ''])
  const sent = fake.seen.find(r => r.url === '/sdapi/v1/txt2img').json
  assert.deepEqual([sent.width, sent.height], [1024, 1024], 'square')
  assert.match(sent.prompt, /watercolor/)
  assert.match(sent.prompt, /face and shoulders/)
  assert.match(sent.prompt, /long black hair/)
  assert.doesNotMatch(sent.prompt, /short hair/, 'not the other cast member')
  assert.equal((await media.settings()).imageBackend, 'openai', 'the settings stay as they were')

  // The images API with another model picked for this one.
  await media.drawAvatar(card.id, undefined, { model: 'grok-imagine-image' })
  const asked = fake.seen.find(r => r.url === '/v1/images/generations').json
  assert.deepEqual([asked.model, asked.size], ['grok-imagine-image', '1024x1024'])
})

test('生成头像 without the looks in the cast: read from the card by the helper, else drawn from the description', async t => {
  const plain = await setup(t)
  const described = await plain.media.drawAvatar(plain.card.id, undefined, { backend: 'sdwebui' })
  assert.equal(described.from, 'description')
  assert.match(described.note, /照着描述画/)
  assert.match(plain.fake.seen.at(-1).json.prompt, /茶馆掌柜/)

  const helped = await setup(t, { helper: true })
  const read = await helped.media.drawAvatar(helped.card.id, undefined, { backend: 'sdwebui' })
  assert.equal(read.from, 'draft')
  assert.match(read.note, /本机 · writer 从卡里读出来/)
  assert.ok(helped.fake.seen.some(r => r.url === '/v1/chat/completions'))
  assert.match(helped.fake.seen.find(r => r.url === '/sdapi/v1/txt2img').json.prompt, /green qipao/)
})

test('over HTTP: 生成头像 and 画一张 take a method and model for one drawing; the settings stay', async t => {
  const fake = await fakeBackends(t)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-draw-http-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json() }
  }
  await call('/api/media/settings', { method: 'PUT', body: { imageBackend: 'comfy', sdUrl: fake.base } })
  const card = (await call('/api/cards/import', { method: 'POST', body: { filename: 'c.json', data: Buffer.from(JSON.stringify({ name: '林青禾', description: 'long black hair, green qipao', first_mes: '你好。' })).toString('base64') } })).body

  const drawn = await call(`/api/cards/${card.id}/avatar/draw`, { method: 'POST', body: { backend: 'sdwebui' } })
  assert.equal(drawn.status, 200)
  assert.match(drawn.body.image, /^data:image\/png;base64,/)
  assert.equal(drawn.body.backend, 'SD WebUI')
  assert.equal((await call(`/api/cards/${card.id}/edit`)).body.hasAvatar, false, 'nothing taken yet')
  assert.equal((await call(`/api/cards/${card.id}/avatar/draw`, { method: 'POST', body: {} })).status, 400, 'the saved ComfyUI has no workflow yet')

  const portrait = await call(`/api/cards/${card.id}/roster/portrait`, { method: 'POST', body: { entry: { name: '阿砚', kind: 'boy', looks: 'short hair' }, backend: 'sdwebui' } })
  assert.equal(portrait.status, 200)
  assert.equal(fake.seen.filter(r => r.url === '/sdapi/v1/txt2img').length, 2)
  assert.equal((await call('/api/media/settings')).body.media.imageBackend, 'comfy', 'the settings stay as they were')
})

test('this install\'s own image backends: offered beside the others, their model kept, drawn with the cast\'s pictures', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-own-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const calls = []
  const own = {
    id: 'local',
    status: async () => ({ id: 'local', name: '本机画图', ready: true, need: '', hint: '慢', models: [{ id: 'm-fast', label: 'Fast' }, { id: 'm-fine', label: 'Fine' }], model: 'm-fast' }),
    draw: async input => (calls.push(input), { buffer: PNG, label: `本机 · ${input.model || 'm-fast'}`, note: '' }),
  }
  const media = createMedia(store, { ownBackends: [own] })
  const card = normalizeCard({ name: '林青禾', description: 'long black hair', first_mes: '你好。' })
  card.media = { roster: [{ id: 'aa11bb22cc', name: '林青禾', kind: 'girl', looks: 'long black hair' }] }
  await store.saveCard(card, PNG)

  // Saved as the 画图方式, with a model of its own; another build without it falls back.
  await store.saveSettings({ media: media.cleanSettings({ imageBackend: 'local', localModels: { local: 'm-fine' } }, await media.settings()) })
  assert.deepEqual([(await media.settings()).imageBackend, (await media.settings()).localModels], ['local', { local: 'm-fine' }])
  assert.equal(cleanMedia((await store.getSettings()).media).imageBackend, 'openai', 'a build without it draws with the default')
  assert.throws(() => media.cleanSettings({ localModels: { local: 'bad model!' } }, {}), /模型名不对/)
  assert.deepEqual((await media.ownBackends()).map(view => [view.id, view.model]), [['local', 'm-fine']], 'the saved model is the one shown')

  // The avatar: its own character's reference picture goes along, square.
  await media.saveRosterRef(card.id, 'aa11bb22cc', `data:image/png;base64,${PNG.toString('base64')}`)
  const drawn = await media.drawAvatar(card.id, undefined, {})
  assert.equal(drawn.backend, '本机 · m-fine')
  assert.deepEqual([calls[0].shape, calls[0].model, calls[0].references.length], ['square', 'm-fine', 1])
  // A picked model for one drawing, and a portrait with no references.
  await media.drawPortrait(card.id, { name: '阿砚', kind: 'boy', looks: 'short hair' }, undefined, { model: 'm-fast' })
  assert.deepEqual([calls[1].model, calls[1].shape, calls[1].references.length], ['m-fast', 'portrait', 0])
  assert.equal((await media.settings()).localModels.local, 'm-fine', 'the pick is for that one only')
  // Picked from another backend: the usual pick rules hold.
  assert.deepEqual(withDrawChoice(await media.settings(), { backend: 'local', model: 'm-fast' }, ['openai', 'local']).localModels, { local: 'm-fast' })

  // The picker lists it after the usual ones, with its own words and model names.
  const choices = drawChoices({ media: await media.settings(), own: await media.ownBackends() })
  const listed = choices.at(-1)
  assert.deepEqual([listed.id, listed.name, listed.saved, listed.ready, listed.model, listed.models, listed.labels['m-fine']], ['local', '本机画图', true, true, 'm-fine', ['m-fast', 'm-fine'], 'Fine'])
  assert.deepEqual(choiceBody({ backend: 'local', model: 'm-fast' }, choices), { model: 'm-fast' })
  const notReady = drawChoices({ own: [{ id: 'local', name: 'x', ready: false, need: '没装', models: [] }] }).at(-1)
  assert.deepEqual([notReady.ready, notReady.need, notReady.needText], [false, 'own', '没装'])
})
