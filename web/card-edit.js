// 修改角色卡 (the card list's ⋯ → 修改角色卡): a saved card's fields edited in
// place, its picture, its own worldbook (the entries window, web/books.js), and
// 对话修改: say what to change, the model writes the pieces out again
// (server/forge/edit.mjs, a job run like a 创作角色卡 draft's), they show as
// before and after, and only the ticked ones go into the card.
//
// 生成头像 draws one for the card (server/media.mjs drawAvatar) with the 画图方式
// and model picked for it (web/draw-choice.js); it shows beside the buttons to
// take, draw again or drop, and only taking it changes the card.
//
// Each field saves when it loses focus. The card keeps its id, so its chats,
// cast, sprites, scenes and picture settings stay. A chat renders the card into
// its frozen prefix when it starts: an edit that reaches it leaves an open chat
// on the old text until applied (the bar the preset and entries windows show).
import { t } from '/i18n.js'
import { pngOf } from '/forge.js'
import { CARD_FIELDS } from '/shared/card-edit.js'
import { createTalk } from '/talk.js'

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
const IDEAS = [t`让她说话更冷淡一点`, t`加一个青梅竹马的 NPC 条目`, t`开场白短一点，结尾留个悬念`]

/**
 * @param deps - { api, el, toast, guard, saveFile, getChat, isGenerating, openProviders,
 *   openBook(cardId) (the entries window on the card's own book), onChatChanged(chatView),
 *   onCardChanged(cardId, { avatar }) (the list, the card's details and its picture follow),
 *   pickDraw(options) (web/draw-choice.js: the 画图方式 and model for one drawing) }
 */
export function initCardEdit({ api, el, toast, guard, saveFile, getChat, isGenerating, openProviders, openBook, onChatChanged, onCardChanged, pickDraw }) {
  const $ = id => document.getElementById(id)
  const dialog = $('card-edit-dialog')
  const state = {
    card: null, // GET /api/cards/:id/edit
    stale: false, // a saved edit reached the prefix; the open chat on this card has not applied it
    told: false, // the prefix toast was shown (no open chat on this card)
    pane: 'card', // on a phone: 'card' or 'assist'
    saving: Promise.resolve(),
    drawn: null, // 生成头像: { busy, picked } while drawing, then { image, backend, note, picked } to take or drop
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
    view.body = el('div', { class: 'ce-body' }, [view.main, view.assist])
    dialog.replaceChildren(
      el('div', { class: 'forge ce' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: t`修改角色卡` }), view.sub]),
          view.tabs,
          el('div', { class: 'forge-tools' }, [view.status, talk.model, close]),
        ]),
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
    state.card = { ...card, fromForge: card.fromForge ?? state.card?.fromForge ?? false }
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
        prefixBar(),
        hero(card),
        el('section', { class: 'plan-card' }, [
          el('header', {}, [el('h4', { text: t`角色定义` })]),
          el('p', { class: 'hint', text: t`标着「固定前缀」的几项在对话开局时写进固定前缀：新对话直接用改过的，进行中的对话要「应用到当前对话」才会用上。` }),
          ...['description', 'personality', 'scenario', 'mesExample'].map(key => fieldBlock(key)),
        ]),
        greetingsSection(card),
        bookSection(card),
        el('section', { class: 'plan-card' }, [
          el('header', {}, [el('h4', { text: t`给模型的指示` })]),
          ...['systemPrompt', 'postHistoryInstructions', 'depthPrompt'].map(key => fieldBlock(key, { rows: 3 })),
        ]),
        el('section', { class: 'plan-card' }, [el('header', {}, [el('h4', { text: t`给玩家看的` })]), fieldBlock('creatorNotes', { rows: 3 })]),
      ]),
    )
    view.main.scrollTop = top
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
          card.hasAvatar && !android ? el('a', { class: 'btn small ghost', href: `/api/cards/${card.id}/png?v=${Date.now()}`, download: `${card.name}.png`, title: t`图片里带着整张卡（包括这里的修改），SillyTavern 可以直接导入`, text: t`导出 PNG` }) : null,
          el('button', { type: 'button', class: 'btn small ghost', text: t`导出 JSON`, title: t`SillyTavern 的角色卡 JSON，包括这里的修改`, onclick: () => exportJson() }),
        ]),
        drawn?.image ? drawnBox(drawn) : null,
        el('p', { class: 'hint', text: t`改动直接存进这张卡，对话、角色名册、立绘、场景和配图设置都不变。` }),
        el('p', { class: 'hint', text: card.fromForge ? t`这张卡是「创作角色卡」做的：在那边再点「更新这张卡」，会换回草稿里的内容。` : t`从文件重新导入这张卡（选更新原来的卡）时，会换成文件里的版本，这里的修改不保留。` }),
      ]),
    ])
  }

  /** A drawn avatar waiting: take it, draw again (the same way or another), or drop it. */
  function drawnBox(drawn) {
    return el('div', { class: 'ce-drawn' }, [
      el('p', { text: [t`左边是新画的头像（${drawn.backend}），还没换上。`, drawn.note].filter(Boolean).join(' ') }),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'btn small primary', text: t`用这张`, onclick: () => takeDrawn() }),
        el('button', { type: 'button', class: 'btn small', text: t`再画一张`, onclick: () => drawAvatar(drawn.picked) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`换个画法…`, onclick: () => drawAvatar() }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`不要了`, onclick: () => { state.drawn = null; renderMain() } }),
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
    const addRow = el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`＋ 添加开场白`, onclick: () => addGreeting(areas, addRow) })])
    return el('section', { class: 'plan-card' }, [
      el('header', {}, [el('h4', { text: t`开场白 · ${card.greetings.filter(g => g.trim()).length} 条` })]),
      el('p', { class: 'hint', text: t`开新对话时选一条。改了不影响已经开始的对话。` }),
      ...blocks,
      addRow,
    ])
  }

  /** A box for one more opening, kept once it has text (a blank one is dropped on save). */
  function addGreeting(areas, addRow) {
    if (addRow.previousElementSibling?.classList.contains('ce-new-greeting')) return addRow.previousElementSibling.querySelector('textarea').focus()
    const area = el('textarea', { class: 'ce-text', rows: '5', spellcheck: 'false', placeholder: t`新的开场白`, 'aria-label': t`开场白 ${areas.length + 1}` })
    area.addEventListener('change', () => save({ greetings: [...areas.map(a => a.value), area.value] }, { redraw: true }))
    addRow.before(el('div', { class: 'ce-field ce-new-greeting' }, [el('div', { class: 'ce-field-head' }, [el('b', { text: t`开场白 ${areas.length + 1}（新）` })]), area]))
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
      card.worldbookIds.length ? el('p', { class: 'hint', text: t`另外挂了 ${card.worldbookIds.length} 本独立世界书，在「设置 → 挂载的世界书」里管理。` }) : null,
      el('p', { class: 'hint', text: t`人物、地点和设定的条目也可以在「对话修改」里让向导加，比如：加一个青梅竹马的 NPC 条目。` }),
    ])
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
      const bar = view.main.querySelector('.ce-apply')
      if (bar) bar.replaceWith(prefixBar())
      else view.main.querySelector('.ce-card')?.prepend(prefixBar())
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
    view.main.querySelector('.ce-apply')?.remove()
    toast(t`已重建固定前缀，下一轮生效`)
  }

  /** A picture the page can load as the card's avatar: made PNG, the card written into it on the server. */
  async function setAvatar(url) {
    const image = await pngOf(url)
    absorb(await queue(() => api(`/api/cards/${state.card.id}/avatar`, { method: 'PUT', body: { image } })))
    state.avatarAt = Date.now()
    renderMain()
    saved(false, t`头像已换`)
    await onCardChanged?.(state.card.id, { avatar: true })
  }

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
    renderMain()
    try {
      const result = await api(`/api/cards/${id}/avatar/draw`, { method: 'POST', body: picked.body })
      if (state.card?.id === id) state.drawn = { ...result, picked }
    } catch (error) {
      if (state.card?.id === id) state.drawn = before?.image ? before : null
      throw error
    } finally {
      if (state.card?.id === id) renderMain()
    }
  })

  const takeDrawn = guard(async () => {
    if (!state.drawn?.image) return
    await setAvatar(state.drawn.image)
    state.drawn = null
    renderMain()
  })

  const exportJson = guard(async () => {
    await state.saving
    const json = await api(`/api/cards/${state.card.id}/sillytavern`)
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
  const KIND_TEXT = { field: '', greeting: '', entry: t`世界书`, newEntry: t`新条目`, removeEntry: t`删除条目` }

  function changeTitle(change) {
    if (change.kind === 'field') return FIELD_TEXT[change.key]?.[0] ?? change.key
    if (change.kind === 'greeting') return change.index < state.card.greetings.length || change.before ? t`开场白 ${change.index + 1}` : t`开场白 ${change.index + 1}（新加）`
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
    return change.constant ? [t`常驻`, 'on', t`写进对话开局时的固定前缀`] : [t`关键词`, 'key', t`最近的对话提到关键词时随消息发送`]
  }

  function changeNotes(change) {
    const notes = []
    if (change.kind === 'entry' && change.name) notes.push(t`名称：${change.title || t`未命名条目`} → ${change.name}`)
    if (change.kind === 'newEntry' || change.keys) notes.push(t`关键词：${(change.keys ?? []).join(t`、`) || t`（无）`}`)
    if (change.kind === 'newEntry' && change.constant) notes.push(t`常驻：写进对话开局时的固定前缀`)
    return notes
  }

  function targetLabel(id) {
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
    placeholder: target => (target ? t`「${target.label}」想怎么改，比如：再短一点，语气冷一些` : t`说说想怎么改，比如：让她说话更冷淡一点`),
    busy: job => (job.chars ? t`正在改，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在读这张卡…`),
    changeTitle,
    changeWhere,
    changeNotes,
    targetLabel,
    // A request waits for the fields still saving.
    beforeAsk: () => state.saving,
    async onApplied(result) {
      absorb(result.card)
      renderMain()
      saved(result.prefix, t`已改进卡里：${result.applied} 处`)
      toast(t`已改进卡里：${result.applied} 处`)
      await onCardChanged?.(state.card.id)
    },
  })

  /** 按意见改: the next request is kept to this piece. */
  function aim(id, label) {
    talk.aim(id, label)
    showPane('assist')
  }

  // The entries window edits the card's book: count again when it closes.
  $('book-dialog')?.addEventListener('close', guard(async () => {
    if (!dialog.open || !state.card) return
    absorb(await api(`/api/cards/${state.card.id}/edit`))
    renderMain()
  }))
  dialog.addEventListener('close', () => talk.stop())
  // Esc: the field being typed in saves as it loses focus.
  dialog.addEventListener('cancel', () => document.activeElement?.blur?.())

  return {
    open: guard(async cardId => {
      if (!view.main) layout()
      const switching = state.card?.id !== cardId
      const [card, session] = await Promise.all([api(`/api/cards/${cardId}/edit`), api(`/api/cards/${cardId}/assistant`), talk.loadModels()])
      if (switching) {
        state.card = null
        state.stale = false
        state.told = false
        state.drawn = null
        talk.reset()
        view.main.scrollTop = 0
      }
      absorb(card)
      showPane(state.pane)
      renderMain()
      talk.load(session)
      if (!dialog.open) dialog.showModal()
      // The talk opens at its latest turn (it has no size until the window shows).
      talk.scroll()
    }),
  }
}
