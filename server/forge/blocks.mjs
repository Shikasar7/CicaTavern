// The tagged blocks a 对话修改 answer is written in (修改角色卡 edit.mjs, a
// worldbook book-edit.mjs, a preset preset-edit.mjs): a <reply> to the user,
// then each changed piece written out in full, e.g.
//   <entry uid="3" keys="…">the whole entry</entry>
// Read leniently: a block ends at its close tag, the next block, the reply, or
// where an answer that was cut off ends.
import { section } from './prompts.mjs'

/** An attribute value as it goes into a tag the model reads. */
export const attr = value => String(value ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim()

/** Keywords as the model writes them: "a, b、c" → ['a', 'b', 'c']. */
export const splitKeys = text => [...new Set(String(text ?? '').split(/[,，、]/).map(key => key.trim()).filter(Boolean))].slice(0, 100)

const attrsOf = text => Object.fromEntries([...String(text).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, key, a, b]) => [key.toLowerCase(), a ?? b]))

/**
 * An answer → { reply, blocks: [{ tag, attrs, body }] } for the given tag names.
 * A reply left open runs into the first block; an answer without any tags is all reply.
 */
export function readBlocks(text, tags) {
  const names = tags.join('|')
  const source = String(text ?? '')
  const block = new RegExp(`<(${names})\\b([^>]*)>([\\s\\S]*?)(?:</\\1\\s*>|(?=<(?:${names})\\b|</?reply>)|$)`, 'gi')
  // A body without fences, or a close tag of another kind the model ended it with.
  const strayClose = new RegExp(`\\s*</(?:${names})\\s*>\\s*$`, 'i')
  const opening = new RegExp(`<(?:${names})\\b`, 'i')
  const bodyOf = body => String(body).replace(strayClose, '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
  const reply = (section(source, 'reply') || (opening.test(source) ? '' : source.trim())).split(opening)[0].trim()
  const blocks = [...source.matchAll(block)].map(([, tag, attrs, body]) => ({ tag: tag.toLowerCase(), attrs: attrsOf(attrs), body: bodyOf(body) }))
  return { reply: reply.slice(0, 2000), blocks }
}

/** Earlier turns as the next request tells them: what was asked, what was answered, what the user took. */
export function historyLines(turns, max = 6) {
  return turns
    .filter(turn => turn.assistant)
    .slice(-max)
    .map(turn => `- 用户：${turn.user.text}\n  你：${turn.assistant.reply || '（只给了改动）'}${outcomeText(turn)}`)
}

function outcomeText(turn) {
  if (!turn.assistant?.changes.length) return ''
  if (turn.outcome?.undone) return '（用户采用后又撤销了）'
  if (turn.outcome?.discarded) return '（用户没有采用）'
  if (turn.outcome?.applied) return `（用户采用了其中 ${turn.outcome.applied.length} 处）`
  return ''
}
