import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanMedia, createMedia, mediaDefaults } from '../server/media.mjs'
import { createApp } from '../server/http.mjs'
import { normalizeProvider } from '../server/providers.mjs'
import { createStore } from '../server/store.mjs'
import { audioOf, audioType, cloudError, createCloudSource, listAccountVoices, requestSpec, unpack, wavFromPcm } from '../server/voice/cloud.mjs'
import { cleanVoiceList, createVoices, prepareText } from '../server/voice/index.mjs'
import { defaultVoices, speechRequest, takesInstructions } from '../server/voice/openai.mjs'

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32, 0x55)])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)])
const PCM = Buffer.alloc(480, 1) // 10 ms of 24 kHz mono 16-bit
const PROVIDER_KEY = 'sk-voice-provider-0001'
const FISH_KEY = 'fish-secret-key-abcd1234'
const MINIMAX_KEY = 'eyJminimax.secret.key-wxyz5678'
const FISH_VOICE = '0123456789abcdef0123456789abcdef'
// No voice service assumed (the release): an emptied address stays empty.
const RELEASE = mediaDefaults({ xiaoya: false })

/** Change some media settings as the settings form would. */
async function saveMedia(store, patch) {
  await store.saveSettings({ media: cleanMedia(patch, (await store.getSettings()).media ?? RELEASE, RELEASE) })
}

/** One fake server for every voice source: /audio/speech, Fish, MiniMax (both sites) and a voice bridge. */
async function fakeVoices(t) {
  const seen = []
  const fake = { pcm: false, minimaxError: 0, bridgeNames: ['jok'], bridgeCloud: [], fishModels: [], minimaxAccount: {} }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const json = raw.length && String(req.headers['content-type']).includes('json') ? JSON.parse(raw) : null
    seen.push({ url: req.url, json, headers: req.headers })
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    if (req.url === '/v1/audio/speech') {
      if (req.headers.authorization !== `Bearer ${PROVIDER_KEY}`) return send(401, { error: { message: 'bad key' } })
      if (json.model === 'missing') return send(404, { error: { message: 'model not found' } })
      return fake.pcm ? send(200, PCM, 'audio/L16;rate=24000') : send(200, MP3, 'audio/mpeg')
    }
    if (req.url === '/fish/v1/tts') {
      if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return send(401, { message: `Invalid key ${req.headers.authorization}` })
      if (fake.fishBroke && req.headers.model !== 's2.1-pro-free') return send(402, { status: 402, message: 'Insufficient balance' })
      return send(200, MP3, 'audio/mpeg')
    }
    // 从账户读取音色: Fish pages through the account's models, MiniMax lists every kind at once.
    if (req.url.startsWith('/fish/model?')) {
      if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return send(401, { message: `Invalid key ${req.headers.authorization}` })
      const query = new URL(req.url, 'http://fake').searchParams
      const size = Number(query.get('page_size'))
      const page = Number(query.get('page_number'))
      const items = fake.fishModels.slice((page - 1) * size, page * size)
      return send(200, { total: fake.fishModels.length, items, has_more: page * size < fake.fishModels.length })
    }
    if (req.url === '/minimax-cn/v1/get_voice' || req.url === '/minimax-intl/v1/get_voice') {
      if (req.headers.authorization !== `Bearer ${MINIMAX_KEY}`) return send(200, { base_resp: { status_code: 1004, status_msg: `login fail ${req.headers.authorization}` } })
      return send(200, { ...fake.minimaxAccount, base_resp: { status_code: 0, status_msg: 'success' } })
    }
    if (req.url === '/minimax-cn/v1/t2a_v2' || req.url === '/minimax-intl/v1/t2a_v2') {
      if (req.headers.authorization !== `Bearer ${MINIMAX_KEY}`) return send(200, { base_resp: { status_code: 1004, status_msg: 'login fail' } })
      if (fake.minimaxError) return send(200, { base_resp: { status_code: fake.minimaxError, status_msg: 'nope' } })
      return send(200, { data: { audio: MP3.toString('hex'), status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } })
    }
    if (req.url === '/api/persona/list') return send(200, { voices: fake.bridgeNames.map(name => ({ name })), cloud_voices: fake.bridgeCloud, current: { voice: 'jok' } })
    if (req.url === '/api/tts') return send(200, WAV, 'audio/wav')
    send(404, { error: 'no' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const calls = url => seen.filter(r => r.url === url)
  return { seen, calls, base, fake, urls: { fish: `${base}/fish`, minimax: { cn: `${base}/minimax-cn`, intl: `${base}/minimax-intl` } } }
}

async function setup(t, mediaSettings = {}) {
  const voices = await fakeVoices(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-voice-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createStore(root)
  await store.init()
  const provider = normalizeProvider({ name: '朗读', api: 'openai-completions', baseURL: `${voices.base}/v1`, apiKey: PROVIDER_KEY, models: ['chat'] })
  await store.saveProviders([provider])
  await saveMedia(store, { ttsProvider: provider.id, ...mediaSettings })
  const media = createMedia(store, { voiceUrls: voices.urls, features: { xiaoya: false } })
  const files = async () => (await readdir(path.join(root, 'media', 'tts')).catch(() => [])).sort()
  return { ...voices, store, media, provider, files, root }
}

test('voice helpers: request formats, decoding, voice lists, emotion handling', () => {
  // Fish: tags stay in the text, the model goes in a header.
  const fish = requestSpec({ service: 'fish', key: 'k-123', model: 'drama-3', voice: FISH_VOICE }, '[害羞地] 你来啦。')
  assert.equal(fish.url, 'https://api.fish.audio/v1/tts')
  assert.deepEqual(fish.headers, { authorization: 'Bearer k-123', model: 'drama-3' })
  assert.deepEqual(fish.body, { text: '[害羞地] 你来啦。', reference_id: FISH_VOICE, format: 'mp3', mp3_bitrate: 128, latency: 'normal' })
  assert.throws(() => requestSpec({ service: 'fish', key: 'k', model: 's9', voice: 'x' }, '你好'), /Fish 不认模型/)
  assert.throws(() => requestSpec({ service: 'fish', key: '', model: 'drama-3', voice: 'x' }, '你好'), /还没填密钥/)
  // MiniMax: the site picks the host; hex audio comes back in JSON.
  const minimax = requestSpec({ service: 'minimax', key: 'k', model: 'speech-2.8-hd', voice: 'female-shaonv', region: 'intl' }, '你好')
  assert.equal(minimax.url, 'https://api.minimax.io/v1/t2a_v2')
  assert.equal(requestSpec({ service: 'minimax', key: 'k', model: 'speech-2.8-hd', voice: 'v', region: 'cn' }, '你好').url, 'https://api.minimaxi.com/v1/t2a_v2')
  assert.deepEqual(minimax.body.voice_setting, { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 })
  assert.deepEqual([minimax.body.output_format, minimax.body.stream, minimax.body.audio_setting.format], ['hex', false, 'mp3'])
  assert.deepEqual(unpack('minimax', Buffer.from(JSON.stringify({ data: { audio: MP3.toString('hex') }, base_resp: { status_code: 0 } }))), MP3)
  assert.throws(() => unpack('minimax', Buffer.from(JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }))), /1008：余额不足/)
  assert.throws(() => unpack('minimax', Buffer.from(JSON.stringify({ data: { audio: '' }, base_resp: { status_code: 0 } }))), /没有返回音频/)

  // Audio: the bytes say what they are; raw PCM gets a WAV header.
  assert.equal(audioType(MP3), 'audio/mpeg')
  assert.equal(audioType(WAV), 'audio/wav')
  assert.equal(audioType(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'audio/mpeg')
  assert.equal(audioType(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'audio/aac')
  assert.equal(audioType(Buffer.from('OggS\0\0')), 'audio/ogg')
  assert.equal(audioType(Buffer.from('????'), 'audio/x-wav'), 'audio/wav')
  assert.equal(audioType(Buffer.from('????'), 'application/json'), null)
  const wav = wavFromPcm(PCM, 24000)
  assert.equal(wav.length, PCM.length + 44)
  assert.deepEqual([wav.subarray(0, 4).toString(), wav.subarray(8, 12).toString(), wav.readUInt32LE(24), wav.readUInt16LE(34), wav.readUInt32LE(40)], ['RIFF', 'WAVE', 24000, 16, PCM.length])
  const fromPcm = audioOf(PCM, { contentType: 'audio/L16;rate=16000;channels=1' })
  assert.deepEqual([fromPcm.mime, fromPcm.buffer.readUInt32LE(24), fromPcm.buffer.length], ['audio/wav', 16000, PCM.length + 44])
  assert.equal(audioOf(PCM, { pcmRate: 32000 }).buffer.readUInt32LE(24), 32000)
  assert.throws(() => audioOf(Buffer.from('{"error":"quota"}'), { contentType: 'application/json' }), /不是音频.*quota/)
  assert.deepEqual(audioOf(Buffer.from('anything'), { fallback: 'audio/wav' }).mime, 'audio/wav')
  // Raw PCM whose first sample looks like an MPEG frame sync is still PCM; only a container header says otherwise.
  const syncLike = Buffer.concat([Buffer.from([0xff, 0xfb]), PCM])
  assert.equal(audioOf(syncLike, { contentType: 'audio/L16;rate=24000' }).mime, 'audio/wav')
  assert.equal(audioOf(syncLike, { pcmRate: 24000 }).mime, 'audio/wav')
  assert.equal(audioOf(syncLike, { contentType: 'audio/mpeg' }).mime, 'audio/mpeg')
  assert.equal(audioOf(MP3, { pcmRate: 24000 }).mime, 'audio/mpeg')

  // Voice lists from the settings form: links, ids with names, bare ids on one line.
  assert.deepEqual(cleanVoiceList(`https://fish.audio/zh-CN/m/${FISH_VOICE.toUpperCase()}/ 南晚\n${'a'.repeat(32)}\n\n${FISH_VOICE}`, { fish: true }), [
    { id: FISH_VOICE, name: '南晚' },
    { id: 'a'.repeat(32), name: '' },
  ])
  assert.deepEqual(cleanVoiceList('alloy, coral，nova'), [{ id: 'alloy', name: '' }, { id: 'coral', name: '' }, { id: 'nova', name: '' }])
  assert.deepEqual(cleanVoiceList('FunAudioLLM/CosyVoice2-0.5B:anna 沉稳女声，旁白用'), [{ id: 'FunAudioLLM/CosyVoice2-0.5B:anna', name: '沉稳女声，旁白用' }])
  assert.deepEqual(cleanVoiceList([{ id: 'female-yujie', name: '御姐' }]), [{ id: 'female-yujie', name: '御姐' }])
  assert.throws(() => cleanVoiceList('坏<id> 名字'), /音色 ID/)
  assert.throws(() => cleanMedia({ fishModel: 's9-pro' }), /Fish 模型/)
  assert.throws(() => cleanMedia({ minimaxModel: 'gpt-4o' }), /MiniMax 模型/)
  assert.equal(cleanMedia({ ttsModel: '  ' }).ttsModel, 'gpt-4o-mini-tts')
  assert.equal(cleanMedia({ minimaxRegion: 'intl' }).minimaxRegion, 'intl')

  // Emotion tags: kept, made into instructions, or dropped.
  const line = '[害羞地小声] 你来啦。[开心] 走吧！'
  assert.deepEqual(prepareText(line, 'tags'), { text: line, instructions: '' })
  assert.deepEqual(prepareText(line, 'none'), { text: '你来啦。走吧！', instructions: '' })
  assert.deepEqual(prepareText(line, 'instruction'), { text: '你来啦。走吧！', instructions: '按顺序用这些语气说：害羞地小声；开心' })
  assert.deepEqual(prepareText('[开心] 好。', 'instruction'), { text: '好。', instructions: '用这种语气说：开心' })
  assert.ok(takesInstructions('gpt-4o-mini-tts') && takesInstructions('gpt-4o-mini-tts-2025-12-15') && !takesInstructions('tts-1'))
  assert.deepEqual(speechRequest({ model: 'tts-1', voice: 'nova', text: '你好' }), { model: 'tts-1', input: '你好', voice: 'nova', response_format: 'mp3' })
  assert.equal(defaultVoices('gpt-4o-mini-tts')[0].id, 'alloy')
  assert.equal(defaultVoices('FunAudioLLM/CosyVoice2-0.5B')[0].id, 'FunAudioLLM/CosyVoice2-0.5B:anna')
  assert.deepEqual(defaultVoices('kokoro'), [])
})

test('provider voices: /audio/speech with the provider key, emotions as instructions, cached as .mp3', async t => {
  const { calls, fake, media, store, provider, files } = await setup(t, { ttsVoices: 'coral 温柔\nnova' })
  const ref = `openai:${provider.id}:coral`
  const listed = (await media.voices()).sources.find(s => s.id === 'openai')
  assert.deepEqual(listed, {
    id: 'openai',
    label: '供应商朗读',
    chunkMax: 250,
    emotion: 'instruction',
    model: 'gpt-4o-mini-tts',
    configured: true,
    voices: [{ ref, label: '温柔 · coral' }, { ref: `openai:${provider.id}:nova`, label: 'nova' }],
  })

  const first = await media.speak({ text: '[害羞地小声] 你来啦。', voice: ref })
  assert.deepEqual([first.mime, first.buffer], ['audio/mpeg', MP3])
  const [call] = calls('/v1/audio/speech')
  assert.equal(call.headers.authorization, `Bearer ${PROVIDER_KEY}`)
  assert.deepEqual(call.json, { model: 'gpt-4o-mini-tts', input: '你来啦。', voice: 'coral', response_format: 'mp3', instructions: '用这种语气说：害羞地小声' })
  assert.equal((await files()).length, 1)
  assert.match((await files())[0], /^[0-9a-f]{32}\.mp3$/)
  assert.deepEqual(await media.speak({ text: '[害羞地小声] 你来啦。', voice: ref }), first)
  assert.equal(calls('/v1/audio/speech').length, 1, 'the second time comes from the cache')
  // Another emotion is another take.
  await media.speak({ text: '[生气] 你来啦。', voice: ref })
  assert.equal(calls('/v1/audio/speech').length, 2)

  // A model without instructions: tags dropped; the model is part of the cache key.
  await saveMedia(store, { ttsModel: 'tts-1' })
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: ref })
  assert.deepEqual(calls('/v1/audio/speech').at(-1).json, { model: 'tts-1', input: '你来啦。', voice: 'coral', response_format: 'mp3' })
  assert.equal(calls('/v1/audio/speech').length, 3)

  // Raw PCM gets a WAV header and is kept as .wav; fresh replaces the .mp3 take.
  fake.pcm = true
  const redone = await media.speak({ text: '[害羞地小声] 你来啦。', voice: ref, fresh: true })
  assert.equal(redone.mime, 'audio/wav')
  assert.equal(redone.buffer.subarray(0, 4).toString(), 'RIFF')
  assert.equal(redone.buffer.readUInt32LE(24), 24000)
  assert.equal((await files()).filter(f => f.endsWith('.wav')).length, 1)
  assert.equal((await files()).length, 3, 'the .mp3 of that take is gone')
  assert.deepEqual((await media.speak({ text: '[害羞地小声] 你来啦。', voice: ref })).mime, 'audio/wav')

  // Errors that say what to do.
  await assert.rejects(media.speak({ text: '你好', voice: 'openai:gone:coral' }), /已经删除/)
  await saveMedia(store, { ttsModel: 'missing' })
  await assert.rejects(media.speak({ text: '你好', voice: ref }), /404.*朗读接口/)
  const other = normalizeProvider({ name: '别家', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'x', models: ['m'] }, null, new Set([provider.id]))
  await store.saveProviders([provider, other])
  await assert.rejects(media.speak({ text: '你好', voice: `openai:${other.id}:alloy` }), /不是「配图与朗读」里选的朗读供应商/)
})

test('the read-aloud cache keeps to its size: the takes played longest ago go first', async t => {
  const voices = await fakeVoices(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-voice-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const provider = normalizeProvider({ name: '朗读', api: 'openai-completions', baseURL: `${voices.base}/v1`, apiKey: PROVIDER_KEY, models: ['chat'] })
  const settings = cleanMedia({ ttsProvider: provider.id }, RELEASE, RELEASE)
  const tts = createVoices({ root, settings: async () => settings, providers: async () => [provider], urls: voices.urls, features: { xiaoya: false }, cacheMax: MP3.length * 3 })
  const dir = path.join(root, 'media', 'tts')
  const ref = `openai:${provider.id}:alloy`
  const files = async () => (await readdir(dir).catch(() => [])).sort()
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  /** Read one line; → the file its take is kept in, when it is a new one. */
  const take = async text => {
    const before = new Set(await files())
    await tts.speak({ text, voice: ref })
    return (await files()).find(name => !before.has(name))
  }
  const named = []
  for (const text of ['一', '二', '三']) named.push(await take(text))
  // Last played: 一 300 s ago, 二 200 s, 三 100 s; then 一 is played again, from the cache.
  const ago = seconds => new Date(Date.now() - seconds * 1000)
  await Promise.all(named.map((name, i) => utimes(path.join(dir, name), ago(300 - i * 100), ago(300 - i * 100))))
  await take('一')
  assert.equal(voices.calls('/v1/audio/speech').length, 3)
  await wait(50)
  // A fourth is over the size: the ones played longest ago go, down to four fifths.
  const fourth = await take('四')
  for (let i = 0; i < 100 && (await files()).length > 2; i++) await wait(20)
  assert.deepEqual(await files(), [named[0], fourth].sort())
})

test('Fish and MiniMax: keys kept server-side, tags only for Fish, hex decoded, errors without the key', async t => {
  const { calls, fake, media, store, files } = await setup(t, { fishVoices: `${FISH_VOICE} 南晚` })
  // No key yet: nothing listed, and speaking says so.
  let [, , fishSource, minimaxSource] = (await media.voices()).sources
  assert.deepEqual([fishSource.configured, fishSource.voices, minimaxSource.configured], [false, [], false])
  await assert.rejects(media.speak({ text: '你好', voice: `fish:${FISH_VOICE}` }), /Fish Audio 还没填密钥/)

  assert.deepEqual(await media.setVoiceKey('fish', `Bearer ${FISH_KEY}`), { fish: { hasKey: true, keyHint: '…1234' }, minimax: { hasKey: false, keyHint: '' } })
  await media.setVoiceKey('minimax', MINIMAX_KEY)
  await assert.rejects(media.setVoiceKey('fish', 'has space in it'), /密钥格式/)
  ;[, , fishSource, minimaxSource] = (await media.voices()).sources
  assert.deepEqual(fishSource.voices, [{ ref: `fish:${FISH_VOICE}`, label: '南晚 · 01234567' }])
  assert.equal(fishSource.emotion, 'tags')
  // MiniMax offers its system voices while none are listed.
  assert.equal(minimaxSource.voices[0].ref, 'minimax:female-shaonv')
  assert.equal(minimaxSource.emotion, 'none')

  const fish = await media.speak({ text: '[害羞地小声] 你来啦。', voice: `fish:${FISH_VOICE}` })
  assert.deepEqual([fish.mime, fish.buffer], ['audio/mpeg', MP3])
  const [fishCall] = calls('/fish/v1/tts')
  assert.equal(fishCall.headers.authorization, `Bearer ${FISH_KEY}`)
  assert.equal(fishCall.headers.model, 'drama-3')
  assert.deepEqual(fishCall.json, { text: '[害羞地小声] 你来啦。', reference_id: FISH_VOICE, format: 'mp3', mp3_bitrate: 128, latency: 'normal' })
  // Another Fish model is another voice.
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: `fish:${FISH_VOICE}` })
  assert.equal(calls('/fish/v1/tts').length, 1)
  await saveMedia(store, { fishModel: 's2.1-pro-free' })
  await media.speak({ text: '[害羞地小声] 你来啦。', voice: `fish:${FISH_VOICE}` })
  assert.equal(calls('/fish/v1/tts').length, 2)
  assert.equal(calls('/fish/v1/tts')[1].headers.model, 's2.1-pro-free')

  const minimax = await media.speak({ text: '[害羞地小声] 你来啦。', voice: 'minimax:female-yujie' })
  assert.deepEqual([minimax.mime, minimax.buffer], ['audio/mpeg', MP3])
  const [minimaxCall] = calls('/minimax-cn/v1/t2a_v2')
  assert.equal(minimaxCall.headers.authorization, `Bearer ${MINIMAX_KEY}`)
  assert.deepEqual(minimaxCall.json, {
    model: 'speech-2.8-hd',
    text: '你来啦。',
    stream: false,
    output_format: 'hex',
    language_boost: 'auto',
    voice_setting: { voice_id: 'female-yujie', speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  })
  await saveMedia(store, { minimaxRegion: 'intl' })
  await media.speak({ text: '换个站点', voice: 'minimax:female-yujie' })
  assert.equal(calls('/minimax-intl/v1/t2a_v2').length, 1)
  fake.minimaxError = 1008
  const failed = await media.speak({ text: '没钱了', voice: 'minimax:female-yujie' }).catch(error => error)
  assert.equal(failed.status, 502)
  assert.match(failed.message, /MiniMax.*1008.*余额不足/)
  assert.equal((await files()).filter(f => f.endsWith('.mp3')).length, 4)

  // An account with no balance: the paid models say so and name the free one, which still reads.
  fake.fishBroke = true
  await saveMedia(store, { fishModel: 'drama-3' })
  const broke = await media.speak({ text: '没钱也想听', voice: `fish:${FISH_VOICE}` }).catch(error => error)
  assert.equal(broke.status, 502)
  assert.equal(broke.message, 'Fish Audio 余额不足（HTTP 402）：drama-3 按用量计费。去 fish.audio 充值，或在「配图与朗读 → 朗读来源 → Fish Audio」把模型换成 s2.1-pro-free（免费）。')
  await saveMedia(store, { fishModel: 's2.1-pro-free' })
  assert.equal((await media.speak({ text: '没钱也想听', voice: `fish:${FISH_VOICE}` })).mime, 'audio/mpeg')
  fake.fishBroke = false

  // A wrong key: the service's echo of it is not passed on.
  await media.setVoiceKey('fish', 'fish-wrong-key-00000000')
  const denied = await media.speak({ text: '再来一句', voice: `fish:${FISH_VOICE}` }).catch(error => error)
  assert.match(denied.message, /Fish Audio HTTP 401：密钥无效/)
  assert.doesNotMatch(denied.message, /fish-wrong-key/)
  assert.match(denied.message, /\[密钥已隐藏\]/)
  // Removing the last key removes the file.
  await media.setVoiceKey('fish', '')
  assert.deepEqual(await media.voiceKeys(), { fish: { hasKey: false, keyHint: '' }, minimax: { hasKey: true, keyHint: '…5678' } })
})

test('从账户读取音色: Fish pages, MiniMax groups, merged into the form list with its names, nothing saved, key not echoed', async t => {
  const other = 'a'.repeat(32)
  const { seen, fake, media, store } = await setup(t, { fishVoices: `${FISH_VOICE} 南晚\n${other}` })
  const fishCalls = () => seen.filter(r => r.url.startsWith('/fish/model?'))
  await assert.rejects(media.accountVoices({ source: 'fish' }), /Fish Audio 还没填密钥/)
  await assert.rejects(media.accountVoices({ source: 'openai' }), /没有账户音色可读/)
  await assert.rejects(media.accountVoices({ source: 'nope' }), /不认识的语音来源/)
  assert.equal(fishCalls().length, 0)

  // 102 voices on the account: two pages of 100. Two are listed already; the list holds 100.
  const id = n => n.toString(16).padStart(32, '0')
  fake.fishModels = [
    { _id: FISH_VOICE, title: 'Nanwan', state: 'trained' },
    { _id: other, title: '阿雅', state: 'trained' },
    { _id: id(1), title: '还在练', state: 'training' },
    ...Array.from({ length: 99 }, (_, i) => ({ _id: id(i + 2), title: `声音${i + 2}` })),
  ]
  // A typed key works without being saved.
  const typed = await media.accountVoices({ source: 'fish', keys: { fish: FISH_KEY } })
  assert.deepEqual(fishCalls().map(r => r.url), [
    '/fish/model?self=true&page_size=100&page_number=1',
    '/fish/model?self=true&page_size=100&page_number=2',
  ])
  assert.equal(fishCalls()[0].headers.authorization, `Bearer ${FISH_KEY}`)
  assert.deepEqual(typed.voices.slice(0, 3), [
    { id: FISH_VOICE, name: '南晚' },
    { id: other, name: '阿雅' },
    { id: id(1), name: '还在练（未训练完）' },
  ])
  assert.deepEqual([typed.voices.length, typed.found, typed.added, typed.changed, typed.full], [100, 102, 98, true, true])
  assert.doesNotMatch(JSON.stringify(typed), new RegExp(FISH_KEY))
  assert.deepEqual((await store.getSettings()).media.fishVoices, [{ id: FISH_VOICE, name: '南晚' }, { id: other, name: '' }], 'not saved')
  assert.deepEqual(await media.voiceKeys(), { fish: { hasKey: false, keyHint: '' }, minimax: { hasKey: false, keyHint: '' } })

  // The form's list as it stands, with the saved key; a short last page ends the paging.
  await media.setVoiceKey('fish', FISH_KEY)
  fake.fishModels = fake.fishModels.slice(0, 2)
  const again = await media.accountVoices({ source: 'fish', media: { fishVoices: `${FISH_VOICE} 南晚\n${other} 小雅` } })
  assert.equal(fishCalls().length, 3)
  assert.deepEqual([again.voices, again.added, again.changed, again.full], [[{ id: FISH_VOICE, name: '南晚' }, { id: other, name: '小雅' }], 0, false, false])
  // An account with no voices of its own answers too, and leaves the list as it was.
  fake.fishModels = []
  const none = await media.accountVoices({ source: 'fish' })
  assert.deepEqual([none.found, none.added, none.changed, none.voices.length], [0, 0, false, 2])

  // A wrong key: Fish's echo of it is not passed on.
  await media.setVoiceKey('fish', 'fish-wrong-key-00000000')
  const denied = await media.accountVoices({ source: 'fish' }).catch(error => error)
  assert.equal(denied.status, 502)
  assert.match(denied.message, /Fish Audio HTTP 401：密钥无效/)
  assert.doesNotMatch(denied.message, /fish-wrong-key/)

  // MiniMax: cloned and designed voices, not the system ones; the system voices it offered stay.
  await media.setVoiceKey('minimax', MINIMAX_KEY)
  fake.minimaxAccount = {
    system_voice: [{ voice_id: 'female-shaonv', voice_name: '少女' }],
    voice_cloning: [{ voice_id: 'MyClone001', voice_name: '小晴' }, { voice_id: 'bad id with spaces' }],
    voice_generation: [{ voice_id: 'ttv-voice-2026101801' }],
  }
  const minimax = await media.accountVoices({ source: 'minimax' })
  const [getVoice] = seen.filter(r => r.url === '/minimax-cn/v1/get_voice')
  assert.equal(getVoice.headers.authorization, `Bearer ${MINIMAX_KEY}`)
  assert.deepEqual(getVoice.json, { voice_type: 'all' })
  assert.deepEqual(minimax.voices.slice(0, 2).map(v => v.id), ['female-shaonv', 'female-yujie'])
  assert.deepEqual(minimax.voices.slice(-2), [{ id: 'MyClone001', name: '小晴（复刻）' }, { id: 'ttv-voice-2026101801', name: '设计' }])
  assert.deepEqual([minimax.found, minimax.added, minimax.changed], [2, 2, true])
  // The form's site, and a list of its own.
  const intl = await media.accountVoices({ source: 'minimax', media: { minimaxRegion: 'intl', minimaxVoices: 'MyClone001 晴晴' } })
  assert.equal(seen.filter(r => r.url === '/minimax-intl/v1/get_voice').length, 1)
  assert.deepEqual(intl.voices, [{ id: 'MyClone001', name: '晴晴' }, { id: 'ttv-voice-2026101801', name: '设计' }])
  // MiniMax says a wrong key in its own status; the echo is hidden.
  const wrong = await media.accountVoices({ source: 'minimax', keys: { minimax: 'eyJwrong.minimax.key-0000' } }).catch(error => error)
  assert.match(wrong.message, /MiniMax.*1004.*站点/)
  assert.doesNotMatch(wrong.message, /eyJwrong/)
})

test('cloud voices give up on a service that never answers (读取音色, 试听, reading) and say whether a proxy was used', async t => {
  // One address accepts the connection and stays silent (a blocked site, a dead proxy node);
  // another sends its headers and then stalls; a third refuses.
  const sockets = new Set()
  const silent = createTcpServer(socket => sockets.add(socket))
  const stalled = createServer((req, res) => {
    sockets.add(res.socket)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"items":[')
  })
  const closed = createTcpServer()
  await Promise.all([silent, stalled, closed].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  const at = server => `http://127.0.0.1:${server.address().port}`
  const refused = at(closed)
  await new Promise(resolve => closed.close(resolve))
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    silent.close()
    stalled.close()
  })
  const list = (config, options = {}) => listAccountVoices({ service: 'fish', key: FISH_KEY, ...config }, { timeoutMs: 300, ...options }).catch(error => error)
  const quick = async promise => {
    const started = Date.now()
    const error = await promise
    assert.ok(Date.now() - started < 3000, `gave up after ${Date.now() - started} ms`)
    return error
  }

  const direct = await quick(list({ urls: { fish: at(silent) } }))
  assert.equal(direct.status, 504)
  assert.match(direct.message, /^连不上 Fish Audio：等了 1 秒没有回应。现在没走代理：要开代理才能上这个网站的话，去「设置 → 网络代理」选「跟随系统代理」或填代理地址。$/)
  assert.doesNotMatch(direct.message, new RegExp(FISH_KEY))
  // Through a proxy: check that it runs (a loopback address is reached without it here).
  const proxied = await quick(list({ urls: { fish: at(silent) } }, { proxy: 'http://127.0.0.1:1' }))
  assert.match(proxied.message, /没有回应。检查网络，以及「设置 → 网络代理」里的代理是否在运行/)
  // A body that never ends is given up on too.
  assert.equal((await quick(list({ urls: { fish: at(stalled) } }))).status, 504)
  // MiniMax's mainland site is direct on purpose: no proxy advice. The phone has no proxy menu.
  const home = await quick(list({ service: 'minimax', key: MINIMAX_KEY, region: 'cn', urls: { minimax: { cn: at(silent) } } }))
  assert.match(home.message, /^连不上 MiniMax：等了 1 秒没有回应。检查网络。$/)
  const phone = await quick(list({ urls: { fish: at(silent) } }, { proxyMenu: false }))
  assert.match(phone.message, /没有回应。检查网络和代理设置。$/)
  // A refused connection says the same at once.
  const down = await quick(list({ urls: { fish: refused } }, { timeoutMs: 20000 }))
  assert.equal(down.status, 502)
  assert.match(down.message, /^连不上 Fish Audio：现在没走代理/)
  // Closing the page cancels as before, without the timeout's message.
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  const cancelled = await quick(list({ urls: { fish: at(silent) } }, { signal: controller.signal, timeoutMs: 20000 }))
  assert.equal(cancelled.name, 'AbortError')

  // Speech (reading and 试听) has its own, longer deadline.
  const speak = (service, urls, { proxy = null, timeouts = { list: 300, speech: 300 }, region = 'cn', signal } = {}) => {
    const source = createCloudSource(service, { urls, timeouts })
    const media = { fishModel: 'drama-3', fishVoices: [], minimaxModel: 'speech-2.8-hd', minimaxRegion: region, minimaxVoices: [] }
    return source.synth({ voice: FISH_VOICE, text: '你好' }, { media, keys: { fish: FISH_KEY, minimax: MINIMAX_KEY }, proxy: () => proxy, signal }).catch(error => error)
  }
  const stuck = await quick(speak('fish', { fish: at(silent) }))
  assert.equal(stuck.status, 504)
  assert.match(stuck.message, /^连不上 Fish Audio：等了 1 秒没有回应。现在没走代理：要开代理才能上这个网站的话/)
  assert.equal((await quick(speak('fish', { fish: at(stalled) }))).status, 504)
  // MiniMax's international site goes through the proxy when there is one.
  const abroad = await quick(speak('minimax', { minimax: { intl: at(silent) } }, { region: 'intl', proxy: 'http://127.0.0.1:1' }))
  assert.match(abroad.message, /^连不上 MiniMax：等了 1 秒没有回应。检查网络，以及「设置 → 网络代理」里的代理是否在运行。$/)
  const refusedSpeech = await quick(speak('fish', { fish: refused }, { timeouts: { list: 20000, speech: 20000 } }))
  assert.equal(refusedSpeech.status, 502)
  assert.match(refusedSpeech.message, /^连不上 Fish Audio：现在没走代理/)
  const stopped = new AbortController()
  setTimeout(() => stopped.abort(), 50)
  assert.equal((await quick(speak('fish', { fish: at(silent) }, { signal: stopped.signal, timeouts: { list: 20000, speech: 20000 } }))).name, 'AbortError')
  // A connection reset during the TLS handshake names no code in its message.
  const reset = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' })
  assert.match(cloudError('Fish Audio', reset, FISH_KEY, { route: 'direct' }), /^连不上 Fish Audio：现在没走代理/)
})

test('voice routing: names the voice service lists go to it first; unprefixed names are its own', async t => {
  const { calls, fake, base, media, store } = await setup(t, { fishVoices: FISH_VOICE })
  await media.setVoiceKey('fish', FISH_KEY)
  await saveMedia(store, { ttsUrl: base })
  const other = 'f'.repeat(32)
  fake.bridgeCloud = [{ name: `fish:${FISH_VOICE}`, label: '南晚', provider: 'Fish Audio · 云端', model: 'drama-3', tags: true }]
  // The bridge calls this one by name (the personal install's cards keep their sound) ...
  const viaBridge = await media.speak({ text: '[开心] 你好', voice: `fish:${FISH_VOICE}` })
  assert.equal(viaBridge.mime, 'audio/wav')
  assert.deepEqual(calls('/api/tts').at(-1).json, { text: '[开心] 你好', voice: `fish:${FISH_VOICE}`, stable: false })
  assert.equal(calls('/fish/v1/tts').length, 0)
  // ... one it does not list goes to Fish with the tavern's own key.
  await media.speak({ text: '[开心] 你好', voice: `fish:${other}` })
  assert.equal(calls('/fish/v1/tts').at(-1).json.reference_id, other)
  // Unprefixed and bridge: names are the service's.
  await media.speak({ text: '走吧', voice: 'jok' })
  await media.speak({ text: '走吧', voice: 'bridge:南晚' })
  assert.deepEqual(calls('/api/tts').slice(-2).map(c => c.json.voice), ['jok', '南晚'])
  // Without a voice service, an unprefixed name has nowhere to go; a browser voice never comes here.
  await saveMedia(store, { ttsUrl: '' })
  await assert.rejects(media.speak({ text: '走吧', voice: 'jok' }), /认不出音色/)
  await assert.rejects(media.speak({ text: '走吧', voice: '' }), /浏览器音色/)
  await assert.rejects(media.speak({ text: '走吧', voice: 'browser:Xiaoxiao' }), /页面里朗读/)
  // A card without a voice reads with the service's current one; with the service down, say that and what would work.
  await saveMedia(store, { ttsUrl: 'http://127.0.0.1:9' })
  await assert.rejects(media.speak({ text: '走吧', voice: '' }), error => {
    assert.match(error.message, /这张卡还没选对白音色/)
    assert.match(error.message, /没开/)
    assert.match(error.message, new RegExp(`Fish Audio「${FISH_VOICE}」`))
    return true
  })
})

test('voice over HTTP: real content type, keys never reach the page, 试听 with unsaved settings, the phone sees every voice', async t => {
  const voices = await fakeVoices(t)
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-voice-http-'))
  const app = createApp({ dataRoot: root, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    server.closeAllConnections?.()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
  }
  const provider = (await call('/api/providers', { method: 'POST', body: { name: '朗读', api: 'openai-completions', baseURL: `${voices.base}/v1`, apiKey: PROVIDER_KEY, models: ['chat'] } })).body

  const saved = await call('/api/media/settings', { method: 'PUT', body: { ttsProvider: provider.id, ttsVoices: 'coral', fishKey: FISH_KEY, minimaxKey: MINIMAX_KEY, fishVoices: FISH_VOICE } })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.voiceKeys, { fish: { hasKey: true, keyHint: '…1234' }, minimax: { hasKey: true, keyHint: '…5678' } })
  // Neither key appears in anything the page can read.
  const pages = await Promise.all(['/api/media/settings', '/api/settings', '/api/media/voices', '/api/persona/list', '/api/status'].map(p => call(p)))
  for (const page of pages) {
    const text = JSON.stringify(page.body)
    assert.doesNotMatch(text, new RegExp(FISH_KEY))
    assert.doesNotMatch(text, /eyJminimax/)
    assert.doesNotMatch(text, new RegExp(PROVIDER_KEY))
  }
  // A blank field keeps the key; the clear flag removes it.
  assert.equal((await call('/api/media/settings', { method: 'PUT', body: { fishKey: '  ' } })).body.voiceKeys.fish.hasKey, true)
  assert.equal((await call('/api/media/settings', { method: 'PUT', body: { minimaxClearKey: true } })).body.voiceKeys.minimax.hasKey, false)

  // /api/tts says what the audio is.
  const ref = `openai:${provider.id}:coral`
  const spoken = await call('/api/tts', { method: 'POST', body: { text: '[开心] 你好', voice: ref } })
  assert.deepEqual([spoken.status, spoken.type, spoken.body.subarray(0, 3).toString()], [200, 'audio/mpeg', 'ID3'])

  // 试听: the form's model before saving, the source's first voice, nothing cached.
  const before = (await readdir(path.join(root, 'media', 'tts'))).length
  const heard = await call('/api/media/voices/preview', { method: 'POST', body: { source: 'openai', media: { ttsModel: 'tts-1', ttsVoices: 'nova\ncoral' } } })
  assert.deepEqual([heard.status, heard.type], [200, 'audio/mpeg'])
  assert.deepEqual(voices.calls('/v1/audio/speech').at(-1).json, { model: 'tts-1', input: '你好呀，很高兴见到你。今天想听我讲点什么呢？', voice: 'nova', response_format: 'mp3' })
  assert.equal((await readdir(path.join(root, 'media', 'tts'))).length, before)
  assert.equal((await call('/api/media/settings')).body.media.ttsModel, 'gpt-4o-mini-tts', 'not saved')
  // A typed key is tried without being saved.
  const noKey = await call('/api/media/voices/preview', { method: 'POST', body: { source: 'minimax' } })
  assert.match(noKey.body.error, /MiniMax 还没填密钥/)
  assert.equal((await call('/api/media/voices/preview', { method: 'POST', body: { voice: 'browser:Xiaoxiao' } })).status, 400)
  // 从账户读取音色 needs a key and a source that has an account.
  const noAccount = await call('/api/media/voices/account', { method: 'POST', body: { source: 'minimax' } })
  assert.deepEqual([noAccount.status, noAccount.body.error], [400, 'MiniMax 还没填密钥'])
  assert.equal((await call('/api/media/voices/account', { method: 'POST', body: { source: 'openai' } })).status, 400)

  // The phone, reading through this tavern, sees its cloud voices with how each treats emotions.
  const persona = (await call('/api/persona/list')).body
  assert.deepEqual(persona.voices, [])
  assert.deepEqual(persona.cloud_voices.map(v => [v.name, v.tags, v.chunkMax]), [
    [ref, true, 250],
    [`fish:${FISH_VOICE}`, true, 250],
  ])
})

test('speech chunks: dialogue and narration may take different lengths', async () => {
  const { speechChunks } = await import('../web/shared/speech.js')
  const long = '这是很长的一句话，'.repeat(30)
  const chunks = speechChunks(`${long}“${long}”`, { max: { dialogue: 250, narration: 100 } })
  const longest = kind => Math.max(...chunks.filter(c => c.kind === kind).map(c => c.text.length))
  assert.ok(longest('narration') <= 100)
  assert.ok(longest('dialogue') > 100 && longest('dialogue') <= 250)
})
