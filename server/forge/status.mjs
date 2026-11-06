// A card creator card's status bar. The card carries its layout
// (extensions.cicatavern.status_bar), which this app draws itself (web/status.js),
// and a SillyTavern copy: a display regex that turns MVU's <StatusPlaceHolderImpl/>
// into the same bar in an HTML block, plus the MVU script that keeps the
// variables there. This app leaves that regex out (web/render.js withoutOwnStatus)
// and runs no helper scripts.
import { cleanStatusSpec, paletteColors, rangeOf } from '../../web/shared/status.js'

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
.trow{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-top:1px dashed var(--line)}.trow:first-child{border-top:0}.trow>b{font-weight:500}.trow>span{color:var(--muted);font-size:12px}
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
    else if(f.show==='tags'||f.show==='list'||f.show==='stats'||f.show==='badge'){const t=h('span','tags wide');const list=tags(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('span','tag',x));row.append(t)}
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

/** The status bar as one HTML block for a SillyTavern regex replacement. */
export function statusBarHtml(spec) {
  const data = JSON.stringify(spec).replace(/</g, '\\u003c')
  const { theme, style } = barLook(spec)
  // A whole page: Tavern Helper leaves a code block as code unless it has html>, <head> or <body in it.
  return ['```html', '<!DOCTYPE html>', '<html><head><meta charset="utf-8">', `<style>${BAR_STYLE}</style>`, '</head><body>', `<div class="bar${theme}" id="bar"${style}></div>`, `<script>const SPEC=${data};${BAR_SCRIPT}</script>`, '</body></html>', '```'].join('\n')
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
    regexEntry(OWN_STATUS_SCRIPT, words.statusBar, '<StatusPlaceHolderImpl/>', statusBarHtml(spec), { markdownOnly: true }),
  ]
}

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
