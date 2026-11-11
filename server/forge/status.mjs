// A card creator card's status bar. The card carries its layout
// (extensions.cicatavern.status_bar), which this app draws itself (web/status.js),
// and a SillyTavern copy: a display regex that turns MVU's <StatusPlaceHolderImpl/>
// into the same bar in an HTML block, plus the MVU script that keeps the
// variables there. This app leaves that regex out (web/render.js withoutOwnStatus)
// and runs no helper scripts.
import YAML from 'yaml'
import { SHOWS, STATUS_THEMES, cleanStatusSpec, paletteColors, phoneApps, rangeOf, skinClass } from '../../web/shared/status.js'
import { msg } from '../i18n.mjs'
import { skinnedFrame } from './status-frame.mjs'

export const OWN_STATUS_SCRIPT = 'cicatavern-status-bar'

/** How a variable shows when the plan did not say: gauges for numbers with a range. */
export function defaultShow(variable) {
  if (variable.type === 'number') return rangeOf(variable.range).max !== undefined ? 'meter' : 'number'
  if (variable.type === 'list') return 'tags'
  if (variable.type === 'book') return 'table'
  if (variable.type === 'boolean') return 'flag'
  return 'text'
}

/** The plan's status bar layout, or null when it tracks nothing (or shows nothing). */
export function statusSpecOf(plan) {
  // A plain MVU card (创作角色卡's 格式) keeps its variables but no bar of its own.
  if (!plan?.tracking?.enabled || plan.status?.ui === false) return null
  return cleanStatusSpec({
    title: plan.tracking.title,
    theme: plan.status?.theme,
    palette: plan.status?.palette,
    skin: plan.status?.skin,
    // 立绘, 场景图 and 动效 (方案页 → 状态栏 → 门面): the pictures are the app's, found where the bar is drawn.
    portrait: plan.status?.portrait === true,
    scene: plan.status?.scene === true,
    effect: plan.status?.effect,
    phone: plan.status?.phone === true,
    fields: plan.tracking.variables.map(v => ({ path: v.path, label: v.label, show: v.show || defaultShow(v), ...rangeOf(v.range), ...(plan.status?.pages && v.page ? { page: v.page } : {}) })),
  })
}

// The SillyTavern bar: the layout as data plus a small renderer, reading the
// message's variables through MVU (Tavern Helper). Light and dark follow the system.
export const BAR_STYLE = `
:root{--bg:#f7f8f5;--line:#dfe4df;--ink:#1c2427;--muted:#5d6a6d;--faint:#8b9698;--accent:#2b5869;--soft:rgba(43,88,105,.11);--track:#dde3de;--ok:#2f7a55;--bad:#b0413a}
@media (prefers-color-scheme:dark){:root{--bg:#182025;--line:#273238;--ink:#dde3e0;--muted:#919da0;--faint:#67747a;--accent:#8dbfcb;--soft:rgba(141,191,203,.12);--track:#263137;--ok:#6fbf93;--bad:#e57b70}}
body{margin:0;background:transparent}
.bar{margin:8px 0;padding:12px 16px 14px;background:var(--bg);border:1px solid var(--line);border-radius:14px;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:var(--ink)}
.title{font-weight:600;letter-spacing:.1em;color:var(--accent);margin-bottom:8px}
.group+.group{margin-top:9px;padding-top:9px;border-top:1px dashed var(--line)}
.gname{font-size:11.5px;color:var(--faint);letter-spacing:.12em;margin-bottom:3px}
.row{display:grid;grid-template-columns:minmax(3.6em,max-content) minmax(0,1fr) auto;align-items:center;gap:12px;min-height:26px}
.row>.wide{grid-column:2/-1}
.label{color:var(--muted);white-space:nowrap}
.meter{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.meter>i{display:block;height:100%;border-radius:3px;background:var(--accent)}
.value{text-align:right;min-width:3.4em;font-variant-numeric:tabular-nums}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:12px;padding:0 9px;border-radius:999px;background:var(--soft);line-height:22px}
.stars{color:var(--accent);letter-spacing:1px}
.line{padding:2px 0;border-top:1px dashed var(--line)}.line:first-child{border-top:0}.trow{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-top:1px dashed var(--line)}.trow:first-child{border-top:0}.trow>b{font-weight:500}.trow>span{color:var(--muted);font-size:12px}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}.tab{padding:2px 12px;border:1px solid var(--line);border-radius:999px;background:none;color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer}.tab.on{background:var(--soft);border-color:var(--accent);color:var(--ink)}
.faint{color:var(--faint)}.on{color:var(--ok)}
.theme-paper{--bg:#f6efe0;--line:#dccdae;--ink:#3b2f22;--muted:#7a6a55;--faint:#a8977c;--accent:#8a3b2a;--soft:rgba(138,59,42,.1);--track:#e6dac2;font-family:"Noto Serif SC","Songti SC",STSong,serif}
@media (prefers-color-scheme:dark){.theme-paper{--bg:#28221a;--line:#3d342a;--ink:#e8dcc6;--muted:#b3a487;--faint:#857760;--accent:#d9876f;--soft:rgba(217,135,111,.13);--track:#3a3127}}
.theme-neon{--bg:#0f1220;--line:#2b2f55;--ink:#e6e8ff;--muted:#9aa0d8;--faint:#6a70a8;--accent:#3ef0ff;--soft:rgba(62,240,255,.12);--track:#23264a;box-shadow:0 0 14px rgba(62,240,255,.22)}
.theme-neon .title{text-shadow:0 0 6px rgba(62,240,255,.6)}
.theme-neon .meter>i{box-shadow:0 0 6px var(--accent)}
.theme-ink{--bg:#f3f1ea;--line:#d4d0c4;--ink:#24241f;--muted:#6f6d62;--faint:#98958a;--accent:#2f2f2a;--soft:rgba(47,47,42,.09);--track:#dedbd0;font-family:"Noto Serif SC","Songti SC",STSong,serif}
.theme-parchment{--bg:#efe2c4;--line:#c9b285;--ink:#3a2a16;--muted:#75603f;--faint:#a08a63;--accent:#7a4b1e;--soft:rgba(122,75,30,.12);--track:#ddcba3;font-family:"Noto Serif SC","Songti SC",STSong,serif}
.theme-gothic{--bg:#16121a;--line:#33283a;--ink:#e9e0ea;--muted:#a795ad;--faint:#75637c;--accent:#c0395a;--soft:rgba(192,57,90,.15);--track:#2b2230}
.theme-terminal{--bg:#0b140e;--line:#1f3a28;--ink:#b8f5c8;--muted:#6fae82;--faint:#4a7a58;--accent:#3ddc84;--soft:rgba(61,220,132,.12);--track:#16291c;font-family:ui-monospace,Consolas,"Courier New",monospace}
.theme-ocean{--bg:#0e1f2b;--line:#1f3b4d;--ink:#dcecf2;--muted:#8fb2c1;--faint:#5f8294;--accent:#4fc3d9;--soft:rgba(79,195,217,.13);--track:#18303f}
.theme-pastel{--bg:#fff6f8;--line:#f3d6de;--ink:#4a3a40;--muted:#9a7d86;--faint:#c4a7b0;--accent:#e57a9b;--soft:rgba(229,122,155,.13);--track:#f6e3e8;border-radius:18px}
@media (prefers-color-scheme:dark){.theme-pastel{--bg:#2b2226;--line:#3f3036;--ink:#f1dfe5;--muted:#c09aa7;--faint:#8c6f79;--accent:#f09ab5;--soft:rgba(240,154,181,.13);--track:#3b2d33}}`

// An extension that renders the block in a frame of its own (小白X) leaves out what Tavern Helper puts there: `mvu` and `floor`
// fall back on the page around it, or the bar shows only its title.
export const BAR_LOAD = `const mvu=()=>{try{return typeof Mvu!=='undefined'?Mvu:parent.Mvu}catch(e){return null}};
function floor(){
  if(typeof getCurrentMessageId==='function')return getCurrentMessageId();
  const mes=frameElement&&frameElement.closest('.mes');
  return mes?Number(mes.getAttribute('mesid')):'latest';
}
async function load(){
  try{if(typeof waitGlobalInitialized==='function')await waitGlobalInitialized('Mvu')}catch(e){}
  for(let i=0;i<40&&!mvu();i++)await new Promise(done=>setTimeout(done,250));
  try{const data=mvu().getMvuData({type:'message',message_id:floor()});draw((data&&data.stat_data)||{})}catch(e){draw({})}
}`

const BAR_SCRIPT = `
const unwrap=v=>Array.isArray(v)&&v.length===2&&typeof v[1]==='string'&&(typeof v[0]==='number'||typeof v[0]==='boolean')?v[0]:v;
const get=(o,p)=>p.split('.').reduce((a,k)=>a==null?undefined:a[k],o);
const text=v=>{v=unwrap(v);if(v==null)return'';if(typeof v!=='object')return String(v);if(Array.isArray(v))return v.map(text).join('、');return Object.entries(v).map(([k,x])=>k+'：'+text(x)).join('；')};
const tags=v=>{v=unwrap(v);if(v==null||v==='')return[];if(Array.isArray(v))return v.map(text);if(typeof v==='object')return Object.entries(v).map(([k,x])=>typeof unwrap(x)==='number'?k+' ×'+unwrap(x):k);return String(v).split(/[、，,;；]/).map(s=>s.trim()).filter(Boolean)};
const lines=v=>{v=unwrap(v);if(v==null||v==='')return[];if(Array.isArray(v))return v.map(text).filter(Boolean);if(typeof v==='object')return Object.entries(v).map(([k,x])=>k+'：'+text(x));return String(v).split(/\\n+/).map(s=>s.trim()).filter(Boolean)};
const h=(tag,cls,content)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(content!=null)e.textContent=content;return e};
function draw(stat,page){
  const bar=document.getElementById('bar');bar.replaceChildren();
  const pages=[...new Set(SPEC.fields.filter(f=>f.show!=='hidden'&&f.page).map(f=>f.page))];
  page=pages.length<2?null:page||pages[0];
  const groups=[];
  for(const f of SPEC.fields){
    if(f.show==='hidden')continue;
    if(page&&(f.page||pages[0])!==page)continue;
    const value=unwrap(get(stat,f.path));if(value===undefined)continue;
    const keys=f.path.split('.');const name=keys.length>1?keys[keys.length-2]:'';
    let g=groups.find(x=>x.name===name);if(!g)groups.push(g={name,rows:[]});
    const row=h('div','row');row.append(h('span','label',f.label||keys[keys.length-1]));
    const ratio=/^\\s*(-?[\\d.]+)\\s*\\/\\s*([\\d.]+)\\s*$/.exec(String(value));
    const n=Number(ratio?ratio[1]:value),low=ratio?0:f.min,high=ratio?Number(ratio[2]):f.max;
    if(f.show==='meter'&&Number.isFinite(n)&&high>low){const m=h('span','meter'),i=h('i');i.style.width=Math.max(0,Math.min(100,(n-low)/(high-low)*100))+'%';m.append(i);row.append(m,h('span','value',ratio?String(value).trim():String(n)))}
    else if(f.show==='rating'&&Number.isFinite(n)){const top=f.max||5,on=Math.max(0,Math.min(top,Math.round(n)));row.append(h('span','wide stars','★'.repeat(on)+'☆'.repeat(top-on)))}
    else if(f.show==='list'){const t=h('div','wide');const list=lines(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('div','line',x));row.append(t)}
    else if(f.show==='tags'||f.show==='stats'||f.show==='badge'){const t=h('span','tags wide');const list=tags(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('span','tag',x));row.append(t)}
    else if(f.show==='table'){const t=h('div','wide');const rows=value&&typeof value==='object'?Object.entries(value).filter(([k])=>!k.startsWith('$')):[];if(!rows.length)t.append(h('span','faint','—'));for(const[k,x]of rows){const r=h('div','trow');r.append(h('b','',Array.isArray(value)?text(x):k));if(!Array.isArray(value))r.append(h('span','',text(x)));t.append(r)}row.append(t)}
    else if(f.show==='flag'){const on=Boolean(value)&&value!=='false'&&value!=='否';row.append(h('span','wide '+(on?'on':'faint'),on?'✓':'—'))}
    else row.append(h('span','wide',text(value)||'—'));
    g.rows.push(row);
  }
  const title=SPEC.title||(groups.length===1&&groups[0].name)||'';
  if(title)bar.append(h('div','title',title));
  if(page){const tabs=h('div','tabs');for(const p of pages){const b=h('button','tab'+(p===page?' on':''),p);b.type='button';b.onclick=()=>draw(stat,p);tabs.append(b)}bar.append(tabs)}
  for(const g of groups){const box=h('div','group');if(g.name&&g.name!==title)box.append(h('div','gname',g.name));box.append(...g.rows);bar.append(box)}
}
${BAR_LOAD}
load();`

/** The class and the colors of a bar, for anything drawn to go with it. */
export function barLook(spec) {
  const theme = spec.theme && spec.theme !== 'plain' ? ` theme-${spec.theme}` : ''
  const colors = spec.palette ? paletteColors(spec.palette) : null
  // A card's own colors, set on the bar so they stand in both light and dark.
  const style = colors ? ` style="--bg:${colors.surface};--ink:${colors.ink};--accent:${colors.accent};--muted:${colors.muted};--faint:${colors.faint};--line:${colors.line};--track:${colors.track};--soft:${colors.soft}"` : ''
  return { theme, style }
}

/**
 * The status bar as one HTML block for a SillyTavern regex replacement.
 * @param english - the card's language, for the few words a bar says itself.
 */
// A bar drawn by this app's own code in SillyTavern (it wears a look, has 动效, or a 小手机 with something in it) is a
// whole page of tens of thousands of characters, made anew for every reply that has one. Only the latest replies get
// it there (a regex's 最大深度): a long chat would otherwise open with a hundred of them.
export const wholeFrame = spec => Boolean(spec?.skin || spec?.effect || (spec?.phone && phoneApps(spec).apps.length))
export const STATUS_DEPTH = 2

export function statusBarHtml(spec, { english = false } = {}) {
  // A whole page: Tavern Helper leaves a code block as code unless it has html>, <head> or <body in it.
  const page = (style, body) => ['```html', '<!DOCTYPE html>', '<html><head><meta charset="utf-8">', `<style>${style}</style>`, '</head><body>', body, '</body></html>', '```'].join('\n')
  // 定制外观 is written for the bar this app draws: that bar's own drawing code goes into the frame (status-frame.mjs),
  // a good deal longer than the plain one below.
  if (wholeFrame(spec)) {
    const frame = skinnedFrame(spec, { english, load: BAR_LOAD })
    return page(frame.style, `<script>${frame.script}</script>`)
  }
  const data = JSON.stringify(spec).replace(/</g, '\\u003c')
  const { theme, style } = barLook(spec)
  return page(BAR_STYLE, `<div class="bar${theme}" id="bar"${style}></div>\n<script>const SPEC=${data};${BAR_SCRIPT}</script>`)
}

/** A regex script as a card keeps it. */
export const regexEntry = (id, scriptName, findRegex, replaceString, options) => ({
  id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false,
  markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...options,
})

/** The SillyTavern side: the bar's display regex and the one that keeps its placeholder from the model. */
export function statusScripts(spec, words) {
  return [
    regexEntry(`${OWN_STATUS_SCRIPT}-hide`, words.hidePlaceholder, '<StatusPlaceHolderImpl/>', '', { promptOnly: true }),
    regexEntry(OWN_STATUS_SCRIPT, words.statusBar, '<StatusPlaceHolderImpl/>', statusBarHtml(spec, { english: words.english === true }), { markdownOnly: true, ...(wholeFrame(spec) ? { maxDepth: STATUS_DEPTH } : {}) }),
  ]
}

/** A card's scripts with the bar's SillyTavern copy made again from `spec`: for a layout changed after they were written. */
export const withStatusCopy = (scripts, spec, english) => (Array.isArray(scripts) ? scripts : []).map(script => (script.id === OWN_STATUS_SCRIPT
  // How far back it is drawn follows what it is: a whole page for the latest replies only; a depth set by hand stays.
  ? { ...script, replaceString: statusBarHtml(spec, { english }), maxDepth: wholeFrame(spec) ? script.maxDepth ?? STATUS_DEPTH : script.maxDepth === STATUS_DEPTH ? null : script.maxDepth ?? null }
  : script))

// MagVarUpdate, the script SillyTavern cards use to apply <UpdateVariable> blocks and
// show the placeholder. Only Tavern Helper runs it; this app has the same built in.
export const MVU_HELPER_ID = '6d1f4c2a-8e3b-4f5a-9c7d-c1ca7a7e5b01'
const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'"

export function mvuHelper(words) {
  return {
    scripts: [{
      type: 'script',
      enabled: true,
      id: MVU_HELPER_ID,
      name: 'MVU',
      content: MVU_IMPORT,
      info: words.mvuInfo,
      button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }, { name: '重新读取初始变量', visible: true }] },
      data: {},
    }],
    variables: {},
  }
}

// ─── A layout a model writes (检查这张卡, 对话修改) ─────────────────────────

/** How a model writes a layout: the <status_bar> block and what goes in it, for the format part of a system prompt. */
export const STATUS_FORMAT = () => `<status_bar>{"title": "标题，可空", "theme": "paper", "fields": [{"path": "变量路径", "label": "短名", "show": "meter", "min": 0, "max": 100, "page": "页名，两三个字，可不写"}]}</status_bar>
  show 可选：${SHOWS.join('、')}。meter 要写 min 和 max，rating 要写 max。theme 可选：${STATUS_THEMES.join('、')}。写全所有要显示的变量。
  按这张卡配色时不写 theme，写 "palette": {"bg": "#101820", "ink": "#f2f2f2", "accent": "#e0a030"}，三个都是六位颜色，分别是背景、文字、强调。theme、palette 和 page 不改就不写，原样留着。`

const themeNames = () => ({ paper: msg`纸张`, neon: msg`霓虹`, pastel: msg`柔和`, ink: msg`水墨`, parchment: msg`羊皮卷`, gothic: msg`暗夜`, terminal: msg`终端`, ocean: msg`深海` })

/** A layout in lines, as a change's before and after read: all of it, a change gone out of date is told by these. */
export function statusLines(spec) {
  if (!spec) return ''
  const { palette, skin } = spec
  const head = [
    spec.title ? `${msg`标题`}: ${spec.title}` : '',
    spec.theme ? `${msg`主题`}: ${themeNames()[spec.theme] ?? spec.theme}` : '',
    // Its rules are not for reading in a line: which look it is tells one from another.
    skin ? `${msg`定制外观`}: ${skin.name || msg`未命名`} (${skinClass(skin.css).slice(5)})` : '',
    palette ? `${msg`配色`}: ${msg`背景`} ${palette.bg} · ${msg`文字`} ${palette.ink} · ${msg`强调`} ${palette.accent}` : '',
    spec.portrait || spec.scene ? `${msg`图片`}: ${[spec.portrait ? msg`立绘` : '', spec.scene ? msg`场景图` : ''].filter(Boolean).join(' · ')}` : '',
    spec.effect ? `${msg`动效`}: ${spec.effect}` : '',
    spec.phone ? msg`小手机` : '',
  ].filter(Boolean)
  return [...head, ...spec.fields.map(field => `${field.label || field.path} (${field.path}): ${field.show}${field.page ? ` · ${msg`页`}: ${field.page}` : ''}`)].join('\n')
}

export const statusChange = (before, after, more = {}) => ({ id: 'statusBar', kind: 'statusBar', spec: after, before: statusLines(before), after: statusLines(after), ...more })

/** Whether a card shows a status bar of its own making: a regex or a script draws it, not a layout. */
export function drawsOwnBar(card) {
  const scripts = Array.isArray(card.regexScripts) ? card.regexScripts : []
  return scripts.some(script => !script.disabled && /StatusPlaceHolderImpl|状态栏|status/i.test(`${script.findRegex}${script.scriptName}`))
}

/** The card's layout as a model reads it, or why there is none to write. */
export function statusPart(card) {
  if (card.statusBar) {
    // A look of the card's own is long and not the model's to rewrite here: said in a line.
    const { skin, ...layout } = card.statusBar
    const kept = skin ? `\n（这张卡的状态栏有一套定制外观${skin.name ? `「${skin.name}」` : ''}，改布局时程序会原样留着，不用写；写了 theme 就会换掉它。）` : ''
    return `<status_bar>${JSON.stringify(layout)}</status_bar>${kept}`
  }
  return drawsOwnBar(card) ? '（这张卡用自己的正则或脚本画状态栏，不要写 <status_bar>）' : '（这张卡还没有状态栏布局）'
}

/** A layout as written, over what it says nothing of: the look and the pages stay as the card has them. */
function withOwnLook(spec, written, before) {
  if (!before) return spec
  const look = written.theme === undefined && !spec.palette ? { ...(before.theme ? { theme: before.theme } : {}), ...(before.palette ? { palette: before.palette } : {}) } : {}
  // 定制外观 stays till a theme is written in its place.
  const skin = written.theme === undefined && before.skin ? { skin: before.skin } : {}
  const paged = written.fields.some(field => field?.page !== undefined)
  const pageOf = field => before.fields.find(item => item.path === field.path)?.page
  return { ...spec, ...look, ...skin, fields: paged ? spec.fields : spec.fields.map(field => (pageOf(field) ? { ...field, page: pageOf(field) } : field)) }
}

/** A model's <status_bar> in an answer as a change to the card's layout: [] when there is none, or it cannot be read. */
export function readStatus(body, card) {
  if (drawsOwnBar(card) && !card.statusBar) return []
  const text = /<status_bar\b[^>]*>([\s\S]*?)(?:<\/status_bar>|$)/i.exec(body)?.[1]?.trim().replace(/^```\w*\n?|\n?```$/g, '')
  if (!text) return []
  let written
  try {
    written = YAML.parse(text)
  } catch {
    return []
  }
  const spec = cleanStatusSpec(written)
  return spec ? [statusChange(card.statusBar ?? null, withOwnLook(spec, written, card.statusBar), card.statusBar ? {} : { scripts: true })] : []
}

/** Variables a line each, `path: value`, for a model to pick a layout's paths from. */
export function variableLines(value, keys = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return keys.length ? [`${keys.join('.')}: ${JSON.stringify(value)}`] : []
  return Object.entries(value).filter(([key]) => !key.startsWith('$')).flatMap(([key, item]) => variableLines(item, [...keys, key]))
}
