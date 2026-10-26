import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanMedia, mediaDefaults } from '../server/media.mjs'
import { createApp } from '../server/http.mjs'
import { localEndpoint, multipart, readAudio, suggestedModel, transcribePrompt, transcriptText } from '../server/voice/listen.mjs'

const KEY = 'sk-listen-provider-0042'
const RELEASE = mediaDefaults({ xiaoya: false })
// 0.1 s of 16 kHz mono WAV, as the page sends it.
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(3200 + 24, 1)])

/** A multipart/form-data body → { field: value } (files as { filename, type, size }). */
function parseForm(raw, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1]
  const fields = {}
  for (const part of raw.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = part.slice(2).split('\r\n\r\n')
    const body = rest.join('\r\n\r\n').slice(0, -2)
    const name = /name="([^"]+)"/.exec(head)[1]
    const filename = /filename="([^"]+)"/.exec(head)?.[1]
    fields[name] = filename ? { filename, type: /Content-Type: (.+)/.exec(head)[1].trim(), size: Buffer.from(body, 'latin1').length } : Buffer.from(body, 'latin1').toString('utf8')
  }
  return fields
}

/** A provider's /v1/audio/transcriptions, a speaches-like local /v1, whisper.cpp's /inference, and a strict one. */
async function fakeTranscribers(t) {
  const seen = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const form = parseForm(Buffer.concat(chunks), String(req.headers['content-type']))
    seen.push({ url: req.url, form, auth: req.headers.authorization })
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    if (req.url === '/v1/audio/transcriptions') {
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: 'bad key' } })
      // SenseVoice's tags around the words.
      return send(200, { text: '<|zh|><|NEUTRAL|><|Speech|>我推开门，  看见林雪。' })
    }
    if (req.url === '/local/v1/audio/transcriptions') return send(200, { text: 'hello there' })
    if (req.url === '/cpp/inference') return send(200, '  就这样吧\n', 'text/plain')
    // A service that takes nothing but the file and the model.
    if (req.url === '/strict/v1/audio/transcriptions') return form.language || form.prompt ? send(400, { error: { message: 'unexpected field' } }) : send(200, { text: 'ok' })
    send(404, { error: { message: 'no such route' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { seen, base: `http://127.0.0.1:${server.address().port}` }
}

async function startApp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-listen-'))
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
    return { status: res.status, body: await res.json() }
  }
  return { root, call }
}

test('voice input helpers: settings, models by provider, prompt, audio, answers, addresses', () => {
  // Nothing is chosen until the player picks; the fields are checked as saved.
  assert.equal(RELEASE.sttSource, '')
  const media = cleanMedia({ sttSource: 'local', sttUrl: ' http://192.168.1.5:8000/v1/ ', sttLocalModel: 'Systran/faster-whisper-small', sttLanguage: 'zh' }, RELEASE, RELEASE)
  assert.deepEqual([media.sttSource, media.sttUrl, media.sttLocalModel, media.sttLanguage], ['local', 'http://192.168.1.5:8000/v1', 'Systran/faster-whisper-small', 'zh'])
  assert.equal(cleanMedia({ sttSource: 'nope', sttLanguage: 'Chinese' }, media, RELEASE).sttSource, 'local', 'an unknown source keeps the saved one')
  assert.equal(cleanMedia({ sttLanguage: 'Chinese' }, media, RELEASE).sttLanguage, 'zh')
  assert.throws(() => cleanMedia({ sttUrl: 'ftp://x' }, RELEASE, RELEASE), /本地转写服务地址不对/)
  assert.throws(() => cleanMedia({ sttModel: 'two words' }, RELEASE, RELEASE), /转写模型名不对/)

  assert.equal(suggestedModel('https://api.siliconflow.cn/v1'), 'FunAudioLLM/SenseVoiceSmall')
  assert.equal(suggestedModel('https://api.groq.com/openai/v1'), 'whisper-large-v3-turbo')
  assert.equal(suggestedModel('https://api.openai.com/v1'), 'gpt-4o-mini-transcribe')
  assert.equal(suggestedModel('https://relay.example/v1'), 'whisper-1')

  // Chinese leads with a simplified sentence (whisper writes as its prompt does); names keep their spelling.
  assert.equal(transcribePrompt('zh', ['林雪', '你', '林雪']), '以下是普通话的句子。人名：林雪、你。')
  assert.equal(transcribePrompt('', ['林雪']), '以下是普通话的句子。人名：林雪。')
  assert.equal(transcribePrompt('en', ['Alice', 'Bob']), 'Alice, Bob')
  assert.equal(transcribePrompt('', []), '')

  const audio = readAudio(WAV.toString('base64'), 'audio/wav')
  assert.deepEqual([audio.filename, audio.type, audio.buffer.length], ['speech.wav', 'audio/wav', WAV.length])
  assert.equal(readAudio(WAV.toString('base64'), 'audio/webm;codecs=opus').filename, 'speech.webm')
  assert.equal(readAudio(WAV.toString('base64'), 'audio/mp4').filename, 'speech.m4a')
  assert.throws(() => readAudio(WAV.toString('base64'), 'video/webm'), /不认识的录音格式/)
  assert.throws(() => readAudio('', 'audio/wav'), /没有收到录音/)
  assert.throws(() => readAudio('AAAA', 'audio/wav'), /录音是空的/)

  assert.equal(transcriptText({ contentType: 'application/json', buffer: Buffer.from('{"text":"<|en|><|HAPPY|> hi\\n there "}') }), 'hi there')
  assert.equal(transcriptText({ contentType: 'text/plain', buffer: Buffer.from(' 好的\n') }), '好的')
  assert.throws(() => transcriptText({ contentType: 'application/json', buffer: Buffer.from('{"error":1}') }), /没有 text/)

  assert.equal(localEndpoint('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1/audio/transcriptions')
  assert.equal(localEndpoint('http://127.0.0.1:8080/inference'), 'http://127.0.0.1:8080/inference')
  assert.equal(localEndpoint('http://h/v1/audio/transcriptions'), 'http://h/v1/audio/transcriptions')

  // Empty optional fields are left out.
  const form = multipart({ file: { buffer: WAV, filename: 'speech.wav', type: 'audio/wav' }, model: 'whisper-1', language: '', prompt: undefined })
  const fields = parseForm(form.buffer, form.contentType)
  assert.deepEqual(Object.keys(fields), ['file', 'model'])
  assert.deepEqual(fields.file, { filename: 'speech.wav', type: 'audio/wav', size: WAV.length })
})

test('voice input over HTTP: provider with its key and default model, names as a hint, form values unsaved, nothing kept', async t => {
  const fake = await fakeTranscribers(t)
  const { root, call } = await startApp(t)
  const audio = WAV.toString('base64')
  const transcribe = body => call('/api/media/transcribe', { method: 'POST', body: { audio, type: 'audio/wav', ...body } })

  // Not chosen yet: the page is told where to choose.
  const unset = await transcribe({})
  assert.deepEqual([unset.status, unset.body.error], [400, '还没选语音输入用什么转写：在「配图与朗读 → 语音输入」里选'])

  const provider = (await call('/api/providers', { method: 'POST', body: { name: '听写', api: 'openai-completions', baseURL: `${fake.base}/v1`, apiKey: KEY, models: ['chat'] } })).body
  const saved = await call('/api/media/settings', { method: 'PUT', body: { sttSource: 'provider', sttProvider: provider.id, sttLanguage: 'zh' } })
  assert.deepEqual([saved.status, saved.body.media.sttSource, saved.body.media.sttProvider], [200, 'provider', provider.id])

  const heard = await transcribe({ names: ['林雪', '你', 42] })
  assert.deepEqual([heard.status, heard.body], [200, { text: '我推开门， 看见林雪。', by: '听写' }])
  const sent = fake.seen.at(-1)
  assert.equal(sent.url, '/v1/audio/transcriptions')
  assert.equal(sent.auth, `Bearer ${KEY}`)
  assert.deepEqual(sent.form, { file: { filename: 'speech.wav', type: 'audio/wav', size: WAV.length }, model: 'whisper-1', language: 'zh', prompt: '以下是普通话的句子。人名：林雪、你。' })
  // The provider's key never reaches the page.
  assert.doesNotMatch(JSON.stringify((await call('/api/media/settings')).body), new RegExp(KEY))

  // 试一试: the form's values, not saved.
  const local = await transcribe({ media: { sttSource: 'local', sttUrl: `${fake.base}/local/v1`, sttLocalModel: 'Systran/faster-whisper-small', sttLanguage: '' } })
  assert.deepEqual(local.body, { text: 'hello there', by: new URL(fake.base).host })
  assert.deepEqual(fake.seen.at(-1).form, { file: { filename: 'speech.wav', type: 'audio/wav', size: WAV.length }, model: 'Systran/faster-whisper-small' })
  assert.equal(fake.seen.at(-1).auth, undefined, 'no key goes to a local server')
  assert.equal((await call('/api/media/settings')).body.media.sttSource, 'provider')
  // whisper.cpp's own path answers in plain text.
  assert.equal((await transcribe({ media: { sttSource: 'local', sttUrl: `${fake.base}/cpp/inference` } })).body.text, '就这样吧')

  // A service that refuses language and prompt is asked again with the file and model alone.
  const strict = (await call('/api/providers', { method: 'POST', body: { name: 'Strict', api: 'openai-completions', baseURL: `${fake.base}/strict/v1`, apiKey: KEY, models: ['m'] } })).body
  assert.equal((await transcribe({ media: { sttProvider: strict.id, sttModel: 'sense' }, names: ['林雪'] })).body.text, 'ok')
  assert.deepEqual(fake.seen.slice(-2).map(r => Object.keys(r.form)), [['file', 'model', 'language', 'prompt'], ['file', 'model']])

  // What goes wrong says what to do.
  const missing = (await call('/api/providers', { method: 'POST', body: { name: 'NoAudio', api: 'openai-completions', baseURL: `${fake.base}/none/v1`, apiKey: KEY, models: ['m'] } })).body
  const noRoute = await transcribe({ media: { sttProvider: missing.id } })
  assert.equal(noRoute.status, 502)
  assert.match(noRoute.body.error, /NoAudio 返回 404.*可能没有 \/audio\/transcriptions 语音转写接口，或者模型名 whisper-1 不对/)
  const claude = (await call('/api/providers', { method: 'POST', body: { name: 'Claude', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-x', models: ['m'] } })).body
  assert.match((await transcribe({ media: { sttProvider: claude.id } })).body.error, /Claude 是 Anthropic 接口，没有语音转写接口/)
  assert.match((await transcribe({ media: { sttProvider: 'gone' } })).body.error, /供应商已经删除/)
  assert.equal((await transcribe({ media: { sttSource: 'browser' } })).status, 400)
  assert.match((await transcribe({ media: { sttSource: 'local', sttUrl: '' } })).body.error, /还没填本地转写服务的地址/)
  assert.match((await transcribe({ media: { sttSource: 'local', sttUrl: `${fake.base}/v2` } })).body.error, /没有 \/v2\/audio\/transcriptions 这个接口/)
  assert.match((await transcribe({ media: { sttSource: 'local', sttUrl: 'http://127.0.0.1:9' } })).body.error, /连不上本地转写服务 http:\/\/127\.0\.0\.1:9/)
  assert.match((await transcribe({ type: 'text/html' })).body.error, /不认识的录音格式：text\/html/)

  // No recording is kept anywhere in the data folder.
  const files = async dir => (await readdir(dir, { withFileTypes: true })).flatMap(entry => (entry.isDirectory() ? [] : [entry.name]))
  assert.ok(!(await files(root)).some(name => /\.(wav|webm|m4a|ogg)$/.test(name)))
  assert.deepEqual(await readdir(path.join(root, 'media')).catch(() => []), [])
})
