// Cloud speech services called with the user's own key: Fish Audio and
// MiniMax. requestSpec() and listAccountVoices() are ported from xiaoya-voice's
// bridge/cloud_tts.py (request_spec / unpack_audio / list_account_voices):
// service → URL, headers, body, never falling back to another service or
// voice. Both are asked for MP3, which a phone on the LAN fetches faster than
// WAV. The audio helpers below are shared by every server-side source: what
// kind of audio came back, and a WAV header for raw PCM.
import { fetchBytes, postJson } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { msg } from '../i18n.mjs'

export const FISH_URL = 'https://api.fish.audio'
// 国内站 / 国际站: a key works on the site it was made on only.
export const MINIMAX_URLS = Object.freeze({ cn: 'https://api.minimaxi.com', intl: 'https://api.minimax.io' })

// Fish answers an unknown model with its default one instead of an error: only these are sent.
export const FISH_MODELS = ['drama-3', 's2.1-pro', 's2.1-pro-free', 's2-pro']
// The one Fish model that is free (fair use); the others bill the account, which answers 402 when it is empty.
export const FISH_FREE_MODEL = 's2.1-pro-free'
export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd']
// MiniMax's system voices, offered while no voice of the account is listed.
// Names are getters: in the language of the page that asks (server/i18n.mjs).
export const MINIMAX_VOICES = Object.freeze([
  ['female-shaonv', () => msg`少女`],
  ['female-yujie', () => msg`御姐`],
  ['female-chengshu', () => msg`成熟女性`],
  ['female-tianmei', () => msg`甜美女性`],
  ['male-qn-qingse', () => msg`青涩青年`],
  ['male-qn-jingying', () => msg`精英青年`],
  ['male-qn-badao', () => msg`霸道青年`],
  ['male-qn-daxuesheng', () => msg`青年大学生`],
].map(([id, name]) => Object.freeze({ id, get name() { return name() } })))

export const CLOUD = Object.freeze({
  fish: { label: 'Fish Audio', emotion: 'tags', chunkMax: 250 },
  minimax: { label: 'MiniMax', emotion: 'none', chunkMax: 300 },
})

const minimaxBase = (region, urls) => urls.minimax?.[region] ?? MINIMAX_URLS[region] ?? MINIMAX_URLS.cn

/**
 * The request for one piece of speech.
 * @param config - { service, key, model, voice, region, urls }; urls overrides the
 *   services' addresses (tests point them at a fake server).
 */
export function requestSpec({ service, key, model, voice, region = 'cn', urls = {} }, text) {
  if (!key) throw httpError(400, msg`${CLOUD[service]?.label ?? service} 还没填密钥：在「配图与朗读 → 朗读」里填`)
  if (!voice || !model) throw httpError(400, msg`还没选模型或音色`)
  if (service === 'fish') {
    if (!FISH_MODELS.includes(model)) throw httpError(400, msg`Fish 不认模型 ${model}：只能选 ${FISH_MODELS.join(' / ')}`)
    return {
      url: `${urls.fish ?? FISH_URL}/v1/tts`,
      headers: { authorization: `Bearer ${key}`, model },
      // Fish acts on bracketed delivery tags ([害羞地小声]) from where they stand.
      body: { text, reference_id: voice, format: 'mp3', mp3_bitrate: 128, latency: 'normal' },
    }
  }
  if (service === 'minimax') {
    return {
      url: `${minimaxBase(region, urls)}/v1/t2a_v2`,
      headers: { authorization: `Bearer ${key}` },
      body: {
        model,
        text,
        stream: false,
        output_format: 'hex',
        language_boost: 'auto',
        voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      },
    }
  }
  throw httpError(400, msg`不认识的语音服务：${service}`)
}

const minimaxCodes = () => ({
  1002: msg`限流，稍后再试`,
  1004: msg`密钥不对，或者和站点（国内站 / 国际站）不一致`,
  1008: msg`余额不足`,
  1039: msg`限流，稍后再试`,
  2013: msg`参数不对：检查模型和音色 ID`,
})

function parseReply(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error(msg`${label} 返回的不是 JSON`)
  }
}

/** MiniMax answers 200 with a status of its own, which may be an error. */
function checkMinimax(json) {
  const status = json?.base_resp ?? {}
  if (status.status_code) throw new Error(msg`MiniMax 错误 ${status.status_code}：${minimaxCodes()[status.status_code] ?? String(status.status_msg ?? '').slice(0, 120)}`)
}

/** The audio in a service's answer. MiniMax sends JSON with the audio as hex, and a status that may be an error. */
export function unpack(service, payload) {
  if (service !== 'minimax') return payload
  const json = parseReply(payload, 'MiniMax')
  checkMinimax(json)
  const hex = json?.data?.audio
  if (typeof hex !== 'string' || !hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(msg`MiniMax 没有返回音频：检查音色 ID 和额度`)
  return Buffer.from(hex, 'hex')
}

const FISH_PAGE = 100
// How long a cloud request may take. A connection that stalls (a site blocked
// from where the user is, a dead proxy node) would otherwise wait for the
// socket's ten-minute idle limit, with 从账户读取音色 or 试听 spinning all the
// while. A voice list comes back in about a second; a piece of speech (up to
// 300 characters, then the MP3) in well under half a minute.
export const TIMEOUTS = Object.freeze({ list: 20_000, speech: 60_000 })

/** How a request travels: 'proxy', 'direct' (no proxy set) or 'home' (MiniMax's mainland site, direct on purpose). */
const routeOf = (service, region, proxy) => (proxy ? 'proxy' : service === 'minimax' && region === 'cn' ? 'home' : 'direct')

/** Where to look when a service cannot be reached. proxyMenu: this app has 设置 → 网络代理 (the phone does not). */
function reachHint(route, proxyMenu = true) {
  if (route === 'proxy') return msg`检查网络，以及「设置 → 网络代理」里的代理是否在运行。`
  if (route === 'home') return msg`检查网络。`
  if (route === 'direct' && proxyMenu) return msg`现在没走代理：要开代理才能上这个网站的话，去「设置 → 网络代理」选「跟随系统代理」或填代理地址。`
  return msg`检查网络和代理设置。`
}

/**
 * run(signal) with a deadline: the caller's signal still cancels it; past the
 * deadline the error carries `timedOut` (ms) for cloudError.
 */
async function bounded(ms, signal, run) {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), ms)
  const cancel = () => deadline.abort()
  if (signal?.aborted) cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await run(deadline.signal)
  } catch (error) {
    if (deadline.signal.aborted && !signal?.aborted) error.timedOut = ms
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * The account's own voices as [{ id, name }]: the ones cloned or designed on
 * it, not the service's system voices. Fish lists them a page at a time.
 * @param config - { service, key, region, urls } as for requestSpec().
 * @param options - proxy, signal; timeoutMs for the whole list; proxyMenu as for reachHint.
 */
export async function listAccountVoices({ service, key, region = 'cn', urls = {} }, { proxy = null, signal, timeoutMs = TIMEOUTS.list, proxyMenu = true } = {}) {
  const label = CLOUD[service]?.label
  if (!label) throw httpError(400, msg`不认识的语音服务：${service}`)
  if (!key) throw httpError(400, msg`${label} 还没填密钥：在「配图与朗读 → 朗读」里填`)
  const found = []
  const list = async bound => {
    const options = { headers: { authorization: `Bearer ${key}` }, proxy, signal: bound }
    if (service === 'fish') {
      for (let page = 1; page <= 20; page++) {
        const { buffer } = await fetchBytes(`${urls.fish ?? FISH_URL}/model?self=true&page_size=${FISH_PAGE}&page_number=${page}`, options)
        const json = parseReply(buffer, label)
        const items = Array.isArray(json?.items) ? json.items : []
        for (const model of items) {
          if (!model?._id) continue
          const unready = (model.state ?? 'trained') === 'trained' ? '' : msg`（未训练完）`
          found.push({ id: String(model._id), name: `${String(model.title ?? '').trim().slice(0, 30)}${unready}` })
        }
        if (items.length < FISH_PAGE || json.has_more === false) break
      }
      return
    }
    const { buffer } = await postJson(`${minimaxBase(region, urls)}/v1/get_voice`, { voice_type: 'all' }, options)
    const json = parseReply(buffer, label)
    checkMinimax(json)
    for (const [group, kind] of [['voice_cloning', msg`复刻`], ['voice_generation', msg`设计`]]) {
      for (const voice of Array.isArray(json[group]) ? json[group] : []) {
        if (voice?.voice_id) found.push({ id: String(voice.voice_id), name: voice.voice_name ? msg`${String(voice.voice_name).trim().slice(0, 30)}（${kind}）` : kind })
      }
    }
  }
  try {
    await bounded(timeoutMs, signal, list)
  } catch (error) {
    if (signal?.aborted) throw error
    throw cloudFailure(label, error, key, { route: routeOf(service, region, proxy), proxyMenu })
  }
  return found
}

const statusText = () => ({ 400: msg`请求参数或音色不匹配`, 401: msg`密钥无效或已过期`, 402: msg`额度不足`, 403: msg`没有权限`, 404: msg`模型或音色不存在`, 429: msg`限流或额度不足` })
// Node's codes and messages for a connection that failed; a reset during the TLS handshake says only the latter.
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|secure TLS connection|请求超时/i

/**
 * What went wrong, with the key taken out of anything the service echoed back.
 * @param options - { route, proxyMenu }: where to look when it cannot be reached (reachHint).
 */
export function cloudError(label, error, key, { route = '', proxyMenu = true } = {}) {
  const status = error?.providerStatus
  const raw = String(error?.message ?? error)
  const text = (key ? raw.split(key).join(msg`[密钥已隐藏]`) : raw).replace(/^\d{3} /, '').slice(0, 160)
  if (error?.timedOut) return msg`连不上 ${label}：等了 ${Math.ceil(error.timedOut / 1000)} 秒没有回应。${reachHint(route, proxyMenu)}`
  if (status) return msg`${label} HTTP ${status}：${statusText()[status] ?? msg`服务暂时异常`}${text ? msg`（${text}）` : ''}`
  if (UNREACHABLE.test(`${error?.code ?? ''} ${raw}`)) return msg`连不上 ${label}：${reachHint(route, proxyMenu)}`
  return msg`${label}：${text}`
}

/** cloudError as the error to throw: 504 when the service never answered, else 502. */
const cloudFailure = (label, error, key, options) => httpError(error?.timedOut ? 504 : 502, cloudError(label, error, key, options))

// ─── Audio ──────────────────────────────────────────────────────────────

export const AUDIO_EXT = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac' })
const TYPE_ALIASES = { 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/opus': 'audio/ogg' }

/** The type a container header names (WAV, ID3, Ogg, FLAC), or null: what bare frame bytes cannot be mistaken for. */
function containerType(buffer) {
  const head = buffer.subarray(0, 12)
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav'
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  if (head.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac'
  return null
}

/** The audio type from the bytes, else from the Content-Type; null when neither says. */
export function audioType(buffer, contentType = '') {
  const head = buffer.subarray(0, 12)
  const container = containerType(buffer)
  if (container) return container
  // A frame sync: MPEG audio has a layer, ADTS (AAC) has layer 0.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return (head[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg'
  const type = String(contentType).split(';')[0].trim().toLowerCase()
  const known = TYPE_ALIASES[type] ?? type
  return AUDIO_EXT[known] ? known : null
}

/** 16-bit little-endian PCM with a WAV header, so a browser can play it. */
export function wavFromPcm(pcm, rate = 24000, channels = 1) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const PCM_TYPE = /^audio\/(pcm|l16|x-pcm|raw)\b/i

/**
 * { buffer, mime } for audio a service sent. Raw PCM (said by the Content-Type,
 * e.g. audio/L16;rate=24000, or expected with pcmRate) gets a WAV header.
 * @param fallback - the type when nothing says (a voice service that answers WAV by protocol).
 */
export function audioOf(buffer, { contentType = '', pcmRate = 0, fallback = '' } = {}) {
  if (!buffer?.length) throw new Error(msg`返回的音频是空的`)
  const declared = String(contentType)
  // Said or expected to be raw PCM: only a container header says otherwise. Its first sample can look like an
  // MPEG frame sync (FF Fx), which was taken for MP3 and played as noise, with no WAV header.
  if (!containerType(buffer) && (PCM_TYPE.test(declared) || pcmRate)) {
    const rate = Number(/rate=(\d+)/i.exec(declared)?.[1]) || pcmRate || 24000
    const channels = Number(/channels=(\d)/i.exec(declared)?.[1]) || 1
    return { buffer: wavFromPcm(buffer, rate, channels), mime: 'audio/wav' }
  }
  const mime = audioType(buffer) ?? audioType(Buffer.alloc(0), declared) ?? fallback
  if (!mime) {
    // A JSON error with a 200 status is the usual reason.
    const text = buffer.subarray(0, 200).toString('utf8')
    throw new Error(/^\s*[{[]/.test(text) ? msg`返回的不是音频：${text.replace(/\s+/g, ' ').slice(0, 160)}` : msg`返回的不是认得的音频格式`)
  }
  return { buffer, mime }
}

// ─── Source ─────────────────────────────────────────────────────────────

/**
 * A cloud service as a voice source (voice/index.mjs). Voices are the IDs
 * listed in 配图与朗读 (fishVoices / minimaxVoices); MiniMax offers its system
 * voices while none are listed.
 * @param urls - test addresses: { fish, minimax: { cn, intl } }.
 * @param proxyMenu - this app has 设置 → 网络代理 to point to when a service cannot be reached.
 * @param timeouts - { list, speech } in ms (TIMEOUTS; tests shorten them).
 */
export function createCloudSource(service, { urls = {}, proxyMenu = true, timeouts = TIMEOUTS } = {}) {
  const { label, emotion, chunkMax } = CLOUD[service]
  const settingsOf = media => (service === 'fish'
    ? { model: media.fishModel, voices: media.fishVoices ?? [], region: '' }
    : { model: media.minimaxModel, voices: media.minimaxVoices?.length ? media.minimaxVoices : MINIMAX_VOICES, region: media.minimaxRegion })
  // Fish and MiniMax's international site are abroad; MiniMax's mainland site is reached directly.
  const via = (region, proxy) => (service === 'minimax' && region === 'cn' ? null : proxy())
  return {
    id: service,
    label,
    chunkMax,
    emotion: () => emotion,
    model: media => settingsOf(media).model,
    configured: ({ keys }) => Boolean(keys[service]),
    /** The voices offered now: [{ id, name }]. */
    listed: media => settingsOf(media).voices,
    list({ media }) {
      return settingsOf(media).voices.map(v => ({ ref: `${service}:${v.id}`, label: v.name ? `${v.name} · ${v.id.slice(0, 8)}` : v.id }))
    },
    /** The voice id from the part of a reference after `fish:`. */
    target: rest => (rest ? { voice: rest } : null),
    async synth({ voice, text }, { media, keys, proxy, signal }) {
      const { model, region } = settingsOf(media)
      const key = keys[service]
      const spec = requestSpec({ service, key, model, voice, region, urls }, text)
      const through = via(region, proxy)
      let result
      try {
        result = await bounded(timeouts.speech, signal, bound => postJson(spec.url, spec.body, { headers: spec.headers, signal: bound, proxy: through }))
      } catch (error) {
        if (signal?.aborted) throw error
        if (service === 'fish' && error?.providerStatus === 402 && model !== FISH_FREE_MODEL) {
          throw httpError(502, msg`Fish Audio 余额不足（HTTP 402）：${model} 按用量计费。去 fish.audio 充值，或在「配图与朗读 → 朗读来源 → Fish Audio」把模型换成 ${FISH_FREE_MODEL}（免费）。`)
        }
        throw cloudFailure(label, error, key, { route: routeOf(service, region, through), proxyMenu })
      }
      try {
        return audioOf(unpack(service, result.buffer), { contentType: result.contentType })
      } catch (error) {
        throw httpError(502, cloudError(label, error, key))
      }
    },
    /** The account's own voices (listAccountVoices), with the key in `keys`. */
    account({ media, keys, proxy, signal }) {
      const { region } = settingsOf(media)
      return listAccountVoices({ service, key: keys[service], region, urls }, { proxy: via(region, proxy), signal, proxyMenu, timeoutMs: timeouts.list })
    },
  }
}
