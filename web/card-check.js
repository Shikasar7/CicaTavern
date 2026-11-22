// 检查这张卡 (the card list's ⋯, 修改角色卡): what is wrong with a saved card and what could be better, in one list.
// The program's findings show as soon as the window opens and cost nothing (server/forge/check.mjs); the model is asked
// only by the button here, after it says which model and about how much (check-model.mjs). Each finding shows as before
// and after, and can be taken in as it is, written over first, or ignored; what was taken in can be taken back, one by
// one or all that went in together. Only safe fixes come ticked for 一键采用. The last 试玩体检's problems have a
// section of their own: a model is asked for changes to them only by their buttons, and they can be fixed by hand.
import { t } from '/i18n.js'
import { EFFECTS, SHOWS, STATUS_THEMES, backdropLayers, cleanMap, cleanStatusSpec, colorContrast, lookTokensUsed, statusPages, triedExtreme, withTried } from '/shared/status.js'
import { getPath, unwrap } from '/shared/vars.js'
import { laidOut, layoutTakes, statusBar } from '/status.js'
import { coverPage } from '/cover.js'
import { decorBlock, lookPictures } from '/look-pictures.js'
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
// The 场景 that is the card's map, not a place the story is at.
const MAP_SCENE = /^(?:地图|世界地图|全图|大地图|map|world ?map)$/i
const SCENES_NAMED = 6

const LEVELS = [['error', t`会出错`, t`这些地方现在不起作用。`], ['warn', t`可能有问题`, t`能用，但多半不是作者想要的效果。`], ['tip', t`可以更好`, t`不改也能玩。`]]
const FOCUS = [['rules', t`玩法和变量`, t`规则打架、变量没写清、和开场白对不上`], ['tokens', t`省上下文`, t`常驻改关键词、重复条目、太宽的关键词`], ['look', t`美化`, t`状态栏显示什么、用什么主题`], ['style', t`文笔`, t`套话和前后矛盾。默认不查，别人的写法不去挑`]]
const SHOW_TEXT = { meter: t`进度条`, number: t`数字`, rating: t`星级`, text: t`文字`, long: t`长文字`, badge: t`徽章`, tags: t`标签`, list: t`列表`, stats: t`数值表`, table: t`表格`, flag: t`是或否`, map: t`地图`, types: t`克制图`, forms: t`形态链`, hidden: t`不显示` }
const THEME_TEXT = { plain: t`朴素`, editorial: t`文艺杂志`, meadow: t`晴野`, sigil: t`夜曜纹章`, daybreak: t`晨笺`, aquarelle: t`天光云影`, cobalt: t`钴蓝`, afterschool: t`放课后`, lineart: t`线稿`, signal: t`信号`, mercury: t`流银`, redink: t`赤墨`, kaleido: t`万华`, [OWN_COLORS]: t`按卡配色` }
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
    script.stRequest ? t`它要改 SillyTavern 组装和发出请求的方式（当前预设的设置、工具调用、拦截请求）。这里的请求由程序在后台组装发出，这部分不起作用；它因此每次都弹提示的话，关掉它不影响其余内容。` : '',
    lacking,
  ].filter(Boolean).join('')
}

/**
 * Why a ticked 顶上放立绘, 顶上放场景图 or 小手机 may change nothing on the bar: what the 版式 does with it
 * (layoutTakes), and what pictures the card has. `info`: { figure: someone in 角色名册 has a 立绘 or 人设图, avatar,
 * scenes: the names of the 场景 with a picture }, or null while it is asked for.
 */
function artNotes(spec, takes, info) {
  const notes = []
  if (spec.portrait) {
    if (takes.portrait) notes.push(takes.portrait)
    if (info && !info.figure) notes.push(info.avatar ? t`角色名册里还没有立绘或人设图，先用卡的头像。` : t`这张卡还没有立绘、人设图或头像，立绘不会显示。在「设置 → 配图与朗读 → 角色名册」里画。`)
  }
  if (spec.scene) {
    if (takes.scene) notes.push(takes.scene)
    if (info && !info.scenes.length) notes.push(t`这张卡还没有场景图，场景图不会显示。在视觉小说里画场景，或者用「一键备齐」。`)
    else if (info) {
      const named = info.scenes.slice(0, SCENES_NAMED).join(t`、`)
      notes.push(info.scenes.length > SCENES_NAMED ? t`回复写到的地点和场景图同名时才显示，现有：${named} 等 ${info.scenes.length} 张。` : t`回复写到的地点和场景图同名时才显示，现有：${named}。`)
    }
  }
  if (spec.phone && takes.phone) notes.push(takes.phone)
  return notes
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
  edit.spec = edit.spec ?? (structuredClone(change.spec))
  edit.paged = edit.paged ?? (statusPages(edit.spec).length > 0)
  const { spec } = edit
  const preview = el('div', { class: 'status-preview cc-status-preview' })
  edit.tryKey = tryKey
  const drawPreview = () => {
    const shown = cleanStatusSpec(spec)
    preview.replaceChildren((shown && statusBar(el, shown, triedState(edit, state), { collapsible: false, note: triedNote(edit), art: edit.lookArt ?? null })) || el('p', { class: 'hint', text: t`还没有要显示的项。` }))
  }
  // 定制外观的图 came (skinPanel loads them): the preview is drawn again with them.
  edit.onArt = drawPreview
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
      spec.palette = spec.palette ?? (change.spec.palette ?? FIRST_COLORS)
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
  const skinText = () => (spec.skin.name ? t`定制外观「${spec.skin.name}」` : t`定制外观`)
  const lookText = name => (name === OWN_SKIN ? (spec.skin.base ? t`${skinText()} · 叠在${THEME_TEXT[spec.skin.base]}上` : skinText()) : THEME_TEXT[name] ?? name)
  const theme = el('select', { 'aria-label': t`主题`, onchange: () => pickLook(theme.value) }, looks.map(name => el('option', { value: name, selected: look === name, text: lookText(name) })))
  // 版式: how the bar is laid out; the plain one is rows under a title.
  const layout = el('select', { 'aria-label': t`版式`, title: t`状态栏怎么排。卡片式：人放在最前面，页签在底下；侧栏式：数值一直在左边，右边换页；卷轴式：顶上是场景图和题字`, onchange: () => {
    if (layout.value) spec.layout = layout.value
    else delete spec.layout
    redraw()
  } }, [['', t`简洁（原来的）`], ['card', t`卡片式`], ['rail', t`侧栏式`], ['scroll', t`卷轴式`]].map(([value, text]) => el('option', { value, text })))
  layout.value = spec.layout ?? ''
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
  // 立绘, 场景图 and 动效 on the bar: the pictures are the ones the app keeps for this card. A box the 版式 leaves
  // without effect is greyed out (what it holds is kept, for a change back); a ticked one that will show nothing says why.
  const takes = layoutTakes(spec.layout ?? '')
  const notes = el('div', { class: 'front-notes', 'aria-live': 'polite' })
  const drawNotes = () => notes.replaceChildren(...artNotes(spec, takes, edit.artInfo).map(text => el('small', { class: 'hint front-note', text })))
  edit.drawNotes = drawNotes
  const picture = (key, label, hint) => {
    const off = takes.off.includes(key)
    const box = el('input', { type: 'checkbox', disabled: off, onchange: () => {
      if (box.checked) spec[key] = true
      else delete spec[key]
      drawPreview()
      drawNotes()
    } })
    box.checked = spec[key] === true
    return el('label', { class: `front-check${off ? ' off' : ''}`, title: off ? takes[key] : hint }, [box, el('span', { text: label })])
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
    el('small', { class: 'hint', text: t`下面的预览不带图：立绘和场景图要回到对话里看，也只在 CicaTavern 里显示。` }),
    notes,
  ])
  drawNotes()
  // What pictures the card has, asked for once: a ticked box with none to show says so.
  if (design?.api && design.cardId && edit.artInfo === undefined) {
    edit.artInfo = null
    const ask = path => design.api(`/api/cards/${design.cardId}/${path}`).catch(() => null)
    Promise.all([ask('media'), ask('sprites'), ask('scenes')]).then(([media, drawn, places]) => {
      const cast = (media?.roster ?? []).filter(entry => !entry.player)
      edit.artInfo = {
        figure: cast.some(entry => drawn?.sprites?.[entry.id]?.file || entry.ref),
        avatar: design.hasAvatar === true,
        scenes: (places?.scenes ?? []).filter(scene => scene.file && !MAP_SCENE.test(String(scene.name ?? '').trim())).map(scene => String(scene.name ?? '').trim()).filter(Boolean),
      }
      edit.drawNotes?.()
    })
  }
  // What the card's variables could show and the bar does not.
  const left = spare.filter(field => !spec.fields.some(shown => shown.path === field.path))
  const adding = el('select', { class: 'cc-status-add', 'aria-label': t`加一项`, onchange: () => {
    spec.fields.push(structuredClone(left.find(field => field.path === adding.value)))
    redraw()
  } }, [el('option', { value: '', text: t`加一项…` }), ...left.map(field => el('option', { value: field.path, text: field.label ? `${field.label} (${field.path})` : field.path }))])
  drawPreview()
  // The picture of the card's map (the 场景 called 地图), where there is one: asked for once, then drawn again with it.
  if (design?.api && design.cardId && edit.mapSrc === undefined && spec.fields.some(field => field.show === 'map')) {
    edit.mapSrc = ''
    design.api(`/api/cards/${design.cardId}/scenes`).then(found => {
      const scene = (found?.scenes ?? []).find(one => one.file && MAP_SCENE.test(String(one.name ?? '').trim()))
      if (!scene) return
      edit.mapSrc = `/api/scenes/${design.cardId}/${scene.file}`
      redraw()
    }, () => {})
  }
  return [
    preview,
    tryout,
    el('div', { class: 'cc-status-top' }, [title, theme, layout]),
    spec.palette ? colors() : null,
    design ? skinPanel(el, edit, { state, redraw, kept: change.spec.skin?.css ?? '', ...design }) : null,
    pictures,
    paging,
    el('div', { class: 'cc-status-rows' }, spec.fields.map(row)),
    spec.fields.some(field => field.show === 'map') ? mapEditor(el, spec, { drawPreview, paths: spec.fields.map(field => field.path), src: edit.mapSrc ?? '' }) : null,
    left.length ? adding : null,
  ]
}

// 地图: the places of the card's map, a line each (区域：地点), and where each is on it: its pin is dragged there.
const PLACE_LINE = /^(?:(.{1,16}?)[：:])?\s*(.{1,40})$/

/**
 * @param spec - the bar being edited; its `map` is written here.
 * @param options - { drawPreview(), paths: the bar's variables (for 当前地点), src: the picture of the map, or '' }
 */
function mapEditor(el, spec, { drawPreview, paths, src }) {
  spec.map = spec.map ?? { places: [] }
  const map = spec.map
  const stage = el('div', { class: `status-map-stage cc-map-stage${src ? '' : ' plain'}` })
  const draw = () => {
    stage.replaceChildren(...[src ? el('img', { class: 'status-map-img', src, alt: '', draggable: 'false' }) : null, ...laidOut(map.places).map((shown, index) => {
      const place = map.places[index]
      const pin = el('button', { type: 'button', class: 'status-pin cc-map-pin', style: `left:${shown.x}%;top:${shown.y}%`, title: t`拖到它在图上的位置` }, [el('i', { class: 'status-pin-dot', 'aria-hidden': 'true' }), el('span', { class: 'status-pin-name', text: place.short || place.name })])
      const move = event => {
        const box = stage.getBoundingClientRect()
        place.x = Math.max(0, Math.min(100, Math.round(((event.clientX - box.left) / box.width) * 1000) / 10))
        place.y = Math.max(0, Math.min(100, Math.round(((event.clientY - box.top) / box.height) * 1000) / 10))
        pin.style.left = `${place.x}%`
        pin.style.top = `${place.y}%`
      }
      pin.addEventListener('pointerdown', event => {
        event.preventDefault()
        pin.setPointerCapture(event.pointerId)
        pin.addEventListener('pointermove', move)
        pin.addEventListener('pointerup', () => {
          pin.removeEventListener('pointermove', move)
          drawPreview()
        }, { once: true })
      })
      // Without a mouse: the arrow keys, a step at a time.
      pin.addEventListener('keydown', event => {
        const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
        if (!step) return
        event.preventDefault()
        place.x = Math.max(0, Math.min(100, (place.x ?? shown.x) + step[0]))
        place.y = Math.max(0, Math.min(100, (place.y ?? shown.y) + step[1]))
        pin.style.left = `${place.x}%`
        pin.style.top = `${place.y}%`
        drawPreview()
      })
      return pin
    })].filter(Boolean))
  }
  const lines = el('textarea', { class: 'cc-map-places', rows: 5, 'aria-label': t`地图上的地点`, placeholder: t`一行一个地点，可以在前面写它属于哪一片，比如：\n上城区：白塔神殿\n下城区：断剑酒馆`, onchange: () => {
    const next = []
    for (const line of lines.value.split('\n')) {
      const [, zone = '', name = ''] = PLACE_LINE.exec(line.trim()) ?? []
      if (!name.trim() || next.some(one => one.name === name.trim())) continue
      const old = map.places.find(one => one.name === name.trim())
      next.push({ ...old, name: name.trim(), ...(zone.trim() ? { zone: zone.trim() } : {}) })
      if (!zone.trim()) delete next.at(-1).zone
    }
    map.places = cleanMap({ places: next })?.places ?? []
    draw()
    drawPreview()
  } })
  lines.value = map.places.map(place => (place.zone ? t`${place.zone}：${place.name}` : place.name)).join('\n')
  const here = el('select', { 'aria-label': t`记着当前地点的变量`, onchange: () => {
    if (here.value) map.here = here.value
    else delete map.here
    drawPreview()
  } }, [el('option', { value: '', text: t`没有` }), ...[...new Set([map.here, ...paths].filter(Boolean))].map(path => el('option', { value: path, text: path }))])
  here.value = map.here ?? ''
  draw()
  return el('div', { class: 'cc-map' }, [
    el('b', { text: t`地图` }),
    el('small', { class: 'hint', text: src ? t`把每个地点的图钉拖到它在图上的位置。` : t`没有地图的图时，地点按片区排成几行；想放一张图，在「配图与朗读 → 场景」里加一个叫「地图」的场景，再回来把图钉拖到位置上。` }),
    lines,
    map.places.length ? stage : null,
    el('label', { class: 'cc-map-here' }, [el('span', { text: t`当前地点的变量` }), here]),
  ])
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

// 风格: ways a look can go. The chip only picks one ([key, name, what it is in a line]); what it is made of, part by
// part, is the server's to tell the model (server/forge/skin-styles.mjs). What the user types goes over it.
const SKIN_STYLES = () => [
  ['fresh', t`日系清新`, t`日系清新：浅色的底，低饱和的粉蓝或薄荷色，大圆角，细线，留白多，像一个干净的手机日记应用`],
  ['metal', t`金属光泽`, t`金属光泽：拉丝金属的底，边框有高光和倒角，进度条像抛光的金属条，冷色，硬朗`],
  ['journal', t`日记手帐`, t`日记手帐：米色的纸，淡淡的格线或点阵，像贴上去的和纸胶带和便签，手写感的字体，标题下面一道荧光笔`],
  ['pixel', t`像素风`, t`像素风：硬边，不用圆角和模糊，粗的像素边框（用 box-shadow 叠出台阶），等宽字体，颜色不超过六种，进度条分成一格一格`],
  ['cel', t`赛璐璐平涂`, t`赛璐璐平涂：平涂的色块，纤细均匀的描边，淡而开阔的配色（沙黄、天青、淡紫），用细线排出一点阴影，不用渐变的光泽`],
  ['ink', t`水墨留白`, t`水墨留白：宣纸的底，墨色浓淡，朱红只点一处，拉开字距的楷体标题，细而不匀的墨线，大片留白`],
  ['neon', t`赛博霓虹`, t`赛博霓虹：近黑的底，青和品红的霓虹描边带一点辉光，等宽字体，细的扫描线，角上有切角`],
  ['storybook', t`童话绘本`, t`童话绘本：暖色的纸，蜡笔和水彩的感觉，圆润的边框像手画的，颜色明快，小装饰用星星和叶子`],
]

// 起点: where a look starts. A theme stays under it and the model writes only what it changes; from nothing it writes all.
const SKIN_STARTS = () => [
  ['', t`从零设计`, t`模型从头写一整套，只按这张卡的气氛和你写的要求`],
  ['editorial', t`文艺杂志`, t`在文艺杂志上改：留着它的纸、字和星图细线，模型只写要改的地方`],
  ['meadow', t`晴野`, t`在晴野上改：留着它的手绘线条、圆字和草地，模型只写要改的地方`],
  ['sigil', t`夜曜纹章`, t`在夜曜纹章上改：留着它的黑曜石、鎏金和魔纹，模型只写要改的地方`],
  ['daybreak', t`晨笺`, t`在晨笺上改：留着它的晨曦纸面、衬线大字和花体，模型只写要改的地方`],
  ['aquarelle', t`天光云影`, t`在天光云影上改：留着它的水彩纸、墨线框和会变的天空，模型只写要改的地方`],
  ['cobalt', t`钴蓝`, t`在钴蓝上改：留着它的单色印刷、蓝色标签和错开的圆盘，模型只写要改的地方`],
  ['afterschool', t`放课后`, t`在放课后上改：留着它的搪瓷招牌、深蓝菜单底和白边蓝窗，模型只写要改的地方`],
  ['lineart', t`线稿`, t`在线稿上改：留着它的图框方格纸、细线画的机器人和尺寸线，模型只写要改的地方`],
  ['signal', t`信号`, t`在信号上改：留着它的近黑底、薄荷绿格子点阵和追踪细线，模型只写要改的地方`],
  ['mercury', t`流银`, t`在流银上改：留着它流动的镀铬、烟色玻璃面板和水银管，模型只写要改的地方`],
  ['redink', t`赤墨`, t`在赤墨上改：留着它的黑色块、黑柱、毛笔标题和那一道红，模型只写要改的地方`],
  ['kaleido', t`万华`, t`在万华上改：留着它的黑底、彩色喷流、镶色的黑玻璃分组和虹彩边框，模型只写要改的地方`],
]

const PROBE_WIDTHS = [340, 720]
// Words a reader must make out, and those that are faint on purpose.
const READ_PARTS = '.status-app-name, .status-phone-name, .status-title, .status-label, .status-value, .status-text, .status-tag, .status-badge, .status-stars, .status-flag, .status-long, .status-list li, .status-table th, .status-table td, .status-page, .status-tab, .status-group-name, .status-section'
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
  probeBlocks(bar, width, note)
  probeWords(bar, READ_PARTS, FAINT_PARTS, note)
  for (const meter of bar.querySelectorAll('.status-meter')) {
    if (meter.closest('[hidden]')) continue
    const rect = meter.getBoundingClientRect()
    if (rect.height < 3 || rect.width < 24) note('meter', t`进度条太细或太短（${Math.round(rect.width)}×${Math.round(rect.height)} 像素），看不出进度`)
  }
}

// The bar's blocks, top to bottom as the page lays them (web/status.js statusBar), and what stands in the phone.
const BAR_BLOCKS = ['status-head', 'status-pages', 'status-art', 'status-rail', 'status-main', 'status-body', 'status-dock', 'status-phone']
const PHONE_PARTS = ['status-phone-top', 'status-phone-head', 'status-phone-screen', 'status-phone-home']

/** How far two boxes lie over each other, in pixels each way (0 when they do not). */
function overlap(a, b) {
  const wide = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const high = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return wide > 0 && high > 0 ? Math.min(wide, high) : 0
}

/**
 * Where the bar's blocks stand: one under the other, none over another (negative margins can still pull one up), and
 * in the phone the title, the screen and the bar at the foot each inside the frame, the foot's bar in the middle.
 * Exported for the layout check (test/skin-layout.test.mjs draws looks that move things and reads what this says).
 */
export function probeBlocks(bar, width, note) {
  const shown = (root, names) => names.map(name => [...root.children].find(node => node.classList.contains(name))).filter(node => node && !node.hidden && node.getBoundingClientRect().height > 0)
  const blocks = shown(bar, BAR_BLOCKS)
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const [first, second] = [blocks[i], blocks[j]]
      const [a, b] = [first.getBoundingClientRect(), second.getBoundingClientRect()]
      const [upper, lower] = [first.classList[0], second.classList[0]]
      if (overlap(a, b) > 3) note(`over:${upper}:${lower}`, t`宽 ${width} 像素时，.${upper} 和 .${lower} 叠在了一起：状态栏的各块要一块在一块下面，不要用负的 margin 把哪一块拉上去`)
      else if (b.top < a.top - 3) note(`order:${upper}:${lower}`, t`.${upper} 和 .${lower} 的上下顺序反了：各块的顺序由程序定`)
    }
  }
  // A block let out to the bar's edge goes out the same on both sides (a title strip that stops short on the right).
  const around = bar.getBoundingClientRect()
  for (const block of blocks) {
    // 侧栏式 stands its rail beside the tabs: neither reaches both edges.
    if (block.classList.contains('status-phone') || (bar.classList.contains('layout-rail') && block.matches('.status-rail, .status-main'))) continue
    const rect = block.getBoundingClientRect()
    const [left, right] = [rect.left - around.left, around.right - rect.right]
    if (Math.abs(left - right) > 3) note(`lean:${block.classList[0]}`, t`宽 ${width} 像素时，.${block.classList[0]} 左右没有对齐（左边离状态栏的边 ${Math.round(left)} 像素，右边 ${Math.round(right)} 像素）：两边的 margin 和 padding 要一样`)
  }
  // A gauge with no room left (two columns kept at a phone's width).
  const tight = [...bar.querySelectorAll('.status-meter')].filter(meter => !meter.closest('[hidden]')).map(meter => meter.getBoundingClientRect().width).filter(wide => wide > 0 && wide < 80)
  if (tight.length) note(`tight:${width}`, t`宽 ${width} 像素时，进度条被挤得只剩 ${Math.round(Math.min(...tight))} 像素：这么窄时各组要排成一列。几列并排用 repeat(auto-fit, minmax(min(100%, 260px), 1fr)) 这种自己会折行的写法，不要靠 @media（它看的是窗口，不是状态栏的宽度）`)
  const frame = bar.querySelector('.status-phone:not([hidden]) > .status-phone-frame')
  if (!frame) return
  const box = frame.getBoundingClientRect()
  const inner = { left: box.left + frame.clientLeft, right: box.left + frame.clientLeft + frame.clientWidth, top: box.top + frame.clientTop, bottom: box.top + frame.clientTop + frame.clientHeight }
  const parts = shown(frame, PHONE_PARTS)
  parts.forEach((part, i) => {
    const rect = part.getBoundingClientRect()
    const name = `.${part.classList[0]}`
    // A title strip let out to the frame's edge is cut there and reads as flush; what counts is that it starts and ends in step.
    const [left, right] = [rect.left - inner.left, inner.right - rect.right]
    if (Math.abs(left - right) > 3) note(`lean:${name}`, t`小手机里的 ${name} 左右没有对齐（左边离边框 ${Math.round(left)} 像素，右边 ${Math.round(right)} 像素）：两边的 margin 和 padding 要一样`)
    if (rect.bottom > inner.bottom + 2 || rect.top < inner.top - 2) note(`phone-out:${name}`, t`小手机里的 ${name} 伸到了边框外面`)
    const next = parts[i + 1]
    if (next && overlap(rect, next.getBoundingClientRect()) > 3) note(`phone-over:${name}`, t`小手机里的 ${name} 和 .${next.classList[0]} 叠在了一起`)
  })
  // What is on the phone's screen keeps the same edge on both sides (a box drawn round a group, pushed to one side).
  const screen = frame.querySelector('.status-phone-screen')
  const group = screen?.querySelector(':scope > .status-group')
  if (group) {
    const [outer, rect, style] = [screen.getBoundingClientRect(), group.getBoundingClientRect(), getComputedStyle(screen)]
    const left = rect.left - outer.left - screen.clientLeft - parseFloat(style.paddingLeft)
    const right = outer.left + screen.clientLeft + screen.clientWidth - parseFloat(style.paddingRight) - rect.right
    if (Math.abs(left - right) > 3) note('lean:group', t`小手机里的 ${'.status-group'} 左右没有对齐（左边离边框 ${Math.round(left)} 像素，右边 ${Math.round(right)} 像素）：两边的 margin 和 padding 要一样`)
  }
  const dock = bar.querySelector('.status-dock')
  if (dock) {
    const apps = [...dock.querySelectorAll('.status-app')].map(app => app.getBoundingClientRect())
    if (apps.some((a, i) => apps.some((b, j) => j > i && overlap(a, b) > 3))) note('apps-over', t`宽 ${width} 像素时，小手机的图标（.status-app）互相叠在了一起`)
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
  // The words start at the page's left edge (a look that re-laid the page left them in the middle of it).
  const main = page.querySelector('.cover-main')
  if (main && !page.classList.contains('has-figure') && main.getBoundingClientRect().left - box.left > Math.max(48, box.width * 0.2)) note('cover-main', t`开场页的字（.cover-main）被推到了中间，左边空了一大块：不要改 .cover 的排法，也不要给 .cover-main 加大的左边距`)
  probeWords(page, COVER_PARTS, COVER_FAINT, note)
}

/** A computed background-image's layers, the topmost first. */
function imageLayers(image) {
  const layers = []
  let depth = 0
  let from = 0
  for (let i = 0; i < image.length; i += 1) {
    if (image[i] === '(') depth += 1
    else if (image[i] === ')') depth -= 1
    else if (image[i] === ',' && depth === 0) {
      layers.push(image.slice(from, i).trim())
      from = i + 1
    }
  }
  layers.push(image.slice(from).trim())
  return layers
}

/**
 * Whether words stand right on one of the look's pictures: going outwards, the first ground behind them is a picture
 * with no wash over it (a gradient above it in the same background, at least this solid) and no fill nearer the words.
 * A picture the look drew itself (SVG in its CSS: a paper grain, a ridge of hills, a line of stars) is its ornament, not
 * one of the card's photographs: words over it are left to the look.
 */
const WASH = 0.7
const DRAWN = /^url\(\s*["']?data:image\/svg\+xml/i
function onPicture(part, bar) {
  for (let node = part; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const layers = imageLayers(style.backgroundImage || 'none')
    const picture = layers.findIndex(layer => /^url\(/.test(layer) && !DRAWN.test(layer))
    if (picture >= 0) {
      const washed = layers.slice(0, picture).some(layer => {
        const stops = (layer.match(/rgba?\([^)]*\)/g) ?? []).map(rgbaOf).filter(Boolean)
        return stops.length > 0 && Math.min(...stops.map(stop => stop[3])) >= WASH
      })
      return !washed
    }
    if ((rgbaOf(style.backgroundColor)?.[3] ?? 0) >= WASH) return false
    if (node === bar) break
  }
  return false
}

/** The words in `root` that must be read (`parts`; `faint`: those dim on purpose): shown, large enough, apart from their ground. */
function probeWords(bar, parts, faint, note) {
  for (const part of bar.querySelectorAll(parts)) {
    if (part.closest('[hidden]') || !part.textContent.trim()) continue
    // An app of one thing has its name on the phone's title: the page itself leaves the name out of the screen (style.css).
    if (part.matches('.status-phone-screen.single .status-group-name, .status-phone-screen.single .status-row.block > .status-label')) continue
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
    if (onPicture(part, bar)) {
      note(`picture:${tag}`, t`${words} 直接压在图上，字会看不清：图上面先压一层不透明度至少 0.75 的渐变或底色`)
      continue
    }
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
 * @param art - { lookPictures, lookTokens } (web/look-pictures.js): the card's pictures the look may name. A look that
 *   names some is drawn with them, and once more without (its fallback has to hold up too).
 */
export function skinProblems(el, spec, state, more = [], cover = null, art = null) {
  const shown = cleanStatusSpec(spec)
  if (!shown?.skin) return []
  const found = new Map()
  const note = (key, words) => { if (!found.has(key)) found.set(key, words) }
  const named = lookTokensUsed(shown.skin.css)
  for (const token of named.filter(token => art?.lookTokens && !art.lookTokens.has(token))) note(`token:${token}`, t`外观里用了 ${token}，这张卡没有这张图：只能用 <pictures> 里列出的名字`)
  // A new box for each width: Chrome 156 kept a reused one at the width it had first (an inline width changed
  // afterwards was in its style but not in its size), so a bar looked over at 720 was measured at 340.
  let host = null
  const sized = width => {
    host?.remove()
    host = el('div', { class: 'skin-probe', 'aria-hidden': 'true', style: `width:${width}px` })
    document.body.append(host)
    return host
  }
  try {
    const drawings = [state, withTried(state, triedExtreme(shown, state, 'full')), ...more].map(values => [values, art])
    // Without the pictures: what shows where one is missing (left out of a SillyTavern copy over its cap).
    if (named.length && art?.lookPictures) drawings.push([state, null])
    for (const [values, pictures] of drawings) {
      for (const width of PROBE_WIDTHS) {
        const bar = statusBar(el, shown, values, { collapsible: false, remembers: false, art: pictures })
        if (!bar) continue
        sized(width).append(bar)
        const tabs = [...bar.querySelectorAll('.status-page')]
        for (const tab of tabs.length ? tabs : [null]) {
          tab?.click()
          probe(bar, width, note)
        }
        // 小手机: each app opened in turn, the phone looked over like the rest (it is put away till one is).
        for (const app of bar.querySelectorAll('.status-app')) {
          app.click()
          probe(bar, width, note)
        }
      }
    }
    if (cover?.cover) {
      for (const width of PROBE_WIDTHS) {
        const openings = (cover.cover.openings?.length ? cover.cover.openings : [{}, {}]).map(() => '')
        const page = coverPage(el, { name: cover.name, cover: cover.cover, palette: shown.palette ?? null, skin: shown.skin, art: art?.lookPictures ? { lookPictures: art.lookPictures } : null, openings, picked: 0, onPick: async () => {} })
        sized(width).append(page.node)
        probeCover(page.node, width, note)
      }
    }
  } finally {
    host?.remove()
  }
  return [...found.values()].slice(0, MAX_PROBLEMS)
}

/**
 * The bar in a look: the rules over the theme it starts from (skin.base) with that theme's colors or its own, or, from
 * nothing, the three colors and the rules in place of a theme.
 */
function wearing(spec, skin, decor = null) {
  const next = { ...spec, skin: { name: skin.name, css: skin.css, ...(decor ? { decor } : {}), ...(skin.base ? { base: skin.base } : {}) } }
  if (skin.palette) next.palette = skin.palette
  else delete next.palette
  if (skin.base) next.theme = skin.base
  else delete next.theme
  return next
}

/**
 * 定制外观 in a bar's editor: 修改角色卡 → 状态栏 for a saved card, and the plan's status bar in 创作角色卡 (web/forge.js). What it
 * knows is kept on `edit.look` (the editor is drawn again and again): the server's view ({ skin: the draft, job, busy,
 * error, estimate }), what the user typed, what drawing the draft showed. `edit.spec` is the bar being edited: a look
 * put on goes into it (palette, skin), then `redraw()`.
 * @param options - { api, cardId (or url and stopUrl, where the look is asked for and stopped), state: the variables
 *   as they start, redraw, kept: the CSS of the look already saved, instant: whether redraw() saves (no 保存 to click),
 *   busyWords: what to say while something else has the model, pictureCard: the saved card whose pictures a look may
 *   name (定制外观的图; none for a draft not saved yet), pickDraw: how to draw (web/draw-choice.js), for 画装饰图 }
 */
export function skinPanel(el, edit, { api, cardId, url = `/api/cards/${cardId}/check/skin`, stopUrl = `/api/cards/${cardId}/check/stop`, state, redraw, kept = '', instant = false, cover = null, busyWords = t`模型正在看这张卡（检查这张卡），等它看完再设计外观。`, pictureCard = cardId, pickDraw = null }) {
  const look = (edit.look = edit.look ?? ({ data: null, missing: false, wish: '', style: '', sending: false, mending: false, checked: '', came: '', problems: [], failure: '' }))
  // 定制外观的图: what the card has, for the previews and the check; drawn again once they are known.
  if (look.pictures?.cardId !== pictureCard) look.pictures = pictureCard ? lookPictures(api, pictureCard) : null
  const art = () => look.pictures?.art ?? null
  const picturesChanged = () => {
    edit.lookArt = art()
    look.checked = ''
    check()
    look.draw?.()
    edit.onArt?.()
  }
  const draft = () => look.data?.skin ?? null
  const worn = () => Boolean(draft() && edit.spec.skin?.css === draft().css)
  const asking = () => look.sending || Boolean(look.data?.job)
  // What to work from: the draft on show, or the look the bar already wears.
  const base = () => draft() ?? (edit.spec.skin ? { name: edit.spec.skin.name ?? '', palette: edit.spec.palette, css: edit.spec.skin.css, ...(edit.spec.skin.base ? { base: edit.spec.skin.base } : {}) } : null)

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
  // 风格: one picked stays marked (picked again: none); what it is, in a line, under the chips.
  const styles = el('div', { class: 'cc-skin-styles', role: 'group', 'aria-label': t`风格` })
  const styleNote = el('p', { class: 'hint cc-skin-style-note', hidden: true })
  const drawStyles = () => {
    const picked = SKIN_STYLES().find(([key]) => key === look.style)
    styles.replaceChildren(
      el('span', { class: 'hint', text: t`风格：` }),
      ...SKIN_STYLES().map(([key, name, words]) => el('button', { type: 'button', class: 'chip-pick', 'aria-pressed': String(look.style === key), text: name, title: words, onclick: () => {
        look.style = look.style === key ? '' : key
        drawStyles()
        drawActions()
      } })),
    )
    styleNote.hidden = !picked
    styleNote.textContent = picked ? t`${picked[2]}。模型会拿到这种风格的详细做法（底、配色、边框、字、进度条、标签、变化时的反应），下面自己写的要求优先。再点一次取消。` : ''
  }
  drawStyles()
  // 起点: a theme to go over (the theme stays under the look, the model writes what it changes), or nothing. Till one
  // is picked: the theme the look worn now goes over, else the bar's theme.
  if (look.start === undefined) look.start = edit.spec.skin ? edit.spec.skin.base ?? '' : STATUS_THEMES.includes(edit.spec.theme) && edit.spec.theme !== 'plain' ? edit.spec.theme : ''
  const starts = el('div', { class: 'cc-skin-styles cc-skin-starts', role: 'group', 'aria-label': t`起点` })
  const drawStarts = () => starts.replaceChildren(
    el('span', { class: 'hint', text: t`起点：` }),
    ...SKIN_STARTS().map(([key, name, words]) => el('button', { type: 'button', class: 'chip-pick', 'aria-pressed': String(look.start === key), text: name, title: words, onclick: () => {
      look.start = key
      drawStarts()
      drawActions()
    } })),
  )
  drawStarts()
  const decorSlot = el('div', {})
  const box = (look.box = el('div', { class: 'cc-skin', hidden: true }, [
    el('p', { class: 'cc-skin-head' }, [el('strong', { text: t`定制外观` }), el('small', { class: 'hint', text: t`让模型按这张卡的气氛给状态栏写一套样子：边框、纹饰、字体、进度条，也能用上这张卡自己的图（场景、立绘、头像）和下面画的装饰图。状态栏还是程序画的，变量照常显示。` })]),
    draftSlot,
    decorSlot,
    starts,
    styles,
    styleNote,
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
    look.problems = skinProblems(el, wearing(edit.spec, skin), state, scenesOf(edit.tryKey).map(scene => withTried(state, scene.values)), cover, art())
  }

  function take(data) {
    look.data = data
    // The card's own pictures a new draft names are copied small first (they travel with the look); drawn again then.
    const css = draft()?.css
    if (css && look.pictures?.data && look.copied !== draft().at) {
      look.copied = draft().at
      look.pictures.copyFor(css).then(made => { if (made) picturesChanged() })
    }
    check()
    // A look just made that draws badly goes back once, with what was found; the one that comes back is shown as it is.
    // (The answer can be in the view a moment before its job is gone: it has come only once the job is.)
    const fresh = Boolean(draft()) && !data.job && draft().at !== look.came
    if (draft() && !data.job) look.came = draft().at
    const mend = fresh && look.mending && look.problems.length > 0 && !draft().fixed
    if (fresh) look.mending = false
    if (mend) send({ previous: draft(), problems: look.problems, base: draft().base ?? '' })
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
      take(await api(url, { method: 'POST', body: { spec: edit.spec, base: look.start, ...body } }))
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
    send({ wish: look.wish.trim(), style: look.style, previous })
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
    // 画装饰图's prompts go with the look (a redesign that wrote none keeps the ones there were).
    const next = wearing(edit.spec, skin, skin.decor ?? edit.spec.skin?.decor)
    for (const key of Object.keys(edit.spec)) if (!(key in next)) delete edit.spec[key]
    Object.assign(edit.spec, next)
    // The 动效 the model picked for this look comes with it (it can be changed after).
    if (skin.effect) edit.spec.effect = skin.effect
    redraw()
  }

  function estimateText(estimate) {
    if (!estimate.ready) return t`先在「模型供应商」里添加供应商，再选一个模型。`
    const money = estimate.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    return t`点了才发送。发给 ${estimate.model}，一次大约 ${count(estimate.input + estimate.output)} token${money}。画出来有撑出去或看不清的地方时，会让模型再改一次。`
  }

  function draftBlock(skin) {
    const shown = cleanStatusSpec(wearing(edit.spec, skin))
    const bar = shown && statusBar(el, shown, triedState(edit, state), { collapsible: false, remembers: false, note: triedNote(edit), art: art() })
    const cut = { url: t`要加载的图片和字体，或用了程序不留的写法的小图`, import: t`@import 和 @font-face`, fixed: t`固定在屏幕上的层`, long: t`超出长度的最后几条规则（可以写上「精简一些」再让它改）` }
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
        look.problems.length ? el('button', { type: 'button', class: 'btn small', disabled: asking() || look.data.busy, text: t`让模型修这几处`, onclick: () => send({ previous: skin, problems: look.problems, base: skin.base ?? '' }) }) : null,
        el('button', { type: 'button', class: 'btn primary small', text: t`用这套外观`, title: instant ? t`用在这张卡的状态栏上` : t`换到上面的预览里；点「保存」才写进卡`, onclick: () => wear() }),
      ]),
    ])
  }

  /** The buttons, or what the model is doing. */
  function drawActions() {
    const { job, busy, estimate } = look.data
    // A look to work from is one on the 起点 picked: another 起点 starts anew.
    const from = base() && (base().base ?? '') === look.start ? base() : null
    const off = asking() || busy || !estimate.ready
    if (look.sending) return actions.replaceChildren(el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: t`正在发给模型…` })]))
    if (job) {
      const words = job.chars ? t`模型正在写，已经写了 ${count(job.chars)} 字…` : t`模型正在设计，已经 ${Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)} 秒。关掉窗口也会接着写。`
      return actions.replaceChildren(el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), el('span', { text: words })]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })]))
    }
    return actions.replaceChildren(el('div', { class: 'cc-actions' }, [
      edit.spec.skin ? el('button', { type: 'button', class: 'btn ghost small', text: t`去掉定制外观`, title: edit.spec.skin.base ? t`状态栏回到「${THEME_TEXT[edit.spec.skin.base]}」原来的样子；这套外观不再用` : t`状态栏回到三个颜色的样子；这套外观不再用`, onclick: () => {
        // Over a theme, the theme stays as it was, in its own colors.
        if (edit.spec.skin.base) delete edit.spec.palette
        delete edit.spec.skin
        redraw()
      } }) : null,
      el('span', { class: 'grow' }),
      from ? el('button', { type: 'button', class: 'btn small', disabled: off || !(look.wish.trim() || look.style), text: t`照这个改`, title: t`在现在这一套的基础上，按上面写的和选的风格改`, onclick: () => ask(from) }) : null,
      // With nothing written or picked, another one unlike this; with a wish or a style, one made from that alone.
      el('button', { type: 'button', class: `btn small${from ? '' : ' primary'}`, disabled: off, text: from ? t`另设计一套` : look.start ? t`在「${THEME_TEXT[look.start]}」上设计` : t`让模型设计`, onclick: () => ask(from && !look.wish.trim() && !look.style ? from : null) }),
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
    // 画装饰图: on a saved card only (the pictures are kept with it).
    const pictures = look.pictures
    decorSlot.replaceChildren(...(pictures?.data ? [decorBlock(el, { api, pictures, pickDraw, prompts: () => draft()?.decor ?? edit.spec.skin?.decor ?? {}, onChanged: picturesChanged })] : pictureCard ? [] : [el('p', { class: 'hint', text: t`保存这张卡以后，外观就能用上它的场景、立绘和画的装饰图。` })]))
    drawActions()
    const words = look.failure || look.data.error
    failure.replaceChildren(...(words ? [el('div', { class: 'forge-error' }, [el('p', { text: words })])] : []))
  }

  if (look.pictures && !look.pictures.data && !look.pictures.asked) {
    look.pictures.asked = true
    look.pictures.load().then(() => {
      // The look the bar wears, and a draft from before, may name pictures not copied yet.
      for (const css of [edit.spec.skin?.css, draft()?.css]) if (css) look.pictures.copyFor(css).then(made => { if (made) picturesChanged() })
      picturesChanged()
    })
  } else edit.lookArt = art()
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

/** @param deps - { api, el, toast, guard, getChat, isGenerating, openProviders, openToolPrompts(group), openTalk(cardId, words), openStatus(cardId) (修改角色卡 → 状态栏), openTrial(cardId), onChatChanged(chat), onCardChanged(cardId) } */
export function initCardCheck({ api, el, toast, guard, getChat, isGenerating, openProviders, openToolPrompts = null, openTalk, openStatus, openTrial, onChatChanged, onCardChanged }) {
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
      // The bar is laid out by hand in 修改角色卡 → 状态栏 (one place for it); this window says what is wrong with it.
      state.data.statusTune
        ? el('div', { class: 'cc-actions' }, [el('button', { type: 'button', class: 'btn small', text: t`调整状态栏`, title: t`到「修改角色卡 → 状态栏」里直接改主题、颜色和显示的内容，不用模型`, onclick: () => {
          dialog.close()
          openStatus(state.cardId)
        } })])
        : null,
    ].filter(Boolean))
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
    const edit = change => (edits[change.id] = edits[change.id] ?? ({}))
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
    state.scenes = state.scenes ?? (new Set(SCENE_TEXT.slice(0, 4).map(([id]) => id)))
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
