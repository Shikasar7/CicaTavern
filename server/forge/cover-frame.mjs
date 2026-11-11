// A card's 开场页 as SillyTavern gets it. Here the page draws the cover above the opening (web/cover.js); another app
// knows nothing of it, so on the way out the cover becomes the card's first opening: a mark that a display regex turns
// into a page of its own, made of this app's own drawing code as the skinned bar's copy is (status-frame.mjs). The
// card's openings follow it as the message's other versions, and a door on the page switches to one (Tavern Helper's
// setChatMessages). The card kept here never has the mark: a card brought back in is put right again (withoutCover).
import { paletteColors, scopedSkinCss, skinClass } from '../../web/shared/status.js'
import { COVER_MARK, COVER_SCRIPT, COVER_HIDE_SCRIPT, cleanCover } from '../../web/shared/cover.js'
import { frameKit } from './status-frame.mjs'
import { regexEntry } from './status.mjs'

let parts = null

/** The cover's drawing code as two more scopes beside the bar's, the texts it says, and the styles it stands on. */
function coverParts() {
  if (parts) return parts
  const kit = frameKit()
  const shared = kit.unwrapped(kit.read('shared/cover.js'))
  const page = kit.unwrapped(kit.read('cover.js'))
  const head = (module, name) => module.imports.map(({ from, names }) => {
    if (from.endsWith('/i18n.js') && !from.includes('shared') && names.join() === 't') return 'const t=I.createTag(DICT);'
    if (from.endsWith('shared/status.js') || from === './status.js') {
      const given = names.filter(one => one === 'paletteColors')
      return `${given.length ? 'const paletteColors=()=>COLORS;' : ''}${kit.taken(names.filter(one => one !== 'paletteColors'), 'S')}`
    }
    if (from.endsWith('shared/cover.js')) return kit.taken(names, 'CS')
    if (from === '/status.js') return kit.taken(names, 'B')
    throw new Error(`cover frame: ${name} imports ${from}`)
  }).join('')
  const script = [kit.script, kit.scoped('CS', head(shared, 'shared/cover.js'), shared), kit.scoped('CP', head(page, 'cover.js'), page)].join('\n')
  const css = kit.read('style.css').split('\n')
  const from = css.findIndex(line => line.startsWith('.cover-wrap {'))
  const to = css.findIndex(line => line.startsWith('@media (prefers-reduced-motion: reduce) { .cover '))
  if (from < 0 || to < from) throw new Error('cover frame: web/style.css has no cover rules where they were')
  const said = [...new Set([...kit.read('cover.js').matchAll(/\bt`((?:[^`\\]|\\.)*)`/g)].map(found => {
    let at = 0
    return found[1].replace(/\$\{[^}]*\}/g, () => `{${at++}}`)
  }))]
  parts = { script, said, styles: [kit.drift, css.slice(from, to + 1).join('\n')].join('\n'), kit }
  return parts
}

// The page finds the card's openings as the other versions of the message it is in, and switches to the one picked.
// It is added to the body, never put in place of what is there: Tavern Helper puts the whole page inside its own body,
// and the page's styles with it.
const BOOT = `async function boot(){
let texts=[];
try{const first=getChatMessages(0,{include_swipes:true})[0];texts=(first&&first.swipes)||[]}catch(e){}
const openings=texts.length>1?texts.slice(1):Array.from({length:DATA.count},()=>'');
const page=CP.coverPage(el,{name:DATA.name,by:DATA.by,cover:DATA.cover,palette:COLORS?{}:null,skin:SCOPE?{css:' '}:null,openings,picked:-1,canPick:true,always:true,onPick:async index=>{await setChatMessages([{message_id:0,swipe_id:index+1}])}});
document.body.append(page.node);
}
boot();`

/** The cover as a page in a code block, for the display regex to put where the mark is. */
export function coverHtml(card, { english = false } = {}) {
  const { script, said, styles, kit } = coverParts()
  const cover = cleanCover(card.cover)
  const data = value => JSON.stringify(value).replace(/</g, '\\u003c')
  const colors = card.statusBar?.palette ? paletteColors(card.statusBar.palette) : null
  const by = (card.tags ?? []).slice(0, 3).join(' · ') || card.creator || ''
  const count = [card.firstMes, ...(card.alternateGreetings ?? [])].filter(text => String(text ?? '').trim()).length
  // 定制外观 dresses the cover too: its rules go into the page's styles, scoped as the page scopes them.
  const skin = card.statusBar?.skin ?? null
  const scope = skin ? skinClass(skin.css) : ''
  const code = kit.safe([
    `const SPEC=null,COLORS=${data(colors)},SCOPE=${data(scope)},DICT=${english ? kit.englishTexts(said) : 'null'};`,
    `const DATA=${data({ name: card.name, by, cover, count })};`,
    script,
    BOOT,
  ].join('\n'))
  const style = [kit.vars, styles, '.cover-wrap{margin:8px 0;max-width:none}', skin ? scopedSkinCss(skin.css, scope) : ''].join('\n').replace(/<\/(?=style)/gi, '<\\/')
  if (/\{\{|<\/script|```/i.test(code) || /\{\{|```/.test(style)) throw new Error('cover frame: the page holds what SillyTavern would read as its own')
  return ['```html', '<!DOCTYPE html>', '<html><head><meta charset="utf-8">', `<style>${style}</style>`, '</head><body>', `<script>${code}</script>`, '</body></html>', '```'].join('\n')
}

const NOTE = {
  zh: '（开场页：装了酒馆助手才能显示。没装的话，左右切换这条消息，选一个开场。）',
  en: '(Cover page: it shows with Tavern Helper installed. Without it, swipe this message to pick an opening.)',
}

/** Whether a card is written in English (no Chinese in its name or opening): what its SillyTavern copy says by. */
export const englishText = card => !/[一-鿿]/.test(`${card.name ?? ''}${String(card.firstMes ?? '').slice(0, 400)}`)

/**
 * A card with a cover as SillyTavern gets it: the cover first among its openings, and the two regexes that show it and
 * keep it from the model. A card with no cover, or no opening to go to, is left as it is.
 */
export function withCover(card) {
  const openings = [card.firstMes, ...(card.alternateGreetings ?? [])].filter(text => String(text ?? '').trim())
  const cover = cleanCover(card.cover)
  if (!cover || cover.st === false || !openings.length || String(card.firstMes ?? '').startsWith(COVER_MARK)) return card
  const english = englishText(card)
  const find = '/<CoverPage\\/>[\\s\\S]*/'
  const scripts = (card.regexScripts ?? []).filter(script => script.id !== COVER_SCRIPT && script.id !== COVER_HIDE_SCRIPT)
  return {
    ...card,
    firstMes: `${COVER_MARK}\n${english ? NOTE.en : NOTE.zh}`,
    alternateGreetings: openings,
    regexScripts: [
      ...scripts,
      regexEntry(COVER_HIDE_SCRIPT, english ? 'Hide the cover page from the model' : '对模型隐藏开场页', find, '', { promptOnly: true }),
      regexEntry(COVER_SCRIPT, english ? 'Cover page' : '开场页', find, coverHtml(card, { english }), { markdownOnly: true }),
    ],
  }
}
