// 你的角色 and 文风 (设置 → 写作, web/personas.js): the lists store.mjs keeps
// (getList / updateList, shaped by web/shared/personas.js), changed one item
// at a time, read from files, and picked by cards. A chat keeps what it started
// with (chats.mjs chatPicks), so nothing here touches a chat's prefix.
import { cardsOf, KINDS, personasInFile, sameItem, stylesInFile } from '../web/shared/personas.js'
import { httpError, newId } from './store.mjs'
import { msg } from './i18n.mjs'

/** The fields of an item the page may change, by kind. */
const FIELDS = { persona: ['name', 'title', 'description'], style: ['name', 'text'] }

const picked = (kind, body) => Object.fromEntries(FIELDS[kind].filter(key => typeof body?.[key] === 'string').map(key => [key, body[key]]))

export function createPickLists(store) {
  /** A list as the page reads it: each item with the cards that picked it. */
  const view = list => ({ ...list, items: list.items.map(item => ({ ...item, cardIds: cardsOf(list, item.id) })) })
  const missing = kind => httpError(404, kind === 'persona' ? msg`没有这个角色` : msg`没有这个文风`)
  const has = (list, id, kind) => {
    if (!list.items.some(item => item.id === id)) throw missing(kind)
  }

  /** `item` added after the others. → { item, list }. */
  async function add(kind, item) {
    const made = KINDS[kind].clean({ ...item, id: newId() })
    const list = await store.updateList(kind, list => ({ ...list, items: [...list.items, made] }))
    return { item: made, list: view(list) }
  }

  return {
    async list(kind) {
      return view(await store.getList(kind))
    },
    /** A new item from what the page filled in (a persona is named 你 until it says otherwise). */
    create(kind, body) {
      return add(kind, picked(kind, body))
    },
    async update(kind, id, body) {
      let item = null
      const list = await store.updateList(kind, list => {
        has(list, id, kind)
        return { ...list, items: list.items.map(one => (one.id === id ? (item = KINDS[kind].clean({ ...one, ...picked(kind, body), id })) : one)) }
      })
      return { item, list: view(list) }
    },
    /**
     * A copy to change apart from the original; no card picks it. A persona keeps its name (the player's, in the
     * story) and says it is a copy in its note; a style says it in its name. The page may name it itself.
     */
    async copy(kind, id, body = {}) {
      const from = (await store.getList(kind)).items.find(item => item.id === id)
      if (!from) throw missing(kind)
      const said = kind === 'persona'
        ? { title: from.title ? msg`${from.title}（副本）` : msg`副本` }
        : { name: from.name ? msg`${from.name}（副本）` : msg`副本` }
      return add(kind, { ...from, ...said, ...picked(kind, body) })
    },
    /** The default stays (another is made the default first); cards that picked this one use the default again. */
    async remove(kind, id) {
      const list = await store.updateList(kind, list => {
        has(list, id, kind)
        if (list.defaultId === id) throw httpError(400, msg`默认的不能删：先把另一个设为默认`)
        return { ...list, items: list.items.filter(item => item.id !== id) }
      })
      return view(list)
    },
    /** The one new chats use on cards that picked none. */
    async setDefault(kind, id) {
      return view(await store.updateList(kind, list => {
        has(list, id, kind)
        return { ...list, defaultId: id }
      }))
    },
    /**
     * The cards that pick an item, ticked at once: `ids` is all of them (cards that exist). A card picks one of each
     * kind, so ticking it here takes it off the one it had. → the list and the cards that changed.
     */
    async setCards(kind, id, ids) {
      const known = new Set((await store.listCards()).map(card => card.id))
      const wanted = new Set((Array.isArray(ids) ? ids.map(String) : []).filter(cardId => known.has(cardId)))
      const changed = []
      const list = await store.updateList(kind, list => {
        has(list, id, kind)
        const cards = { ...list.cards }
        for (const cardId of known) {
          if (wanted.has(cardId) && cards[cardId] !== id) {
            cards[cardId] = id
            changed.push(cardId)
          } else if (!wanted.has(cardId) && cards[cardId] === id) {
            delete cards[cardId]
            changed.push(cardId)
          }
        }
        return { ...list, cards }
      })
      return { list: view(list), changed }
    },
    /**
     * Items from a file (`text` as read, `filename` for a style in plain text), each added after the others. One
     * the list (or the file, before it) has already is skipped. → { added, skipped, list }.
     */
    async importFile(kind, { text, filename = '' } = {}) {
      let found
      if (kind === 'persona') {
        let json
        try {
          json = JSON.parse(String(text ?? ''))
        } catch {
          throw httpError(400, msg`不是 JSON 文件`)
        }
        found = personasInFile(json)
      } else {
        found = stylesInFile(String(text ?? ''), String(filename))
      }
      if (!found.length) throw httpError(400, kind === 'persona' ? msg`文件里没有角色设定：要 SillyTavern 导出的角色备份（personas），或者本应用导出的` : msg`文件里没有文风：要 SillyTavern 的系统提示词文件、本应用导出的文风，或者一个文本文件`)
      const added = []
      let skipped = 0
      const list = await store.updateList(kind, list => {
        for (const item of found) {
          if ([...list.items, ...added].some(other => sameItem(kind, other, item))) {
            skipped++
            continue
          }
          added.push(KINDS[kind].clean({ ...item, id: newId() }))
        }
        return { ...list, items: [...list.items, ...added] }
      })
      return { added, skipped, list: view(list) }
    },
    /**
     * What a card's new chats use: `personaId` / `styleId` an item's id, or '' for the default; left out, it stays.
     * → both lists.
     */
    async setCardPicks(cardId, { personaId, styleId } = {}) {
      await store.getCard(cardId)
      const out = {}
      for (const [kind, id] of [['persona', personaId], ['style', styleId]]) {
        if (typeof id !== 'string') {
          out[kind] = view(await store.getList(kind))
          continue
        }
        out[kind] = view(await store.updateList(kind, list => {
          if (id) has(list, id, kind)
          const cards = { ...list.cards }
          if (id) cards[cardId] = id
          else delete cards[cardId]
          return { ...list, cards }
        }))
      }
      return out
    },
    /** A card deleted: what it picked goes with it (the items stay). */
    async dropCard(cardId) {
      for (const kind of Object.keys(KINDS)) {
        await store.updateList(kind, list => {
          const cards = { ...list.cards }
          delete cards[cardId]
          return { ...list, cards }
        })
      }
    },
    /** A new version of a card (imported as a card of its own) picks what the old one did, unless it picked already. */
    async inheritCard(fromId, toId) {
      for (const kind of Object.keys(KINDS)) {
        const list = await store.getList(kind)
        if (!list.cards[fromId] || list.cards[toId]) continue
        await store.updateList(kind, list => (list.cards[fromId] && !list.cards[toId] ? { ...list, cards: { ...list.cards, [toId]: list.cards[fromId] } } : list))
      }
    },
  }
}
