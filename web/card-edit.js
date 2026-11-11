// 修改角色卡 (the card list's ⋯ → 修改角色卡): a saved card's fields edited in
// place, its picture, its own worldbook (the entries window, web/books.js), and
// 对话修改: say what to change, the model writes the pieces out again
// (server/forge/edit.mjs, a job run like a 创作角色卡 draft's), they show as
// before and after, and only the ticked ones go into the card.
//
// 生成头像 draws one for the card (server/media.mjs drawAvatar) with the 画图方式
// and model picked for it (web/draw-choice.js); it shows beside the buttons to
// take, draw again or drop, and only taking it changes the card. Avatars drawn
// and not taken, and the ones replaced, stay below it to take back (抽图历史,
// server/draw-history.mjs).
//
// Each field saves when it loses focus. The card keeps its id, so its chats,
// cast, sprites, scenes and picture settings stay. A chat renders the card into
// its frozen prefix when it starts: an edit that reaches it leaves an open chat
// on the old text until applied (the bar the preset and entries windows show).
//
// 状态栏: the card's bar as 检查这张卡 has it (GET /api/cards/:id/check/status), its
// look and rows edited with the same editor (card-check.js statusEditor, imported
// when it is first opened) and saved as 调整状态栏 is there, so it shows in that
// window's 已采用 and can be taken back from either. 对话修改 can change it too:
// the model writes the layout, it shows as a preview and before and after.
import { t } from '/i18n.js'
import { pngOf } from '/forge.js'
import { CARD_FIELDS } from '/shared/card-edit.js'
import { EFFECTS, cleanStatusSpec } from '/shared/status.js'
import { coverWords } from '/shared/cover.js'
import { coverPage } from '/cover.js'
import { statusBar } from '/status.js'
import { createTalk } from '/talk.js'
import { historyStrip, keptItems } from '/draw-choice.js'

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'

// [label, what it is]; the ones in the prefix say so with a tag.
const FIELD_TEXT = {
  name: [t`名字`, ''],
  description: [t`描述`, t`角色是谁、长什么样、和你是什么关系。`],
  personality: [t`性格`, ''],
  scenario: [t`场景`, t`故事开始时的处境。`],
  mesExample: [t`对话示例`, t`示范角色怎么说话，几段之间用 <START> 隔开。`],
  systemPrompt: [t`系统提示`, t`卡作者给模型的总体指示。`],
  postHistoryInstructions: [t`每轮都要遵守`, t`SillyTavern 的 Post-History Instructions：每轮回复都要遵守的要求。`],
  depthPrompt: [t`角色备注`, t`每轮随消息发送的提醒，改了下一轮就生效。`],
  creatorNotes: [t`创作者备注`, t`给玩家看的说明，不发给模型。`],
  creator: [t`作者`, ''],
  tags: [t`标签`, ''],
}
const inPrefix = key => CARD_FIELDS.find(f => f.key === key)?.prefix === true
const IDEAS = [t`让她说话更冷淡一点`, t`加一个青梅竹马的 NPC 条目`, t`开场白短一点，结尾留个悬念`, t`把对话里后来出场的角色加进设定和变量`, t`状态栏换成暗色的配色，好感度用进度条`]
// 对话修改 kept to the status bar: the id its change has (server/forge/edit.mjs STATUS_TARGET).
const STATUS = 'statusBar'

/**
 * @param deps - { api, el, toast, guard, saveFile, getChat, isGenerating, openProviders, openCheck(cardId) (检查这张卡),
 *   openBook(cardId) (the entries window on the card's own book), onChatChanged(chatView),
 *   onCardChanged(cardId, { avatar }) (the list, the card's details and its picture follow),
 *   pickDraw(options) (web/draw-choice.js: the 画图方式 and model for one drawing) }
 */
export function initCardEdit({ api, el, toast, guard, saveFile, saveDownload = null, getChat, isGenerating, openProviders, openCheck, openBook, onChatChanged, onCardChanged, pickDraw }) {
  const $ = id => document.getElementById(id)
  const dialog = $('card-edit-dialog')
  const state = {
    card: null, // GET /api/cards/:id/edit
    stale: false, // a saved edit reached the prefix; the open chat on this card has not applied it
    told: false, // the prefix toast was shown (no open chat on this card)
    pane: 'card', // on a phone: 'card' or 'assist'
    saving: Promise.resolve(),
    drawn: null, // 生成头像: { busy, picked } while drawing, then { image, backend, note, history, picked } to take or drop
    kept: [], // 抽图历史: the avatars kept (replaced, or drawn and not taken), newest first
    withRegex: false, // the exports take the 正则集 attached to the card along (?regex=sets)
    status: null, // 状态栏: GET /api/cards/:id/check/status; null while it is read, or from a server without it
    tuning: null, // 调整样式 open: what statusEditor keeps, { spec, paged }
  }
  const view = {}

  // ─── Skeleton ─────────────────────────────────────────────────────────
  function layout() {
    view.sub = el('span', { class: 'forge-sub' })
    view.status = el('span', { class: 'ce-status', 'aria-live': 'polite' })
    const close = el('button', { type: 'button', class: 'btn ghost icon', title: t`关闭`, 'aria-label': t`关闭`, html: ICON_CLOSE, onclick: () => dialog.close() })
    view.tabs = el('div', { class: 'ce-tabs', role: 'tablist' }, [
      el('button', { type: 'button', role: 'tab', 'data-pane': 'card', text: t`卡片`, onclick: () => showPane('card') }),
      el('button', { type: 'button', role: 'tab', 'data-pane': 'assist', text: t`对话修改`, onclick: () => showPane('assist') }),
    ])
    view.main = el('div', { class: 'forge-main ce-main' })
    view.assist = el('aside', { class: 'ce-assist' }, [
      el('header', { class: 'ce-assist-head' }, [el('h3', { text: t`对话修改` }), talk.clear]),
      talk.thread,
      talk.compose,
    ])
    // 应用到当前对话: above both halves, so a phone showing 对话修改 sees it too.
    view.apply = el('div', { class: 'ce-apply-slot', 'aria-live': 'polite' })
    view.body = el('div', { class: 'ce-body' }, [view.main, view.assist])
    dialog.replaceChildren(
      el('div', { class: 'forge ce' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: t`修改角色卡` }), view.sub]),
          view.tabs,
          el('div', { class: 'forge-tools' }, [view.status, talk.model, close]),
        ]),
        view.apply,
        view.body,
      ]),
    )
  }

  function showPane(pane) {
    state.pane = pane
    view.body.dataset.pane = pane
    for (const tab of view.tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.pane === pane))
    if (pane === 'assist') queueMicrotask(() => talk.scroll())
  }

  // ─── Data ─────────────────────────────────────────────────────────────
  /** A card view from the server; fromForge is only worked out when the window opens. */
  function absorb(card) {
    // regexSets (the 正则集 attached) come with the window's own read, as fromForge does.
    state.card = { ...card, fromForge: card.fromForge ?? state.card?.fromForge ?? false, regexSets: card.regexSets ?? state.card?.regexSets ?? [] }
    view.sub.textContent = state.card.name
  }

  /** Saves go one after another, and a request to the model waits for them. */
  function queue(fn) {
    const next = state.saving.then(fn)
    state.saving = next.catch(() => {})
    return next
  }

  // ─── The card ─────────────────────────────────────────────────────────
  function renderMain() {
    const top = view.main.scrollTop
    const card = state.card
    view.main.replaceChildren(
      el('div', { class: 'forge-polish ce-card' }, [
        hero(card),
        el('section', { class: 'plan-card' }, [
          el('header', {}, [el('h4', { text: t`角色定义` })]),
          el('p', { class: 'hint', text: t`标着「固定前缀」的几项在对话开局时写进固定前缀：新对话直接用改过的，进行中的对话要「应用到当前对话」才会用上。` }),
          ...['description', 'personality', 'scenario', 'mesExample'].map(key => fieldBlock(key)),
        ]),
        greetingsSection(card),
        bookSection(card),
        (view.statusBox = el('div', { class: 'ce-status-slot' })),
        el('section', { class: 'plan-card' }, [
          el('header', {}, [el('h4', { text: t`给模型的指示` })]),
          ...['systemPrompt', 'postHistoryInstructions', 'depthPrompt'].map(key => fieldBlock(key, { rows: 3 })),
        ]),
        el('section', { class: 'plan-card' }, [el('header', {}, [el('h4', { text: t`给玩家看的` })]), fieldBlock('creatorNotes', { rows: 3 })]),
        (view.coverBox = el('section', { class: 'plan-card' })),
      ]),
    )
    renderCover()
    syncKept()
    renderStatus()
    view.main.scrollTop = top
  }

  /**
   * Only the picture part of the top section again (the picture, its buttons, a
   * drawn one waiting): a field being typed in, the name and tags too, stays.
   */
  function renderPicture() {
    const old = view.main.querySelector('.ce-hero')
    if (!old) return renderMain()
    const keptBox = view.keptBox
    const next = hero(state.card)
    view.keptBox = keptBox
    old.querySelector('.hero-frame').replaceWith(next.querySelector('.hero-frame'))
    old.querySelector('.hero-body > .row').replaceWith(next.querySelector('.hero-body > .row'))
    old.querySelector('.ce-drawn')?.remove()
    const drawn = next.querySelector('.ce-drawn')
    if (drawn) keptBox.before(drawn)
    syncKept()
  }

  function showApply() {
    const bar = prefixBar()
    view.apply.replaceChildren(...(bar ? [bar] : []))
  }

  function prefixBar() {
    if (!state.stale || getChat()?.cardId !== state.card.id) return null
    return el('div', { class: 'preset-apply ce-apply' }, [
      el('span', { text: t`当前对话的固定前缀还是改动前的版本。应用后，下一轮会重新写入一次缓存。` }),
      el('button', { class: 'btn small primary', type: 'button', disabled: isGenerating(), text: t`应用到当前对话`, onclick: guard(applyToChat) }),
    ])
  }

  function hero(card) {
    const drawn = state.drawn
    const picture = drawn?.image
      ? el('img', { class: 'hero-img square', src: drawn.image, alt: t`新画的头像` })
      : card.hasAvatar
        ? el('img', { class: 'hero-img', src: `/api/cards/${card.id}/avatar?v=${state.avatarAt ?? 0}`, alt: t`${card.name}的头像` })
        : el('div', { class: 'hero-img blank' }, [el('span', { text: [...card.name][0] ?? '?' })])
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => changeAvatar(upload.files[0]) })
    const name = el('input', { class: 'ce-name', value: card.name, maxlength: '200', 'aria-label': t`名字` })
    name.addEventListener('change', () => {
      if (!name.value.trim()) {
        name.value = state.card.name
        toast(t`名字不能空着`)
        return
      }
      save({ name: name.value })
    })
    const tags = el('input', { value: card.tags.join(', '), placeholder: t`用逗号分开`, 'aria-label': t`标签` })
    tags.addEventListener('change', () => save({ tags: tags.value }))
    const creator = el('input', { value: card.creator ?? '', maxlength: '200', 'aria-label': t`作者` })
    creator.addEventListener('change', () => save({ creator: creator.value }))
    const android = document.documentElement.dataset.edition === 'android'
    return el('section', { class: 'forge-hero-card ce-hero' }, [
      el('div', { class: `hero-frame${drawn?.busy ? ' drawing' : ''}` }, [picture, drawn?.busy ? el('span', { class: 'hero-busy' }, [el('span', { class: 'dots' }), t`正在画…`]) : null]),
      el('div', { class: 'hero-body' }, [
        el('div', { class: 'ce-name-row' }, [name, el('span', { class: 'strategy on', title: t`写进对话开局时的固定前缀`, text: t`固定前缀` })]),
        el('div', { class: 'ce-meta' }, [
          el('label', {}, [el('span', { text: t`标签` }), tags]),
          el('label', {}, [el('span', { text: t`作者` }), creator]),
        ]),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', class: 'btn small', text: card.hasAvatar ? t`换头像` : t`上传头像`, disabled: Boolean(drawn?.busy), onclick: () => upload.click() }),
          upload,
          el('button', { type: 'button', class: 'btn small', text: t`生成头像`, title: t`按这张卡的角色画一张方形头像，可以选画图方式和模型`, disabled: Boolean(drawn?.busy), onclick: () => drawAvatar() }),
          // The phone app saves it itself (saveDownload), one from before that cannot.
          card.hasAvatar && (!android || saveDownload) ? el('a', { class: 'btn small ghost', href: `/api/cards/${card.id}/png?v=${Date.now()}${state.withRegex ? '&regex=sets' : ''}`, download: `${card.name}.png`, onclick: event => {
            if (!saveDownload) return
            event.preventDefault()
            saveDownload(new URL(event.currentTarget.href).pathname + new URL(event.currentTarget.href).search, `${card.name}.png`, 'image/png')
          }, title: t`图片里带着整张卡（包括这里的修改），SillyTavern 可以直接导入`, text: t`导出 PNG` }) : null,
          el('button', { type: 'button', class: 'btn small ghost', text: t`导出 JSON`, title: t`SillyTavern 的角色卡 JSON，包括这里的修改`, onclick: () => exportJson() }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`检查这张卡`, title: t`查写错和对不上的地方，也可以让模型提优化建议`, onclick: guard(async () => { await state.saving; await openCheck(state.card.id) }) }),
        ]),
        regexChoice(card),
        drawn?.image ? drawnBox(drawn) : null,
        (view.keptBox = el('div', { class: 'ce-kept' })),
        el('p', { class: 'hint', text: t`改动直接存进这张卡，对话、角色名册、立绘、场景和配图设置都不变。` }),
        el('p', { class: 'hint', text: card.fromForge ? t`这张卡是「创作角色卡」做的：在那边再点「更新这张卡」，会换回草稿里的内容。` : t`从文件重新导入这张卡（选更新原来的卡）时，会换成文件里的版本，这里的修改不保留。` }),
      ]),
    ])
  }

  /** A drawn avatar waiting: take it, draw again (the same way or another), or drop it. */
  function drawnBox(drawn) {
    return el('div', { class: 'ce-drawn' }, [
      el('p', { text: [t`左边是新画的头像（${drawn.backend}），还没换上。`, drawn.history ? t`再画一张，这张会留在下面。` : '', drawn.note].filter(Boolean).join(' ') }),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'btn small primary', text: t`用这张`, onclick: () => takeDrawn() }),
        el('button', { type: 'button', class: 'btn small', text: t`再画一张`, onclick: () => drawAvatar(drawn.picked) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`换个画法…`, onclick: () => drawAvatar() }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`不要了`, onclick: () => dropDrawn() }),
      ]),
    ])
  }

  function fieldBlock(key, { rows = 4 } = {}) {
    const [label, hint] = FIELD_TEXT[key]
    const value = state.card[key] ?? ''
    const area = el('textarea', { class: 'ce-text', rows: String(Math.min(16, Math.max(rows, value.split('\n').length + 1))), spellcheck: 'false', 'aria-label': label })
    area.value = value
    area.addEventListener('change', () => save({ [key]: area.value }))
    return el('div', { class: 'ce-field' }, [
      el('div', { class: 'ce-field-head' }, [
        el('b', { text: label }),
        inPrefix(key) ? el('span', { class: 'strategy on', title: t`写进对话开局时的固定前缀`, text: t`固定前缀` }) : null,
        el('span', { class: 'grow' }),
        el('span', { class: 'ce-count', text: value ? t`${value.length.toLocaleString()} 字` : '' }),
        askButton(`field:${key}`, label),
      ]),
      hint ? el('p', { class: 'hint', text: hint }) : null,
      area,
    ])
  }

  /** 按意见改: the next request is kept to this piece. */
  function askButton(id, label) {
    return el('button', { type: 'button', class: 'btn ghost small', text: t`按意见改`, title: t`在「对话修改」里说说这一处想怎么改`, onclick: () => aim(id, label) })
  }

  function greetingsSection(card) {
    const list = card.greetings.length ? card.greetings : ['']
    const areas = []
    const saveAll = () => save({ greetings: areas.map(area => area.value) }, { redraw: true })
    const blocks = list.map((text, i) => {
      const area = el('textarea', { class: 'ce-text', rows: String(Math.min(14, Math.max(4, text.split('\n').length + 1))), spellcheck: 'false', 'aria-label': t`开场白 ${i + 1}` })
      area.value = text
      area.addEventListener('change', saveAll)
      areas.push(area)
      const label = i === 0 ? t`开场白 1（第一条）` : t`开场白 ${i + 1}`
      return el('div', { class: 'ce-field' }, [
        el('div', { class: 'ce-field-head' }, [
          el('b', { text: label }),
          el('span', { class: 'grow' }),
          el('span', { class: 'ce-count', text: text ? t`${text.length.toLocaleString()} 字` : '' }),
          askButton(`greeting:${i}`, label),
          i > 0 ? el('button', { type: 'button', class: 'btn ghost small danger', text: t`删除`, onclick: () => { if (confirm(t`删除开场白 ${i + 1}？`)) save({ greetings: areas.filter(a => a !== area).map(a => a.value) }, { redraw: true }) } }) : null,
        ]),
        area,
      ])
    })
    const addRow = el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`＋ 添加开场白`, onclick: () => addGreeting(areas, addRow, saveAll) })])
    return el('section', { class: 'plan-card' }, [
      el('header', {}, [el('h4', { text: t`开场白 · ${card.greetings.filter(g => g.trim()).length} 条` })]),
      el('p', { class: 'hint', text: t`开新对话时选一条。改了不影响已经开始的对话。` }),
      ...blocks,
      addRow,
    ])
  }

  /**
   * A box for one more opening, kept once it has text (a blank one is dropped on save).
   * It joins `areas`, so deleting another opening keeps it.
   */
  function addGreeting(areas, addRow, saveAll) {
    if (addRow.previousElementSibling?.classList.contains('ce-new-greeting')) return addRow.previousElementSibling.querySelector('textarea').focus()
    const area = el('textarea', { class: 'ce-text', rows: '5', spellcheck: 'false', placeholder: t`新的开场白`, 'aria-label': t`开场白 ${areas.length + 1}` })
    area.addEventListener('change', saveAll)
    addRow.before(el('div', { class: 'ce-field ce-new-greeting' }, [el('div', { class: 'ce-field-head' }, [el('b', { text: t`开场白 ${areas.length + 1}（新）` })]), area]))
    areas.push(area)
    area.focus()
  }

  function bookSection(card) {
    const own = card.bookEntries
      ? t`卡里自带 ${card.bookEntries} 条（启用 ${card.bookEnabled}，其中常驻 ${card.bookConstant}）`
      : t`这张卡还没有自带世界书。`
    return el('section', { class: 'plan-card' }, [
      el('header', {}, [el('h4', { text: t`世界书` })]),
      el('p', { class: 'ce-book-line' }, [
        el('span', { text: own }),
        el('button', { type: 'button', class: 'btn small', text: card.bookEntries ? t`查看和编辑条目` : t`新建第一个条目`, onclick: () => editBook() }),
      ]),
      card.worldbookIds.length ? el('p', { class: 'hint', text: t`另外挂了 ${card.worldbookIds.length} 本独立世界书，在「设置 → 世界书与状态 → 挂载的世界书」里管理。` }) : null,
      el('p', { class: 'hint', text: t`人物、地点和设定的条目也可以在「对话修改」里让向导加，比如：加一个青梅竹马的 NPC 条目。` }),
    ])
  }

  // ─── 状态栏 ───────────────────────────────────────────────────────────
  /** Read the card's status bar part again; a server without it (not restarted yet) leaves the section out. */
  async function loadStatus(id = state.card?.id) {
    if (!id) return
    const status = await api(`/api/cards/${id}/check/status`).catch(() => null)
    if (state.card?.id !== id) return
    state.status = status
    renderStatus()
  }

  /** Only the 状态栏 section again: a field being typed in elsewhere stays. */
  function renderStatus() {
    if (!view.statusBox?.isConnected || !state.card) return
    view.statusBox.replaceChildren(...(state.status ? [statusSection(state.status)] : []))
  }

  /** The bar as it shows at the start of a chat, or a line saying there is none. */
  function barPreview(spec, variables, note = t`预览 · 初始值`) {
    const shown = cleanStatusSpec(spec)
    return el('div', { class: 'status-preview cc-status-preview' }, [(shown && statusBar(el, shown, variables, { collapsible: false, note })) || el('p', { class: 'hint', text: t`还没有要显示的项。` })])
  }

  function statusSection(data) {
    const tune = data.statusTune
    const busy = Boolean(state.statusBusy)
    const head = el('header', {}, [
      el('h4', { text: t`状态栏` }),
      el('span', { class: 'grow' }),
      data.ownBar ? null : askButton(STATUS, t`状态栏`),
    ])
    if (data.ownBar) return el('section', { class: 'plan-card ce-statusbar' }, [head, el('p', { class: 'hint', text: t`这张卡的状态栏是它自己的正则或脚本画的，这里调不了样式。` })])
    if (!tune) return el('section', { class: 'plan-card ce-statusbar' }, [head, el('p', { class: 'hint', text: t`这张卡没有变量，也就没有状态栏。想要的话点「按意见改」说说要记什么，比如：加一个好感度，显示在状态栏里。` })])
    const [change] = tune.changes
    // What is wrong with it (状态栏有几项对不上变量): fixed here as in 检查这张卡. A bar laid out from the variables is 调整样式's.
    const problems = data.findings.filter(item => item.level !== 'tip' && item.changes.length && !item.manual)
    const last = data.records.at(-1)
    if (state.tuning) {
      return el('section', { class: 'plan-card ce-statusbar' }, [
        head,
        el('p', { class: 'hint', text: change.before ? t`只改显示，不动变量，也不发给模型。保存后这张卡的对话都按新样式显示。` : t`这张卡还没有自己的状态栏，这是按变量排的一个。保存后它跟着卡走，导出到 SillyTavern 也在。` }),
        el('div', { class: 'cc-change' }, view.editor.statusEditor(el, change, state.tuning, { spare: tune.fields, state: data.state, redraw: renderStatus, design: { api, cardId: state.card.id, cover: state.card.cover ? { name: state.card.name, cover: state.card.cover } : null }, tryKey: state.card.id })),
        el('div', { class: 'cc-actions' }, [
          el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { state.tuning = null; renderStatus() } }),
          el('span', { class: 'grow' }),
          el('button', { type: 'button', class: 'btn primary small', disabled: busy, text: t`保存`, onclick: () => takeStatus([{ id: tune.id, edits: { [change.id]: { spec: state.tuning.spec } } }], t`状态栏已保存`) }),
        ]),
      ])
    }
    return el('section', { class: 'plan-card ce-statusbar' }, [
      head,
      el('p', { class: 'hint', text: data.statusBar ? t`主题、配色、标题、每项的名字和显示方式、分页都可以改，还能让模型写一套这张卡自己的外观。只改显示，不动变量。也可以点「按意见改」说给向导听。` : t`这张卡还没有自己的状态栏，对话里按变量自动排。点「调整样式」会按变量排一个给你改，保存后跟着卡走。` }),
      data.statusBar ? barPreview(data.statusBar, data.state) : null,
      ...problems.map(item => el('div', { class: 'ce-outcome-row' }, [
        el('p', { class: 'ce-outcome warn', text: item.why ? t`${item.title}：${item.why}` : item.title }),
        el('button', { type: 'button', class: 'btn small', disabled: busy, text: t`修好`, title: t`照「检查这张卡」的改法改，可以撤销`, onclick: () => takeStatus([{ id: item.id }], t`状态栏已修好`) }),
      ])),
      el('div', { class: 'cc-actions' }, [
        el('button', { type: 'button', class: 'btn small', text: t`调整样式`, title: t`直接改状态栏的主题、颜色和显示的内容，不用模型`, onclick: () => openTuning() }),
        el('span', { class: 'grow' }),
        last ? el('button', { type: 'button', class: 'btn ghost small', disabled: busy, text: t`撤销「${last.title}」`, title: t`改回这次调整之前的样子（也可以在「检查这张卡」的「已采用」里撤销）`, onclick: () => undoStatus(last.id) }) : null,
      ]),
    ].filter(Boolean))
  }

  /** 调整样式: the editor 检查这张卡 has, loaded the first time (it lives with that window's code). */
  const openTuning = guard(async () => {
    view.editor ??= await import('/card-check.js')
    state.tuning = {}
    renderStatus()
  })

  /** Into the card through 检查这张卡's taking in (POST …/check/apply): it is kept there, to take back. */
  const takeStatus = guard(async (items, message) => {
    if (state.statusBusy) return
    const id = state.card.id
    state.statusBusy = true
    renderStatus()
    let result
    try {
      await state.saving
      result = await queue(() => api(`/api/cards/${id}/check/apply`, { method: 'POST', body: { items } }))
    } finally {
      state.statusBusy = false
      renderStatus()
    }
    if (state.card?.id !== id) return
    state.tuning = null
    absorb(result.card)
    saved(result.prefix, message)
    const gaps = result.chatGaps
    if (gaps) {
      const names = gaps.labels.slice(0, 3).join(t`、`) + (gaps.labels.length > 3 ? t` 等 ${gaps.labels.length} 处` : '')
      toast(t`${message}。状态栏新加的「${names}」在 ${gaps.chats} 段已有对话里还没有这些变量，那里先显示不出来：等回复写上，或在右栏「状态」点「编辑」补上`, 9000)
    }
    await loadStatus(id)
    await onCardChanged?.(id)
  })

  const undoStatus = guard(async record => {
    const id = state.card.id
    state.statusBusy = true
    renderStatus()
    let result
    try {
      await state.saving
      result = await queue(() => api(`/api/cards/${id}/check/undo`, { method: 'POST', body: { record } }))
    } finally {
      state.statusBusy = false
      renderStatus()
    }
    if (state.card?.id !== id) return
    absorb(result.card)
    saved(result.prefix, t`已撤销`)
    await loadStatus(id)
    await onCardChanged?.(id)
  })

  // ─── 开场页 ───────────────────────────────────────────────────────────
  // What a new chat shows above the card's opening (web/cover.js): turned on, its words start as the creator's notes
  // (else the description) and are changed here. Saved as it is changed, like the card's other fields.
  function renderCover() {
    const card = state.card
    const cover = card.cover ?? null
    const put = patch => save({ cover: patch === null ? null : { ...(cover ?? {}), ...patch } }).then(() => renderCover())
    const box = el('input', { type: 'checkbox', onchange: () => {
      if (!box.checked) return put(null)
      const words = coverWords(card.creatorNotes || card.description)
      return put({ tagline: words.tagline, lines: words.lines.slice(0, 3) })
    } })
    box.checked = Boolean(cover)
    const names = { rain: t`雨`, snow: t`雪`, petals: t`花瓣`, embers: t`火星`, fireflies: t`萤火`, stars: t`星光`, dust: t`浮尘` }
    const effect = el('select', { 'aria-label': t`动效`, onchange: () => put({ effect: effect.value }) }, [el('option', { value: '', text: t`不要` }), ...EFFECTS.map(kind => el('option', { value: kind, text: names[kind] }))])
    effect.value = cover?.effect ?? ''
    const tagline = el('input', { type: 'text', maxlength: 60, 'aria-label': t`卡名下面的一句`, placeholder: t`卡名下面的一句`, onchange: () => put({ tagline: tagline.value }) })
    tagline.value = cover?.tagline ?? ''
    const lines = el('textarea', { rows: 3, 'aria-label': t`开场页上的几行字`, placeholder: t`再写几行，一行一句，最多 4 行`, onchange: () => put({ lines: lines.value.split('\n') }) })
    lines.value = (cover?.lines ?? []).join('\n')
    const abroad = el('input', { type: 'checkbox', onchange: () => put({ st: abroad.checked ? undefined : false }) })
    abroad.checked = cover?.st !== false
    const figure = el('input', { type: 'checkbox', onchange: () => put({ figure: figure.checked ? undefined : false }) })
    figure.checked = cover?.figure !== false
    const openings = card.greetings.filter(text => text.trim())
    const own = coverArtSrc(card)
    const avatar = card.hasAvatar ? `/api/cards/${card.id}/avatar` : ''
    // The preview has the picture picked for the cover, else the card's (the scenes and 立绘 show in a chat).
    const art = own || avatar ? { backdrop: own || avatar, soft: !own, portrait: cover?.figure === false ? '' : avatar, zoom: false } : null
    const page = cover ? coverPage(el, { name: card.name, by: (card.tags ?? []).slice(0, 3).join(' · ') || card.creator, cover, palette: card.statusBar?.palette ?? null, skin: card.statusBar?.skin ?? null, art, openings, picked: 0, onPick: async () => {} }) : null
    view.coverBox.replaceChildren(
      el('header', {}, [el('h4', { text: t`开场页` })]),
      el('p', { class: 'hint', text: t`新对话的开场白上面先显示一页：卡名、几行字，卡有好几个开场时每个开场一张可以点的卡片。图片用这张卡已有的头像、立绘和场景图，也可以给它单独选一张背景图。导出到 SillyTavern 时，这一页放在第一条开场白里（要装酒馆助手才显示，不带图片）。` }),
      el('div', { class: 'front-row' }, [
        el('label', { class: 'front-check' }, [box, el('span', { text: t`开场页` })]),
        cover ? el('label', { class: 'front-check' }, [el('span', { text: t`动效` }), effect]) : null,
        cover ? el('label', { class: 'front-check', title: t`带上：导出的卡第一条开场白是开场页（要装酒馆助手才显示；没装的人看到一行说明，要左右切换消息选开场）。不带：导出的卡和没有开场页时一样` }, [abroad, el('span', { text: t`导出到 SillyTavern 时带上开场页` })]) : null,
      ]),
      ...(cover ? [coverArtRow(card, figure), el('div', { class: 'front-words' }, [tagline, lines]), el('div', { class: 'front-preview' }, page.node)] : []),
    )
  }

  const coverArtSrc = card => (card.coverArt ? `/api/cards/${card.id}/cover-art?v=${card.coverArt}` : '')

  /**
   * 背景图: the picture behind the cover. Not picked, it is the scene the chat is at (else the card's picture, blurred);
   * picked, it is one of the player's own or one this card already has (its picture, a scene, someone's 立绘 or 人设图),
   * kept as the cover's own copy.
   */
  function coverArtRow(card, figure) {
    const own = coverArtSrc(card)
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: guard(async () => {
      const file = upload.files[0]
      upload.value = ''
      if (file) await setCoverArt(file)
    }) })
    const shelf = el('div', { class: 'front-art-picks', hidden: true })
    const choose = el('button', { type: 'button', class: 'btn small ghost', text: t`从这张卡的图里挑`, onclick: guard(async () => {
      if (!shelf.hidden) return (shelf.hidden = true)
      shelf.hidden = false
      shelf.replaceChildren(el('p', { class: 'hint', text: t`正在找这张卡的图…` }))
      const pictures = await cardPictures(card)
      shelf.replaceChildren(...(pictures.length
        ? pictures.map(item => el('button', { type: 'button', class: 'front-art-pick', title: item.label, onclick: guard(async () => {
            shelf.hidden = true
            await setCoverArt(await (await fetch(item.src)).blob())
          }) }, [el('img', { src: item.src, alt: '', loading: 'lazy', draggable: 'false' }), el('span', { text: item.label })]))
        : [el('p', { class: 'hint', text: t`这张卡还没有别的图：头像、场景图、立绘都没有。上传一张吧。` })]))
    }) })
    return el('div', { class: 'front-art' }, [
      el('div', { class: 'front-row' }, [
        el('span', { class: 'front-art-label', text: t`背景图` }),
        own ? el('img', { class: 'front-art-now', src: own, alt: t`开场页的背景图` }) : el('span', { class: 'hint', text: t`自动：对话所在地点的场景图，没有就用头像虚化` }),
        el('button', { type: 'button', class: 'btn small ghost', text: own ? t`换一张…` : t`上传图片…`, onclick: () => upload.click() }),
        choose,
        own ? el('button', { type: 'button', class: 'btn small ghost', text: t`用回自动的`, onclick: guard(() => clearCoverArt()) }) : null,
        el('label', { class: 'front-check', title: t`选的图里已经画了角色时可以去掉，开场页旁边就不再站一个立绘` }, [figure, el('span', { text: t`旁边放立绘` })]),
        upload,
      ]),
      shelf,
    ])
  }

  /** The pictures this card already has, to pick one for the cover from: { src, label }. */
  async function cardPictures(card) {
    const [media, drawn, places] = await Promise.all([
      api(`/api/cards/${card.id}/media`).catch(() => null),
      api(`/api/cards/${card.id}/sprites`).catch(() => null),
      api(`/api/cards/${card.id}/scenes`).catch(() => null),
    ])
    const list = card.hasAvatar ? [{ src: `/api/cards/${card.id}/avatar`, label: t`头像` }] : []
    for (const scene of places?.scenes ?? []) if (scene.file) list.push({ src: `/api/scenes/${card.id}/${scene.file}`, label: scene.name || t`场景` })
    for (const entry of media?.roster ?? []) {
      const sprite = drawn?.sprites?.[entry.id]?.file
      if (sprite) list.push({ src: `/api/sprites/${card.id}/${sprite}`, label: t`${entry.name}的立绘` })
      if (entry.ref) list.push({ src: `/api/cards/${card.id}/roster/${entry.id}/ref`, label: t`${entry.name}的人设图` })
    }
    return list
  }

  /** A picture (a file, or one the card has) as the cover's: made a JPEG of at most 1920 px on its long side. */
  async function setCoverArt(blob) {
    const image = await jpegOf(blob)
    const id = state.card.id
    const result = await queue(() => api(`/api/cards/${id}/cover-art`, { method: 'PUT', body: { image } }))
    if (state.card?.id !== id) return
    absorb(result)
    renderCover()
    saved(false, t`开场页的图已换`)
    await onCardChanged?.(id)
  }

  async function clearCoverArt() {
    const id = state.card.id
    const result = await queue(() => api(`/api/cards/${id}/cover-art`, { method: 'DELETE' }))
    if (state.card?.id !== id) return
    absorb(result)
    renderCover()
    saved(false, t`开场页用回自动的图`)
    await onCardChanged?.(id)
  }

  // ─── Saving ───────────────────────────────────────────────────────────
  /** Save a patch (PUT /api/cards/:id/edit); `redraw` draws the card again (greetings change shape). */
  function save(patch, { redraw = false } = {}) {
    const id = state.card.id
    return queue(guard(async () => {
      const result = await api(`/api/cards/${id}/edit`, { method: 'PUT', body: patch })
      if (state.card?.id !== id) return
      const nameChanged = result.name !== state.card.name
      absorb(result)
      if (!result.changed.length) return
      if (redraw || nameChanged || patch.tags !== undefined) renderMain()
      else refreshCounts()
      saved(result.prefix)
      await onCardChanged?.(id)
    }))
  }

  /** The character counts beside each field, after a save. */
  function refreshCounts() {
    for (const field of view.main.querySelectorAll('.ce-field')) {
      const area = field.querySelector('textarea')
      const count = field.querySelector('.ce-count')
      if (area && count) count.textContent = area.value ? t`${area.value.length.toLocaleString()} 字` : ''
    }
  }

  /** "已保存", and what a change to the prefix means for chats on this card. */
  function saved(prefix, message = t`已保存`) {
    view.status.textContent = message
    clearTimeout(state.statusTimer)
    state.statusTimer = setTimeout(() => (view.status.textContent = ''), 2500)
    if (!prefix) return
    if (getChat()?.cardId === state.card.id) {
      state.stale = true
      showApply()
    } else if (!state.told) {
      state.told = true
      toast(t`已保存。改的内容在对话开局时的固定前缀里：新对话直接用新的，这张卡进行中的对话要在「设置 → 更多」里重建前缀才会用上。`, 7000)
    }
  }

  async function applyToChat() {
    const chat = getChat()
    if (!chat || chat.cardId !== state.card.id) return
    const fresh = await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
    state.stale = false
    onChatChanged(fresh)
    showApply()
    toast(t`已重建固定前缀，下一轮生效`)
  }

  /** A picture as a JPEG data URL no larger than 1920 px on its long side (开场页的图). */
  async function jpegOf(blob) {
    const bitmap = await createImageBitmap(blob).catch(() => {
      throw new Error(t`读不出这张图片，换一张 PNG、JPG 或 WebP 试试`)
    })
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height))
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) })
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    return canvas.toDataURL('image/jpeg', 0.88)
  }

  /**
   * A picture the page can load as the card's avatar: made PNG, the card written into it on the server.
   * @param history - the kept picture it is (抽图历史): no longer kept once it is the avatar.
   */
  async function setAvatar(url, history = '') {
    const image = await pngOf(url)
    absorb(await queue(() => api(`/api/cards/${state.card.id}/avatar`, { method: 'PUT', body: { image, ...(history ? { history } : {}) } })))
    state.avatarAt = Date.now()
    renderPicture()
    saved(false, t`头像已换`)
    await onCardChanged?.(state.card.id, { avatar: true })
    // The one replaced is kept now.
    loadKept()
  }

  // ─── 抽图历史: the card's avatars before (server/draw-history.mjs) ──────
  /** The kept ones under the picture, but the one drawn and shown above it. */
  function syncKept() {
    if (!view.keptBox || !state.card) return
    const shown = state.drawn?.history
    const items = keptItems(state.card.id, state.kept.filter(entry => entry.file !== shown))
    view.keptBox.replaceChildren(...[historyStrip(el, items, { title: t`以前的头像`, onPick: item => takeKept(item), onRemove: item => dropKept(item) })].filter(Boolean))
  }

  /** Read the kept ones again (a server without them: none). */
  async function loadKept(id = state.card?.id) {
    if (!id) return
    const kept = await api(`/api/cards/${id}/history`).catch(() => null)
    if (state.card?.id !== id) return
    state.kept = kept?.slots?.avatar ?? []
    syncKept()
  }

  const takeKept = guard(async item => {
    if (state.drawn?.busy) return
    await setAvatar(item.src, item.file)
  })

  const dropKept = guard(async item => {
    const kept = await api(`/api/cards/${state.card.id}/history/${item.file}`, { method: 'DELETE' })
    state.kept = kept.slots?.avatar ?? []
    syncKept()
  })

  const changeAvatar = guard(async file => {
    if (!file) return
    const url = URL.createObjectURL(file)
    try {
      await setAvatar(url)
    } finally {
      URL.revokeObjectURL(url)
    }
  })

  /** 生成头像: asks how to draw it (`again`: the way it was drawn last), then shows what came back. */
  const drawAvatar = guard(async (again = null) => {
    if (state.drawn?.busy) return
    const picked = again ?? (await pickDraw({ title: t`生成头像`, note: t`按这张卡的角色画一张方形头像：脸和肩膀，用这张卡的画风。长相取角色名册里的；名册里没有，就让辅助模型从卡里读，再不行就照描述画。` }))
    if (!picked) return
    const id = state.card.id
    const before = state.drawn
    state.drawn = { busy: true, picked }
    renderPicture()
    try {
      const result = await api(`/api/cards/${id}/avatar/draw`, { method: 'POST', body: picked.body })
      if (state.card?.id === id) state.drawn = { ...result, picked }
    } catch (error) {
      if (state.card?.id === id) state.drawn = before?.image ? before : null
      throw error
    } finally {
      // Seconds later: only the picture, so what was typed meanwhile stays.
      if (state.card?.id === id) renderPicture()
    }
    // The one shown before is kept: it joins the row below.
    loadKept(id)
  })

  const takeDrawn = guard(async () => {
    if (!state.drawn?.image) return
    await setAvatar(state.drawn.image, state.drawn.history)
    state.drawn = null
    renderPicture()
  })

  /** 不要了: the drawn one goes, from the kept ones too. */
  const dropDrawn = guard(async () => {
    const file = state.drawn?.history
    state.drawn = null
    renderPicture()
    if (!file) return
    await api(`/api/cards/${state.card.id}/history/${file}`, { method: 'DELETE' })
    loadKept()
  })

  /** With 正则集 attached: whether the exports write them into the card, after its own scripts. */
  function regexChoice(card) {
    const sets = card.regexSets ?? []
    if (!sets.length) return null
    const count = sets.reduce((sum, set) => sum + set.scripts, 0)
    const box = el('input', { type: 'checkbox', checked: state.withRegex })
    box.addEventListener('change', () => {
      state.withRegex = box.checked
      renderPicture()
    })
    return el('label', { class: 'check-row ce-regex-choice', title: t`挂上的正则集：${sets.map(set => set.name).join(t`、`)}` }, [
      box,
      el('span', { text: t`导出时带上挂在这张卡上的正则集（${sets.length} 个，${count} 条）：写进卡的局部正则，排在卡自带的后面` }),
    ])
  }

  const exportJson = guard(async () => {
    await state.saving
    const json = await api(`/api/cards/${state.card.id}/sillytavern${state.withRegex && state.card.regexSets?.length ? '?regex=sets' : ''}`)
    saveFile(`${state.card.name}.json`, JSON.stringify(json, null, 2), t`已导出：SillyTavern 的角色卡 JSON，包括这里的修改。`)
  })

  const editBook = guard(async () => {
    await state.saving
    const id = state.card.id
    // The first entry makes the card's own book.
    if (!state.card.bookEntries) await api(`/api/cards/${id}/book`, { method: 'PUT', body: { add: { comment: t`新条目` } } })
    await openBook(id)
  })

  // ─── 对话修改 (talk.js) ───────────────────────────────────────────────
  const KIND_TEXT = { field: '', greeting: '', entry: t`世界书`, newEntry: t`新条目`, removeEntry: t`删除条目`, chatState: t`对话变量` }

  function changeTitle(change) {
    if (change.kind === 'field') return FIELD_TEXT[change.key]?.[0] ?? change.key
    if (change.kind === 'greeting') return change.index < state.card.greetings.length || change.before ? t`开场白 ${change.index + 1}` : t`开场白 ${change.index + 1}（新加）`
    if (change.kind === 'chatState') return `${KIND_TEXT.chatState} · ${change.path}`
    if (change.kind === 'statusBar') return change.before ? t`状态栏` : t`状态栏（新排）`
    const name = change.kind === 'newEntry' ? change.name : change.title || t`未命名条目`
    return `${KIND_TEXT[change.kind]} · ${name}`
  }

  /** Where a change goes: the tag beside its title. */
  function changeWhere(change) {
    if (change.kind === 'field') {
      if (inPrefix(change.key)) return [t`固定前缀`, 'on', t`写进对话开局时的固定前缀`]
      if (change.key === 'depthPrompt') return [t`每轮`, 'key', t`每轮随消息发送`]
      return [t`不发给模型`, 'off', '']
    }
    if (change.kind === 'greeting') return [t`新对话`, 'off', t`开新对话时选`]
    if (change.kind === 'chatState') return [t`这段对话`, 'key', t`写进读到的这段对话现在的变量，下一轮发给模型`]
    if (change.kind === 'statusBar') return [t`只改显示`, 'off', t`不发给模型；这张卡的对话都按新样式显示`]
    if (change.initvar) return [t`初始变量`, 'on', t`新对话从这些值开始；还没有变量的对话点「应用到当前对话」后补上，已经有变量的对话不会变`]
    return change.constant ? [t`常驻`, 'on', t`写进对话开局时的固定前缀`] : [t`关键词`, 'key', t`最近的对话提到关键词时随消息发送`]
  }

  function changeNotes(change) {
    const notes = []
    if (change.kind === 'chatState') notes.push(t`写进对话：${change.chat}`)
    if (change.kind === 'entry' && change.name) notes.push(t`名称：${change.title || t`未命名条目`} → ${change.name}`)
    if ((change.kind === 'newEntry' && !change.initvar) || change.keys) notes.push(t`关键词：${(change.keys ?? []).join(t`、`) || t`（无）`}`)
    if (change.kind === 'newEntry' && change.constant) notes.push(t`常驻：写进对话开局时的固定前缀`)
    return notes
  }

  /** A status bar change: how it will look, then its settings before and after. */
  function changeBody(change, { diffBox }) {
    if (change.kind !== 'statusBar') return null
    return [barPreview(change.spec, state.status?.state ?? {}, t`预览 · 初始值（采用后的样子）`), change.before === change.after ? null : diffBox(change.before ?? '', change.after ?? '')].filter(Boolean)
  }

  function targetLabel(id) {
    if (id === STATUS) return t`状态栏`
    const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
    if (kind === 'field') return FIELD_TEXT[rest]?.[0] ?? rest
    if (kind === 'greeting') return t`开场白 ${Number(rest) + 1}`
    return t`条目 ${rest}`
  }

  const talk = createTalk({ api, el, guard, openProviders }, {
    url: () => `/api/cards/${state.card.id}/assistant`,
    isOpen: () => dialog.open,
    intro: () => t`说说想怎么改：向导会把要改的地方整段写出来，改前改后对照着给你看，勾上的才会改进卡里。`,
    ideas: () => IDEAS,
    placeholder: target => (target?.id === STATUS ? t`状态栏想怎么改，比如：换成暗色的配色，好感度用进度条，分成两页` : target ? t`「${target.label}」想怎么改，比如：再短一点，语气冷一些` : t`说说想怎么改，比如：让她说话更冷淡一点`),
    busy: job => (job.chars ? t`正在改，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在读这张卡…`),
    changeTitle,
    changeWhere,
    changeNotes,
    changeBody,
    targetLabel,
    // A request waits for the fields still saving.
    beforeAsk: () => state.saving,
    references: {
      chats: async () => (await api('/api/chats')).filter(chat => chat.cardId === state.card.id),
      current: () => getChat()?.id ?? '',
    },
    async onApplied(result) {
      absorb(result.card)
      renderMain()
      saved(result.prefix, t`已改进卡里：${result.applied} 处`)
      toast(result.lost?.length ? t`已改进卡里：${result.applied} 处。这张卡的变量规则里没有 ${result.lost.join(t`、`)}，下一条回复后会被去掉` : t`已改进卡里：${result.applied} 处`, result.lost?.length ? 9000 : undefined)
      if (result.chat?.id === getChat()?.id) onChatChanged(result.chat)
      loadStatus()
      await onCardChanged?.(state.card.id)
    },
    undo: true,
    async onUndone(result) {
      absorb(result.card)
      renderMain()
      saved(result.prefix, t`已撤销这次修改`)
      toast(result.chatKept ? t`已撤销这次修改。写进对话的变量没有改回去，要改可以在右栏「状态」里改。` : t`已撤销这次修改`, result.chatKept ? 7000 : undefined)
      loadStatus()
      await onCardChanged?.(state.card.id)
    },
  })

  /** 按意见改: the next request is kept to this piece. */
  function aim(id, label) {
    talk.aim(id, label)
    showPane('assist')
  }

  // The entries window and 检查这张卡 change the card behind this one: read it again when they close.
  const readAgain = guard(async () => {
    if (!dialog.open || !state.card) return
    absorb(await api(`/api/cards/${state.card.id}/edit`))
    renderMain()
    loadStatus()
  })
  $('book-dialog')?.addEventListener('close', readAgain)
  $('card-check-dialog')?.addEventListener('close', readAgain)
  dialog.addEventListener('close', () => talk.stop())
  // Esc: the field being typed in saves as it loses focus.
  dialog.addEventListener('cancel', () => document.activeElement?.blur?.())

  return {
    /** @param options.say - words to put in 对话修改's box, which opens. */
    open: guard(async (cardId, { say = '' } = {}) => {
      if (!view.main) layout()
      const switching = state.card?.id !== cardId
      const [card, session] = await Promise.all([api(`/api/cards/${cardId}/edit`), api(`/api/cards/${cardId}/assistant`), talk.loadModels()])
      if (switching) {
        state.card = null
        state.stale = false
        state.told = false
        state.drawn = null
        state.kept = []
        state.withRegex = false
        state.status = null
        state.tuning = null
        talk.reset()
        view.main.scrollTop = 0
      }
      absorb(card)
      showPane(say ? 'assist' : state.pane)
      renderMain()
      showApply()
      loadKept(cardId)
      loadStatus(cardId)
      talk.load(session)
      if (!dialog.open) dialog.showModal()
      if (say) talk.say(say)
      // The talk opens at its latest turn (it has no size until the window shows).
      talk.scroll()
    }),
  }
}
