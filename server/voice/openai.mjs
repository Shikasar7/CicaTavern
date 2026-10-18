// A provider's OpenAI-compatible speech endpoint (POST /audio/speech): OpenAI,
// SiliconFlow (CosyVoice), relays, or a local Kokoro / GPT-SoVITS wrapper.
// The provider's address, key and direct/proxy setting come from
// providers.json; 配图与朗读 picks the provider, the model and the voices.
// gpt-4o-mini-tts takes `instructions`: the reply's [emotion] tags become those.
import { providerError, providerRequest } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { audioOf } from './cloud.mjs'
import { msg } from '../i18n.mjs'

export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']
// SiliconFlow's CosyVoice2 system voices are named after the model: <model>:<voice>.
const cosyVoices = () => [['anna', msg`沉稳女声`], ['bella', msg`激情女声`], ['claire', msg`温柔女声`], ['diana', msg`欢快女声`], ['alex', msg`沉稳男声`], ['benjamin', msg`低沉男声`], ['charles', msg`磁性男声`], ['david', msg`欢快男声`]]

/** Models that take `instructions` (gpt-4o-mini-tts and its dated snapshots). */
export const takesInstructions = model => /^gpt-4o(-mini)?-tts\b/i.test(String(model ?? ''))

/** Voices offered while none are listed in the settings: the model's usual ones, when known. */
export function defaultVoices(model) {
  if (/CosyVoice2/i.test(model)) return cosyVoices().map(([id, name]) => ({ id: `${model}:${id}`, name }))
  if (/^(gpt-4o(-mini)?-tts|tts-1)/i.test(model)) return OPENAI_VOICES.map(id => ({ id, name: '' }))
  return []
}

/** The /audio/speech body. */
export function speechRequest({ model, voice, text, instructions }) {
  return { model, input: text, voice, response_format: 'mp3', ...(instructions ? { instructions } : {}) }
}

/** Delivery tags ([害羞地小声]) as one instruction for the whole piece. */
export function instructionsFor(tags) {
  const unique = [...new Set(tags)]
  if (!unique.length) return ''
  return unique.length === 1 ? `用这种语气说：${unique[0]}` : `按顺序用这些语气说：${unique.join('；')}`
}

const speaks = provider => Boolean(provider) && provider.api !== 'anthropic-messages'

export function createOpenaiSource() {
  const voicesOf = media => (media.ttsVoices?.length ? media.ttsVoices : defaultVoices(media.ttsModel))
  return {
    id: 'openai',
    get label() {
      return msg`供应商朗读`
    },
    chunkMax: 250,
    emotion: media => (takesInstructions(media.ttsModel) ? 'instruction' : 'none'),
    model: media => media.ttsModel,
    configured: ({ media, providers }) => Boolean(media.ttsModel) && speaks(providers.find(p => p.id === media.ttsProvider)),
    list({ media, providers }) {
      const provider = providers.find(p => p.id === media.ttsProvider)
      return voicesOf(media).map(v => ({ ref: `openai:${provider.id}:${v.id}`, label: v.name ? `${v.name} · ${v.id.replace(/^.*:/, '')}` : v.id }))
    },
    /** `openai:<provider id>:<voice>`: the voice may have colons of its own. */
    target(rest) {
      const cut = rest.indexOf(':')
      if (cut <= 0 || cut === rest.length - 1) return null
      return { providerId: rest.slice(0, cut), voice: rest.slice(cut + 1) }
    },
    async synth({ providerId, voice, text, instructions }, { media, providers, proxy, signal }) {
      const provider = providers.find(p => p.id === providerId)
      if (!provider) throw httpError(400, msg`供应商「${providerId}」已经删除：在「配图与朗读」里给这张卡重新选音色`)
      if (!speaks(provider)) throw httpError(400, msg`${provider.name} 是 Anthropic 接口，没有朗读接口`)
      // The model belongs to the provider picked in the settings; another provider's would be a guess.
      if (provider.id !== media.ttsProvider) throw httpError(400, msg`${provider.name} 不是「配图与朗读」里选的朗读供应商：给这张卡重新选音色，或者把朗读供应商换回它`)
      const body = speechRequest({ model: media.ttsModel, voice, text, instructions: takesInstructions(media.ttsModel) ? instructions : '' })
      let result
      try {
        result = await providerRequest(provider, '/audio/speech', { body, signal, proxy: proxy() })
      } catch (error) {
        if (signal?.aborted) throw error
        const hint = error.providerStatus === 404 ? msg`（这个供应商可能没有 /audio/speech 朗读接口，或者模型名不对）` : ''
        throw httpError(502, `${providerError(provider, error)}${hint}`)
      }
      try {
        // A server that answers raw PCM says so in its Content-Type (audio/pcm, audio/L16;rate=…).
        return audioOf(result.buffer, { contentType: result.contentType })
      } catch (error) {
        throw httpError(502, msg`${provider.name}：${error.message}`)
      }
    },
  }
}
