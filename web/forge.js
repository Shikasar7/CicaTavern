// 创作角色卡: making a card by talking it through (server/forge/).
//   Home:     say the idea in a sentence, or pick up a draft.
//   聊想法:   each round the guide says what it understood and asks a few key
//             questions; every option carries a sample line to choose by feel.
//             The sketch beside it fills in as choices are made; any item can
//             be edited or locked.
//   定方案:   the talk written up as a plan; comment on any part and have it revised.
//   动笔:     the plan written out step by step (progress shown; a stopped run carries on).
//   打磨:     read and edit the card, have any piece rewritten by a note, draw or
//             upload the avatar, save it as a card and export the PNG.
// The model works in the background; the window polls the draft while it does.
import { t, zh } from '/i18n.js'
import { EVENT_RATES, bookValue, cleanPath, cleanStatusSpec, rangeOf, settlePicks } from '/shared/status.js'
import { splitPath } from '/shared/vars.js'
import { statusBar } from '/status.js'
import { REFERENCE_FILES, referenceBody, referenceChips } from '/talk.js'
import { historyStrip } from '/draw-choice.js'

// On a phone the keyboard's Enter key starts a new line (it has no Shift+Enter); the button sends.
const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)')
const sendsOnEnter = event => event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touchKeyboard.matches
const STEPS = [
  ['discuss', t`聊想法`],
  ['plan', t`定方案`],
  ['write', t`动笔`],
  ['polish', t`打磨与头像`],
]
// Examples to start from, by kind of card; 换一批 draws four (from all of them while the kind is not said).
const EXAMPLES = {
  single: [
    t`雨夜便利店里遇到的神秘女孩，氛围安静一点`,
    t`修仙宗门里嘴硬心软的师姐`,
    t`末日废土上陪我赶路的旧型机器人`,
    t`每天同一班末班车上，坐在对面看书的人`,
    t`被我从河边捡回家、不肯说出来历的少年`,
    t`古董钟表店里，修了一百年钟的店主`,
    t`我的新室友，好像不太会当人类`,
    t`宫里新来的女官，奉命盯着失宠的我`,
  ],
  ensemble: [
    t`民国旧宅的侦探事务所，我是新来的助手`,
    t`乐队解散前的最后一个夏天，四个人各怀心事`,
    t`山间温泉旅馆，三姐妹和突然上门的继承人`,
    t`王立魔法学院的问题班级，我是新来的班主任`,
    t`一艘深空货船上的五个船员，和一个偷渡客`,
    t`江湖客栈里的掌柜、厨子和跑堂，都有一段过去`,
    t`社团活动室里，三个总也凑不齐人的推理社成员`,
  ],
  world: [
    t`浮空群岛之间跑货的飞艇，我是新雇的领航员`,
    t`一座每晚都会重排街道的城市`,
    t`灵气复苏后的现代都市，我刚觉醒了没用的能力`,
    t`深海殖民站断了联络的第七天`,
    t`妖怪和人类混住的老商店街，我继承了一家杂货铺`,
    t`王朝末年的边关小城，三方势力都在等一封信`,
    t`被大雪封住的山中修道院，有人在夜里敲钟`,
  ],
  game: [
    t`三十天里攒够赎身的钱，从花街逃出去`,
    t`经营一家快倒闭的异世界酒馆，每天结一次账`,
    t`末日避难所的所长，食物、人心和外面的威胁`,
    t`从外门杂役开始修炼，有境界、灵石和宗门声望`,
    t`恋爱模拟：一个学期，四个可以攻略的人`,
    t`地下城探索：每层一个房间，血量、背包和线索`,
    t`宫斗：从答应一路往上，宠爱、位份和人脉`,
  ],
}
const brickLabel = brick => OPTION_GROUPS_LABELS[brick] ?? brick
const examplesFor = kind => (EXAMPLES[kind] ?? Object.values(EXAMPLES).flat())
/** Four examples of a kind at random, not the ones shown just now where there are enough. */
function drawExamples(kind, shown = []) {
  const pool = examplesFor(kind)
  const fresh = pool.filter(text => !shown.includes(text))
  const from = fresh.length >= 4 ? fresh : pool
  return [...from].sort(() => Math.random() - 0.5).slice(0, 4)
}
// The picks about the card before talking (server/forge/prompts.mjs CARD_CHOICES), in groups that combine.
// one: a single value ('' = not said, the guide goes by the talk); many: any of them; flag: on or off.
const OPTION_GROUPS = [
  { key: 'cast', kind: 'one', label: t`人物`, values: [['', t`不定`], ['single', t`一个主角`], ['ensemble', t`几个主角（群像）`]], hint: t`群像：两到四个主要角色，各有目的，彼此之间也有关系。` },
  { key: 'world', kind: 'flag', label: t`世界观`, values: [[false, t`不强调`], [true, t`重世界观`]], hint: t`地点、势力、规则写得具体，模型兼任叙述者，适合冒险、探索、模拟。可以和群像、玩法一起选。` },
  { key: 'gender', kind: 'one', label: t`角色性别`, values: [['', t`不限`], ['female', t`女性`], ['male', t`男性`], ['mixed', t`男女都有`]], hint: t`核心角色的性别；给我灵感和交给 Cica 也按它来。` },
  // <user>'s own: how the card calls them. 不限 sends nothing; the summary says whose gender it is.
  { key: 'userGender', kind: 'one', label: t`你的性别`, values: [['', t`不限`], ['female', t`女`], ['male', t`男`]], short: label => t`你是${label}`, hint: t`你在故事里是男是女：角色怎么称呼你、用「他」还是「她」都按它写。这里不选，向导聊到你的身份时会问，你在聊天里说了也算。方案页还能改。` },
  { key: 'play', kind: 'many', label: t`玩法`, values: [['bond', t`好感与关系阶段`], ['growth', t`成长与能力`], ['resources', t`经营与资源`], ['countdown', t`倒计时与事件`], ['explore', t`探索与线索`], ['battle', t`战斗与成长`]], hint: t`可多选。每种玩法记录对应的数值：好感和信任（性格随它分阶段）、等级和修为、金钱和物资、剩余天数、解锁的地点和线索。战斗与成长用应用内置的规则，不占变量，开局就有检定、回合制战斗、背包和升级。` },
  { key: 'format', kind: 'one', label: t`格式`, values: [['', t`向导定`], ['text', t`纯文本卡`], ['mvu', t`MVU 变量卡`], ['mvu-ui', t`MVU + 美化状态栏`]], hint: t`纯文本：不记录数值。MVU：记录数值，每条回复下面有状态栏。美化状态栏：在 SillyTavern 里也显示成好看的面板（要装酒馆助手）。` },
  { key: 'statusTheme', kind: 'one', label: t`状态栏样式`, values: [['plain', t`简洁`], ['paper', t`古风纸笺`], ['neon', t`赛博霓虹`], ['pastel', t`柔和手账`]], when: options => options.format === 'mvu-ui' },
  // 高级选项: folded away, and nothing changes while none is picked. server/forge/bricks.mjs writes what the bricks put in a card.
  { key: 'bricks', kind: 'many', advanced: true, label: t`玩法积木`, values: [['books', t`背包和册子`], ['selfcheck', t`写前自查`], ['events', t`随机事件`], ['judge', t`裁判表`], ['world', t`世界动态`], ['creation', t`建角页`]], about: {
    books: t`玩的时候能增能减的记录：物品、认识的人、任务、回忆、线索。向导按卡定一到三本，状态栏里显示成表格。`,
    selfcheck: t`模型写之前先过一遍这张卡最容易写崩的地方，比如人物说话走样、设定前后打架。玩家看不到这段，每轮多写一小段。`,
    events: t`程序每轮抽一次，抽中了就发生：路上碰到的人、日常小事、远处传来的消息。不用记数值，纯文本卡也能用。`,
    judge: t`用等级决定成败，不让模型放水：修为、关系深度、势力实力都能比。模型照表判定，SillyTavern 里也有效。和「战斗与成长」只能留一个。`,
    creation: t`开局先填一张表再开始故事：选出身、分点数、写一小段，也能全部随机。填完模型按你选的写开场，写进变量。不想填可以换到普通开场白。`,
    world: t`你不动，世界也在变：几件事各有进度，程序隔几轮推一件往前走一步，模型用一两句让你听到风声。状态栏里看得到走到哪一步。`,
  } },
  { key: 'eventRate', kind: 'one', advanced: true, label: t`事件多常见`, values: [['', t`交给向导`], ['rare', t`偶尔`], ['normal', t`常见`], ['often', t`频繁`]], hint: t`偶尔：约八轮一次。常见：约五轮一次。频繁：约三轮一次。`, when: options => options.bricks.includes('events') },
  { key: 'judgeDice', kind: 'one', advanced: true, label: t`运气`, values: [['', t`交给向导`], ['on', t`平手看骰子`], ['off', t`不看运气`]], hint: t`等级一样时怎么定：程序掷骰子，或者由模型按故事判。`, when: options => options.bricks.includes('judge') },
  { key: 'worldRate', kind: 'one', advanced: true, label: t`世界动得多快`, values: [['', t`交给向导`], ['rare', t`慢`], ['normal', t`中`], ['often', t`快`]], hint: t`慢：约八轮动一步。中：约五轮。快：约三轮。`, when: options => options.bricks.includes('world') },
  { key: 'scale', kind: 'one', advanced: true, label: t`卡的规模`, values: [['', t`轻量`], ['standard', t`标准`], ['epic', t`大作`]], hint: t`轻量和以前一样。标准：最多 30 个角色、20 个地点、120 个变量。大作：最多 60 个角色、40 个地点、200 个变量。方案页就是世界目录，配角和地点先写一句话，看过再分批写，写卡的时间和花费都会多很多。` },
  { key: 'statusTheme', kind: 'one', advanced: true, label: t`更多样式`, values: [['ink', t`水墨`], ['parchment', t`羊皮卷`], ['gothic', t`暗夜`], ['terminal', t`终端`], ['ocean', t`深海`], ['auto', t`按卡配色`]], hint: t`按卡配色：向导按这张卡的气氛挑颜色，方案页还能改。`, when: options => options.format === 'mvu-ui' },
  { key: 'statusPages', kind: 'flag', advanced: true, label: t`状态栏分页`, values: [[false, t`一页`], [true, t`分几页`]], hint: t`变量多时分成几页，比如概览、册子、人物，向导按卡分。`, when: options => options.format === 'mvu-ui' },
]
// Words that ask for another card's own text. Asked for with a card only being learned from, the page asks first.
const COPY_WORDS = /照搬|照抄|抄过来|搬过来|原文|原样|原封不动|一模一样|复制(这张|那张|它|原)|照着(它|这张|那张|原卡)写|直接用(它|这张|那张|原卡|原来)/
const OPTION_GROUPS_LABELS = Object.fromEntries(OPTION_GROUPS.find(group => group.key === 'bricks').values)
const NO_OPTIONS = { cast: '', world: false, gender: '', userGender: '', play: [], format: '', statusTheme: 'plain', bricks: [], eventRate: '', judgeDice: '', worldRate: '', scale: '', statusPages: false }
/** The examples that fit the picks (EXAMPLES is by the old kinds). */
const exampleKind = options => (options.play?.length || options.format.startsWith('mvu') ? 'game' : options.world ? 'world' : options.cast || '')
/** The picks in a few words, for the sketch's folded row. */
function optionsSummary(options) {
  const words = OPTION_GROUPS.flatMap(group => {
    if (group.when && !group.when(options)) return []
    const value = options[group.key]
    if (group.kind === 'many') return value.map(v => group.values.find(([key]) => key === v)?.[1]).filter(Boolean)
    if (group.kind === 'flag') return value ? [group.values[1][1]] : []
    const label = value && !(group.key === 'statusTheme' && value === 'plain') ? group.values.find(([key]) => key === value)?.[1] : ''
    return label ? [group.short ? group.short(label) : label] : []
  })
  return words.length ? words.join(t`、`) : t`都交给向导`
}
// 出三版来挑: the angle each version takes (server/forge/prompts.mjs PLAN_ANGLES).
const PLAN_ANGLE = { close: t`贴着聊的来`, bold: t`更大胆`, shift: t`换个切入` }
// The cliché checks' names (server/forge/write.mjs LINT), which the draft keeps in Chinese.
const LINT_TEXT = new Map([
  [zh`破折号`, t`破折号`], [zh`模糊词`, t`模糊词`], [zh`表情套话`, t`表情套话`], [zh`声线套话`, t`声线套话`],
  [zh`陈旧比喻`, t`陈旧比喻`], [zh`夸张情绪`, t`夸张情绪`], [zh`否定转折`, t`否定转折`], [zh`名称不具体`, t`名称不具体`],
  [zh`写给作者的话`, t`写给作者的话`], [zh`隔着讲情绪`, t`隔着讲情绪`], [zh`假主语`, t`假主语`], [zh`解释原因`, t`解释原因`],
])
/** An entry's name, or "开场白2" (how the server names an opening) as the page says it. */
const pieceName = target => {
  const n = /^开场白(\d+)$/.exec(target)?.[1]
  return n ? t`开场 ${n}` : target
}
// A plan's world kind, which the server keeps as 真实 or 架空 whatever the card's language.
const WORLD_KIND = new Map([[zh`真实`, t`真实`], [zh`架空`, t`架空`]])
const STRATEGY = { constant: [t`常驻`, 'on'], keyword: [t`提到时`, 'key'], off: [t`不发送`, 'off'] }
const POSITION = { before: t`角色定义前`, after: t`角色定义后`, depth: t`上下文末尾` }
const STAGE_TEXT = { discuss: t`聊想法`, plan: t`定方案`, write: t`动笔`, polish: t`打磨与头像` }
// How a tracked variable shows in the status bar, and the value type each implies (hidden keeps its own).
const SHOWS = [['meter', t`进度条`], ['number', t`数字`], ['rating', t`星级`], ['text', t`文字`], ['badge', t`徽章`], ['long', t`长文字`], ['tags', t`标签`], ['list', t`列表`], ['table', t`表格`], ['flag', t`是或否`], ['hidden', t`不显示`]]
const SHOW_TYPE = { meter: 'number', number: 'number', rating: 'number', text: 'string', badge: 'string', long: 'string', tags: 'list', list: 'list', table: 'book', flag: 'boolean' }

/** The variables' initial values as the card's [InitVar] will have them (server/forge/write.mjs typedValue). */
function initialOf(variables) {
  const root = {}
  for (const v of variables) {
    const keys = splitPath(cleanPath(v.path))
    if (!keys.length) continue
    const raw = String(v.initial ?? '').trim()
    let value = raw
    if (v.type === 'number') value = Number.isFinite(Number(raw)) && raw !== '' ? Number(raw) : 0
    else if (v.type === 'boolean') value = /^(true|是|有|1)$/i.test(raw) // i18n-ignore: values typed into the card
    else if (v.type === 'list') value = raw ? raw.split(/[、,，]/).map(s => s.trim()).filter(Boolean) : []
    else if (v.type === 'book') value = bookValue(raw, v.columns)
    let at = root
    for (const key of keys.slice(0, -1)) at = at[key] = at[key] && typeof at[key] === 'object' ? at[key] : {}
    at[keys.at(-1)] = value
  }
  return root
}
const MANAGE_PROVIDERS = '__manage_providers__'
const ICON_LOCK = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>'
const ICON_OPEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 5.6-1.5"/></svg>'
const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>'
const ICON_NEW = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>'

function ago(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return t`刚刚`
  if (min < 60) return t`${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return t`${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days === 1 ? t`昨天` : t`${days} 天前`
}

/** Any picture the page can load, as PNG (cards carry their data in PNG text chunks); also used by 修改角色卡. */
export async function pngOf(url) {
  const img = new Image()
  // onload rather than decode(): decode() can wait forever while the page is in the background.
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error(t`读不了头像图片，换一张试试`))
    img.src = url
  })
  const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

/**
 * @param deps - { api, el, toast, guard, openProviders, onCardSaved, startChatWith, makeVisualNovel(cardId, places),
 *   pickDraw(options) (web/draw-choice.js: the 画图方式 and model for the avatar), openTrial(cardId, { changed }) (试玩体检) }
 */
export function initForge({ api, el, toast, guard, saveDownload = null, openProviders, onCardSaved, startChatWith, makeVisualNovel, pickDraw, openTrial, onClosed }) {
  const $ = id => document.getElementById(id)
  const dialog = $('forge-dialog')
  const state = {
    draft: null, // the open draft as the server shows it; null on the home view
    list: [],
    models: [],
    defaultModel: '',
    // Picks for the latest round: question id → { labels: Set, delegate, custom, other }.
    picks: new Map(),
    picksFor: '', // `${draftId}:${round}` the picks belong to
    notes: new Map(), // plan section → comment
    planText: '',
    idea: '',
    references: [], // the home view's files, as the server read them, for the new draft
    homeReading: '', // which of them is open
    readingRef: '', // the draft's reference open above the box
    options: { ...NO_OPTIONS }, // the home view's picks for a new draft (OPTION_GROUPS)
    ideas: [], // 给我灵感: the batch shown
    ideasSeen: [], // titles shown so far, for 换一批 to bring new ones
    ideasBusy: false,
    examples: null, // the examples shown before any ideas (drawExamples)
    cicaBusy: false, // 交给 Cica: one idea being thought of
    previewValues: {}, // 数值预览: draft id → path → value where the sliders are
    homeModel: '',
    retryPick: { key: '', model: '' }, // 换个模型重写: the model picked under an error (key: the draft and the error)
    poll: null,
    shown: '', // what the main area last showed, to re-render only on change
    open: new Set(), // entries shown in full on the polish view
    editing: null, // the piece being edited by hand: entry name, "开场白N", "description" or "notes"
    // What that editor holds ({ draftId, target, text }), kept until saved or dropped: the column is drawn again
    // when an entry opens, a picture comes or a rewrite starts, and the typing went with it.
    editText: null,
    noteFor: null, // the piece a rewrite note is being written for
    noteText: '',
    avatarDesc: null, // the avatar scene as the user edits it; null = the plan's
    settingsName: '', // 设置 → 你的名字; '' when not filled in (the default 你)
  }
  const view = {}

  // ─── Skeleton ─────────────────────────────────────────────────────────
  function layout() {
    view.title = el('span', { class: 'forge-sub' })
    view.steps = el('ol', { class: 'forge-steps' })
    view.model = el('select', { class: 'forge-model', title: t`和你聊、写方案用哪个模型`, onchange: () => changeModel() })
    // Back to the start: a new card, or another draft. Words, not just an icon: as an icon it went unnoticed.
    view.home = el('button', { type: 'button', class: 'btn ghost small forge-new', title: t`回到开始页：写一张新卡，或打开别的草稿`, onclick: () => goHome() }, [el('span', { html: ICON_NEW }), el('span', { text: t`新卡 · 草稿` })])
    const close = el('button', { type: 'button', class: 'btn ghost icon', title: t`关闭（草稿会保留）`, 'aria-label': t`关闭`, html: ICON_CLOSE, onclick: () => dialog.close() })
    view.main = el('div', { class: 'forge-main' })
    view.sketch = el('aside', { class: 'forge-sketch' })
    view.composer = el('textarea', {
      class: 'forge-input',
      rows: 2,
      placeholder: t`也可以直接说想法，比如：想要她说话带点毒舌`,
      oninput: () => updateFoot(),
      onkeydown: event => {
        if (sendsOnEnter(event)) {
          event.preventDefault()
          send()
        }
      },
    })
    view.planText = el('textarea', { class: 'forge-input', rows: 2, placeholder: t`对方案的总体意见，比如：配角太多了，只留店长`, oninput: () => { state.planText = view.planText.value; updateFoot() } })
    view.file = el('input', { type: 'file', accept: REFERENCE_FILES, multiple: true, hidden: true, onchange: () => addFiles() })
    view.attach = attachButton()
    view.attachPlan = attachButton()
    view.refList = el('div', { class: 'ce-refs' })
    view.refText = el('div', { class: 'ce-ref-text', hidden: true })
    view.refStudy = el('div', { class: 'forge-study-list' })
    view.refs = el('div', { class: 'forge-refbar', hidden: true }, [view.refList, view.refStudy, view.refText])
    view.pickCount = el('span', { class: 'forge-count' })
    view.undo = el('button', { type: 'button', class: 'btn ghost small', text: t`撤回上一轮`, title: t`去掉你上一次的回答和向导对它的回复`, onclick: () => undo() })
    view.toPlan = el('button', { type: 'button', class: 'btn', text: t`差不多了，出方案`, onclick: () => makePlan() })
    view.toPlans = el('button', { type: 'button', class: 'btn ghost', text: t`出三版来挑`, title: t`同一段讨论写出三版方案：贴着聊的、更大胆的、换个切入的，挑一版再改。花的额度和时间多一些。`, onclick: () => makePlan(true) })
    view.send = el('button', { type: 'button', class: 'btn primary', text: t`继续聊`, onclick: () => send() })
    view.back = el('button', { type: 'button', class: 'btn ghost', text: t`回去接着聊`, onclick: () => setStage('discuss') })
    view.revise = el('button', { type: 'button', class: 'btn', text: t`按意见修改方案`, onclick: () => revise() })
    view.write = el('button', { type: 'button', class: 'btn primary', text: t`开始写这张卡`, onclick: () => startWrite() })
    view.rewriteAll = el('button', { type: 'button', class: 'btn ghost', text: t`按这个方案重写`, title: t`从头再写一遍：已写的内容和你的修改会被替换`, onclick: () => startWrite(true) })
    view.toPlanBack = el('button', { type: 'button', class: 'btn ghost', text: t`回到方案`, onclick: () => setStage('plan') })
    view.saved = el('span', { class: 'forge-count' })
    view.chat = el('button', { type: 'button', class: 'btn', text: t`开始对话`, onclick: () => startChat() })
    // Opens the window only: nothing is sent until 开始试玩 there (every run costs).
    view.trial = el('button', { type: 'button', class: 'btn', text: t`试玩体检`, onclick: () => startTrial() })
    view.vn = el('button', { type: 'button', class: 'btn', text: t`做成视觉小说`, title: t`保存这张卡，开一个新对话进入视觉小说模式：选画图方式，备齐角色名册、立绘和表情，再给方案里的地点画背景`, onclick: () => startVn() })
    view.png = el('a', { class: 'btn', text: t`导出 PNG`, title: t`图片里带着整张卡，SillyTavern 可以直接导入`, onclick: event => {
      // The phone app saves it itself (saveDownload).
      if (!saveDownload) return
      event.preventDefault()
      const link = new URL(view.png.href)
      saveDownload(link.pathname + link.search, view.png.download, 'image/png')
    } })
    view.save = el('button', { type: 'button', class: 'btn primary', text: t`保存为角色卡`, onclick: () => saveCard() })
    view.polishFoot = el('div', { class: 'forge-foot' }, [el('div', { class: 'forge-actions' }, [view.toPlanBack, el('span', { class: 'grow' }), view.saved, view.png, view.trial, view.vn, view.chat, view.save])])
    view.discussFoot = el('div', { class: 'forge-foot' }, [view.composer, el('div', { class: 'forge-actions' }, [view.attach, view.pickCount, el('span', { class: 'grow' }), view.undo, view.toPlans, view.toPlan, view.send])])
    view.planFoot = el('div', { class: 'forge-foot' }, [view.planText, el('div', { class: 'forge-actions' }, [view.back, view.attachPlan, el('span', { class: 'grow' }), view.rewriteAll, view.revise, view.write])])
    view.body = el('div', { class: 'forge-body' }, [view.main, view.sketch])
    dialog.replaceChildren(
      el('div', { class: 'forge' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: t`创作角色卡` }), view.title]),
          view.steps,
          el('div', { class: 'forge-tools' }, [view.model, view.home, close]),
        ]),
        view.body,
        view.refs,
        view.discussFoot,
        view.planFoot,
        view.polishFoot,
        view.file,
      ]),
    )
  }

  function attachButton() {
    return el('button', { type: 'button', class: 'btn ghost small', text: t`附文件`, title: t`附资料给向导读：设定、小说原文（txt、md），一张卡（PNG、JSON），或世界书。之后聊天、写方案和写卡都照着它`, onclick: () => view.file.click() })
  }

  // ─── Data ─────────────────────────────────────────────────────────────
  async function loadModels() {
    const data = await api('/api/models').catch(() => ({ choices: [], defaultModel: '' }))
    state.models = data.choices.filter(m => m.id.includes('/'))
    state.defaultModel = data.defaultModel || ''
  }

  function apply(draft) {
    const before = state.draft
    state.draft = draft
    // A job started or going on: watched, so the chip shows once the dialog is closed (however it closes).
    if (draft.job && !background.timer) watchBackground()
    // A new round, or the same round answered again (换一组问题): new questions, fresh picks.
    const round = `${draft.id}:${draft.rounds.length}:${draft.rounds.at(-1)?.assistant?.at ?? ''}`
    if (state.picksFor !== round) {
      state.picks = new Map()
      state.picksFor = round
    }
    if (before?.id !== draft.id) {
      state.notes = new Map()
      state.avatarDesc = null
      state.planText = ''
      view.composer.value = ''
      view.planText.value = ''
    }
    render()
    schedule()
  }

  function schedule() {
    clearTimeout(state.poll)
    if (!state.draft?.job || !dialog.open) return
    const id = state.draft.id
    state.poll = setTimeout(async () => {
      try {
        if (state.draft?.id === id) apply(await api(`/api/forge/${id}`))
      } catch {
        schedule()
      }
    }, 900)
  }

  // ─── Rendering ────────────────────────────────────────────────────────
  function render() {
    const draft = state.draft
    view.title.textContent = draft ? draft.title : ''
    renderSteps()
    renderModels()
    view.home.hidden = !draft
    view.body.classList.toggle('home', !draft)
    // Writing and polishing are about the card itself: the talk's sketch steps aside.
    view.body.classList.toggle('wide', Boolean(draft && (draft.stage === 'write' || draft.stage === 'polish')))
    view.discussFoot.hidden = !draft || draft.stage !== 'discuss'
    view.planFoot.hidden = !draft || draft.stage !== 'plan'
    view.polishFoot.hidden = !draft || draft.stage !== 'polish'
    renderMain()
    renderSketch()
    renderReferences()
    updateFoot()
  }

  /** The draft's material, above the box while there is talk to go by it. */
  function renderReferences() {
    const draft = state.draft
    const list = draft && (draft.stage === 'discuss' || draft.stage === 'plan') ? draft.references ?? [] : []
    view.refs.hidden = !list.length
    const key = JSON.stringify([draft?.id, list.map(item => [item.id, item.mode]), Boolean(draft?.job)])
    if (key === state.refsShown) return
    state.refsShown = key
    if (!list.some(item => item.id === state.readingRef)) closeReading()
    view.refList.replaceChildren(...(list.length ? referenceChips(el, list, { open: toggleReading, drop: dropReference, locked: Boolean(draft.job), studied: true }) : []))
    view.refStudy.replaceChildren(...list.filter(item => item.structure).map(item => studyRow(item, { locked: Boolean(draft.job), change: changeDraftMode })))
  }

  /** A card among the material: what is being learned from it, and the way to its content. */
  function studyRow(item, { locked = false, change, take = null }) {
    const { title, bricks } = item.structure
    const copying = item.mode === 'content'
    const found = bricks.map(brickLabel)
    return el('div', { class: 'forge-study' }, [
      el('span', { class: 'hint', text: copying ? t`「${title}」：使用原文。做出来的卡会写明参考了它和它的作者。` : found.length ? t`「${title}」：只学结构，不读内容。认出了${found.join(t`、`)}。` : t`「${title}」：只学结构，不读内容。` }),
      take && !copying ? el('button', { type: 'button', class: 'btn ghost small', text: t`照这个结构选上`, onclick: () => take(item) }) : null,
      el('button', { type: 'button', class: 'btn ghost small', disabled: locked, text: copying ? t`改回只学结构` : t`使用原文…`, onclick: guard(async () => change(item, !copying)) }),
    ].filter(Boolean))
  }

  /** Whether the player says the author allows it: nothing of the card's reaches the model before they do. */
  function askToCopy({ title, author, notes }) {
    return new Promise(resolve => {
      const box = el('input', { type: 'checkbox' })
      const go = el('button', { type: 'button', class: 'btn primary', disabled: true, text: t`使用原文` })
      box.addEventListener('change', () => { go.disabled = !box.checked })
      const done = answer => {
        dialog.close()
        dialog.remove()
        resolve(answer)
      }
      go.addEventListener('click', () => done(true))
      const dialog = el('dialog', { class: 'dialog forge-copy' }, [
        el('h2', { text: t`要用「${title}」里的原文和素材吗？` }),
        el('p', { text: t`这张卡的内容属于它的作者。很多卡写明了不许二传和二创，请先看作者的说明，确认对方允许这样使用，尊重作者的版权。` }),
        el('p', { class: 'hint', text: author ? t`原作者：${author}` : t`这张卡没有写作者，确认起来要更小心。` }),
        notes ? el('blockquote', { text: notes }) : null,
        el('p', { text: t`确认之后，向导会读这张卡的全文。做出来的卡，作者写你的名字，不写 CicaTavern，简介末尾写上参考的卡名、原作者和声明。` }),
        el('p', { class: 'hint', text: t`免责声明：CicaTavern 不检查授权，也不替你承担责任。用不用、怎么用由你决定，由此产生的责任由你承担。` }),
        el('label', { class: 'check-row' }, [box, el('span', { text: t`我已确认原作者允许这样使用` })]),
        el('div', { class: 'row forge-copy-actions' }, [el('button', { type: 'button', class: 'btn ghost', text: t`只学结构`, onclick: () => done(false) }), go]),
      ].filter(Boolean))
      dialog.addEventListener('cancel', event => {
        event.preventDefault()
        done(false)
      })
      document.body.append(dialog)
      dialog.showModal()
    })
  }

  const changeDraftMode = async (item, copying) => {
    if (copying && !(await askToCopy(item.structure))) return
    apply(await api(`/api/forge/${state.draft.id}/references/${item.id}`, { method: 'PUT', body: { mode: copying ? 'content' : 'structure', confirmed: copying } }))
  }

  const changeHomeMode = async (item, copying) => {
    if (copying && !(await askToCopy(item.structure))) return
    item.mode = copying ? 'content' : 'structure'
    item.confirmed = copying
    redrawHome()
  }

  /** 照这个结构选上: what was found in the card, as picks of the player's own to change. */
  function takeStructure({ structure }) {
    const next = { ...state.options, bricks: [...new Set([...state.options.bricks, ...structure.bricks])], ...(structure.scale ? { scale: structure.scale } : {}), ...(structure.format !== 'text' ? { format: structure.format } : {}) }
    state.options = settlePicks(next, state.options)
    state.advancedOpen = true
    redrawHome()
    toast(t`已选上，可以在高级选项里再改。`)
  }

  /** Before words that ask for a card's text go out: the same question as the button's. */
  async function offerCopy(text, cards, change) {
    if (!COPY_WORDS.test(text)) return
    for (const item of cards.filter(card => card.structure && card.mode !== 'content')) await change(item, true)
  }

  function closeReading() {
    state.readingRef = ''
    view.refText.hidden = true
    view.refText.replaceChildren()
  }

  function renderSteps() {
    const draft = state.draft
    const at = draft ? STEPS.findIndex(([id]) => id === draft.stage) : -1
    const key = JSON.stringify([draft?.id, at, Boolean(draft?.job), Boolean(draft?.plan), Boolean(draft?.card), Boolean(draft?.card?.writtenAt)])
    if (key === state.stepsShown) return
    state.stepsShown = key
    view.steps.replaceChildren(
      ...STEPS.map(([id, label], i) => {
        const has = { discuss: true, plan: Boolean(draft?.plan), write: Boolean(draft?.card), polish: Boolean(draft?.card?.writtenAt) }
        const reachable = draft && !draft.job && has[id]
        const done = i < at || (has[id] && id !== 'write' && i !== at) || (id === 'write' && draft?.card?.writtenAt)
        return el('li', { class: i === at ? 'now' : done ? 'done' : '' }, [
          el('button', { type: 'button', disabled: !reachable || i === at, onclick: () => setStage(id) }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { text: label })]),
        ])
      }),
    )
  }

  /** `force`: rebuild even when nothing changed (to put the choice back after 管理模型供应商…). */
  function renderModels(force = false) {
    const draft = state.draft
    const current = draft ? draft.model : state.homeModel
    const known = state.models.some(m => m.id === state.defaultModel)
    const label = m => `${m.group} · ${m.label}`
    view.model.disabled = Boolean(draft?.job)
    // Rebuilding the list on every poll would also close it under the user's mouse.
    const key = JSON.stringify([current, state.defaultModel, state.models.map(label)])
    if (!force && key === state.modelsShown) return
    state.modelsShown = key
    view.model.replaceChildren(
      ...[
        el('option', { value: '', selected: !current, text: known ? t`默认模型（${label(state.models.find(m => m.id === state.defaultModel))}）` : t`默认模型（还没选）` }),
        ...state.models.map(m => el('option', { value: m.id, selected: m.id === current, text: label(m) })),
        current && !state.models.some(m => m.id === current) ? el('option', { value: current, selected: true, text: t`${current}（不可用）` }) : null,
        el('option', { value: MANAGE_PROVIDERS, text: t`管理模型供应商…` }),
      ].filter(Boolean),
    )
  }

  /** In the talk, keep the reader at the bottom when they were there; elsewhere, where they were. */
  function keepScroll(fn, stick) {
    const box = view.main
    const atBottom = stick && box.scrollHeight - box.scrollTop - box.clientHeight < 80
    const top = box.scrollTop
    fn()
    box.scrollTop = atBottom ? box.scrollHeight : top
  }

  /** What the main column shows, as a key: it is redrawn only when this changes. */
  function mainKey(draft) {
    // The job counts by which one it is, not by its progress: fillBusy keeps that current.
    const job = draft?.job ? [draft.job.kind, draft.job.step, draft.job.startedAt] : null
    return draft ? JSON.stringify([draft.id, draft.stage, draft.rounds.length, draft.rounds.at(-1)?.assistant?.at, job, draft.error, draft.plan ? draft.updatedAt : '', state.editing, state.noteFor, [...state.open].join()]) : `home:${state.list.length}:${state.list.map(d => d.updatedAt).join()}`
  }

  function renderMain() {
    const draft = state.draft
    const key = mainKey(draft)
    if (key === state.shown) {
      if (draft?.job && state.busy?.working.isConnected) keepScroll(() => fillBusy(draft.job), draft.stage === 'discuss')
      if (draft?.job && state.writeClock?.isConnected) state.writeClock.textContent = state.writeClock.dataset.prefix + elapsed(draft.job.startedAt)
      return
    }
    // A different draft or stage starts at its top (the talk at its newest round).
    const place = draft ? `${draft.id}:${draft.stage}` : 'home'
    const first = state.place !== place
    state.place = place
    state.shown = key
    keepScroll(() => {
      if (!draft) view.main.replaceChildren(homeView())
      else if (draft.stage === 'polish' && draft.card) view.main.replaceChildren(polishView(draft))
      else if (draft.stage === 'write' && draft.card) view.main.replaceChildren(writeView(draft))
      else if (draft.stage === 'plan' && draft.plan && !(draft.job?.kind === 'discuss')) view.main.replaceChildren(planView(draft))
      else view.main.replaceChildren(threadView(draft))
    }, draft?.stage === 'discuss')
    if (first) view.main.scrollTop = draft && draft.stage !== 'discuss' ? 0 : view.main.scrollHeight
  }

  // ─── Home ─────────────────────────────────────────────────────────────
  function homeView() {
    const idea = el('textarea', {
      class: 'forge-idea',
      rows: 3,
      placeholder: t`比如：雨夜便利店里遇到的神秘女孩，氛围安静一点`,
      oninput: () => (state.idea = idea.value),
      onkeydown: event => {
        if (sendsOnEnter(event)) {
          event.preventDefault()
          start()
        }
      },
    })
    idea.value = state.idea
    const drafts = state.list.map(d =>
      el('li', { onclick: () => openDraft(d.id) }, [
        el('div', { class: 'item-main' }, [
          el('div', { class: 'item-title' }, [d.title, d.busy ? el('span', { class: 'busy-dot', title: t`正在写` }) : null]),
          el('div', { class: 'item-sub', text: t`${STAGE_TEXT[d.stage] ?? d.stage} · 聊了 ${d.rounds} 轮 · ${ago(d.updatedAt)}` }),
        ]),
        el('button', { type: 'button', class: 'btn ghost small danger', text: t`删除`, onclick: event => { event.stopPropagation(); removeDraft(d) } }),
      ]),
    )
    const fill = text => {
      state.idea = idea.value = text
      idea.focus()
    }
    const study = state.references.filter(item => item.structure).map(item => studyRow(item, { change: changeHomeMode, take: takeStructure }))
    const attached = state.references.length ? el('div', { class: 'ce-refs' }, referenceChips(el, state.references, { open: toggleHomeReading, drop: dropHomeReference, studied: true })) : null
    const reading = state.references.find(item => item.id === state.homeReading)
    if (attached) idea.placeholder = t`想怎么用这些资料？也可以不写，向导读完会问你`
    const kinds = optionsPanel(state.options, next => {
      const kindBefore = exampleKind(state.options)
      state.options = next
      if (exampleKind(next) !== kindBefore) state.examples = null
      redrawHome()
    })
    const ideas = state.ideas.length
      ? state.ideas.map(item => el('button', { type: 'button', class: 'forge-idea-card', onclick: () => fill(t`${item.title}：${item.pitch}`) }, [
          el('b', { text: item.title }),
          el('span', { text: item.pitch }),
          item.tags.length ? el('span', { class: 'chips' }, item.tags.map(tag => el('span', { class: 'chip quiet', text: tag }))) : null,
        ]))
      : [
          ...(state.examples ??= drawExamples(exampleKind(state.options))).map(text => el('button', { type: 'button', class: 'chip', text, onclick: () => fill(text) })),
          el('button', { type: 'button', class: 'chip quiet', text: t`换一批`, title: t`从现成的例子里另抽几个`, onclick: () => {
            state.examples = drawExamples(exampleKind(state.options), state.examples)
            redrawHome()
          } }),
        ]
    return el('div', { class: 'forge-home' }, [
      el('h3', { class: 'forge-hero', text: t`想要一张什么样的卡？` }),
      el('p', { class: 'forge-lead', text: t`一句话就够。说不清楚也没关系：向导会一轮轮给你几个具体的选择，每个选项都附一句试读，凭感觉挑，慢慢就聊清楚了。` }),
      el('details', { class: 'forge-kind', open: state.optionsOpen !== false, ontoggle: event => (state.optionsOpen = event.target.open) }, [
        el('summary', {}, [el('span', { text: t`卡的设定` }), el('span', { class: 'hint', text: optionsSummary(state.options) })]),
        kinds,
      ]),
      idea,
      attached,
      study.length ? el('div', { class: 'forge-study-list' }, study) : null,
      // A card it only studies: what the model gets of it, not the card's text.
      reading ? el('div', { class: 'ce-ref-text' }, el('pre', { text: reading.structure && reading.mode !== 'content' && reading.brief ? reading.brief : reading.text })) : null,
      el('div', { class: 'forge-attach-row' }, [attachButton(), el('span', { class: 'hint', text: t`手上有设定或小说？附上它，向导会照着聊，写卡时也照着写。附别人的卡时默认只学结构，不读内容。` })]),
      el('div', { class: 'forge-ideas-head' }, [
        el('span', { class: 'hint', text: state.ideas.length ? t`点一个填进上面，可以再改` : t`没想好？` }),
        el('span', { class: 'row' }, [
          el('button', { type: 'button', class: 'btn small', disabled: state.ideasBusy, text: state.ideasBusy ? t`正在想…` : state.ideas.length ? t`换一批` : t`给我灵感`, title: t`按随机抽的舞台、关系和转折，想几张卡的点子`, onclick: () => inspire() }),
          el('button', { type: 'button', class: 'btn small', disabled: state.cicaBusy, text: state.cicaBusy ? t`Cica 在想…` : t`交给 Cica`, title: t`让 Cica 随便想一个，填进上面的输入框，可以再改`, onclick: () => askCica() }),
        ]),
      ]),
      el('div', { class: `forge-ideas${state.ideas.length ? ' cards' : ''}` }, ideas),
      el('div', { class: 'forge-start' }, [el('span', { class: 'hint', text: t`右上角可以换模型。写卡要动脑筋，强一点的模型效果更好。` }), el('button', { type: 'button', class: 'btn primary', text: t`开始聊`, onclick: () => start() })]),
      drafts.length ? el('h4', { class: 'forge-h', text: t`继续创作` }) : null,
      drafts.length ? el('ul', { class: 'forge-drafts' }, drafts) : null,
    ])
  }

  // ─── 聊想法 ───────────────────────────────────────────────────────────
  function threadView(draft) {
    const items = []
    draft.rounds.forEach((round, i) => {
      const last = i === draft.rounds.length - 1
      items.push(youBubble(round.user, i === 0))
      if (round.assistant) items.push(sayBlock(round.assistant, last && !draft.job && draft.stage === 'discuss'))
    })
    const last = draft.rounds.at(-1)
    if (draft.job) items.push(busyBlock(draft))
    else if (draft.error) items.push(errorBlock(draft.error))
    else if (!last.assistant) items.push(errorBlock({ message: t`这一轮还没有回复。` }))
    if (draft.stage === 'plan' && draft.job?.kind === 'discuss') items.push(el('p', { class: 'hint', text: t`方案会在这一轮聊完后保留。` }))
    return el('div', { class: 'forge-thread' }, items)
  }

  function youBubble(user, first) {
    const parts = []
    if (!first) for (const pick of user.picks) parts.push(el('div', { class: 'forge-picked' }, [el('span', { class: 'q', text: pick.title }), el('span', { class: 'a', text: pick.delegate ? t`你来定` : pick.custom ? t`都不是：${pick.custom}` : pick.labels.join(t`、`) })]))
    if (user.text) parts.push(el('p', { text: user.text }))
    return el('div', { class: 'forge-you' }, parts)
  }

  function sayBlock(assistant, live) {
    const paragraphs = assistant.reply.split(/\n+/).filter(Boolean).map(p => el('p', { text: p }))
    const questions = live ? assistant.questions.map(questionCard) : []
    const asked = !live && assistant.questions.length ? el('p', { class: 'forge-asked', text: t`问了：${assistant.questions.map(q => q.title).join(' · ')}` }) : null
    const note = live && assistant.unreadable ? el('p', { class: 'hint warn', text: t`这次回复的格式不完整，问题或草图没能读出来。可以点「换一组问题」重来。` }) : null
    const tools = live
      ? el('div', { class: 'forge-say-tools' }, [
          el('span', { class: 'forge-by', text: assistant.model }),
          el('button', { type: 'button', class: 'btn ghost small', text: t`换一组问题`, title: t`让向导重新回这一轮`, onclick: () => retry() }),
        ])
      : null
    return el('div', { class: 'forge-say' }, [el('div', { class: 'forge-voice' }, paragraphs), note, ...questions, asked, tools])
  }

  // The job's progress (the reply as it streams in, the plan's length so far)
  // changes on every poll. It is filled into this block in place: rebuilding the
  // page for it replayed every bubble's fade-in, so the page flickered.
  function busyBlock(draft) {
    const stop = el('button', { type: 'button', class: 'btn ghost small', text: t`停下`, onclick: () => stopJob() })
    const voice = draft.job.kind === 'plan' ? null : el('div', { class: 'forge-voice' })
    const label = document.createTextNode('')
    const working = el('p', { class: 'forge-working' }, [el('span', { class: 'dots' }), label])
    // A moving bar and the time it has taken: a plan's bar follows what is written of it, talk just moves.
    const fill = el('i')
    const bar = el('div', { class: `forge-progress${draft.job.kind === 'plan' ? '' : ' unknown'}` }, fill)
    const clock = el('span', { class: 'forge-clock' })
    state.busy = { voice, working, label, fill, clock, startedAt: draft.job.startedAt }
    fillBusy(draft.job)
    return el('div', { class: 'forge-say busy' }, [voice, working, el('div', { class: 'forge-progress-row' }, [bar, clock]), el('div', { class: 'forge-say-tools' }, [stop])])
  }

  function fillBusy(job) {
    const { voice, label, fill, clock } = state.busy
    if (clock) clock.textContent = elapsed(job.startedAt)
    if (fill && job.kind === 'plan') fill.style.width = `${Math.round(Math.min(95, 4 + (job.chars ?? 0) / 80))}%`
    if (job.kind === 'plan') {
      const text = t`正在把聊过的内容写成创作方案${job.chars ? t`（已写 ${job.chars} 字）` : ''}，通常要一两分钟。可以关掉窗口，回来再看。`
      if (label.data !== text) label.data = text
      return
    }
    const paragraphs = job.partial ? job.partial.split(/\n+/).filter(Boolean) : []
    const shown = paragraphs.join('\n')
    if (voice && voice.dataset.shown !== shown) {
      voice.replaceChildren(...paragraphs.map(p => el('p', { text: p })))
      voice.dataset.shown = shown
    }
    const text = paragraphs.length ? t`在想接下来问什么…` : t`向导在想…`
    if (label.data !== text) label.data = text
  }

  /** 1:23 since an ISO time. */
  function elapsed(iso) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }

  function errorBlock(error) {
    return el('div', { class: 'forge-error' }, [
      el('p', { text: error.message }),
      el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`重试`, onclick: () => retry() })]),
      otherModel(error),
    ])
  }

  /**
   * 换个模型重写: another model for the failed step, this once (the draft keeps its own). Nothing is sent
   * until the button is clicked, and the line above it says what that would come to; never switched by itself.
   */
  function otherModel(error) {
    if (!error.kind || error.kind === 'avatar' || !state.draft) return null
    const choices = state.models.filter(m => m.id !== error.model)
    if (!choices.length) return null
    const id = state.draft.id
    // The failed model is in the key: a swapped model can fail with the very same message.
    const key = `${id}:${error.kind}:${error.model || ''}:${error.message}`
    if (state.retryPick.key !== key || !choices.some(m => m.id === state.retryPick.model)) state.retryPick = { key, model: '' }
    const pick = state.retryPick
    const line = el('p', { class: 'hint forge-other-cost' })
    const go = el('button', { type: 'button', class: 'btn small', text: t`换这个模型重写`, onclick: () => retry(pick.model) })
    const select = el('select', { class: 'forge-model', 'aria-label': t`换哪个模型重写这一步`, onchange: () => choose(select.value) }, [
      el('option', { value: '', text: t`换个模型…` }),
      ...choices.map(m => el('option', { value: m.id, selected: m.id === pick.model, text: `${m.group} · ${m.label}` })),
    ])
    const choose = async model => {
      pick.model = model
      go.disabled = !model
      line.textContent = model ? t`正在估算…` : t`这一步写坏了可以换个模型重写：只这一次用它，草稿的模型不变。`
      if (!model) return
      try {
        const estimate = await api(`/api/forge/${id}/retry?model=${encodeURIComponent(model)}`)
        if (pick.model !== model) return
        line.textContent = otherCost(estimate)
      } catch (failure) {
        if (pick.model === model) line.textContent = failure.message
      }
    }
    choose(pick.model)
    return el('div', { class: 'forge-other' }, [line, el('div', { class: 'row' }, [select, go])])
  }

  /** What a retry with another model would come to, as 换这个模型重写 says it. */
  function otherCost(estimate) {
    const lead = t`点了才发送，只这一步用 ${estimate.model}，草稿的模型不变。`
    if (estimate.input == null) return lead + t`这一步上次的用量没有记下，估不出要花多少。`
    const tokens = (estimate.input + estimate.output).toLocaleString()
    const money = estimate.cost == null ? t`（这个模型没有单价，估不出金额）` : t`，大约 $${estimate.cost.toFixed(3)}`
    return lead + (estimate.measured ? t`按这一步上次的用量，大约 ${tokens} token${money}。` : t`按这一步发出的内容和输出上限估算，最多大约 ${tokens} token${money}。`)
  }

  function pickOf(id) {
    if (!state.picks.has(id)) state.picks.set(id, { labels: new Set(), delegate: false, custom: '', other: false })
    return state.picks.get(id)
  }

  function questionCard(question) {
    const pick = pickOf(question.id)
    const card = el('section', { class: `forge-q ${question.kind}` })
    const paint = () => {
      for (const button of card.querySelectorAll('.forge-opt')) button.setAttribute('aria-pressed', String(pick.labels.has(button.dataset.label)))
      delegate.setAttribute('aria-pressed', String(pick.delegate))
      other.setAttribute('aria-pressed', String(pick.other))
      custom.hidden = !pick.other
      updateFoot()
    }
    const options = question.options.map(option =>
      el('button', {
        type: 'button',
        class: 'forge-opt',
        'data-label': option.label,
        onclick: () => {
          if (question.kind === 'multi') pick.labels.has(option.label) ? pick.labels.delete(option.label) : pick.labels.add(option.label)
          else pick.labels = pick.labels.has(option.label) ? new Set() : new Set([option.label])
          pick.delegate = false
          pick.other = false
          pick.custom = ''
          paint()
        },
      }, [
        el('b', { text: option.label }),
        option.detail ? el('span', { class: 'detail', text: option.detail }) : null,
        option.sample ? el('span', { class: 'sample', text: option.sample }) : null,
      ]),
    )
    const delegate = el('button', { type: 'button', class: 'chip', text: t`你来定`, title: t`交给向导挑最合适的`, onclick: () => { pick.delegate = !pick.delegate; pick.labels = new Set(); pick.other = false; paint() } })
    const other = el('button', { type: 'button', class: 'chip', text: t`都不是…`, onclick: () => { pick.other = !pick.other; pick.labels = new Set(); pick.delegate = false; paint(); if (pick.other) custom.focus() } })
    const custom = el('input', { type: 'text', class: 'forge-custom', placeholder: t`说说你想要的`, oninput: () => { pick.custom = custom.value.trim(); updateFoot() } })
    custom.value = pick.custom
    card.append(
      ...[
        el('header', {}, [el('h3', { text: question.title }), question.kind === 'multi' ? el('span', { class: 'tag', text: t`可多选` }) : null, question.kind === 'taste' ? el('span', { class: 'tag', text: t`凭感觉挑一段` }) : null]),
        question.why ? el('p', { class: 'why', text: question.why }) : null,
        el('div', { class: 'forge-opts' }, options),
        el('div', { class: 'forge-more' }, [delegate, other, custom]),
      ].filter(Boolean),
    )
    paint()
    return card
  }

  /** The picks as the server takes them; questions without an answer are left out. */
  function picksList() {
    const draft = state.draft
    const questions = draft?.rounds.at(-1)?.assistant?.questions ?? []
    return questions
      .map(q => {
        const pick = state.picks.get(q.id)
        if (!pick) return null
        const custom = pick.other ? pick.custom : ''
        if (!pick.labels.size && !pick.delegate && !custom) return null
        return { id: q.id, labels: [...pick.labels], delegate: pick.delegate, custom }
      })
      .filter(Boolean)
  }

  function updateFoot() {
    const draft = state.draft
    if (!draft) return
    const busy = Boolean(draft.job)
    const waiting = !draft.rounds.at(-1)?.assistant
    const picks = picksList().length
    const asked = draft.rounds.at(-1)?.assistant?.questions.length ?? 0
    view.pickCount.textContent = asked ? t`${picks} / ${asked} 个问题已选` : ''
    view.send.disabled = busy || waiting || (!picks && !view.composer.value.trim())
    view.toPlan.disabled = view.toPlans.disabled = busy || !draft.rounds.some(r => r.assistant)
    view.attach.disabled = view.attachPlan.disabled = busy
    view.toPlan.classList.toggle('ready', draft.brief.readiness >= 75)
    view.undo.hidden = draft.rounds.length < 2
    view.undo.disabled = busy
    view.composer.disabled = busy
    const notes = [...state.notes.values()].some(Boolean) || state.planText.trim()
    view.revise.disabled = busy || !notes
    view.revise.classList.toggle('primary', Boolean(notes))
    view.back.disabled = busy
    view.planText.disabled = busy
    // 定方案 → 动笔: once written, the main button goes back to the card; writing again is the quiet one.
    const card = draft.card
    view.write.textContent = card?.writtenAt ? t`回到打磨` : card ? t`接着写` : t`开始写这张卡`
    view.write.disabled = busy || Boolean(notes) || !draft.plan
    view.write.title = notes ? t`先按意见改好方案，再动笔` : ''
    view.write.classList.toggle('primary', !notes)
    view.rewriteAll.hidden = !card
    view.rewriteAll.disabled = busy
    // 打磨: save, then talk to it or take the PNG.
    const savedId = card?.savedCardId
    view.save.textContent = savedId ? t`更新这张卡` : t`保存为角色卡`
    view.save.disabled = busy
    view.chat.hidden = !savedId
    view.vn.hidden = !makeVisualNovel
    // The phone app's WebView saves no download: the link is left out there, as in 修改角色卡.
    view.png.hidden = !savedId || (document.documentElement.dataset.edition === 'android' && !saveDownload)
    if (savedId) {
      // The saved card as it is now: edits made in 修改角色卡 since are in it.
      view.png.href = `/api/cards/${savedId}/png?v=${encodeURIComponent(card.savedAt ?? '')}`
      view.png.download = `${draft.title}.png`
    }
    view.saved.textContent = !savedId ? '' : card.changedSinceSave ? t`已保存 ${ago(card.savedAt)}，之后的改动还没保存` : t`已保存 ${ago(card.savedAt)}`
    view.trial.hidden = !savedId || !openTrial
    view.trial.disabled = busy
    view.trial.title = card?.changedSinceSave
      ? t`试玩的是上次保存的卡，之后的改动不在里面；想试最新的，先点「更新这张卡」`
      : t`让模型替你玩几回合，查变量和格式，再挑抢话和出戏。点开不发送，开始试玩才花额度`
    view.toPlanBack.disabled = busy
  }

  // ─── 设定草图 ─────────────────────────────────────────────────────────
  /** `force`: rebuild even when the sketch is unchanged (to put back an item left unedited). */
  function renderSketch(force = false) {
    const draft = state.draft
    if (!draft) {
      view.sketch.replaceChildren()
      state.sketchShown = ''
      return
    }
    const brief = draft.brief
    // Only when the sketch changed: a rebuild replays every item's fade-in, and polls come every second.
    const key = JSON.stringify([draft.id, brief, draft.options, draft.greetingCount, Boolean(draft.job), state.sketchOptionsOpen])
    if (!force && key === state.sketchShown) return
    // Do not pull an item out from under the user while they are editing it.
    if (view.sketch.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return
    state.sketchShown = key
    const ready = brief.readiness
    const items = brief.items.map(item => sketchItem(item))
    const title = el('input', { class: 'sketch-title', value: brief.title, placeholder: t`卡的暂定名`, 'aria-label': t`卡的暂定名`, onchange: () => saveBrief({ title: title.value }) })
    // On a phone the sketch folds to its title row; a tap opens it.
    const head = el('div', {
      class: 'sketch-head',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(state.sketchOpen === true),
      onclick: () => {
        state.sketchOpen = !state.sketchOpen
        view.sketch.classList.toggle('open', state.sketchOpen)
        head.setAttribute('aria-expanded', String(state.sketchOpen))
      },
    }, [el('span', { class: 'sketch-label', text: t`设定草图` }), el('span', { class: 'sketch-pct', text: t`成形 ${ready}%` })])
    view.sketch.classList.toggle('open', state.sketchOpen === true)
    view.sketch.replaceChildren(
      ...[
        head,
        el('div', { class: 'sketch-bar' }, [el('i', { style: `width: ${ready}%` })]),
        el('p', { class: 'sketch-hint', text: ready >= 75 ? t`关键的几件事都清楚了：可以出方案，也可以接着细化。` : t`点任何一项可以直接改；锁上的项向导不会再动。` }),
        title,
        sketchOptions(draft),
        items.length ? el('ul', { class: 'sketch-items' }, items) : el('p', { class: 'sketch-empty', text: t`聊一轮之后，这里会出现舞台、角色、关系这些设定。` }),
        brief.open.length ? el('div', { class: 'sketch-open' }, [el('span', { class: 'sketch-label', text: t`还没定` }), ...brief.open.map(text => el('span', { class: 'chip quiet', text }))]) : null,
      ].filter(Boolean),
    )
  }

  /** The picks about the card and how many openings: the next round and the plan go by them. */
  function sketchOptions(draft) {
    const busy = Boolean(draft.job)
    const options = { ...NO_OPTIONS, ...draft.options }
    const picks = el('details', { class: 'sketch-picks', open: state.sketchOptionsOpen === true, ontoggle: event => (state.sketchOptionsOpen = event.target.open) }, [
      el('summary', {}, [el('span', { class: 'sketch-label', text: t`卡的设定` }), el('span', { class: 'hint', text: optionsSummary(options) })]),
      optionsPanel(options, next => saveOptions({ options: next }), { compact: true, disabled: busy }),
    ])
    const count = el('select', { disabled: busy, 'aria-label': t`开场白几个` }, [
      el('option', { value: '0', text: t`向导定（一般 2 个）` }),
      ...[1, 2, 3, 4, 5, 6].map(n => el('option', { value: String(n), text: t`${n} 个` })),
    ])
    count.value = String(draft.greetingCount ?? 0)
    count.addEventListener('change', () => saveOptions({ greetingCount: Number(count.value) }))
    return el('div', { class: 'sketch-opts' }, [
      picks,
      el('label', {}, [el('span', { class: 'sketch-label', text: t`开场白` }), count]),
    ])
  }

  /**
   * The picks as rows of buttons, one row per group (OPTION_GROUPS); `onChange(next)` gets
   * them all with the one changed. The status bar's look shows only with the styled bar.
   */
  function optionsPanel(options, onChange, { compact = false, disabled = false } = {}) {
    const row = group => {
      const value = options[group.key]
      const on = key => (group.kind === 'many' ? value.includes(key) : value === key)
      const pick = key => {
        const next = group.kind === 'many' ? (on(key) ? value.filter(v => v !== key) : [...value, key]) : key
        onChange(settlePicks({ ...options, [group.key]: next }, options))
      }
      // Bricks say what they do where there is room: each is a choice that costs something.
      const cards = group.about && !compact
      const buttons = group.values.map(([key, label]) => el('button', {
        type: 'button', class: cards ? 'forge-brick' : null, text: cards ? null : label, disabled, 'aria-pressed': String(on(key)),
        onclick: () => pick(key),
      }, cards ? [el('b', { text: label }), el('span', { text: group.about[key] })] : []))
      return el('div', { class: `forge-pick${cards ? ' wide' : ''}` }, [
        el('span', { class: 'forge-pick-label', text: group.label }),
        el('div', { class: `${cards ? 'forge-bricks' : 'seg'}${group.kind === 'many' ? ' many' : ''}`, role: 'group', 'aria-label': group.label }, buttons),
        !compact && group.hint ? el('p', { class: 'hint forge-pick-hint', text: group.hint }) : null,
      ])
    }
    const shown = OPTION_GROUPS.filter(group => !group.when || group.when(options))
    const advanced = shown.filter(group => group.advanced)
    // What is picked in there stays in view; otherwise it opens only when asked.
    const open = state.advancedOpen ?? (options.bricks.length > 0 || Boolean(options.scale) || options.statusPages)
    return el('div', { class: `forge-picks${compact ? ' compact' : ''}` }, [
      ...shown.filter(group => !group.advanced).map(row),
      el('details', { class: 'forge-advanced', open, ontoggle: event => (state.advancedOpen = event.target.open) }, [
        el('summary', { text: t`高级选项` }),
        compact ? null : el('p', { class: 'hint', text: t`想做复杂的卡再看这里，不选就和平常一样。` }),
        ...advanced.map(row),
        options.formatBefore !== undefined ? el('p', { class: 'hint forge-pick-note', text: t`这块积木要记数值，格式改成了「MVU + 美化状态栏」。取消它就改回来。` }) : null,
      ]),
    ])
  }

  const saveOptions = guard(async patch => apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: patch })))

  function sketchItem(item) {
    const value = el('div', { class: 'sketch-value', tabindex: '0', role: 'button', title: t`点一下修改`, text: item.value || t`（空）` })
    const edit = () => {
      const box = el('textarea', { class: 'sketch-edit', rows: 3 })
      box.value = item.value
      const done = save => {
        if (save && box.value.trim() !== item.value) changeItem(item, { value: box.value.trim(), by: 'user' })
        else renderSketch(true)
      }
      box.addEventListener('blur', () => done(true))
      box.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          event.preventDefault()
          box.blur()
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) box.blur()
      })
      value.replaceWith(box)
      box.focus()
    }
    value.addEventListener('click', edit)
    value.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        edit()
      }
    })
    const lock = el('button', {
      type: 'button',
      class: `sketch-lock${item.locked ? ' on' : ''}`,
      title: item.locked ? t`已锁定：向导不会再改它。点一下解锁` : t`锁定：向导之后不会再改它`,
      'aria-label': item.locked ? t`解锁` : t`锁定`,
      'aria-pressed': String(item.locked),
      html: item.locked ? ICON_LOCK : ICON_OPEN,
      onclick: () => changeItem(item, { locked: !item.locked, by: item.locked ? item.by : 'user' }),
    })
    return el('li', { class: item.locked ? 'locked' : '' }, [
      el('div', { class: 'sketch-row' }, [el('span', { class: 'sketch-key', text: item.label }), el('span', { class: `sketch-by ${item.by}`, text: item.by === 'user' ? t`你定的` : t`向导补的` }), lock]),
      value,
    ])
  }

  /** One item changed, found by its key in the sketch as it is now (a reply coming in may have reordered it). */
  const changeItem = guard(async (item, patch) => {
    const now = state.draft.brief.items
    const items = now.some(i => i.key === item.key) ? now.map(i => (i.key === item.key ? { ...i, ...patch } : i)) : [...now, { ...item, ...patch }]
    await saveBrief({ items })
  })

  const saveBrief = guard(async patch => {
    const brief = { title: state.draft.brief.title, items: state.draft.brief.items, ...patch }
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { brief } }))
  })

  // ─── 定方案 ───────────────────────────────────────────────────────────
  function planView(draft) {
    const plan = draft.plan
    const core = plan.characters.filter(c => c.kind === 'core')
    const npcs = plan.characters.filter(c => c.kind === 'npc')
    const fields = pairs => el('dl', { class: 'plan-fields' }, pairs.filter(([, v]) => v && (!Array.isArray(v) || v.length)).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: Array.isArray(v) ? v.join(t`；`) : v })]))
    const bullets = (items, cls = '') => el('ul', { class: `plan-list ${cls}` }, items.map(text => el('li', { text })))
    const sections = [
      section(t`概要`, [
        el('p', { class: 'plan-name', text: plan.name }),
        plan.summary ? el('p', { class: 'plan-summary', text: plan.summary }) : null,
        draft.planModel ? el('p', { class: 'hint', text: t`方案由 ${draft.planModel} 写` }) : null,
      ]),
      plan.warnings.length ? el('div', { class: 'plan-warn' }, [el('b', { text: t`写之前看一眼` }), bullets(plan.warnings)]) : null,
      plan.assumptions.length
        ? section(t`向导补的设定`, [el('p', { class: 'hint', text: t`这些是你没说过、向导替你补上的。不合意的，在下面写一句就会改掉。` }), bullets(plan.assumptions, 'assumed')], 'lamp')
        : null,
      section(t`你的身份`, [nameField(draft), genderField(draft), fields([[t`身份`, plan.user_role.identity], [t`限制`, plan.user_role.constraints]])]),
      section(t`舞台`, [
        fields([[t`类型`, WORLD_KIND.get(plan.world.kind) ?? plan.world.kind], [t`概述`, plan.world.overview]]),
        plan.world.rules.length ? el('h5', { text: t`和常识不同的规则` }) : null,
        plan.world.rules.length ? bullets(plan.world.rules) : null,
        plan.world.places.length ? el('h5', { text: t`地点` }) : null,
        ...plan.world.places.map(p => fields([[p.name, [p.description, p.scenes.length ? t`场所：${p.scenes.join(t`、`)}` : ''].filter(Boolean).join(' ')]])),
        plan.world.factions.length ? el('h5', { text: t`势力` }) : null,
        ...plan.world.factions.map(f => fields([[f.name, f.description]])),
        plan.world.history.length ? el('h5', { text: t`往事` }) : null,
        plan.world.history.length ? bullets(plan.world.history.map(h => [h.event, h.impact].filter(Boolean).join(t`：`))) : null,
      ]),
      section(t`角色`, [...core.map(c => characterCard(c, fields, plan)), ...npcs.map(c => characterCard(c, fields, plan))]),
      plan.events?.length ? section(t`事件`, [
        el('p', { class: 'hint', text: t`到了时机才交给模型的事：对话里提到关键词，或者数值到了某个程度。` }),
        el('ul', { class: 'plan-list' }, plan.events.map((event, index) => eventRow(plan, event, index))),
      ]) : null,
      section(t`文风与扮演`, [
        fields([[t`视角`, plan.style.perspective], [t`语言`, plan.style.tone], [t`氛围`, plan.style.mood], [t`参照`, plan.style.reference], [t`特别要求`, plan.style.special]]),
        plan.play_rules.length ? el('h5', { text: t`扮演准则` }) : null,
        plan.play_rules.length ? bullets(plan.play_rules) : null,
      ]),
      plan.game ? section(t`战斗与成长`, gameSection(plan.game, fields)) : null,
      plan.bricks?.length ? section(t`玩法积木`, brickSection(draft, fields, bullets)) : null,
      section(t`状态栏`, statusEditor(draft)),
      section(t`开场白`, [
        plan.tracking.enabled ? el('p', { class: 'hint', text: t`每个开场是一个不同的起点。处境和状态栏初始值对不上的开场，带着自己的开局数值，玩家选这个开场时生效。` }) : null,
        el('ol', { class: 'plan-list' }, plan.greetings.map(g => el('li', {}, [
          el('b', { text: g.title }),
          el('span', { text: t` ${[g.start, g.scene, g.situation].filter(Boolean).join(t`：`)}（${g.length} 字）` }),
          greetingState(plan, g),
        ]))),
      ]),
      section(t`世界书`, [
        el('p', { class: 'hint', text: t`常驻的每轮都在；「提到时」的只在对话里出现关键词时才交给模型，省上下文。这些按规则自动配好。` }),
        el('ul', { class: 'plan-entries' }, plan.entries.map(entryRow)),
      ]),
      section(t`头像`, [fields([[t`画谁`, plan.avatar.character], [t`样子`, plan.avatar.description], [t`画风`, plan.avatar.style ? t`${plan.avatar.style}（保存时写进「配图 → 画风」，立绘和背景都按它画）` : '']])]),
    ]
    return el('div', { class: 'forge-plan' }, [
      draft.job?.kind === 'plan' ? busyBlock(draft) : draft.error ? errorBlock(draft.error) : null,
      el('p', { class: 'forge-lead', text: t`方案出来了。哪里不合意，就在那一块点「提意见」写一句，写完点下面的「按意见修改方案」；也可以回去接着聊。` }),
      draft.planOptions.length > 1 ? planOptions(draft) : null,
      draft.planMissing?.length && !draft.job ? planMissing(draft) : null,
      ...sections,
    ])
  }

  /** 出三版来挑: the versions side by side; the one picked is the plan shown below. */
  function planOptions(draft) {
    const busy = Boolean(draft.job)
    return el('section', { class: 'plan-card plan-options' }, [
      el('header', {}, [el('h4', { text: t`${draft.planOptions.length} 版方案` })]),
      el('p', { class: 'hint', text: t`同一段讨论写出的几版。选一版，下面就显示它的全文；提意见修改、开始写，都用选中的这一版。` }),
      el('div', { class: 'plan-option-list' }, draft.planOptions.map((option, i) => el('button', {
        type: 'button', class: `plan-option${option.picked ? ' on' : ''}`, 'aria-pressed': String(option.picked), disabled: busy,
        onclick: () => !option.picked && pickPlan(i),
      }, [
        el('span', { class: 'tag', text: PLAN_ANGLE[option.angle] ?? option.angle }),
        el('b', { text: option.name }),
        option.summary ? el('span', { class: 'plan-option-text', text: option.summary }) : null,
        option.cast.length ? el('span', { class: 'hint', text: t`主要角色：${option.cast.join(t`、`)}` }) : null,
        el('span', { class: 'hint', text: t`开场：${option.greetings.join(t` / `)}` }),
      ]))),
    ])
  }

  /** Versions of 出三版来挑 that did not come (asked twice): which, why, and a way to ask for them again. */
  function planMissing(draft) {
    const which = draft.planMissing.map(m => PLAN_ANGLE[m.angle] ?? m.angle).join(t`、`)
    return el('div', { class: 'forge-error' }, [
      el('p', { text: t`「${which}」那版没写出来：${draft.planMissing[0].error}` }),
      el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`再写一次`, onclick: guard(async () => apply(await api(`/api/forge/${draft.id}/plan`, { method: 'POST', body: { variants: true, missing: true } }))) })]),
    ])
  }

  const pickPlan = guard(async index => apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { planPick: index } })))

  /** An opening's own starting values, by their status bar names; nothing when it starts from the defaults. */
  function greetingState(plan, greeting) {
    const own = Object.entries(greeting?.state ?? {})
    if (!plan.tracking.enabled || !own.length) return null
    const label = path => plan.tracking.variables.find(v => v.path === path)?.label || path
    return el('span', { class: 'plan-greet-state' }, [el('span', { class: 'hint', text: t`开局数值` }), ...own.map(([path, value]) => el('span', { class: 'chip quiet', text: `${label(path)} ${value}` }))])
  }

  /**
   * The player's name in this card: empty for the one in settings, or a name of
   * the card's own. Saved as it is changed, without redrawing under the cursor.
   */
  function nameField(draft) {
    const box = el('input', {
      type: 'text', class: 'plan-username', maxlength: 24, disabled: Boolean(draft.job), 'aria-label': t`你在这张卡里的名字`,
      placeholder: state.settingsName ? t`用设置里的名字（${state.settingsName}）` : t`用设置里的名字（还没填，叫「你」）`,
    })
    box.value = draft.plan.user_role.name ?? ''
    box.addEventListener('change', guard(async () => {
      const view = await api(`/api/forge/${draft.id}`, { method: 'PUT', body: { userName: box.value.trim() } })
      box.value = view.plan.user_role.name ?? ''
      state.draft = view
      state.shown = mainKey(view)
    }))
    return el('dl', { class: 'plan-fields' }, [
      el('dt', { text: t`名字` }),
      el('dd', {}, [box, el('p', { class: 'hint', text: t`空着就用设置里「你的名字」，以后改了设置也跟着变。填一个名字，用这张卡开的对话里你就叫这个名字。卡里写的都是 {{user}}，导到 SillyTavern 也一样。` })]),
    ])
  }

  /** The player's gender in this card (卡的设定 你的性别, kept with the plan too): how it calls and refers to them. */
  function genderField(draft) {
    const now = draft.plan.user_role.gender ?? ''
    const group = OPTION_GROUPS.find(g => g.key === 'userGender')
    const buttons = group.values.map(([key, label]) => el('button', {
      type: 'button', text: label, disabled: Boolean(draft.job), 'aria-pressed': String(now === key),
      onclick: guard(async () => key !== now && apply(await api(`/api/forge/${draft.id}`, { method: 'PUT', body: { userGender: key } }))),
    }))
    return el('dl', { class: 'plan-fields' }, [
      el('dt', { text: t`性别` }),
      el('dd', {}, [
        el('div', { class: 'seg', role: 'group', 'aria-label': t`你的性别` }, buttons),
        el('p', { class: 'hint', text: draft.card ? t`角色怎么称呼你、用「他」还是「她」按它写。卡的简介会跟着改；已经写好的条目和开场白不会，要改就重写。` : t`角色怎么称呼你、用「他」还是「她」按它写。不限就不写明。` }),
      ]),
    ])
  }

  /**
   * The tracked variables, edited in place, with the status bar they make
   * (initial values) beside them. Each change is saved as it is made; the
   * editor stays as it is under the cursor.
   */
  function statusEditor(draft) {
    const tracking = draft.plan.tracking
    const busy = Boolean(draft.job)
    let variables = tracking.variables.map(v => ({ ...v }))
    const look = draft.plan.status ?? {}
    // 按卡配色: the three colors the rest is worked out from, here to be changed by hand.
    let palette = look.theme === 'auto' ? look.palette ?? { bg: '#f7f8f5', ink: '#1c2427', accent: '#2b5869' } : null
    const save = guard(async ({ enabled = state.draft.plan.tracking.enabled, redraw = false } = {}) => {
      const body = { tracking: { enabled, title: title.value.trim(), variables: variables.filter(v => v.path.trim()), ...(palette ? { palette } : {}) } }
      const view = await api(`/api/forge/${draft.id}`, { method: 'PUT', body })
      if (redraw) return apply(view)
      state.draft = view
      state.shown = mainKey(view)
    })
    const title = el('input', { type: 'text', class: 'var-title', maxlength: 30, disabled: busy, placeholder: t`状态栏标题（可不填）`, 'aria-label': t`状态栏标题` })
    title.value = tracking.title ?? ''

    if (!tracking.enabled) {
      // A first variable to start from, in the card's language.
      const english = /^(en|english)/i.test(String(draft.plan.language ?? ''))
      const first = draft.plan.characters.find(c => c.kind === 'core')?.name ?? draft.plan.name
      const sample = english
        ? { path: `${first}.affection`, label: 'Affection' }
        : { path: `${first}.${zh`好感度`}`, label: zh`好感` }
      return [
        el('p', { class: 'hint', text: t`不记录会变化的数值。要的话，加上状态栏，记下好感、体力这类数值，显示在每条回复下面。` }),
        el('button', { type: 'button', class: 'btn small', disabled: busy, text: t`加上状态栏`, onclick: () => {
          if (!variables.length) variables = [{ ...sample, type: 'number', initial: '20', range: '0~100', show: 'meter', check: '' }]
          save({ enabled: true, redraw: true })
        } }),
      ]
    }

    const preview = el('div', { class: 'status-preview' })
    const rows = el('div', { class: 'var-rows' })
    const drawPreview = () => {
      const shown = variables.filter(v => v.path.trim())
      const spec = cleanStatusSpec({ title: title.value.trim(), theme: look.theme, palette, fields: shown.map(v => ({ path: v.path, label: v.label, show: v.show, ...rangeOf(v.range), ...(look.pages && v.page ? { page: v.page } : {}) })) })
      preview.replaceChildren(spec ? statusBar(el, spec, initialOf(shown), { collapsible: false, note: t`预览 · 初始值` }) ?? empty() : empty())
    }
    const empty = () => el('p', { class: 'hint', text: t`还没有要显示的项。` })
    const drawRows = () => rows.replaceChildren(...variables.map(variableRow))
    const variableRow = (v, index) => {
      const input = (key, attrs) => {
        const box = el('input', { type: 'text', disabled: busy, ...attrs })
        box.value = v[key] ?? ''
        box.addEventListener('input', () => { v[key] = box.value; drawPreview() })
        box.addEventListener('change', () => save())
        return box
      }
      const range = input('range', { class: 'var-range', placeholder: t`范围 0~100`, 'aria-label': t`范围` })
      range.hidden = v.type !== 'number'
      // 册子: what each row keeps, split as the server splits a list.
      const columns = el('input', { type: 'text', class: 'var-range', disabled: busy, placeholder: t`每行记什么，比如 数量、说明`, 'aria-label': t`每行记什么` })
      columns.value = (v.columns ?? []).join(t`、`)
      columns.hidden = v.type !== 'book'
      columns.addEventListener('input', () => { v.columns = columns.value.split(/[、,，\s]+/).filter(Boolean); drawPreview() }) // i18n-ignore: separators
      columns.addEventListener('change', () => save())
      const page = input('page', { class: 'var-range', maxlength: 8, placeholder: t`第几页的页名`, 'aria-label': t`在状态栏哪一页` })
      page.hidden = !look.pages
      const show = el('select', { class: 'var-show', disabled: busy, 'aria-label': t`显示方式` }, SHOWS.map(([value, label]) => el('option', { value, text: label })))
      show.value = v.show
      const row = el('div', { class: `var-row${v.show === 'hidden' ? ' quiet' : ''}` }, [
        el('div', { class: 'var-line' }, [
          input('path', { class: 'var-path', placeholder: t`谁的.什么，比如 林小雨.好感度`, 'aria-label': t`变量` }),
          input('label', { class: 'var-label', maxlength: 12, placeholder: t`短名`, 'aria-label': t`状态栏上的名字` }),
          show,
          el('button', { type: 'button', class: 'icon-btn', disabled: busy, title: t`删掉这一项`, 'aria-label': t`删掉这一项`, html: ICON_CLOSE, onclick: () => {
            variables.splice(index, 1)
            drawRows()
            drawPreview()
            save()
          } }),
        ]),
        el('div', { class: 'var-line' }, [
          input('initial', { class: 'var-initial', placeholder: v.type === 'book' ? t`名字|数量|说明，几行用；隔开` : t`初始值`, 'aria-label': t`初始值` }),
          range,
          columns,
          page,
          input('check', { class: 'var-check', placeholder: t`什么事会让它怎么变`, 'aria-label': t`怎么变` }),
        ]),
      ])
      show.addEventListener('change', () => {
        v.show = show.value
        if (SHOW_TYPE[v.show]) v.type = SHOW_TYPE[v.show]
        if (v.type === 'book' && !v.columns?.length) v.columns = [zh`说明`]
        range.hidden = v.type !== 'number'
        columns.hidden = v.type !== 'book'
        columns.value = (v.columns ?? []).join(t`、`)
        row.classList.toggle('quiet', v.show === 'hidden')
        drawPreview()
        save()
      })
      return row
    }
    const colorRow = () => el('div', { class: 'var-colors' }, [['bg', t`背景`], ['ink', t`文字`], ['accent', t`强调`]].map(([key, label]) => {
      const box = el('input', { type: 'color', disabled: busy, 'aria-label': label })
      box.value = palette[key]
      box.addEventListener('input', () => { palette = { ...palette, [key]: box.value }; drawPreview() })
      box.addEventListener('change', () => save())
      return el('label', {}, [box, el('span', { text: label })])
    }))
    title.addEventListener('input', drawPreview)
    title.addEventListener('change', () => save())
    drawRows()
    drawPreview()
    return [
      el('p', { class: 'hint', text: t`这些数值显示在每条回复下面的状态栏里，模型每轮按「怎么变」更新它们。直接在这里改，上面的预览跟着变；也可以点「提意见」让向导改。` }),
      el('div', { class: 'status-editor' }, [
        el('div', { class: 'var-editor' }, [
          title,
          palette ? colorRow() : null,
          rows,
          el('div', { class: 'row' }, [
            el('button', { type: 'button', class: 'btn small', disabled: busy, text: t`＋ 加一项`, onclick: () => {
              variables.push({ path: '', label: '', type: 'number', initial: '0', range: '0~100', show: 'meter', check: '' })
              drawRows()
              rows.lastElementChild?.querySelector('.var-path')?.focus()
            } }),
            el('button', { type: 'button', class: 'btn ghost small', disabled: busy, text: t`不要状态栏`, onclick: () => save({ enabled: false, redraw: true }) }),
          ]),
        ]),
        preview,
      ]),
    ]
  }

  /** How a core character's stages read: names, and the range of the tracked value each covers. */
  function stagesLine(plan, c) {
    if (!c.stages?.length) return ''
    const staged = plan.entries.some(e => e.owner === c.name && e.staged)
    if (!staged) return t`（写了分阶段，但用来分阶段的数值不在状态栏里，这次不分）`
    const label = plan.tracking.variables.find(v => v.path === c.stage_by)?.label || c.stage_by
    const parts = c.stages.map((s, i) => {
      const from = i ? c.stages[i - 1].until : ''
      const range = s.until && from ? `${from}~${s.until}` : s.until ? `< ${s.until}` : `≥ ${from}`
      return t`${s.name}（${label} ${range}）${s.main.length ? t`：${s.main.join(t`、`)}` : ''}`
    })
    return parts.join(' → ')
  }

  /** 战斗与成长 in the plan: how the player starts. The card's 游戏规则 can change it afterwards. */
  function gameSection(game, fields) {
    const { body, grace, mind, charm } = game.attributes
    return [
      el('p', { class: 'hint', text: t`保存后这张卡开着完整规则，开局就能打。想改就告诉向导，或者保存后在角色卡的「游戏规则」里改。` }),
      fields([
        [t`属性`, t`体魄 ${body}、灵巧 ${grace}、心智 ${mind}、魅力 ${charm}`],
        [t`技能`, game.skills.map(skill => skill.name)],
        [t`开局物品`, game.things.map(thing => (thing.count > 1 ? `${thing.name} ×${thing.count}` : thing.name))],
        [t`常见敌人`, game.foes.map(foe => foe.name)],
        [t`同伴`, (game.companions ?? []).map(companion => (companion.start ? companion.name : t`${companion.name}（之后入队）`))],
        [t`气力叫作`, game.energyName],
        [t`等级阶梯`, game.ranks?.join(' → ')],
        [t`阶梯跨度`, game.ranks?.length ? (game.rankSpan === 'narrow' ? t`小：差几级才打不过` : t`大：差一级就很难打`) : ''],
        [t`理智`, game.sanity ? t`记录，受到惊吓会掉` : ''],
      ]),
    ]
  }

  /** 玩法积木 in the plan: the works are the code's; this is what the model filled in, and what they add. */
  function brickSection(draft, fields, bullets) {
    const plan = draft.plan
    const books = plan.tracking.variables.filter(v => v.type === 'book')
    const events = plan.random_events
    const judge = plan.judge
    const moves = plan.world_moves
    const form = plan.creation
    const cost = draft.brickCost
    return [
      el('p', { class: 'hint', text: t`机关由程序写好，下面是向导填的内容。想改就点「提意见」写一句。` }),
      cost ? el('p', { class: 'hint', text: t`这些规则常驻约 ${cost.always} 字，模型每轮大概多写 ${cost.reply} 字。` }) : null,
      books.length ? el('h5', { text: t`册子` }) : null,
      books.length ? bullets(books.map(v => t`${v.label || v.path}：每行记${v.columns.join(t`、`)}`)) : null,
      plan.selfcheck?.length ? el('h5', { text: t`写前自查` }) : null,
      plan.selfcheck?.length ? bullets(plan.selfcheck) : null,
      events?.groups.length ? el('h5', { text: t`随机事件（约 ${EVENT_RATES[events.rate]} 轮一次）` }) : null,
      ...(events?.groups ?? []).map(group => fields([[group.when || t`名单`, group.items]])),
      judge?.ranks.length ? el('h5', { text: t`裁判表` }) : null,
      judge?.ranks.length ? fields([
        [t`比什么`, judge.measure],
        [t`什么时候判`, judge.when],
        [t`等级`, judge.ranks.join(' < ')],
        [t`差距`, judge.gaps.map(gap => t`差 ${gap.gap}：${gap.result}`)],
        [t`已知`, judge.known.map(item => `${item.name} ${item.rank}`)],
        [t`运气`, judge.dice ? t`平手看骰子` : t`不看运气`],
      ]) : null,
      moves?.lines.length ? el('h5', { text: t`世界动态（约 ${EVENT_RATES[moves.rate]} 轮动一步）` }) : null,
      moves?.lines.length ? fields(moves.lines.map(line => [line.name, line.stages.join(' → ')])) : null,
      form?.fields.length ? el('h5', { text: t`建角页` }) : null,
      form?.fields.length ? fields(form.fields.map(field => [field.label, field.kind === 'text' ? t`玩家自己写` : field.kind === 'points' ? t`${field.total} 点分给：${field.options.join(t`、`)}` : field.options])) : null,
    ]
  }

  /** An event in the plan: when it comes in, and whether it made it into the card (it needs a way to come in). */
  function eventRow(plan, event, index) {
    const label = path => plan.tracking.variables.find(v => v.path === path)?.label || path
    const triggers = [
      event.keywords.length ? t`提到：${event.keywords.join(t`、`)}` : '',
      ...(Array.isArray(event.requires) ? event.requires : event.requires ? [event.requires] : []).map(r => `${label(r.path)} ${r.op === 'has' ? t`里有` : r.op} ${r.value}`),
    ].filter(Boolean)
    const kept = plan.entries.some(e => e.type === zh`事件` && e.event === index)
    return el('li', {}, [
      el('b', { text: event.name }),
      el('span', { text: ` ${event.when}` }),
      el('span', { class: 'plan-greet-state' }, [
        ...triggers.map(text => el('span', { class: 'chip quiet', text })),
        kept ? null : el('span', { class: 'hint', text: t`没有能用的触发条件，不会写进卡里` }),
      ]),
    ])
  }

  function characterCard(c, fields, plan) {
    const p = c.personality
    return el('div', { class: 'plan-char' }, [
      el('div', { class: 'plan-char-head' }, [el('b', { text: c.name }), el('span', { class: `tag${c.kind === 'npc' ? ' off' : ''}`, text: c.kind === 'npc' ? t`配角` : t`核心角色` }), c.aliases.length ? el('span', { class: 'hint', text: t`也叫 ${c.aliases.join(t`、`)}` }) : null]),
      fields([
        [t`身份`, [c.identity, c.age, c.gender].filter(Boolean).join(t`，`)],
        [t`和你`, c.relationship],
        [t`外貌`, c.appearance],
        [t`穿着`, c.outfit],
        [t`性格`, [p.base && t`底色「${p.base}」`, p.main.length && t`主色调${p.main.map(m => t`「${m}」`).join('')}`, p.accent.length && t`点缀${p.accent.map(m => t`「${m}」`).join('')}`].filter(Boolean).join(t`，`)],
        [t`说话`, c.voice],
        [t`作用`, c.role],
        [t`几副面孔`, c.facets ? t`会写不同处境下判若两人的几面` : ''],
        [t`分阶段`, stagesLine(plan, c)],
      ]),
    ])
  }

  function entryRow(entry) {
    const [text, cls] = STRATEGY[entry.strategy] ?? ['', '']
    return el('li', {}, [
      el('div', { class: 'plan-entry-head' }, [el('b', { text: entry.name }), el('span', { class: `strategy ${cls}`, text: text }), el('span', { class: 'hint', text: POSITION[entry.position] })]),
      el('div', { class: 'plan-entry-sub' }, [entry.purpose, entry.strategy === 'keyword' && entry.keywords.length ? t`　关键词：${entry.keywords.join(t`、`)}` : ''].join('')),
    ])
  }

  function section(title, children, tone = '') {
    const note = el('textarea', { class: 'plan-note', rows: 2, placeholder: t`关于「${title}」想怎么改`, oninput: () => { state.notes.set(title, note.value); updateFoot() } })
    note.value = state.notes.get(title) ?? ''
    note.hidden = !note.value
    const toggle = el('button', { type: 'button', class: 'btn ghost small', text: t`提意见`, onclick: () => { note.hidden = !note.hidden; if (!note.hidden) note.focus() } })
    return el('section', { class: `plan-card ${tone}` }, [el('header', {}, [el('h4', { text: title }), toggle]), ...children.filter(Boolean), note])
  }

  // ─── 动笔 ─────────────────────────────────────────────────────────────
  function writeView(draft) {
    const job = draft.job
    const steps = draft.writing.map(step => {
      const mark = { done: '✓', running: '', failed: '!', waiting: '' }[step.state]
      const extra = step.state === 'running' && job?.chars ? t`已写 ${job.chars} 字` : step.state === 'failed' ? t`没写成` : step.by ? t`由 ${step.by} 重写` : ''
      return el('li', { class: step.state }, [el('span', { class: 'mark', text: mark }), el('span', { class: 'label', text: step.label }), extra ? el('span', { class: 'extra', text: extra }) : null])
    })
    const written = draft.card.entries.filter(e => e.content && e.type !== zh`状态`)
    const running = Boolean(job)
    // The whole of it as one bar: steps done, the one running half; striped while it runs.
    const done = draft.writing.filter(step => step.state === 'done').length + (running ? 0.5 : 0)
    const share = draft.writing.length ? Math.round((done / draft.writing.length) * 100) : 0
    const overall = el('div', { class: 'forge-progress-row' }, [
      el('div', { class: `forge-progress${running ? ' running' : ''}`, role: 'progressbar', 'aria-valuenow': String(share), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('i', { style: `width: ${share}%` })),
      (state.writeClock = el('span', { class: 'forge-clock', 'data-prefix': running ? t`第 ${Math.min(draft.writing.length, Math.floor(done) + 1)}/${draft.writing.length} 步 · ` : '', text: running ? t`第 ${Math.min(draft.writing.length, Math.floor(done) + 1)}/${draft.writing.length} 步 · ` + elapsed(job.startedAt) : t`${Math.floor(done)}/${draft.writing.length} 步` })),
    ])
    return el('div', { class: 'forge-write' }, [
      el('h3', { class: 'forge-hero', text: running ? t`正在写这张卡` : draft.error ? t`写到一半停下了` : t`还差几步` }),
      overall,
      el('p', { class: 'forge-lead', text: running ? t`按方案一步步写：先写世界和角色，后面的参照前面的保持一致；最后检查一遍套话和前后矛盾。可以关掉窗口，回来再看。` : t`已经写好的部分都留着，从停下的地方接着写。` }),
      el('ol', { class: 'write-steps' }, steps),
      draft.error ? el('div', { class: 'forge-error' }, [el('p', { text: draft.error.message }), running ? null : otherModel(draft.error)]) : null,
      el('div', { class: 'row' }, [
        running ? el('button', { type: 'button', class: 'btn', text: t`停下`, onclick: () => stopJob() }) : el('button', { type: 'button', class: 'btn primary', text: t`接着写`, onclick: () => startWrite() }),
      ]),
      written.length ? el('p', { class: 'hint', text: t`已写好：${written.map(e => e.name).join(t`、`)}` }) : null,
    ])
  }

  // ─── 打磨与头像 ───────────────────────────────────────────────────────
  function polishView(draft) {
    const card = draft.card
    const busy = Boolean(draft.job)
    const working = target => busy && draft.job.step === target
    const checks = card.checks ?? []
    const byOrder = [...card.entries].sort((a, b) => a.order - b.order)
    return el('div', { class: 'forge-polish' }, [
      draft.error && draft.error.kind !== 'avatar' ? errorBlock(draft.error) : null,
      avatarHero(draft),
      checks.length
        ? el('section', { class: 'plan-card lamp' }, [
            el('header', {}, [el('h4', { text: t`还有 ${checks.length} 处可能的套话` })]),
            el('p', { class: 'hint', text: t`程序按常见套话扫出来的，不一定都要改。点「按这条改」让向导改写那一段。` }),
            el('ul', { class: 'check-list' }, checks.slice(0, 20).map(hit => el('li', {}, [
              el('span', { class: 'check-where', text: pieceName(hit.target) }),
              el('span', { class: 'tag', text: LINT_TEXT.get(hit.label) ?? hit.label }),
              el('span', { class: 'check-text', text: `…${hit.excerpt}…` }),
              el('button', { type: 'button', class: 'btn ghost small', text: t`按这条改`, disabled: busy, onclick: () => rewrite(hit.target, zh`去掉这里的「${hit.label}」：「${hit.excerpt.trim()}」，换成具体的写法`) }),
            ]))),
          ])
        : el('p', { class: 'hint', text: card.issuesFound ? t`检查过了：向导挑出 ${card.issuesFound} 处毛病，已经改好。` : t`检查过了，没有发现常见的套话。` }),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: t`开场白` })]),
        ...card.greetings.map((g, i) => {
          const own = greetingState(draft.plan, draft.plan.greetings[i])
          const title = g.title || t`开场 ${i + 1}`
          return pieceBlock({ target: zh`开场白${i + 1}`, title, text: g.text, reading: true, working: working(zh`开场白${i + 1}`), busy, head: own ? el('span', { class: 'piece-title' }, [el('b', { text: title }), own]) : null })
        }),
      ]),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: t`世界书 · ${card.entries.length} 条` })]),
        el('p', { class: 'hint', text: t`按发给模型的顺序排列。点条目名展开；状态记录的几条由程序生成。` }),
        ...byOrder.map(entry => entryBlock(entry, { busy, working: working(entry.name) })),
      ]),
      valuesPreview(draft),
      rosterPreview(draft.plan),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: t`卡片信息` })]),
        pieceBlock({ target: 'description', title: t`角色描述（发给模型，几行速览）`, text: card.description, busy, noRewrite: true }),
        pieceBlock({ target: 'notes', title: t`创作者备注（给玩家看，不发给模型）`, text: card.creatorNotes, busy, noRewrite: true }),
      ]),
    ])
  }

  /**
   * 数值预览: sliders for the tracked numbers (and switches for yes/no values); at
   * each position the server renders the card's EJS as SillyTavern would and says
   * which stage each character is in, which events are in, and what the staged
   * entries read. No model call; the values are not saved anywhere.
   */
  function valuesPreview(draft) {
    const variables = draft.plan.tracking?.enabled ? draft.plan.tracking.variables.filter(v => v.type === 'number' || v.type === 'boolean') : []
    const dynamic = draft.card.entries.some(e => e.staged || e.type === zh`事件`)
    if (!variables.length || !dynamic) return null
    const values = (state.previewValues[draft.id] ??= {})
    const out = el('div', { class: 'values-out', 'aria-live': 'polite' })
    let asked = 0
    let timer = null
    const show = async () => {
      const ask = ++asked
      const result = await api(`/api/forge/${draft.id}/preview`, { method: 'POST', body: { values } }).catch(error => ({ error }))
      if (ask !== asked || !out.isConnected) return
      if (result.error) return out.replaceChildren(el('p', { class: 'hint', text: result.error.message }))
      out.replaceChildren(...previewResult(result))
    }
    const later = () => {
      clearTimeout(timer)
      timer = setTimeout(show, 150)
    }
    const controls = variables.map(v => {
      if (v.type === 'boolean') {
        const box = el('input', { type: 'checkbox', checked: values[v.path] ?? /^(true|是|有|1)$/i.test(v.initial), onchange: () => { values[v.path] = box.checked; later() } })
        return el('label', { class: 'values-row' }, [el('span', { class: 'values-label', text: v.label || v.path }), box])
      }
      const [min, max] = rangeOf(v)
      const start = values[v.path] ?? (Number.isFinite(Number(v.initial)) && v.initial !== '' ? Number(v.initial) : min)
      const number = el('span', { class: 'values-number', text: String(start) })
      const slider = el('input', { type: 'range', min, max, step: max - min > 20 ? 1 : 'any', value: start, 'aria-label': v.label || v.path, oninput: () => {
        values[v.path] = Number(slider.value)
        number.textContent = slider.value
        later()
      } })
      return el('label', { class: 'values-row' }, [el('span', { class: 'values-label', text: v.label || v.path }), slider, number])
    })
    const reset = el('button', { type: 'button', class: 'btn ghost small', text: t`回到初始值`, onclick: () => {
      state.previewValues[draft.id] = {}
      state.shown = ''
      renderMain()
    } })
    show()
    return el('section', { class: 'plan-card values-preview' }, [
      el('header', {}, [el('h4', { text: t`数值预览` }), reset]),
      el('p', { class: 'hint', text: t`拖动看看数值到了不同程度时，模型拿到的是哪个性格阶段、哪些事件。只是预览，不改卡，也不调模型。` }),
      el('div', { class: 'values-controls' }, controls),
      out,
    ])
  }

  /** A tracked number's range from its 「0~100」 (or 0 to 100 when it says none). */
  function rangeOf(variable) {
    const found = /(-?\d+(?:\.\d+)?)\s*(?:~|～|-|—|到|至)\s*(-?\d+(?:\.\d+)?)/.exec(variable.range ?? '')
    const [min, max] = found ? [Number(found[1]), Number(found[2])] : [0, 100]
    const start = Number(variable.initial)
    return max > min ? [Math.min(min, Number.isFinite(start) ? start : min), Math.max(max, Number.isFinite(start) ? start : max)] : [0, 100]
  }

  function previewResult({ characters, events, entries }) {
    const parts = []
    if (characters.length) {
      parts.push(el('ul', { class: 'values-stages' }, characters.map(c => el('li', {}, [
        el('b', { text: c.name }),
        el('span', { class: 'tag', text: c.stage }),
        el('span', { class: 'hint', text: [c.main.length ? t`主色调 ${c.main.join(t`、`)}` : '', c.accent.length ? t`点缀 ${c.accent.join(t`、`)}` : ''].filter(Boolean).join(t`；`) }),
      ]))))
    }
    if (events.length) {
      parts.push(el('div', { class: 'values-events' }, [
        el('span', { class: 'hint', text: t`事件` }),
        ...events.map(e => el('span', {
          class: `chip${e.on ? '' : ' quiet off'}`,
          text: e.name,
          title: e.conditional
            ? e.on ? (e.keywords.length ? t`条件满足：对话里提到「${e.keywords.join(t`、`)}」时出现` : t`条件满足：每轮都在`) : t`条件还不满足，不会出现`
            : t`没有数值条件：对话里提到「${e.keywords.join(t`、`)}」时出现`,
        })),
      ]))
    }
    for (const entry of entries) {
      parts.push(el('details', { class: 'values-entry' }, [el('summary', { text: t`${entry.name}（此时发给模型的样子）` }), el('pre', { text: entry.text })]))
    }
    return parts
  }

  /** Who goes into 配图与朗读 → 角色名册 when the card is saved, and how they look there. */
  function rosterPreview(plan) {
    const cast = plan.characters.filter(c => c.looks_tags)
    if (!cast.length) return null
    return el('section', { class: 'plan-card' }, [
      el('header', {}, [el('h4', { text: t`角色名册` })]),
      el('p', { class: 'hint', text: t`保存时写进「配图与朗读 → 角色名册」：配图和视觉小说的立绘按这里的长相画。再次保存时，新角色会加进去，名册里已有的人，你在配图里改过的地方不会被覆盖。` }),
      el('dl', { class: 'plan-fields' }, cast.flatMap(c => [el('dt', { text: c.name }), el('dd', { text: [c.looks_tags, c.outfit_tags].filter(Boolean).join(' · ') })])),
    ])
  }

  /** One editable piece: an opening, an entry's text, or a card field. */
  function pieceBlock({ target, title, text, reading = false, working = false, busy = false, noRewrite = false, head = null }) {
    const editing = state.editing === target
    const noting = state.noteFor === target
    const body = editing
      ? (() => {
          const box = el('textarea', { class: 'piece-edit', rows: Math.min(24, Math.max(6, text.split('\n').length + 2)) })
          const kept = state.editText
          box.value = kept?.draftId === state.draft?.id && kept.target === target ? kept.text : text
          box.addEventListener('input', () => (state.editText = { draftId: state.draft?.id, target, text: box.value }))
          return el('div', {}, [
            box,
            el('div', { class: 'row end' }, [
              el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { state.editing = null; state.editText = null; state.shown = ''; renderMain() } }),
              el('button', { type: 'button', class: 'btn small primary', text: t`保存修改`, onclick: () => saveEdit(target, box.value) }),
            ]),
          ])
        })()
      : reading && text
        ? el('div', { class: 'piece-read' }, text.split(/\n+/).filter(Boolean).map(p => el('p', { text: p })))
        : el('div', { class: reading ? 'piece-read' : 'piece-text', text: text || t`（空）` })
    const note = noting
      ? (() => {
          const input = el('input', { type: 'text', class: 'piece-note', placeholder: t`想怎么改，比如：再短一点；她不该这么快就信任你`, onkeydown: event => { if (event.key === 'Enter' && !event.isComposing) rewrite(target, input.value) } })
          input.value = state.noteText
          input.addEventListener('input', () => (state.noteText = input.value))
          queueMicrotask(() => input.focus())
          return el('div', { class: 'piece-noting' }, [input, el('button', { type: 'button', class: 'btn small primary', text: t`重写`, onclick: () => rewrite(target, input.value) }), el('button', { type: 'button', class: 'btn ghost small', text: t`算了`, onclick: () => { state.noteFor = null; state.shown = ''; renderMain() } })])
        })()
      : null
    const tools = editing || noting
      ? null
      : el('div', { class: 'piece-tools' }, [
          working ? el('span', { class: 'forge-working' }, [el('span', { class: 'dots' }), t`正在重写…`]) : null,
          el('button', { type: 'button', class: 'btn ghost small', text: t`编辑`, disabled: busy, onclick: () => { state.editing = target; state.editText = null; state.noteFor = null; state.shown = ''; renderMain() } }),
          noRewrite ? null : el('button', { type: 'button', class: 'btn ghost small', text: t`按意见重写`, disabled: busy, onclick: () => { state.noteFor = target; state.noteText = ''; state.editing = null; state.editText = null; state.shown = ''; renderMain() } }),
        ])
    return el('div', { class: `piece${working ? ' working' : ''}` }, [el('div', { class: 'piece-head' }, [head ?? el('b', { text: title }), tools]), note, body])
  }

  function entryBlock(entry, { busy, working }) {
    const [text, cls] = STRATEGY[entry.strategy] ?? ['', '']
    const open = state.open.has(entry.name) || state.editing === entry.name || state.noteFor === entry.name || working
    const generated = entry.type === zh`状态`
    const head = el('button', { type: 'button', class: 'entry-toggle', 'aria-expanded': String(open), onclick: () => { open ? state.open.delete(entry.name) : state.open.add(entry.name); state.shown = ''; renderMain() } }, [
      el('b', { text: entry.name }),
      el('span', { class: `strategy ${cls}`, text }),
      el('span', { class: 'hint', text: POSITION[entry.position] }),
      entry.strategy === 'keyword' ? el('span', { class: 'hint', text: t`关键词：${entry.keywords.join(t`、`)}` }) : null,
      open ? null : el('span', { class: 'hint', text: t`${entry.content.length} 字` }),
    ])
    if (!open) return el('div', { class: 'piece folded' }, [el('div', { class: 'piece-head' }, [head])])
    return pieceBlock({ target: entry.name, title: entry.name, text: entry.content, busy, working, noRewrite: generated, head })
  }

  function avatarHero(draft) {
    const card = draft.card
    const plan = draft.plan
    const drawing = draft.job?.kind === 'avatar'
    const picture = card.avatar
      ? el('img', { class: 'hero-img', src: `/api/forge/${draft.id}/avatar?t=${encodeURIComponent(card.avatar.at)}`, alt: t`${plan.name}的头像` })
      : el('div', { class: 'hero-img blank' }, [el('span', { text: [...plan.name][0] ?? '?' })])
    const scene = el('textarea', { class: 'hero-scene', rows: 3, placeholder: 'English tags for the picture: 1girl, wet hair, raincoat, convenience store, night, rain' })
    // An uploaded picture has no scene of its own: show the plan's.
    scene.value = state.avatarDesc ?? (card.avatar?.description || plan.avatar.tags)
    scene.addEventListener('input', () => (state.avatarDesc = scene.value))
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => uploadAvatar(upload.files[0]) })
    const error = draft.error?.kind === 'avatar' ? el('p', { class: 'hint warn', text: draft.error.message }) : null
    return el('section', { class: 'forge-hero-card' }, [
      el('div', { class: `hero-frame${drawing ? ' drawing' : ''}` }, [picture, drawing ? el('span', { class: 'hero-busy' }, [el('span', { class: 'dots' }), t`正在画…`]) : null]),
      el('div', { class: 'hero-body' }, [
        el('p', { class: 'plan-name', text: plan.name }),
        plan.summary ? el('p', { class: 'plan-summary', text: plan.summary }) : null,
        el('p', { class: 'hint', text: card.avatar ? t`头像${card.avatar.source === 'upload' ? t`是你上传的` : t`由 ${card.avatar.backend || t`画图后端`} 画`}。` : t`还没有头像：用「配图」里设好的画图方式画一张，或者上传一张；都没有的话，保存时会做一张带名字的头像。` }),
        el('label', { class: 'hero-label', text: t`画面描述` }),
        scene,
        error,
        el('div', { class: 'row' }, [
          drawing
            ? el('button', { type: 'button', class: 'btn', text: t`停下`, onclick: () => stopJob() })
            : el('button', { type: 'button', class: 'btn', text: card.avatar ? t`换一张` : t`画头像`, disabled: Boolean(draft.job), onclick: () => drawAvatar(scene.value) }),
          el('button', { type: 'button', class: 'btn ghost', text: t`上传图片`, disabled: Boolean(draft.job), onclick: () => upload.click() }),
          upload,
        ]),
        // 抽图历史: the avatars it had before; one taken back is the avatar, the one now joins them.
        historyStrip(el, (card.avatarHistory ?? []).map(entry => ({ ...entry, src: `/api/forge/${draft.id}/history/${entry.file}` })), {
          title: t`以前的头像`,
          onPick: item => takeKeptAvatar(item),
          onRemove: item => dropKeptAvatar(item),
        }),
      ]),
    ])
  }

  /** A name card for a card without a picture: the first character large, on a quiet colour from the name. */
  function nameCard(name) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 768
    const g = canvas.getContext('2d')
    const hues = [198, 28, 160, 340, 255, 45]
    const hue = hues[[...name].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % hues.length]
    g.fillStyle = `hsl(${hue} 26% 20%)`
    g.fillRect(0, 0, 512, 768)
    g.fillStyle = `hsl(${hue} 50% 72% / .16)`
    g.beginPath()
    g.arc(372, 210, 128, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = `hsl(${hue} 30% 92%)`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = '600 230px "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif'
    g.fillText([...name][0] ?? '?', 256, 400)
    g.font = '500 44px "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif'
    g.fillText([...name].slice(0, 10).join(''), 256, 640)
    return canvas.toDataURL('image/png')
  }

  // ─── Actions ──────────────────────────────────────────────────────────
  const start = guard(async () => {
    const text = state.idea.trim()
    if (!text && !state.references.length) {
      toast(t`先说说你想要一张什么样的卡，一句话也行`)
      return
    }
    await offerCopy(text, state.references, changeHomeMode)
    const draft = await api('/api/forge', { method: 'POST', body: { text, model: state.homeModel, options: state.options, references: state.references } })
    state.idea = ''
    state.ideas = []
    state.references = []
    state.homeReading = ''
    apply(draft)
  })

  // 附文件: on a draft they go onto it; before there is one the page keeps what the server read of them.
  const addFiles = guard(async () => {
    const files = [...view.file.files]
    view.file.value = ''
    for (const file of files) {
      const body = await referenceBody(file)
      if (state.draft) apply(await api(`/api/forge/${state.draft.id}/references`, { method: 'POST', body }))
      else {
        state.references.push(await api('/api/forge/references', { method: 'POST', body: { ...body, have: state.references.map(item => item.chars) } }))
        redrawHome()
      }
    }
  })

  const toggleReading = guard(async item => {
    if (state.readingRef === item.id) return closeReading()
    const { text } = await api(`/api/forge/${state.draft.id}/references/${item.id}`)
    state.readingRef = item.id
    view.refText.replaceChildren(el('pre', { text }))
    view.refText.hidden = false
  })

  const dropReference = guard(async item => apply(await api(`/api/forge/${state.draft.id}/references/${item.id}`, { method: 'DELETE' })))

  function toggleHomeReading(item) {
    state.homeReading = state.homeReading === item.id ? '' : item.id
    redrawHome()
  }

  function dropHomeReference(item) {
    state.references = state.references.filter(other => other !== item)
    redrawHome()
  }

  /** The home view again, with what was typed (it lives in state.idea). */
  function redrawHome() {
    if (state.draft) return
    state.shown = ''
    renderMain()
  }

  // 给我灵感 / 换一批: a few ideas from the model, none of the ones shown before.
  const inspire = guard(async () => {
    state.ideasBusy = true
    redrawHome()
    try {
      const { ideas } = await api('/api/forge/ideas', { method: 'POST', body: { model: state.homeModel, options: state.options, exclude: state.ideasSeen } })
      state.ideas = ideas
      state.ideasSeen = [...state.ideasSeen, ...ideas.map(item => item.title)].slice(-40)
    } finally {
      state.ideasBusy = false
      redrawHome()
    }
  })

  // 交给 Cica: one idea, put in the box as if picked, ready to start.
  const askCica = guard(async () => {
    state.cicaBusy = true
    redrawHome()
    try {
      const { ideas } = await api('/api/forge/ideas', { method: 'POST', body: { model: state.homeModel, options: state.options, exclude: state.ideasSeen, count: 1 } })
      const [item] = ideas
      state.idea = t`${item.title}：${item.pitch}`
      state.ideasSeen = [...state.ideasSeen, item.title].slice(-40)
    } finally {
      state.cicaBusy = false
      redrawHome()
    }
  })

  const send = guard(async () => {
    const draft = state.draft
    if (view.send.disabled) return
    const body = { text: view.composer.value.trim(), picks: picksList() }
    await offerCopy(body.text, draft.references ?? [], changeDraftMode)
    const next = await api(`/api/forge/${draft.id}/say`, { method: 'POST', body })
    view.composer.value = ''
    apply(next)
  })

  const makePlan = guard(async (variants = false) => {
    const draft = state.draft
    if (draft.brief.readiness < 50 && !confirm(t`关键的设定还没聊清楚，现在出方案，向导会补很多它自己的设想。还是现在出？`)) return
    // Words typed but not sent still count.
    if (view.composer.value.trim() || picksList().length) {
      if (!confirm(t`输入框里还有没发出去的话。先出方案的话，这些不会算进去。继续？`)) return
    }
    apply(await api(`/api/forge/${draft.id}/plan`, { method: 'POST', body: { variants } }))
  })

  const revise = guard(async () => {
    const notes = [...state.notes.entries()].filter(([, text]) => text.trim()).map(([section, text]) => ({ section, text }))
    const next = await api(`/api/forge/${state.draft.id}/revise`, { method: 'POST', body: { text: state.planText, notes } })
    state.notes = new Map()
    state.planText = view.planText.value = ''
    apply(next)
  })

  // `model`: 换这个模型重写, another model for this retry only.
  const retry = guard(async (model = '') => apply(await api(`/api/forge/${state.draft.id}/retry`, { method: 'POST', body: model ? { model } : {} })))
  const undo = guard(async () => {
    if (!confirm(t`撤回你上一次的回答和向导对它的回复？`)) return
    apply(await api(`/api/forge/${state.draft.id}/undo`, { method: 'POST' }))
  })
  const stopJob = guard(async () => {
    await api(`/api/forge/${state.draft.id}/stop`, { method: 'POST' })
    apply(await api(`/api/forge/${state.draft.id}`))
  })
  const startWrite = guard(async (restart = false) => {
    const draft = state.draft
    if (draft.card?.writtenAt && !restart) return setStage('polish')
    if (restart && !confirm(t`按现在的方案从头再写一遍？已经写好的内容和你的修改都会被替换（头像保留）。`)) return
    state.open = new Set()
    apply(await api(`/api/forge/${draft.id}/write`, { method: 'POST', body: { restart } }))
  })

  const rewrite = guard(async (target, note) => {
    const text = String(note ?? '').trim()
    if (!text) {
      toast(t`先写下想怎么改`)
      return
    }
    state.noteFor = null
    state.noteText = ''
    state.open.add(target)
    apply(await api(`/api/forge/${state.draft.id}/rewrite`, { method: 'POST', body: { target, note: text } }))
  })

  const saveEdit = guard(async (target, text) => {
    const body = target === 'description' ? { description: text } : target === 'notes' ? { creatorNotes: text } : /^开场白\d+$/.test(target) ? { greetings: state.draft.card.greetings.map((g, i) => (zh`开场白${i + 1}` === target ? text : g.text)) } : { entries: [{ name: target, content: text }] }
    const next = await api(`/api/forge/${state.draft.id}/card`, { method: 'PUT', body })
    state.editing = null
    state.editText = null
    apply(next)
  })

  const drawAvatar = guard(async description => {
    const picked = await pickDraw({ title: state.draft.card?.avatar ? t`换一张头像` : t`画头像`, note: t`按方案里的长相和上面的画面描述画。` })
    if (!picked) return
    apply(await api(`/api/forge/${state.draft.id}/avatar`, { method: 'POST', body: { description, ...picked.body } }))
  })

  const takeKeptAvatar = guard(async item => {
    if (state.draft.job) return
    apply(await api(`/api/forge/${state.draft.id}/history/${item.file}/use`, { method: 'POST' }))
  })

  const dropKeptAvatar = guard(async item => apply(await api(`/api/forge/${state.draft.id}/history/${item.file}`, { method: 'DELETE' })))

  const uploadAvatar = guard(async file => {
    if (!file) return
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error(t`读不了这张图片`))
      reader.readAsDataURL(file)
    })
    apply(await api(`/api/forge/${state.draft.id}/avatar`, { method: 'PUT', body: { image } }))
  })

  const saveCard = guard(async () => {
    const draft = state.draft
    const avatar = draft.card.avatar ? await pngOf(`/api/forge/${draft.id}/avatar?t=${encodeURIComponent(draft.card.avatar.at)}`) : nameCard(draft.plan.name)
    let result = await api(`/api/forge/${draft.id}/save`, { method: 'POST', body: { avatar, ask: true } })
    // Edited since in 修改角色卡 or 检查这张卡 (say from 试玩体检 here): updating puts the draft back over that.
    if (result.changedElsewhere) {
      const picture = result.pictureChanged ? `\n\n${t`头像在别处换过：更新会换回向导里的头像，现在这张收进「旧图」，在「修改角色卡」里还能换回来。`}` : ''
      if (!confirm(t`「${result.card.name}」保存之后在别处改过（比如「修改角色卡」「检查这张卡」）。更新会用向导里的内容整张换掉，那些修改会没有。还要更新吗？` + picture)) return
      result = await api(`/api/forge/${draft.id}/save`, { method: 'POST', body: { avatar } })
    }
    apply(result.draft)
    await onCardSaved?.(result.card.id)
    if (result.updated) toast(t`「${result.card.name}」已更新，原来的对话都还在。`)
    else toast(t`已保存为角色卡「${result.card.name}」，在左边的角色卡列表里。角色名册（长相、衣着）也一起建好了。`, 8000, { action: { text: t`写一张新卡`, run: () => goHome() } })
  })

  const startChat = guard(async () => {
    const id = state.draft?.card?.savedCardId
    if (!id) return
    dialog.close()
    await startChatWith?.(id)
  })

  // 试玩体检 on the saved card, over this window: closing it comes back here.
  const startTrial = guard(async () => {
    const card = state.draft?.card
    if (!card?.savedCardId) return
    await openTrial?.(card.savedCardId, { changed: Boolean(card.changedSinceSave), forge: true })
  })

  // 做成视觉小说: a new chat with the card, in the mode, and its pictures drawn (the plan's places get backgrounds).
  const startVn = guard(async () => {
    // Not saved yet: saved first (the visual novel plays the saved card).
    if (!state.draft?.card?.savedCardId) await saveCard()
    const id = state.draft?.card?.savedCardId
    if (!id) return
    const places = (state.draft.plan?.world?.places ?? []).map(place => place.name)
    dialog.close()
    await makeVisualNovel?.(id, places)
  })

  const setStage = guard(async stage => {
    if (!state.draft || stage === state.draft.stage || !STAGE_TEXT[stage]) return
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { stage } }))
  })

  const changeModel = guard(async () => {
    const value = view.model.value
    if (value === MANAGE_PROVIDERS) {
      renderModels(true)
      openProviders?.()
      return
    }
    if (!state.draft) {
      state.homeModel = value
      return
    }
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { model: value } }))
  })

  const openDraft = guard(async id => {
    state.shown = ''
    apply(await api(`/api/forge/${id}`))
  })

  const removeDraft = guard(async draft => {
    if (!confirm(t`删除草稿「${draft.title}」？聊过的内容和方案都会删掉。`)) return
    await api(`/api/forge/${draft.id}`, { method: 'DELETE' })
    await goHome()
  })

  const goHome = guard(async () => {
    clearTimeout(state.poll)
    state.draft = null
    state.shown = ''
    state.list = await api('/api/forge')
    render()
  })

  // ─── The chip outside the dialog: drafts being written in the background ───
  // Jobs run on the server whatever the page does. With the dialog closed, a chip in the corner
  // says what is being written and how far (polled every few seconds), then that it is done;
  // a click opens that draft.
  const chip = el('div', { class: 'forge-chip', hidden: true, role: 'status' })
  document.body.append(chip)
  const background = { timer: null, running: new Map(), done: null }

  async function watchBackground() {
    clearTimeout(background.timer)
    background.timer = null
    // With the dialog open the page itself shows the job: look again in a while, in case it is closed.
    if (dialog.open) {
      chip.hidden = true
      if (state.draft?.job) {
        background.running.set(state.draft.id, state.draft.title)
        background.timer = setTimeout(watchBackground, 3000)
      }
      return
    }
    const list = await api('/api/forge').catch(() => null)
    if (!list || dialog.open) return
    const running = list.filter(d => d.busy)
    // One that was running and is no longer: done, or stopped by an error.
    for (const [id, title] of background.running) {
      if (running.some(d => d.id === id)) continue
      const now = list.find(d => d.id === id)
      background.done = { id, title: now?.title ?? title, failed: Boolean(now?.error) }
    }
    background.running = new Map(running.map(d => [d.id, d.title]))
    drawChip(running)
    if (running.length) background.timer = setTimeout(watchBackground, 3000)
    else background.timer = null
  }

  function drawChip(running) {
    const open = id => {
      background.done = null
      chip.hidden = true
      openAt(id)
    }
    if (running.length) {
      const d = running[0]
      const p = d.progress
      const share = p ? Math.round((p.done / p.total) * 100) : null
      const step = d.job?.kind === 'write' ? p?.label || t`写卡` : d.job?.kind === 'plan' ? t`写方案` : d.job?.kind === 'discuss' ? t`向导在想` : t`进行中`
      chip.replaceChildren(
        el('button', { type: 'button', class: 'forge-chip-main', title: t`点开看进度`, onclick: () => open(d.id) }, [
          el('span', { class: 'dots' }),
          el('span', { class: 'forge-chip-text', text: t`正在创作「${d.title}」· ${step}${share !== null ? ` · ${share}%` : ''} · ${d.job ? elapsed(d.job.startedAt) : ''}${running.length > 1 ? t`（还有 ${running.length - 1} 张）` : ''}` }),
        ]),
        el('div', { class: `forge-progress${share === null ? ' unknown' : ' running'}` }, el('i', share === null ? {} : { style: `width: ${share}%` })),
      )
      chip.className = 'forge-chip'
      chip.hidden = false
      return
    }
    if (background.done) {
      const { id, title, failed } = background.done
      chip.replaceChildren(
        el('button', { type: 'button', class: 'forge-chip-main', onclick: () => open(id) }, [el('span', { class: 'forge-chip-text', text: failed ? t`「${title}」写到一半停下了，点开看看` : t`「${title}」这一步完成了，点开看看` })]),
        el('button', { type: 'button', class: 'forge-chip-close', 'aria-label': t`关掉`, text: '×', onclick: () => { background.done = null; chip.hidden = true } }),
      )
      chip.className = `forge-chip ${failed ? 'failed' : 'done'}`
      chip.hidden = false
      return
    }
    chip.hidden = true
  }

  // Closed while something is being written: it goes on on the server, and the chip follows it.
  dialog.addEventListener('close', () => {
    clearTimeout(state.poll)
    watchBackground()
    onClosed?.()
  })
  // Esc while editing a sketch item only ends the edit (handled there).

  const forge = {
    /** @param id - a draft to open at once (the chip for a job running in the background). */
    async open(id = '') {
      clearTimeout(background.timer)
      chip.hidden = true
      if (!view.main) layout()
      await loadModels()
      const persona = await api('/api/persona').catch(() => null)
      state.settingsName = /^(你|you)?$/i.test(String(persona?.name ?? '').trim()) ? '' : persona.name.trim()
      if (!dialog.open) dialog.showModal()
      if (id) await openDraft(id)
      else if (state.draft) {
        state.shown = ''
        await openDraft(state.draft.id)
      } else await goHome()
    },
    /** Look for drafts being written (the page has just loaded: a job may have gone on without it). */
    watch: () => watchBackground(),
  }
  const openAt = guard(id => forge.open(id))
  return forge
}
