// The built-in preset (基础预设): its options, shared by the server (the
// prompt text, server/basic.mjs) and the page (the options panel), and the two
// blocks it asks the model for, which the page draws itself: a time box before
// the story and four choices after it.
//   <time_box>10月19日 周一 傍晚6:20｜旧城茶馆二楼｜小雨</time_box>
//   <choices>
//   A. 接过茶，问她刚才想说什么
//   …
//   </choices>

export const BASIC_ID = 'basic'

/** Each option's values; the first listed is not necessarily the default (see BASIC_DEFAULTS). */
export const BASIC_OPTIONS = Object.freeze({
  person: ['greeting', 'second', 'third', 'first'],
  style: ['natural', 'plain', 'cinematic', 'delicate', 'light', 'classical', 'webnovel'],
  impersonation: ['off', 'standard', 'strict'],
  knowledge: ['off', 'on'],
  jailbreak: ['off', 'soft', 'strong'],
  intimacy: ['restrained', 'natural', 'explicit'],
  choices: ['off', 'four'],
  timeBox: ['off', 'on'],
  statusBar: ['off', 'auto'],
})

export const BASIC_DEFAULTS = Object.freeze({
  person: 'greeting',
  style: 'natural',
  impersonation: 'standard',
  knowledge: 'on',
  jailbreak: 'off',
  intimacy: 'natural',
  choices: 'four',
  timeBox: 'on',
  statusBar: 'auto',
})

/** Saved options with unknown keys dropped and unknown values back at their default. */
export function cleanBasic(value) {
  const out = {}
  for (const [key, values] of Object.entries(BASIC_OPTIONS)) {
    out[key] = values.includes(value?.[key]) ? value[key] : BASIC_DEFAULTS[key]
  }
  return out
}

const TIME_BOX = /<time_box>([\s\S]*?)<\/time_box>/i
const CHOICES = /<choices>([\s\S]*?)(?:<\/choices>|$)/i
const ITEM = /^\s*(?:[-*•]\s*)?(?:[A-Da-d]|[1-4]|[①②③④])\s*[.、:：)）．]\s*/

/** The time box's parts (time, place, weather…), or null when the reply has none. */
export function timeBoxOf(text) {
  const match = TIME_BOX.exec(String(text ?? ''))
  if (!match) return null
  const parts = match[1].split(/[｜|]/).map(part => part.trim()).filter(Boolean)
  return parts.length ? parts : null
}

/**
 * The reply's choices (at most four), or [] when it has none. A block the model
 * did not close yet (still streaming) counts too.
 */
export function choicesOf(text) {
  const match = CHOICES.exec(String(text ?? ''))
  if (!match) return []
  const lines = match[1].split('\n').map(line => line.trim()).filter(Boolean)
  const marked = lines.filter(line => ITEM.test(line))
  return (marked.length ? marked : lines).map(line => line.replace(ITEM, '').trim()).filter(Boolean).slice(0, 4)
}

/** Remove both blocks (the page draws them on its own). */
export function withoutBasicBlocks(text) {
  return String(text ?? '')
    .replace(/<time_box>[\s\S]*?<\/time_box>\s*/gi, '')
    .replace(/<choices>[\s\S]*?(?:<\/choices>|$)\s*/gi, '')
}
