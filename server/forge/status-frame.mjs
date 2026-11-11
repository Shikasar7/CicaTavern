// The SillyTavern copy of a bar that wears 定制外观. A look's rules are written for the bar this app draws
// (web/status.js: its elements, class names and data marks), so the copy cannot be the small renderer the plain
// bars get (status.mjs BAR_SCRIPT): the page's own drawing code goes into the frame as it is, with the styles
// it stands on, and the look's rules find there what they find here.
//
// What goes in: web/shared/vars.js, web/shared/i18n.js, the first part of web/shared/status.js (what works out the
// rows) and web/status.js, each in a scope of its own with its imports handed to it. Read from the files the page
// is served from, once.
import { readFileSync } from 'node:fs'
import english from '../../web/i18n/en.js'
import { paletteColors, scopedSkinCss, skinClass } from '../../web/shared/status.js'

const WEB = new URL('../../web/', import.meta.url)
const read = name => readFileSync(new URL(name, WEB), 'utf8').replace(/\r\n/g, '\n')

// Where shared/status.js stops being about drawing (the bricks, the palette and the look's own parser follow).
const STATUS_END = '// ─── 玩法积木'
// What the drawing code takes from the rest of shared/status.js: worked out here, and handed over as values.
const GIVEN = ['paletteColors', 'scopedSkinCss', 'skinClass']

/** A module's code with no imports or exports, what it imported and what it exported. Whole-line comments go. */
function unwrapped(source) {
  const imports = []
  const exports = []
  const code = source
    .replace(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)'\s*;?\s*$/gm, (_, names, from) => {
      imports.push({ from, names: names.split(',').map(name => name.trim()).filter(Boolean) })
      return ''
    })
    .replace(/^export\s+(async\s+function|function|const|let|class)\s+(\w+)/gm, (_, kind, name) => {
      exports.push(name)
      return `${kind} ${name}`
    })
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('//'))
    .join('\n')
  if (/^(import|export)\b/m.test(code)) throw new Error('status frame: an import or export this cannot carry')
  return { code, imports, exports }
}

/** A scope of its own for a module: what it needs comes in as `head`, what it exports goes out as an object. */
const scoped = (name, head, { code, exports }) => `const ${name}=(()=>{${head}\n${code}\nreturn{${exports.join(',')}}})();`

const taken = (names, from) => `const{${names.join(',')}}=${from};`

// The page's own way of making an element (web/app.js el).
const FRAME_EL = `function el(tag,attrs={},children=[]){
const node=document.createElement(tag);
for(const[key,value]of Object.entries(attrs)){
if(value===undefined||value===null||value===false)continue;
if(key==='class')node.className=value;
else if(key==='html')node.innerHTML=value;
else if(key==='text')node.textContent=value;
else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);
else node.setAttribute(key,value===true?'':value);
}
for(const child of[].concat(children))if(child)node.append(child);
return node;
}`

let parts = null

/** The drawing code as one script, and the styles the bar stands on. Built once. */
function frameParts() {
  if (parts) return parts
  const vars = unwrapped(read('shared/vars.js'))
  const i18n = unwrapped(read('shared/i18n.js'))
  const whole = read('shared/status.js')
  const end = whole.indexOf(STATUS_END)
  if (end < 0) throw new Error('status frame: web/shared/status.js has no mark where the drawing part ends')
  const status = unwrapped(whole.slice(0, end))
  const page = unwrapped(read('status.js'))
  if (vars.imports.length || i18n.imports.length) throw new Error('status frame: vars.js and i18n.js are taken to import nothing')
  // shared/status.js reads vars.js; web/status.js reads the tag (made here) and shared/status.js.
  const statusHead = status.imports.map(({ from, names }) => {
    if (!from.endsWith('vars.js') || names.some(name => !vars.exports.includes(name))) throw new Error(`status frame: shared/status.js imports ${from}`)
    return taken(names, 'V')
  }).join('')
  const pageHead = page.imports.map(({ from, names }) => {
    if (from.endsWith('/i18n.js') && !from.includes('shared') && names.join() === 't') return 'const t=I.createTag(DICT);'
    if (!from.endsWith('shared/status.js')) throw new Error(`status frame: web/status.js imports ${from}`)
    const lost = names.filter(name => !status.exports.includes(name) && !GIVEN.includes(name))
    if (lost.length) throw new Error(`status frame: web/status.js needs ${lost.join(', ')}`)
    return taken(names.filter(name => !GIVEN.includes(name)), 'S')
  }).join('')
  // The colors and the look's class are worked out on this side; its rules are in the page's styles already.
  const given = 'const paletteColors=()=>COLORS,skinClass=()=>SCOPE,scopedSkinCss=()=>"";'
  const script = [scoped('V', '', vars), scoped('I', '', i18n), scoped('S', statusHead, status), scoped('B', pageHead + given, page), FRAME_EL].join('\n')
  // The texts the bar says, for a card in English: the page's own table, cut to what web/status.js uses.
  const said = [...new Set([...read('status.js').matchAll(/\bt`((?:[^`\\]|\\.)*)`/g)].map(found => {
    let at = 0
    return found[1].replace(/\$\{[^}]*\}/g, () => `{${at++}}`)
  }))]
  const css = read('style.css').split('\n')
  const from = css.findIndex(line => line.startsWith('.status-bar {'))
  const to = css.findIndex(line => line.startsWith('.status-flag.on'))
  if (from < 0 || to < from) throw new Error('status frame: web/style.css has no status bar rules where they were')
  // The bar's rules, and those of what drifts over it (动效) with the moves they name.
  const kept = line => line.startsWith('.status-') || line.startsWith('.drift') || /^@keyframes (?:status|drift)-/.test(line) || /^@media \(prefers-reduced-motion: reduce\) \{ \.(?:status-|drift)/.test(line)
  const styles = css.slice(from, to + 1).filter(kept).join('\n')
  // What drifts, by itself: the 开场页's page has it too (cover-frame.mjs).
  const drift = css.slice(from, to + 1).filter(line => line.startsWith('.drift') || /^@keyframes drift-/.test(line) || line.startsWith('@media (prefers-reduced-motion: reduce) { .drift')).join('\n')
  parts = { script, said, styles, drift }
  return parts
}

// What the bar's styles read from the page: this app's own colors and fonts, light and dark by the system.
const FRAME_VARS = `:root{--surface:#f7f8f5;--raised:#f7f8f5;--line:#dfe4df;--line-soft:#dfe4df;--ink:#1c2427;--muted:#5d6a6d;--faint:#8b9698;--accent:#2b5869;--accent-soft:rgba(43,88,105,.11);--meter-track:#dde3de;--ok:#2f7a55;--bad:#b0413a;--shadow-1:none;--ease:cubic-bezier(.2,.8,.2,1);--serif:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong","SimSun",serif;--ui:"HarmonyOS Sans SC","MiSans","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{--surface:#182025;--raised:#182025;--line:#273238;--line-soft:#273238;--ink:#dde3e0;--muted:#919da0;--faint:#67747a;--accent:#8dbfcb;--accent-soft:rgba(141,191,203,.12);--meter-track:#263137;--ok:#6fbf93;--bad:#e57b70}}
body{margin:0;background:transparent}`

/** The page's English for what the bar says, as an object written out (a text, or a function of its parts). */
function englishTexts(said) {
  const entries = said.filter(key => Object.hasOwn(english, key)).map(key => `${JSON.stringify(key)}:${typeof english[key] === 'function' ? String(english[key]) : JSON.stringify(english[key])}`)
  return `{${entries.join(',')}}`
}

// SillyTavern fills $1 and $<name> into a regex's replacement and reads {{…}} as a macro: neither may be in the page.
// $ is a dollar in a string, a template or a name alike.
const safe = text => text.replace(/\$(?=[\d<])/g, '\\u0024')

/** What another page made of the bar's drawing code is built with (the 开场页's, cover-frame.mjs). */
export function frameKit() {
  const { script, drift } = frameParts()
  return { script, drift, vars: FRAME_VARS, read, unwrapped, scoped, taken, englishTexts, safe }
}

/**
 * The page a bar drawn by this app's own code is in SillyTavern (one that wears a look, has 动效 or a 小手机):
 * { style, script } for status.mjs to put in its frame.
 * @param load - the code that finds the message's variables and calls draw(stat) (status.mjs BAR_LOAD).
 */
export function skinnedFrame(spec, { english: inEnglish = false, load }) {
  const { script, said, styles } = frameParts()
  const scope = spec.skin ? skinClass(spec.skin.css) : ''
  // The rules stay out of the layout the script reads: they are in the styles, scoped as the page scopes them.
  const { skin, ...layout } = spec
  const shown = skin ? { ...layout, skin: { ...(skin.name ? { name: skin.name } : {}), css: '' } } : layout
  const data = value => JSON.stringify(value).replace(/</g, '\\u003c')
  const dict = inEnglish ? englishTexts(said) : 'null'
  const code = safe([
    `const SPEC=${data(shown)},COLORS=${data(spec.palette ? paletteColors(spec.palette) : null)},SCOPE=${data(scope)},DICT=${dict};`,
    script,
    // A bar with nothing to show yet leaves the frame empty, as the page leaves the reply without one. It is drawn
    // into a place of its own: Tavern Helper puts the whole page inside its own body, styles and all, so emptying the
    // body would take the page's own styles out with it (seen in SillyTavern: the bar came out bare).
    'const ROOT=document.createElement("div");document.body.append(ROOT);',
    'function draw(stat){const bar=B.statusBar(el,SPEC,stat,{collapsible:false,remembers:false});ROOT.replaceChildren(...(bar?[bar]:[]))}',
    load,
    'load();',
  ].join('\n'))
  // The look's rules are cleaned of anything that is not a rule; a tag's end in a string would still close the sheet.
  const style = [FRAME_VARS, styles, '.status-bar{margin:8px 0}', skin ? scopedSkinCss(skin.css, scope) : ''].join('\n').replace(/<\/(?=style)/gi, '<\\/')
  // What would end the script or the code block the page sits in, or what SillyTavern reads as a macro.
  if (/\{\{|<\/script|```/i.test(code) || /\{\{|```/.test(style)) throw new Error('status frame: the page holds what SillyTavern would read as its own')
  return { style, script: code }
}
