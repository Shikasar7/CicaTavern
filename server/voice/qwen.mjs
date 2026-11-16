// Qwen-Audio-TTS on Alibaba Cloud Bailian (DashScope) through a provider set up
// with the 通义千问 template: its key, and its address with /compatible-mode/v1
// swapped for DashScope's own /api/v1 (the compatible mode has no /audio/speech).
// 配图与朗读 picks the provider, the model and, if wanted, which voices to offer;
// none listed = the system voices every qwen-audio-3.1 model has. A reply's
// [emotion] tags become the request's instruction. The service answers with a
// link to the audio (24 hours), fetched at once.
import { fetchBytes, providerError, providerRequest } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { audioOf } from './cloud.mjs'
import { msg } from '../i18n.mjs'

export const QWEN_TTS_MODELS = ['qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash']
// DashScope keeps an instruction this short (CosyVoice's limit; Qwen-Audio's is not stated).
const INSTRUCTION_MAX = 100

// The system voices both qwen-audio-3.1 models have (the plus model has only these).
const SYSTEM = [
  ['longanhuan_v3.1', () => msg`龙安欢（女声）`],
  ['longanlingxin_v3.1', () => msg`龙安灵心（女声）`],
  ['longanfengyue_v3.1', () => msg`龙安风悦（女声）`],
  ['xunanchuan_v3.1', () => msg`许南川（男声）`],
]
export const QWEN_VOICES = SYSTEM.map(([id]) => id)

/** The system voices as listed when none are written. */
export const qwenDefaultVoices = () => SYSTEM.map(([id, name]) => ({ id, name: name() }))

/** A provider on DashScope (the 通义千问 template, the international site, or a workspace address). */
export const isDashscope = provider => Boolean(provider) && provider.api !== 'anthropic-messages' && /(^https?:\/\/[^/]*\.aliyuncs\.com)(\/|$)/i.test(String(provider.baseURL ?? ''))

/** DashScope's own API beside the provider's OpenAI-compatible address: https://<host>/api/v1. */
export function dashscopeBase(provider) {
  const base = String(provider?.baseURL ?? '').replace(/\/+$/, '')
  if (/\/compatible-mode\/v1$/i.test(base)) return base.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(base)) return base
  return `${new URL(base).origin}/api/v1`
}

/** The SpeechSynthesizer body: MP3, the instruction only when there is one. */
export function qwenSpeechRequest({ model, voice, text, instructions }) {
  const instruction = String(instructions ?? '').trim().slice(0, INSTRUCTION_MAX)
  return { model, input: { text, voice, format: 'mp3', ...(instruction ? { instruction } : {}) } }
}

export function createQwenSource() {
  const voicesOf = media => (media.qwenTtsVoices?.length ? media.qwenTtsVoices : qwenDefaultVoices())
  const providerOf = ({ media, providers }) => providers.find(p => p.id === media.qwenTtsProvider)
  return {
    id: 'qwen',
    get label() {
      return msg`通义千问朗读`
    },
    chunkMax: 300,
    emotion: () => 'instruction',
    model: media => media.qwenTtsModel,
    configured: ctx => Boolean(ctx.media.qwenTtsModel) && Boolean(providerOf(ctx)) && providerOf(ctx).api !== 'anthropic-messages',
    list: ({ media }) => voicesOf(media).map(v => ({ ref: `qwen:${v.id}`, label: v.name ? `${v.name} · ${v.id}` : v.id })),
    target: rest => (rest ? { voice: rest } : null),
    async synth({ voice, text, instructions }, ctx) {
      const { media, proxy, signal } = ctx
      const provider = providerOf(ctx)
      if (!provider) throw httpError(400, msg`还没选通义千问朗读用的供应商：在「配图与朗读 → 朗读来源」里选用「通义千问」模板建的那个`)
      const model = media.qwenTtsModel
      const native = { ...provider, baseURL: dashscopeBase(provider) }
      let json
      try {
        const reply = await providerRequest(native, '/services/audio/tts/SpeechSynthesizer', { body: qwenSpeechRequest({ model, voice, text, instructions }), signal, proxy: proxy() })
        json = JSON.parse(reply.buffer.toString('utf8'))
      } catch (error) {
        if (signal?.aborted) throw error
        const hint = error.providerStatus === 404 ? msg`（「${provider.name}」不是阿里云百炼的地址：要选用「通义千问」模板建的供应商）`
          : error.providerStatus === 400 ? msg`（模型名不对，或者音色不属于这个模型：qwen-audio-3.1 的系统音色以 _v3.1 结尾）`
            : ''
        throw httpError(502, `${providerError(provider, error)}${hint}`)
      }
      const audio = json?.output?.audio
      try {
        if (audio?.data) return audioOf(Buffer.from(audio.data, 'base64'))
        if (!audio?.url) throw new Error(msg`没有返回声音${json?.message ? msg`（${json.message}）` : ''}`)
        // A link to the audio on Alibaba Cloud's storage (signed, no key): reached the way the provider is.
        const file = await fetchBytes(audio.url, { signal, proxy: provider.proxy === 'direct' ? null : proxy() })
        return audioOf(file.buffer, { contentType: file.contentType })
      } catch (error) {
        if (signal?.aborted) throw error
        throw httpError(502, msg`${provider.name} · ${model}：${error.message}`)
      }
    },
  }
}
