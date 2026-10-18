// An external voice service speaking the xiaoya bridge's protocol: POST
// /api/tts {text, voice} → audio, GET /api/persona/list → its voices. That is
// the xiaoya bridge on this machine's own install, or another Agent Tavern
// that has voices (the phone edition reading through the PC's tavern on the
// same Wi-Fi). Voice names are the service's own: no prefix, or `bridge:`.
// Moved from media.mjs unchanged.
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchBytes, postJson } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { msg } from '../i18n.mjs'

/**
 * @param root - the data folder (tts-key.json).
 * @param features - the edition's capabilities: whether the xiaoya bridge is assumed.
 */
export function createBridge({ root, features = null }) {
  // A tavern in LAN mode wants its access key: kept in its own file like the
  // NovelAI token, so /api/settings and the page never carry it.
  const ttsKeyFile = path.join(root, 'tts-key.json')

  async function ttsKey() {
    try {
      return String(JSON.parse(await readFile(ttsKeyFile, 'utf8')).key ?? '')
    } catch {
      return ''
    }
  }

  /** What the page may know about the key. */
  async function ttsKeyStatus() {
    const key = await ttsKey()
    return { hasKey: Boolean(key), keyHint: key ? `…${key.slice(-4)}` : '' }
  }

  /** Save a key; '' removes it. */
  async function setTtsKey(value) {
    const key = String(value ?? '').trim()
    if (!key) await rm(ttsKeyFile, { force: true })
    else {
      if (!/^[\w-]{8,200}$/.test(key)) throw httpError(400, msg`访问口令不对：把电脑上酒馆「局域网访问」里的链接整条粘贴过来`)
      await writeFile(ttsKeyFile, JSON.stringify({ key }), 'utf8')
    }
    return ttsKeyStatus()
  }

  async function ttsHeaders() {
    const key = await ttsKey()
    return key ? { 'x-agent-tavern': '1', 'x-agent-tavern-key': key } : { 'x-agent-tavern': '1' }
  }

  const isLocalUrl = url => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(url)

  /** Why the local voice bridge did not answer, in words that say what to do. */
  function voiceTrouble(media, error) {
    const message = String(error?.message ?? error)
    const down = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout|aborted/i.test(message)
    // Only a tavern asks for a key (401 no or wrong key, 403 an address it does not serve).
    if (/^40[13]\b/.test(message)) return msg`电脑上的酒馆不让访问：把它「手机访问」里的链接整条粘贴到「桥接地址」（链接里带着口令）`
    if (isLocalUrl(media.ttsUrl)) {
      if (!down) return msg`本地语音桥接：${message.replace(/^\d{3} /, '').slice(0, 200)}`
      return features?.xiaoya === false ? msg`本地语音桥接（${media.ttsUrl}）没开` : msg`本地语音桥接（小雅）没开：先运行「小雅一键启动」（或只启动语音桥接）`
    }
    if (down) return msg`连不上 ${media.ttsUrl}：电脑上的酒馆开着吗？手机和电脑在同一个 Wi-Fi 吗？`
    return msg`本地语音桥接（${media.ttsUrl}）：${message.replace(/^\d{3} /, '').slice(0, 200)}`
  }

  /**
   * The service's voice list: its own voices, plus cloud voices it can call by
   * name (fish:<id>, billed per character). Another tavern also says how long
   * a piece each of its voices takes (chunkMax).
   */
  async function voiceList(media, timeout) {
    const json = JSON.parse((await fetchBytes(`${media.ttsUrl}/api/persona/list`, { headers: await ttsHeaders(), signal: AbortSignal.timeout(timeout) })).buffer.toString('utf8'))
    const cloud = (Array.isArray(json.cloud_voices) ? json.cloud_voices : [])
      .filter(v => typeof v?.name === 'string' && v.name.includes(':'))
      .map(v => ({
        name: v.name,
        label: String(v.label || v.name),
        provider: String(v.provider || ''),
        model: String(v.model || ''),
        tags: v.tags === true,
        ...(Number.isInteger(v.chunkMax) && v.chunkMax >= 20 && v.chunkMax <= 500 ? { chunkMax: v.chunkMax } : {}),
      }))
    return {
      voices: (json.voices ?? []).map(v => (typeof v === 'string' ? v : v.name)).filter(Boolean),
      cloud,
      current: json.current?.voice ?? null,
      remote: json.via === 'agent-tavern',
    }
  }

  // What synthesis needs to know about the service, asked at most every 10 s:
  // its current voice (cards that use it: switching it there must not replay
  // audio cached under the old one), its cloud voices (their model goes into
  // the cache key; only some act on [emotion] tags) and every name it lists
  // (those go to it even when they look like fish:<id>).
  let serviceInfo = { at: 0, current: '', cloud: new Map(), names: new Set() }
  async function voiceService(media) {
    if (!media.ttsUrl) return { at: 0, current: '', cloud: new Map(), names: new Set() }
    if (Date.now() - serviceInfo.at < 10_000 && serviceInfo.url === media.ttsUrl) return serviceInfo
    let info = { current: '', cloud: new Map(), names: new Set() }
    try {
      const list = await voiceList(media, 2000)
      info = { current: String(list.current ?? ''), cloud: new Map(list.cloud.map(v => [v.name, v])), names: new Set([...list.voices, ...list.cloud.map(v => v.name)]) }
    } catch {
      // service not answering: synthesis reports it
    }
    serviceInfo = { at: Date.now(), url: media.ttsUrl, ...info }
    return serviceInfo
  }

  return {
    id: 'bridge',
    // A getter: in the language of the page that asks (server/i18n.mjs).
    get label() {
      return msg`本地语音桥接`
    },
    // Tuned for the xiaoya bridge's Qwen3 voices: each call starts its own intonation.
    chunkMax: 100,
    ttsKeyStatus,
    setTtsKey,
    voiceTrouble,
    voiceList,
    voiceService,
    configured: ({ media }) => Boolean(media.ttsUrl),
    /**
     * A voice of the service: how it is spoken and cached. A card on the
     * service's current voice (no name) is keyed by that voice.
     */
    async target(name, media) {
      const service = await voiceService(media)
      const cloud = name ? service.cloud.get(name) : null
      return {
        voice: name,
        // Only voices that act on delivery tags get them; the rest would read them out.
        emotion: cloud?.tags ? 'tags' : 'none',
        speaker: name ? `${name}${cloud?.model ? `#${cloud.model}` : ''}` : `@${service.current}`,
      }
    },
    /**
     * The service stops synthesising when this request is aborted (the client
     * pressed stop). fresh: passed on, so a tavern in between skips its cache too.
     */
    async synth({ voice, text, stable, fresh }, { media, signal }) {
      let result
      try {
        result = await postJson(`${media.ttsUrl}/api/tts`, { text, ...(voice ? { voice } : {}), stable: Boolean(stable), ...(fresh ? { fresh: true } : {}) }, { signal, headers: await ttsHeaders() })
      } catch (error) {
        if (signal?.aborted) throw error
        throw httpError(502, voiceTrouble(media, error))
      }
      return { buffer: result.buffer, contentType: result.contentType }
    },
  }
}
