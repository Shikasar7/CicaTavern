// 正则管理: the global regex scripts (every chat), 正则集 (regex sets: named lists
// of scripts for the cards ticked for them, kept in regex-sets.json) and the
// scripts a card or a preset carries, each with its own switch. A chat runs the
// global ones first, then its preset's, then its card's own, then the sets
// attached to its card (web/shared/regex.js chatScriptList; chats.mjs scriptsOf),
// as SillyTavern runs global, preset and then the card's scripts.
// Scripts that change what is sent change the history the model reads again,
// so the next turn writes the cache once more; display-only ones never do.
import { randomUUID } from 'node:crypto'
import { chatScriptList, normalizeScripts, setsOfCard } from '../web/shared/regex.js'
import { BASIC_ID } from '../web/shared/basic.js'
import { httpError, newId } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_SCRIPTS = 200
// A beautifier's replacement is a whole page of HTML and CSS: presets ship ones of 40 000 characters and more.
const MAX_TEXT = 400_000
const MAX_SETS = 200
const NAME_MAX = 80
const NOTE_MAX = 4000

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

/** A card with the scripts of the sets attached to it after its own: the export that takes them along. */
export function withAttachedScripts(card, sets) {
  const own = Array.isArray(card.regexScripts) ? card.regexScripts : []
  return { ...card, regexScripts: chatScriptList({ card: own, cardId: card.id, sets }) }
}

/** The sets attached to a card, as the card editor names them. */
export const attachedSummary = (sets, cardId) => setsOfCard(sets, cardId).map(set => ({ id: set.id, name: set.name, scripts: set.scripts.length }))

function setName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
  if (!name) throw httpError(400, msg`名字不能空着`)
  return name
}

const note = value => String(value ?? '').slice(0, NOTE_MAX)

/** `scripts` with ids `taken` does not have; `fresh`: every one a new id (a copy is a script of its own). */
function freshIds(scripts, taken = [], fresh = false) {
  const used = new Set(taken)
  return scripts.map(script => {
    const id = fresh || used.has(script.id) ? randomUUID() : script.id
    used.add(id)
    return { ...script, id }
  })
}

export function createRegex(store) {
  /** `change` (set → set) over one set as saved; 404 when it is gone. */
  async function saveSet(id, change) {
    let saved = null
    await store.updateRegexSets(async sets => {
      const set = sets.find(s => s.id === id)
      if (!set) throw httpError(404, msg`正则集不存在`)
      saved = await change(set)
      return sets.map(s => (s.id === id ? saved : s))
    })
    return saved
  }

  async function addSet({ name, description = '', scripts = [] }) {
    const set = { id: newId(), name: setName(name), description: note(description), cardIds: [], scripts: cleanScripts(scripts), createdAt: new Date().toISOString() }
    await store.updateRegexSets(sets => {
      if (sets.length >= MAX_SETS) throw httpError(400, msg`正则集太多（最多 ${MAX_SETS} 个）`)
      return [...sets, set]
    })
    return set
  }

  /**
   * A place scripts live, by the key the page and 对话修改 use: global, set-<id>, card-<id> or
   * preset-<id> → { key, scripts, save(scripts) → the scripts saved }.
   */
  async function placeOf(key) {
    if (key === 'global') return { key, scripts: await store.getRegex(), save: scripts => store.saveRegex(cleanScripts(scripts)) }
    if (key.startsWith('set-')) {
      const id = key.slice(4)
      const set = (await store.getRegexSets()).find(s => s.id === id)
      if (!set) throw httpError(404, msg`正则集不存在`)
      return { key, scripts: set.scripts, save: async scripts => (await saveSet(id, s => ({ ...s, scripts: cleanScripts(scripts) }))).scripts }
    }
    if (key.startsWith('card-')) {
      const card = await store.getCard(key.slice(5))
      return {
        key,
        scripts: Array.isArray(card.regexScripts) ? card.regexScripts : [],
        async save(scripts) {
          card.regexScripts = cleanScripts(scripts)
          await store.saveCard(card)
          return card.regexScripts
        },
      }
    }
    if (key.startsWith('preset-')) {
      if (key.slice(7) === BASIC_ID) throw httpError(400, msg`基础预设自带的正则不能改`)
      const preset = await store.getPreset(key.slice(7))
      return {
        key,
        scripts: preset.regexScripts ?? [],
        async save(scripts) {
          preset.regexScripts = cleanScripts(scripts)
          await store.savePreset(preset)
          return preset.regexScripts
        },
      }
    }
    throw httpError(400, msg`不认识的正则位置`)
  }

  return {
    async list() {
      const [scripts, sets] = await Promise.all([store.getRegex(), store.getRegexSets()])
      return { scripts, sets }
    },
    async save(scripts) {
      return { scripts: await store.saveRegex(cleanScripts(scripts)) }
    },
    /**
     * Scripts from SillyTavern files go after the ones already in `to` (global unless said: set-<id>,
     * card-<id> or preset-<id>), or into a new set named `name` (`to` = 'new'); an id already taken gets a new one.
     */
    async importScripts(scripts, to = 'global', name = '') {
      const incoming = cleanScripts(scripts)
      if (!incoming.length) throw httpError(400, msg`文件里没有可用的正则（要有「查找」的表达式）`)
      if (to === 'new') {
        const set = await addSet({ name: name || msg`导入的正则`, scripts: incoming })
        return { scripts: set.scripts, added: incoming.length, to: `set-${set.id}`, set }
      }
      const place = await placeOf(String(to || 'global'))
      const added = freshIds(incoming, place.scripts.map(s => s.id))
      const saved = await place.save([...place.scripts, ...added])
      return { scripts: saved, added: added.length, to: place.key }
    },
    async saveCardScripts(cardId, scripts) {
      return { scripts: await (await placeOf(`card-${cardId}`)).save(scripts) }
    },
    async savePresetScripts(presetId, scripts) {
      return { scripts: await (await placeOf(`preset-${presetId}`)).save(scripts) }
    },

    // ─── 正则集 ───────────────────────────────────────────────────────────
    /** A new set (empty, or with `scripts`); no card uses it yet. */
    createSet(body) {
      return addSet({ name: body.name || msg`新正则集`, description: body.description, scripts: body.scripts ?? [] })
    },
    /** A set's name, note or scripts, each only when given. */
    updateSet(id, body) {
      return saveSet(id, set => ({
        ...set,
        ...(body.name !== undefined ? { name: setName(body.name) } : {}),
        ...(body.description !== undefined ? { description: note(body.description) } : {}),
        ...(body.scripts !== undefined ? { scripts: cleanScripts(body.scripts) } : {}),
      }))
    },
    /** The cards that use a set, ticked at once: `ids` is all of them (cards that exist). → the set and the cards that changed. */
    async setCards(id, ids) {
      const known = new Set((await store.listCards()).map(card => card.id))
      const wanted = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].filter(cardId => known.has(cardId))
      let changed = []
      const set = await saveSet(id, set => {
        changed = [...wanted.filter(cardId => !set.cardIds.includes(cardId)), ...set.cardIds.filter(cardId => !wanted.includes(cardId))]
        return { ...set, cardIds: wanted }
      })
      return { set, changed }
    },
    /** A copy to change apart from the original, its scripts with ids of their own; no card uses it yet. */
    async copySet(id) {
      const set = (await store.getRegexSets()).find(s => s.id === id)
      if (!set) throw httpError(404, msg`正则集不存在`)
      return addSet({ name: msg`${set.name}（副本）`, description: set.description, scripts: freshIds(set.scripts, [], true) })
    },
    /** → the cards it was attached to, which let go of it with it. */
    async deleteSet(id) {
      let gone = null
      await store.updateRegexSets(sets => {
        gone = sets.find(s => s.id === id)
        if (!gone) throw httpError(404, msg`正则集不存在`)
        return sets.filter(s => s.id !== id)
      })
      return { ok: true, cardIds: gone.cardIds }
    },
    /** A card deleted: the sets let go of it (they stay, for the other cards or later). → the ids of those sets. */
    async dropCard(cardId) {
      const left = []
      await store.updateRegexSets(sets => sets.map(set => {
        if (!set.cardIds.includes(cardId)) return set
        left.push(set.id)
        return { ...set, cardIds: set.cardIds.filter(id => id !== cardId) }
      }))
      return left
    },
    /** The sets attached to a card, in their order. */
    async setsOf(cardId) {
      return setsOfCard(await store.getRegexSets(), cardId)
    },
    /**
     * Scripts (`ids`) copied or moved (`move`) out of one place into another, or into a new set
     * named `name` (`to` empty). Copies get ids of their own. The copy is saved before anything leaves.
     */
    async transfer({ from, to, ids, move = false, name = '' }) {
      const source = await placeOf(String(from ?? ''))
      const wanted = new Set(Array.isArray(ids) ? ids.map(String) : [])
      const picked = source.scripts.filter(s => wanted.has(s.id))
      if (!picked.length) throw httpError(400, msg`没选正则`)
      const key = String(to ?? '')
      if (key === source.key) throw httpError(400, msg`已经在这一组里了`)
      let into
      if (!key) {
        const set = await addSet({ name, scripts: freshIds(picked, [], move !== true) })
        into = { key: `set-${set.id}`, scripts: set.scripts, set }
      } else {
        const target = await placeOf(key)
        into = { key, scripts: await target.save([...target.scripts, ...freshIds(picked, target.scripts.map(s => s.id), move !== true)]) }
      }
      const left = move === true ? await source.save(source.scripts.filter(s => !wanted.has(s.id))) : source.scripts
      return { from: { key: source.key, scripts: left }, to: into, count: picked.length }
    },
  }
}
