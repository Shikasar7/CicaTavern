// 屏蔽词 (设置 → 屏蔽词; web/shared/blockwords.js): one list for every chat.
// Every request to a model goes through blockRequest() last, after the card's,
// preset's and global regex, so the system prompt (card, preset, persona,
// always-on lore), each turn's lore and preset text, the history and the new
// message all reach the model without the words. The chat keeps what was
// written; the same list sends the same text again, so the cache still hits.
// A change rewrites the cache from the first place it touches (blockImpact).
import { randomUUID } from 'node:crypto'
import { blockText, blocksIn, normalizeBlockWords } from '../web/shared/blockwords.js'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_WORDS = 500
const MAX_WORD = 200
const MAX_EXCEPTIONS = 50

/** Entries from the page → stored ones, each with an id of its own. */
export function cleanBlockWords(list) {
  if (!Array.isArray(list)) throw httpError(400, msg`屏蔽词列表的格式不对`)
  if (list.length > MAX_WORDS) throw httpError(400, msg`屏蔽词太多（最多 ${MAX_WORDS} 个）`)
  const seen = new Set()
  return normalizeBlockWords(list).map(word => {
    if (word.word.length > MAX_WORD || word.replacement.length > MAX_WORD || word.exceptions.some(e => e.length > MAX_WORD)) throw httpError(400, msg`「${word.word.slice(0, 24)}」太长了`)
    if (word.exceptions.length > MAX_EXCEPTIONS) throw httpError(400, msg`「${word.word.slice(0, 24)}」的例外太多（最多 ${MAX_EXCEPTIONS} 个）`)
    const id = word.id && !seen.has(word.id) ? word.id.slice(0, 64) : randomUUID()
    seen.add(id)
    return { ...word, id }
  })
}

/** Whether any entry changes what is sent. */
export const blocksPrompt = words => words.some(word => blocksIn(word, 'prompt'))

/** Text on its way to the model. */
export const blockSent = (text, words) => blockText(text, words, { target: 'prompt' })

function blockContent(content, words) {
  if (typeof content === 'string') return blockSent(content, words)
  if (!Array.isArray(content)) return content
  return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? { ...part, text: blockSent(part.text, words) } : part))
}

/** A model request ({ system, messages, … }) with the words applied; its other fields (cache marks) kept. */
export function blockRequest(request, words) {
  if (!blocksPrompt(words)) return request
  return {
    ...request,
    ...(request.system !== undefined ? { system: blockContent(request.system, words) } : {}),
    messages: (request.messages ?? []).map(message => ({ ...message, content: blockContent(message.content, words) })),
  }
}

export function createBlockWords(store) {
  return {
    async list() {
      return { words: await store.getBlockWords() }
    },
    /** @returns { words, before } — before is the list as it was. */
    async save(list) {
      const before = await store.getBlockWords()
      return { words: await store.saveBlockWords(cleanBlockWords(list)), before }
    },
  }
}
