// Pictures and voice for a reply, on demand. Nothing here enters the model's
// context, so prompt caching is unaffected.
// - Image prompt: a helper model (a provider model, never the subscription)
//   describes the scene from the reply, the card's looks and the scene variables.
// - Image: an OpenAI-compatible images endpoint of a provider (e.g. a local
//   grok2api), optionally with the card's avatar as reference, or a ComfyUI
//   workflow with {{prompt}} / {{negative}} / {{seed}} / {{width}} / {{height}}
//   / {{reference}} placeholders, or NovelAI's image API (its persistent
//   token kept server-side in novelai.json, never sent to the page).
// - Voice: the sources in voice/: a provider's /audio/speech, Fish Audio and
//   MiniMax with the user's own key, or a voice service speaking the xiaoya
//   bridge's protocol (the local bridge on this machine's own install, nothing
//   by default elsewhere); proxied so a phone on the LAN can play it, cached
//   by source + model + voice + text. Browser voices (Web Speech) never reach
//   the server.
import { randomInt } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { complete, fetchBytes, googleRequest, isProviderRef, postJson, providerError, providerRequest, refLabel, resolveRef } from './providers.mjs'
import { cleanFrame, cleanLora, cleanRoster, cleanStrength, countTags, draftMaterial, flattenFrame, frameFormat, isFramePrompt, isRosterId, leadOf, naiCharacters, parseFrame, parseRosterDraft, rosterBrief, rosterDraftRequest, withSomeone } from './roster.mjs'
import { httpError, newId } from './store.mjs'
import { FISH_MODELS } from './voice/cloud.mjs'
import { KEYED, cleanVoiceKey, cleanVoiceList, createVoices } from './voice/index.mjs'
import { msg } from './i18n.mjs'
import { EXPRESSION_LOOK, expressionRequest, parseExpressionLabels } from '../web/shared/stage.js'

export const DEFAULT_MEDIA = Object.freeze({
  helperModel: '', // provider ref that writes image prompts; empty = the chat's model when it is a provider
  promptSource: 'helper', // 'helper': a short standalone request; 'chat': asked at the end of the conversation (cache hits)
  imageBackend: 'openai', // 'openai' | 'gemini' | 'comfy' | 'sdwebui' | 'novelai'
  imageProvider: '', // provider id whose base URL serves /images/generations
  imageModel: '',
  imageShape: 'square', // 'square' | 'portrait' | 'landscape'; pixel size per backend (imageSize)
  imageReference: false, // send the card avatar through /images/edits
  imageEditModel: '', // model for /images/edits; empty = imageModel (some gateways split generate and edit models)
  promptStyle: 'natural', // 'natural' sentences or comma-separated 'tags' (SD-style workflows)
  comfyUrl: 'http://127.0.0.1:8188',
  geminiImageProvider: '', // a provider with Google's key: Gemini's own image models (generateContent)
  geminiImageModel: 'gemini-2.5-flash-image',
  geminiReference: true, // cast members in the frame with a reference picture: sent along, so the faces stay
  sdUrl: 'http://127.0.0.1:7860', // Stable Diffusion WebUI / Forge, started with --api
  sdSteps: 28,
  sdCfg: 6,
  sdSampler: 'Euler a',
  sdNegative: 'lowres, bad anatomy, bad hands, text, error, missing fingers, worst quality, low quality, jpeg artifacts, signature, watermark, blurry',
  naiModel: 'nai-diffusion-5-full',
  naiQuality: 'very aesthetic, masterpiece, no text', // appended to every NovelAI prompt
  naiReference: true, // a frame with one cast member who has a reference picture: V4.5 with it (+5 Anlas)
  naiRefFidelity: 0.8,
  naiRefStyle: false, // also take the reference picture's drawing style
  naiV5Empty: 'v45', // V5 allowance used up: 'v45' draws with V4.5 (free on Opus), 'anlas' spends Anlas on V5
  naiNegative: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  ttsUrl: 'http://127.0.0.1:8765', // external voice service (voice/bridge.mjs)
  ttsProvider: '', // provider id whose /audio/speech reads (voices openai:<id>:<voice>)
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoices: Object.freeze([]), // [{ id, name }]; none listed = the model's usual voices
  fishModel: 'drama-3',
  fishVoices: Object.freeze([]), // reference_id + name (voices fish:<id>)
  minimaxModel: 'speech-2.8-hd',
  minimaxRegion: 'cn', // 'cn' 国内站 | 'intl' 国际站
  minimaxVoices: Object.freeze([]), // none listed = MiniMax's system voices
  geminiTtsProvider: '', // a provider with Google's key: Gemini's speech models (voices gemini:<name>)
  geminiTtsModel: 'gemini-2.5-flash-preview-tts',
  geminiTtsVoices: Object.freeze([]), // none listed = Gemini's prebuilt voices
  localModels: Object.freeze({}), // the model picked for each of this install's own image backends (createMedia ownBackends), by id
  autoRead: false,
  autoImage: false,
})

// lora: a file in ComfyUI's models/loras, added to the workflow for this card (ComfyUI only).
// roster: the cast for pictures (roster.mjs); with one, the card LoRA is for frames where no cast member is named.
// style / styleNegative: the card's look; NovelAI puts them on every picture of the card (portraits too).
export const DEFAULT_CARD_MEDIA = Object.freeze({ voice: '', narratorVoice: '', style: '', styleNegative: '', lora: '', loraTrigger: '', loraStrength: 0.8, roster: [] })

const SIZE = /^(\d{3,4})x(\d{3,4})$/
const SHAPES = ['square', 'portrait', 'landscape']
// Images APIs (OpenAI gpt-image, grok2api) take only these three sizes; SDXL
// workflows want about one megapixel at its trained ratios.
const PIXELS = {
  openai: { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' },
  comfy: { square: '1024x1024', portrait: '832x1216', landscape: '1216x832' },
  sdwebui: { square: '1024x1024', portrait: '832x1216', landscape: '1216x832' },
  // All within Opus's free size (at most 1024×1024 pixels).
  novelai: { square: '1024x1024', portrait: '832x1216', landscape: '1216x832' },
}
// Gemini's image models take an aspect ratio, not a size.
const ASPECT = { square: '1:1', portrait: '2:3', landscape: '3:2' }
export const IMAGE_BACKENDS = ['openai', 'gemini', 'comfy', 'sdwebui', 'novelai']
const MODEL_NAME = /^[\w.:/@+-]{1,120}$/
export const NAI_MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']

/**
 * The settings for one drawing with the 画图方式 and model picked for it
 * (web/draw-choice.js), nothing saved: `backend` one of IMAGE_BACKENDS ('' =
 * the saved one), `model` that method's model ('' = its saved one). ComfyUI and
 * SD WebUI draw with what they have loaded. A string is a NovelAI model, as
 * pages before the picker sent it. `backends`: the ones there are, this
 * install's own included (their model goes into localModels).
 */
export function withDrawChoice(media, choice = {}, backends = IMAGE_BACKENDS) {
  const { backend = '', model = '' } = typeof choice === 'string' ? { model: choice } : choice ?? {}
  const using = backends.includes(backend) ? backend : media.imageBackend
  const next = { ...media, imageBackend: using }
  const name = String(model ?? '').trim()
  if (!name) return next
  if (using === 'novelai') {
    if (!/^nai-diffusion-[a-z0-9-]{1,40}$/.test(name)) throw httpError(400, msg`NovelAI 模型名不对`)
    return { ...next, naiModel: name, naiModelPicked: true }
  }
  if (!MODEL_NAME.test(name)) throw httpError(400, msg`模型名不对：${name.slice(0, 60)}`)
  if (using === 'gemini') return { ...next, geminiImageModel: name.replace(/^models\//, '') }
  if (using === 'openai') return { ...next, imageModel: name }
  if (!IMAGE_BACKENDS.includes(using)) return { ...next, localModels: { ...media.localModels, [using]: name } }
  return next
}

/** A draw request's { backend, model } (or the old lone `model`), as withDrawChoice takes it. */
export function drawChoiceOf(body) {
  const pick = key => (typeof body?.[key] === 'string' ? body[key].trim().slice(0, 200) : '')
  return { backend: pick('backend'), model: pick('model') }
}

/** The images API's answer format: gpt-image models always answer in base64 and refuse to be asked. */
export const imageFormat = model => (/^(openai\/)?(gpt-image|chatgpt-image)/i.test(String(model ?? '')) ? {} : { response_format: 'b64_json' })

/** Pixel size for a backend and shape. */
export function imageSize(backend, shape) {
  return (PIXELS[backend] ?? PIXELS.openai)[SHAPES.includes(shape) ? shape : 'square']
}

function shapeOf(size) {
  const match = SIZE.exec(String(size ?? '').trim())
  if (!match) return null
  const ratio = Number(match[1]) / Number(match[2])
  return ratio > 1.15 ? 'landscape' : ratio < 0.87 ? 'portrait' : 'square'
}
const FILE = /^[\w-]{1,64}\.(png|jpg|jpeg|webp)$/

/** Defaults for an edition: only this machine's own install assumes the xiaoya bridge on 8765. */
export function mediaDefaults(features) {
  return features && !features.xiaoya ? Object.freeze({ ...DEFAULT_MEDIA, ttsUrl: '' }) : DEFAULT_MEDIA
}

/**
 * @param defaults - mediaDefaults() of the edition; an emptied address goes
 *   back to its default ('' = no voice service where none is assumed).
 * @param options.backends - the image backends there are: IMAGE_BACKENDS and this install's own.
 */
export function cleanMedia(input, previous = DEFAULT_MEDIA, defaults = DEFAULT_MEDIA, { backends = IMAGE_BACKENDS } = {}) {
  const value = { ...defaults, ...previous }
  const source = input && typeof input === 'object' ? input : {}
  const text = (key, max = 200) => {
    if (typeof source[key] === 'string') value[key] = source[key].trim().slice(0, max)
  }
  text('helperModel')
  text('imageProvider', 40)
  text('imageModel')
  text('imageEditModel')
  if (backends.includes(source.imageBackend)) value.imageBackend = source.imageBackend
  // A backend this install no longer has (a saved setting read by another build): the default.
  if (!backends.includes(value.imageBackend)) value.imageBackend = DEFAULT_MEDIA.imageBackend
  if (source.localModels && typeof source.localModels === 'object' && !Array.isArray(source.localModels)) {
    value.localModels = { ...value.localModels }
    for (const [id, model] of Object.entries(source.localModels)) {
      if (!/^[a-z][\w-]{0,30}$/.test(id) || typeof model !== 'string') continue
      const name = model.trim()
      if (name && !MODEL_NAME.test(name)) throw httpError(400, msg`模型名不对：${name.slice(0, 60)}`)
      value.localModels[id] = name
    }
  }
  text('geminiImageProvider', 40)
  text('geminiTtsProvider', 40)
  for (const key of ['geminiImageModel', 'geminiTtsModel']) {
    if (typeof source[key] !== 'string') continue
    const model = source[key].trim().replace(/^models\//, '')
    if (model && !MODEL_NAME.test(model)) throw httpError(400, msg`Gemini 模型名不对（例如 ${DEFAULT_MEDIA[key]}）`)
    value[key] = model || DEFAULT_MEDIA[key]
  }
  if (source.sdSteps !== undefined && Number.isFinite(Number(source.sdSteps))) value.sdSteps = Math.min(80, Math.max(1, Math.round(Number(source.sdSteps))))
  if (source.sdCfg !== undefined && Number.isFinite(Number(source.sdCfg))) value.sdCfg = Math.min(20, Math.max(1, Math.round(Number(source.sdCfg) * 10) / 10))
  if (typeof source.sdSampler === 'string') value.sdSampler = source.sdSampler.trim().slice(0, 60) || DEFAULT_MEDIA.sdSampler
  if (typeof source.sdNegative === 'string') value.sdNegative = source.sdNegative.trim().slice(0, 1500)
  if (typeof source.naiModel === 'string') {
    const model = source.naiModel.trim()
    if (!/^nai-diffusion-[a-z0-9-]{1,40}$/.test(model)) throw httpError(400, msg`NovelAI 模型名不对（例如 nai-diffusion-5-full）`)
    value.naiModel = model
  }
  if (typeof source.naiRefFidelity === 'number' || typeof source.naiRefFidelity === 'string') {
    const fidelity = Number(source.naiRefFidelity)
    if (Number.isFinite(fidelity)) value.naiRefFidelity = Math.min(1, Math.max(0, Math.round(fidelity * 100) / 100))
  }
  if (typeof source.naiQuality === 'string') value.naiQuality = source.naiQuality.trim().slice(0, 400)
  if (typeof source.naiNegative === 'string') value.naiNegative = source.naiNegative.trim().slice(0, 1500)
  // Settings saved before shapes existed carried a pixel size.
  if (previous?.imageSize && !SHAPES.includes(previous.imageShape)) value.imageShape = shapeOf(previous.imageSize) ?? 'square'
  if (!SHAPES.includes(value.imageShape)) value.imageShape = 'square'
  delete value.imageSize
  if (SHAPES.includes(source.imageShape)) value.imageShape = source.imageShape
  else if (shapeOf(source.imageSize)) value.imageShape = shapeOf(source.imageSize)
  if (source.promptStyle === 'natural' || source.promptStyle === 'tags') value.promptStyle = source.promptStyle
  if (source.promptSource === 'helper' || source.promptSource === 'chat') value.promptSource = source.promptSource
  for (const key of ['comfyUrl', 'sdUrl', 'ttsUrl']) {
    if (typeof source[key] !== 'string') continue
    const url = source[key].trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw httpError(400, msg`${{ comfyUrl: 'ComfyUI', sdUrl: 'SD WebUI' }[key] ?? msg`本地语音桥接`}地址不对`)
    value[key] = url || defaults[key]
  }
  if (source.naiV5Empty === 'v45' || source.naiV5Empty === 'anlas') value.naiV5Empty = source.naiV5Empty
  text('ttsProvider', 40)
  if (typeof source.ttsModel === 'string') {
    const model = source.ttsModel.trim()
    if (model && !/^[\w.:/@+-]{1,120}$/.test(model)) throw httpError(400, msg`朗读模型名不对（例如 gpt-4o-mini-tts）`)
    value.ttsModel = model || DEFAULT_MEDIA.ttsModel
  }
  if (typeof source.fishModel === 'string') {
    if (!FISH_MODELS.includes(source.fishModel)) throw httpError(400, msg`Fish 模型只能选 ${FISH_MODELS.join(' / ')}`)
    value.fishModel = source.fishModel
  }
  if (typeof source.minimaxModel === 'string') {
    if (!/^speech-[\w.-]{1,40}$/.test(source.minimaxModel)) throw httpError(400, msg`MiniMax 模型名不对（例如 speech-2.8-hd）`)
    value.minimaxModel = source.minimaxModel
  }
  if (source.minimaxRegion === 'cn' || source.minimaxRegion === 'intl') value.minimaxRegion = source.minimaxRegion
  for (const key of ['ttsVoices', 'fishVoices', 'minimaxVoices', 'geminiTtsVoices']) {
    if (typeof source[key] === 'string' || Array.isArray(source[key])) value[key] = cleanVoiceList(source[key], { fish: key === 'fishVoices' })
  }
  for (const key of ['imageReference', 'autoRead', 'autoImage', 'naiReference', 'naiRefStyle', 'geminiReference']) if (typeof source[key] === 'boolean') value[key] = source[key]
  return value
}

export function cleanCardMedia(input, previous = DEFAULT_CARD_MEDIA) {
  const value = { ...DEFAULT_CARD_MEDIA, ...previous }
  // openai:<provider id>:<voice> runs long: SiliconFlow's CosyVoice voices carry their model.
  for (const key of ['voice', 'narratorVoice']) if (typeof input?.[key] === 'string') value[key] = input[key].trim().slice(0, 250)
  if (typeof input?.style === 'string') value.style = input.style.trim().slice(0, 600)
  if (typeof input?.styleNegative === 'string') value.styleNegative = input.styleNegative.trim().slice(0, 600)
  if (typeof input?.lora === 'string') value.lora = cleanLora(input.lora)
  if (typeof input?.loraTrigger === 'string') value.loraTrigger = input.loraTrigger.trim().slice(0, 80)
  if (input?.loraStrength !== undefined) value.loraStrength = cleanStrength(input.loraStrength, value.loraStrength)
  value.roster = cleanRoster(Array.isArray(input?.roster) ? input.roster : value.roster)
  return value
}

/**
 * The workflow with a LoraLoader after its checkpoint loader: everything that
 * took the checkpoint's MODEL and CLIP now takes them from the LoRA. Works on
 * any imported workflow, so one workflow serves every card.
 */
export function withLora(workflow, { name, strength = 0.8 }) {
  const loaderId = Object.keys(workflow).find(id => workflow[id]?.class_type === 'CheckpointLoaderSimple' || typeof workflow[id]?.inputs?.ckpt_name === 'string')
  if (!loaderId) throw httpError(400, msg`工作流里没有 Load Checkpoint 节点，加不了 LoRA`)
  const loraId = String(Math.max(0, ...Object.keys(workflow).map(Number).filter(Number.isFinite)) + 1)
  const out = {}
  for (const [id, node] of Object.entries(workflow)) {
    const inputs = Object.fromEntries(
      Object.entries(node.inputs ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) && String(value[0]) === loaderId && (value[1] === 0 || value[1] === 1) ? [loraId, value[1]] : value,
      ]),
    )
    out[id] = { ...node, inputs }
  }
  out[loraId] = {
    class_type: 'LoraLoader',
    _meta: { title: 'Card LoRA' },
    inputs: { lora_name: name, strength_model: strength, strength_clip: strength, model: [loaderId, 0], clip: [loaderId, 1] },
  }
  return out
}

/** The trigger word first, unless the prompt already starts with it. */
export function withTrigger(prompt, trigger) {
  if (!trigger) return prompt
  return prompt.toLowerCase().startsWith(trigger.toLowerCase()) ? prompt : `${trigger}, ${prompt}`
}

// ─── Image prompt ───────────────────────────────────────────────────────

const clip = (text, max) => {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

// The helper only describes one frame; a short cap keeps it fast and stops it
// from drifting into continuing the story.
export const PROMPT_MAX_TOKENS = 400
// A cast-format prompt has a line per person.
const CAST_MAX_TOKENS = 700
const PROMPT_MAX_WORDS = { natural: 90, tags: 70 }

/**
 * The request to the helper model. `reply` is the text as displayed (status
 * bars removed). The task is stated in the system prompt and again after the
 * material: some gateways drop the system part, and a model that sees only a
 * story passage tends to continue it.
 */
export function imagePromptRequest({ card, names, reply, input, state, style, promptStyle, roster = [] }) {
  const tags = promptStyle === 'tags'
  const cast = roster.length > 0
  const format = cast
    ? frameFormat(promptStyle)
    : tags
    ? 'Format: 30-60 comma-separated English tags (subject count, each character\'s hair, eyes, outfit, expression, pose, then setting, lighting, camera). No sentences.'
    : 'Format: one English paragraph of 40-80 words: who is in the frame and how they look (hair, eyes, outfit), expression and pose, setting, lighting, camera angle.'
  const task = [
    'TASK: write an image-generation prompt for ONE frame of the scene above. Do not continue or summarise the story, no dialogue, no narration, no Chinese.',
    cast
      ? 'Pick the most vivid moment of <latest_passage>. No text, captions or speech bubbles in the picture.'
      : 'Pick the most vivid moment of <latest_passage>. Keep the character\'s looks consistent with <character>. No text, captions or speech bubbles in the picture.',
    cast
      ? `Somebody is always in the picture: at least one cast member, ${names.char} or another one rather than the player alone where the moment allows. Never an empty room or a close-up of objects only.`
      : `Somebody is always in the picture, normally ${names.char}. Never an empty room or a close-up of objects only.`,
    format,
    'Reply with the prompt only.',
  ].join('\n')
  const scene = state && Object.keys(state).length ? clip(JSON.stringify(state), 800) : ''
  const content = [
    `<character name="${names.char}">\n${clip(card.description, 1500)}\n</character>`,
    `The player character is called ${names.user}.`,
    cast ? `<cast>\n${rosterBrief(roster, names.user)}\n</cast>` : '',
    scene ? `<variables>\n${scene}\n</variables>` : '',
    style ? `<art_style>${style}</art_style>` : '',
    input ? `<player_action>\n${clip(input, 300)}\n</player_action>` : '',
    `<latest_passage>\n${clip(reply, 1800)}\n</latest_passage>`,
    task,
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    system: `You write prompts for an image generator. You never write story text.\n${format}`,
    messages: [{ role: 'user', content }],
    maxTokens: cast ? CAST_MAX_TOKENS : PROMPT_MAX_TOKENS,
  }
}

/** A prompt without the card's style written into it. */
export function unstyled(prompt, style) {
  if (!style) return prompt
  return String(prompt ?? '').split(style).join('').replace(/^[,，\s]+/, '').replace(/([,，]\s*){2,}/g, ', ')
}

/** The card's style tags first (tag prompts only); in a cast-format prompt, first in its 场景 line. */
export function withStyle(prompt, style, promptStyle) {
  if (!style || promptStyle !== 'tags') return prompt
  if (!isFramePrompt(prompt)) return `${style}, ${prompt}`
  const lines = prompt.split('\n')
  const scene = lines.findIndex(line => /^\s*(?:场景|画面|scene|setting)\s*[:：]/i.test(line))
  if (scene < 0) return [`场景: ${style}`, ...lines].join('\n')
  lines[scene] = lines[scene].replace(/^(\s*(?:场景|画面|scene|setting)\s*[:：]\s*)/i, `$1${style}, `)
  return lines.join('\n')
}

// ─── Scenery (视觉小说模式 backgrounds, server/scenes.mjs) ────────────────

export const SCENERY_NEGATIVE = 'people, person, 1girl, 1boy, character, crowd, text, watermark'

/**
 * The helper's request for a place's background: the place, what the card's
 * worldbook says about it, the card's setting and art style. Empty of people;
 * neutral daylight (the page lays the time of day and the weather over it).
 */
/**
 * @param passage - 画这一轮的场景: the reply the background is for. The place is
 *   then where it happens, as it looks in it (light, weather, objects), and the
 *   answer starts with a PLACE: line naming it (readSceneryAnswer).
 */
export function sceneryPromptRequest({ place, lore = '', setting = '', style = '', promptStyle = 'natural', passage = '' }) {
  const tags = promptStyle === 'tags'
  const format = tags
    ? 'Format: 25-50 comma-separated English tags starting with "scenery, no humans": the place, its architecture and objects, era and culture, lighting, camera. No sentences.'
    : 'Format: one English paragraph of 30-70 words describing the empty place: architecture, objects, era and culture, lighting, a wide eye-level view. End with "No people."'
  const task = passage
    ? [
        'TASK: write an image-generation prompt for a visual novel background of where the story in <passage> takes place, as it looks there and then. Do not write story text.',
        'The place is empty: leave out every person and animal in the passage, and any text or writing on signs. Keep the objects, light, time of day and weather it describes.',
        'A wide establishing shot at eye level.',
        'Match the era and culture of <setting>.',
        format,
        `First line: PLACE: the place's short name in the passage's language (at most 12 characters${place ? `; "${String(place).replace(/"/g, '')}" if it fits` : ''}). Then the prompt on the next line, in English. Nothing else.`,
      ].join('\n')
    : [
        'TASK: write an image-generation prompt for a visual novel background of the place in <place>. Do not write story text, no Chinese.',
        'The place is empty: no people, no animals, no text or writing on signs.',
        'A wide establishing shot at eye level in neutral daylight with no particular weather (time of day and weather are added separately).',
        'Match the era and culture of <setting>.',
        format,
        'Reply with the prompt only.',
      ].join('\n')
  const name = String(place ?? '').replace(/"/g, '')
  const content = [
    name || lore ? `<place name="${name}">${lore ? `\n${clip(lore, 1200)}\n` : ''}</place>` : '',
    passage ? `<passage>\n${clip(passage, 3000)}\n</passage>` : '',
    setting ? `<setting>\n${clip(setting, 500)}\n</setting>` : '',
    style ? `<art_style>${style}</art_style>` : '',
    task,
  ].filter(Boolean).join('\n\n')
  return { system: `You write prompts for an image generator. You never write story text.\n${format}`, messages: [{ role: 'user', content }], maxTokens: PROMPT_MAX_TOKENS + 40 }
}

/** A passage scenery answer → { place, prompt }: the PLACE: line, then the prompt. */
export function readSceneryAnswer(text) {
  const value = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')
  const line = /^\s*\**\s*(?:PLACE|地点)\s*\**\s*[:：]\s*(.+)$/im.exec(value)
  const place = line ? line[1].replace(/[*"「」“”]/g, '').trim().slice(0, 40) : ''
  return { place, prompt: line ? value.slice(0, line.index) + value.slice(line.index + line[0].length) : value }
}

/** A scenery prompt that says, in its own style, that nobody is in the picture. */
export function ensureScenery(prompt, promptStyle = 'natural') {
  const text = String(prompt ?? '').trim()
  if (promptStyle === 'tags') return ['scenery', 'no humans', ...text.split(/\s*,\s*/).filter(tag => tag && !/^(scenery|no humans)$/i.test(tag))].join(', ')
  return /no (people|humans|one)/i.test(text) ? text : `${text} No people.`.trim()
}

/**
 * Strip quotes, labels, code fences and thinking a model may wrap the prompt
 * in, keep the first paragraph, and cut a rambling answer at a word limit.
 */
export function cleanPrompt(text, promptStyle = 'natural') {
  let value = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```\w*/g, '')
    .trim()
    .replace(/^\s*(?:here is|here's)[^:\n]*:\s*/i, '')
    .replace(/^\s*(?:image prompt|positive prompt|prompt|tags)\s*[:：]\s*/i, '')
  value = value.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').replace(/^["“'\s]+|["”'\s]+$/g, '').trim()
  const limit = PROMPT_MAX_WORDS[promptStyle] ?? PROMPT_MAX_WORDS.natural
  if (promptStyle === 'tags') {
    const parts = value.split(/\s*,\s*/).filter(Boolean)
    return parts.slice(0, limit).join(', ')
  }
  const words = value.split(/\s+/)
  if (words.length <= limit) return value
  const cut = words.slice(0, limit).join(' ')
  const sentence = cut.lastIndexOf('.')
  return sentence > cut.length * 0.6 ? cut.slice(0, sentence + 1) : `${cut.replace(/[,;:]$/, '')}.`
}

/**
 * The same task asked inside the conversation: the model already has the
 * card, the world and the whole story, so this only says what to write.
 * `passage` is given when the reply is not in the history (the opening).
 */
export function contextImageInstruction({ promptStyle, style, passage, roster = [], userName = '' }) {
  const cast = roster.length > 0
  const format = cast
    ? `出场人物（只用这些名字，方括号原样写）：\n${rosterBrief(roster, userName)}\n${frameFormat(promptStyle)}`
    : promptStyle === 'tags'
      ? '格式：30–60 个英文标签，用逗号分隔（人数、每个人的发型发色、眼睛、服装、表情、动作，然后场景、光线、镜头），不写句子。'
      : '格式：一段 40–80 个英文单词的描述：画面里有谁、长什么样（发型发色、眼睛、服装）、表情和动作、场景、光线、镜头角度。'
  return [
    '（暂停扮演。这一条不是剧情，不要回应剧情，也不要续写。）',
    passage ? `<latest_passage>\n${clip(passage, 1800)}\n</latest_passage>\n` : '',
    cast
      ? `为${passage ? '上面这段' : '你上一条回复里'}最有画面感的一个瞬间，写给生图模型用的英文提示词。人物长相会自动补上，你只写谁在画面里、现在穿什么（换过的衣服、受的伤都要对）、在做什么、什么表情、站在哪。画面里不要出现文字、字幕或对话气泡。`
      : `为${passage ? '上面这段' : '你上一条回复里'}最有画面感的一个瞬间，写一段给生图模型用的英文提示词。人物外貌以角色设定和剧情里的最新状态为准（换过的衣服、受的伤、所在的地方都要对）。画面里不要出现文字、字幕或对话气泡。`,
    cast ? '画面里一定要有人：至少一个出场人物，能选的话画角色本人或其他人，不要只有玩家。不要画空场景，也不要只画物品特写。' : '画面里一定要有人，通常是角色本人。不要画空场景，也不要只画物品特写。',
    style ? `画风：${style}` : '',
    format,
    '只输出提示词本身，不要标题、解释或思考过程。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Refusals read as auth errors otherwise; say what usually causes them. */
function imageError(provider, error) {
  const text = String(error?.message ?? '')
  // grok2api relays a Grok Web refusal as 503 "Grok Web 媒体上游返回 403"; others say policy/moderation.
  if (/上游返回 403|content[ _-]?policy|moderation|safety system|nsfw|flagged/i.test(text)) {
    return msg`${provider.name} 拒绝画这张：多半是提示词或参考图没过它的内容审核。改掉敏感的描述再画，或者在「配图与朗读」里关掉参考图试试。（${text.slice(0, 160)}）`
  }
  return providerError(provider, error)
}

// ─── ComfyUI ────────────────────────────────────────────────────────────

const NUMERIC = new Set(['{{seed}}', '{{width}}', '{{height}}'])

/** Fill placeholders in an API-format workflow; whole-value numeric ones become numbers. */
export function fillWorkflow(workflow, values) {
  const walk = node => {
    if (typeof node === 'string') {
      if (NUMERIC.has(node.trim())) return Number(values[node.trim().slice(2, -2)])
      return node.replace(/\{\{(prompt|negative|seed|width|height|reference)\}\}/g, (_, key) => String(values[key] ?? ''))
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return walk(workflow)
}

export function checkWorkflow(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw httpError(400, msg`工作流必须是 ComfyUI「导出（API）」的 JSON`)
  const nodes = Object.values(json)
  if (!nodes.length || !nodes.every(n => n && typeof n === 'object' && n.class_type)) throw httpError(400, msg`这不是 API 格式的工作流：在 ComfyUI 里用「导出（API）」`)
  if (!JSON.stringify(json).includes('{{prompt}}')) throw httpError(400, msg`工作流里没有 {{prompt}} 占位符：把正向提示词节点的文本改成 {{prompt}}`)
  return json
}

// A cast member's reference picture: one person, nothing else to copy from it.
const PORTRAIT_SCENE = 'solo, upper body, looking at viewer, simple background, white background'
// A card's avatar (修改角色卡 → 生成头像): square, the face and shoulders filling it.
const AVATAR_SCENE = 'solo, portrait, face and shoulders, close-up, looking at viewer, simple background'
const AVATAR_NEGATIVE = 'nsfw, multiple views, text, full body, lower body'
// 立绘 for the visual novel mode: the page cuts the white out, so nothing may touch the edges but the body.
const SPRITE_SCENE = 'solo, upper body, cowboy shot, looking at viewer, standing, simple background, white background, full color'
const SPRITE_NEGATIVE = 'multiple views, text, scenery, detailed background, gradient background, frame, border, nsfw'

// ─── NovelAI ────────────────────────────────────────────────────────────

// 23 steps is the site's default and inside Opus's free generations (≤28).
const NAI_STEPS = 23

/** The generate-image body the NovelAI site sends for a V4-style model (V4, V4.5, V5). */
export function naiRequest({ model, prompt, negative, width, height, seed, characters = [], reference = null }) {
  const centers = c => [{ x: c.x, y: c.y }]
  const coords = characters.some(c => c.positioned)
  const body = {
    input: prompt,
    model,
    action: 'generate',
    parameters: {
      params_version: 3,
      width,
      height,
      scale: 5,
      sampler: 'k_euler_ancestral',
      steps: NAI_STEPS,
      n_samples: 1,
      ucPreset: 3, // "none": the negative prompt below is the whole of it
      qualityToggle: false,
      seed,
      noise_schedule: 'karras',
      cfg_rescale: 0,
      sm: false,
      sm_dyn: false,
      dynamic_thresholding: false,
      legacy: false,
      legacy_v3_extend: false,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      negative_prompt: negative,
      characterPrompts: characters.map(c => ({ prompt: c.prompt, uc: '', center: { x: c.x, y: c.y }, enabled: true })),
      v4_prompt: { caption: { base_caption: prompt, char_captions: characters.map(c => ({ char_caption: c.prompt, centers: centers(c) })) }, use_coords: coords, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: characters.map(c => ({ char_caption: '', centers: centers(c) })) }, legacy_uc: false },
    },
  }
  // Character reference (V4.5): primary strength 1, secondary 1 − fidelity, as the site sends it.
  if (reference) {
    Object.assign(body.parameters, {
      director_reference_images: [reference.image],
      director_reference_descriptions: [{ caption: { base_caption: reference.style ? 'character&style' : 'character', char_captions: [] }, legacy_uc: false }],
      director_reference_strength_values: [1],
      director_reference_secondary_strength_values: [Math.round((1 - reference.fidelity) * 100) / 100],
      director_reference_information_extracted: [1],
    })
  }
  return body
}

/** The V4.5 model to use with a reference picture (V5 has no character reference yet). */
export function referenceModel(model) {
  return /curated/.test(model) ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full'
}

const isV5 = model => /^nai-diffusion-5-/.test(model)
const V5_LOW = 10 // percent of the V5 allowance at which pictures get a note

/** "2.2 小时" / "40 分钟". */
function waitText(minutes) {
  return minutes >= 60 ? msg`${Math.round(minutes / 6) / 10} 小时` : msg`${Math.max(1, Math.round(minutes))} 分钟`
}

/**
 * NovelAI's /user/subscription in the app's terms. `usage` is the V5 allowance
 * (percent left, plus any bought; seconds until the next percent comes back).
 */
export function naiAccount(json) {
  const steps = json?.trainingStepsLeft ?? {}
  const anlas = (Number(steps.fixedTrainingStepsLeft) || 0) + (Number(steps.purchasedTrainingSteps) || 0)
  const tier = [msg`免费`, 'Tablet', 'Scroll', 'Opus'][json?.tier] ?? `tier ${json?.tier}`
  const usage = json?.usage
  const v5 = usage && Number.isFinite(Number(usage.percent))
    ? (() => {
        const percent = Math.max(0, Math.round(Number(usage.percent)))
        const bought = Math.max(0, Math.round(Number(usage.purchasedPercent) || 0))
        const seconds = Number(usage.timeUntilNextPercent)
        return {
          percent,
          purchasedPercent: bought,
          empty: usage.isNegative === true || percent + bought <= 0,
          nextPercentMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null,
        }
      })()
    : null
  const renewsAt = Number(json?.expiresAt) > 0 ? new Date(Number(json.expiresAt) * 1000).toISOString() : null
  return { tier, active: json?.active !== false, anlas, v5, renewsAt }
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

/** The first file of a zip (NovelAI answers with one); a bare image passes through. */
export function unzipFirst(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE) || (buffer[0] === 0xff && buffer[1] === 0xd8)) return buffer
  const end = buffer.lastIndexOf(Buffer.from('504b0506', 'hex'))
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50 || end < 0) throw new Error(msg`返回的既不是图片也不是 zip`)
  const entry = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt32LE(entry) !== 0x02014b50) throw new Error(msg`zip 目录损坏`)
  const method = buffer.readUInt16LE(entry + 10)
  const size = buffer.readUInt32LE(entry + 20)
  const local = buffer.readUInt32LE(entry + 42)
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const data = buffer.subarray(start, start + size)
  if (method === 0) return Buffer.from(data)
  if (method === 8) return inflateRawSync(data)
  throw new Error(msg`zip 压缩方式 ${method} 不认识`)
}

/** A pasted persistent token (pst-…): printable, no spaces. */
export function cleanNaiToken(value) {
  const token = String(value ?? '').trim().replace(/^Bearer\s+/i, '')
  if (!/^[!-~]{16,1000}$/.test(token)) throw httpError(400, msg`NovelAI 令牌格式不对：在 NovelAI 网页「设置 → Account → Get Persistent API Token」复制（pst- 开头）`)
  return token
}

function multipart(fields) {
  const boundary = `----agent-tavern-${newId()}`
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (value && Buffer.isBuffer(value.buffer)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: ${value.type}\r\n\r\n`))
      parts.push(value.buffer, Buffer.from('\r\n'))
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { contentType: `multipart/form-data; boundary=${boundary}`, buffer: Buffer.concat(parts) }
}

function extOf(contentType, buffer) {
  if (/jpe?g/.test(contentType) || (buffer[0] === 0xff && buffer[1] === 0xd8)) return 'jpg'
  if (/webp/.test(contentType) || buffer.subarray(8, 12).toString() === 'WEBP') return 'webp'
  return 'png'
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param store - for settings, providers and file locations.
 * @param proxy - the app's proxy for providers set to follow it: a URL, or a
 *   function read on every request (the setting can change while running).
 * @param askInContext - engine.askInContext, for prompts written inside the conversation.
 * @param novelai - NovelAI base URLs (tests point them at a fake server).
 * @param voiceUrls - cloud speech addresses, the same way: { fish, minimax: { cn, intl } }.
 * @param features - the edition's capabilities (edition.mjs); without the
 *   xiaoya bridge assumed, no voice service is configured by default.
 * @param ownBackends - this install's own image backends, beside IMAGE_BACKENDS:
 *   { id, status() → { id, name, ready, need, hint, models: [{ id, label }], model },
 *   draw({ prompt, shape, references: [Buffer], model, signal }) → { buffer, label, note } }.
 */
export function createMedia(store, { proxy = null, askInContext = null, novelai = {}, voiceUrls = {}, features = null, ownBackends = [] } = {}) {
  const proxyNow = typeof proxy === 'function' ? proxy : () => proxy
  const defaults = mediaDefaults(features)
  const backends = [...IMAGE_BACKENDS, ...ownBackends.map(own => own.id)]
  // Since 2026-09-21 api.novelai.net refuses third-party tools ("update to the
  // image URL"); generation and the subscription lookup both live on the image host.
  const naiImageUrl = novelai.imageUrl ?? 'https://image.novelai.net'
  const mediaDir = chatId => path.join(store.dirs.root, 'media', chatId)

  async function settings() {
    return cleanMedia((await store.getSettings()).media ?? {}, defaults, defaults, { backends })
  }

  /** A settings form or patch over the saved settings (PUT /api/media/settings). */
  const cleanSettings = (input, previous) => cleanMedia(input, previous, defaults, { backends })

  /** This install's own image backends as the page offers them, each with the model it draws with. */
  async function ownBackendViews() {
    const media = await settings()
    return Promise.all(ownBackends.map(async own => {
      const view = await own.status()
      return { ...view, model: media.localModels?.[own.id] || view.model }
    }))
  }

  const voices = createVoices({ root: store.dirs.root, settings, providers: () => store.getProviders(), proxy: proxyNow, features, urls: voiceUrls })

  const workflowFile = path.join(store.dirs.root, 'comfy-workflow.json')

  async function loadWorkflow() {
    try {
      return JSON.parse(await readFile(workflowFile, 'utf8'))
    } catch {
      return null
    }
  }

  async function saveWorkflow(json) {
    await writeFile(workflowFile, JSON.stringify(checkWorkflow(json), null, 1), 'utf8')
    return describeWorkflow(json)
  }

  function describeWorkflow(json) {
    if (!json) return null
    const text = JSON.stringify(json)
    return {
      nodes: Object.keys(json).length,
      placeholders: ['prompt', 'negative', 'seed', 'width', 'height', 'reference'].filter(key => text.includes(`{{${key}}}`)),
    }
  }

  /** Helper model: the configured one, else the chat's own model when that is a provider. */
  async function helperTarget(chat, media) {
    const fallback = (await store.getSettings()).model
    const ref = media.helperModel || (isProviderRef(chat.model) ? chat.model : '') || (isProviderRef(fallback) ? fallback : '')
    if (!ref) throw httpError(400, msg`还没选写画面提示词的辅助模型：在「配图与朗读」里选一个供应商的模型`)
    return resolveRef(ref, await store.getProviders())
  }

  async function writeImagePrompt(chat, node, { reply, input }, signal) {
    const media = await settings()
    const card = await store.getCard(chat.cardId)
    const cardMedia = cleanCardMedia(card.media)
    const roster = cardMedia.roster
    // A cast answers in its own format; an answer that ignored it is still usable as a plain prompt.
    // Either way somebody from the cast is in it when the answer left everyone out.
    const clean = text => {
      const prompt = (roster.length && cleanFrame(text)) || cleanPrompt(text, media.promptStyle)
      return withSomeone(prompt, roster, chat.names.user, card.name, media.promptStyle)
    }
    let note = ''
    if (media.promptSource === 'chat' && askInContext) {
      const providers = await store.getProviders()
      const instruction = contextImageInstruction({ promptStyle: media.promptStyle, style: cardMedia.style, passage: node.parent ? '' : reply, roster, userName: chat.names.user })
      const answer = await askInContext(chat.id, node.id, instruction, { maxTokens: roster.length ? CAST_MAX_TOKENS : PROMPT_MAX_TOKENS, signal })
      if (answer) {
        const prompt = clean(answer.text)
        if (!prompt) throw httpError(502, msg`对话模型没有写出提示词，可以「重写」，或改用辅助模型`)
        const u = answer.usage
        const total = u.input + u.cacheRead + u.cacheWrite
        return {
          prompt: withStyle(prompt, cardMedia.style, media.promptStyle),
          model: refLabel(answer.model, providers) ?? answer.model,
          cache: total ? Math.round((u.cacheRead / total) * 100) : null,
          inContext: true,
        }
      }
      note = msg`这段剧情是 Claude 订阅写的，借不了它的上下文，这次用辅助模型写。`
    }
    const { provider, modelId } = await helperTarget(chat, media)
    const request = imagePromptRequest({ card, names: chat.names, reply, input, state: node.state, style: cardMedia.style, promptStyle: media.promptStyle, roster })
    let result
    try {
      result = await complete(provider, modelId, { ...request, signal }, { proxy: proxyNow() })
    } catch (error) {
      if (error.status) throw error
      throw httpError(502, providerError(provider, error))
    }
    const prompt = clean(result.text)
    if (!prompt) throw httpError(502, msg`${provider.name} · ${modelId} 没有写出提示词${result.stopReason ? msg`（${result.stopReason}）` : ''}：推理型模型可能把输出额度花在了思考上，辅助模型换个不带推理的快模型`)
    return { prompt: withStyle(prompt, cardMedia.style, media.promptStyle), model: `${provider.name} · ${modelId}`, note }
  }

  async function avatarOf(cardId) {
    try {
      return await readFile(store.avatarPath(cardId))
    } catch {
      return null
    }
  }

  async function openaiImage(media, prompt, cardId, signal, cast = null) {
    const providers = await store.getProviders()
    const provider = providers.find(p => p.id === media.imageProvider)
    if (!provider) throw httpError(400, msg`还没选生图的供应商：在「配图与朗读」里选`)
    if (provider.api === 'anthropic-messages') throw httpError(400, msg`${provider.name} 是 Anthropic 接口，没有生图接口`)
    if (!media.imageModel) throw httpError(400, msg`还没填生图模型`)
    const reference = media.imageReference ? (cast?.lead && (await refFor(cardId, cast.lead))) || (await avatarOf(cardId)) : null
    // OpenRouter draws through chat (Gemini and GPT image models answer with a picture).
    if (/openrouter\.ai/i.test(provider.baseURL)) return { buffer: await chatImage(provider, media, prompt, reference, signal), note: '' }
    const size = imageSize('openai', media.imageShape)
    const generate = () =>
      providerRequest(provider, '/images/generations', {
        body: { model: media.imageModel, prompt, n: 1, size, ...imageFormat(media.imageModel) },
        signal,
        proxy: proxyNow(),
      })
    let response
    let note = ''
    try {
      if (reference) {
        const editModel = media.imageEditModel || media.imageModel
        try {
          response = await editWithReference(provider, { model: editModel, prompt, size, reference }, signal)
        } catch (error) {
          // The model cannot edit (grok2api: a Web 2.0 route only generates and
          // answers 404 "模型不存在"); draw without the reference instead of failing.
          if (signal?.aborted || ![400, 404, 422].includes(error.providerStatus)) throw error
          response = await generate()
          note = msg`${editModel} 用不了参考图（${String(error.message).slice(0, 80)}），这张没带参考图。可以在「配图与朗读」里给参考图单独选一个能改图的模型（grok2api 的 Web 账号是 grok-imagine-image-edit）。`
        }
      } else {
        response = await generate()
      }
    } catch (error) {
      if (error.status || signal?.aborted) throw error
      throw httpError(502, imageError(provider, error))
    }
    let json
    try {
      json = JSON.parse(response.buffer.toString('utf8'))
    } catch {
      throw httpError(502, msg`${provider.name} 返回的不是图片结果`)
    }
    const item = json.data?.[0]
    if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), note }
    if (item?.url) {
      const url = new URL(item.url, provider.baseURL).href
      return { buffer: (await fetchBytes(url, { signal, proxy: provider.proxy === 'direct' ? null : proxyNow() })).buffer, note }
    }
    throw httpError(502, msg`${provider.name} 没有返回图片${json.error?.message ? msg`：${json.error.message}` : ''}`)
  }

  /**
   * /images/edits with the avatar as reference. JSON with a data URL first
   * (grok2api accepts nothing else); a server that wants the classic
   * multipart form gets it on the second try.
   */
  async function editWithReference(provider, { model, prompt, size, reference }, signal) {
    const dataUrl = `data:${reference[0] === 0xff ? 'image/jpeg' : 'image/png'};base64,${reference.toString('base64')}`
    try {
      return await providerRequest(provider, '/images/edits', {
        body: { model, prompt, n: 1, size, ...imageFormat(model), image: { url: dataUrl } },
        signal,
        proxy: proxyNow(),
      })
    } catch (error) {
      const wantsForm = error.providerStatus === 415 || /multipart|form-data|image.+file|must be a file/i.test(error.message)
      if (!wantsForm || signal?.aborted) throw error
      return providerRequest(provider, '/images/edits', {
        body: multipart({ model, prompt, n: '1', size, ...imageFormat(model), image: { buffer: reference, filename: 'reference.png', type: 'image/png' } }),
        signal,
        proxy: proxyNow(),
      })
    }
  }

  /**
   * An image model behind chat completions (OpenRouter: google/gemini-…-image,
   * openai/gpt-…-image): asked for an image answer, the reference picture in the
   * message when there is one.
   */
  async function chatImage(provider, media, prompt, reference, signal) {
    const content = reference
      ? [{ type: 'image_url', image_url: { url: `data:image/${extOf('', reference) === 'jpg' ? 'jpeg' : extOf('', reference)};base64,${reference.toString('base64')}` } }, { type: 'text', text: `${prompt}\n\nKeep the character's face, hair and body from the picture above.` }]
      : prompt
    let response
    try {
      response = await providerRequest(provider, '/chat/completions', {
        body: { model: media.imageModel, messages: [{ role: 'user', content }], modalities: ['image', 'text'], image_config: { aspect_ratio: ASPECT[media.imageShape] ?? '1:1' } },
        signal,
        proxy: proxyNow(),
      })
    } catch (error) {
      if (error.status || signal?.aborted) throw error
      throw httpError(502, imageError(provider, error))
    }
    let json
    try {
      json = JSON.parse(response.buffer.toString('utf8'))
    } catch {
      throw httpError(502, msg`${provider.name} 返回的不是图片结果`)
    }
    const message = json.choices?.[0]?.message
    const url = message?.images?.[0]?.image_url?.url ?? ''
    const data = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(url)?.[1]
    if (data) return Buffer.from(data, 'base64')
    if (/^https?:/.test(url)) return (await fetchBytes(url, { signal, proxy: provider.proxy === 'direct' ? null : proxyNow() })).buffer
    const said = typeof message?.content === 'string' ? message.content.trim().slice(0, 160) : ''
    throw httpError(502, msg`${provider.name} · ${media.imageModel} 没有返回图片${said ? msg`：${said}` : msg`：选一个能出图的模型（名字里带 image 的）`}`)
  }

  /**
   * Gemini's own image models (Nano Banana: generateContent answering with an
   * image). Cast members in the frame who have a reference picture go along
   * first (up to three), each named, so their faces stay the same.
   */
  async function geminiImage(media, prompt, cardId, signal, cast = null, { scenery = false } = {}) {
    const provider = (await store.getProviders()).find(p => p.id === media.geminiImageProvider)
    if (!provider) throw httpError(400, msg`还没选 Gemini 生图用的供应商：在「配图与朗读 → 画图方式」里选用「Gemini」模板建的那个`)
    if (provider.api === 'anthropic-messages') throw httpError(400, msg`${provider.name} 是 Anthropic 接口，没有生图接口`)
    const model = media.geminiImageModel || DEFAULT_MEDIA.geminiImageModel
    const parts = []
    if (media.geminiReference && !scenery && cardId) {
      for (const { entry } of cast?.characters ?? []) {
        if (parts.length >= 6) break
        const ref = await refFor(cardId, entry)
        if (!ref) continue
        const type = extOf('', ref) === 'jpg' ? 'jpeg' : extOf('', ref)
        parts.push({ text: `Reference picture of ${entry.name}: keep this face, hair and body in the new picture.` }, { inlineData: { mimeType: `image/${type}`, data: ref.toString('base64') } })
      }
    }
    parts.push({ text: prompt })
    const ask = config => googleRequest(provider, `/models/${model}:generateContent`, {
      body: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...config } },
      signal,
      proxy: proxyNow(),
    })
    let json
    try {
      try {
        json = await ask({ imageConfig: { aspectRatio: ASPECT[media.imageShape] ?? '1:1' } })
      } catch (error) {
        // An older model without aspect ratios: draw it square.
        if (error.providerStatus !== 400 || !/image_?config|aspect/i.test(error.message) || signal?.aborted) throw error
        json = await ask({})
      }
    } catch (error) {
      if (error.status || signal?.aborted) throw error
      const hint = error.providerStatus === 404 ? msg`（模型名不对，或者这个供应商不是 Google 的地址）` : ''
      throw httpError(502, `${imageError(provider, error)}${hint}`)
    }
    const candidate = json?.candidates?.[0]
    const image = candidate?.content?.parts?.find(part => part.inlineData?.data || part.inline_data?.data)
    if (image) return Buffer.from((image.inlineData ?? image.inline_data).data, 'base64')
    const said = (candidate?.content?.parts ?? []).map(part => part.text).filter(Boolean).join(' ').trim().slice(0, 160)
    const why = json?.promptFeedback?.blockReason || candidate?.finishReason || ''
    throw httpError(502, msg`${provider.name} · ${model} 没有画出图${why ? msg`（${why}）` : ''}${said ? msg`：${said}` : ''}`)
  }

  /**
   * Stable Diffusion WebUI or Forge (txt2img over its --api). The model is the
   * one loaded in the WebUI; a card's or a lone cast member's LoRA goes in the
   * prompt as <lora:name:strength>, with its trigger word.
   */
  async function sdwebuiImage(media, prompt, cardId, signal, cast = null, { scenery = false } = {}) {
    const cardMedia = cardId ? cleanCardMedia((await store.getCard(cardId)).media) : DEFAULT_CARD_MEDIA
    const owner = scenery ? null : cast ? (cast.solo?.lora ? cast.solo : null) : cardMedia.lora ? cardMedia : null
    if (owner) prompt = `${withTrigger(prompt, owner.loraTrigger)}, <lora:${owner.lora.replace(/^.*[\\/]/, '').replace(/\.(safetensors|pt|ckpt)$/i, '')}:${owner.loraStrength}>`
    const [width, height] = imageSize('sdwebui', media.imageShape).split('x').map(Number)
    const body = {
      prompt,
      negative_prompt: [media.sdNegative, scenery ? SCENERY_NEGATIVE : ''].filter(Boolean).join(', '),
      steps: media.sdSteps,
      cfg_scale: media.sdCfg,
      sampler_name: media.sdSampler,
      width,
      height,
      seed: -1,
      batch_size: 1,
      n_iter: 1,
    }
    let result
    try {
      result = await postJson(`${media.sdUrl}/sdapi/v1/txt2img`, body, { signal })
    } catch (error) {
      if (signal?.aborted) throw error
      if (/ECONNREFUSED/.test(String(error.message ?? error.code))) throw httpError(502, msg`连不上 SD WebUI：先打开 WebUI（启动参数加 --api），再确认地址（默认 http://127.0.0.1:7860）`)
      const hint = error.providerStatus === 404 ? msg`（WebUI 启动参数要加 --api）` : ''
      throw httpError(502, msg`SD WebUI：${String(error.message).slice(0, 200)}${hint}`)
    }
    let json
    try {
      json = JSON.parse(result.buffer.toString('utf8'))
    } catch {
      throw httpError(502, msg`SD WebUI 返回的不是图片结果`)
    }
    const first = json.images?.[0]
    if (typeof first !== 'string' || !first) throw httpError(502, msg`SD WebUI 没有返回图片`)
    return Buffer.from(first.replace(/^data:image\/[\w.+-]+;base64,/, ''), 'base64')
  }

  /** @param options.scenery - a background (scenes.mjs): no LoRA, no trigger word, a negative prompt that keeps people out. */
  async function comfyImage(media, prompt, cardId, signal, cast = null, { scenery = false } = {}) {
    const imported = await loadWorkflow()
    if (!imported) throw httpError(400, msg`还没导入 ComfyUI 工作流：在「配图与朗读」里导入「导出（API）」的 JSON`)
    // No card yet (a card being created): no card LoRA.
    const cardMedia = cardId ? cleanCardMedia((await store.getCard(cardId)).media) : DEFAULT_CARD_MEDIA
    // Several LoRAs in one picture bleed into each other: a named cast uses only a lone member's own.
    const owner = scenery ? null : cast ? (cast.solo?.lora ? cast.solo : null) : cardMedia.lora ? cardMedia : null
    const workflow = owner ? withLora(imported, { name: owner.lora, strength: owner.loraStrength }) : imported
    if (owner) prompt = withTrigger(prompt, owner.loraTrigger)
    const base = media.comfyUrl
    const [width, height] = imageSize('comfy', media.imageShape).split('x').map(Number)
    let reference = ''
    const needsReference = JSON.stringify(workflow).includes('{{reference}}')
    if (needsReference) {
      const avatar = (cast?.lead && (await refFor(cardId, cast.lead))) || (await avatarOf(cardId))
      if (!avatar) throw httpError(400, msg`工作流要参考图（{{reference}}），这张卡没有头像`)
      const upload = await postMultipart(`${base}/upload/image`, multipart({ image: { buffer: avatar, filename: `tavern-${cardId}.png`, type: 'image/png' }, overwrite: 'true' }), signal)
      reference = JSON.parse(upload.toString('utf8')).name
    }
    const filled = fillWorkflow(workflow, { prompt, negative: scenery ? SCENERY_NEGATIVE : '', seed: randomInt(1, 2 ** 31), width, height, reference })
    let queued
    try {
      queued = JSON.parse((await postJson(`${base}/prompt`, { prompt: filled, client_id: 'agent-tavern' }, { signal })).buffer.toString('utf8'))
    } catch (error) {
      if (signal?.aborted) throw error
      throw httpError(502, comfyError(error))
    }
    const id = queued.prompt_id
    if (!id) throw httpError(502, msg`ComfyUI 没接受这个工作流：${JSON.stringify(queued.node_errors ?? queued.error ?? queued).slice(0, 200)}`)
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted')
      await sleep(1500)
      const history = JSON.parse((await fetchBytes(`${base}/history/${id}`, { signal })).buffer.toString('utf8'))
      const entry = history[id]
      if (!entry) continue
      if (entry.status?.status_str === 'error') throw httpError(502, msg`ComfyUI 执行出错，去 ComfyUI 界面看看是哪个节点`)
      const image = Object.values(entry.outputs ?? {}).flatMap(out => out.images ?? []).find(img => img.type === 'output') ?? Object.values(entry.outputs ?? {}).flatMap(out => out.images ?? [])[0]
      if (image) {
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
        return (await fetchBytes(`${base}/view?${query}`, { signal })).buffer
      }
      if (entry.status?.completed) throw httpError(502, msg`ComfyUI 跑完了，但工作流没有输出图片（要有 SaveImage 或 PreviewImage 节点）`)
    }
    throw httpError(504, msg`ComfyUI 十分钟还没出图`)
  }

  async function postMultipart(url, form, signal) {
    const { buffer } = await postRaw(url, form, signal)
    return buffer
  }

  async function postRaw(url, form, signal) {
    try {
      return await providerRequest({ baseURL: url, api: 'openai-completions', apiKey: '', headers: {}, proxy: 'direct' }, '', { body: form, signal })
    } catch (error) {
      throw httpError(502, comfyError(error))
    }
  }

  function comfyError(error) {
    const text = String(error?.message ?? error)
    if (/ECONNREFUSED/.test(text)) return msg`连不上 ComfyUI：先打开 ComfyUI，再确认地址（默认 http://127.0.0.1:8188）`
    return msg`ComfyUI：${text.slice(0, 200)}`
  }

  // The persistent token lives in its own file, so /api/settings never carries it.
  const naiFile = path.join(store.dirs.root, 'novelai.json')

  async function naiToken() {
    try {
      return String(JSON.parse(await readFile(naiFile, 'utf8')).token ?? '')
    } catch {
      return ''
    }
  }

  /** What the page may know about the token. */
  async function naiStatus() {
    const token = await naiToken()
    return { hasToken: Boolean(token), tokenHint: token ? `…${token.slice(-4)}` : '' }
  }

  /** Save a pasted token; '' removes it. */
  async function setNaiToken(value) {
    if (value === '') await rm(naiFile, { force: true })
    else await writeFile(naiFile, JSON.stringify({ token: cleanNaiToken(value) }), 'utf8')
    return naiStatus()
  }

  const naiProvider = (baseURL, token) => ({ name: 'NovelAI', baseURL, api: 'openai-completions', apiKey: token, headers: {} })

  function naiError(error, model) {
    const status = error?.providerStatus
    const text = String(error?.message ?? error).slice(0, 200)
    if (status === 401) return msg`NovelAI 不认这个令牌：在 NovelAI 网页重新生成持久令牌，再到「配图与朗读」里粘贴。（${text}）`
    if (status === 402) return msg`NovelAI 要求付费：订阅没生效，或者这张超出了 Opus 的免费范围而 Anlas 不够。（${text}）`
    if (status === 429) return msg`NovelAI 一个账号同时只画一张，上一张还没画完，稍等再画。`
    if ((status === 400 || status === 404 || status >= 500) && /model/i.test(text)) return msg`NovelAI 不认模型 ${model}：在「配图与朗读」里换成 V4.5 试试。（${text}）`
    return providerError({ name: 'NovelAI' }, error)
  }

  async function naiSubscription(token, timeout = 20000) {
    const { buffer } = await providerRequest(naiProvider(naiImageUrl, token), '/user/subscription', { method: 'GET', proxy: proxyNow(), signal: AbortSignal.timeout(timeout) })
    return naiAccount(JSON.parse(buffer.toString('utf8')))
  }

  /** Subscription tier, Anlas and the V5 allowance, to check a token without drawing anything. */
  async function naiCheck(typed) {
    const token = typed ? cleanNaiToken(typed) : await naiToken()
    if (!token) throw httpError(400, msg`还没填 NovelAI 令牌`)
    try {
      return await naiSubscription(token)
    } catch (error) {
      throw httpError(502, naiError(error, ''))
    }
  }

  /**
   * V5 on Opus draws from an allowance that refills a little every hour; once
   * it is empty NovelAI takes Anlas instead. Read it before each V5 picture:
   * empty → V4.5 (free on Opus) unless the settings say to spend Anlas; low →
   * a note under the picture. When the lookup fails, draw as asked.
   */
  async function v5Plan(media, model, token) {
    if (!isV5(model)) return { model, note: '' }
    const account = await naiSubscription(token, 8000).catch(() => null)
    const v5 = account?.v5
    if (!v5) return { model, note: '' }
    const next = v5.nextPercentMinutes ? msg`，${waitText(v5.nextPercentMinutes)}后回 1%` : ''
    if (v5.empty) {
      if (media.naiV5Empty === 'anlas' && account.anlas > 0) return { model, note: msg`V5 额度用完了${next}，这张扣 Anlas 画（还剩 ${account.anlas}）。` }
      const why = media.naiV5Empty === 'anlas' ? msg`，Anlas 也没了` : ''
      return { model: referenceModel(model), note: msg`V5 额度用完了${next}${why}，这张改用 V4.5 画（Opus 不扣 Anlas）。` }
    }
    if (v5.percent <= V5_LOW) return { model, note: msg`V5 额度只剩 ${v5.percent}%${next}。用完后${media.naiV5Empty === 'anlas' ? msg`扣 Anlas 画` : msg`自动改用 V4.5`}。` }
    return { model, note: '' }
  }

  async function naiImage(media, prompt, signal, cast = null, cardId = '') {
    const token = await naiToken()
    if (!token) throw httpError(400, msg`还没填 NovelAI 令牌：在「配图与朗读」里把画图用改成 NovelAI，粘贴持久令牌`)
    const [width, height] = imageSize('novelai', media.imageShape).split('x').map(Number)
    // The card's look first on every picture, weighted up ({{ }}) so a long scene doesn't drown it;
    // taken out of the prompt where it was written in, so it isn't there twice.
    const card = cardId ? cleanCardMedia((await store.getCard(cardId).catch(() => ({}))).media ?? {}) : DEFAULT_CARD_MEDIA
    const scene = cast ? { ...cast, scene: unstyled(cast.scene, card.style) } : null
    const base = scene ? [countTags(scene.characters), scene.scene].filter(Boolean).join(', ') : unstyled(prompt, card.style)
    const positive = [card.style ? `{{${card.style}}}` : '', base.replace(/[,，\s]+$/, ''), media.naiQuality].filter(Boolean).join(', ')
    const negative = [media.naiNegative, card.styleNegative].filter(Boolean).join(', ')
    let model = media.naiModel
    let reference = null
    // A model picked for this one picture is used as picked: a reference picture only goes along when it can take one (V4.5).
    const canRefer = !media.naiModelPicked || /^nai-diffusion-4-5-/.test(model)
    const picture = media.naiReference && canRefer && cast?.lead ? await refFor(cardId, cast.lead) : null
    if (picture) {
      model = referenceModel(model)
      reference = { image: picture.toString('base64'), fidelity: media.naiRefFidelity, style: media.naiRefStyle }
    }
    const characters = cast ? naiCharacters(cast) : []
    const seed = randomInt(1, 2 ** 32 - 1)
    const plan = await v5Plan(media, model, token)
    model = plan.model
    let note = plan.note
    for (let attempt = 0; ; attempt++) {
      const body = naiRequest({ model, prompt: positive, negative, width, height, seed, characters, reference })
      const label = `NovelAI · ${model}${reference ? msg` · 人设图：${cast.lead.name}` : ''}`
      try {
        const { buffer } = await providerRequest(naiProvider(naiImageUrl, token), '/ai/generate-image', { body, signal, proxy: proxyNow() })
        return { buffer: unzipFirst(buffer), label, note }
      } catch (error) {
        if (signal?.aborted || error.status) throw error
        // One generation at a time per account: wait for the one in flight.
        if (error.providerStatus === 429 && attempt < 2) {
          await sleep(4000)
          continue
        }
        // A reference picture costs Anlas even on Opus: without any, draw it plain rather than not at all.
        if (error.providerStatus === 402 && reference) {
          note = msg`NovelAI 的 Anlas 不够（带人设图每张 5 Anlas），这张没带「${cast.lead.name}」的人设图。`
          reference = null
          model = media.naiModel
          await sleep(4000)
          continue
        }
        // V5 past its allowance with no Anlas left (or the lookup missed it): V4.5 is free on Opus.
        if (error.providerStatus === 402 && isV5(model)) {
          note = msg`V5 额度用完、Anlas 也不够，这张改用 V4.5 画。`
          model = referenceModel(model)
          await sleep(4000)
          continue
        }
        throw httpError(502, error.providerStatus ? naiError(error, model) : msg`NovelAI：${String(error.message).slice(0, 200)}`)
      }
    }
  }

  // ─── Cast ───────────────────────────────────────────────────────────
  // Reference pictures live next to the card: cards/<id>/roster/<entry id>.png.

  const rosterDir = cardId => path.join(path.dirname(store.avatarPath(cardId)), 'roster')
  function refFile(cardId, entryId) {
    if (!isRosterId(entryId)) throw httpError(400, msg`角色编号不对`)
    return path.join(rosterDir(cardId), `${entryId}.png`)
  }

  async function rosterRef(cardId, entryId) {
    try {
      return await readFile(refFile(cardId, entryId))
    } catch {
      return null
    }
  }

  /** The picture that keeps someone's looks: one riding along with them (a 立绘 for its expressions), else their roster picture. */
  async function refFor(cardId, entry) {
    if (Buffer.isBuffer(entry?.picture)) return entry.picture
    return entry?.id ? rosterRef(cardId, entry.id) : null
  }

  async function readRosterRef(cardId, entryId) {
    const data = await rosterRef(cardId, entryId)
    if (!data) throw httpError(404, msg`这个角色还没有人设图`)
    return data
  }

  /** A picture from the page (already padded to NovelAI's reference canvas there) as a data URL. */
  async function saveRosterRef(cardId, entryId, dataUrl) {
    await store.getCard(cardId)
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
    if (!match) throw httpError(400, msg`人设图要是 PNG、JPG 或 WebP`)
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length > 15 * 1024 * 1024) throw httpError(400, msg`人设图太大（最多 15MB）`)
    await mkdir(rosterDir(cardId), { recursive: true })
    await writeFile(refFile(cardId, entryId), buffer)
    return { ref: true }
  }

  async function removeRosterRef(cardId, entryId) {
    await rm(refFile(cardId, entryId), { force: true })
    return { ref: false }
  }

  /** The card's media settings with which cast members have a reference picture. */
  async function cardMediaView(cardId) {
    const value = cleanCardMedia((await store.getCard(cardId)).media)
    const roster = await Promise.all(value.roster.map(async entry => ({ ...entry, ref: Boolean(await rosterRef(cardId, entry.id)) })))
    return { ...value, roster }
  }

  /** Save the form; pictures of members no longer on the roster go too. */
  async function saveCardMedia(cardId, body) {
    const card = await store.getCard(cardId)
    card.media = cleanCardMedia(body, card.media)
    await store.saveCard(card)
    const keep = new Set(card.media.roster.map(entry => `${entry.id}.png`))
    let files = []
    try {
      files = await readdir(rosterDir(cardId))
    } catch {
      // no pictures yet
    }
    await Promise.all(files.filter(file => !keep.has(file)).map(file => rm(path.join(rosterDir(cardId), file), { force: true })))
    return cardMediaView(cardId)
  }

  /** Copy a card's picture and voice settings, cast and reference pictures onto another card (a new version of it). */
  async function inheritCardMedia(fromId, toId) {
    const [from, to] = await Promise.all([store.getCard(fromId), store.getCard(toId)])
    to.media = cleanCardMedia(from.media ?? {})
    await store.saveCard(to)
    let files = []
    try {
      files = await readdir(rosterDir(fromId))
    } catch {
      // no pictures
    }
    if (files.length) await mkdir(rosterDir(toId), { recursive: true })
    await Promise.all(files.map(file => copyFile(path.join(rosterDir(fromId), file), path.join(rosterDir(toId), file))))
    return to.media
  }

  /** A first roster from the card and its lore, written by the helper model; not saved. */
  async function draftRoster(cardId, signal) {
    const media = await settings()
    const card = await store.getCard(cardId)
    const books = await Promise.all((card.worldbookIds ?? []).map(id => store.getBook(id).catch(() => null)))
    const { provider, modelId } = await helperTarget({ model: '' }, media)
    let result
    try {
      result = await complete(provider, modelId, { ...rosterDraftRequest(draftMaterial(card, books.filter(Boolean))), signal }, { proxy: proxyNow() })
    } catch (error) {
      if (error.status) throw error
      throw httpError(502, providerError(provider, error))
    }
    const roster = parseRosterDraft(result.text)
    if (!roster.length) throw httpError(502, msg`${provider.name} · ${modelId} 没有列出角色${result.stopReason ? msg`（${result.stopReason}）` : ''}，可以再试一次，或者手动添加`)
    // The card LoRA most likely belongs to the character the card is named after.
    const current = cleanCardMedia(card.media)
    if (current.lora) {
      const owner = roster.find(entry => !entry.player && card.name.includes(entry.name))
      if (owner) Object.assign(owner, { lora: current.lora, loraTrigger: current.loraTrigger, loraStrength: current.loraStrength })
    }
    return { roster, model: `${provider.name} · ${modelId}` }
  }

  /** The settings with the 画图方式 and model picked for one picture, if any (withDrawChoice). */
  async function settingsFor(choice) {
    return withDrawChoice(await settings(), choice, backends)
  }

  /** Generate one image for a reply and record it on the node; `backend` and `model` for this one only. */
  async function generateImage(chat, nodeId, prompt, signal, { model = '', backend: method = '' } = {}) {
    const text = String(prompt ?? '').trim()
    if (!text) throw httpError(400, msg`提示词是空的`)
    const media = await settingsFor({ backend: method, model })
    const { roster } = cleanCardMedia((await store.getCard(chat.cardId)).media)
    const frame = roster.length && isFramePrompt(text) ? parseFrame(text, roster, chat.names?.user) : null
    const cast = frame?.characters.length ? { ...frame, solo: frame.characters.length === 1 ? frame.characters[0].entry : null, lead: leadOf(frame.characters) } : null
    const { buffer, note, backend } = await render(media, chat.cardId, frame, cast, text, signal)
    const file = `${newId()}.${extOf('', buffer)}`
    await mkdir(mediaDir(chat.id), { recursive: true })
    await writeFile(path.join(mediaDir(chat.id), file), buffer)
    return { file, prompt: text, backend, at: new Date().toISOString(), ...(note ? { note } : {}) }
  }

  /**
   * One picture from whichever backend is chosen.
   * @param options.scenery - a background with nobody in it (comfyImage).
   */
  // NovelAI draws one picture at a time per account: a second request while one runs is refused.
  let naiTail = Promise.resolve()
  function naiAlone(fn) {
    const run = naiTail.then(fn, fn)
    naiTail = run.catch(() => {})
    return run
  }

  /**
   * @param options.references - what this install's own backends get to keep faces
   *   the same: 'all' (the cast's reference pictures, else the card's avatar
   *   when the picture is of the card's own character), 'cast' (only theirs), 'none'.
   */
  async function render(media, cardId, frame, cast, text, signal, { scenery = false, references = 'all' } = {}) {
    // Backends without per-character prompts get the cast written out in one prompt.
    const flat = cast ? flattenFrame(cast, media.promptStyle) : frame ? frame.scene : text
    const own = ownBackends.find(item => item.id === media.imageBackend)
    if (own) {
      const pictures = scenery || references === 'none' ? [] : await castPictures(cardId, cast, { avatar: references === 'all' })
      const { buffer, label, note = '' } = await own.draw({ prompt: flat, shape: media.imageShape, references: pictures, model: media.localModels?.[own.id] ?? '', signal })
      return { buffer, note, backend: label }
    }
    if (media.imageBackend === 'comfy') {
      const buffer = await comfyImage(media, flat, cardId, signal, cast, { scenery })
      // A workflow built around a reference picture puts the card's picture into the background too.
      const referenced = scenery && describeWorkflow(await loadWorkflow().catch(() => null))?.placeholders.includes('reference')
      return { buffer, note: referenced ? msg`这个 ComfyUI 工作流要参考图，背景里可能会出现人物` : '', backend: 'ComfyUI' }
    }
    if (media.imageBackend === 'novelai') {
      const { buffer, label, note } = await naiAlone(() => {
        if (signal?.aborted) throw new Error('aborted')
        return naiImage(media, flat, signal, cast, cardId)
      })
      return { buffer, note, backend: label }
    }
    if (media.imageBackend === 'gemini') return { buffer: await geminiImage(media, flat, cardId, signal, cast, { scenery }), note: '', backend: media.geminiImageModel }
    if (media.imageBackend === 'sdwebui') return { buffer: await sdwebuiImage(media, flat, cardId, signal, cast, { scenery }), note: '', backend: 'SD WebUI' }
    const { buffer, note } = await openaiImage(media, flat, cardId, signal, cast)
    return { buffer, note, backend: media.imageReference && !note ? media.imageEditModel || media.imageModel : media.imageModel }
  }

  /**
   * Reference pictures for a picture of `cast`: its members' (four at most), else
   * with `avatar` the card's avatar, when no cast is named or the lead is the
   * card's own character.
   */
  async function castPictures(cardId, cast, { avatar = true } = {}) {
    if (!cardId) return []
    const pictures = []
    for (const { entry } of cast?.characters ?? []) {
      if (pictures.length >= 4) break
      const ref = await refFor(cardId, entry)
      if (ref) pictures.push(ref)
    }
    if (pictures.length || !avatar) return pictures
    const card = await store.getCard(cardId).catch(() => null)
    const lead = cast?.lead
    const own = !lead || [lead.name, ...String(lead.aliases ?? '').split(/[,，、]/)].map(name => name.trim()).some(name => name && card?.name.includes(name))
    const picture = own ? await avatarOf(cardId) : null
    return picture ? [picture] : []
  }

  /**
   * A reference picture for a cast member drawn from their looks and usual
   * outfit: one person, upper body, plain background, no reference of its
   * own. Returned to the page, which pads it like an upload.
   */
  async function drawPortrait(cardId, input, signal, { model = '', backend: method = '' } = {}) {
    await store.getCard(cardId)
    const [entry] = cleanRoster([input])
    if (!entry?.looks) throw httpError(400, msg`先写这个角色的长相，再画人设图`)
    const media = await settingsFor({ backend: method, model })
    const cast = { scene: PORTRAIT_SCENE, characters: [{ entry, action: [entry.outfit, 'standing'].filter(Boolean).join(', '), position: '' }], solo: entry, lead: entry }
    const plain = { ...media, imageShape: 'portrait', naiReference: false, imageReference: false, geminiReference: false, naiNegative: [media.naiNegative, 'nsfw, multiple views, text'].filter(Boolean).join(', '), sdNegative: [media.sdNegative, 'nsfw, multiple views, text'].filter(Boolean).join(', ') }
    const { buffer, backend } = await render(plain, cardId, cast, cast, '', signal, { references: 'none' })
    const type = extOf('', buffer) === 'jpg' ? 'jpeg' : extOf('', buffer)
    return { image: `data:image/${type};base64,${buffer.toString('base64')}`, backend }
  }

  /**
   * A 立绘 for the visual novel mode: one cast member, half-body, on white,
   * with their reference picture as configured (so it stays the same face).
   * → { buffer, backend, note }
   */
  async function drawSprite(cardId, entryId, signal) {
    const { roster } = cleanCardMedia((await store.getCard(cardId)).media)
    const entry = roster.find(item => item.id === entryId)
    if (!entry) throw httpError(404, msg`名单里没有这个角色`)
    if (!entry.looks) throw httpError(400, msg`先在「配图 → 角色名单」里写${entry.name}的长相，再画立绘`)
    const media = await settings()
    const cast = { scene: SPRITE_SCENE, characters: [{ entry, action: [entry.outfit, 'standing'].filter(Boolean).join(', '), position: '' }], solo: entry, lead: entry }
    const plain = { ...media, imageShape: 'portrait', naiNegative: [media.naiNegative, SPRITE_NEGATIVE].filter(Boolean).join(', '), sdNegative: [media.sdNegative, SPRITE_NEGATIVE].filter(Boolean).join(', ') }
    return render(plain, cardId, cast, cast, '', signal)
  }

  /**
   * One expression of a 立绘 (视觉小说 表情差分): the 立绘 itself, else the cast
   * member's reference picture, goes along as the picture to keep, and only the
   * face is to change. SD WebUI and a ComfyUI workflow without a reference
   * picture draw it anew from the looks. → { buffer, backend, note }
   */
  async function drawExpression(cardId, entryId, expression, base, signal) {
    const look = EXPRESSION_LOOK[expression]
    if (!look) throw httpError(404, msg`没有这种表情`)
    const { roster } = cleanCardMedia((await store.getCard(cardId)).media)
    const entry = roster.find(item => item.id === entryId)
    if (!entry) throw httpError(404, msg`名单里没有这个角色`)
    const picture = base ?? (await rosterRef(cardId, entryId))
    if (!picture) throw httpError(400, msg`先给${entry.name}画或上传立绘，再画表情`)
    const media = await settings()
    const tags = media.promptStyle === 'tags'
    const scene = tags
      ? `${SPRITE_SCENE}, same character, same outfit, same pose`
      : `Edit the reference picture of ${entry.name}: keep the same character, face, hair, outfit, pose, framing, art style and the plain white background; change only the facial expression, to ${look.words}`
    const lead = { ...entry, picture }
    const cast = { scene, characters: [{ entry: lead, action: tags ? [entry.outfit, look.tags].filter(Boolean).join(', ') : `with ${look.words}`, position: '' }], solo: lead, lead }
    const plain = { ...media, imageShape: 'portrait', imageReference: true, geminiReference: true, naiReference: true, naiNegative: [media.naiNegative, SPRITE_NEGATIVE].filter(Boolean).join(', '), sdNegative: [media.sdNegative, SPRITE_NEGATIVE].filter(Boolean).join(', ') }
    const result = await render(plain, cardId, cast, cast, '', signal, { references: 'cast' })
    const fresh = media.imageBackend === 'sdwebui' || (media.imageBackend === 'comfy' && !describeWorkflow(await loadWorkflow().catch(() => null))?.placeholders.includes('reference'))
    const note = fresh ? msg`这种画图方式不能照着立绘改，表情是按长相重新画的，可能和立绘不太一样。` : ''
    return { ...result, note: [result.note, note].filter(Boolean).join(' ') }
  }

  /**
   * 用辅助模型判断表情: the helper labels each spoken line of a reply with its
   * speaker's expression. `lines`: { speaker, text } or null per step.
   * → { labels: expression or null per step }
   */
  async function labelExpressions(lines, signal) {
    const list = (Array.isArray(lines) ? lines : []).slice(0, 400).map(line => (line && typeof line.text === 'string' && typeof line.speaker === 'string' ? { speaker: line.speaker, text: line.text } : null))
    if (!list.some(Boolean)) return { labels: list.map(() => null) }
    const media = await settings()
    const { provider, modelId } = await helperTarget({ model: '' }, media)
    let result
    try {
      result = await complete(provider, modelId, { ...expressionRequest(list), signal }, { proxy: proxyNow() })
    } catch (error) {
      if (error.status) throw error
      throw httpError(502, providerError(provider, error))
    }
    return { labels: parseExpressionLabels(result.text, list.length) }
  }

  /**
   * A picture of one character for a card that does not exist yet (创作角色卡):
   * looks and outfit as a cast member, the scene as given (else a plain upper
   * body). No references, no card LoRA. Returns { buffer, backend }.
   */
  async function drawCardArt(input, signal, choice = {}) {
    const [entry] = cleanRoster([{ name: input?.name || '角色', kind: input?.kind, looks: input?.looks, outfit: input?.outfit }])
    if (!entry?.looks) throw httpError(400, msg`还没有这个角色的长相描述`)
    const media = await settingsFor(choice)
    const scene = typeof input.scene === 'string' && input.scene.trim() ? input.scene.trim().slice(0, 400) : PORTRAIT_SCENE
    const cast = { scene, characters: [{ entry, action: [entry.outfit, 'looking at viewer'].filter(Boolean).join(', '), position: '' }], solo: entry, lead: entry }
    const plain = { ...media, imageShape: 'portrait', naiReference: false, imageReference: false, geminiReference: false, naiNegative: [media.naiNegative, 'nsfw, multiple views, text'].filter(Boolean).join(', '), sdNegative: [media.sdNegative, 'nsfw, multiple views, text'].filter(Boolean).join(', ') }
    return render(plain, null, cast, cast, '', signal, { references: 'none' })
  }

  /**
   * Who a saved card's avatar shows, and how they look: the card's own character
   * in its cast (looks and outfit), else one the helper model reads from the
   * card and its lore (as 草拟名册 does), else the description as it is.
   * → { entry, from: 'roster' | 'draft' | 'description', model? }
   */
  async function avatarSubject(card, media, signal) {
    const names = entry => [entry.name, ...String(entry.aliases ?? '').split(/[,，、]/)].map(name => name.trim()).filter(Boolean)
    const own = list => list.find(entry => !entry.player && entry.looks && names(entry).some(name => card.name.includes(name) || name.includes(card.name)))
    const drawable = list => list.filter(entry => !entry.player && entry.looks)
    const cast = cleanCardMedia(card.media).roster
    // The card's own character, or the only one the cast has.
    const listed = own(cast) ?? (drawable(cast).length === 1 ? drawable(cast)[0] : null)
    if (listed) return { entry: listed, from: 'roster' }
    let target = null
    try {
      target = await helperTarget({ model: '' }, media)
    } catch {
      // No helper model: the description it is.
    }
    if (target) {
      const books = await Promise.all((card.worldbookIds ?? []).map(id => store.getBook(id).catch(() => null)))
      try {
        const result = await complete(target.provider, target.modelId, { ...rosterDraftRequest(draftMaterial(card, books.filter(Boolean))), signal }, { proxy: proxyNow() })
        const drafted = parseRosterDraft(result.text)
        const entry = own(drafted) ?? drawable(drafted)[0]
        if (entry) return { entry, from: 'draft', model: `${target.provider.name} · ${target.modelId}` }
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    const looks = String(card.description ?? '').replace(/\{\{char\}\}/gi, card.name).replace(/\s+/g, ' ').trim().slice(0, 400)
    if (!looks) throw httpError(400, msg`这张卡没有描述，名册里也没有长相：先在「配图与朗读 → 角色名册」里写长相`)
    return { entry: cleanRoster([{ name: card.name, kind: 'other', looks }])[0], from: 'description' }
  }

  /**
   * An avatar for a saved card (修改角色卡 → 生成头像): its own character, face
   * and shoulders, square, in the card's style. Not saved: the page shows it to
   * take or draw again. → { image (data URL), backend, from, note }
   */
  async function drawAvatar(cardId, signal, choice = {}) {
    const card = await store.getCard(cardId)
    const media = await settingsFor(choice)
    const { entry, from, model } = await avatarSubject(card, media, signal)
    const { style } = cleanCardMedia(card.media)
    const cast = { scene: [style, AVATAR_SCENE].filter(Boolean).join(', '), characters: [{ entry, action: [entry.outfit, 'looking at viewer'].filter(Boolean).join(', '), position: '' }], solo: entry, lead: entry }
    const plain = { ...media, imageShape: 'square', naiReference: false, imageReference: false, geminiReference: false, naiNegative: [media.naiNegative, AVATAR_NEGATIVE].filter(Boolean).join(', '), sdNegative: [media.sdNegative, AVATAR_NEGATIVE].filter(Boolean).join(', ') }
    const { buffer, backend, note } = await render(plain, cardId, cast, cast, '', signal, { references: 'cast' })
    const type = extOf('', buffer) === 'jpg' ? 'jpeg' : extOf('', buffer)
    const how = from === 'draft' ? msg`名册里没有${card.name}的长相，这次由 ${model} 从卡里读出来画。` : from === 'description' ? msg`名册里没有${card.name}的长相，这次照着描述画；在「角色名册」里写好长相会更准。` : ''
    return { image: `data:image/${type};base64,${buffer.toString('base64')}`, backend, from, note: [note, how].filter(Boolean).join(' ') }
  }

  /**
   * A background for a place (scenes.mjs): the helper writes the prompt from the
   * place, its worldbook text, the card's setting and style; landscape, no
   * reference pictures, no LoRA. Without a helper, a plain prompt for sentence
   * style; tag style needs one. → { buffer, prompt, backend, note }
   */
  async function drawScenery({ cardId, place, lore = '', prompt = '', passage = '' }, signal) {
    const media = await settings()
    const card = await store.getCard(cardId)
    const cardMedia = cleanCardMedia(card.media)
    let text = String(prompt ?? '').trim()
    let named = ''
    if (!text) {
      let target = null
      try {
        target = await helperTarget({ model: '' }, media)
      } catch (error) {
        if (media.promptStyle === 'tags') throw error
      }
      if (target) {
        const { provider, modelId } = target
        const request = sceneryPromptRequest({ place, lore, passage, setting: card.scenario, style: cardMedia.style, promptStyle: media.promptStyle })
        let result
        try {
          result = await complete(provider, modelId, { ...request, signal }, { proxy: proxyNow() })
        } catch (error) {
          if (error.status) throw error
          throw httpError(502, providerError(provider, error))
        }
        const answer = passage ? readSceneryAnswer(result.text) : { place: '', prompt: result.text }
        named = answer.place
        text = cleanPrompt(answer.prompt, media.promptStyle)
        if (!text) throw httpError(502, msg`${provider.name} · ${modelId} 没有写出场景提示词`)
      } else if (passage && !place) {
        throw httpError(400, msg`按这一轮画场景要辅助模型读回复：在「配图与朗读」里选一个辅助模型`)
      } else {
        text = `A visual novel background of ${place}: the empty place, a wide eye-level view, soft natural light.`
      }
      text = withStyle(ensureScenery(text, media.promptStyle), cardMedia.style, media.promptStyle)
    }
    const plain = { ...media, imageShape: 'landscape', imageReference: false, naiReference: false, naiNegative: [media.naiNegative, SCENERY_NEGATIVE].filter(Boolean).join(', ') }
    const { buffer, note, backend } = await render(plain, cardId, null, null, text, signal, { scenery: true })
    return { buffer, prompt: text, backend, note, place: named }
  }

  /** 主题 → 对话修改: a picture behind the page from the talk's prompt, landscape, nobody in it, no card's look. */
  async function drawBackdrop(prompt, signal) {
    const media = await settings()
    const text = ensureScenery(String(prompt ?? '').trim(), media.promptStyle)
    const plain = { ...media, imageShape: 'landscape', imageReference: false, naiReference: false, geminiReference: false, naiNegative: [media.naiNegative, SCENERY_NEGATIVE].filter(Boolean).join(', ') }
    const { buffer, backend } = await render(plain, null, null, null, text, signal, { scenery: true, references: 'none' })
    return { buffer, backend }
  }

  async function readImage(chatId, file) {
    if (!FILE.test(file)) throw httpError(400, msg`文件名不对`)
    return readFile(path.join(mediaDir(chatId), file))
  }

  async function removeImage(chatId, file) {
    if (!FILE.test(file)) throw httpError(400, msg`文件名不对`)
    await rm(path.join(mediaDir(chatId), file), { force: true })
  }

  async function removeChatMedia(chatId) {
    await rm(mediaDir(chatId), { recursive: true, force: true })
  }

  /** Copy the images a forked chat keeps; a missing file is skipped. */
  async function copyChatMedia(fromId, toId, files) {
    const wanted = files.filter(file => FILE.test(file))
    if (!wanted.length) return
    await mkdir(mediaDir(toId), { recursive: true })
    await Promise.all(wanted.map(file => copyFile(path.join(mediaDir(fromId), file), path.join(mediaDir(toId), file)).catch(() => {})))
  }

  /** LoRA files ComfyUI can load (for the per-card picker); empty when it is not running. */
  async function loras() {
    const media = await settings()
    try {
      const list = JSON.parse((await fetchBytes(`${media.comfyUrl}/models/loras`, { signal: AbortSignal.timeout(4000) })).buffer.toString('utf8'))
      return { ok: true, loras: Array.isArray(list) ? list.filter(name => typeof name === 'string') : [] }
    } catch {
      return { ok: false, loras: [] }
    }
  }

  // ─── Voice ──────────────────────────────────────────────────────────
  // The sources live in voice/; media keeps the settings they read.

  /**
   * One chunk of speech as { buffer, mime }, cached by source + model + voice
   * + text; fresh synthesises again and replaces the cached take.
   */
  const speak = (request, signal) => voices.speak(request, signal)

  /** The voice settings as the form shows them: its fields over the saved ones, typed keys over the saved keys. */
  async function voiceDraft(draft, keys) {
    const typed = {}
    for (const [id, value] of Object.entries(keys && typeof keys === 'object' ? keys : {})) {
      if (KEYED.includes(id) && typeof value === 'string' && value.trim()) typed[id] = cleanVoiceKey(value)
    }
    const media = draft && typeof draft === 'object' ? cleanMedia(draft, await settings(), defaults) : await settings()
    return { media, keys: typed }
  }

  /** 试听 with the settings as the form shows them. */
  async function previewVoice({ voice, source, text, media: draft, keys = {} }, signal) {
    return voices.preview({ voice, source, text, draft: await voiceDraft(draft, keys) }, signal)
  }

  /** 从账户读取音色 with the form's list and key; nothing is saved. */
  async function accountVoices({ source, media: draft, keys = {} }, signal) {
    return voices.accountVoices({ source, draft: await voiceDraft(draft, keys) }, signal)
  }

  return { defaults, settings, cleanSettings, ownBackends: ownBackendViews, naiStatus, setNaiToken, naiCheck, cardMediaView, saveCardMedia, inheritCardMedia, draftRoster, drawPortrait, drawCardArt, drawAvatar, drawScenery, drawBackdrop, drawSprite, drawExpression, labelExpressions, readRosterRef, saveRosterRef, removeRosterRef, writeImagePrompt, generateImage, readImage, removeImage, removeChatMedia, copyChatMedia, loras, voices: voices.list, personaList: voices.personaList, ttsKeyStatus: voices.ttsKeyStatus, setTtsKey: voices.setTtsKey, voiceKeys: voices.keyStatus, setVoiceKey: voices.setKey, speak, previewVoice, accountVoices, loadWorkflow, saveWorkflow, describeWorkflow }
}
