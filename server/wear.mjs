// 衣柜 and who wears what. A cast member's outfits are the usual one (roster.mjs `outfit`) and those in `wardrobe`
// ({ id, name, tags, when }): the English tags are what a picture is drawn with, word for word, the name what people and
// the story's model read. Who wears what is never kept on its own: it follows from the story's path, the marks
// 【换装|名字|套名】 in the replies (web/shared/vn.js WEAR_MARK) and the player's own changes (node.wear) in order, so a
// branch, a rewrite or an edit has its own. An outfit nobody listed (a mark's 泳装) is the chat's alone (chat.wardrobe),
// its tags written once by whoever writes the first picture prompt with it.
import { anchorKey } from '../web/shared/draw.js'
import { outfitSaid, wearMarks, wearValue } from '../web/shared/vn.js'
import { findEntry, nameFor } from './roster.mjs'

export const USUAL = 'usual'
export const USUAL_NAME = '平时'
const TEMP_MAX = 12
const same = (a, b) => anchorKey(a) === anchorKey(b) && anchorKey(a) !== ''

/**
 * Whether someone has more than the usual outfit, or a variable of the card's own that says what they wear (wearPath):
 * only then is the story told of it, and the clothes not written by the prompt's model.
 */
export const hasWardrobe = entry => Boolean(entry?.wardrobe?.length || entry?.wearPath)
export const anyWardrobe = roster => (roster ?? []).some(hasWardrobe)

/** An entry's outfits: the usual one first, then the wardrobe, then the chat's own. */
export function outfitsOf(entry, chat = null) {
  return [
    { id: USUAL, name: USUAL_NAME, tags: entry.outfit ?? '', when: '' },
    ...(entry.wardrobe ?? []),
    ...(chat?.wardrobe?.[entry.id] ?? []).map(item => ({ id: '', name: item.name, tags: item.tags ?? '', when: '', temp: true })),
  ]
}

/** The outfit an entry has by its id, else by its name; one of a name alone (not listed yet) as it is written. */
function outfitBy(entry, chat, { id = '', name = '' }) {
  const list = outfitsOf(entry, chat)
  return list.find(item => id && item.id === id) ?? list.find(item => same(item.name, name)) ?? (name ? { id: '', name, tags: '', when: '', temp: true } : list[0])
}

/**
 * What each cast member with a wardrobe wears: Map(entry id → outfit { id, name, tags, when }).
 * @param path - the chat's nodes from the start to the one looked at.
 * @param options.anchor - words of the last reply (a picture's anchor): what comes after them has not happened yet.
 */
export function wearOn(chat, path, roster, { anchor = '' } = {}) {
  const worn = new Map()
  const people = (roster ?? []).filter(hasWardrobe)
  if (!people.length) return worn
  for (const entry of people) worn.set(entry.id, outfitsOf(entry, chat)[0])
  // What each one's own variable said last (wearPath): only a change of it changes their clothes, so one the player chose
  // stays until then.
  const by = new Map()
  path.forEach((node, index) => {
    if (node.deleted) return
    if (node.role === 'assistant') {
      const key = index === path.length - 1 && anchor ? anchorKey(anchor) : ''
      const text = String(node.text ?? '')
      for (const mark of wearMarks(text)) {
        // The picture's words come before the mark: not changed yet.
        if (key && anchorKey(text.slice(0, mark.at)).includes(key)) continue
        const entry = findEntry(roster, mark.name, chat.names?.user)
        if (entry && worn.has(entry.id)) worn.set(entry.id, outfitBy(entry, chat, { name: mark.outfit }))
      }
      for (const entry of people) {
        const words = entry.wearPath ? wearValue(node.state, entry.wearPath) : ''
        if (!words || words === by.get(entry.id)) continue
        by.set(entry.id, words)
        worn.set(entry.id, outfitSaid(outfitsOf(entry, chat), words) ?? outfitBy(entry, chat, { name: words }))
      }
    }
    for (const [id, choice] of Object.entries(node.wear ?? {})) {
      const entry = people.find(item => item.id === id)
      if (entry) worn.set(id, outfitBy(entry, chat, choice))
    }
  })
  return worn
}

/** The path from the start to a node, by its parents. */
export function pathToNode(chat, nodeId) {
  const path = []
  for (let node = chat.nodes[nodeId]; node && !path.includes(node); node = chat.nodes[node.parent]) path.unshift(node)
  return path
}

// What the turn's message says of it (engine.mjs takes the block out of the older messages).
export const WEAR_BLOCK = /\n*<穿着>\n[\s\S]*?\n<\/穿着>/g

/** The turn's word on clothes, or '' when nobody has a wardrobe. */
export function wearBlock(chat, path, roster) {
  const worn = wearOn(chat, path, roster)
  if (!worn.size) return ''
  const people = roster.filter(entry => worn.has(entry.id))
  const name = entry => nameFor(entry, chat.names?.user)
  // Those whose own variable says it: changed by changing that, no mark.
  const marked = people.filter(entry => !entry.wearPath)
  const followed = people.filter(entry => entry.wearPath)
  const listed = entry => outfitsOf(entry, chat).map(item => (item.when ? `${item.name}（${item.when}）` : item.name)).join('、')
  return [
    '<穿着>',
    // What is worn now in words too: a name alone (平时) leaves the story to make its clothes up.
    `现在：${people.map(entry => `${name(entry)} — ${worn.get(entry.id).name}${worn.get(entry.id).tags ? `（${worn.get(entry.id).tags.slice(0, 160)}）` : ''}`).join('；')}`,
    `各人的衣服：${people.map(entry => `${name(entry)}：${listed(entry)}`).join('；')}`,
    marked.length ? `正文里的衣着和上面一致。剧情里谁换了衣服，就在换好之后的那一行前面单独写一行【换装|名字|套名】，名字和套名照抄；换的不在上面，套名就写那件衣服的叫法。没人换就不写，脱了外套、弄湿了不算换。` : '正文里的衣着和上面一致。',
    followed.length ? `${followed.map(entry => `${name(entry)}的衣服看变量「${entry.wearPath}」`).join('，')}：换了就更新这个变量，是上面有的就写那个名字，不用写换装标记。` : '',
    '</穿着>',
  ].filter(Boolean).join('\n')
}

/** The frame with everyone in what they wear: the outfit's tags join the looks, which the prompt's writer never writes. */
export function dress(frame, worn) {
  if (!worn?.size) return frame
  const add = entry => {
    const tags = worn.get(entry.id)?.tags
    return tags ? { ...entry, looks: [entry.looks, tags].filter(Boolean).join(', ') } : entry
  }
  return { ...frame, characters: frame.characters.map(person => ({ ...person, entry: add(person.entry) })) }
}

// 衣服[沈岚]: …, the line the prompt's writer adds for an outfit nobody has described yet.
const CLOTHES_LINE = /^\s*(?:[-*•>]+\s*)?\**(?:衣服|clothes)\s*[[【(（]?\s*([^\]】)）:：]{1,40}?)\s*[\]】)）]?\**\s*[:：]\s*(.+)$/i

/** That line taken out of an answer: { text, clothes: [{ name, tags }] }. */
export function takeClothes(answer) {
  const clothes = []
  const text = String(answer ?? '').split(/\r?\n/).filter(line => {
    const match = CLOTHES_LINE.exec(line)
    if (!match) return true
    const tags = match[2].replace(/[*`]/g, '').trim().slice(0, 400)
    if (tags) clothes.push({ name: match[1].trim(), tags })
    return false
  }).join('\n')
  return { text, clothes }
}

/** Those kept in the chat: the tags of outfits worn now that had none. → whether anything was. */
export function keepClothes(chat, roster, worn, clothes) {
  let kept = false
  for (const { name, tags } of clothes) {
    const entry = findEntry(roster, name, chat.names?.user)
    const outfit = entry && worn.get(entry.id)
    if (!outfit || outfit.id || outfit.tags) continue
    const list = (chat.wardrobe?.[entry.id] ?? []).filter(item => !same(item.name, outfit.name))
    chat.wardrobe = { ...(chat.wardrobe ?? {}), [entry.id]: [...list, { name: outfit.name, tags }].slice(-TEMP_MAX) }
    kept = true
  }
  return kept
}

/** For 换衣服: everyone with a wardrobe, what they can wear and what they wear now. */
export function wearView(chat, path, roster) {
  const worn = wearOn(chat, path, roster)
  return (roster ?? []).filter(entry => worn.has(entry.id)).map(entry => {
    const now = worn.get(entry.id)
    const outfits = outfitsOf(entry, chat)
    // One the story marked and nobody has described: there to be seen, and to go back to.
    if (!outfits.some(item => item.id === now.id && item.name === now.name)) outfits.push(now)
    return {
      id: entry.id,
      name: nameFor(entry, chat.names?.user),
      player: entry.player,
      now: { id: now.id, name: now.name },
      outfits: outfits.map(({ id, name, tags, when, temp }) => ({ id, name, tags, when, ...(temp ? { temp: true } : {}) })),
    }
  })
}

/** The player's own change, on the newest message: { entry id: { id } | { name } }. → the node, or null when nothing was named. */
export function changeWear(chat, node, roster, change) {
  const wear = { ...(node.wear ?? {}) }
  let any = false
  for (const [id, choice] of Object.entries(change ?? {})) {
    const entry = roster.find(item => item.id === id && hasWardrobe(item))
    if (!entry || !choice || typeof choice !== 'object') continue
    const outfit = outfitsOf(entry, chat).find(item => (choice.id ? item.id === choice.id : item.name === choice.name))
    if (!outfit) continue
    wear[id] = outfit.id ? { id: outfit.id, name: outfit.name } : { id: '', name: outfit.name }
    any = true
  }
  if (!any) return null
  node.wear = wear
  return node
}
