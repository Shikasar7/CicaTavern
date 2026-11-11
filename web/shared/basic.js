// The built-in preset (基础预设): its options, shared by the server (the
// prompt text, server/basic.mjs) and the page (the options panel), and the two
// blocks it asks the model for, which the page draws itself: a time box before
// the story and four choices after it.
//   <time_box>10月19日 周一 傍晚6:20｜旧城茶馆二楼｜小雨</time_box>
//   <choices>
//   A. 接过茶，问她刚才想说什么
//   …
//   </choices>

// Reasoning in its own tag (web/app.js folds it, server/state.mjs leaves it out of the story text):
// <thinking>, <think>, <cot_reasoning>, <draft>, <CoT>, <思考>, <思考过程>, <思维链>, <推理>… Matched
// without case; a tag name only, for <(…)>…</\1>. Here rather than in vn.js, which imports this file.
export const FOLD_TAG = '[\\w~-]*(?:think|draft|reasoning)[\\w~-]*|cot(?:[_~-][\\w~-]*)?|[\\w~-]*[_~-]cot|思考(?:过程)?|思维链?|推理(?:过程)?|草稿' // i18n-ignore: a pattern
// A reasoning block, and one still open at the end. Thinking often names the blocks it plans to write (「结尾
// <choices>…」): a mention there is no block.
export const REASONING = new RegExp(`<(${FOLD_TAG})>[\\s\\S]*?</\\1>|<(${FOLD_TAG})>(?![\\s\\S]*</\\2>)[\\s\\S]*$`, 'gi')
/** `text` without its reasoning blocks. */
export const outsideReasoning = text => String(text ?? '').replace(REASONING, '')

const REASONING_CLOSED = new RegExp(`<(${FOLD_TAG})>[\\s\\S]*?</\\1>`, 'gi')
/** Where `text`'s closed reasoning blocks are: [{ inner, close, end }], the offsets of what is inside, of the closing tag, and after it. */
export function reasoningSpans(text) {
  const spans = []
  for (const match of String(text ?? '').matchAll(REASONING_CLOSED)) {
    const end = match.index + match[0].length
    spans.push({ inner: match.index + match[1].length + 2, close: end - match[1].length - 3, end })
  }
  return spans
}

const TAG_LIKE = /<(\/?)([A-Za-z_][\w~:.-]*)([^<>\n]*)>/g
/**
 * `text` with the tags its thinking only names written ＜like this＞, where the same tag is a real block outside the
 * thinking: what a card's page reads with its own `<fox_selc>([\s\S]*?)</fox_selc>` (getChatMessages) then finds the
 * real block, not the mention (「结尾输出<fox_selc>」) and the story after it. The thinking reads the same.
 */
export function quietMentions(text) {
  const source = String(text ?? '')
  const spans = reasoningSpans(source)
  if (!spans.length) return source
  const outside = new Set()
  let last = 0
  for (const span of [...spans, { inner: source.length, close: source.length, end: source.length }]) {
    for (const match of source.slice(last, span.inner).matchAll(TAG_LIKE)) outside.add(match[2].toLowerCase())
    last = span.end
  }
  let out = ''
  last = 0
  for (const span of spans) {
    const inner = source.slice(span.inner, span.close).replace(TAG_LIKE, (whole, slash, name, rest) => (outside.has(name.toLowerCase()) ? `＜${slash}${name}${rest}＞` : whole)) // i18n-ignore: full-width brackets
    out += source.slice(last, span.inner) + inner
    last = span.close
  }
  return out + source.slice(last)
}

export const BASIC_ID = 'basic'

/** Each option's values; the first listed is not necessarily the default (see BASIC_DEFAULTS). */
export const BASIC_OPTIONS = Object.freeze({
  person: ['greeting', 'second', 'third', 'first'],
  style: ['natural', 'cinematic', 'delicate', 'light', 'classical', 'webnovel', 'literary', 'diary', 'realist', 'earthy', 'calm'],
  pace: ['natural', 'slow', 'steady', 'fast'],
  impersonation: ['off', 'standard', 'strict'],
  knowledge: ['off', 'on'],
  selfCheck: ['off', 'on'],
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
  pace: 'natural',
  impersonation: 'standard',
  knowledge: 'on',
  selfCheck: 'off',
  themes: 'standard',
  jailbreak: 'off',
  intimacy: 'natural',
  choices: 'four',
  timeBox: 'on',
  statusBar: 'auto',
  // 正文字数: the range a reply's story picks its length from, in characters; 0 is no bound on that side.
  lengthMin: 0,
  lengthMax: 0,
})

/** The most 正文字数 can ask for. */
export const MAX_LENGTH = 20000
const lengthCount = value => {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LENGTH) : 0
}

// Values that went, and the closest one left. 白描 (up to 2.3.2) read the same as 淡然 and 电影感.
const REPLACED = Object.freeze({ style: { plain: 'calm' } })

/** Saved options with unknown keys dropped and unknown values back at their default. */
export function cleanBasic(value, options = BASIC_OPTIONS, defaults = BASIC_DEFAULTS) {
  const out = {}
  for (const [key, values] of Object.entries(options)) {
    const saved = REPLACED[key]?.[value?.[key]] ?? value?.[key]
    out[key] = values.includes(saved) ? saved : defaults[key]
  }
  // 正文字数 is a number, not one of a list; a lower bound above the upper one is the upper one.
  if ('lengthMax' in defaults) {
    const max = lengthCount(value?.lengthMax)
    const min = lengthCount(value?.lengthMin)
    out.lengthMin = max && min > max ? max : min
    out.lengthMax = max
  }
  return out
}


// The visual novel preset (视觉小说预设): the built-in preset's options, saved apart
// (settings.vn), and its own on how the story is told: more dialogue, short narration,
// scenery left to the background picture, a beat per paragraph for the text box.
// 直连对话: talking to the model with no card. Its chats hang on this hidden card, so everything a chat has works for them.
export const DIRECT_CARD = 'direct'

export const VN_ID = 'vn'

export const VN_OPTIONS = Object.freeze({
  ...BASIC_OPTIONS,
  dialogue: ['more', 'most', 'balanced'],
  narration: ['brief', 'minimal', 'normal'],
  scenery: ['brief', 'normal'],
  paging: ['short', 'normal'],
  flavor: ['auto', 'galgame', 'adventure'],
})

export const VN_DEFAULTS = Object.freeze({
  ...BASIC_DEFAULTS,
  dialogue: 'more',
  narration: 'brief',
  scenery: 'brief',
  paging: 'short',
  flavor: 'auto',
})

export const cleanVn = value => cleanBasic(value, VN_OPTIONS, VN_DEFAULTS)

/** The built-in presets: the basic one and the visual novel one. */
export const isBuiltinPreset = id => id === BASIC_ID || id === VN_ID

/** Where a built-in preset's options are saved in the settings. */
export const builtinKey = id => (id === VN_ID ? 'vn' : 'basic')

/** A built-in preset's options as saved. */
export const builtinOptions = (settings, id) => (id === VN_ID ? cleanVn(settings?.vn) : cleanBasic(settings?.basic))

/** Where a built-in preset's own edits are saved in the settings (cleanBuiltinEdits). */
export const editsKey = id => (id === VN_ID ? 'vnEdits' : 'basicEdits')

// Where a player's own entry in a built-in preset goes: 'top' after the narrator's rules, 'rules' in the
// every-turn section after the options' paragraphs, 'turn' with each turn's message (as a preset's
// after-history entries go).
export const ADDED_PLACES = ['top', 'rules', 'turn']
export const MAX_ADDED = 60
const MAX_TEXT = 40000
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '')

/**
 * A built-in preset's edits as kept (settings.basicEdits / vnEdits): `texts` its own paragraphs rewritten, by
 * the key of the paragraph with the option it was written for (server/basic.mjs basicParts); `off` those
 * switched off; `added` the player's own entries; `regexScripts` the player's own regex, after the preset's two.
 */
export function cleanBuiltinEdits(value) {
  const saved = isRecord(value) ? value : {}
  const texts = {}
  if (isRecord(saved.texts)) for (const [key, body] of Object.entries(saved.texts)) if (/^[\w:,-]{1,80}$/.test(key) && typeof body === 'string') texts[key] = text(body)
  const off = Array.isArray(saved.off) ? [...new Set(saved.off.filter(key => typeof key === 'string' && /^[\w:,-]{1,80}$/.test(key)))].slice(0, 200) : []
  const seen = new Set()
  const added = (Array.isArray(saved.added) ? saved.added : [])
    .filter(entry => isRecord(entry) && typeof entry.id === 'string' && /^[\w-]{1,60}$/.test(entry.id) && !seen.has(entry.id) && seen.add(entry.id))
    .slice(0, MAX_ADDED)
    .map(entry => ({
      id: entry.id,
      name: text(entry.name).trim().slice(0, 80) || '新条目', // i18n-ignore: a saved name, only when one went missing
      content: text(entry.content),
      enabled: entry.enabled !== false,
      place: ADDED_PLACES.includes(entry.place) ? entry.place : 'rules',
    }))
  const regexScripts = Array.isArray(saved.regexScripts) ? saved.regexScripts.filter(isRecord) : []
  return { texts, off, added, regexScripts }
}

// A time box the model closed with another tag, or not at all, ends with its line;
// choices the model did not close yet (still streaming, or cut off) run to the end.
const TIME_BOX_SOURCE = '<time_box>(?:([\\s\\S]*?)<\\/time_box>|([^\\n]*?)(?:<\\/[\\w-]+>|$))'
const TIME_BOX = new RegExp(TIME_BOX_SOURCE, 'im')
const CHOICES = /<choices>([\s\S]*?)(?:<\/choices>|$)/i
/** Both blocks, for hiding them from the story text. */
export const TIME_BOX_BLOCK = new RegExp(TIME_BOX_SOURCE, 'gim')
export const CHOICES_BLOCK = /<choices>[\s\S]*?(?:<\/choices>|$)/gi
/** 写前自查: never story, whichever way the option stands now. One left open ends with its paragraph. */
export const SELF_CHECK_BLOCK = /<self_check>(?:[\s\S]*?<\/self_check>|(?![\s\S]*<\/self_check>)[\s\S]*?(?:\n\s*\n|$))\s*/gi
const ITEM = /^\s*(?:[-*•]\s*)?(?:[A-Ia-i]|[1-9]|[①-⑨])\s*[.、:：)）．]\s*/
/** The most choices a reply shows: A–I, so the visual novel's number keys reach each one. */
export const MAX_CHOICES = 9
/** A choice's letter: A, B, C… */
export const choiceLetter = i => String.fromCharCode(65 + i)

/** The time box's parts (time, place, weather…), or null when the reply has none. */
export function timeBoxOf(text) {
  const match = TIME_BOX.exec(outsideReasoning(text))
  if (!match) return null
  const parts = (match[1] ?? match[2]).split(/[｜|]/).map(part => part.trim()).filter(Boolean)
  return parts.length ? parts : null
}

/**
 * The reply's choices (at most MAX_CHOICES), or [] when it has none. A block the model
 * did not close yet (still streaming) counts too.
 */
export function choicesOf(text) {
  const match = CHOICES.exec(outsideReasoning(text))
  if (!match) return []
  const lines = match[1].split('\n').map(line => line.trim()).filter(Boolean)
  const marked = lines.filter(line => ITEM.test(line))
  return (marked.length ? marked : lines).map(line => line.replace(ITEM, '').trim()).filter(Boolean).slice(0, MAX_CHOICES)
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
//   three or more A–I lines at the very end.
// Only the end of a reply is read: a list in the middle of the story stays story.

const BLOCK = /<(w2g|options|选项)>([\s\S]*?)<\/\1>/i
const LETTER = /^\s*(?:[-*•]\s*)?([A-Ia-i]|[1-9]|[①-⑨])\s*[.、:：)）．]\s*/
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
const MAX = MAX_CHOICES
const TAIL = 24

const tidy = text => text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()

/** One block's items: A–I lines when it has them, else every line. */
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
    if ((!kind || kind === 'letter') && LETTER.test(line) && /^[A-Ia-i]/.test(line.trim().replace(/^[-*•]\s*/, ''))) {
      kind = 'letter'
      items.unshift(tidy(line.replace(LETTER, '')))
      start = i
      continue
    }
    break
  }
  // Bullets are only choices under a heading saying so; labelled and A–I lines stand on their own.
  const headed = start < lines.length && HEADING.test(lines[start])
  const ok = items.length >= 2 && (kind === 'label' || (kind === 'letter' && items.length >= 3) || headed)
  if (!ok) return { choices: [], text: source }
  const rest = lines.slice(0, start)
  while (rest.length && (!rest.at(-1).trim() || DIVIDER.test(rest.at(-1)))) rest.pop()
  return { choices: items.filter(Boolean).slice(0, MAX), text: rest.join('\n') }
}
