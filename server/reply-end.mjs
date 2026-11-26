// How a provider's reply ended, when it did not end as one should: kept back partway by the model's content check,
// the stream closed without saying it was over, or said to be over in the middle of a sentence. All three are
// upstream's doing (the model, or the provider or relay in between): this app takes in all that comes.
import { replyBlocks } from '../web/shared/basic.js'
import { cutAtGate } from '../web/shared/game/marks.js'
import { hasUpdateBlock } from './mvu.mjs'

// Why a model answered with no text, or stopped partway, as providers pass it on (Gemini's blockReason /
// finishReason, an OpenAI-style content_filter): its own content check, not this app or the API.
export const PROHIBITED = /PROHIBITED_CONTENT|BLOCKLIST|SPII/i
export const RECITATION = /RECITATION/i
export const FILTERED = /SAFETY|content_filter|content_policy/i
const REFUSED = /^refusal$/i

// What an API says when a reply ended as it should, or at the output limit (told apart elsewhere).
const NORMAL = /^(?:stop|end_turn|stop_sequence|completed|eos|max_tokens|length|max_output_tokens|tool_use|tool_calls|function_call|pause_turn)$/i
// An update block that is being written: the story before it is whole, and 自动补写变量 makes up for the block.
const OPEN_UPDATE = /<(update(?:variable)?)>(?![\s\S]*<\/\1>)/i
// A tag or a piece of one at the very end (`<font color="#9`, `</`), or a mark that has more to come.
const MID_TAG = /<\/?(?:[A-Za-z][^<>\n]{0,200})?$/
const MID_SENTENCE = /[，、；“「『（(]$/
const WORD_END = /[㐀-鿿\w]$/
// A line that ends on a word as it should: a choice or a list's item, a status line.
const LISTED = /^\s*(?:[A-Za-z0-9一二三四五六七八九十]{1,3}\s*[.、．)）:：]|[-*•·▪◆■●>|#])|[:：|｜]/

/** Whether the text stops in the middle. @param more - something is due after the story (an update block). */
export function stopsMidway(text, { more = false } = {}) {
  const end = String(text ?? '').trimEnd()
  if (!end) return false
  if (MID_TAG.test(end) || MID_SENTENCE.test(end)) return true
  return more && WORD_END.test(end) && !LISTED.test(end.slice(end.lastIndexOf('\n') + 1))
}

/**
 * What became of a reply, or null when nothing is wrong with how it ended:
 * 'filtered' - the model's content check; 'dropped' - the stream ended with no word that it was over, or with a
 * reason that is none; 'halfway' - said to be over, in the middle of a sentence.
 * @param end - { stop: the reason the API gave, or null; ended: whether the stream said it was over }.
 * @param more - an update block is due at the end of a whole reply.
 */
export function upstreamCut(text, { stop = null, ended = true } = {}, { more = false } = {}) {
  const reason = String(stop ?? '')
  const source = String(text ?? '')
  if (OPEN_UPDATE.test(source)) return null
  const written = hasUpdateBlock(source)
  if (PROHIBITED.test(reason) || RECITATION.test(reason) || FILTERED.test(reason) || REFUSED.test(reason)) return written ? null : 'filtered'
  if (!stopsMidway(source, { more: more && !written })) return null
  return !ended || (reason && !NORMAL.test(reason)) ? 'dropped' : 'halfway'
}

/** Whether 自动补写变量 waits: the story stops midway, so it is to be written on first (its block comes with the rest). */
export const waitsForRest = truncated => ['paused', 'filtered', 'dropped', 'halfway'].includes(truncated)

// A stop on a line of its own: a choice's line has words before its mark.
const OWN_LINE = /^\s*[【]\s*(?:检定|战斗)[^【】\n]*】\s*$/
const STORY = /^(?:content|maintext|main_text|gametxt|game_text|story|narrative|正文|剧情|故事)$/i

/**
 * Whether a reply still being written has come to a stop that is sure to end it: what tells the story from a plan or a
 * list of choices may be yet to come, so only a mark on a line of its own, in the story's own wrapper or in a reply
 * that has no blocks at all. → { wrapper: the one left open, or null }, or null.
 */
export function surelyAtGate(text, stops) {
  const source = String(text ?? '')
  const { text: upTo, gate } = cutAtGate(source, stops)
  if (!gate) return null
  const line = upTo.split('\n').filter(item => !/^\s*<\//.test(item)).at(-1) ?? ''
  if (!OWN_LINE.test(line)) return null
  const blocks = replyBlocks(source)
  const at = source.indexOf(line)
  const around = blocks.find(block => block.start < at && at < block.end)
  if (!around) return blocks.length ? null : { wrapper: null }
  return STORY.test(around.name) ? { wrapper: around.close === source.length ? around.name : null } : null
}
