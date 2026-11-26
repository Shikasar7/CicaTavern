// 这一张怎么画 (web/draw-choice.js): which 画图方式 are set up and what models each
// offers, from the saved picture settings (/api/media/settings) and the
// providers (/api/providers). A choice holds for one drawing; the server puts it
// over the saved settings without saving it (server/media.mjs withDrawChoice).

// 配图放在画的那一句下面: a picture's anchor is a few words of the reply, copied by whoever wrote its prompt (server/media.mjs
// takeAnchor); the page puts the picture under the paragraph that has them (web/media.js placePictures). Compared without
// the spaces and marks a copy gets wrong, then by ever shorter beginnings and ends of it, down to this much.
const ANCHOR_LEAST = 6
export const MAX_ANCHOR = 120

/** The letters, digits and characters of a text: what a copied sentence keeps. (By ranges: the Android build has no Unicode classes.) */
export const anchorKey = text => String(text ?? '').toLowerCase().replace(/[\s\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u00bf\u2000-\u206f\u2500-\u25ff\u2e00-\u2e7f\u3000-\u303f\ufe30-\ufe4f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g, '')

/** Which of `texts` (a reply's paragraphs) an anchor is from: its index, or -1. */
export function findAnchor(texts, anchor) {
  const key = anchorKey(anchor)
  if (key.length < ANCHOR_LEAST) return -1
  const keys = texts.map(anchorKey)
  for (let length = key.length; length >= ANCHOR_LEAST; length--) {
    for (const part of length === key.length ? [key] : [key.slice(0, length), key.slice(-length)]) {
      const at = keys.findIndex(text => text.includes(part))
      if (at >= 0) return at
    }
  }
  return -1
}

/**
 * Where pictures with an anchor are shown as a reply is read line by line (视觉小说): Map(index in `texts` → picture).
 * A second one on the same line waits for the next. Those whose words are not found, and those left over at the end, are in none.
 * @param texts - the lines; '' for what is no line.
 */
export function picturesOnLines(images, texts) {
  const at = new Map()
  for (const image of images ?? []) {
    let index = image?.anchor ? findAnchor(texts, image.anchor) : -1
    if (index < 0) continue
    while (index < texts.length && (at.has(index) || !texts[index])) index++
    if (index < texts.length) at.set(index, image)
  }
  return at
}

// As offered, the usual first.
export const DRAW_BACKENDS = Object.freeze(['openai', 'gemini', 'novelai', 'comfy', 'sdwebui'])
export const NAI_MODEL_IDS = Object.freeze(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'])
export const GEMINI_IMAGE_MODELS = Object.freeze(['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'])

// 生图方案 (设置 → 配图与朗读 → 配图 → 生图方案, server/media.mjs cleanImagePresets): what one saved way of drawing
// holds. The NovelAI token, the imported ComfyUI workflow and the providers' keys stay where they are (one of each):
// a plan names a provider, a model and the options, not a key.
export const IMAGE_PRESET_KEYS = Object.freeze([
  'imageBackend', 'imageProvider', 'imageModel', 'imageEditModel', 'imageShape', 'imageReference', 'promptStyle', 'promptDetail',
  'comfyUrl', 'comfyMode', 'comfyTemplate', 'comfyModel', 'comfyClip', 'comfyClip2', 'comfyClipType', 'comfyVae', 'comfySteps', 'comfyCfg', 'comfyNegative', 'comfySampler', 'comfyScheduler',
  'geminiImageProvider', 'geminiImageModel', 'geminiReference',
  'sdUrl', 'sdSteps', 'sdCfg', 'sdSampler', 'sdNegative',
  'naiModel', 'naiQuality', 'naiReference', 'naiRefFidelity', 'naiRefStyle', 'naiV5Empty', 'naiNegative',
  'localModels',
])

/** The image settings of `media` that a 生图方案 keeps. */
export const imagePresetOf = media => Object.fromEntries(IMAGE_PRESET_KEYS.map(key => [key, media[key]]))

/** The saved 生图方案 that the settings `media` draw with now, or null (changed since, or none saved). */
export function currentImagePreset(media) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const now = imagePresetOf(media)
  // localModels: only the keys a plan holds (an own backend added later is not a change).
  return (media.imagePresets ?? []).find(preset => IMAGE_PRESET_KEYS.every(key => (key === 'localModels' ? Object.entries(preset.settings.localModels ?? {}).every(([id, model]) => now.localModels?.[id] === model) : same(preset.settings[key], now[key])))) ?? null
}
// A model that draws, by its name.
export const IMAGE_MODEL = /image|imagine|dall|flux|sdxl|stable|seedream|gpt-image|kolors|wanx|cogview|midjourney|recraft|ideogram/i
// SD WebUI answers nobody until it runs: it counts as set up once its address was changed or it is the one in use.
const SD_DEFAULT = 'http://127.0.0.1:7860'

const unique = list => [...new Set(list.filter(Boolean))]

/**
 * Each 画图方式 as the picker offers it:
 *   { id, saved, ready, need, provider, providerId, model, models }
 * `saved`: the one the settings use. `need` says what is missing when it is not
 * ready: 'provider' | 'token' | 'workflow' | 'address', or 'own' with `needText`.
 * `model`: its saved model, '' for the ones that draw with what they have loaded
 * (ComfyUI, SD WebUI), which offer no `models`. `own`: this install's own
 * backends as the server describes them (/api/media/settings ownBackends), which
 * come with their `name`, `hint` and model `labels`.
 */
export function drawChoices({ media = {}, providers = [], workflow = null, novelai = null, own = [] } = {}) {
  const find = id => (id ? providers.find(p => p.id === id && p.api !== 'anthropic-messages') : null) ?? null
  // A provider's models are { id, label? } (providers.mjs); ids are what a request names.
  const listed = provider => (Array.isArray(provider?.models) ? provider.models.map(m => (typeof m === 'string' ? m : m?.id)).filter(id => typeof id === 'string' && id) : [])
  const drawing = list => list.filter(id => IMAGE_MODEL.test(id))
  const usual = DRAW_BACKENDS.map(id => {
    const saved = media.imageBackend === id
    const method = (ready, need, extra) => ({ id, saved, ready, need: ready ? '' : need, provider: '', providerId: '', model: '', models: [], ...extra })
    if (id === 'openai') {
      const provider = find(media.imageProvider)
      const known = drawing(listed(provider)).length ? drawing(listed(provider)) : listed(provider)
      return method(Boolean(provider), 'provider', { provider: provider?.name ?? '', providerId: provider?.id ?? '', model: media.imageModel ?? '', models: unique([media.imageModel, ...known]) })
    }
    if (id === 'gemini') {
      const provider = find(media.geminiImageProvider)
      return method(Boolean(provider), 'provider', { provider: provider?.name ?? '', providerId: provider?.id ?? '', model: media.geminiImageModel ?? '', models: unique([media.geminiImageModel, ...GEMINI_IMAGE_MODELS, ...drawing(listed(provider))]) })
    }
    if (id === 'novelai') return method(novelai?.hasToken === true, 'token', { model: media.naiModel ?? '', models: unique([...NAI_MODEL_IDS, media.naiModel]) })
    // 简单模式 (a model picked from ComfyUI) draws without an imported workflow.
    if (id === 'comfy') {
      const simple = media.comfyMode === 'simple' && Boolean(media.comfyModel)
      return method(simple || Boolean(workflow), 'workflow', simple ? { simple: true, model: media.comfyModel } : {})
    }
    return method(saved || Boolean(media.sdUrl && media.sdUrl !== SD_DEFAULT), 'address')
  })
  const owned = own.map(item => {
    const models = Array.isArray(item.models) ? item.models.filter(m => typeof m?.id === 'string') : []
    const ready = item.ready === true
    return {
      id: item.id,
      saved: media.imageBackend === item.id,
      ready,
      need: ready ? '' : 'own',
      needText: ready ? '' : String(item.need ?? ''),
      name: String(item.name ?? item.id),
      hint: String(item.hint ?? ''),
      provider: '',
      providerId: '',
      model: String(item.model ?? ''),
      models: models.map(m => m.id),
      labels: Object.fromEntries(models.map(m => [m.id, String(m.label ?? m.id)])),
    }
  })
  return [...usual, ...owned]
}

/** Where the picker starts: the saved 画图方式, else the first one set up. */
export function startingChoice(choices) {
  const method = choices.find(c => c.saved) ?? choices.find(c => c.ready) ?? choices[0]
  return { backend: method?.id ?? '', model: method?.model ?? '' }
}

/**
 * A draw request's body for a choice: only what differs from the settings, so
 * {} draws as they say. A model is sent for the methods that offer models.
 */
export function choiceBody(choice, choices) {
  const method = choices.find(c => c.id === choice?.backend)
  if (!method) return {}
  const body = method.saved ? {} : { backend: method.id }
  const model = method.models.length ? String(choice.model ?? '').trim() : ''
  if (model && model !== method.model) body.model = model
  return body
}

// ─── 画风预设 ───────────────────────────────────────────────────────────
// What 「画风与 LoRA」 offers to fill a card's 画风 with (web/media.js names
// them): words for tag prompts (Danbooru tags anime models and NovelAI know) and
// for sentence prompts (Flux, Krea 2, gpt-image, Gemini), and a 画风负面 for
// NovelAI. The 画风 stays the card's own text afterwards: editable, any words.
export const STYLE_PRESETS = Object.freeze([
  {
    id: 'anime',
    tags: 'anime coloring, anime screencap, cel shading, clean lineart, vibrant colors',
    natural: 'Japanese anime style, clean lineart, flat cel shading, vibrant colors',
    negative: 'realistic, photorealistic, 3d',
  },
  {
    id: 'galgame',
    tags: 'official art, game cg, detailed illustration, delicate lineart, soft shading, bloom',
    natural: 'polished visual novel CG illustration, delicate lineart, soft shading, gentle bloom, detailed background',
    negative: 'sketch, monochrome, 3d',
  },
  {
    id: 'impasto',
    tags: 'impasto, painterly, thick brushstrokes, oil painting (medium), rich colors, dramatic lighting',
    natural: 'painterly digital illustration with thick impasto brushstrokes, rich colors and dramatic lighting',
    negative: 'flat color, cel shading, lineart',
  },
  {
    id: 'watercolor',
    tags: 'watercolor (medium), traditional media, soft colors, pastel colors, paper texture',
    natural: 'soft watercolor painting on textured paper, translucent washes, gentle pastel colors, loose edges',
    negative: '3d, photorealistic, cel shading',
  },
  {
    id: 'ink',
    tags: 'chinese style, ink wash painting, traditional chinese painting, muted colors, elegant',
    natural: 'Chinese ink wash painting with fine gongbi linework, muted mineral colors and generous empty space',
    negative: '3d, photorealistic, neon lights',
  },
  {
    id: 'semireal',
    tags: 'semi-realistic, realistic shading, detailed face, digital painting, soft lighting',
    natural: 'semi-realistic digital painting, anime-inspired faces with realistic lighting and soft rendering',
    negative: 'chibi, flat color, sketch',
  },
  {
    id: 'photo',
    tags: 'photorealistic, realistic, photo (medium), cinematic lighting, depth of field, film grain',
    natural: 'photorealistic cinematic photograph, natural skin texture, shallow depth of field, soft film grain',
    negative: 'anime, cartoon, illustration, lineart',
  },
  {
    id: 'retro',
    tags: '1990s (style), retro artstyle, anime screencap, muted colors, film grain',
    natural: '1990s retro anime style, hand-painted cel look, muted colors, slight film grain',
    negative: '3d, photorealistic',
  },
  {
    id: 'render3d',
    tags: '3d, blender (medium), cgi, stylized, soft global illumination',
    natural: 'stylized 3D render, soft global illumination, smooth materials, cinematic composition',
    negative: '2d, sketch, lineart',
  },
])

/** The preset a 画风 text was filled from (either wording), or null for the card's own words. */
export function stylePresetOf(style) {
  const text = String(style ?? '').trim()
  return text ? STYLE_PRESETS.find(preset => preset.tags === text || preset.natural === text) ?? null : null
}
