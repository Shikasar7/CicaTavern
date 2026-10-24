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
  themes: ['standard', 'open'],
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
  themes: 'standard',
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

// A time box the model closed with another tag, or not at all, ends with its line;
// choices the model did not close yet (still streaming, or cut off) run to the end.
const TIME_BOX_SOURCE = '<time_box>(?:([\\s\\S]*?)<\\/time_box>|([^\\n]*?)(?:<\\/[\\w-]+>|$))'
const TIME_BOX = new RegExp(TIME_BOX_SOURCE, 'im')
const CHOICES = /<choices>([\s\S]*?)(?:<\/choices>|$)/i
/** Both blocks, for hiding them from the story text. */
export const TIME_BOX_BLOCK = new RegExp(TIME_BOX_SOURCE, 'gim')
export const CHOICES_BLOCK = /<choices>[\s\S]*?(?:<\/choices>|$)/gi
const ITEM = /^\s*(?:[-*•]\s*)?(?:[A-Da-d]|[1-4]|[①②③④])\s*[.、:：)）．]\s*/

/** The time box's parts (time, place, weather…), or null when the reply has none. */
export function timeBoxOf(text) {
  const match = TIME_BOX.exec(String(text ?? ''))
  if (!match) return null
  const parts = (match[1] ?? match[2]).split(/[｜|]/).map(part => part.trim()).filter(Boolean)
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
    .replace(new RegExp(`${TIME_BOX_SOURCE}\\s*`, 'gim'), '')
    .replace(/<choices>[\s\S]*?(?:<\/choices>|$)\s*/gi, '')
}

// Choices a reply ends with in a card's or preset's own format, so they become
// the same buttons as the built-in preset's <choices>:
//   <w2g> / <options> / <选项> blocks (A：… B：…);
//   labelled lines: 「🩶堕落选项🩶：……」 (two or more, at the end);
//   a heading such as 「请选择你的下一步行动：」 followed by two or more items;
//   two or more A–D lines at the very end.
// Only the end of a reply is read: a list in the middle of the story stays story.

const BLOCK = /<(w2g|options|选项)>([\s\S]*?)<\/\1>/i
const LETTER = /^\s*(?:[-*•]\s*)?([A-Da-d]|[1-6]|[①②③④⑤⑥])\s*[.、:：)）．]\s*/
// No \p{…} here: the phone's Node (no ICU) cannot compile it, and the server loads this file.
// Letters are Latin and CJK; emoji the pictograph and symbol blocks.
const WORD = 'A-Za-z\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF'
const EMOJI = '\\u{1F000}-\\u{1FAFF}\\u2190-\\u21FF\\u2300-\\u23FF\\u2460-\\u24FF\\u25A0-\\u27BF\\u2900-\\u297F\\u2B00-\\u2BFF\\u3030\\u303D\\u3297\\u3299\\u00A9\\u00AE\\u203C\\u2049\\u2122\\u2139'
// 「🩶堕落选项🩶：……」「**探索选项**：……」. The symbol runs are plain classes (they take ** too):
// `(?:[^…]|\*\*)*` could split every ** two ways, and a line opening on a long run of them
// (**·**·**·…) took seconds to minutes to turn down.
const LABELLED = new RegExp(`^\\s*[^${WORD}0-9\\s]*\\s*([${WORD}]{1,8}?)选项\\s*[^${WORD}0-9\\s：:]*\\s*[：:]\\s*(\\S.*)$`, 'u') // i18n-ignore: a pattern
const HEADING = new RegExp(`^\\s*(?:[#>*\\-—\\s]|[${EMOJI}\\uFE0F\\u200D])*[^。！？!?\\n]{0,16}(选择|选项|行动|下一步|接下来)[^。！？!?\\n]{0,16}[：:]\\s*(?:\\*\\*)?\\s*$`, 'u') // i18n-ignore: a pattern
const BULLET = new RegExp(`^\\s*(?:[-*•·]|[${EMOJI}][${EMOJI}\\uFE0F\\u200D]*)\\s*`, 'u')
const DIVIDER = /^\s*(?:[-—─━=*_~]\s*){3,}$/
const MAX = 4
const TAIL = 24

const tidy = text => text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** One block's items: A–D lines when it has them, else every line. */
function blockItems(body) {
  const lines = body.split('\n').map(line => line.trim()).filter(Boolean)
  const marked = lines.filter(line => LETTER.test(line))
  return (marked.length ? marked : lines).map(line => tidy(line.replace(LETTER, ''))).filter(Boolean)
}

/**
 * The reply's choices in another format, and its text without them.
 * @returns {{ choices: string[], text: string }} choices empty when there are none (text unchanged).
 */
export function otherChoices(text) {
  const source = String(text ?? '')
  const block = BLOCK.exec(source)
  if (block) {
    const items = blockItems(block[2])
    if (items.length >= 2) return { choices: items.slice(0, MAX), text: (source.slice(0, block.index) + source.slice(block.index + block[0].length)).trimEnd() }
  }
  const lines = source.split('\n')
  // Walk up from the end over blank lines and dividers, gathering a run of items.
  const items = []
  let kind = ''
  let start = lines.length
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TAIL); i--) {
    const line = lines[i]
    if (!line.trim() || (DIVIDER.test(line) && !items.length)) {
      if (!items.length) start = i
      continue
    }
    const labelled = LABELLED.exec(line)
    if (labelled && (!kind || kind === 'label')) {
      kind = 'label'
      items.unshift(`${labelled[1]}：${tidy(labelled[2])}`) // i18n-ignore: the story's own words
      start = i
      continue
    }
    if (items.length && HEADING.test(line)) {
      start = i
      kind = kind || 'heading'
      break
    }
    if ((!kind || kind === 'bullet') && BULLET.test(line) && !LETTER.test(line)) {
      kind = 'bullet'
      items.unshift(tidy(line.replace(BULLET, '')))
      start = i
      continue
    }
    if ((!kind || kind === 'letter') && LETTER.test(line) && /^[A-Da-d]/.test(line.trim().replace(/^[-*•]\s*/, ''))) {
      kind = 'letter'
      items.unshift(tidy(line.replace(LETTER, '')))
      start = i
      continue
    }
    break
  }
  // Bullets are only choices under a heading saying so; labelled and A–D lines stand on their own.
  const headed = start < lines.length && HEADING.test(lines[start])
  const ok = items.length >= 2 && (kind === 'label' || (kind === 'letter' && items.length >= 3) || headed)
  if (!ok) return { choices: [], text: source }
  const rest = lines.slice(0, start)
  while (rest.length && (!rest.at(-1).trim() || DIVIDER.test(rest.at(-1)))) rest.pop()
  return { choices: items.filter(Boolean).slice(0, MAX), text: rest.join('\n') }
}
