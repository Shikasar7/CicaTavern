// Voice input (语音输入): what the player says, as text for the input box. It
// is never sent on its own: the page puts it in the box to be read first.
//   provider  a provider's OpenAI-compatible POST /audio/transcriptions (OpenAI
//             gpt-4o-mini-transcribe / whisper-1, SiliconFlow SenseVoice, Groq
//             whisper, Mistral Voxtral), with its key, address and proxy setting
//   local     a whisper server on this machine or the LAN (speaches /
//             faster-whisper-server, LocalAI, whisper.cpp's /inference): no key, no proxy
//   browser   the page's own speech recognition (Web Speech API): never reaches the server
//   off       no microphone button
// The page sends a 16 kHz mono WAV where it can (every service takes WAV; whisper.cpp
// takes nothing else), else what the browser recorded. Nothing is kept: the audio
// goes to the service and is dropped with the request.
import { providerError, providerRequest } from '../providers.mjs'
import { httpError, newId } from '../store.mjs'
import { msg } from '../i18n.mjs'

export const LISTEN_SOURCES = ['provider', 'local', 'browser', 'off']
// sttSource '' = not chosen yet: the button asks where the audio should go before anything is recorded.
export const DEFAULT_LISTEN = Object.freeze({ sttSource: '', sttProvider: '', sttModel: '', sttUrl: '', sttLocalModel: '', sttLanguage: '' })
// OpenAI's limit for one file; three minutes of 16 kHz WAV is under 6 MB.
export const MAX_AUDIO = 25 * 1024 * 1024
// What a recording may be, as the services name the file.
const AUDIO_FILE = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/flac': 'flac', 'audio/x-flac': 'flac' }
const MODEL = /^[\w.:/@+-]{1,120}$/

/** The usual speech-to-text model at a provider's address, for an empty model field. */
export function suggestedModel(baseURL) {
  const url = String(baseURL ?? '')
  if (/siliconflow/i.test(url)) return 'FunAudioLLM/SenseVoiceSmall'
  if (/groq\.com/i.test(url)) return 'whisper-large-v3-turbo'
  if (/mistral\.ai/i.test(url)) return 'voxtral-mini-latest'
  if (/api\.openai\.com/i.test(url)) return 'gpt-4o-mini-transcribe'
  return 'whisper-1'
}

/** The voice input fields of a settings form or patch, over `value` (cleanMedia's). */
export function cleanListen(source, value) {
  if (LISTEN_SOURCES.includes(source.sttSource) || source.sttSource === '') value.sttSource = source.sttSource
  if (typeof source.sttProvider === 'string') value.sttProvider = source.sttProvider.trim().slice(0, 40)
  for (const key of ['sttModel', 'sttLocalModel']) {
    if (typeof source[key] !== 'string') continue
    const model = source[key].trim()
    if (model && !MODEL.test(model)) throw httpError(400, msg`转写模型名不对（例如 whisper-1）`)
    value[key] = model
  }
  if (typeof source.sttUrl === 'string') {
    const url = source.sttUrl.trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw httpError(400, msg`本地转写服务地址不对：要以 http:// 或 https:// 开头`)
    value.sttUrl = url
  }
  if (typeof source.sttLanguage === 'string' && /^([a-z]{2,3})?$/.test(source.sttLanguage.trim())) value.sttLanguage = source.sttLanguage.trim()
  return value
}

/**
 * Words the transcriber should spell as the story does: the names in the chat.
 * Whisper writes Mandarin in traditional or simplified characters as its prompt
 * does, so a Chinese one leads with a simplified sentence.
 */
export function transcribePrompt(language, names = []) {
  const list = [...new Set(names.map(name => String(name ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, 8)
  const chinese = language === 'zh' || (!language && list.some(name => /[㐀-鿿]/.test(name)))
  // Sent to the transcriber, never shown: in the language it should write.
  if (chinese) return `以下是普通话的句子。${list.length ? `人名：${list.join('、')}。` : ''}` // i18n-ignore: a prompt for the transcriber
  return list.join(', ')
}

/** A multipart/form-data body: strings, and { buffer, filename, type } for a file. */
export function multipart(fields) {
  const boundary = `----agent-tavern-${newId()}`
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    if (Buffer.isBuffer(value.buffer)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.type}\r\n\r\n`))
      parts.push(value.buffer, Buffer.from('\r\n'))
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, buffer: Buffer.concat(parts) }
}

/** The recording as sent by the page (base64 + its type) → { buffer, type, filename }. */
export function readAudio(data, type) {
  const mime = String(type ?? '').split(';')[0].trim().toLowerCase()
  const ext = AUDIO_FILE[mime]
  if (!ext) throw httpError(400, msg`不认识的录音格式：${mime.slice(0, 40) || msg`（没写）`}`)
  if (typeof data !== 'string' || !data) throw httpError(400, msg`没有收到录音`)
  if (data.length > Math.ceil(MAX_AUDIO / 3) * 4) throw httpError(413, msg`录音太大了：一次最多 25 MB`)
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length < 64) throw httpError(400, msg`录音是空的`)
  return { buffer, type: mime, filename: `speech.${ext}` }
}

/** The service's answer → plain text: JSON { text }, or the text itself; SenseVoice's <|tags|> dropped. */
export function transcriptText({ contentType = '', buffer }) {
  const raw = buffer.toString('utf8')
  let text = raw
  if (/json/i.test(contentType) || /^\s*\{/.test(raw)) {
    try {
      text = JSON.parse(raw).text
    } catch {
      throw new Error(msg`转写服务返回的不是 JSON`)
    }
    if (typeof text !== 'string') throw new Error(msg`转写服务的回答里没有 text`)
  }
  return text.replace(/<\|[^|>]{0,40}\|>/g, '').replace(/\s+/g, ' ').trim()
}

/** The local service's address for a recording: as written when it names its path, else + /audio/transcriptions. */
export function localEndpoint(url) {
  const base = String(url ?? '').replace(/\/+$/, '')
  return /\/(audio\/transcriptions|inference)$/i.test(base) ? base : `${base}/audio/transcriptions`
}

const transcribes = provider => Boolean(provider) && provider.api !== 'anthropic-messages'

/**
 * @param providers - async () → providers.json, keys included.
 * @param proxy - () → the app's proxy now.
 */
export function createListen({ providers, proxy = () => null }) {
  /**
   * POST the recording; a service that refuses the optional fields (language,
   * prompt) with 400 or 422 is asked again with the file and model alone.
   */
  async function post(provider, suffix, { audio, model, language, prompt }, signal) {
    const fields = { file: audio, model, language, prompt }
    const send = body => providerRequest(provider, suffix, { body: multipart(body), signal, proxy: proxy() })
    try {
      return await send(fields)
    } catch (error) {
      if (signal?.aborted || ![400, 422].includes(error.providerStatus) || (!language && !prompt)) throw error
      return send({ file: audio, model })
    }
  }

  /**
   * The text of one recording. `media` is the settings to use (the saved ones,
   * or the form's for 试一试); `names` are the chat's names, a spelling hint.
   * → { text, by } (by: the service, for the page to say where it went).
   */
  async function transcribe({ media, audio, names = [] }, signal) {
    const language = media.sttLanguage || ''
    const prompt = transcribePrompt(language, names)
    if (media.sttSource === 'browser') throw httpError(400, msg`浏览器识别在页面里进行，不经过服务端`)
    if (media.sttSource === 'local') {
      if (!media.sttUrl) throw httpError(400, msg`还没填本地转写服务的地址：在「配图与朗读 → 语音输入」里填`)
      const url = localEndpoint(media.sttUrl)
      const local = { name: msg`本地转写服务`, baseURL: url, api: 'openai-completions', apiKey: '', headers: {}, proxy: 'direct' }
      let result
      try {
        result = await post(local, '', { audio, model: media.sttLocalModel, language, prompt }, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        if (error.providerStatus === 404) throw httpError(502, msg`本地转写服务没有 ${new URL(url).pathname} 这个接口：OpenAI 兼容的服务填到 /v1，whisper.cpp 填到 /inference`)
        if (error.providerStatus) throw httpError(502, msg`本地转写服务出错：${String(error.message).slice(0, 200)}`)
        throw httpError(502, msg`连不上本地转写服务 ${media.sttUrl}：确认它开着、地址和端口没写错（${String(error.message).slice(0, 120)}）`)
      }
      return { text: transcriptText(result), by: new URL(url).host }
    }
    if (media.sttSource !== 'provider') throw httpError(400, msg`还没选语音输入用什么转写：在「配图与朗读 → 语音输入」里选`)
    const provider = (await providers()).find(p => p.id === media.sttProvider)
    if (!provider) throw httpError(400, media.sttProvider ? msg`语音输入选的供应商已经删除：在「配图与朗读 → 语音输入」里重新选` : msg`语音输入还没选供应商：在「配图与朗读 → 语音输入」里选`)
    if (!transcribes(provider)) throw httpError(400, msg`${provider.name} 是 Anthropic 接口，没有语音转写接口`)
    const model = media.sttModel || suggestedModel(provider.baseURL)
    let result
    try {
      result = await post(provider, '/audio/transcriptions', { audio, model, language, prompt }, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      const hint = error.providerStatus === 404 ? msg`（这个供应商可能没有 /audio/transcriptions 语音转写接口，或者模型名 ${model} 不对）` : ''
      throw httpError(502, `${providerError(provider, error)}${hint}`)
    }
    try {
      return { text: transcriptText(result), by: provider.name }
    } catch (error) {
      throw httpError(502, msg`${provider.name}：${error.message}`)
    }
  }

  return { transcribe }
}
