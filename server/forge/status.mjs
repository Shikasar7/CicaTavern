// A card creator card's status bar. The card carries its layout
// (extensions.cicatavern.status_bar), which this app draws itself (web/status.js),
// and a SillyTavern copy: a display regex that turns MVU's <StatusPlaceHolderImpl/>
// into the same bar in an HTML block, plus the MVU script that keeps the
// variables there. This app leaves that regex out (web/render.js withoutOwnStatus)
// and runs no helper scripts.
import { cleanStatusSpec, rangeOf } from '../../web/shared/status.js'

export const OWN_STATUS_SCRIPT = 'cicatavern-status-bar'

/** How a variable shows when the plan did not say: gauges for numbers with a range. */
export function defaultShow(variable) {
  if (variable.type === 'number') return rangeOf(variable.range).max !== undefined ? 'meter' : 'number'
  if (variable.type === 'list') return 'tags'
  if (variable.type === 'boolean') return 'flag'
  return 'text'
}

/** The plan's status bar layout, or null when it tracks nothing (or shows nothing). */
export function statusSpecOf(plan) {
  if (!plan?.tracking?.enabled) return null
  return cleanStatusSpec({
    title: plan.tracking.title,
    fields: plan.tracking.variables.map(v => ({ path: v.path, label: v.label, show: v.show || defaultShow(v), ...rangeOf(v.range) })),
  })
}

// The SillyTavern bar: the layout as data plus a small renderer, reading the
// message's variables through MVU (Tavern Helper). Light and dark follow the system.
const BAR_STYLE = `
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
.faint{color:var(--faint)}.on{color:var(--ok)}`

const BAR_SCRIPT = `
const unwrap=v=>Array.isArray(v)&&v.length===2&&typeof v[1]==='string'&&(typeof v[0]==='number'||typeof v[0]==='boolean')?v[0]:v;
const get=(o,p)=>p.split('.').reduce((a,k)=>a==null?undefined:a[k],o);
const text=v=>{v=unwrap(v);if(v==null)return'';if(typeof v!=='object')return String(v);if(Array.isArray(v))return v.map(text).join('、');return Object.entries(v).map(([k,x])=>k+'：'+text(x)).join('；')};
const tags=v=>{v=unwrap(v);if(v==null||v==='')return[];if(Array.isArray(v))return v.map(text);if(typeof v==='object')return Object.entries(v).map(([k,x])=>typeof unwrap(x)==='number'?k+' ×'+unwrap(x):k);return String(v).split(/[、，,;；]/).map(s=>s.trim()).filter(Boolean)};
const h=(tag,cls,content)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(content!=null)e.textContent=content;return e};
function draw(stat){
  const bar=document.getElementById('bar');bar.replaceChildren();
  const groups=[];
  for(const f of SPEC.fields){
    if(f.show==='hidden')continue;
    const value=unwrap(get(stat,f.path));if(value===undefined)continue;
    const keys=f.path.split('.');const name=keys.length>1?keys[keys.length-2]:'';
    let g=groups.find(x=>x.name===name);if(!g)groups.push(g={name,rows:[]});
    const row=h('div','row');row.append(h('span','label',f.label||keys[keys.length-1]));
    const n=Number(value);
    if(f.show==='meter'&&Number.isFinite(n)){const m=h('span','meter'),i=h('i');i.style.width=Math.max(0,Math.min(100,(n-f.min)/(f.max-f.min)*100))+'%';m.append(i);row.append(m,h('span','value',String(n)))}
    else if(f.show==='tags'){const t=h('span','tags wide');const list=tags(value);if(!list.length)t.append(h('span','faint','—'));for(const x of list)t.append(h('span','tag',x));row.append(t)}
    else if(f.show==='flag'){const on=Boolean(value)&&value!=='false'&&value!=='否';row.append(h('span','wide '+(on?'on':'faint'),on?'✓':'—'))}
    else row.append(h('span','wide',text(value)||'—'));
    g.rows.push(row);
  }
  const title=SPEC.title||(groups.length===1&&groups[0].name)||'';
  if(title)bar.append(h('div','title',title));
  for(const g of groups){const box=h('div','group');if(g.name&&g.name!==title)box.append(h('div','gname',g.name));box.append(...g.rows);bar.append(box)}
}
async function load(){
  try{if(typeof waitGlobalInitialized==='function')await waitGlobalInitialized('Mvu')}catch(e){}
  try{const data=Mvu.getMvuData({type:'message',message_id:getCurrentMessageId()});draw((data&&data.stat_data)||{})}catch(e){draw({})}
}
load();`

/** The status bar as one HTML block for a SillyTavern regex replacement. */
export function statusBarHtml(spec) {
  const data = JSON.stringify(spec).replace(/</g, '\\u003c')
  return ['```html', `<div class="bar" id="bar"></div>`, `<style>${BAR_STYLE}</style>`, `<script>const SPEC=${data};${BAR_SCRIPT}</script>`, '```'].join('\n')
}

const regex = (id, scriptName, findRegex, replaceString, options) => ({
  id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false,
  markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...options,
})

/** The SillyTavern side: the bar's display regex and the one that keeps its placeholder from the model. */
export function statusScripts(spec, words) {
  return [
    regex(`${OWN_STATUS_SCRIPT}-hide`, words.hidePlaceholder, '<StatusPlaceHolderImpl/>', '', { promptOnly: true }),
    regex(OWN_STATUS_SCRIPT, words.statusBar, '<StatusPlaceHolderImpl/>', statusBarHtml(spec), { markdownOnly: true }),
  ]
}

// MagVarUpdate, the script SillyTavern cards use to apply <UpdateVariable> blocks and
// show the placeholder. Only Tavern Helper runs it; this app has the same built in.
const MVU_IMPORT = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'"

export function mvuHelper(words) {
  return {
    scripts: [{
      type: 'script',
      enabled: true,
      id: '6d1f4c2a-8e3b-4f5a-9c7d-c1ca7a7e5b01',
      name: 'MVU',
      content: MVU_IMPORT,
      info: words.mvuInfo,
      button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }, { name: '重新读取初始变量', visible: true }] },
      data: {},
    }],
    variables: {},
  }
}
