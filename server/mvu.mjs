// MVU cards (variables updated by an <UpdateVariable> block at the end of each
// reply): telling them apart, and writing a missing block afterwards (补写变量).
// In a long chat the block is the part most often dropped, after a preset's own
// end blocks or once the history no longer shows earlier ones.
import { entryText, entryTitle, isConstant, isInitvar } from './worldbook.mjs'
import { UPDATE_BLOCK } from '../web/shared/vars.js'

const MVU = /_\.set\s*\(|UpdateVariable|JSONPatch/
const BLOCK = /<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i

/**
 * Whether the chat asks for MVU update blocks: in the card's own fields, the books given (the card's, and those
 * attached beside it) or the preset's prompts. Rules kept in a preset or an attached book count as the card's.
 */
export function usesMvu(card, books = [], preset = null) {
  const texts = [
    card?.systemPrompt,
    card?.postHistoryInstructions,
    ...books.flatMap(book => (book?.entries ?? []).filter(e => e.enabled !== false).map(e => e.content)),
    ...(preset?.prompts ?? []).filter(p => p?.enabled !== false).map(p => p.content),
  ]
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

// 修好这轮变量 (engine.mjs fixUpdate): the reply's own update block written again, whole, in place of the one it has.
const REWRITE = '重新写上一条回复这一轮完整的 <UpdateVariable> 块，它会整个替换原来那个：分析本轮哪些变量变了，写出更新命令，格式和平时每轮结尾一样。变量名和路径要和现有变量完全一致，值的类型和每轮能变多少都要符合规则（原来那块里的数值不一定对）；原来写对的照样保留。'
const CHECK = '程序没查出格式问题，玩家觉得这一轮的变量不对。请对照上一条回复的剧情核对：剧情里发生了、变量没跟上的补上，写错的改掉。'

/** The update blocks of a reply (not its <state> patches), as they are written. */
export function updateBlocks(text) {
  return [...String(text ?? '').matchAll(UPDATE_BLOCK)].filter(match => match[1].toLowerCase() !== 'state').map(match => match[0].trim())
}

/** A reply without its update blocks, its <state> patches left. */
export function withoutUpdateBlocks(text) {
  return String(text ?? '').replace(UPDATE_BLOCK, (block, tag) => (tag.toLowerCase() === 'state' ? block : '')).replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * Asked inside the conversation: the model has the rules and the story already; it gets what the program found
 * (issueLines) and the variables as they were before this turn's update.
 */
export function fixInstruction({ lines, state }) {
  return [
    '（暂停扮演。这一条不是剧情，不要回应剧情，也不要续写。）',
    lines.length ? `你上一条回复结尾的变量更新有问题，程序检查出：\n${lines.join('\n')}` : CHECK,
    `本轮更新之前的变量：\n${clip(JSON.stringify(state ?? {}, null, 1), 16000)}`,
    `按系统提示里这张卡的变量更新规则和输出格式，${REWRITE}`,
    ONLY_BLOCK,
  ].join('\n\n')
}

/** The same for a model that has not seen the chat (fillRequest), with the block the reply has. */
export function fixRequest({ books, render, state, reply, blocks, lines, maxTokens = 3000 }) {
  const request = fillRequest({ books, render, state, reply, maxTokens })
  request.system = [
    '你负责一场互动小说的变量记录。用户消息里是这张角色卡的变量规则、本轮之前的变量值、本轮的剧情和剧情结尾原来写的变量更新块。',
    `原来的变量更新块有问题。按变量规则里的更新规则和输出格式，${REWRITE}`,
    ONLY_BLOCK,
  ].join('\n')
  const told = lines.length ? `<程序查出的问题>\n${lines.join('\n')}\n</程序查出的问题>` : `<要做的>\n${CHECK}\n</要做的>`
  request.messages[0].content = request.messages[0].content.replace(/\n\n只输出 <UpdateVariable>…<\/UpdateVariable> 这一个块。$/, '')
    + `\n\n<原来的变量更新块>\n${clip(blocks.join('\n\n') || '（没有）', 8000)}\n</原来的变量更新块>\n\n${told}\n\n只输出 <UpdateVariable>…</UpdateVariable> 这一个块。`
  return request
}
