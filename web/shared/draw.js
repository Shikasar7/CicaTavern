// 这一张怎么画 (web/draw-choice.js): which 画图方式 are set up and what models each
// offers, from the saved picture settings (/api/media/settings) and the
// providers (/api/providers). A choice holds for one drawing; the server puts it
// over the saved settings without saving it (server/media.mjs withDrawChoice).

// As offered, the usual first.
export const DRAW_BACKENDS = Object.freeze(['openai', 'gemini', 'novelai', 'comfy', 'sdwebui'])
export const NAI_MODEL_IDS = Object.freeze(['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'])
export const GEMINI_IMAGE_MODELS = Object.freeze(['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'])
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
