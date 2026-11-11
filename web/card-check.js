// 检查这张卡 (the card list's ⋯, 修改角色卡): what is wrong with a saved card and what could be better, in one list.
// The program's findings show as soon as the window opens and cost nothing (server/forge/check.mjs); the model is asked
// only by the button here, after it says which model and about how much (check-model.mjs). Each finding shows as before
// and after, and can be taken in as it is, written over first, or ignored; what was taken in can be taken back, one by
// one or all that went in together. Only safe fixes come ticked for 一键采用. The last 试玩体检's problems have a
// section of their own: a model is asked for changes to them only by their buttons, and they can be fixed by hand.
import { t } from '/i18n.js'
import { EFFECTS, SHOWS, STATUS_THEMES, backdropLayers, cleanStatusSpec, colorContrast, statusPages, triedExtreme, withTried } from '/shared/status.js'
import { getPath, unwrap } from '/shared/vars.js'
import { statusBar } from '/status.js'
import { coverPage } from '/cover.js'
import { diffView } from '/talk.js'

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const MANAGE_PROVIDERS = '__manage__'
// In the same list: the window of the player's 附加提示词 for the check (web/tool-prompts.js).
const TOOL_PROMPTS = '__tool_prompts__'
// 按卡配色 in the theme list: not a theme, three colors of the card's own.
const OWN_COLORS = 'auto'
// 定制外观 there too, while the bar wears one: a look a model wrote for this card.
const OWN_SKIN = 'skin'
const FIRST_COLORS = { bg: '#f7f8f5', ink: '#1c2427', accent: '#2b5869' }
// A long look is left out of the editing box: the page would hang on it, and a model never wrote it.
const MAX_EDIT = 20000
const FOLD_OVER = 6

const LEVELS = [['error', t`会出错`, t`这些地方现在不起作用。`], ['warn', t`可能有问题`, t`能用，但多半不是作者想要的效果。`], ['tip', t`可以更好`, t`不改也能玩。`]]
const FOCUS = [['rules', t`玩法和变量`, t`规则打架、变量没写清、和开场白对不上`], ['tokens', t`省上下文`, t`常驻改关键词、重复条目、太宽的关键词`], ['look', t`美化`, t`状态栏显示什么、用什么主题`], ['style', t`文笔`, t`套话和前后矛盾。默认不查，别人的写法不去挑`]]
const SHOW_TEXT = { meter: t`进度条`, number: t`数字`, rating: t`星级`, text: t`文字`, long: t`长文字`, badge: t`徽章`, tags: t`标签`, list: t`列表`, stats: t`数值表`, table: t`表格`, flag: t`是或否`, hidden: t`不显示` }
const THEME_TEXT = { plain: t`朴素`, paper: t`纸张`, neon: t`霓虹`, pastel: t`柔和`, ink: t`水墨`, parchment: t`羊皮卷`, gothic: t`暗夜`, terminal: t`终端`, ocean: t`深海`, [OWN_COLORS]: t`按卡配色` }
const BRICK_TEXT = { books: t`册子`, selfcheck: t`写前自查`, events: t`随机事件`, judge: t`裁判表`, world: t`世界动态`, schedule: t`日程`, relations: t`关系网`, routes: t`路线与结局`, creation: t`建角页` }
// What a Tavern Helper script's absence comes to (server/helper-scripts.mjs).
const HELPER_EFFECT = { none: t`不受影响`, some: t`部分影响`, lost: t`功能缺失` }
// A script that only follows the variables runs here, in a sandbox on the server (server/card-scripts.mjs).
const HELPER_HOOKS = t`在这里运行：每轮变量更新前后照 MVU 的方式执行（在服务器的沙盒里，手机和视觉小说里也一样）。`
// Any other runs on the page while the chat is open (web/card-scripts.js).
const HELPER_PAGE = t`在这里运行：打开对话时在页面上启动，在它自己的隔离框架里；它自己画的界面显示在右下角的小窗。`
const HELPER_KIND = {
  mvu: t`MVU 框架：变量更新和状态栏已经内置。`,
  schema: t`变量规则：已经读进来，每轮照规则检查变量。`,
  'schema-remote': t`变量规则放在网上，读不到：变量照常更新，但范围和默认值不生效。`,
  upkeep: t`管 SillyTavern 里世界书和正则设置的小工具，这里用不上。`,
  updater: t`检查作者更新的工具：这里不会自动更新，出新版要重新导入。`,
}
// What the trial's reader calls a problem (server/forge/trial.mjs).
const KIND_TEXT = { 抢话: t`抢话`, 出戏: t`出戏`, 矛盾: t`矛盾`, 放水: t`放水`, 重复: t`重复`, 数值: t`数值`, 事件: t`事件`, 其他: t`其他` }
// Findings about an entry's keywords: their box is the keywords, not its text.
const KEY_RULES = new Set(['key-joined', 'key-invalid', 'key-single', 'entry-unreachable'])

const count = n => n.toLocaleString()

/** What one script's absence means here, in a sentence or two. */
function helperWords(script) {
  if (!script.on) return t`作者关着，SillyTavern 里也不运行。`
  // The Tavern Helper functions it calls that are not where it runs: that step of it fails.
  const lacking = script.missing?.length ? t`它用到的这些酒馆助手函数这里没有，用到时那一步会失败：${script.missing.join(t`、`)}。` : ''
  if (script.kind === 'hooks') {
    const notes = [script.uses.includes('model') ? t`它会自己调用模型：要在下面允许才行。` : '', script.buttons.length ? t`它的按钮在输入框上方。` : '', lacking]
    return [HELPER_HOOKS, ...notes].filter(Boolean).join('')
  }
  if (script.kind !== 'custom') return HELPER_KIND[script.kind]
  if (script.remote) return t`从网址加载（${script.hosts.join(t`、`)}），内容不在卡里：打开对话时在页面上运行，要在「设置 → 更多 → 隐私与网络」里开着「加载酒馆助手脚本库」。看不出它具体做什么，用到的功能这里不一定都有。`
  return [
    HELPER_PAGE,
    script.buttons.length ? t`它的按钮在输入框上方。` : '',
    script.stPage ? t`它要改 SillyTavern 自己页面上的东西（消息列表、菜单），这部分不起作用。` : '',
    lacking,
  ].filter(Boolean).join('')
}

/**
 * The bar's settings, the fields a row each: what it shows, how and on which page. It never turns into HTML to write by
 * hand. Also 修改角色卡's (web/card-edit.js, which imports it when its 状态栏 is opened).
 * @param change - a statusBar change ({ spec }); `edit` keeps what is written over it, { spec, paged }
 * @param options - { spare: fields the card's variables could show and the bar does not, state: the variables as they
 *   start (the preview), redraw(): draw it again (a row added or gone, the look changed), design: { api, cardId }
 *   where a model can be asked for a look of the card's own (定制外观; skinPanel's options), tryKey: what the scenes
 *   tried in the preview are kept under on this device (the card's id) }
 */
export function statusEditor(el, change, edit, { spare = [], state = {}, redraw, design = null, tryKey = '' }) {
  edit.spec ??= structuredClone(change.spec)
  edit.paged ??= statusPages(edit.spec).length > 0
  const { spec } = edit
  const preview = el('div', { class: 'status-preview cc-status-preview' })
  edit.tryKey = tryKey
  const drawPreview = () => {
    const shown = cleanStatusSpec(spec)
    preview.replaceChildren((shown && statusBar(el, shown, triedState(edit, state), { collapsible: false, note: triedNote(edit) })) || el('p', { class: 'hint', text: t`还没有要显示的项。` }))
  }
  // 试数值: the preview, and a look being designed under it, with other values than the card starts with.
  const tryout = tryoutBar(el, edit, { spec: () => spec, state, key: tryKey, onChange: () => {
    drawPreview()
    edit.look?.draw?.()
  } })
  const pickLook = name => {
    if (name === OWN_SKIN) return
    // Any other look takes the card's own off; its three colors stay for 按卡配色.
    delete spec.skin
    if (name === OWN_COLORS) {
      spec.palette ??= change.spec.palette ?? FIRST_COLORS
      delete spec.theme
    } else {
      delete spec.palette
      spec.theme = name === 'plain' ? undefined : name
    }
    redraw()
  }
  const title = el('input', { value: spec.title ?? '', placeholder: t`标题，可以不写`, 'aria-label': t`状态栏标题`, oninput: () => { spec.title = title.value; drawPreview() } })
  const look = spec.skin ? OWN_SKIN : spec.palette ? OWN_COLORS : spec.theme ?? 'plain'
  const looks = [...STATUS_THEMES, OWN_COLORS, ...(spec.skin ? [OWN_SKIN] : [])]
  const lookText = name => (name === OWN_SKIN ? (spec.skin.name ? t`定制外观「${spec.skin.name}」` : t`定制外观`) : THEME_TEXT[name] ?? name)
  const theme = el('select', { 'aria-label': t`主题`, onchange: () => pickLook(theme.value) }, looks.map(name => el('option', { value: name, selected: look === name, text: lookText(name) })))
  const colors = () => el('div', { class: 'var-colors' }, [['bg', t`背景`], ['ink', t`文字`], ['accent', t`强调`]].map(([key, label]) => {
    const box = el('input', { type: 'color', value: spec.palette[key], 'aria-label': label, oninput: () => { spec.palette = { ...spec.palette, [key]: box.value }; drawPreview() } })
    return el('label', {}, [box, el('span', { text: label })])
  }))
  const paging = el('label', { class: 'check-row cc-status-paged' }, [
    el('input', { type: 'checkbox', checked: edit.paged, onchange: event => {
      edit.paged = event.target.checked
      if (!edit.paged) for (const field of spec.fields) delete field.page
      redraw()
    } }),
    el('span', { text: t`分几页` }),
    el('small', { class: 'hint', text: t`没写页名的放在第一页，至少要有两页。` }),
  ])
  const row = (field, index) => {
    const label = el('input', { value: field.label ?? '', placeholder: field.path, 'aria-label': t`「${field.path}」的名字`, oninput: () => { field.label = label.value; drawPreview() } })
    const show = el('select', { 'aria-label': t`「${field.path}」的显示方式`, onchange: () => { field.show = show.value; redraw() } }, SHOWS.map(name => el('option', { value: name, selected: field.show === name, text: SHOW_TEXT[name] ?? name })))
    const page = el('input', { value: field.page ?? '', maxlength: 8, placeholder: t`第几页的页名`, 'aria-label': t`「${field.path}」在状态栏哪一页`, oninput: () => { field.page = page.value; drawPreview() } })
    const drop = el('button', { type: 'button', class: 'btn ghost small', 'aria-label': t`去掉「${field.path}」`, title: t`去掉`, text: '×', onclick: () => { spec.fields.splice(index, 1); redraw() } })
    return el('div', { class: `cc-status-row${edit.paged ? ' paged' : ''}` }, [el('code', { text: field.path }), label, show, edit.paged ? page : null, drop])
  }
  // 立绘, 场景图 and 动效 on the bar: the pictures are the ones the app keeps for this card.
  const picture = (key, label, hint) => {
    const box = el('input', { type: 'checkbox', onchange: () => {
      if (box.checked) spec[key] = true
      else delete spec[key]
      drawPreview()
    } })
    box.checked = spec[key] === true
    return el('label', { class: 'front-check', title: hint }, [box, el('span', { text: label })])
  }
  const effect = el('select', { 'aria-label': t`动效`, onchange: () => {
    if (effect.value) spec.effect = effect.value
    else delete spec.effect
    drawPreview()
  } }, [el('option', { value: '', text: t`不要` }), ...EFFECTS.map(kind => el('option', { value: kind, text: effectNames()[kind] }))])
  effect.value = spec.effect ?? ''
  const pictures = el('div', { class: 'front-row' }, [
    picture('portrait', t`顶上放立绘`, t`显示主要角色的立绘（角色名册里画的；没有立绘时用人设图或卡的头像）。状态栏里有「心情」这类变量、又画了表情时，立绘跟着换表情`),
    picture('scene', t`顶上放场景图`, t`回复写到一个有场景图的地点时显示那张图（视觉小说的场景）`),
    picture('phone', t`小手机`, t`列表、表格、长段文字和第一页以后的各页不直接摆在状态栏上，变成一排图标，点开在一个小手机里看（背包、任务、情报这类）`),
    el('label', { class: 'front-check' }, [el('span', { text: t`动效` }), effect]),
    el('small', { class: 'hint', text: t`图片只在 CicaTavern 里显示，这里的预览不带图。` }),
  ])
  // What the card's variables could show and the bar does not.
  const left = spare.filter(field => !spec.fields.some(shown => shown.path === field.path))
  const adding = el('select', { class: 'cc-status-add', 'aria-label': t`加一项`, onchange: () => {
    spec.fields.push(structuredClone(left.find(field => field.path === adding.value)))
    redraw()
  } }, [el('option', { value: '', text: t`加一项…` }), ...left.map(field => el('option', { value: field.path, text: field.label ? `${field.label} (${field.path})` : field.path }))])
  drawPreview()
  return [
    preview,
    tryout,
    el('div', { class: 'cc-status-top' }, [title, theme]),
    spec.palette ? colors() : null,
    design ? skinPanel(el, edit, { state, redraw, kept: change.spec.skin?.css ?? '', ...design }) : null,
    pictures,
    paging,
    el('div', { class: 'cc-status-rows' }, spec.fields.map(row)),
    left.length ? adding : null,
  ]
}

/** What each 动效 is called. */
export const effectNames = () => ({ rain: t`雨`, snow: t`雪`, petals: t`花瓣`, embers: t`火星`, fireflies: t`萤火`, stars: t`星光`, dust: t`浮尘` })

// ─── 试数值 ───────────────────────────────────────────────────────────────
// The preview with other values than the card starts with: every gauge full or down, values typed in, and scenes kept
// by name on this device (a card's, by its id). Only the preview changes; a look being designed is checked in them too.

const MAX_SCENES = 8
const TRY_ROWS = 40
const scenesKey = key => `statusScenes:${key}`

/** The scenes kept for a card on this device: [{ name, values: { path: value } }]. */
function scenesOf(key) {
  if (!key) return []
  try {
    const list = JSON.parse(localStorage.getItem(scenesKey(key)) ?? '[]')
    return Array.isArray(list) ? list.filter(item => item && typeof item.name === 'string' && item.values && typeof item.values === 'object').slice(0, MAX_SCENES) : []
  } catch {
    return []
  }
}

function keepScenes(key, list) {
  try {
    if (list.length) localStorage.setItem(scenesKey(key), JSON.stringify(list.slice(0, MAX_SCENES)))
    else localStorage.removeItem(scenesKey(key))
  } catch {
    // A private window: the scenes last as long as the page.
  }
}

/** The variables as a preview shows them: as the card starts, or with what is being tried (`edit.tryout`) over that. */
export const triedState = (edit, state) => (edit.tryout ? withTried(state, edit.tryout.values) : state)
/** The line under a preview's title that says which. */
export const triedNote = edit => (edit.tryout ? t`预览 · ${edit.tryout.name}` : t`预览 · 初始值`)

/**
 * 试数值 under a bar's preview. What is tried is `edit.tryout` ({ name, values }), null for the card's own start.
 * @param options - { spec(): the bar now, state: the variables as they start, key: what the scenes are kept under
 *   ('' = none are kept), onChange(): draw the previews again }
 */
export function tryoutBar(el, edit, { spec, state, key = '', onChange }) {
  const box = el('div', { class: 'cc-tryout' })
  const shown = () => cleanStatusSpec(spec())
  const pick = (name, values) => {
    edit.tryout = values ? { name, values } : null
    draw()
    onChange()
  }
  /** A value typed over the others being tried; the boxes stay as they are under the cursor. */
  const set = (path, value) => {
    edit.tryout = { name: scenesOf(key).some(scene => scene.name === edit.tryout?.name) ? edit.tryout.name : t`自己改的`, values: { ...edit.tryout?.values, [path]: value } }
    onChange()
  }

  function valueBox(field) {
    const now = unwrap(getPath(triedState(edit, state), field.path))
    const label = field.label || field.path
    if (field.show === 'meter' && typeof now === 'number') {
      const said = el('span', { class: 'cc-try-said', text: String(now) })
      const box = el('input', { type: 'range', min: field.min, max: field.max, step: (field.max - field.min) % 1 || field.max - field.min < 10 ? 'any' : 1, value: now, 'aria-label': label, oninput: () => {
        const value = Math.round(Number(box.value) * 100) / 100
        said.textContent = String(value)
        set(field.path, value)
      } })
      return [box, said]
    }
    if ((field.show === 'number' || field.show === 'rating') && typeof now === 'number') {
      const box = el('input', { type: 'number', value: now, 'aria-label': label, ...(field.show === 'rating' ? { min: 0, max: field.max ?? 5 } : {}), oninput: () => { if (box.value !== '' && Number.isFinite(Number(box.value))) set(field.path, Number(box.value)) } })
      return [box]
    }
    if (field.show === 'flag' && typeof now === 'boolean') {
      const box = el('input', { type: 'checkbox', checked: now, 'aria-label': label, onchange: () => set(field.path, box.checked) })
      return [box]
    }
    if ((field.show === 'tags' || field.show === 'list') && Array.isArray(now) && now.every(item => typeof item === 'string')) {
      const box = el('input', { type: 'text', 'aria-label': label, placeholder: t`几项用顿号隔开`, oninput: () => set(field.path, box.value.split(/[、,，]/).map(item => item.trim()).filter(Boolean)) }) // i18n-ignore: separators
      box.value = now.join(t`、`)
      return [box]
    }
    if (typeof now === 'string') {
      const box = el('input', { type: 'text', 'aria-label': label, oninput: () => set(field.path, box.value) })
      box.value = now
      return [box]
    }
    return null
  }

  function draw() {
    const bar = shown()
    if (!bar) return box.replaceChildren()
    const scenes = scenesOf(key)
    const active = edit.tryout?.name ?? ''
    const chip = (name, values, on = active === name) => el('button', { type: 'button', class: 'cc-try-chip', 'aria-pressed': String(on), text: name, onclick: () => pick(name, values) })
    const kept = scenes.map(scene => el('span', { class: 'cc-try-kept' }, [
      chip(scene.name, scene.values),
      el('button', { type: 'button', class: 'cc-try-drop', title: t`删掉这个场景`, 'aria-label': t`删掉场景「${scene.name}」`, text: '×', onclick: () => {
        keepScenes(key, scenes.filter(item => item.name !== scene.name))
        if (active === scene.name) return pick('', null)
        draw()
      } }),
    ]))
    const head = el('div', { class: 'cc-try-chips' }, [
      el('span', { class: 'hint', text: t`试数值` }),
      el('button', { type: 'button', class: 'cc-try-chip', 'aria-pressed': String(!edit.tryout), text: t`初始值`, onclick: () => pick('', null) }),
      chip(t`数值拉满`, triedExtreme(bar, state, 'full')),
      chip(t`数值见底`, triedExtreme(bar, state, 'low')),
      ...kept,
      el('button', { type: 'button', class: 'cc-try-chip', 'aria-expanded': String(Boolean(edit.tryOpen)), text: edit.tryOpen ? t`收起` : t`自己改…`, onclick: () => { edit.tryOpen = !edit.tryOpen; draw() } }),
    ])
    if (!edit.tryOpen) return box.replaceChildren(head)
    const rows = bar.fields.filter(field => field.show !== 'hidden').slice(0, TRY_ROWS).flatMap(field => {
      const boxes = valueBox(field)
      return boxes ? [el('div', { class: 'cc-try-row' }, [el('span', { text: field.label || field.path, title: field.path }), ...boxes])] : []
    })
    const name = el('input', { type: 'text', maxlength: 12, placeholder: t`场景的名字，比如：好感满了`, 'aria-label': t`场景的名字` })
    name.value = scenes.some(scene => scene.name === active) ? active : ''
    const keep = el('button', { type: 'button', class: 'btn small', text: t`存成场景`, title: t`存在这台设备上，下次调这张卡的状态栏还在；设计外观时也会照这些场景检查`, onclick: () => {
      const called = name.value.trim()
      if (!called || !edit.tryout) return name.focus()
      keepScenes(key, [...scenes.filter(scene => scene.name !== called), { name: called, values: edit.tryout.values }])
      pick(called, edit.tryout.values)
    } })
    box.replaceChildren(
      head,
      rows.length ? el('div', { class: 'cc-try-rows' }, rows) : el('p', { class: 'hint', text: t`这张状态栏没有能直接改的项（表格和数值表按初始值显示）。` }),
      el('p', { class: 'hint', text: t`只改这里的预览，不动卡和对话。表格和数值表按初始值显示。` }),
      key ? el('div', { class: 'cc-try-keep' }, [name, keep, scenes.length >= MAX_SCENES ? el('small', { class: 'hint', text: t`最多存 ${MAX_SCENES} 个，再存要先删一个。` }) : null]) : null,
    )
  }
  draw()
  return box
}

// ─── 定制外观 ─────────────────────────────────────────────────────────────
// A look of the card's own for its bar: a model writes the CSS (server/forge/skin.mjs), sent only by the buttons here.
// The draft is drawn off screen before it is shown, at a phone's width and a wide one, as the chat starts and with the
// gauges full, to see what sticks out of the bar or cannot be read; what that finds goes back to the model once.

// Ways a look can go, to start from: picking one writes its words into the box, to be changed like any typed there.
const SKIN_STYLES = () => [
  [t`日系清新`, t`日系清新：浅色的底，低饱和的粉蓝或薄荷色，大圆角，细线，留白多，像一个干净的手机日记应用`],
  [t`金属光泽`, t`金属光泽：拉丝金属的底，边框有高光和倒角，进度条像抛光的金属条，冷色，硬朗`],
  [t`日记手帐`, t`日记手帐：米色的纸，淡淡的格线或点阵，像贴上去的和纸胶带和便签，手写感的字体，标题下面一道荧光笔`],
  [t`像素风`, t`像素风：硬边，不用圆角和模糊，粗的像素边框（用 box-shadow 叠出台阶），等宽字体，颜色不超过六种，进度条分成一格一格`],
  [t`赛璐璐平涂`, t`莫比斯式的赛璐璐平涂：平涂的色块，纤细均匀的描边，淡而开阔的配色（沙黄、天青、淡紫），用细线排出一点阴影，不用渐变的光泽`],
  [t`水墨留白`, t`水墨留白：宣纸的底，墨色浓淡，朱红只点一处，竖排感的标题，细而不匀的墨线，大片留白`],
  [t`赛博霓虹`, t`赛博霓虹：近黑的底，青和品红的霓虹描边带一点辉光，等宽字体，细的扫描线，角上有切角`],
  [t`童话绘本`, t`童话绘本：暖色的纸，蜡笔和水彩的感觉，圆润的边框像手画的，颜色明快，小装饰用星星和叶子`],
]

const PROBE_WIDTHS = [340, 720]
// Words a reader must make out, and those that are faint on purpose.
const READ_PARTS = '.status-title, .status-label, .status-value, .status-text, .status-tag, .status-badge, .status-stars, .status-flag, .status-long, .status-list li, .status-table th, .status-table td, .status-page, .status-tab, .status-group-name, .status-section'
const FAINT_PARTS = '.status-group-name, .status-section, .status-table thead th, .status-flag:not(.on)'
const MAX_PROBLEMS = 8

/** `rgb(1, 2, 3)` / `rgba(1 2 3 / .5)` as [r, g, b, a]; null for a color written some other way. */
function rgbaOf(text) {
  // What color-mix() computes to: color(srgb 0.95 0.93 0.89 / 0.5), each part from 0 to 1.
  const mixed = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+)(%?))?\s*\)$/.exec(String(text).trim())
  if (mixed) return [Number(mixed[1]) * 255, Number(mixed[2]) * 255, Number(mixed[3]) * 255, Math.max(0, Math.min(1, mixed[4] === undefined ? 1 : Number(mixed[4]) / (mixed[5] ? 100 : 1)))]
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(String(text).trim())
  if (!match) return null
  const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1)
  return [Number(match[1]), Number(match[2]), Number(match[3]), Math.max(0, Math.min(1, alpha))]
}

const over = ([r, g, b, a], under) => [r, g, b].map((value, i) => value * a + under[i] * (1 - a))
const hexOf = rgb => `#${rgb.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`

/** Whether an element's background shows only through its letters (background-clip: text). */
const lettered = style => (style.backgroundClip || style.webkitBackgroundClip || '').split(',').some(clip => clip.trim() === 'text')

/** The colors that may be behind a part of the bar ([r, g, b] each): fills and a gradient's stops, one over the other from the page inward. None when they cannot be told. */
function groundsOf(part, bar) {
  const chain = []
  for (let node = part; node; node = node.parentElement) {
    chain.unshift(node)
    if (node === bar) break
  }
  let grounds = [(rgbaOf(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255]).slice(0, 3)]
  for (const node of chain) {
    const style = getComputedStyle(node)
    // A background cut to the letters is the words' own color, not what is behind them.
    if (lettered(style)) continue
    const fill = rgbaOf(style.backgroundColor)
    if (fill?.[3]) grounds = grounds.map(under => over(fill, under))
    // Lines along an edge and a ruler's ticks are beside the words (backdropLayers leaves them out).
    const layers = backdropLayers(style.backgroundImage, { size: style.backgroundSize, repeat: style.backgroundRepeat, box: node.getBoundingClientRect() })
    if (!layers) return []
    // From the bottom layer up: each one's colors over what is under it.
    for (const colors of layers.reverse()) {
      const stops = colors.map(rgbaOf)
      if (stops.some(stop => !stop)) return []
      grounds = [...new Map(grounds.flatMap(under => stops.map(stop => over(stop, under))).map(rgb => [hexOf(rgb), rgb])).values()].slice(0, 8)
    }
  }
  return grounds
}

/** A part of the bar as a model knows it: its class (a problem with it is said once, for all there are of it), with one row it is in. */
function partName(part) {
  const classOf = node => [...node.classList].find(item => item.startsWith('status-') || item.startsWith('cover-'))
  const name = classOf(part)
  const label = part.closest('.status-row')?.dataset.label
  // A cell or a list's line has no class of its own: said by what it is in (.status-table th).
  const within = name ? null : part.closest('.status-table, .status-list, .cover-lines')
  const tag = name ? `.${name}` : `${within ? `.${classOf(within)} ` : ''}${part.tagName.toLowerCase()}`
  return { tag, words: label && name !== 'status-row' ? t`${tag}（比如「${label}」这一行）` : tag }
}

/** One drawing of the bar looked over; `note(key, words)` for each thing wrong with it. */
function probe(bar, width, note) {
  const box = bar.getBoundingClientRect()
  if (box.height < 24 || box.width < width / 2) return note('gone', t`状态栏几乎没有显示出来（只有 ${Math.round(box.width)}×${Math.round(box.height)} 像素）`)
  if (box.width > width + 1) note(`wider:${width}`, t`放在 ${width} 像素宽的地方时，状态栏自己有 ${Math.round(box.width)} 像素宽，伸出去了`)
  if (bar.scrollWidth > bar.clientWidth + 1) note(`wide:${width}`, t`宽 ${width} 像素时，里面的内容把状态栏横向撑开了`)
  for (const part of bar.querySelectorAll('*')) {
    // 动效's pieces drift in from outside the bar and out again: that is theirs to do.
    if (part.closest('[hidden], .drift')) continue
    const rect = part.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    const { tag, words } = partName(part)
    // A table scrolls sideways in its own box: only that box must stay in.
    const scrolls = part.closest('.status-table-wrap') && !part.classList.contains('status-table-wrap')
    if (!scrolls && (rect.right > box.right + 2 || rect.left < box.left - 2)) note(`out:${tag}`, t`宽 ${width} 像素时，${words} 横向伸出了状态栏`)
    if (rect.bottom > box.bottom + 2 || rect.top < box.top - 2) note(`out-y:${tag}`, t`${words} 伸到了状态栏的上面或下面`)
  }
  probeWords(bar, READ_PARTS, FAINT_PARTS, note)
  for (const meter of bar.querySelectorAll('.status-meter')) {
    if (meter.closest('[hidden]')) continue
    const rect = meter.getBoundingClientRect()
    if (rect.height < 3 || rect.width < 24) note('meter', t`进度条太细或太短（${Math.round(rect.width)}×${Math.round(rect.height)} 像素），看不出进度`)
  }
}

// The 开场页 dressed by the same look: the words a reader must make out on it, and those faint on purpose.
const COVER_PARTS = '.cover-kicker, .cover-title, .cover-tagline, .cover-lines li, .cover-door-no, .cover-door-title, .cover-door-brief, .cover-hint'
const COVER_FAINT = '.cover-kicker, .cover-door-no, .cover-hint'

/** One drawing of the cover looked over, as a bar is. */
function probeCover(wrap, width, note) {
  const page = wrap.querySelector('.cover')
  const box = page.getBoundingClientRect()
  if (box.height < 60 || box.width < width / 2) return note('cover-gone', t`开场页几乎没有显示出来（只有 ${Math.round(box.width)}×${Math.round(box.height)} 像素）`)
  if (box.width > width + 1 || page.scrollWidth > page.clientWidth + 1) note(`cover-wide:${width}`, t`宽 ${width} 像素时，开场页被横向撑开了`)
  for (const part of page.querySelectorAll('.cover-main, .cover-figure, .cover-doors, .cover-door, .cover-hint')) {
    const rect = part.getBoundingClientRect()
    if (rect.width && (rect.right > box.right + 2 || rect.left < box.left - 2)) note(`cover-out:${partName(part).tag}`, t`宽 ${width} 像素时，${partName(part).words} 横向伸出了开场页`)
  }
  probeWords(page, COVER_PARTS, COVER_FAINT, note)
}

/** The words in `root` that must be read (`parts`; `faint`: those dim on purpose): shown, large enough, apart from their ground. */
function probeWords(bar, parts, faint, note) {
  for (const part of bar.querySelectorAll(parts)) {
    if (part.closest('[hidden]') || !part.textContent.trim()) continue
    const { tag, words } = partName(part)
    const style = getComputedStyle(part)
    const rect = part.getBoundingClientRect()
    if (style.display === 'none' || style.visibility === 'hidden' || (!rect.width && !rect.height)) {
      note(`hidden:${tag}`, t`${words} 被藏起来了，要显示出来`)
      continue
    }
    const size = parseFloat(style.fontSize)
    if (size < 11) note(`small:${tag}`, t`${words} 的字只有 ${Math.round(size * 10) / 10} 像素，太小`)
    let alpha = 1
    for (let node = part; node && node !== bar.parentElement; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity)
    if (alpha < 0.45) note(`faded:${tag}`, t`${words} 太透明，看不清`)
    const ink = rgbaOf(style.color)
    // Letters filled with a gradient have no one color to hold against the ground.
    if (!ink || lettered(style)) continue
    const limit = part.matches(faint) ? 2 : 3
    for (const ground of groundsOf(part, bar)) {
      const seen = over([ink[0], ink[1], ink[2], ink[3] * alpha], ground)
      const apart = colorContrast(hexOf(seen), hexOf(ground))
      if (apart !== null && apart < limit) {
        note(`dim:${tag}:${hexOf(seen)}`, t`${words} 的字（${hexOf(seen)}）和它的底色（${hexOf(ground)}）太接近，看不清`)
        break
      }
    }
  }
}

/**
 * What is wrong with a bar in a look of the card's own, in lines a model can put right; [] when it draws well. Drawn as
 * the card starts and with every gauge full, and as each of `more` (states: the scenes the user keeps to try).
 * @param cover - { name, cover } of a card with a 开场页: the look dresses it too, and it is drawn and looked over as well.
 */
export function skinProblems(el, spec, state, more = [], cover = null) {
  const shown = cleanStatusSpec(spec)
  if (!shown?.skin) return []
  const found = new Map()
  const note = (key, words) => { if (!found.has(key)) found.set(key, words) }
  const host = el('div', { class: 'skin-probe', 'aria-hidden': 'true' })
  document.body.append(host)
  try {
    for (const values of [state, withTried(state, triedExtreme(shown, state, 'full')), ...more]) {
      for (const width of PROBE_WIDTHS) {
        host.style.width = `${width}px`
        const bar = statusBar(el, shown, values, { collapsible: false, remembers: false })
        if (!bar) continue
        host.replaceChildren(bar)
        const tabs = [...bar.querySelectorAll('.status-page')]
        for (const tab of tabs.length ? tabs : [null]) {
          tab?.click()
          probe(bar, width, note)
        }
      }
    }
    if (cover?.cover) {
      for (const width of PROBE_WIDTHS) {
        host.style.width = `${width}px`
        const openings = (cover.cover.openings?.length ? cover.cover.openings : [{}, {}]).map(() => '')
        const page = coverPage(el, { name: cover.name, cover: cover.cover, palette: shown.palette ?? null, skin: shown.skin, openings, picked: 0, onPick: async () => {} })
        host.replaceChildren(page.node)
        probeCover(page.node, width, note)
      }
    }
  } finally {
    host.remove()
  }
  return [...found.values()].slice(0, MAX_PROBLEMS)
}

/** The bar in a look: the three colors and the rules, in place of a theme. */
function wearing(spec, skin) {
  const next = { ...spec, palette: skin.palette, skin: { name: skin.name, css: skin.css } }
  delete next.theme
  return next
}

/**
 * 定制外观 in a bar's editor: 调整状态栏 for a saved card, and the plan's status bar in 创作角色卡 (web/forge.js). What it
 * knows is kept on `edit.look` (the editor is drawn again and again): the server's view ({ skin: the draft, job, busy,
 * error, estimate }), what the user typed, what drawing the draft showed. `edit.spec` is the bar being edited: a look
 * put on goes into it (palette, skin), then `redraw()`.
 * @param options - { api, cardId (or url and stopUrl, where the look is asked for and stopped), state: the variables
 *   as they start, redraw, kept: the CSS of the look already saved, instant: whether redraw() saves (no 保存 to click),
 *   busyWords: what to say while something else has the model }
 */
export function skinPanel(el, edit, { api, cardId, url = `/api/cards/${cardId}/check/skin`, stopUrl = `/api/cards/${cardId}/check/stop`, state, redraw, kept = '', instant = false, cover = null, busyWords = t`模型正在看这张卡（检查这张卡），等它看完再设计外观。` }) {
  const look = (edit.look ??= { data: null, missing: false, wish: '', sending: false, mending: false, checked: '', came: '', problems: [], failure: '' })
  const draft = () => look.data?.skin ?? null
  const worn = () => Boolean(draft() && edit.spec.skin?.css === draft().css)
  const asking = () => look.sending || Boolean(look.data?.job)
  // What to work from: the draft on show, or the look the bar already wears.
  const base = () => draft() ?? (edit.spec.skin ? { name: edit.spec.skin.name ?? '', palette: edit.spec.palette, css: edit.spec.skin.css } : null)

  // The parts that change are drawn again in their own places: the box being typed in is left alone.
  const draftSlot = el('div', {})
  const hint = el('p', { class: 'hint' })
  const actions = el('div', {})
  const failure = el('div', {})
  const wish = el('textarea', { rows: 2, 'aria-label': t`想要什么样的外观`, oninput: () => {
    look.wish = wish.value
    drawActions()
  } })
  wish.value = look.wish
  const styles = el('div', { class: 'cc-skin-styles', role: 'group', 'aria-label': t`风格` }, [
    el('span', { class: 'hint', text: t`风格：` }),
    ...SKIN_STYLES().map(([name, words]) => el('button', { type: 'button', class: 'chip-pick', text: name, title: words, onclick: () => {
      // The style's line goes first, in place of another style's; what the user typed stays under it.
      const styles = SKIN_STYLES().map(([, line]) => line)
      const typed = look.wish.split('\n').map(line => line.trim()).filter(line => line && !styles.includes(line))
      wish.value = look.wish = [words, ...typed].join('\n')
      drawActions()
      wish.focus()
    } })),
  ])
  const box = (look.box = el('div', { class: 'cc-skin', hidden: true }, [
    el('p', { class: 'cc-skin-head' }, [el('strong', { text: t`定制外观` }), el('small', { class: 'hint', text: t`让模型按这张卡的气氛给状态栏写一套样子：边框、纹饰、字体、进度条。状态栏还是程序画的，变量照常显示。` })]),
    draftSlot,
    styles,
    wish,
    hint,
    actions,
    failure,
  ]))
  look.draw = draw

  /** Draw the draft off screen once and keep what that showed. */
  function check() {
    const skin = draft()
    if (!skin || look.checked === skin.at) return
    look.checked = skin.at
    look.problems = skinProblems(el, wearing(edit.spec, skin), state, scenesOf(edit.tryKey).map(scene => withTried(state, scene.values)), cover)
  }

  function take(data) {
    look.data = data
    check()
    // A look just made that draws badly goes back once, with what was found; the one that comes back is shown as it is.
    // (The answer can be in the view a moment before its job is gone: it has come only once the job is.)
    const fresh = Boolean(draft()) && !data.job && draft().at !== look.came
    if (draft() && !data.job) look.came = draft().at
    const mend = fresh && look.mending && look.problems.length > 0 && !draft().fixed
    if (fresh) look.mending = false
    if (mend) send({ previous: draft(), problems: look.problems })
  }

  function poll() {
    clearTimeout(look.timer)
    if (!look.data?.job) return
    look.timer = setTimeout(async () => {
      // Asked when the time comes: a panel just drawn again is not on the page yet when this is set going.
      if (!look.box.isConnected) return
      const data = await api(url).catch(() => null)
      if (data) take(data)
      look.draw()
      poll()
    }, 1500)
  }

  async function send(body) {
    look.sending = true
    look.failure = ''
    look.draw()
    try {
      take(await api(url, { method: 'POST', body: { spec: edit.spec, ...body } }))
    } catch (error) {
      look.failure = error.message
      look.mending = false
    }
    look.sending = false
    look.draw()
    poll()
  }

  /** A new look, asked for by the user: one that draws badly is sent back once by itself. */
  function ask(previous) {
    look.mending = true
    send({ wish: look.wish.trim(), previous })
  }

  async function stop() {
    look.mending = false
    await api(stopUrl, { method: 'POST' }).catch(() => null)
  }

  async function drop() {
    const data = await api(url, { method: 'DELETE' }).catch(() => null)
    if (data) look.data = data
    look.problems = []
    look.draw()
  }

  function wear() {
    const skin = draft()
    Object.assign(edit.spec, { palette: skin.palette, skin: { name: skin.name, css: skin.css } })
    // The 动效 the model picked for this look comes with it (it can be changed after).
    if (skin.effect) edit.spec.effect = skin.effect
    delete edit.spec.theme
    redraw()
  }

  function estimateText(estimate) {
    if (!estimate.ready) return t`先在「模型供应商」里添加供应商，再选一个模型。`
    const money = estimate.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    return t`点了才发送。发给 ${estimate.model}，一次大约 ${count(estimate.input + estimate.output)} token${money}。画出来有撑出去或看不清的地方时，会让模型再改一次。`
  }

  function draftBlock(skin) {
    const shown = cleanStatusSpec(wearing(edit.spec, skin))
    const bar = shown && statusBar(el, shown, triedState(edit, state), { collapsible: false, remembers: false, note: triedNote(edit) })
    const cut = { url: t`要加载的图片或字体`, import: t`@import 和 @font-face`, fixed: t`固定在屏幕上的层`, long: t`超出长度的最后几条规则（可以写上「精简一些」再让它改）` }
    return el('div', { class: 'cc-skin-draft' }, [
      el('p', { class: 'cc-skin-name' }, [el('strong', { text: skin.name ? t`「${skin.name}」` : t`新的外观` }), el('small', { class: 'hint', text: skin.model })]),
      skin.reply ? el('p', { class: 'hint', text: skin.reply }) : null,
      skin.effect ? el('p', { class: 'hint', text: t`动效：${effectNames()[skin.effect] ?? skin.effect}（用上这套外观时一起换，之后可以在下面改）` }) : null,
      el('div', { class: 'status-preview cc-status-preview' }, [bar || el('p', { class: 'hint', text: t`还没有要显示的项。` })]),
      look.problems.length
        ? el('div', { class: 'cc-skin-problems' }, [
            el('p', { class: 'ce-outcome warn', text: skin.fixed ? t`让模型改过一次，画出来还有这些地方不对：` : t`画出来有这些地方不对：` }),
            el('ul', {}, look.problems.map(text => el('li', { text }))),
          ])
        : el('p', { class: 'hint', text: t`按手机和电脑的宽度都画过一遍：没有撑出去或看不清的地方。` }),
      skin.cut?.length ? el('p', { class: 'hint', text: t`模型写了不能用的东西，已经去掉：${skin.cut.map(key => cut[key] ?? key).join(t`、`)}。` }) : null,
      el('div', { class: 'cc-actions' }, [
        el('button', { type: 'button', class: 'btn ghost small', disabled: asking(), text: t`不要了`, title: t`丢掉这一版，卡里什么都不变`, onclick: () => drop() }),
        el('span', { class: 'grow' }),
        look.problems.length ? el('button', { type: 'button', class: 'btn small', disabled: asking() || look.data.busy, text: t`让模型修这几处`, onclick: () => send({ previous: skin, problems: look.problems }) }) : null,
        el('button', { type: 'button', class: 'btn primary small', text: t`用这套外观`, title: instant ? t`用在这张卡的状态栏上` : t`换到上面的预览里；点「保存」才写进卡`, onclick: () => wear() }),
      ]),
    ])
  }

  /** The buttons, or what the model is doing. */
  function drawActions() {
    const { job, busy, estimate } = look.data
    const from = base()
    const off = asking() || busy || !estimate.ready
    if (look.sending) return actions.replaceChildren(el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: t`正在发给模型…` })]))
    if (job) {
      const words = job.chars ? t`模型正在写，已经写了 ${count(job.chars)} 字…` : t`模型正在设计，已经 ${Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)} 秒。关掉窗口也会接着写。`
      return actions.replaceChildren(el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: words })]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })]))
    }
    return actions.replaceChildren(el('div', { class: 'cc-actions' }, [
      edit.spec.skin ? el('button', { type: 'button', class: 'btn ghost small', text: t`去掉定制外观`, title: t`状态栏回到三个颜色的样子；这套外观不再用`, onclick: () => { delete edit.spec.skin; redraw() } }) : null,
      el('span', { class: 'grow' }),
      from ? el('button', { type: 'button', class: 'btn small', disabled: off || !look.wish.trim(), text: t`照这个改`, title: t`在现在这一套的基础上，按上面写的改`, onclick: () => ask(from) }) : null,
      // With nothing written, another one unlike this; with a wish, one made from the wish alone.
      el('button', { type: 'button', class: `btn small${from ? '' : ' primary'}`, disabled: off, text: from ? t`另设计一套` : t`让模型设计`, onclick: () => ask(from && !look.wish.trim() ? from : null) }),
    ]))
  }

  function draw() {
    box.hidden = look.missing || !look.data
    if (box.hidden) return
    const skin = draft()
    const name = skin?.name ? t`「${skin.name}」` : t`这一套`
    // The draft the card already wears (saved with it) is nothing new to show.
    const saved = worn() && skin.css === kept
    draftSlot.replaceChildren(...(saved ? [] : worn() ? [el('p', { class: 'hint', text: t`上面的预览用的就是${name}，点「保存」才写进卡。三个颜色还能在上面改。` })] : skin ? [draftBlock(skin)] : []))
    wish.placeholder = base() ? t`想怎么改，比如：边框再细一点，进度条换成金色` : t`想要什么样子，可以不写。比如：像一张泛黄的借书卡；终端里的绿字`
    hint.textContent = look.data.busy ? busyWords : estimateText(look.data.estimate)
    drawActions()
    const words = look.failure || look.data.error
    failure.replaceChildren(...(words ? [el('div', { class: 'forge-error' }, [el('p', { text: words })])] : []))
  }

  if (look.data) {
    check()
    draw()
    poll()
  } else if (!look.missing) {
    // A server from before this (not restarted yet) has no such page: the editor is as it was.
    api(url).then(data => {
      look.data = data
      // A draft from an earlier visit is nothing that just came.
      look.came = data.job ? '' : data.skin?.at ?? ''
      check()
      look.draw()
      poll()
    }).catch(() => {
      look.missing = true
    })
  }
  return box
}

/** @param deps - { api, el, toast, guard, getChat, isGenerating, openProviders, openToolPrompts(group), openTalk(cardId, words), openTrial(cardId), onChatChanged(chat), onCardChanged(cardId) } */
export function initCardCheck({ api, el, toast, guard, getChat, isGenerating, openProviders, openToolPrompts = null, openTalk, openTrial, onChatChanged, onCardChanged }) {
  const dialog = document.getElementById('card-check-dialog')
  const view = {}
  const state = {
    cardId: '',
    fromForge: false,
    data: null, // GET /api/cards/:id/check
    models: [],
    defaultModel: '',
    ticked: new Set(), // findings 一键采用 takes in
    seen: new Set(), // findings already given their first tick
    opened: new Set(), // findings shown open
    editing: new Map(), // finding id → { change id: what was written over it }
    tuning: null, // 调整状态栏 open: what statusEditor keeps, { spec, paged }
    stale: false, // something taken in reached the prefix; the open chat on this card has not applied it
    poll: null,
    busy: false,
    pending: '', // 'check' or 'check-trial' from the click till the server says the model has it
    loading: null, // the timer of 正在检查 while the first read is on its way
    whole: false, // 全本检查 ticked: the entries the ask leaves out go after it, in batches
    shown: '', // what the list last showed: a poll with nothing new leaves it, and any box being typed in, alone
  }
  const url = (path = '') => `/api/cards/${state.cardId}/check${path}`

  function layout() {
    view.sub = el('span', { class: 'forge-sub' })
    view.main = el('div', { class: 'forge-main cc-main' })
    view.take = el('button', { type: 'button', class: 'btn primary', onclick: () => takeTicked() })
    view.all = el('button', { type: 'button', class: 'btn ghost small', onclick: () => tickAll() })
    view.footNote = el('span', { class: 'hint cc-foot-note' })
    view.foot = el('div', { class: 'forge-foot' }, [el('div', { class: 'forge-actions' }, [view.footNote, el('span', { class: 'grow' }), view.all, view.take])])
    dialog.replaceChildren(
      el('div', { class: 'forge cc' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: t`检查这张卡` }), view.sub]),
          el('div', { class: 'forge-tools' }, [el('button', { type: 'button', class: 'btn ghost icon', title: t`关闭`, 'aria-label': t`关闭`, html: ICON_CLOSE, onclick: () => dialog.close() })]),
        ]),
        view.main,
        view.foot,
      ]),
    )
  }

  // ─── Data ─────────────────────────────────────────────────────────────
  const takeable = item => item.changes.length > 0 && !item.manual && !item.stale && !item.broken?.length

  function load(data) {
    stopLoading()
    state.data = data
    const key = JSON.stringify({ ...data, job: Boolean(data.job) })
    if (key === state.shown) {
      fillJob()
      schedule()
      return
    }
    state.shown = key
    for (const item of data.findings) {
      if (state.seen.has(item.id)) continue
      state.seen.add(item.id)
      if (takeable(item) && !item.risky) state.ticked.add(item.id)
      if (data.findings.length <= FOLD_OVER) state.opened.add(item.id)
    }
    const open = new Set(data.findings.map(item => item.id))
    for (const id of state.ticked) if (!open.has(id) || !takeable(data.findings.find(item => item.id === id))) state.ticked.delete(id)
    // One that comes back after an undo starts over.
    for (const id of state.seen) if (!open.has(id)) state.seen.delete(id)
    view.sub.textContent = data.name
    render()
    schedule()
  }

  function schedule() {
    clearTimeout(state.poll)
    if (!state.data?.job || !dialog.open) return
    const cardId = state.cardId
    state.poll = setTimeout(async () => {
      try {
        const data = await api(url())
        if (state.cardId === cardId) load(data)
      } catch {
        schedule()
      }
    }, 1200)
  }

  async function loadModels() {
    const data = await api('/api/models').catch(() => ({ choices: [], defaultModel: '' }))
    state.models = data.choices.filter(model => model.id.includes('/'))
    state.defaultModel = data.defaultModel || ''
  }

  // ─── The page ─────────────────────────────────────────────────────────
  /**
   * The window, before the card's first read is back: a card with big variable rules takes seconds, and the click
   * should show it was heard. The seconds show once it is long enough to wonder.
   */
  function showLoading() {
    stopLoading()
    state.shown = ''
    view.jobLine = null
    const line = el('span', { text: t`正在检查这张卡…` })
    const started = Date.now()
    state.loading = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000)
      if (seconds >= 2) line.textContent = t`正在检查这张卡，已经 ${seconds} 秒。变量规则大的卡要多等一会儿。`
    }, 1000)
    view.main.replaceChildren(el('div', { class: 'cc-page cc-loading', role: 'status' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), line])]))
    view.foot.hidden = true
  }

  function stopLoading() {
    clearInterval(state.loading)
    state.loading = null
  }

  /** Sent to the model: said at once, while the server gets the card ready, till the answer says the model has it. */
  function sending() {
    return el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: t`正在发给模型…` })])])
  }

  async function asking(kind, send) {
    state.pending = kind
    render()
    try {
      const data = await send()
      state.pending = ''
      state.shown = ''
      load(data)
    } catch (error) {
      state.pending = ''
      render()
      throw error
    }
  }

  function render() {
    const top = view.main.scrollTop
    const { findings, records, ignored } = state.data
    view.jobLine = null
    view.main.replaceChildren(
      el('div', { class: 'cc-page' }, [
        prefixBar(),
        summary(),
        tunePanel(),
        ...LEVELS.map(([level, title, note]) => group(level, title, note, findings.filter(item => item.from === 'program' && item.level === level))),
        trialSection(findings.filter(item => item.from === 'trial'), findings.filter(item => item.from === 'model' && item.trial)),
        brickSection(findings.filter(item => item.from === 'model' && item.brick)),
        interviewSection(findings.filter(item => item.from === 'model' && item.interview)),
        modelSection(findings.filter(item => item.from === 'model' && !item.trial && !item.brick && !item.interview)),
        records.length ? takenSection(records) : null,
        ignored.length ? ignoredSection(ignored) : null,
      ]),
    )
    view.main.scrollTop = top
    updateFoot()
  }

  function prefixBar() {
    if (!state.stale || getChat()?.cardId !== state.cardId) return null
    return el('div', { class: 'preset-apply cc-apply' }, [
      el('span', { text: t`当前对话的固定前缀还是改动前的版本。应用后，下一轮会重新写入一次缓存。` }),
      el('button', { class: 'btn small primary', type: 'button', disabled: isGenerating(), text: t`应用到当前对话`, onclick: guard(applyToChat) }),
    ])
  }

  async function applyToChat() {
    const chat = getChat()
    if (!chat || chat.cardId !== state.cardId) return
    onChatChanged(await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} }))
    state.stale = false
    render()
    toast(t`已重建固定前缀，下一轮生效`)
  }

  function verdict(all) {
    const findings = all.filter(item => item.from === 'program')
    const by = level => findings.filter(item => item.level === level).length
    if (by('error')) return t`有 ${by('error')} 处写错了，还有 ${by('warn') + by('tip')} 处可以看看`
    if (by('warn')) return t`没有写错的地方，有 ${by('warn')} 处可能有问题`
    if (by('tip')) return t`格式没有问题，有 ${by('tip')} 处可以更好`
    return t`格式没有问题`
  }

  function summary() {
    const { facts, findings } = state.data
    const line = [
      facts.entries ? t`世界书 ${facts.entries} 条（启用 ${facts.enabled}）` : t`没有世界书`,
      facts.constantChars ? t`常驻约 ${count(facts.constantChars)} 字（约 ${count(facts.constantTokens)} token）` : '',
      facts.variables ? t`变量 ${facts.variables} 个` : '',
      facts.scripts ? t`正则 ${facts.scripts} 条` : '',
      t`开场白 ${facts.greetings} 段`,
      // A server not yet restarted sends none (web/ is read live).
      facts.bricks?.length ? t`玩法积木：${facts.bricks.map(brick => BRICK_TEXT[brick]).join(t`、`)}` : '',
    ].filter(Boolean).join(t` · `)
    const notes = [
      facts.helperScripts && !facts.helperList?.length ? t`这张卡带了 ${facts.helperScripts} 个酒馆助手脚本，这里不运行。读不到它们各是什么：卡图换过，或者是早先用 JSON 导入的。` : '',
      facts.schema ? t`变量规则由卡里的脚本决定，自检不判断变量有没有写漏。` : '',
      state.data.ownBar ? t`这张卡的状态栏是它自己的正则或脚本画的，这里调不了样式。` : '',
      facts.attachedBooks ? t`另外挂了 ${facts.attachedBooks} 本独立世界书，这里只查卡自带的。` : '',
      facts.remote.length ? t`美化要联网加载：${facts.remote.slice(0, 3).join(t`、`)}${facts.remote.length > 3 ? t` 等 ${facts.remote.length} 处` : ''}。` : '',
      state.fromForge ? t`这张卡是「创作角色卡」做的：在那边再点「更新这张卡」，会换回草稿里的内容，这里的修改不保留。` : '',
    ].filter(Boolean)
    return el('section', { class: 'cc-summary' }, [
      el('h3', { text: verdict(findings) }),
      el('p', { class: 'cc-facts', text: line }),
      helperList(facts.helperList),
      ...notes.map(text => el('p', { class: 'hint', text })),
      state.data.statusTune && !state.tuning
        ? el('div', { class: 'cc-actions' }, [el('button', { type: 'button', class: 'btn small', text: t`调整状态栏`, title: t`直接改状态栏的主题、颜色和显示的内容，不用模型`, onclick: () => { state.tuning = {}; render() } })])
        : null,
    ].filter(Boolean))
  }

  /** 调整状态栏: the bar's editor on its own, whether or not anything was found about it. */
  function tunePanel() {
    const tune = state.data.statusTune
    if (!state.tuning || !tune) return null
    const [change] = tune.changes
    return el('section', { class: 'plan-card cc-tune' }, [
      el('header', {}, [el('h4', { text: t`调整状态栏` })]),
      el('p', { class: 'hint', text: change.before ? t`只改显示，不动变量，也不发给模型。保存后这张卡的对话都按新样式显示。` : t`这张卡还没有自己的状态栏，这是按变量排的一个。保存后它跟着卡走，导出到 SillyTavern 也在。` }),
      el('div', { class: 'cc-change' }, statusEditor(el, change, state.tuning, { spare: tune.fields, state: state.data.state, redraw: render, design: { api, cardId: state.cardId, cover: state.data.cover ? { name: state.data.name ?? '', cover: state.data.cover } : null }, tryKey: state.cardId })),
      el('div', { class: 'cc-actions' }, [
        el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { state.tuning = null; render() } }),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn primary small', disabled: Boolean(state.data.job), title: state.data.job ? t`模型还在看这张卡，等它看完或先停下` : '', text: t`保存`, onclick: () => take([{ id: tune.id, edits: { [change.id]: { spec: state.tuning.spec } } }], t`状态栏已保存`) }),
      ]),
    ])
  }

  /** 酒馆助手脚本: each one and what its absence means; those something is missing for can be taken to 对话修改. */
  function helperList(scripts) {
    if (!scripts?.length) return null
    const tally = Object.keys(HELPER_EFFECT).map(effect => [effect, scripts.filter(script => script.effect === effect).length]).filter(([, n]) => n)
    const redo = script => {
      const words = t`「${script.name}」这个酒馆助手脚本在这里有些功能用不了。看看它做什么，用世界书、变量或开场白做出差不多的效果。`
      dialog.close()
      openTalk(state.cardId, words)
    }
    const rows = scripts.map(script => el('li', { class: `cc-helper ${script.effect}` }, [
      el('div', { class: 'cc-helper-head' }, [
        el('b', { text: script.name || t`没有名字的脚本` }),
        el('span', { class: 'cc-helper-tag', text: HELPER_EFFECT[script.effect] }),
        script.on && script.kind === 'custom' && script.effect !== 'none' ? el('button', { type: 'button', class: 'btn ghost small', text: t`用对话重做`, title: t`到「对话修改」里，让向导用世界书、变量和开场白做差不多的效果`, onclick: () => redo(script) }) : null,
      ].filter(Boolean)),
      el('p', { class: 'hint', text: helperWords(script) }),
      script.about ? el('p', { class: 'hint', text: t`作者说明：${script.about}` }) : null,
    ].filter(Boolean)))
    // A script run here that calls the model does so only once the player says so (server/card-scripts.mjs).
    const callsModel = scripts.some(script => script.on && script.kind === 'hooks' && script.uses.includes('model'))
    return el('details', { class: 'cc-helpers', open: tally.some(([effect]) => effect !== 'none') || callsModel }, [
      el('summary', { text: t`酒馆助手脚本 ${scripts.length} 个：${tally.map(([effect, n]) => `${HELPER_EFFECT[effect]} ${n}`).join(t`，`)}` }),
      el('ul', {}, rows),
      callsModel ? modelPermit() : null,
      el('p', { class: 'hint', text: t`跟着变量的脚本在服务器上运行，其余的打开对话时在页面上运行；脚本本身改不了。用不了的部分可以用「对话修改」做差不多的效果。` }),
    ].filter(Boolean))
  }

  /** Whether this card's scripts may call the model themselves, as the player sets it. */
  function modelPermit() {
    const box = el('input', { type: 'checkbox', disabled: true })
    const url = `/api/cards/${state.cardId}/script-permissions`
    api(url).then(permissions => {
      box.checked = permissions.model
      box.disabled = false
    }).catch(() => {})
    box.addEventListener('change', () => {
      const wanted = box.checked
      api(url, { method: 'PUT', body: { model: wanted } }).then(permissions => { box.checked = permissions.model }).catch(error => {
        box.checked = !wanted
        toast(error.message, 6000)
      })
    })
    return el('label', { class: 'cc-permit' }, [box, el('span', { text: t`允许这张卡的脚本自己调用模型（每次按一次对话计费，每分钟最多 6 次）` })])
  }

  function group(level, title, note, items) {
    if (!items.length) return null
    const shown = items.filter(takeable)
    const allOn = shown.length > 0 && shown.every(item => state.ticked.has(item.id))
    return el('section', { class: `plan-card cc-group ${level}` }, [
      el('header', {}, [
        el('h4', { text: t`${title} · ${items.length}` }),
        shown.length > 1 ? el('button', { type: 'button', class: 'btn ghost small', text: allOn ? t`这组都不勾` : t`这组都勾上`, onclick: () => tickGroup(shown, !allOn) }) : null,
      ]),
      el('p', { class: 'hint', text: note }),
      el('div', { class: 'cc-items' }, items.map(item => itemBlock(item))),
    ])
  }

  function changeLabel(change) {
    if (change.kind === 'field') return t`字段`
    if (change.kind === 'greeting') return t`开场白 ${change.index + 1}`
    if (change.kind === 'entry') return t`条目「${change.name ?? change.title ?? change.uid}」`
    if (change.kind === 'newEntry') return t`新条目「${change.name}」`
    if (change.kind === 'removeEntry') return t`删除条目「${change.title || change.uid}」`
    if (change.kind === 'regex') return t`正则「${change.title}」`
    if (change.kind === 'newRegex') return t`新正则「${change.name}」`
    if (change.kind === 'removeRegex') return t`删除正则「${change.title}」`
    return t`状态栏`
  }

  function changeNotes(change) {
    const notes = []
    if (change.keys) notes.push(change.keysNow ? t`关键词` : t`关键词：${change.keys.join(t`、`) || t`（无）`}`)
    if (change.mode) notes.push(change.mode === 'constant' ? t`改成常驻` : t`改成关键词触发`)
    if (change.enabled !== undefined) notes.push(change.enabled ? t`打开这一条` : t`关掉这一条`)
    if (change.kind === 'newEntry') notes.push(change.late ? t`每轮都发：跟在每一轮的消息后面` : change.constant ? t`常驻：写进对话开局时的固定前缀` : t`关键词触发`)
    if (change.minDepth !== undefined) notes.push(t`从深度 ${change.minDepth} 起才生效`)
    if (change.world) notes.push(t`作用于世界书条目`)
    return notes
  }

  /** A change as before and after. */
  function changeBlock(change) {
    const regex = change.kind === 'regex' || change.kind === 'newRegex' || change.kind === 'removeRegex'
    const diffs = regex
      ? [
          (change.findBefore ?? '') !== (change.findAfter ?? change.find ?? '') ? diffView(el, change.findBefore ?? '', change.findAfter ?? change.find ?? '') : null,
          (change.replaceBefore ?? '') !== (change.replaceAfter ?? change.replace ?? '') ? diffView(el, change.replaceBefore ?? '', change.replaceAfter ?? change.replace ?? '') : null,
        ]
      : [(/^new/.test(change.kind) ? '' : change.before ?? '') === (/^remove/.test(change.kind) ? '' : change.after ?? '') ? null : diffView(el, /^new/.test(change.kind) ? '' : change.before ?? '', /^remove/.test(change.kind) ? '' : change.after ?? '')]
    const keys = change.keys && change.keysNow ? diffView(el, change.keysNow.join(t`、`), change.keys.join(t`、`)) : null
    return el('div', { class: 'cc-change' }, [
      el('p', { class: 'ce-change-note', text: [changeLabel(change), ...changeNotes(change)].join(t`；`) }),
      keys,
      ...diffs,
    ])
  }

  function itemBlock(item) {
    const open = state.opened.has(item.id)
    const canTake = takeable(item)
    const editing = state.editing.has(item.id)
    const toggle = () => {
      open ? state.opened.delete(item.id) : state.opened.add(item.id)
      render()
    }
    const head = el('div', { class: 'ce-change-head' }, [
      canTake
        ? el('input', { type: 'checkbox', checked: state.ticked.has(item.id), 'aria-label': t`采用「${item.title}」`, onchange: event => { event.target.checked ? state.ticked.add(item.id) : state.ticked.delete(item.id); updateFoot() } })
        : el('span', { class: 'ce-mark', text: '–' }),
      el('button', { type: 'button', class: 'ce-change-title', 'aria-expanded': String(open), onclick: toggle, text: item.title }),
      item.from === 'trial' ? el('span', { class: 'strategy key', text: item.round ? t`试玩 · 第 ${item.round} 回合 · ${KIND_TEXT[item.kind] ?? item.kind}` : t`试玩` }) : null,
      item.outdated ? el('span', { class: 'strategy off', title: state.data.trial?.dated === false ? t`这份试玩报告是旧版本做的，看不出之后卡改过没有。这条可能已经改好，再试玩一次可以确认。` : t`试玩之后卡改过了，这条可能已经改好，再试玩一次可以确认。`, text: t`可能已过期` }) : null,
      item.from === 'model' ? el('span', { class: 'strategy key', text: t`模型` }) : null,
      item.risky && canTake ? el('span', { class: 'strategy off', title: t`这条会改变卡的玩法，看过再勾`, text: t`看过再勾` }) : null,
    ])
    if (!open) return el('div', { class: 'ce-change folded cc-item' }, [head])
    const warnings = [
      item.stale ? t`卡里这段内容已经变了，这条建议对不上了。` : '',
      item.broken?.length ? t`这条会弄坏格式，不能采用：${item.broken.join(t`；`)}` : '',
      item.missed ? t`有 ${item.missed} 处改动在原文里没找到，没有列出来。` : '',
    ].filter(Boolean)
    return el('div', { class: 'ce-change cc-item' }, [
      head,
      item.why ? el('p', { class: 'cc-why', text: item.why }) : null,
      item.quote ? el('blockquote', { class: 'cc-quote', text: item.quote }) : null,
      item.fix ? el('p', { class: 'cc-why', text: t`审读的改法：${item.fix}` }) : null,
      ...warnings.map(text => el('p', { class: 'ce-outcome warn', text })),
      ...(editing ? editBlocks(item) : item.manual ? [] : item.changes.map(changeBlock)),
      itemActions(item, canTake, editing),
    ])
  }

  function itemActions(item, canTake, editing) {
    if (item.from === 'trial') return trialActions(item)
    const canEdit = item.changes.length > 0 && !item.stale && item.changes.some(change => !/^remove/.test(change.kind))
    if (editing) {
      return el('div', { class: 'cc-actions' }, [
        el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { state.editing.delete(item.id); render() } }),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn primary small', text: t`采用改好的`, onclick: () => take([{ id: item.id, edits: state.editing.get(item.id) }]) }),
      ])
    }
    return el('div', { class: 'cc-actions' }, [
      el('button', { type: 'button', class: 'btn ghost small', text: t`忽略`, title: t`以后不再提这一条，可以在最下面恢复`, onclick: () => setIgnored(item, true) }),
      el('span', { class: 'grow' }),
      canEdit ? el('button', { type: 'button', class: 'btn small', text: item.manual ? t`手动改` : t`改一下`, onclick: () => { state.editing.set(item.id, {}); render() } }) : null,
      canTake ? el('button', { type: 'button', class: 'btn primary small', text: t`采用`, onclick: () => take([{ id: item.id }]) }) : null,
    ])
  }

  // ─── Writing over a change ────────────────────────────────────────────
  function editBlocks(item) {
    const edits = state.editing.get(item.id)
    const edit = change => (edits[change.id] ??= {})
    return item.changes.filter(change => !/^remove/.test(change.kind)).map(change => el('div', { class: 'cc-change' }, [
      el('p', { class: 'ce-change-note', text: changeLabel(change) }),
      ...(change.kind === 'statusBar' ? statusEditor(el, change, edit(change), { state: state.data.state, redraw: render }) : change.kind === 'regex' || change.kind === 'newRegex' ? regexEditor(change, edit(change)) : textEditor(item, change, edit(change))),
    ]))
  }

  function textBox(value, label, write) {
    const area = el('textarea', { class: 'ce-text', rows: String(Math.min(14, Math.max(3, String(value).split('\n').length + 1))), spellcheck: 'false', 'aria-label': label, oninput: () => write(area.value) })
    area.value = value
    return area
  }

  function textEditor(item, change, edit) {
    const entryLike = change.kind === 'entry' || change.kind === 'newEntry'
    const keysOnly = KEY_RULES.has(item.rule) || (change.kind === 'entry' && change.after === change.before && !item.manual)
    const keys = el('input', { value: edit.keys ?? (change.keys ?? change.keysNow ?? []).join(', '), placeholder: t`关键词，用逗号分开`, 'aria-label': t`关键词`, oninput: () => { edit.keys = keys.value } })
    return [
      entryLike && (keysOnly || change.keys || change.kind === 'newEntry') ? keys : null,
      keysOnly ? null : textBox(edit.after ?? change.after ?? '', t`改好的内容`, value => { edit.after = value }),
    ]
  }

  function regexEditor(change, edit) {
    const find = change.findAfter ?? change.find ?? ''
    const replace = change.replaceAfter ?? change.replace ?? ''
    return [
      el('label', { class: 'cc-label', text: t`查找` }),
      textBox(edit.find ?? find, t`查找`, value => { edit.find = value }),
      replace.length <= MAX_EDIT ? el('label', { class: 'cc-label', text: t`替换成` }) : null,
      replace.length <= MAX_EDIT ? textBox(edit.replace ?? replace, t`替换成`, value => { edit.replace = value }) : el('p', { class: 'hint', text: t`替换内容太长（${count(replace.length)} 字），这里不改。` }),
    ]
  }

  // ─── What a trial found ───────────────────────────────────────────────
  /** A trial's problem in words for 对话修改, with where it showed and what the reader would change. */
  function trialWords(item) {
    const where = item.round ? t`第 ${item.round} 回合 · ${KIND_TEXT[item.kind] ?? item.kind}：` : ''
    const quote = item.quote ? t`（原文：${item.quote}）` : ''
    const fix = item.fix ? t`审读的改法：${item.fix}。` : ''
    return t`试玩体检查出这个问题：${where}${item.title}${quote}。${fix}改这张卡来解决它，改之前先给我看改前改后。`
  }

  function trialActions(item) {
    const estimate = state.data.trial?.estimate
    const job = state.data.job
    return el('div', { class: 'cc-actions' }, [
      el('button', { type: 'button', class: 'btn ghost small', text: t`忽略`, title: t`以后不再提这一条，可以在最下面恢复`, onclick: () => setIgnored(item, true) }),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'btn small', text: t`用对话改`, title: t`到「对话修改」里，带着这个问题让向导改`, onclick: () => {
        dialog.close()
        openTalk(state.cardId, trialWords(item))
      } }),
      estimate ? el('button', { type: 'button', class: 'btn primary small', disabled: !estimate.ready || Boolean(job), title: job ? t`模型还在看这张卡，等它看完或先停下` : '', text: t`让模型出改法`, onclick: () => askTrial([item.id]) }) : null,
    ].filter(Boolean))
  }

  /** The problems, each followed by the changes the model gave for it; changes for no problem still shown come last. */
  function trialSection(items, fixes) {
    const trial = state.data.trial
    if (!items.length && !fixes.length) return null
    const job = state.data.job
    const estimate = trial?.estimate
    const shown = new Set()
    const blocks = items.flatMap(item => {
      const mine = fixes.filter(fix => fix.answers?.includes(item.id))
      for (const fix of mine) shown.add(fix.id)
      return [itemBlock(item), ...mine.map(fix => el('div', { class: 'cc-trial-fix' }, [itemBlock(fix)]))]
    })
    const rest = fixes.filter(fix => !shown.has(fix.id))
    const takeableFixes = fixes.filter(takeable)
    return el('section', { class: 'plan-card cc-model cc-trial' }, [
      el('header', {}, [
        el('h4', { text: t`试玩发现 · ${items.length}` }),
        takeableFixes.length > 1 ? el('button', { type: 'button', class: 'btn ghost small', text: t`改法都勾上`, onclick: () => tickGroup(takeableFixes, true) }) : null,
        openTrial ? el('button', { type: 'button', class: 'btn ghost small', text: t`再试玩一次`, onclick: () => { dialog.close(); openTrial(state.cardId) } }) : null,
      ].filter(Boolean)),
      el('p', { class: 'hint', text: trial ? t`最近一次试玩体检（${trial.model}，${new Date(trial.at).toLocaleString()}）查出的问题。程序没有现成的改法：可以让模型出改法，看过改前改后再采用；也可以用对话自己改，不用改的就忽略。` : t`这些是给试玩问题出的改法，那份报告已经换掉了。` }),
      trial?.outdated ? el('p', { class: 'ce-outcome warn', text: trial.dated === false ? t`这份试玩报告是旧版本做的，看不出之后卡改过没有。下面的问题可能已经改好，再试玩一次可以确认。` : t`试玩之后卡改过了，下面的问题可能已经改好，再试玩一次可以确认。` }) : null,
      estimate ? el('p', { class: 'cc-estimate', text: estimateLine({ estimate }, true) }) : null,
      state.pending === 'check-trial'
        ? sending()
        : job?.kind === 'check-trial'
        ? el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), (view.jobLine = el('span', { text: jobText(job) }))]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })])
        : items.length > 1 && estimate
          ? el('div', { class: 'cc-send' }, [el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn small', disabled: !estimate.ready || Boolean(job) || Boolean(state.pending), text: t`${items.length} 条都让模型出改法`, onclick: () => askTrial(items.map(item => item.id)) })])
          : null,
      state.data.error?.kind === 'check-trial' && !state.pending ? el('div', { class: 'forge-error' }, [el('p', { text: state.data.error.message })]) : null,
      trial?.reply ? el('div', { class: 'forge-voice cc-reply' }, trial.reply.split(/\n+/).filter(Boolean).map(text => el('p', { text }))) : null,
      trial?.askedModel ? el('div', { class: 'forge-by', text: trial.askedModel }) : null,
      el('div', { class: 'cc-items' }, [...blocks, ...rest.map(itemBlock)]),
    ].filter(Boolean))
  }

  const askTrial = guard(async ids => {
    const replacing = state.data.findings.some(item => item.trial && (!item.answers?.length || item.answers.some(id => ids.includes(id))))
    if (replacing && !confirm(t`再出一次改法会换掉这些问题还没采用的改法，继续？`)) return
    await asking('check-trial', () => api(url('/ask'), { method: 'POST', body: { trial: ids } }))
  })

  // ─── The model ────────────────────────────────────────────────────────
  function modelChoice() {
    const { model } = state.data
    const known = state.models.find(item => item.id === state.defaultModel)
    const label = item => `${item.group} · ${item.label}`
    const select = el('select', { class: 'forge-model', title: t`让哪个模型看`, disabled: Boolean(state.data.job) || Boolean(state.pending), onchange: guard(async () => {
      if (select.value === MANAGE_PROVIDERS || select.value === TOOL_PROMPTS) {
        const asked = select.value
        select.value = model
        if (asked === MANAGE_PROVIDERS) openProviders?.()
        else openToolPrompts?.('check')
        return
      }
      load(await api(url(), { method: 'PUT', body: { model: select.value } }))
    }) }, [
      el('option', { value: '', selected: !model, text: known ? t`默认模型（${label(known)}）` : t`默认模型（还没选）` }),
      ...state.models.map(item => el('option', { value: item.id, selected: item.id === model, text: label(item) })),
      el('option', { value: MANAGE_PROVIDERS, text: t`管理模型供应商…` }),
      openToolPrompts ? el('option', { value: TOOL_PROMPTS, text: t`附加提示词…` }) : null,
    ].filter(Boolean))
    return select
  }

  /** @param trial - for the trial's problems: each click sends once, the problems along with the card. */
  function estimateLine({ estimate }, trial = false) {
    if (!estimate.ready) return t`先在「模型供应商」里添加供应商，再选一个模型。`
    const money = estimate.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    const whole = estimate.shown < estimate.entries ? t`世界书只附上 ${estimate.shown} 条全文，其余 ${estimate.entries - estimate.shown} 条给目录。` : ''
    if (trial) return t`点了才发送，点一次发一次。发给 ${estimate.model}：卡的内容约 ${count(estimate.chars)} 字加上这些问题，一共大约 ${count(estimate.input + estimate.output)} token${money}。${whole}`
    const rest = estimate.rest && state.whole ? estimate.rest : null
    if (rest) {
      const restMoney = rest.cost == null ? '' : t`，大约 $${rest.cost.toFixed(3)}`
      const both = estimate.cost == null || rest.cost == null ? '' : t`两项合计大约 $${(estimate.cost + rest.cost).toFixed(3)}。`
      return t`点了才发送。发给 ${estimate.model}：先看整张卡，大约 ${count(estimate.input + estimate.output)} token${money}；再分 ${rest.parts} 批看其余 ${rest.entries} 条，大约 ${count(rest.input + rest.output)} token${restMoney}。${both}`
    }
    return t`点了才发送。发给 ${estimate.model}：卡的内容约 ${count(estimate.chars)} 字，一共大约 ${count(estimate.input + estimate.output)} token${money}。${whole}`
  }

  /** 全本检查: only for a card the ask does not read whole; ticked, the button sends the batches after it. */
  function wholeChoice(rest, job) {
    if (!rest) return null
    const notes = [
      rest.long ? t`有 ${rest.long} 条单条超过 2 万字，不附上。` : '',
      rest.left ? t`最多分 ${rest.parts} 批，还有 ${rest.left} 条排不进。` : '',
    ].join('')
    return el('label', { class: 'check-row cc-focus cc-whole' }, [
      el('input', { type: 'checkbox', checked: state.whole, disabled: Boolean(job) || Boolean(state.pending), onchange: event => { state.whole = event.target.checked; render() } }),
      el('span', { text: t`全本检查` }),
      el('small', { text: t`其余 ${rest.entries} 条分 ${rest.parts} 批再发给模型，每批带上规则、变量和目录。花得多，默认不勾。${notes}` }),
    ])
  }

  /** How far the last 全本检查 got. */
  function wholeLine(whole, job) {
    if (!whole || job?.kind === 'check') return null
    const stopped = whole.done < whole.total ? t`中途停下了，看完的几批的建议都留着。` : ''
    return el('p', { class: 'hint cc-whole-done', text: t`全本检查：其余 ${whole.entries} 条分 ${whole.total} 批，看完了 ${whole.done} 批。${stopped}` })
  }

  function modelSection(items) {
    const data = state.data
    const job = data.job
    const boxes = FOCUS.map(([key, label, note]) => el('label', { class: 'check-row cc-focus', title: note }, [
      el('input', { type: 'checkbox', checked: data.focus.includes(key), disabled: Boolean(job) || Boolean(state.pending), onchange: guard(async event => {
        const focus = FOCUS.map(([name]) => name).filter(name => (name === key ? event.target.checked : data.focus.includes(name)))
        load(await api(url(), { method: 'PUT', body: { focus } }))
      }) }),
      el('span', { text: label }),
      el('small', { text: note }),
    ]))
    return el('section', { class: 'plan-card cc-model' }, [
      el('header', {}, [
        el('h4', { text: items.length ? t`让模型再看看 · ${items.length} 条建议` : t`让模型再看看` }),
        items.filter(takeable).length > 1 ? el('button', { type: 'button', class: 'btn ghost small', text: t`这组都勾上`, onclick: () => tickGroup(items.filter(takeable), true) }) : null,
      ]),
      el('p', { class: 'hint', text: t`程序查的是写法，模型看的是内容：哪些常驻可以改关键词、规则有没有打架、状态栏怎么排更好。模型的建议都要你看过再采用。` }),
      el('div', { class: 'cc-focus-list' }, boxes),
      wholeChoice(data.estimate.rest, job),
      el('p', { class: 'cc-estimate', text: estimateLine(data) }),
      state.pending === 'check'
        ? sending()
        : job && job.kind === 'check'
        ? el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), (view.jobLine = el('span', { text: jobText(job) }))]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })])
        : el('div', { class: 'cc-send' }, [modelChoice(), el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn primary small', disabled: !data.estimate.ready || Boolean(job), text: data.askedAt ? t`再看一次` : t`发给模型看看`, onclick: () => ask() })]),
      data.error && data.error.kind === 'check' && !state.pending ? el('div', { class: 'forge-error' }, [el('p', { text: data.error.message })]) : null,
      data.reply ? el('div', { class: 'forge-voice cc-reply' }, data.reply.split(/\n+/).filter(Boolean).map(text => el('p', { text }))) : null,
      data.askedModel ? el('div', { class: 'forge-by', text: data.askedModel }) : null,
      wholeLine(data.whole, job),
      items.length ? el('div', { class: 'cc-items' }, items.map(item => itemBlock(item))) : null,
    ])
  }

  // ─── 加玩法积木 ─────────────────────────────────────────────────────────
  // What 创作角色卡 can give a new card, for a card that is already there: the code writes the rule and the regex, a
  // model fills in what is this card's own (server/forge/brick-add.mjs). What it fills in is listed here to take in.
  const BRICK_NOTE = {
    selfcheck: t`模型每次写之前，先过一遍这张卡最容易写崩的几处；这段玩家看不到`,
    events: t`程序每轮抽一次，抽中了就发生：碰到的人、日常小事、远处的消息`,
    judge: t`用等级决定成败，不让模型放水。开着游戏规则的卡不用加`,
  }

  function brickSection(items) {
    const add = state.data.brickAdd
    // A server not yet restarted sends none (web/ is read live).
    if (!add || (!add.open.length && !items.length)) return null
    const { job, error } = state.data
    const busy = Boolean(job) || Boolean(state.pending)
    const { estimate } = add
    const wish = el('input', { type: 'text', class: 'cc-brick-wish', maxlength: 400, disabled: busy, placeholder: t`对要加的玩法有什么想法，可以不写。比如：多一些深夜来的怪客人`, 'aria-label': t`对要加的玩法的想法`, oninput: () => { state.brickWish = wish.value } })
    wish.value = state.brickWish ?? ''
    const money = estimate?.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    const note = !estimate ? '' : estimate.ready ? t`点了才发送，一次填一块。发给 ${estimate.model}，大约 ${count(estimate.input + estimate.output)} token${money}。填好的先列在下面，看过再采用。` : t`先在「模型供应商」里添加供应商，再选一个模型。`
    return el('section', { class: 'plan-card cc-model cc-bricks' }, [
      el('header', {}, [el('h4', { text: t`加玩法积木` })]),
      el('p', { class: 'hint', text: t`给这张卡加现成的玩法，导入的卡也能加。规则条目和正则由程序写好，模型只按这张卡填内容；采用后可以在「已采用」里撤销。` }),
      ...add.open.map(brick => el('div', { class: 'cc-brick-row' }, [
        el('b', { text: BRICK_TEXT[brick] }),
        el('span', { class: 'hint', text: BRICK_NOTE[brick] }),
        el('button', { type: 'button', class: 'btn small', disabled: busy || !estimate?.ready, title: job ? t`模型还在看这张卡，等它看完或先停下` : '', text: t`让模型填`, onclick: () => askBrick(brick) }),
      ])),
      add.open.length ? wish : null,
      add.open.length && note ? el('p', { class: 'cc-estimate', text: note }) : null,
      state.pending === 'check-brick'
        ? sending()
        : job?.kind === 'check-brick'
          ? el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: job.chars ? t`模型正在写，已经写了 ${count(job.chars)} 字…` : t`模型正在读这张卡…` })]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })])
          : null,
      error?.kind === 'check-brick' && !state.pending ? el('div', { class: 'forge-error' }, [el('p', { text: error.message })]) : null,
      items.length ? el('div', { class: 'cc-items' }, items.map(item => itemBlock(item))) : null,
      el('p', { class: 'hint', text: t`世界动态、日程、关系网、路线与结局、背包和册子、建角页要用到变量，只能在「创作角色卡」做新卡时选。` }),
    ].filter(Boolean))
  }

  const askBrick = guard(async brick => {
    await asking('check-brick', () => api(url('/brick'), { method: 'POST', body: { brick, wish: state.brickWish ?? '' } }))
  })

  // ─── 角色采访 ─────────────────────────────────────────────────────────
  // The moments an example can show (server/forge/interview.mjs SCENES); the first four are picked to start with.
  const SCENE_TEXT = [['daily', t`平常搭话`], ['tease', t`被打趣`], ['refuse', t`不肯做的事`], ['soft', t`示弱或关心人`], ['upset', t`被惹恼`], ['secret', t`不想说的事`], ['craft', t`做拿手的事`], ['quiet', t`话很少的时候`]]

  /** 角色采访: a model writes the character into a few moments, as examples for 对话示例. */
  function interviewSection(items) {
    const talk = state.data.interview
    // A server not yet restarted sends none (web/ is read live).
    if (!talk) return null
    const { job, error } = state.data
    const busy = Boolean(job) || Boolean(state.pending)
    const { estimate } = talk
    state.scenes ??= new Set(SCENE_TEXT.slice(0, 4).map(([id]) => id))
    const go = el('button', { type: 'button', class: 'btn small', disabled: busy || !estimate.ready || !state.scenes.size, title: job ? t`模型还在看这张卡，等它看完或先停下` : '', text: t`让模型写`, onclick: () => askInterview() })
    const chips = SCENE_TEXT.map(([id, text]) => {
      const chip = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.scenes.has(id)), disabled: busy, text, onclick: () => {
        state.scenes.has(id) ? state.scenes.delete(id) : state.scenes.add(id)
        chip.setAttribute('aria-pressed', String(state.scenes.has(id)))
        go.disabled = busy || !estimate.ready || !state.scenes.size
      } })
      return chip
    })
    const wish = el('input', { type: 'text', class: 'cc-brick-wish', maxlength: 400, disabled: busy, placeholder: t`对示例有什么想法，可以不写。比如：她生气的时候不骂人，只是不说话`, 'aria-label': t`对示例的想法`, oninput: () => { state.interviewWish = wish.value } })
    wish.value = state.interviewWish ?? ''
    const money = estimate.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    const note = estimate.ready ? t`点了才发送。发给 ${estimate.model}，大约 ${count(estimate.input + estimate.output)} token${money}。写好的先列在下面，看过再采用。` : t`先在「模型供应商」里添加供应商，再选一个模型。`
    return el('section', { class: 'plan-card cc-model cc-interview' }, [
      el('header', {}, [el('h4', { text: t`角色采访：写对话示例` })]),
      el('p', { class: 'hint', text: talk.has
        ? t`把这张卡的角色放进几个场合，让模型写出他会怎么说、怎么做，接在已有的对话示例后面。模型扮演时照示例学他的声口。`
        : t`这张卡还没有对话示例。把角色放进几个场合，让模型写出他会怎么说、怎么做；模型扮演时照示例学他的声口，比只读设定更像他。` }),
      el('div', { class: 'cc-scenes', role: 'group', 'aria-label': t`写哪些场合` }, chips),
      wish,
      el('div', { class: 'cc-send' }, [el('p', { class: 'cc-estimate', text: note }), el('span', { class: 'grow' }), go]),
      state.pending === 'check-interview'
        ? sending()
        : job?.kind === 'check-interview'
          ? el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: job.chars ? t`模型正在写，已经写了 ${count(job.chars)} 字…` : t`模型正在读这张卡…` })]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })])
          : null,
      error?.kind === 'check-interview' && !state.pending ? el('div', { class: 'forge-error' }, [el('p', { text: error.message })]) : null,
      items.length ? el('div', { class: 'cc-items' }, items.map(item => itemBlock(item))) : null,
    ].filter(Boolean))
  }

  const askInterview = guard(async () => {
    await asking('check-interview', () => api(url('/interview'), { method: 'POST', body: { scenes: [...state.scenes], wish: state.interviewWish ?? '' } }))
  })

  function jobText(job) {
    // 全本检查's batches: part:<i>:<n>.
    const [, at, total] = /^part:(\d+):(\d+)$/.exec(job.step ?? '') ?? []
    const part = at ? t`全本检查第 ${at}/${total} 批：` : ''
    if (job.chars) return `${part}${t`模型正在写，已经写了 ${count(job.chars)} 字…`}`
    if (part) return t`${part}模型正在读这一批条目。停下的话，看完的几批的建议都留着。`
    return t`模型正在读这张卡，已经 ${Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)} 秒。可能要几分钟，关掉窗口也会接着看。`
  }

  function fillJob() {
    if (state.data.job && view.jobLine?.isConnected) view.jobLine.textContent = jobText(state.data.job)
  }

  const ask = guard(async () => {
    if (state.data.findings.some(item => item.from === 'model' && !item.trial) && !confirm(t`再看一次会换掉还没采用的模型建议，继续？`)) return
    await asking('check', () => api(url('/ask'), { method: 'POST', body: { focus: state.data.focus, whole: state.whole && Boolean(state.data.estimate.rest) } }))
  })

  const stop = guard(async () => {
    await api(url('/stop'), { method: 'POST' })
    load(await api(url()))
  })

  // ─── Taking in, and back ──────────────────────────────────────────────
  function updateFoot() {
    const takeableIds = state.data.findings.filter(takeable).map(item => item.id)
    const n = state.ticked.size
    view.foot.hidden = !takeableIds.length
    view.take.textContent = t`一键采用 ${n} 条`
    view.take.disabled = !n || state.busy || Boolean(state.data.job)
    view.all.textContent = n === takeableIds.length ? t`只留安全的` : t`全选`
    view.footNote.textContent = t`默认只勾上安全的修复。`
  }

  function tickAll() {
    const items = state.data.findings.filter(takeable)
    const everything = state.ticked.size === items.length
    state.ticked = new Set(items.filter(item => !everything || !item.risky).map(item => item.id))
    render()
  }

  function tickGroup(items, on) {
    for (const item of items) on ? state.ticked.add(item.id) : state.ticked.delete(item.id)
    render()
  }

  const take = guard(async (items, said = '') => {
    if (state.busy) return
    state.busy = true
    updateFoot()
    let result
    try {
      result = await api(url('/apply'), { method: 'POST', body: { items } })
    } finally {
      state.busy = false
      updateFoot()
    }
    for (const { id } of items) {
      state.editing.delete(id)
      state.ticked.delete(id)
      if (id === state.data.statusTune?.id) state.tuning = null
    }
    // Counted by suggestion, as they were ticked; one that could not go in with the others is named, still in the list.
    const kept = result.skipped?.length ? t`。「${result.skipped.join(t`」「`)}」要改的那段已经被前面一条改了，没能一起改，还留在列表里，可以让模型再看看` : ''
    const done = (said || (result.taken ? t`已采用 ${result.taken} 条` : t`已改进卡里：${result.applied} 处`)) + kept
    const gaps = result.chatGaps
    const names = gaps ? gaps.labels.slice(0, 3).join(t`、`) + (gaps.labels.length > 3 ? t` 等 ${gaps.labels.length} 处` : '') : ''
    await afterChange(result, gaps ? t`${done}。状态栏新加的「${names}」在 ${gaps.chats} 段已有对话里还没有这些变量，那里先显示不出来：等回复写上，或在右栏「状态」点「编辑」补上` : done, Boolean(gaps))
  })

  const takeTicked = () => take([...state.ticked].map(id => ({ id, ...(state.editing.has(id) ? { edits: state.editing.get(id) } : {}) })))

  /** What every change to the card is followed by: the list again, and the prefix of a chat on it. */
  async function afterChange(result, message, long = false) {
    load(result.check)
    if (result.prefix) {
      if (getChat()?.cardId === state.cardId) {
        state.stale = true
        render()
        if (long) toast(message, 9000)
      } else toast(t`${message}。改的内容在对话开局时的固定前缀里：新对话直接用新的，进行中的对话要在「设置 → 更多」里重建前缀才会用上。`, long ? 11000 : 7000)
    } else toast(message, long ? 9000 : undefined)
    await onCardChanged?.(state.cardId)
  }

  const undo = guard(async body => {
    await afterChange(await api(url('/undo'), { method: 'POST', body }), t`已撤销`)
  })

  function takenSection(records) {
    const batches = new Map()
    for (const record of records) batches.set(record.batch, [...(batches.get(record.batch) ?? []), record])
    return el('section', { class: 'plan-card cc-taken' }, [
      el('header', {}, [el('h4', { text: t`已采用 · ${records.length}` })]),
      ...[...batches.entries()].reverse().map(([batch, list]) => el('div', { class: 'cc-batch' }, [
        list.length > 1 ? el('div', { class: 'cc-batch-head' }, [el('span', { text: t`一起采用的 ${list.length} 条` }), el('button', { type: 'button', class: 'btn ghost small', text: t`全部撤销`, onclick: () => undo({ batch }) })]) : null,
        ...list.map(record => el('div', { class: 'cc-record' }, [
          el('span', { class: 'ce-mark on', text: '✓' }),
          el('span', { class: 'cc-record-title', text: record.title }),
          el('button', { type: 'button', class: 'btn ghost small', text: t`撤销`, title: t`改回采用之前的样子`, onclick: () => undo({ record: record.id }) }),
        ])),
      ])),
    ])
  }

  const setIgnored = guard(async (item, on) => {
    state.ticked.delete(item.id)
    load(await api(url(), { method: 'PUT', body: on ? { ignore: item.id } : { restore: item.id } }))
  })

  function ignoredSection(items) {
    return el('details', { class: 'plan-card cc-ignored' }, [
      el('summary', { text: t`已忽略 · ${items.length}` }),
      ...items.map(item => el('div', { class: 'cc-record' }, [
        el('span', { class: 'cc-record-title', text: item.title }),
        el('button', { type: 'button', class: 'btn ghost small', text: t`恢复`, onclick: () => setIgnored(item, false) }),
      ])),
    ])
  }

  dialog.addEventListener('close', () => {
    clearTimeout(state.poll)
    stopLoading()
  })

  return {
    open: guard(async cardId => {
      if (!view.main) layout()
      const switching = state.cardId !== cardId
      if (switching) {
        state.cardId = cardId
        state.shown = ''
        state.ticked = new Set()
        state.seen = new Set()
        state.opened = new Set()
        state.editing = new Map()
        state.tuning = null
        state.stale = false
        state.whole = false
        state.pending = ''
        state.data = null
        view.main.scrollTop = 0
      }
      // Open at once: another card's list, or none yet, says 正在检查 till this one's is in; the same card's shows
      // as it was while it is read again.
      if (!state.data) {
        view.sub.textContent = ''
        showLoading()
      }
      if (!dialog.open) dialog.showModal()
      try {
        const [data, edit] = await Promise.all([api(url()), api(`/api/cards/${cardId}/edit`), loadModels()])
        state.fromForge = edit.fromForge === true
        // Closed while it was read: nothing to show it in.
        if (!dialog.open || state.cardId !== cardId) return
        load(data)
      } catch (error) {
        if (!state.data) dialog.close()
        throw error
      }
    }),
  }
}
