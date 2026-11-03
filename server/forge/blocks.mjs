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

// Quoted as asked, in full-width quotes (a model writing Chinese slips into them), or not quoted at all.
const attrsOf = text =>
  Object.fromEntries(
    [...String(text).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|「([^」]*)」|([^\s"'>/]+))/g)].map(([, key, ...values]) => [key.toLowerCase(), values.find(value => value !== undefined)]),
  )

/** A body wrapped whole in one ``` fence (the model's habit), without it; anything else as it is. */
function unfence(text) {
  const match = /^```[\w+-]*[ \t]*\n?([\s\S]*?)\n?```$/.exec(text)
  return match && !/^```/m.test(match[1]) ? match[1].trim() : text
}

/**
 * A block's body for a piece that was `before`: its fences kept when the piece
 * itself is a fenced block (an HTML front-end opening, a ```yaml entry).
 */
export const bodyFor = (block, before) => (/^\s*```/.test(String(before ?? '')) ? block.raw : block.body)

/**
 * An answer → { reply, blocks: [{ tag, attrs, body, raw }] } for the given tag names
 * (`raw`: the body with a fence around it kept, see bodyFor).
 * A reply left open runs into the first block; an answer without any tags is all reply.
 */
export function readBlocks(text, tags) {
  const names = tags.join('|')
  const source = String(text ?? '')
  const block = new RegExp(`<(${names})\\b([^>]*)>([\\s\\S]*?)(?:</\\1\\s*>|(?=<(?:${names})\\b|</?reply>)|$)`, 'gi')
  // A body without fences, or a close tag of another kind the model ended it with.
  const strayClose = new RegExp(`\\s*</(?:${names})\\s*>\\s*$`, 'i')
  const opening = new RegExp(`<(?:${names})\\b`, 'i')
  const bodyOf = body => {
    const raw = String(body).replace(strayClose, '').trim()
    return { body: unfence(raw), raw }
  }
  const reply = (section(source, 'reply') || (opening.test(source) ? '' : source.trim())).split(opening)[0].trim()
  const blocks = [...source.matchAll(block)].map(([, tag, attrs, body]) => ({ tag: tag.toLowerCase(), attrs: attrsOf(attrs), ...bodyOf(body) }))
  return { reply: reply.slice(0, 2000), blocks }
}

// A reply that says it changed something, and one that says there was nothing to change.
const CLAIMS = /已经?(把|将|给|为|改|加|添|新增|删|写|补|调整|替换|更新|设置|做)|我(把|将|给|为)|改(成|为|好|了)|加(了|上|入)|添加|新增|新建|写(了|入|进)|补(充|上)|调整(了|为)|删(除|掉|了)|替换|更新(了|为)|\b(added|changed|updated|rewrote|removed|replaced|created)\b/i
const DECLINES = /不需要|无需|不用改|没有改|没改|无法|做不到|不能改|不建议|不必|\b(no changes?|not needed|cannot|can't)\b/i

/**
 * Whether an answer read as `read` ({ reply, changes, dropped? }) promised changes it did not
 * deliver: blocks that could not be taken, or a reply saying it changed things and no block at all.
 */
export function claimsChanges(read) {
  if (read.changes.length) return false
  if (read.dropped?.length) return true
  const reply = String(read.reply ?? '')
  return CLAIMS.test(reply) && !DECLINES.test(reply)
}

/** The follow-up asked once after such an answer: what went wrong, and to answer again in the format. */
export function missingNote(read) {
  const named = reason => (read.dropped ?? []).filter(item => item.reason === reason).map(item => `「${item.name}」`).join('')
  const why = [
    named('unshown') ? `条目${named('unshown')}这次没有附上全文，不能改，不要再输出它们（要补的内容可以写成新条目）` : '',
    named('unknown') ? `字段名${named('unknown')}不在可用的名字里` : '',
  ].filter(Boolean)
  return `【格式提醒】上面的回答说做了修改，但里面没有能采用的改动${why.length ? `：${why.join('；')}` : '：改动没有写在规定的标签里'}，所以什么都没有改。
请重新回答：先写 <reply>，再按要求的格式把每一处改动的完整内容写在对应的标签里，标签外不写别的。确实不需要改的话，只写 <reply> 说明原因。`
}

/** Earlier turns as the next request tells them: what was asked, what was answered, what the user took. */
export function historyLines(turns, max = 6) {
  return turns
    .filter(turn => turn.assistant)
    .slice(-max)
    .map(turn => `- 用户：${turn.user.text}\n  你：${turn.assistant.reply || '（只给了改动）'}${outcomeText(turn)}`)
}

function outcomeText(turn) {
  // Said so plainly: a reply that told of changes it never wrote out would otherwise read as done.
  if (!turn.assistant?.changes.length) return turn.assistant ? '（这次没有写出改动，内容没有变）' : ''
  if (turn.outcome?.undone) return '（用户采用后又撤销了）'
  if (turn.outcome?.discarded) return '（用户没有采用）'
  if (turn.outcome?.applied) return `（用户采用了其中 ${turn.outcome.applied.length} 处）`
  return ''
}
