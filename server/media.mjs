// Pictures and voice for a reply, on demand. Nothing here enters the model's
// context, so prompt caching is unaffected.
// - Image prompt: a helper model (a provider model, never the subscription)
//   describes the scene from the reply, the card's looks and the scene variables.
// - Image: an OpenAI-compatible images endpoint of a provider (e.g. a local
//   grok2api), optionally with the card's avatar as reference, or a ComfyUI
//   workflow with {{prompt}} / {{negative}} / {{seed}} / {{width}} / {{height}}
//   / {{reference}} placeholders, or NovelAI's image API (its persistent
//   token kept server-side in novelai.json, never sent to the page).
// - Voice: a voice service speaking the xiaoya bridge's protocol (/api/tts →
//   WAV; the local bridge on this machine's own install, nothing by default
//   elsewhere), proxied so a phone on the LAN can play it, cached by voice +
//   text. Browser voices (Web Speech) never reach the server.
import { createHash, randomInt } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { complete, fetchBytes, isProviderRef, postJson, providerError, providerRequest, refLabel, resolveRef } from './providers.mjs'
import { cleanFrame, cleanLora, cleanRoster, cleanStrength, countTags, draftMaterial, flattenFrame, frameFormat, isFramePrompt, isRosterId, leadOf, naiCharacters, parseFrame, parseRosterDraft, rosterBrief, rosterDraftRequest } from './roster.mjs'
import { httpError, newId } from './store.mjs'

export const DEFAULT_MEDIA = Object.freeze({
  helperModel: '', // provider ref that writes image prompts; empty = the chat's model when it is a provider
  promptSource: 'helper', // 'helper': a short standalone request; 'chat': asked at the end of the conversation (cache hits)
  imageBackend: 'openai', // 'openai' | 'comfy' | 'novelai'
  imageProvider: '', // provider id whose base URL serves /images/generations
  imageModel: '',
  imageShape: 'square', // 'square' | 'portrait' | 'landscape'; pixel size per backend (imageSize)
  imageReference: false, // send the card avatar through /images/edits
  imageEditModel: '', // model for /images/edits; empty = imageModel (some gateways split generate and edit models)
  promptStyle: 'natural', // 'natural' sentences or comma-separated 'tags' (SD-style workflows)
  comfyUrl: 'http://127.0.0.1:8188',
  naiModel: 'nai-diffusion-5-full',
  naiQuality: 'very aesthetic, masterpiece, no text', // appended to every NovelAI prompt
  naiReference: true, // a frame with one cast member who has a reference picture: V4.5 with it (+5 Anlas)
  naiRefFidelity: 0.8,
  naiRefStyle: false, // also take the reference picture's drawing style
  naiV5Empty: 'v45', // V5 allowance used up: 'v45' draws with V4.5 (free on Opus), 'anlas' spends Anlas on V5
  naiNegative: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  ttsUrl: 'http://127.0.0.1:8765',
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
  // All within Opus's free size (at most 1024×1024 pixels).
  novelai: { square: '1024x1024', portrait: '832x1216', landscape: '1216x832' },
}
export const NAI_MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']

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
 */
export function cleanMedia(input, previous = DEFAULT_MEDIA, defaults = DEFAULT_MEDIA) {
  const value = { ...defaults, ...previous }
  const source = input && typeof input === 'object' ? input : {}
  const text = (key, max = 200) => {
    if (typeof source[key] === 'string') value[key] = source[key].trim().slice(0, max)
  }
  text('helperModel')
  text('imageProvider', 40)
  text('imageModel')
  text('imageEditModel')
  if (['openai', 'comfy', 'novelai'].includes(source.imageBackend)) value.imageBackend = source.imageBackend
  if (typeof source.naiModel === 'string') {
    const model = source.naiModel.trim()
    if (!/^nai-diffusion-[a-z0-9-]{1,40}$/.test(model)) throw httpError(400, 'NovelAI 模型名不对（例如 nai-diffusion-5-full）')
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
  for (const key of ['comfyUrl', 'ttsUrl']) {
    if (typeof source[key] !== 'string') continue
    const url = source[key].trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(url)) throw httpError(400, `${key === 'comfyUrl' ? 'ComfyUI' : '语音服务'}地址不对`)
    value[key] = url || defaults[key]
  }
  if (source.naiV5Empty === 'v45' || source.naiV5Empty === 'anlas') value.naiV5Empty = source.naiV5Empty
  for (const key of ['imageReference', 'autoRead', 'autoImage', 'naiReference', 'naiRefStyle']) if (typeof source[key] === 'boolean') value[key] = source[key]
  return value
}

export function cleanCardMedia(input, previous = DEFAULT_CARD_MEDIA) {
  const value = { ...DEFAULT_CARD_MEDIA, ...previous }
  for (const key of ['voice', 'narratorVoice']) if (typeof input?.[key] === 'string') value[key] = input[key].trim().slice(0, 80)
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
  if (!loaderId) throw httpError(400, '工作流里没有 Load Checkpoint 节点，加不了 LoRA')
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
    return `${provider.name} 拒绝画这张：多半是提示词或参考图没过它的内容审核。改掉敏感的描述再画，或者在「配图与朗读」里关掉参考图试试。（${text.slice(0, 160)}）`
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
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw httpError(400, '工作流必须是 ComfyUI「导出（API）」的 JSON')
  const nodes = Object.values(json)
  if (!nodes.length || !nodes.every(n => n && typeof n === 'object' && n.class_type)) throw httpError(400, '这不是 API 格式的工作流：在 ComfyUI 里用「导出（API）」')
  if (!JSON.stringify(json).includes('{{prompt}}')) throw httpError(400, '工作流里没有 {{prompt}} 占位符：把正向提示词节点的文本改成 {{prompt}}')
  return json
}

// A cast member's reference picture: one person, nothing else to copy from it.
const PORTRAIT_SCENE = 'solo, upper body, looking at viewer, simple background, white background'

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
  return minutes >= 60 ? `${Math.round(minutes / 6) / 10} 小时` : `${Math.max(1, Math.round(minutes))} 分钟`
}

/**
 * NovelAI's /user/subscription in the app's terms. `usage` is the V5 allowance
 * (percent left, plus any bought; seconds until the next percent comes back).
 */
export function naiAccount(json) {
  const steps = json?.trainingStepsLeft ?? {}
  const anlas = (Number(steps.fixedTrainingStepsLeft) || 0) + (Number(steps.purchasedTrainingSteps) || 0)
  const tier = ['免费', 'Tablet', 'Scroll', 'Opus'][json?.tier] ?? `tier ${json?.tier}`
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
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50 || end < 0) throw new Error('返回的既不是图片也不是 zip')
  const entry = buffer.readUInt32LE(end + 16)
  if (buffer.readUInt32LE(entry) !== 0x02014b50) throw new Error('zip 目录损坏')
  const method = buffer.readUInt16LE(entry + 10)
  const size = buffer.readUInt32LE(entry + 20)
  const local = buffer.readUInt32LE(entry + 42)
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const data = buffer.subarray(start, start + size)
  if (method === 0) return Buffer.from(data)
  if (method === 8) return inflateRawSync(data)
  throw new Error(`zip 压缩方式 ${method} 不认识`)
}

/** A pasted persistent token (pst-…): printable, no spaces. */
export function cleanNaiToken(value) {
  const token = String(value ?? '').trim().replace(/^Bearer\s+/i, '')
  if (!/^[!-~]{16,1000}$/.test(token)) throw httpError(400, 'NovelAI 令牌格式不对：在 NovelAI 网页「设置 → Account → Get Persistent API Token」复制（pst- 开头）')
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
 * @param features - the edition's capabilities (edition.mjs); without the
 *   xiaoya bridge assumed, no voice service is configured by default.
 */
export function createMedia(store, { proxy = null, askInContext = null, novelai = {}, features = null } = {}) {
  const proxyNow = typeof proxy === 'function' ? proxy : () => proxy
  const defaults = mediaDefaults(features)
  // Since 2026-09-21 api.novelai.net refuses third-party tools ("update to the
  // image URL"); generation and the subscription lookup both live on the image host.
  const naiImageUrl = novelai.imageUrl ?? 'https://image.novelai.net'
  const mediaDir = chatId => path.join(store.dirs.root, 'media', chatId)
  const ttsDir = path.join(store.dirs.root, 'media', 'tts')

  async function settings() {
    return cleanMedia((await store.getSettings()).media ?? {}, defaults, defaults)
  }

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
    if (!ref) throw httpError(400, '还没选写画面提示词的辅助模型：在「配图与朗读」里选一个供应商的模型')
    return resolveRef(ref, await store.getProviders())
  }

  async function writeImagePrompt(chat, node, { reply, input }, signal) {
    const media = await settings()
    const card = await store.getCard(chat.cardId)
    const cardMedia = cleanCardMedia(card.media)
    const roster = cardMedia.roster
    // A cast answers in its own format; an answer that ignored it is still usable as a plain prompt.
    const clean = text => (roster.length && cleanFrame(text)) || cleanPrompt(text, media.promptStyle)
    let note = ''
    if (media.promptSource === 'chat' && askInContext) {
      const providers = await store.getProviders()
      const instruction = contextImageInstruction({ promptStyle: media.promptStyle, style: cardMedia.style, passage: node.parent ? '' : reply, roster, userName: chat.names.user })
      const answer = await askInContext(chat.id, node.id, instruction, { maxTokens: roster.length ? CAST_MAX_TOKENS : PROMPT_MAX_TOKENS, signal })
      if (answer) {
        const prompt = clean(answer.text)
        if (!prompt) throw httpError(502, '对话模型没有写出提示词，可以「重写」，或改用辅助模型')
        const u = answer.usage
        const total = u.input + u.cacheRead + u.cacheWrite
        return {
          prompt: withStyle(prompt, cardMedia.style, media.promptStyle),
          model: refLabel(answer.model, providers) ?? answer.model,
          cache: total ? Math.round((u.cacheRead / total) * 100) : null,
          inContext: true,
        }
      }
      note = '这段剧情是 Claude 订阅写的，借不了它的上下文，这次用辅助模型写。'
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
    if (!prompt) throw httpError(502, `${provider.name} · ${modelId} 没有写出提示词${result.stopReason ? `（${result.stopReason}）` : ''}：推理型模型可能把输出额度花在了思考上，辅助模型换个不带推理的快模型`)
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
    if (!provider) throw httpError(400, '还没选生图的供应商：在「配图与朗读」里选')
    if (provider.api === 'anthropic-messages') throw httpError(400, `${provider.name} 是 Anthropic 接口，没有生图接口`)
    if (!media.imageModel) throw httpError(400, '还没填生图模型')
    const reference = media.imageReference ? (cast?.lead && (await rosterRef(cardId, cast.lead.id))) || (await avatarOf(cardId)) : null
    const size = imageSize('openai', media.imageShape)
    const generate = () =>
      providerRequest(provider, '/images/generations', {
        body: { model: media.imageModel, prompt, n: 1, size, response_format: 'b64_json' },
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
          note = `${editModel} 用不了参考图（${String(error.message).slice(0, 80)}），这张没带参考图。可以在「配图与朗读」里给参考图单独选一个能改图的模型（grok2api 的 Web 账号是 grok-imagine-image-edit）。`
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
      throw httpError(502, `${provider.name} 返回的不是图片结果`)
    }
    const item = json.data?.[0]
    if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), note }
    if (item?.url) {
      const url = new URL(item.url, provider.baseURL).href
      return { buffer: (await fetchBytes(url, { signal, proxy: provider.proxy === 'direct' ? null : proxyNow() })).buffer, note }
    }
    throw httpError(502, `${provider.name} 没有返回图片${json.error?.message ? `：${json.error.message}` : ''}`)
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
        body: { model, prompt, n: 1, size, response_format: 'b64_json', image: { url: dataUrl } },
        signal,
        proxy: proxyNow(),
      })
    } catch (error) {
      const wantsForm = error.providerStatus === 415 || /multipart|form-data|image.+file|must be a file/i.test(error.message)
      if (!wantsForm || signal?.aborted) throw error
      return providerRequest(provider, '/images/edits', {
        body: multipart({ model, prompt, n: '1', size, response_format: 'b64_json', image: { buffer: reference, filename: 'reference.png', type: 'image/png' } }),
        signal,
        proxy: proxyNow(),
      })
    }
  }

  async function comfyImage(media, prompt, cardId, signal, cast = null) {
    const imported = await loadWorkflow()
    if (!imported) throw httpError(400, '还没导入 ComfyUI 工作流：在「配图与朗读」里导入「导出（API）」的 JSON')
    const cardMedia = cleanCardMedia((await store.getCard(cardId)).media)
    // Several LoRAs in one picture bleed into each other: a named cast uses only a lone member's own.
    const owner = cast ? (cast.solo?.lora ? cast.solo : null) : cardMedia.lora ? cardMedia : null
    const workflow = owner ? withLora(imported, { name: owner.lora, strength: owner.loraStrength }) : imported
    if (owner) prompt = withTrigger(prompt, owner.loraTrigger)
    const base = media.comfyUrl
    const [width, height] = imageSize('comfy', media.imageShape).split('x').map(Number)
    let reference = ''
    const needsReference = JSON.stringify(workflow).includes('{{reference}}')
    if (needsReference) {
      const avatar = (cast?.lead && (await rosterRef(cardId, cast.lead.id))) || (await avatarOf(cardId))
      if (!avatar) throw httpError(400, '工作流要参考图（{{reference}}），这张卡没有头像')
      const upload = await postMultipart(`${base}/upload/image`, multipart({ image: { buffer: avatar, filename: `tavern-${cardId}.png`, type: 'image/png' }, overwrite: 'true' }), signal)
      reference = JSON.parse(upload.toString('utf8')).name
    }
    const filled = fillWorkflow(workflow, { prompt, negative: '', seed: randomInt(1, 2 ** 31), width, height, reference })
    let queued
    try {
      queued = JSON.parse((await postJson(`${base}/prompt`, { prompt: filled, client_id: 'agent-tavern' }, { signal })).buffer.toString('utf8'))
    } catch (error) {
      if (signal?.aborted) throw error
      throw httpError(502, comfyError(error))
    }
    const id = queued.prompt_id
    if (!id) throw httpError(502, `ComfyUI 没接受这个工作流：${JSON.stringify(queued.node_errors ?? queued.error ?? queued).slice(0, 200)}`)
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted')
      await sleep(1500)
      const history = JSON.parse((await fetchBytes(`${base}/history/${id}`, { signal })).buffer.toString('utf8'))
      const entry = history[id]
      if (!entry) continue
      if (entry.status?.status_str === 'error') throw httpError(502, 'ComfyUI 执行出错，去 ComfyUI 界面看看是哪个节点')
      const image = Object.values(entry.outputs ?? {}).flatMap(out => out.images ?? []).find(img => img.type === 'output') ?? Object.values(entry.outputs ?? {}).flatMap(out => out.images ?? [])[0]
      if (image) {
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
        return (await fetchBytes(`${base}/view?${query}`, { signal })).buffer
      }
      if (entry.status?.completed) throw httpError(502, 'ComfyUI 跑完了，但工作流没有输出图片（要有 SaveImage 或 PreviewImage 节点）')
    }
    throw httpError(504, 'ComfyUI 十分钟还没出图')
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
    if (/ECONNREFUSED/.test(text)) return '连不上 ComfyUI：先打开 ComfyUI，再确认地址（默认 http://127.0.0.1:8188）'
    return `ComfyUI：${text.slice(0, 200)}`
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
    if (status === 401) return `NovelAI 不认这个令牌：在 NovelAI 网页重新生成持久令牌，再到「配图与朗读」里粘贴。（${text}）`
    if (status === 402) return `NovelAI 要求付费：订阅没生效，或者这张超出了 Opus 的免费范围而 Anlas 不够。（${text}）`
    if (status === 429) return 'NovelAI 一个账号同时只画一张，上一张还没画完，稍等再画。'
    if ((status === 400 || status === 404 || status >= 500) && /model/i.test(text)) return `NovelAI 不认模型 ${model}：在「配图与朗读」里换成 V4.5 试试。（${text}）`
    return providerError({ name: 'NovelAI' }, error)
  }

  async function naiSubscription(token, timeout = 20000) {
    const { buffer } = await providerRequest(naiProvider(naiImageUrl, token), '/user/subscription', { method: 'GET', proxy: proxyNow(), signal: AbortSignal.timeout(timeout) })
    return naiAccount(JSON.parse(buffer.toString('utf8')))
  }

  /** Subscription tier, Anlas and the V5 allowance, to check a token without drawing anything. */
  async function naiCheck(typed) {
    const token = typed ? cleanNaiToken(typed) : await naiToken()
    if (!token) throw httpError(400, '还没填 NovelAI 令牌')
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
    const next = v5.nextPercentMinutes ? `，${waitText(v5.nextPercentMinutes)}后回 1%` : ''
    if (v5.empty) {
      if (media.naiV5Empty === 'anlas' && account.anlas > 0) return { model, note: `V5 额度用完了${next}，这张扣 Anlas 画（还剩 ${account.anlas}）。` }
      const why = media.naiV5Empty === 'anlas' ? '，Anlas 也没了' : ''
      return { model: referenceModel(model), note: `V5 额度用完了${next}${why}，这张改用 V4.5 画（Opus 不扣 Anlas）。` }
    }
    if (v5.percent <= V5_LOW) return { model, note: `V5 额度只剩 ${v5.percent}%${next}。用完后${media.naiV5Empty === 'anlas' ? '扣 Anlas 画' : '自动改用 V4.5'}。` }
    return { model, note: '' }
  }

  async function naiImage(media, prompt, signal, cast = null, cardId = '') {
    const token = await naiToken()
    if (!token) throw httpError(400, '还没填 NovelAI 令牌：在「配图与朗读」里把画图用改成 NovelAI，粘贴持久令牌')
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
    const picture = media.naiReference && canRefer && cast?.lead ? await rosterRef(cardId, cast.lead.id) : null
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
      const label = `NovelAI · ${model}${reference ? ` · 人设图：${cast.lead.name}` : ''}`
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
          note = `NovelAI 的 Anlas 不够（带人设图每张 5 Anlas），这张没带「${cast.lead.name}」的人设图。`
          reference = null
          model = media.naiModel
          await sleep(4000)
          continue
        }
        // V5 past its allowance with no Anlas left (or the lookup missed it): V4.5 is free on Opus.
        if (error.providerStatus === 402 && isV5(model)) {
          note = 'V5 额度用完、Anlas 也不够，这张改用 V4.5 画。'
          model = referenceModel(model)
          await sleep(4000)
          continue
        }
        throw httpError(502, error.providerStatus ? naiError(error, model) : `NovelAI：${String(error.message).slice(0, 200)}`)
      }
    }
  }

  // ─── Cast ───────────────────────────────────────────────────────────
  // Reference pictures live next to the card: cards/<id>/roster/<entry id>.png.

  const rosterDir = cardId => path.join(path.dirname(store.avatarPath(cardId)), 'roster')
  function refFile(cardId, entryId) {
    if (!isRosterId(entryId)) throw httpError(400, '角色编号不对')
    return path.join(rosterDir(cardId), `${entryId}.png`)
  }

  async function rosterRef(cardId, entryId) {
    try {
      return await readFile(refFile(cardId, entryId))
    } catch {
      return null
    }
  }

  async function readRosterRef(cardId, entryId) {
    const data = await rosterRef(cardId, entryId)
    if (!data) throw httpError(404, '这个角色还没有人设图')
    return data
  }

  /** A picture from the page (already padded to NovelAI's reference canvas there) as a data URL. */
  async function saveRosterRef(cardId, entryId, dataUrl) {
    await store.getCard(cardId)
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
    if (!match) throw httpError(400, '人设图要是 PNG、JPG 或 WebP')
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length > 15 * 1024 * 1024) throw httpError(400, '人设图太大（最多 15MB）')
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
    if (!roster.length) throw httpError(502, `${provider.name} · ${modelId} 没有列出角色${result.stopReason ? `（${result.stopReason}）` : ''}，可以再试一次，或者手动添加`)
    // The card LoRA most likely belongs to the character the card is named after.
    const current = cleanCardMedia(card.media)
    if (current.lora) {
      const owner = roster.find(entry => !entry.player && card.name.includes(entry.name))
      if (owner) Object.assign(owner, { lora: current.lora, loraTrigger: current.loraTrigger, loraStrength: current.loraStrength })
    }
    return { roster, model: `${provider.name} · ${modelId}` }
  }

  /** Generate one image for a reply and record it on the node. */
  /** The settings with a NovelAI model picked for one picture, if any. */
  async function settingsFor(model) {
    const media = await settings()
    if (!model) return media
    if (!/^nai-diffusion-[a-z0-9-]{1,40}$/.test(String(model))) throw httpError(400, 'NovelAI 模型名不对')
    return { ...media, naiModel: model, naiModelPicked: true }
  }

  async function generateImage(chat, nodeId, prompt, signal, { model = '' } = {}) {
    const text = String(prompt ?? '').trim()
    if (!text) throw httpError(400, '提示词是空的')
    const media = await settingsFor(model)
    const { roster } = cleanCardMedia((await store.getCard(chat.cardId)).media)
    const frame = roster.length && isFramePrompt(text) ? parseFrame(text, roster, chat.names?.user) : null
    const cast = frame?.characters.length ? { ...frame, solo: frame.characters.length === 1 ? frame.characters[0].entry : null, lead: leadOf(frame.characters) } : null
    const { buffer, note, backend } = await render(media, chat.cardId, frame, cast, text, signal)
    const file = `${newId()}.${extOf('', buffer)}`
    await mkdir(mediaDir(chat.id), { recursive: true })
    await writeFile(path.join(mediaDir(chat.id), file), buffer)
    return { file, prompt: text, backend, at: new Date().toISOString(), ...(note ? { note } : {}) }
  }

  /** One picture from whichever backend is chosen. */
  async function render(media, cardId, frame, cast, text, signal) {
    // Backends without per-character prompts get the cast written out in one prompt.
    const flat = cast ? flattenFrame(cast, media.promptStyle) : frame ? frame.scene : text
    if (media.imageBackend === 'comfy') return { buffer: await comfyImage(media, flat, cardId, signal, cast), note: '', backend: 'ComfyUI' }
    if (media.imageBackend === 'novelai') {
      const { buffer, label, note } = await naiImage(media, flat, signal, cast, cardId)
      return { buffer, note, backend: label }
    }
    const { buffer, note } = await openaiImage(media, flat, cardId, signal, cast)
    return { buffer, note, backend: media.imageReference && !note ? media.imageEditModel || media.imageModel : media.imageModel }
  }

  /**
   * A reference picture for a cast member drawn from their looks and usual
   * outfit: one person, upper body, plain background, no reference of its
   * own. Returned to the page, which pads it like an upload.
   */
  async function drawPortrait(cardId, input, signal, { model = '' } = {}) {
    await store.getCard(cardId)
    const [entry] = cleanRoster([input])
    if (!entry?.looks) throw httpError(400, '先写这个角色的长相，再画人设图')
    const media = await settingsFor(model)
    const cast = { scene: PORTRAIT_SCENE, characters: [{ entry, action: [entry.outfit, 'standing'].filter(Boolean).join(', '), position: '' }], solo: entry, lead: entry }
    const plain = { ...media, imageShape: 'portrait', naiReference: false, imageReference: false, naiNegative: [media.naiNegative, 'nsfw, multiple views, text'].filter(Boolean).join(', ') }
    const { buffer, backend } = await render(plain, cardId, cast, cast, '', signal)
    const type = extOf('', buffer) === 'jpg' ? 'jpeg' : extOf('', buffer)
    return { image: `data:image/${type};base64,${buffer.toString('base64')}`, backend }
  }

  async function readImage(chatId, file) {
    if (!FILE.test(file)) throw httpError(400, '文件名不对')
    return readFile(path.join(mediaDir(chatId), file))
  }

  async function removeImage(chatId, file) {
    if (!FILE.test(file)) throw httpError(400, '文件名不对')
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

  // ─── Voice ──────────────────────────────────────────────────────────

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

  // The voice service is the xiaoya bridge, or another Agent Tavern that has one
  // (the phone edition reading through the PC's tavern on the same Wi-Fi). A
  // tavern in LAN mode wants its access key: kept in its own file like the
  // NovelAI token, so /api/settings and the page never carry it.
  const ttsKeyFile = path.join(store.dirs.root, 'tts-key.json')

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
      if (!/^[\w-]{8,200}$/.test(key)) throw httpError(400, '访问口令不对：把电脑上酒馆「局域网访问」里的链接整条粘贴过来')
      await writeFile(ttsKeyFile, JSON.stringify({ key }), 'utf8')
    }
    return ttsKeyStatus()
  }

  async function ttsHeaders() {
    const key = await ttsKey()
    return key ? { 'x-agent-tavern': '1', 'x-agent-tavern-key': key } : { 'x-agent-tavern': '1' }
  }

  const isLocalUrl = url => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(url)

  /** Why the voice service did not answer, in words that say what to do. */
  function voiceTrouble(media, error) {
    const message = String(error?.message ?? error)
    const down = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timeout|aborted/i.test(message)
    // Only a tavern asks for a key (401 no or wrong key, 403 an address it does not serve).
    if (/^40[13]\b/.test(message)) return '电脑上的酒馆不让访问：把它「局域网访问」里的链接整条粘贴到「语音服务地址」（链接里带着口令）'
    if (isLocalUrl(media.ttsUrl)) {
      if (!down) return `语音服务：${message.replace(/^\d{3} /, '').slice(0, 200)}`
      return features?.xiaoya === false ? `语音服务（${media.ttsUrl}）没开` : '语音服务没开：先运行「小雅一键启动」（或只启动语音桥接）'
    }
    if (down) return `连不上 ${media.ttsUrl}：电脑上的酒馆开着吗？手机和电脑在同一个 Wi-Fi 吗？`
    return `语音服务（${media.ttsUrl}）：${message.replace(/^\d{3} /, '').slice(0, 200)}`
  }

  /** The service's voice list: its own voices, plus cloud voices it can call by name (fish:<id>, billed per character). */
  async function voiceList(media, timeout) {
    const json = JSON.parse((await fetchBytes(`${media.ttsUrl}/api/persona/list`, { headers: await ttsHeaders(), signal: AbortSignal.timeout(timeout) })).buffer.toString('utf8'))
    const cloud = (Array.isArray(json.cloud_voices) ? json.cloud_voices : [])
      .filter(v => typeof v?.name === 'string' && v.name.includes(':'))
      .map(v => ({ name: v.name, label: String(v.label || v.name), provider: String(v.provider || ''), model: String(v.model || ''), tags: v.tags === true }))
    return {
      voices: (json.voices ?? []).map(v => (typeof v === 'string' ? v : v.name)).filter(Boolean),
      cloud,
      current: json.current?.voice ?? null,
      remote: json.via === 'agent-tavern',
    }
  }

  async function voices() {
    const media = await settings()
    // No voice service set up: the page offers the browser's own voices only.
    if (!media.ttsUrl) return { ok: true, configured: false, voices: [], cloud: [], current: null }
    try {
      return { ok: true, ...(await voiceList(media, 5000)) }
    } catch (error) {
      return { ok: false, voices: [], cloud: [], error: voiceTrouble(media, error) }
    }
  }

  /** The bridge's voice list in its own shape, so another tavern can use this one as its voice service. */
  async function personaList() {
    const info = await voices()
    if (!info.ok) throw httpError(502, info.error)
    return { voices: info.voices.map(name => ({ name })), cloud_voices: info.cloud, current: { voice: info.current }, via: 'agent-tavern' }
  }

  // What synthesis needs to know about the service, asked at most every 10 s:
  // its current voice (cards that use it: switching it there must not replay
  // audio cached under the old one) and its cloud voices (their model goes into
  // the cache key; only some act on [emotion] tags).
  let serviceInfo = { at: 0, current: '', cloud: new Map() }
  async function voiceService(media) {
    if (!media.ttsUrl) return { at: 0, current: '', cloud: new Map() }
    if (Date.now() - serviceInfo.at < 10_000) return serviceInfo
    let info = { current: '', cloud: new Map() }
    try {
      const list = await voiceList(media, 2000)
      info = { current: String(list.current ?? ''), cloud: new Map(list.cloud.map(v => [v.name, v])) }
    } catch {
      // service not answering: synthesis below reports it
    }
    serviceInfo = { at: Date.now(), ...info }
    return serviceInfo
  }

  // [emotion] tags speechChunks puts before a line (from 小白X voice tags).
  const DELIVERY_TAG = /\[[^\]\n]{1,40}\]\s*/g

  /**
   * One chunk of speech as WAV, from the cache or the bridge. The bridge stops
   * synthesising when this request is aborted (the client pressed stop).
   * fresh: synthesise again and replace the cached take (passed on, so a
   * tavern in between skips its cache too).
   */
  async function speak({ text, voice, stable, fresh }, signal) {
    const media = await settings()
    if (!media.ttsUrl) throw httpError(400, '没有设置语音服务：在「配图与朗读」里给这张卡选一个浏览器音色，或者填一个语音服务地址')
    const service = await voiceService(media)
    const cloud = voice ? service.cloud.get(voice) : null
    // Only voices that act on delivery tags get them; the rest would read them out.
    const clean = (cloud?.tags ? String(text ?? '') : String(text ?? '').replace(DELIVERY_TAG, '')).trim().slice(0, 500)
    if (!clean) throw httpError(400, '没有要读的文字')
    const speaker = voice ? `${voice}${cloud?.model ? `#${cloud.model}` : ''}` : `@${service.current}`
    const key = createHash('sha256').update(`${speaker}\n${stable ? 1 : 0}\n${clean}`).digest('hex').slice(0, 32)
    const file = path.join(ttsDir, `${key}.wav`)
    if (!fresh) {
      try {
        return await readFile(file)
      } catch {
        // not cached yet
      }
    }
    let result
    try {
      result = await postJson(`${media.ttsUrl}/api/tts`, { text: clean, ...(voice ? { voice } : {}), stable: Boolean(stable), ...(fresh ? { fresh: true } : {}) }, { signal, headers: await ttsHeaders() })
    } catch (error) {
      if (signal?.aborted) throw error
      throw httpError(502, voiceTrouble(media, error))
    }
    await mkdir(ttsDir, { recursive: true })
    await writeFile(file, result.buffer)
    return result.buffer
  }

  return { defaults, settings, naiStatus, setNaiToken, naiCheck, cardMediaView, saveCardMedia, inheritCardMedia, draftRoster, drawPortrait, readRosterRef, saveRosterRef, removeRosterRef, writeImagePrompt, generateImage, readImage, removeImage, removeChatMedia, copyChatMedia, loras, voices, personaList, ttsKeyStatus, setTtsKey, speak, loadWorkflow, saveWorkflow, describeWorkflow }
}
