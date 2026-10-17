// Cloud speech services called with the user's own key: Fish Audio and
// MiniMax. requestSpec() and listAccountVoices() are ported from xiaoya-voice's
// bridge/cloud_tts.py (request_spec / unpack_audio / list_account_voices):
// service → URL, headers, body, never falling back to another service or
// voice. Both are asked for MP3, which a phone on the LAN fetches faster than
// WAV. The audio helpers below are shared by every server-side source: what
// kind of audio came back, and a WAV header for raw PCM.
import { fetchBytes, postJson } from '../providers.mjs'
import { httpError } from '../store.mjs'

export const FISH_URL = 'https://api.fish.audio'
// 国内站 / 国际站: a key works on the site it was made on only.
export const MINIMAX_URLS = Object.freeze({ cn: 'https://api.minimaxi.com', intl: 'https://api.minimax.io' })

// Fish answers an unknown model with its default one instead of an error: only these are sent.
export const FISH_MODELS = ['drama-3', 's2.1-pro', 's2.1-pro-free', 's2-pro']
export const MINIMAX_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd']
// MiniMax's system voices, offered while no voice of the account is listed.
export const MINIMAX_VOICES = Object.freeze([
  ['female-shaonv', '少女'],
  ['female-yujie', '御姐'],
  ['female-chengshu', '成熟女性'],
  ['female-tianmei', '甜美女性'],
  ['male-qn-qingse', '青涩青年'],
  ['male-qn-jingying', '精英青年'],
  ['male-qn-badao', '霸道青年'],
  ['male-qn-daxuesheng', '青年大学生'],
].map(([id, name]) => Object.freeze({ id, name })))

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
  if (!key) throw httpError(400, `${CLOUD[service]?.label ?? service} 还没填密钥：在「配图与朗读 → 朗读」里填`)
  if (!voice || !model) throw httpError(400, '还没选模型或音色')
  if (service === 'fish') {
    if (!FISH_MODELS.includes(model)) throw httpError(400, `Fish 不认模型 ${model}：只能选 ${FISH_MODELS.join(' / ')}`)
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
  throw httpError(400, `不认识的语音服务：${service}`)
}

const MINIMAX_CODES = {
  1002: '限流，稍后再试',
  1004: '密钥不对，或者和站点（国内站 / 国际站）不一致',
  1008: '余额不足',
  1039: '限流，稍后再试',
  2013: '参数不对：检查模型和音色 ID',
}

function parseReply(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new Error(`${label} 返回的不是 JSON`)
  }
}

/** MiniMax answers 200 with a status of its own, which may be an error. */
function checkMinimax(json) {
  const status = json?.base_resp ?? {}
  if (status.status_code) throw new Error(`MiniMax 错误 ${status.status_code}：${MINIMAX_CODES[status.status_code] ?? String(status.status_msg ?? '').slice(0, 120)}`)
}

/** The audio in a service's answer. MiniMax sends JSON with the audio as hex, and a status that may be an error. */
export function unpack(service, payload) {
  if (service !== 'minimax') return payload
  const json = parseReply(payload, 'MiniMax')
  checkMinimax(json)
  const hex = json?.data?.audio
  if (typeof hex !== 'string' || !hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 没有返回音频：检查音色 ID 和额度')
  return Buffer.from(hex, 'hex')
}

const FISH_PAGE = 100

/**
 * The account's own voices as [{ id, name }]: the ones cloned or designed on
 * it, not the service's system voices. Fish lists them a page at a time.
 * @param config - { service, key, region, urls } as for requestSpec().
 */
export async function listAccountVoices({ service, key, region = 'cn', urls = {} }, { proxy = null, signal } = {}) {
  const label = CLOUD[service]?.label
  if (!label) throw httpError(400, `不认识的语音服务：${service}`)
  if (!key) throw httpError(400, `${label} 还没填密钥：在「配图与朗读 → 朗读」里填`)
  const headers = { authorization: `Bearer ${key}` }
  const found = []
  try {
    if (service === 'fish') {
      for (let page = 1; page <= 20; page++) {
        const { buffer } = await fetchBytes(`${urls.fish ?? FISH_URL}/model?self=true&page_size=${FISH_PAGE}&page_number=${page}`, { headers, proxy, signal })
        const json = parseReply(buffer, label)
        const items = Array.isArray(json?.items) ? json.items : []
        for (const model of items) {
          if (!model?._id) continue
          const unready = (model.state ?? 'trained') === 'trained' ? '' : '（未训练完）'
          found.push({ id: String(model._id), name: `${String(model.title ?? '').trim().slice(0, 30)}${unready}` })
        }
        if (items.length < FISH_PAGE || json.has_more === false) break
      }
    } else {
      const { buffer } = await postJson(`${minimaxBase(region, urls)}/v1/get_voice`, { voice_type: 'all' }, { headers, proxy, signal })
      const json = parseReply(buffer, label)
      checkMinimax(json)
      for (const [group, kind] of [['voice_cloning', '复刻'], ['voice_generation', '设计']]) {
        for (const voice of Array.isArray(json[group]) ? json[group] : []) {
          if (voice?.voice_id) found.push({ id: String(voice.voice_id), name: voice.voice_name ? `${String(voice.voice_name).trim().slice(0, 30)}（${kind}）` : kind })
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    throw httpError(502, cloudError(label, error, key))
  }
  return found
}

const STATUS_TEXT = { 400: '请求参数或音色不匹配', 401: '密钥无效或已过期', 402: '额度不足', 403: '没有权限', 404: '模型或音色不存在', 429: '限流或额度不足' }

/** What went wrong, with the key taken out of anything the service echoed back. */
export function cloudError(label, error, key) {
  const status = error?.providerStatus
  const raw = String(error?.message ?? error)
  const text = (key ? raw.split(key).join('[密钥已隐藏]') : raw).replace(/^\d{3} /, '').slice(0, 160)
  if (status) return `${label} HTTP ${status}：${STATUS_TEXT[status] ?? '服务暂时异常'}${text ? `（${text}）` : ''}`
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|socket hang up|请求超时/i.test(raw)) return `连不上 ${label}：检查网络和代理设置。`
  return `${label}：${text}`
}

// ─── Audio ──────────────────────────────────────────────────────────────

export const AUDIO_EXT = Object.freeze({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac' })
const TYPE_ALIASES = { 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/opus': 'audio/ogg' }

/** The audio type from the bytes, else from the Content-Type; null when neither says. */
export function audioType(buffer, contentType = '') {
  const head = buffer.subarray(0, 12)
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav'
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  if (head.subarray(0, 4).toString('latin1') === 'fLaC') return 'audio/flac'
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
  if (!buffer?.length) throw new Error('返回的音频是空的')
  const sniffed = audioType(buffer)
  const declared = String(contentType)
  if (!sniffed && (PCM_TYPE.test(declared) || pcmRate)) {
    const rate = Number(/rate=(\d+)/i.exec(declared)?.[1]) || pcmRate || 24000
    const channels = Number(/channels=(\d)/i.exec(declared)?.[1]) || 1
    return { buffer: wavFromPcm(buffer, rate, channels), mime: 'audio/wav' }
  }
  const mime = sniffed ?? audioType(Buffer.alloc(0), declared) ?? fallback
  if (!mime) {
    // A JSON error with a 200 status is the usual reason.
    const text = buffer.subarray(0, 200).toString('utf8')
    throw new Error(/^\s*[{[]/.test(text) ? `返回的不是音频：${text.replace(/\s+/g, ' ').slice(0, 160)}` : '返回的不是认得的音频格式')
  }
  return { buffer, mime }
}

// ─── Source ─────────────────────────────────────────────────────────────

/**
 * A cloud service as a voice source (voice/index.mjs). Voices are the IDs
 * listed in 配图与朗读 (fishVoices / minimaxVoices); MiniMax offers its system
 * voices while none are listed.
 * @param urls - test addresses: { fish, minimax: { cn, intl } }.
 */
export function createCloudSource(service, { urls = {} } = {}) {
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
      let result
      try {
        result = await postJson(spec.url, spec.body, { headers: spec.headers, signal, proxy: via(region, proxy) })
      } catch (error) {
        if (signal?.aborted) throw error
        throw httpError(502, cloudError(label, error, key))
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
      return listAccountVoices({ service, key: keys[service], region, urls }, { proxy: via(region, proxy), signal })
    },
  }
}
