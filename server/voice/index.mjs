// Voice sources on the server. A card names a voice as `<source>:<id>`:
//   openai:<provider id>:<voice>  a provider's /audio/speech (openai.mjs)
//   fish:<reference_id>           Fish Audio (cloud.mjs)
//   minimax:<voice_id>            MiniMax (cloud.mjs)
//   bridge:<name>, or no prefix   an external voice service (bridge.mjs)
// browser:<name> is spoken by the page and never reaches the server.
// On this machine's own install the xiaoya bridge also calls cloud voices by
// name (fish:<id>): a name the voice service lists goes to it first, so cards
// keep sounding as they did; the tavern's own Fish key is used only for names
// the service does not list.
// Each source says how it treats the [emotion] tags speechChunks puts before a
// line: 'tags' keeps them, 'instruction' turns them into the request's
// instructions, 'none' drops them.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { httpError } from '../store.mjs'
import { createBridge } from './bridge.mjs'
import { AUDIO_EXT, audioOf, createCloudSource } from './cloud.mjs'
import { createOpenaiSource, instructionsFor } from './openai.mjs'

// Services whose key the tavern keeps (voice-keys.json); a provider's key stays in providers.json.
export const KEYED = ['fish', 'minimax']
const MAX_TEXT = 500
// [emotion] tags speechChunks puts before a line (from 小白X voice tags).
const DELIVERY_TAG = /\[([^\]\n]{1,40})\]\s*/g
const PREVIEW_TEXT = '你好呀，很高兴见到你。今天想听我讲点什么呢？'

/** The text to send and, for a source that takes them, the instructions. */
export function prepareText(text, emotion) {
  const raw = String(text ?? '')
  if (emotion === 'tags') return { text: raw.trim().slice(0, MAX_TEXT), instructions: '' }
  const tags = [...raw.matchAll(DELIVERY_TAG)].map(match => match[1].trim()).filter(Boolean)
  const clean = raw.replace(DELIVERY_TAG, '').trim().slice(0, MAX_TEXT)
  return { text: clean, instructions: emotion === 'instruction' ? instructionsFor(tags) : '' }
}

const FISH_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i
const VOICE_ID = /^[\w.:/@+-]{1,200}$/
const BARE_IDS = /^[\w.:/@+-]+(\s*[,，]\s*[\w.:/@+-]+)+$/

/** One listed voice: `<id> <name>`; for Fish, a voice page link (fish.audio/m/<id>) works too. */
function parseVoice(item, fish) {
  let text = typeof item === 'string' ? item.trim() : `${String(item?.id ?? '').trim()} ${String(item?.name ?? '').trim()}`.trim()
  if (!text) return null
  let id
  const fishId = fish ? FISH_ID.exec(text)?.[0] : null
  if (fishId) {
    id = fishId.toLowerCase()
    text = text.replace(/\S*fish\.audio\S*/i, '').replace(FISH_ID, '')
  } else {
    ;[, id, text] = /^(\S+)\s*(.*)$/s.exec(text)
  }
  if (!VOICE_ID.test(id)) throw httpError(400, `音色 ID「${id.slice(0, 60)}」不对：每行写一个音色，ID 在前，后面可以空一格写名字`)
  return { id, name: text.replace(/^[\s·|:：\-–—]+|[\s·|]+$/g, '').slice(0, 40) }
}

/**
 * The voices listed for a source: [{ id, name }] from the settings form's
 * lines (`<id> <name>`, or ids separated by commas on one line) or a saved list.
 */
export function cleanVoiceList(input, { fish = false } = {}) {
  const items = typeof input === 'string'
    ? input.split(/\r?\n/).flatMap(line => (BARE_IDS.test(line.trim()) ? line.split(/[,，]/) : [line]))
    : Array.isArray(input) ? input : []
  const seen = new Set()
  const out = []
  for (const item of items) {
    const voice = parseVoice(item, fish)
    if (!voice || seen.has(voice.id)) continue
    seen.add(voice.id)
    out.push(voice)
  }
  return out.slice(0, 100)
}

/** A pasted key: printable, no spaces; a leading "Bearer " is dropped. */
export function cleanVoiceKey(value) {
  const key = String(value ?? '').trim().replace(/^Bearer\s+/i, '')
  if (!/^[!-~]{8,4000}$/.test(key)) throw httpError(400, '密钥格式不对：只粘贴密钥本身，不要带空格或换行')
  return key
}

/**
 * @param root - the data folder: voice-keys.json, tts-key.json, media/tts/.
 * @param settings - async () → the media settings (media.mjs cleanMedia).
 * @param providers - async () → providers.json, keys included.
 * @param proxy - () → the app's proxy now (the setting can change while running).
 * @param urls - test addresses for the cloud services: { fish, minimax: { cn, intl } }.
 */
export function createVoices({ root, settings, providers, proxy = () => null, features = null, urls = {} }) {
  const bridge = createBridge({ root, features })
  const sources = [createOpenaiSource(), createCloudSource('fish', { urls }), createCloudSource('minimax', { urls })]
  const byId = new Map(sources.map(source => [source.id, source]))
  const ttsDir = path.join(root, 'media', 'tts')

  // The cloud services' keys live in their own file, so /api/settings and the page never carry them.
  const keyFile = path.join(root, 'voice-keys.json')

  async function readKeys() {
    try {
      const json = JSON.parse(await readFile(keyFile, 'utf8'))
      return Object.fromEntries(KEYED.filter(id => typeof json[id] === 'string' && json[id]).map(id => [id, json[id]]))
    } catch {
      return {}
    }
  }

  /** What the page may know about the keys: whether each is set, and its last four characters. */
  async function keyStatus() {
    const keys = await readKeys()
    return Object.fromEntries(KEYED.map(id => [id, { hasKey: Boolean(keys[id]), keyHint: keys[id] ? `…${keys[id].slice(-4)}` : '' }]))
  }

  /** Save a pasted key; '' removes it. */
  async function setKey(id, value) {
    if (!KEYED.includes(id)) throw httpError(400, `不认识的语音服务：${id}`)
    const keys = await readKeys()
    if (value === '') delete keys[id]
    else keys[id] = cleanVoiceKey(value)
    if (Object.keys(keys).length) await writeFile(keyFile, JSON.stringify(keys), 'utf8')
    else await rm(keyFile, { force: true })
    return keyStatus()
  }

  /** Everything a request needs; `draft` overrides settings and keys for 试听 before saving. */
  async function context(draft = {}) {
    const [media, list, keys] = await Promise.all([settings(), providers(), readKeys()])
    return { media: draft.media ?? media, providers: list, keys: { ...keys, ...(draft.keys ?? {}) }, proxy }
  }

  /**
   * Which source speaks a voice reference, and how: { source, voice, emotion,
   * speaker } plus what that source needs (the provider id).
   */
  async function route(ref, ctx) {
    const value = String(ref ?? '').trim()
    if (value.startsWith('browser:')) throw httpError(400, '浏览器音色在页面里朗读，不经过服务端')
    const viaBridge = async name => ({ source: bridge, ...(await bridge.target(name, ctx.media)) })
    const hasBridge = bridge.configured(ctx)
    // The service's own names first, prefixes and all (the xiaoya bridge's fish:<id>).
    if (hasBridge && (!value || (await bridge.voiceService(ctx.media)).names.has(value))) return viaBridge(value)
    if (value.startsWith('bridge:')) {
      if (!hasBridge) throw httpError(400, '这个音色属于本地语音桥接，还没填桥接地址')
      return viaBridge(value.slice('bridge:'.length))
    }
    const cut = value.indexOf(':')
    const source = cut > 0 ? byId.get(value.slice(0, cut)) : null
    const target = source?.target(value.slice(cut + 1))
    // A source the tavern has no key for: the voice service may still know the name (or say it is down).
    if (source && target && (source.configured(ctx) || source.id === 'openai' || !hasBridge)) {
      const model = source.model(ctx.media)
      return { source, ...target, emotion: source.emotion(ctx.media), speaker: `${source.id}|${model}|${value.slice(cut + 1)}` }
    }
    if (hasBridge) return viaBridge(value)
    if (!value) throw httpError(400, '这张卡没选音色，也没有本地语音桥接：在「配图与朗读」里给它选一个浏览器音色或云端音色')
    throw httpError(400, `认不出音色「${value}」：在「配图与朗读」里给这张卡重新选音色`)
  }

  /** One piece of speech, not cached. */
  async function synthesize(target, { text, instructions, stable, fresh }, ctx, signal) {
    const result = await target.source.synth({ ...target, text, instructions, stable, fresh }, { ...ctx, signal })
    if (target.source !== bridge) return result
    // The bridge protocol answers WAV; another tavern says what it relays.
    try {
      return audioOf(result.buffer, { contentType: result.contentType, fallback: 'audio/wav' })
    } catch (error) {
      throw httpError(502, `本地语音桥接：${error.message}`)
    }
  }

  const cacheFile = (key, mime) => path.join(ttsDir, `${key}.${AUDIO_EXT[mime] ?? 'bin'}`)

  async function cached(key) {
    for (const [mime, ext] of Object.entries(AUDIO_EXT)) {
      try {
        return { buffer: await readFile(path.join(ttsDir, `${key}.${ext}`)), mime }
      } catch {
        // not this type
      }
    }
    return null
  }

  async function keep(key, audio) {
    await mkdir(ttsDir, { recursive: true })
    // A take in another format would be found first next time.
    await Promise.all(Object.values(AUDIO_EXT).map(ext => rm(path.join(ttsDir, `${key}.${ext}`), { force: true })))
    await writeFile(cacheFile(key, audio.mime), audio.buffer)
  }

  /**
   * One chunk of speech as { buffer, mime }, from the cache or its source.
   * Cached by source + model + voice + text (the bridge keeps its old keys,
   * so audio read before stays). fresh: synthesise again and replace the
   * cached take.
   */
  async function speak({ text, voice, stable, fresh }, signal) {
    const ctx = await context()
    const target = await route(voice, ctx)
    const prepared = prepareText(text, target.emotion)
    if (!prepared.text) throw httpError(400, '没有要读的文字')
    // Only the bridge has a steady mode.
    const steady = target.source === bridge && stable ? 1 : 0
    const key = createHash('sha256')
      .update(`${target.speaker}\n${steady}\n${prepared.text}${prepared.instructions ? `\n${prepared.instructions}` : ''}`)
      .digest('hex')
      .slice(0, 32)
    if (!fresh) {
      const hit = await cached(key)
      if (hit) return hit
    }
    let audio
    try {
      audio = await synthesize(target, { ...prepared, stable: Boolean(stable), fresh: Boolean(fresh) }, ctx, signal)
    } catch (error) {
      if (signal?.aborted || target.source !== bridge || String(voice ?? '').trim()) throw error
      throw httpError(error.status ?? 502, noVoiceTrouble(error, ctx))
    }
    await keep(key, audio)
    return audio
  }

  /**
   * A card without a voice of its own reads with the voice service's current
   * voice. When that service fails, say so, and name voices that would work.
   */
  function noVoiceTrouble(error, ctx) {
    // Up to two voices from each source that is set up.
    const ready = sources.filter(source => source.configured(ctx)).flatMap(source => source.list(ctx).slice(0, 2).map(v => `${source.label}「${v.label.split(' · ')[0]}」`))
    const pick = ready.length ? `给这张卡选一个音色（可用：${ready.join('、')}）` : '给这张卡选一个音色'
    return `这张卡还没选对白音色，默认用本地语音桥接当前的音色，可是${error.message.replace(/[。.]$/, '')}。在「配图与朗读」里${pick}，就不用本地语音桥接了。`
  }

  /**
   * 试听: a voice with the settings as the form shows them (not saved yet),
   * never cached. `draft` is { media, keys } with the typed values. Without a
   * voice, `source` names a source and its first voice is used.
   */
  async function preview({ voice, source: sourceId = '', text, draft }, signal) {
    const ctx = await context(draft)
    let ref = String(voice ?? '')
    if (!ref && sourceId) {
      const source = byId.get(sourceId)
      if (!source) throw httpError(400, `不认识的语音来源：${sourceId}`)
      if (!source.configured(ctx)) throw httpError(400, source.id === 'openai' ? '先选一个供应商并填模型' : `${source.label} 还没填密钥`)
      ref = source.list(ctx)[0]?.ref ?? ''
      if (!ref) throw httpError(400, `${source.label} 还没列音色：在音色框里至少写一个`)
    }
    const target = await route(ref, ctx)
    const prepared = prepareText(String(text ?? '').trim() || PREVIEW_TEXT, target.emotion)
    return synthesize(target, { ...prepared, stable: false, fresh: true }, ctx, signal)
  }

  /**
   * 从账户读取音色: the account's own voices merged into the source's list as
   * the form shows it (`draft`, a typed key included). Listed voices keep their
   * place and the names written for them; the account's others follow with
   * the account's names. Nothing is saved: the page puts the list in the form.
   * → { voices, found, added, changed, full }; the key is never in it.
   */
  async function accountVoices({ source: sourceId, draft }, signal) {
    const source = byId.get(sourceId)
    if (!source) throw httpError(400, `不认识的语音来源：${String(sourceId).slice(0, 40)}`)
    if (!source.account) throw httpError(400, `${source.label} 没有账户音色可读`)
    const ctx = await context(draft)
    if (!source.configured(ctx)) throw httpError(400, `${source.label} 还没填密钥`)
    const account = new Map()
    for (const voice of await source.account({ ...ctx, signal })) {
      if (VOICE_ID.test(voice.id) && !account.has(voice.id)) account.set(voice.id, voice.name)
    }
    // MiniMax's list starts as its system voices: they stay offered.
    const listed = source.listed(ctx.media)
    const known = new Set(listed.map(v => v.id))
    const named = listed.map(v => ({ id: v.id, name: v.name || account.get(v.id) || '' }))
    const extra = [...account].filter(([id]) => !known.has(id)).map(([id, name]) => ({ id, name }))
    const voices = cleanVoiceList([...named, ...extra], { fish: source.id === 'fish' })
    const added = voices.length - listed.length
    return { voices, found: account.size, added, changed: added > 0 || named.some((v, i) => v.name !== listed[i].name), full: added < extra.length }
  }

  /** Every source with its voices, for 配图与朗读; each says how long a piece it takes (chunkMax). */
  async function list() {
    const ctx = await context()
    const { media } = ctx
    let external = { id: bridge.id, label: bridge.label, chunkMax: bridge.chunkMax, configured: false, ok: true, voices: [], cloud: [], current: null }
    if (media.ttsUrl) {
      try {
        external = { ...external, configured: true, ...(await bridge.voiceList(media, 5000)) }
      } catch (error) {
        external = { ...external, configured: true, ok: false, error: bridge.voiceTrouble(media, error) }
      }
    }
    const own = sources.map(source => {
      const configured = source.configured(ctx)
      return {
        id: source.id,
        label: source.label,
        chunkMax: source.chunkMax,
        emotion: source.emotion(media),
        model: source.model(media),
        configured,
        voices: configured ? source.list(ctx) : [],
      }
    })
    return { sources: [external, ...own] }
  }

  /**
   * The bridge's voice list in its own shape, so another tavern (the phone)
   * can use this one as its voice service: the service's voices, plus this
   * tavern's own cloud voices as named cloud voices.
   */
  async function personaList() {
    const [external, ...own] = (await list()).sources
    const cloud = own.flatMap(source =>
      source.voices.map(v => ({ name: v.ref, label: v.label, provider: source.label, model: source.model, tags: source.emotion !== 'none', chunkMax: source.chunkMax })),
    )
    if (!external.ok && !cloud.length) throw httpError(502, external.error)
    return { voices: external.voices.map(name => ({ name })), cloud_voices: [...external.cloud, ...cloud], current: { voice: external.current }, via: 'agent-tavern' }
  }

  return { list, personaList, speak, preview, accountVoices, keyStatus, setKey, ttsKeyStatus: bridge.ttsKeyStatus, setTtsKey: bridge.setTtsKey }
}
