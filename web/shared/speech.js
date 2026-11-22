// What to read aloud from a reply: quoted speech in the character's voice,
// the rest as narration (dropped when there is no narrator voice). Chunks of
// about 100 characters read more evenly than single sentences on the xiaoya
// bridge: each synthesis call starts its own intonation, so short calls make
// the voice jump between sentences.

const QUOTE = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g
const SENTENCE_END = /(?<=[。！？!?…~～♪])/
const SPEAKABLE = /[\p{L}\p{N}]/u

/** The sources set up to read now, by id (/api/media/voices): a bridge that does not answer is not one. */
export const readyVoiceSources = sources => (sources ?? []).filter(source => source.configured && source.ok !== false).map(source => source.id)

/**
 * The sources to ask about 默认对白音色 once 朗读来源 is set up: none with a default chosen, or from a
 * server that keeps none; each source is asked about once, whatever the answer was.
 */
export function sourcesToAsk(sources, media) {
  if (!media || !('defaultVoice' in media) || media.defaultVoice) return []
  const asked = new Set(media.defaultVoiceAsked ?? [])
  return readyVoiceSources(sources).filter(id => !asked.has(id))
}

/** Remove what a voice would read out as noise: markup, dividers, macros, brackets. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/\[voice:[^\]\n]*\]/gi, '')
    .replace(/^[\s　]*[—–\-=*·•~]{2,}[\s　]*$/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/[*_#`~]{1,}/g, '')
    .replace(/[—–\-=]{3,}/g, '')
    .replace(/[【】［］\[\]]/g, '')
    .replace(/[\s　]+/g, ' ')
    .replace(/ ?([，。！？、；：,.!?;:]) ?/g, '$1')
    // Line breaks in Chinese prose are not pauses between words.
    .replace(/(?<=[⺀-鿿＀-￯“”「」]) (?=[⺀-鿿＀-￯“”「」])/g, '')
    .trim()
}

function splitLong(text, max) {
  const out = []
  let current = ''
  const push = piece => {
    if ((current + piece).length > max && current) {
      out.push(current)
      current = ''
    }
    current += piece
  }
  for (const sentence of text.split(SENTENCE_END)) {
    if (sentence.length <= max) push(sentence)
    else for (const clause of sentence.split(/(?<=[，,；;])/)) {
      if (clause.length <= max) push(clause)
      else for (let i = 0; i < clause.length; i += max) push(clause.slice(i, i + max))
    }
  }
  if (current) out.push(current)
  return out
}

// 小白X writes [voice:情绪:台词] right after a quoted line; the 情绪 part says how to say it.
const VOICE_AFTER = /^\s*\[voice:([^\]:\n]*):[^\]\n]*\]/i
const NO_EMOTION = /^(|无|默认|普通|正常|none|normal|default|neutral)$/i

/** The emotion of a 小白X voice tag as a delivery tag ([害羞地小声]), or '' when it says nothing. */
export function emotionTag(emotion) {
  const clean = String(emotion ?? '').replace(/[[\]【】\n]/g, '').replace(/[，,]/g, '、').trim().slice(0, 40) // i18n-ignore: story text read aloud
  return NO_EMOTION.test(clean) ? '' : `[${clean}] `
}

/**
 * @returns {{ kind: 'dialogue'|'narration', text: string }[]} in reading order.
 * @param narration - false drops narration (no narrator voice).
 * @param max - characters per chunk, or { dialogue, narration } when the two
 *   voices take different lengths (cloud voices bill per request, so longer).
 * @param tags - put a line's emotion before it as a [tag] (voices that act on
 *   bracket tags, such as Fish; the server drops them for the others).
 * @param speakerOf - (quote text) → who says it, for each quote in order: the
 *   chunk's `speaker`, and two people's lines are never joined.
 * @param tone - how a line is said when the reply gives it no emotion of its own (a
 *   cast member's 默认语气), as text or (speaker) → text; only with `tags`.
 * @returns {{ kind: 'dialogue'|'narration', text: string, speaker?: string|null }[]}
 */
export function speechChunks(text, { narration = true, max = 100, tags = false, speakerOf = null, tone = null } = {}) {
  const limit = kind => (typeof max === 'number' ? max : max?.[kind] ?? 100)
  // An options block is not part of the story; voice tags give a line its emotion, then go.
  const source = String(text ?? '').replace(/<small>[\s\S]*?<\/small>/gi, '')
  const runs = []
  let last = 0
  for (const match of source.matchAll(QUOTE)) {
    if (match.index < last) continue
    if (match.index > last) runs.push({ kind: 'narration', text: source.slice(last, match.index) })
    last = match.index + match[0].length
    const voiceTag = VOICE_AFTER.exec(source.slice(last))
    if (voiceTag) last += voiceTag[0].length
    const said = match[0].slice(1, -1)
    const speaker = speakerOf ? speakerOf(said) ?? null : undefined
    // The reply's own emotion for the line, else the speaker's 默认语气.
    const tag = tags ? emotionTag(voiceTag?.[1]) || emotionTag(typeof tone === 'function' ? tone(speaker) : tone) : ''
    runs.push({ kind: 'dialogue', text: said, tag, ...(speakerOf ? { speaker } : {}) })
  }
  if (last < source.length) runs.push({ kind: 'narration', text: source.slice(last) })

  // Clean, drop what is not read, then join neighbours read by the same voice.
  const merged = []
  for (const run of runs) {
    if (run.kind === 'narration' && !narration) continue
    const clean = cleanForSpeech(run.text)
    if (!SPEAKABLE.test(clean)) continue
    const previous = merged.at(-1)
    const joined = previous && previous.kind === run.kind && previous.speaker === run.speaker
    // A line said the same way as the one it joins carries no tag of its own.
    const said = (run.tag && !(joined && previous.tag === run.tag) ? run.tag : '') + clean
    if (joined) {
      previous.text += (/[，。！？、；：,.!?…~～]$/.test(previous.text) ? '' : '，') + said // i18n-ignore: story text read aloud
      previous.tag = run.tag ?? ''
    } else merged.push({ kind: run.kind, text: said, tag: run.tag ?? '', ...('speaker' in run ? { speaker: run.speaker } : {}) })
  }
  // Each chunk is a request of its own: one cut from the middle of a line keeps the line's tag.
  return merged.flatMap(run => {
    let tag = ''
    return splitLong(run.text, limit(run.kind)).map(piece => {
      const text = piece.trim()
      const own = /^\[[^\]]*\] /.test(text)
      const said = !own && tag && run.kind === 'dialogue' ? tag + text : text
      tag = [...said.matchAll(/\[[^\]]*\] /g)].at(-1)?.[0] ?? tag
      return { kind: run.kind, text: said, ...('speaker' in run ? { speaker: run.speaker } : {}) }
    })
  }).filter(chunk => SPEAKABLE.test(chunk.text))
}

// ─── Levelling: every voice about as loud as the next ───────────────────
// Voices come out of their services at very different levels: a whispering Fish voice was 20 dB
// under a sharp one, too quiet to hear at a volume the others were right at. Each chunk is brought
// to one loudness before it plays (web/media.js), then a cast member's own 音量 is put on top.

export const LEVEL_TARGET_DB = -20 // gated RMS in dBFS: about -20 LUFS for speech
const LEVEL_MOST = 10 // +20 dB at most: past that it is noise being raised
const LEVEL_LEAST = 0.25

/**
 * How loud samples are in dBFS: the mean power of 100 ms blocks, leaving out the pauses
 * (below -70 dBFS, or 10 dB under the mean of the rest); null when there is nothing to hear.
 * @param channels - Float32Arrays of the same length.
 */
export function loudnessDb(channels, sampleRate) {
  const length = channels[0]?.length ?? 0
  const block = Math.max(1, Math.round(sampleRate / 10))
  const powers = []
  for (let start = 0; start < length; start += block) {
    const end = Math.min(length, start + block)
    let sum = 0
    for (const data of channels) for (let i = start; i < end; i++) sum += data[i] * data[i]
    powers.push(sum / ((end - start) * channels.length))
  }
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length
  const heard = powers.filter(power => power > 1e-7)
  if (!heard.length) return null
  const floor = mean(heard) / 10
  return 10 * Math.log10(mean(heard.filter(power => power >= floor)))
}

/** The gain that brings audio this loud to LEVEL_TARGET_DB, times `volume` (a cast member's 音量, 1 = as levelled). */
export function levelGain(loudness, volume = 1) {
  const level = loudness == null ? 1 : Math.min(LEVEL_MOST, Math.max(LEVEL_LEAST, 10 ** ((LEVEL_TARGET_DB - loudness) / 20)))
  return level * (Number.isFinite(volume) && volume > 0 ? volume : 1)
}

/** Samples times `gain`; peaks over 0.8 are rounded off below full scale rather than clipped. */
export function applyGain(data, gain) {
  const out = new Float32Array(data.length)
  const knee = 0.8
  for (let i = 0; i < data.length; i++) {
    const value = data[i] * gain
    const size = Math.abs(value)
    out[i] = size <= knee ? value : Math.sign(value) * (knee + (1 - knee) * Math.tanh((size - knee) / (1 - knee)))
  }
  return out
}

/** The channels as a 16-bit PCM WAV file. */
export function wavBytes(channels, sampleRate) {
  const count = channels.length
  const frames = channels[0]?.length ?? 0
  const bytes = new Uint8Array(44 + frames * count * 2)
  const view = new DataView(bytes.buffer)
  const word = (at, text) => [...text].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  word(0, 'RIFF')
  view.setUint32(4, 36 + frames * count * 2, true)
  word(8, 'WAVE')
  word(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, count, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * count * 2, true)
  view.setUint16(32, count * 2, true)
  view.setUint16(34, 16, true)
  word(36, 'data')
  view.setUint32(40, frames * count * 2, true)
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (const data of channels) {
      const value = Math.max(-1, Math.min(1, data[i]))
      view.setInt16(at, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      at += 2
    }
  }
  return bytes
}
