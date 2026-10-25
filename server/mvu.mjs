// MVU cards (variables updated by an <UpdateVariable> block at the end of each
// reply): telling them apart, and writing a missing block afterwards (补写变量).
// In a long chat the block is the part most often dropped, after a preset's own
// end blocks or once the history no longer shows earlier ones.
import { entryText, entryTitle, isConstant, isInitvar } from './worldbook.mjs'

const MVU = /_\.set\s*\(|UpdateVariable|JSONPatch/
const BLOCK = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i

/** Whether the card (its own fields, and the books given) asks for MVU update blocks. */
export function usesMvu(card, books = []) {
  const texts = [card?.systemPrompt, card?.postHistoryInstructions, ...books.flatMap(book => (book?.entries ?? []).filter(e => e.enabled !== false).map(e => e.content))]
  return texts.some(text => MVU.test(String(text ?? '')))
}

/** Whether a reply already carries an update block (closed or not). */
export function hasUpdateBlock(text) {
  return /<UpdateVariable>/i.test(String(text ?? ''))
}

/** The update block in a model's answer, or ''. An answer that wrote only its body gets the tags. */
export function extractUpdate(text) {
  const answer = String(text ?? '')
  const block = BLOCK.exec(answer)
  if (block) return block[0].trim()
  const patch = /<JSONPatch>[\s\S]*?<\/JSONPatch>/i.exec(answer)
  if (patch) return `<UpdateVariable>\n${patch[0].trim()}\n</UpdateVariable>`
  return ''
}

const ONLY_BLOCK = '只输出这一个 <UpdateVariable>…</UpdateVariable> 块，不要正文、解释或思考过程，也不要续写剧情。'

/** Asked inside the conversation (askInContext): the model has the rules and the story already. */
export function fillInstruction() {
  return [
    '（暂停扮演。这一条不是剧情，不要回应剧情，也不要续写。）',
    '你上一条回复漏写了结尾的变量更新块。',
    '按系统提示里这张卡的变量更新规则和输出格式，为上一条回复的剧情补写这一轮的 <UpdateVariable> 块：分析本轮哪些变量变了，写出更新命令，格式和平时每轮结尾一样。',
    ONLY_BLOCK,
  ].join('\n')
}

// The card's entries about variables: how to write updates and what each one means.
const RULES = /UpdateVariable|JSONPatch|变量|mvu|_\.set\s*\(/i
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…（后略）` : text)

/**
 * A self-contained request for a model that has not seen the chat (the reply
 * came from a subscription session, which cannot be borrowed): the card's
 * variable rules, the variables before the reply, the reply itself.
 * @param render - entry → its text for this state (EJS and macros done).
 */
export function fillRequest({ books, render, state, reply, maxTokens = 3000 }) {
  const rules = books
    .flatMap(book => book.entries ?? [])
    .filter(e => e.enabled !== false && isConstant(e) && !isInitvar(e) && (RULES.test(entryTitle(e)) || /UpdateVariable|JSONPatch/.test(entryText(e))))
    .sort((a, b) => a.order - b.order)
    .map(e => `【${entryTitle(e)}】\n${render(e)}`)
    .filter(text => text.trim())
    .join('\n\n')
  const system = [
    '你负责一场互动小说的变量记录。用户消息里是这张角色卡的变量规则、本轮之前的变量值和本轮的剧情。',
    '这一轮的剧情回复漏写了结尾的变量更新块。按变量规则里的更新规则和输出格式，为这段剧情补写这一轮的 <UpdateVariable> 块：分析本轮哪些变量变了，写出更新命令，格式和规则要求的每轮结尾一样。',
    ONLY_BLOCK,
  ].join('\n')
  const user = [
    `<变量规则>\n${clip(rules || '（卡里没有单独的变量规则，按 JSONPatch 格式写：<UpdateVariable><JSONPatch>[{"op":"replace","path":"/路径","value":新值}]</JSONPatch></UpdateVariable>）', 24000)}\n</变量规则>`,
    `<本轮之前的变量>\n${clip(JSON.stringify(state ?? {}, null, 1), 16000)}\n</本轮之前的变量>`,
    `<本轮剧情>\n${clip(String(reply ?? ''), 12000)}\n</本轮剧情>`,
    '只输出 <UpdateVariable>…</UpdateVariable> 这一个块。',
  ].join('\n\n')
  return { system, messages: [{ role: 'user', content: user }], maxTokens }
}
