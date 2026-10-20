// Gemini's speech models (generateContent answering with audio) through a
// provider holding Google's key, the one the Gemini template sets up for chat.
// 配图与朗读 picks the provider, the model and, if wanted, which voices to offer;
// none listed = Google's prebuilt voices. A reply's [emotion] tags become a
// spoken-style prompt before the line ("用…的语气说：…"), which these models follow.
import { googleRequest, isGoogle, providerError } from '../providers.mjs'
import { httpError } from '../store.mjs'
import { audioOf } from './cloud.mjs'
import { msg } from '../i18n.mjs'

// Google's prebuilt voices with the character Google gives each (and how they are usually heard).
const PREBUILT = [
  ['Zephyr', 'girl', 'Bright'], ['Puck', 'boy', 'Upbeat'], ['Charon', 'boy', 'Informative'], ['Kore', 'girl', 'Firm'],
  ['Fenrir', 'boy', 'Excitable'], ['Leda', 'girl', 'Youthful'], ['Orus', 'boy', 'Firm'], ['Aoede', 'girl', 'Breezy'],
  ['Callirrhoe', 'girl', 'Easy-going'], ['Autonoe', 'girl', 'Bright'], ['Enceladus', 'boy', 'Breathy'], ['Iapetus', 'boy', 'Clear'],
  ['Umbriel', 'boy', 'Easy-going'], ['Algieba', 'boy', 'Smooth'], ['Despina', 'girl', 'Smooth'], ['Erinome', 'girl', 'Clear'],
  ['Algenib', 'boy', 'Gravelly'], ['Rasalgethi', 'boy', 'Informative'], ['Laomedeia', 'girl', 'Upbeat'], ['Achernar', 'girl', 'Soft'],
  ['Alnilam', 'boy', 'Firm'], ['Schedar', 'boy', 'Even'], ['Gacrux', 'girl', 'Mature'], ['Pulcherrima', 'girl', 'Forward'],
  ['Achird', 'boy', 'Friendly'], ['Zubenelgenubi', 'boy', 'Casual'], ['Vindemiatrix', 'girl', 'Gentle'], ['Sadachbia', 'boy', 'Lively'],
  ['Sadaltager', 'boy', 'Knowledgeable'], ['Sulafat', 'girl', 'Warm'],
]
export const GEMINI_VOICES = PREBUILT.map(([id]) => id)

const traits = () => ({
  Bright: msg`明亮`, Upbeat: msg`欢快`, Informative: msg`清楚`, Firm: msg`坚定`, Excitable: msg`激动`, Youthful: msg`年轻`,
  Breezy: msg`轻快`, 'Easy-going': msg`随和`, Breathy: msg`气声`, Clear: msg`清亮`, Smooth: msg`顺滑`, Gravelly: msg`沙哑`,
  Soft: msg`柔和`, Even: msg`平稳`, Mature: msg`成熟`, Forward: msg`直率`, Friendly: msg`友好`, Casual: msg`随意`,
  Gentle: msg`温柔`, Lively: msg`活泼`, Knowledgeable: msg`博学`, Warm: msg`温暖`,
})

/** The prebuilt voices as listed when none are written: Kore（女 · 坚定）. */
export function geminiDefaultVoices() {
  const words = traits()
  return PREBUILT.map(([id, kind, trait]) => ({ id, name: `${kind === 'girl' ? msg`女` : msg`男`} · ${words[trait] ?? trait}` }))
}

const DELIVERY_TAG = /\[([^\]\n]{1,40})\]\s*/g

/** The line as Gemini is asked to say it: its [emotion] tags as a spoken-style prompt in front. */
export function geminiSpeechText(text) {
  const raw = String(text ?? '')
  const tags = [...new Set([...raw.matchAll(DELIVERY_TAG)].map(match => match[1].trim().replace(/地$/, '')).filter(Boolean))]
  const line = raw.replace(DELIVERY_TAG, '').trim()
  return tags.length ? `用${tags.join('、')}的语气说：${line}` : line // i18n-ignore: a prompt for the voice, in the story's language
}

export function createGeminiSource() {
  const voicesOf = media => (media.geminiTtsVoices?.length ? media.geminiTtsVoices : geminiDefaultVoices())
  const providerOf = ({ media, providers }) => providers.find(p => p.id === media.geminiTtsProvider)
  return {
    id: 'gemini',
    get label() {
      return msg`Gemini 朗读`
    },
    chunkMax: 300,
    // Kept in the text: geminiSpeechText turns them into the style prompt.
    emotion: () => 'tags',
    model: media => media.geminiTtsModel,
    configured: ctx => Boolean(ctx.media.geminiTtsModel) && Boolean(providerOf(ctx)) && providerOf(ctx).api !== 'anthropic-messages',
    list: ({ media }) => voicesOf(media).map(v => ({ ref: `gemini:${v.id}`, label: v.name ? `${v.id}（${v.name}）` : v.id })),
    target: rest => (rest ? { voice: rest } : null),
    async synth({ voice, text }, ctx) {
      const { media, proxy, signal } = ctx
      const provider = providerOf(ctx)
      if (!provider) throw httpError(400, msg`还没选 Gemini 朗读用的供应商：在「配图与朗读 → 朗读来源」里选用「Gemini」模板建的那个`)
      const model = media.geminiTtsModel
      let json
      try {
        json = await googleRequest(provider, `/models/${model}:generateContent`, {
          body: {
            contents: [{ role: 'user', parts: [{ text: geminiSpeechText(text) }] }],
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
          },
          signal,
          proxy: proxy(),
        })
      } catch (error) {
        if (signal?.aborted) throw error
        const hint = error.providerStatus === 404 ? msg`（模型名不对，或者「${provider.name}」不是 Google 的地址${isGoogle(provider) ? '' : msg`：要选用「Gemini」模板建的供应商`}）` : ''
        throw httpError(502, `${providerError(provider, error)}${hint}`)
      }
      const part = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data || p.inline_data?.data)
      if (!part) {
        const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || ''
        throw httpError(502, msg`${provider.name} · ${model} 没有返回声音${why ? msg`（${why}）` : ''}`)
      }
      const data = part.inlineData ?? part.inline_data
      try {
        // Raw 16-bit PCM, its rate in the type (audio/L16;codec=pcm;rate=24000).
        return audioOf(Buffer.from(data.data, 'base64'), { contentType: data.mimeType ?? data.mime_type ?? '', pcmRate: 24000 })
      } catch (error) {
        throw httpError(502, msg`${provider.name}：${error.message}`)
      }
    },
  }
}
