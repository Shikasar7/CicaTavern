// What SillyTavern needs that older cards were made without. Only on the way out: the card kept here stays as it is, and
// a card made elsewhere keeps its lists as its author left them.
import YAML from 'yaml'
import { LIST_GROWS } from '../../web/shared/status.js'
import { isInitvar } from '../worldbook.mjs'
import { BAR_LOAD, MVU_HELPER_ID, OWN_STATUS_SCRIPT } from './status.mjs'

// The bar's loader as it was: it reads what Tavern Helper puts in a frame, and shows only its title in anyone else's.
const OLD_LOAD = `async function load(){
  try{if(typeof waitGlobalInitialized==='function')await waitGlobalInitialized('Mvu')}catch(e){}
  try{const data=Mvu.getMvuData({type:'message',message_id:getCurrentMessageId()});draw((data&&data.stat_data)||{})}catch(e){draw({})}
}`
const CODE_BLOCK = /^```html\n([\s\S]*)\n```$/
const PAGE = /html>|<head>|<body/
export const INIT_BLOCK = /<initvar>\n([\s\S]*?)\n<\/initvar>/

/** The bar with the page around it that Tavern Helper asks for. Patched, not written again: a hand-edited bar stays edited. */
function currentBar(html) {
  const block = CODE_BLOCK.exec(html)
  if (!block) return html
  const body = block[1].replace(OLD_LOAD, () => BAR_LOAD)
  return ['```html', ...(PAGE.test(body) ? [body] : ['<!DOCTYPE html>', '<html><body>', body, '</body></html>']), '```'].join('\n')
}

function growing(value) {
  if (Array.isArray(value)) return value.includes(LIST_GROWS) ? value : [...value, LIST_GROWS]
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === '$meta' ? item : growing(item)]))
}

function growingText(text) {
  try {
    const state = YAML.parse(text)
    if (!state || typeof state !== 'object') return text
    const next = growing(state)
    return JSON.stringify(next) === JSON.stringify(state) ? text : YAML.stringify(next, { lineWidth: 0 }).trim()
  } catch {
    return text
  }
}

const growingOpening = text => String(text ?? '').replace(INIT_BLOCK, (_, state) => `<initvar>\n${growingText(state)}\n</initvar>`)

/**
 * Whether 创作角色卡 made it: its MVU helper, or the name it signs with when the card has no picture to read that from.
 * @param helpers - the scripts in the card's file, when they were read.
 */
export function madeHere(card, helpers = null) {
  return (Array.isArray(helpers) && helpers.some(script => script?.id === MVU_HELPER_ID)) || String(card.creator ?? '').endsWith('CicaTavern')
}

/**
 * A card as SillyTavern should get it.
 * @param raw - the JSON the card came from (rawOfPicture), or null.
 */
export function forSillyTavern(card, raw = null) {
  const scripts = Array.isArray(card.regexScripts)
    ? { regexScripts: card.regexScripts.map(script => (script.id === OWN_STATUS_SCRIPT ? { ...script, replaceString: currentBar(script.replaceString) } : script)) }
    : {}
  if (!madeHere(card, (raw?.data ?? raw)?.extensions?.tavern_helper?.scripts)) return { ...card, ...scripts }
  return {
    ...card,
    ...scripts,
    firstMes: growingOpening(card.firstMes),
    alternateGreetings: (card.alternateGreetings ?? []).map(growingOpening),
    ...(card.book ? { book: { ...card.book, entries: card.book.entries.map(entry => (isInitvar(entry) ? { ...entry, content: growingText(entry.content) } : entry)) } } : {}),
  }
}
