// What to read aloud from a reply: quoted speech in the character's voice,
// the rest as narration (dropped when there is no narrator voice). Chunks of
// about 100 characters read more evenly than single sentences on the xiaoya
// bridge: each synthesis call starts its own intonation, so short calls make
// the voice jump between sentences.

const QUOTE = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g
const SENTENCE_END = /(?<=[。！？!?…~～♪])/
const SPEAKABLE = /[\p{L}\p{N}]/u

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
  const clean = String(emotion ?? '').replace(/[[\]【】\n]/g, '').replace(/[，,]/g, '、').trim().slice(0, 40)
  return NO_EMOTION.test(clean) ? '' : `[${clean}] `
}

/**
 * @returns {{ kind: 'dialogue'|'narration', text: string }[]} in reading order.
 * @param narration - false drops narration (no narrator voice).
 * @param max - characters per chunk, or { dialogue, narration } when the two
 *   voices take different lengths (cloud voices bill per request, so longer).
 * @param tags - put a line's emotion before it as a [tag] (voices that act on
 *   bracket tags, such as Fish; the server drops them for the others).
 */
export function speechChunks(text, { narration = true, max = 100, tags = false } = {}) {
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
    runs.push({ kind: 'dialogue', text: match[0].slice(1, -1), tag: tags && voiceTag ? emotionTag(voiceTag[1]) : '' })
  }
  if (last < source.length) runs.push({ kind: 'narration', text: source.slice(last) })

  // Clean, drop what is not read, then join neighbours read by the same voice.
  const merged = []
  for (const run of runs) {
    if (run.kind === 'narration' && !narration) continue
    const clean = cleanForSpeech(run.text)
    if (!SPEAKABLE.test(clean)) continue
    const said = (run.tag ?? '') + clean
    const previous = merged.at(-1)
    if (previous && previous.kind === run.kind) previous.text += (/[，。！？、；：,.!?…~～]$/.test(previous.text) ? '' : '，') + said
    else merged.push({ kind: run.kind, text: said })
  }
  return merged.flatMap(run => splitLong(run.text, limit(run.kind)).map(piece => ({ kind: run.kind, text: piece.trim() }))).filter(chunk => SPEAKABLE.test(chunk.text))
}
