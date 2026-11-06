// 建角页: the card opens on a form instead of a story. The player picks, writes or rolls, the page sends it as one message,
// and that message brings in a rule that exists for this one turn: write these into the variables, then open the story.
//
// The form is a display regex over a placeholder in the opening, as the status bar is, so the model never reads it and
// it costs nothing. It works the same in SillyTavern (Tavern Helper's triggerSlash) and here (web/compat.js).
import { BAR_STYLE, barLook, regexEntry, statusSpecOf } from './status.mjs'

export const CREATION_TAG = '<CreationPage/>'
const PAGE_SCRIPT = 'cicatavern-creation-page'
const KINDS = ['pick', 'text', 'points']
const MAX_FIELDS = 6
const MAX_OPTIONS = 12
const MAX_TOTAL = 40
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
// What a label or an option may not hold: it goes into a path, and into one line of a slash command.
const name = (value, max) => clip(value, max).replace(/[./\\:：；;|{}$\s]+/g, '')

const WORDS = {
  zh: {
    mark: '【建角】', entry: '[开局]建角', purpose: '玩家填完开局的表时才生效：把表里的值写进变量，再写开场',
    page: '建角页', hide: '建角页不发给模型', check: '开局由玩家在建角页定，之后随故事变',
    roll: '随机', rollAll: '全部随机', start: '开始故事', left: '还有 {n} 点没分', sent: '已经发出去了，等开场…', blank: '没写', copy: '这里发不出去，把下面这段发给模型：',
  },
  en: {
    mark: '[Character sheet] ', entry: '[Opening] Character sheet', purpose: 'only when the player sends the opening form: puts its values in the variables, then opens the story',
    page: 'Character page', hide: 'Keep the character page from the model', check: 'set by the player on the character page, then moves with the story',
    roll: 'Random', rollAll: 'All random', start: 'Start the story', left: '{n} points left', sent: 'Sent. The story is on its way…', blank: 'not written', copy: 'This page cannot send here. Send this to the model:',
  },
}
const wordsOf = english => WORDS[english ? 'en' : 'zh']

export const CREATION_TALK = '这张卡开局先让玩家填一张表或抽一抽，再开始故事。和用户商量开局要定哪几件事、每件事有哪些选项。用户说交给你，就按这张卡定。'

export const creationPlan = root => `方案里多写一个 creation 字段：{"intro": "开局前对玩家说的一句话", "fields": [{"label": "这一项的名字，几个字", "kind": "pick", "options": ["选项"], "note": "一句说明，可以空着", "path": "tracking 里已经有的变量 path，没有就空着"}]}。kind 有三种：pick 从 options 里选一个，text 玩家自己写一小段，points 把 total 点分给 options 里的几项（比如 "total": 10）。fields 2 到 6 个，pick 的 options 3 到 8 个，每个选项写成这个故事里具体的东西，选了会真的改变开局。不问玩家的名字，名字另有地方填，path 用「${root}.这一项」。`

/** The form as a plan keeps it, or null when the model wrote none. */
export function cleanCreation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const seen = new Set()
  const fields = (Array.isArray(raw.fields) ? raw.fields : [])
    .filter(field => field && typeof field === 'object')
    .map(field => {
      const kind = KINDS.includes(field.kind) ? field.kind : 'pick'
      const options = [...new Set((Array.isArray(field.options) ? field.options : []).map(item => (kind === 'points' ? name(String(item ?? ''), 12) : clip(String(item ?? ''), 24).replace(/[|{}$]/g, ' ').trim())).filter(Boolean))].slice(0, MAX_OPTIONS)
      const path = clip(field.path, 60).replace(/[{}\s]+/g, '')
      return {
        label: name(field.label, 10),
        kind,
        options: kind === 'text' ? [] : options,
        note: clip(field.note, 60),
        ...(kind === 'points' ? { total: Math.min(MAX_TOTAL, Math.max(1, Math.round(Number(field.total)) || 10)) } : {}),
        ...(path && kind !== 'points' ? { path } : {}),
      }
    })
    .filter(field => field.label && !seen.has(field.label) && seen.add(field.label) && (field.kind === 'text' || field.options.length >= 2))
    .slice(0, MAX_FIELDS)
  return { intro: clip(raw.intro, 120), fields }
}

export const creationReady = plan => Boolean(plan.creation?.fields.length)

/** Each value the form sets and the variable it goes in. */
function targets(creation, root) {
  return creation.fields.flatMap(field => (field.kind === 'points'
    ? field.options.map(option => ({ label: option, path: `${root}.${option}`, field }))
    : [{ label: field.label, path: field.path || `${root}.${field.label}`, field }]))
}

/** The variables the form needs that the plan does not have yet. */
export function creationVariables(creation, root, have, english) {
  const { check } = wordsOf(english)
  return targets(creation, root)
    .filter(({ path }) => !have.some(variable => variable.path === path))
    .map(({ label, path, field }) => ({
      path, label: clip(label, 12), type: field.kind === 'points' ? 'number' : 'string', initial: field.kind === 'points' ? '0' : '', range: '', check,
      show: field.kind === 'points' ? 'number' : field.kind === 'text' ? 'text' : 'badge',
    }))
}

/** The entry that comes in with the form's message and with nothing else. */
export function creationEntry(plan, english) {
  const words = wordsOf(english)
  return { name: words.entry, type: '状态', part: 'creation', keywords: [words.mark.trim()], purpose: words.purpose }
}

/** Where the story starts once the form is in: the first opening the plan has. */
function startOf(plan) {
  const opening = plan.greetings?.[0]
  return [opening?.start, opening?.scene, opening?.situation].filter(Boolean).join(' ')
}

export function creationText(plan, english, root) {
  const { mark } = wordsOf(english)
  const map = targets(plan.creation, root).map(({ label, path }) => (english ? `${label} → ${path}` : `${label} → ${path}`)).join(english ? '; ' : '；')
  const start = startOf(plan)
  return english
    ? [
      '<creation_rules>',
      `This holds only when the player's message starts with ${mark.trim()}: that is the form they filled in before the story. At any other time this rule is void.`,
      '- What they chose stands. Do not change it or add to it for them.',
      `- Put the values in the variables: ${map}`,
      `- This turn opens the story.${start ? ` It starts here: ${start}` : ''} Let what they chose show in it.`,
      '- Do not ask them again about what the form settled.',
      '</creation_rules>',
    ].join('\n')
    : [
      '<creation_rules>',
      `这条只在玩家的消息以${mark}开头时有效：那是玩家开局前填好的表，其余时候这条作废。`,
      '- 表里的值是玩家定的，照用，不改，也不替他补别的。',
      `- 把这些值写进变量：${map}`,
      `- 这一轮写故事的开场。${start ? `从这里开始：${start}` : ''}玩家选的东西要在开场里看得出来。`,
      '- 表上定了的事不要再问玩家。',
      '</creation_rules>',
    ].join('\n')
}

/** What the card opens on. The written openings stay behind it, as the ones to take without the form. */
export function creationOpening(creation, english) {
  return [creation.intro || (english ? 'A few things to settle before the story starts.' : '开始之前，先定几件事。'), CREATION_TAG].join('\n\n')
}

const PAGE_STYLE = `
.cr-field{margin:12px 0}
.cr-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.cr-label{font-weight:600}
.cr-note{color:var(--muted);font-size:12px}
.cr-opts{display:flex;flex-wrap:wrap;gap:6px}
.cr-opt,.cr-small,.cr-go{font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:999px;padding:3px 12px;cursor:pointer}
.cr-opt.on,.cr-go{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.cr-small{padding:1px 9px;font-size:12px;color:var(--muted)}
.cr-text{width:100%;box-sizing:border-box;font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:8px;padding:6px 8px;min-height:3em;resize:vertical}
.cr-row{display:flex;align-items:center;gap:8px;min-height:30px}
.cr-row .cr-name{flex:1}
.cr-num{min-width:2em;text-align:center}
.cr-foot{display:flex;align-items:center;gap:10px;margin-top:14px}
.cr-foot .cr-note{flex:1}
.cr-go{padding:6px 18px}
.cr-go:disabled{opacity:.45;cursor:default}
.cr-copy{white-space:pre-wrap;user-select:all;border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin-top:8px}`

// Plain concatenation and no dollar signs: this goes through a regex replacement, and through a template string here.
const PAGE_SCRIPT_TEXT = `
var box=document.getElementById('bar'),W=SPEC.words,picks={},sent=false,left='';
function h(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function one(list){return list[Math.floor(Math.random()*list.length)]}
function spare(f){var v=picks[f.label]||{},n=f.total;f.options.forEach(function(o){n-=v[o]||0});return n}
function roll(f){
  if(f.kind==='pick')picks[f.label]=one(f.options);
  if(f.kind==='points'){var v={};f.options.forEach(function(o){v[o]=0});for(var i=0;i<f.total;i++)v[one(f.options)]++;picks[f.label]=v}
}
function ready(){return SPEC.fields.every(function(f){return f.kind==='pick'?Boolean(picks[f.label]):f.kind==='points'?spare(f)===0:true})}
function line(f){
  var v=picks[f.label];
  if(f.kind==='points')return f.options.map(function(o){return o+'：'+((v&&v[o])||0)}).join('；');
  return f.label+'：'+(String(v||'').trim()||W.blank);
}
function sheet(){return (SPEC.mark+SPEC.fields.map(line).join('；')).replace(/[|]/g,'｜').replace(/[{]/g,'｛').replace(/[}]/g,'｝').replace(/\\s*\\n\\s*/g,' ')}
function pickField(f,body){
  var row=h('div','cr-opts');
  f.options.forEach(function(o){var b=h('button','cr-opt'+(picks[f.label]===o?' on':''),o);b.type='button';b.disabled=sent;b.onclick=function(){picks[f.label]=o;draw()};row.append(b)});
  body.append(row);
}
function textField(f,body){
  var t=h('textarea','cr-text');t.value=picks[f.label]||'';t.disabled=sent;t.oninput=function(){picks[f.label]=t.value};body.append(t);
}
function pointsField(f,body){
  f.options.forEach(function(o){
    var row=h('div','cr-row'),v=picks[f.label]=picks[f.label]||{},n=v[o]||0;
    var less=h('button','cr-small','−'),more=h('button','cr-small','+');
    less.type=more.type='button';less.disabled=sent||n<=0;more.disabled=sent||spare(f)<=0;
    less.onclick=function(){v[o]=n-1;draw()};more.onclick=function(){v[o]=n+1;draw()};
    row.append(h('span','cr-name',o),less,h('span','cr-num',String(n)),more);body.append(row);
  });
}
function draw(){
  box.replaceChildren();
  if(SPEC.title)box.append(h('div','title',SPEC.title));
  SPEC.fields.forEach(function(f){
    var field=h('div','cr-field'),head=h('div','cr-head');
    head.append(h('span','cr-label',f.label));
    if(f.note)head.append(h('span','cr-note',f.note));
    if(f.kind!=='text'){var r=h('button','cr-small',W.roll);r.type='button';r.disabled=sent;r.onclick=function(){roll(f);draw()};head.append(r)}
    field.append(head);
    (f.kind==='pick'?pickField:f.kind==='points'?pointsField:textField)(f,field);
    if(f.kind==='points'&&spare(f)>0)field.append(h('div','cr-note',W.left.replace('{n}',spare(f))));
    box.append(field);
  });
  var foot=h('div','cr-foot'),all=h('button','cr-small',W.rollAll),go=h('button','cr-go',W.start);
  all.type=go.type='button';all.disabled=sent;go.disabled=sent||!ready();
  all.onclick=function(){SPEC.fields.forEach(roll);draw()};go.onclick=send;
  foot.append(all,h('span','cr-note',sent?W.sent:''),go);box.append(foot);
  if(left){box.append(h('div','cr-note',W.copy),h('div','cr-copy',left))}
}
async function send(){
  var text=sheet(),run=null;
  try{run=typeof triggerSlash==='function'?triggerSlash:parent.TavernHelper&&parent.TavernHelper.triggerSlash}catch(e){}
  if(!run){left=text;draw();return}
  sent=true;draw();
  try{await run('/send '+text+' | /trigger')}catch(e){sent=false;left=text;draw()}
}
draw();`

/** The form as one HTML block for a regex replacement. */
export function creationHtml(creation, { title = '', look = {}, english = false } = {}) {
  const { mark, roll, rollAll, start, left, sent, blank, copy } = wordsOf(english)
  const spec = { title, mark, fields: creation.fields.map(({ path, ...field }) => field), words: { roll, rollAll, start, left, sent, blank, copy } }
  const data = JSON.stringify(spec).replace(/</g, '\\u003c')
  return ['```html', '<!DOCTYPE html>', '<html><head><meta charset="utf-8">', `<style>${BAR_STYLE}${PAGE_STYLE}</style>`, '</head><body>', `<div class="bar${look.theme ?? ''}" id="bar"${look.style ?? ''}></div>`, `<script>var SPEC=${data};${PAGE_SCRIPT_TEXT}</script>`, '</body></html>', '```'].join('\n')
}

/** The two scripts: the form for the player, nothing for the model. */
export function creationScripts(plan, english) {
  const words = wordsOf(english)
  const status = statusSpecOf(plan)
  const look = barLook(status ?? { theme: plan.status?.theme, palette: plan.status?.palette })
  return [
    regexEntry(`${PAGE_SCRIPT}-hide`, words.hide, CREATION_TAG, '', { promptOnly: true }),
    regexEntry(PAGE_SCRIPT, words.page, CREATION_TAG, creationHtml(plan.creation, { title: plan.tracking?.title ?? '', look, english }), { markdownOnly: true }),
  ]
}

/** The form a card carries, from its scripts; null without one. */
export function creationOf(scripts) {
  const script = (scripts ?? []).find(item => item.id === PAGE_SCRIPT)
  const found = /var SPEC=(\{.*?\});\n/s.exec(script?.replaceString ?? '')
  if (!found) return null
  try {
    return JSON.parse(found[1])
  } catch {
    return null
  }
}

/** The message the form sends, filled in by chance: what 试玩体检 opens with. */
export function randomSheet(spec, random = Math.random) {
  const one = list => list[Math.floor(random() * list.length)]
  const line = field => {
    if (field.kind === 'pick') return `${field.label}：${one(field.options)}`
    if (field.kind === 'text') return `${field.label}：${spec.words.blank}`
    const points = Object.fromEntries(field.options.map(option => [option, 0]))
    for (let i = 0; i < field.total; i++) points[one(field.options)]++
    return field.options.map(option => `${option}：${points[option]}`).join('；')
  }
  return `${spec.mark}${spec.fields.map(line).join('；')}`
}
