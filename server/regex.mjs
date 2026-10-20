// 正则管理: the global regex scripts (every chat) and the scripts a card or a
// preset carries, each with its own switch. A chat runs the global ones first,
// then its preset's, then its card's (chats.mjs scriptsOf), as SillyTavern does.
// Scripts that change what is sent change the history the model reads again,
// so the next turn writes the cache once more; display-only ones never do.
import { randomUUID } from 'node:crypto'
import { normalizeScripts } from '../web/shared/regex.js'
import { BASIC_ID } from '../web/shared/basic.js'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_SCRIPTS = 200
const MAX_TEXT = 20000

/** Scripts from the page or a SillyTavern file → stored ones, each with an id of its own. */
export function cleanScripts(list) {
  if (!Array.isArray(list)) throw httpError(400, msg`正则列表的格式不对`)
  if (list.length > MAX_SCRIPTS) throw httpError(400, msg`正则太多（最多 ${MAX_SCRIPTS} 条）`)
  const seen = new Set()
  return normalizeScripts(list).map(script => {
    if (script.findRegex.length > MAX_TEXT || script.replaceString.length > MAX_TEXT) throw httpError(400, msg`「${script.scriptName || script.findRegex.slice(0, 24)}」太长了`)
    const id = script.id && !seen.has(script.id) ? script.id.slice(0, 64) : randomUUID()
    seen.add(id)
    return { ...script, id }
  })
}

export function createRegex(store) {
  return {
    async list() {
      return { scripts: await store.getRegex() }
    },
    async save(scripts) {
      return { scripts: await store.saveRegex(cleanScripts(scripts)) }
    },
    /** Scripts from SillyTavern files go after the ones already here; an id already taken gets a new one. */
    async importScripts(scripts) {
      const current = await store.getRegex()
      const taken = new Set(current.map(s => s.id))
      const added = cleanScripts(scripts).map(s => (taken.has(s.id) ? { ...s, id: randomUUID() } : s))
      if (!added.length) throw httpError(400, msg`文件里没有可用的正则（要有「查找」的表达式）`)
      const saved = await store.saveRegex(cleanScripts([...current, ...added]))
      return { scripts: saved, added: added.length }
    },
    async saveCardScripts(cardId, scripts) {
      const card = await store.getCard(cardId)
      card.regexScripts = cleanScripts(scripts)
      await store.saveCard(card)
      return { scripts: card.regexScripts }
    },
    async savePresetScripts(presetId, scripts) {
      if (presetId === BASIC_ID) throw httpError(400, msg`基础预设自带的正则不能改`)
      const preset = await store.getPreset(presetId)
      preset.regexScripts = cleanScripts(scripts)
      await store.savePreset(preset)
      return { scripts: preset.regexScripts }
    },
  }
}
