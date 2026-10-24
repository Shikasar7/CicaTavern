// 世界书 (the card list's 世界书; 设置 → 世界书与状态 → 挂载的世界书 → 查看条目):
// every imported book as a whole — its name, a note, how far back its keywords
// are looked for, the cards that use it, an export for SillyTavern, a copy —
// and the entries of a book (from the settings, a card's own one too), each with
// its switch and an editor in the preset window's layout, or many at once. A
// chat renders its constant entries into the frozen prefix when it starts, so an
// edit that reaches them leaves the open chat on the old text until the prefix
// is applied again (the bar the preset window shows too); keyword entries and
// templated ones are read every turn.
import { t } from '/i18n.js'

// SillyTavern positions; 2–4 all go to the end of the context here (server/worldbook.mjs isLate).
const POSITIONS = [[0, t`角色定义前`], [1, t`角色定义后`], [4, t`上下文末尾`]]

/** { entries, enabled, constant } as the settings count a book. */
export function countEntries(entries) {
  const enabled = entries.filter(e => e.enabled !== false)
  return { entries: entries.length, enabled: enabled.length, constant: enabled.filter(e => e.constant).length }
}

/** "27 条（启用 26，其中常驻 19）" */
export function countText({ entries, enabled, constant }) {
  return t`${entries} 条（启用 ${enabled}，其中常驻 ${constant}）`
}

/** A search box's words, lower-cased: a match has every one of them (the card list, the books, a book's entries). */
export const searchTerms = query => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
export const matchesTerms = (text, terms) => {
  const hay = String(text ?? '').toLowerCase()
  return terms.every(term => hay.includes(term))
}

/** A search box above a list, with the magnifier the history panel has. */
export function searchBox(el, { placeholder, label, onInput }) {
  const input = el('input', { type: 'search', placeholder, 'aria-label': label, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' })
  input.addEventListener('input', () => onInput(input.value))
  const box = el('label', { class: 'list-search' }, [
    el('span', { class: 'list-search-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.3 3.3" /></svg>' }),
    input,
  ])
  return { box, input }
}

const titleOf = e => e.comment || e.content.replace(/\s+/g, ' ').trim().slice(0, 24) || t`未命名条目`
// What a book's entry search looks through.
const entryText = e => `${e.comment ?? ''}\n${e.keys?.join('\n') ?? ''}\n${e.content ?? ''}`
const splitKeys = text => text.split(/[,，]/).map(key => key.trim()).filter(Boolean)
// Entries a chat freezes into its prefix (server/worldbook.mjs inPrefix).
const inPrefix = e => e.enabled && e.constant && !e.initvar && !e.dynamic

/** The tag beside an entry's name: what makes it reach the model. */
function kindOf(e) {
  if (e.initvar) return [t`初始变量`, 'off', t`不发给模型：开新对话时读出来当初始状态`]
  if (e.constant) return [t`常驻`, 'on', e.dynamic ? t`每轮按当前状态渲染后随消息发送` : t`写进对话开局时的固定前缀`]
  return [t`关键词`, 'key', t`最近的对话提到关键词时随消息发送`]
}

/** What changing an entry does, under its fields. */
function noteOf(e) {
  if (e.initvar) return t`初始变量（MVU）：不发给模型，开新对话时读出来当初始状态。改了对之后新开的对话生效。`
  if (e.constant && e.dynamic) return t`常驻，含模板或变量宏：每轮按当前状态渲染后随消息发送，改了下一轮就生效。`
  if (e.constant) return t`常驻：写进对话开局时的固定前缀，关键词不起作用。改了之后，进行中的对话要「应用到当前对话」才会用上。`
  return t`关键词：最近的对话里提到任意一个时，这一轮随消息发送，改了下一轮就生效。顺序小的排在前面。`
}

/**
 * @param deps - { api, el, toast, guard, saveFile, getChat, getCards, getScanDepth, isGenerating, onChatChanged(chatView), onChanged({ mounts }) }
 *   onChanged runs after every save, so the settings page and the card list
 *   count again; `mounts` names the books whose cards changed here.
 */
/**
 * @param deps - { …, openTalk(options) (talk-dialog.js: 对话修改 on the book shown) }
 */
export function initBooks({ api, el, toast, guard, saveFile, getChat, getCards, getScanDepth, isGenerating, onChatChanged, onChanged, openTalk }) {
  const $ = id => document.getElementById(id)
  const dialog = $('book-dialog')
  const state = {
    card: null, // the card the settings page is for; null from the card list's 世界书
    books: [], // nav: [{ id, name, own, counts }]; a card's own book is card-<card id>, as chats know it
    mounted: new Set(), // imported books ticked for the card in the settings page
    selected: null,
    detail: null, // { id, name, description, scanDepth, complete, entries }
    query: '',
    open: new Set(), // expanded entry uids
    panels: new Set(), // open sections above the entries: 'settings', 'cards'
    picking: false, // 多选
    picked: new Set(), // entry uids ticked in 多选
    target: null, // the book picked to copy or move them to ('' a new one), kept while ticking more
    stale: new Set(), // book ids edited in the prefix since the open chat applied them
    remounted: new Set(), // of those, books the open chat's card took on or let go of here
    find: '', // the search above the books: names, notes, and every book's entries
    everything: new Map(), // book id → its entries, read once for that search; dropped when the books change
    reading: null, // while they are read
  }
  const urlOf = id => (id.startsWith('card-') ? `/api/cards/${id.slice(5)}/book` : `/api/worldbooks/${id}`)
  const navOf = id => state.books.find(b => b.id === id)
  const usedBy = id => getCards().filter(c => (c.worldbookIds ?? []).includes(id))

  /** Whether the open chat has this book in its prefix: its card's own, or one its card has mounted. */
  function chatUses(chat, id) {
    if (!chat) return false
    if (id === `card-${chat.cardId}` || navOf(id)?.global) return true
    return (getCards().find(c => c.id === chat.cardId)?.worldbookIds ?? []).includes(id)
  }
  // The open chat's prefix is behind this book: edited, or taken on or let go of by its card.
  const staleInChat = id => state.stale.has(id) && (chatUses(getChat(), id) || (Boolean(getChat()) && state.remounted.has(id)))

  /** The nav from the imported books (GET /api/worldbooks); the card's own book keeps its place and counts. */
  function setBooks(list) {
    const card = state.card
    const own = state.books.find(b => b.own)
    state.books = [
      ...(card && (card.bookEntries || own) ? [own ?? { id: `card-${card.id}`, name: t`卡里自带`, own: true, counts: { entries: card.bookEntries, enabled: card.bookEnabled, constant: card.bookConstant } }] : []),
      ...list.map(b => ({ id: b.id, name: b.name, description: b.description ?? '', own: false, global: Boolean(b.global), counts: { entries: b.entries, enabled: b.enabled, constant: b.constant } })),
    ]
  }

  // Searching the books: a name or note matches at once; entries match once every book has been read.
  const finder = searchBox(el, {
    placeholder: t`搜索书名、备注或条目`,
    label: t`搜索世界书`,
    onInput: value => {
      state.find = value
      renderNav()
      if (searchTerms(value).length) guard(readEverything)()
    },
  })
  $('book-list').before(finder.box)

  /** Every book's entries, for the search: the shown book's as they are now, the others read once. */
  async function readEverything() {
    const missing = state.books.filter(b => !state.everything.has(b.id) && b.id !== state.detail?.id)
    if (!missing.length || state.reading) return
    state.reading = Promise.all(missing.map(b => api(urlOf(b.id)).then(book => state.everything.set(b.id, book.entries))))
    try {
      await state.reading
    } finally {
      state.reading = null
      renderNav()
    }
  }

  /** How many of a book's entries the search finds; null while they are being read. */
  function hitsIn(b, terms) {
    const entries = b.id === state.detail?.id ? state.detail.entries : state.everything.get(b.id)
    return entries ? entries.filter(e => matchesTerms(entryText(e), terms)).length : null
  }

  /**
   * @param card - the card the settings page is for; none from the card list.
   * @param books - imported books (GET /api/worldbooks); fetched when not given.
   * @param mounted - ids of the books ticked for the card.
   * @param select - the book to show: card-<id> or an imported one's id.
   */
  async function open({ card = null, books, mounted = [], select: wanted } = {}) {
    state.card = card
    state.mounted = new Set(mounted)
    state.books = []
    state.find = ''
    finder.input.value = ''
    state.everything.clear()
    setBooks(books ?? await api('/api/worldbooks'))
    await select(navOf(wanted) ? wanted : state.books[0]?.id ?? null)
    if (!dialog.open) dialog.showModal()
    // On a phone, straight to the book that was picked (style.css .show-main).
    dialog.querySelector('.preset-layout').classList.toggle('show-main', Boolean(wanted && navOf(wanted)))
  }

  /** @param query - the entry search to open the book with (from the search above the books). */
  async function select(id, query = '') {
    // The book left keeps its entries as edited here, for the search across books.
    if (state.detail) state.everything.set(state.detail.id, state.detail.entries)
    state.selected = id
    state.query = query
    state.open.clear()
    state.picking = false
    state.picked.clear()
    state.detail = id ? await api(urlOf(id)) : null
    renderNav()
    renderMain()
  }

  async function refreshBooks() {
    setBooks(await api('/api/worldbooks'))
    // Entries may have gone to another book: read them again when searched.
    state.everything.clear()
    renderNav()
    if (searchTerms(state.find).length) await readEverything()
  }

  function renderNav() {
    const terms = searchTerms(state.find)
    const rows = []
    for (const b of state.books) {
      const hits = terms.length ? hitsIn(b, terms) : 0
      if (terms.length && !hits && !matchesTerms(`${b.name}\n${b.description ?? ''}`, terms)) continue
      const users = b.own ? 0 : usedBy(b.id).length
      const tag = b.own ? t`始终生效` : b.global ? t`全局` : state.card ? (state.mounted.has(b.id) ? t`已挂载` : '') : users ? t`${users} 张卡在用` : ''
      // Opened from the search, a book shows the entries it found.
      rows.push(el('li', { class: state.selected === b.id ? 'active' : '', onclick: () => guard(select)(b.id, hits ? state.find.trim() : '') }, [
        el('div', { class: 'item-title' }, [el('span', { class: 'item-main', text: b.name }), tag ? el('span', { class: 'tag', text: tag }) : null]),
        el('div', { class: 'item-sub' }, [hits ? el('span', { class: 'book-hits', text: t`${hits} 条匹配` }) : null, hits ? ' · ' : null, countText(b.counts)]),
      ]))
    }
    if (terms.length && !rows.length) rows.push(el('li', { class: 'list-none', text: state.reading ? t`正在搜索…` : t`没有找到「${state.find.trim()}」` }))
    else if (terms.length && state.reading) rows.push(el('li', { class: 'list-none', text: t`正在搜索条目…` }))
    $('book-list').replaceChildren(...rows)
  }

  // ─── Main column ──────────────────────────────────────────────────────
  /** Title, what the book is to the card (or to the cards), its actions, and the apply bar. */
  function headParts() {
    const detail = state.detail
    const own = navOf(detail.id)?.own
    const card = state.card
    const users = own ? [] : usedBy(detail.id)
    const where = own
      ? t`「${card.name}」卡里自带，这张卡的每个对话都用。重新导入这张卡来更新时，会换成文件里的版本，这里的修改不保留。`
      : navOf(detail.id)?.global
        ? t`全局世界书：每张卡的对话都用，不用挂到卡上。`
        : card
        ? state.mounted.has(detail.id)
          ? t`挂在「${card.name}」上。挂着这本的每张卡都会用到这里的修改。`
          : t`没挂在「${card.name}」上：在下面「用到它的卡」里勾上，才对这张卡生效。`
        : users.length
          ? t`${users.length} 张卡在用，它们的对话都会用到这里的修改。`
          : t`还没有卡用它：在下面「用到它的卡」里勾上才生效。`
    return [
      el('header', { class: 'preset-head' }, [
        el('h3', { class: 'preset-title', text: own ? t`卡里自带的世界书` : detail.name }),
        el('div', { class: 'preset-meta', text: [countText(countEntries(detail.entries)), where].join(t`。`) }),
        el('div', { class: 'preset-actions' }, own ? [talkButton()] : [
          talkButton(),
          el('button', { class: 'btn small', type: 'button', text: t`导出`, title: t`存成 SillyTavern 的世界书 JSON：可以在 SillyTavern 里导入，也可以搬到另一台设备`, onclick: guard(exportBook) }),
          el('button', { class: 'btn small', type: 'button', text: t`复制一份`, title: t`复制出一本一样的，改它不影响原来这本；新的一本先不挂到卡上`, onclick: guard(copyBook) }),
          el('button', { class: 'btn small danger', type: 'button', text: t`删除`, onclick: guard(removeBook) }),
        ]),
      ]),
      staleInChat(detail.id) ? el('div', { class: 'preset-apply' }, [
        el('span', { text: t`当前对话的固定前缀还是改动前的版本。应用后，下一轮会重新写入一次缓存。` }),
        el('button', { class: 'btn small primary', type: 'button', disabled: isGenerating(), text: t`应用到当前对话`, onclick: guard(applyToChat) }),
      ]) : null,
    ]
  }

  function renderHead() {
    $('book-headwrap')?.replaceChildren(...headParts().filter(Boolean))
  }

  function renderMain() {
    const detail = state.detail
    if (!detail) {
      $('book-main').replaceChildren(el('div', { class: 'preset-empty' }, [
        el('p', { text: t`还没有导入的世界书。` }),
        el('p', { class: 'small', text: t`点左上角「导入」选 SillyTavern 的世界书 JSON（也可以直接拖进窗口），或者「新建」一本空的。` }),
      ]))
      return
    }
    const own = navOf(detail.id)?.own
    const search = el('input', { type: 'search', placeholder: t`搜索条目名称、关键词或内容`, value: state.query })
    search.addEventListener('input', () => { state.query = search.value.trim(); filterRows() })
    $('book-main').replaceChildren(...[
      el('div', { id: 'book-headwrap' }, headParts().filter(Boolean)),
      own ? null : el('div', { class: 'book-panels' }, [settingsPanel(), cardsPanel()]),
      el('div', { class: 'preset-tools' }, [
        search,
        detail.entries.length ? el('button', { type: 'button', class: `btn small${state.picking ? ' primary' : ''}`, text: state.picking ? t`完成` : t`多选`, title: t`勾选几条，一起启用、停用、复制、移动或删除`, onclick: togglePicking }) : null,
        el('button', { type: 'button', class: 'btn small', text: t`＋ 新增条目`, onclick: guard(addEntry) }),
      ]),
      state.picking ? bulkBar() : null,
      detail.entries.length
        ? el('ul', { class: `prompt-list book-entries${state.picking ? ' picking' : ''}`, id: 'book-entries' }, detail.entries.map(entryRow))
        : el('div', { class: 'preset-empty' }, [
            el('p', { text: t`这本世界书还没有条目。` }),
            el('p', { class: 'small', text: t`可以一条条新增，也可以说说这本书写什么，让向导写出来。` }),
            el('button', { type: 'button', class: 'btn small primary', text: t`用对话来写`, onclick: () => talkAbout() }),
          ]),
    ].filter(Boolean))
    filterRows()
  }

  /** A section above the entries that stays open or closed as the player left it. */
  function panel(key, summary, body) {
    const box = el('details', { class: 'book-panel', 'data-panel': key }, [el('summary', {}, summary), el('div', { class: 'book-panel-body' }, body)])
    box.open = state.panels.has(key)
    box.addEventListener('toggle', () => (box.open ? state.panels.add(key) : state.panels.delete(key)))
    return box
  }

  /** What 书的设置 says when closed. */
  function settingsSummary() {
    const d = state.detail
    return [
      navOf(d.id)?.global ? t`全局` : '',
      d.scanDepth ? t`扫描最近 ${d.scanDepth} 条` : t`扫描深度跟随设置（${getScanDepth()} 条）`,
      d.description.trim() ? t`有备注` : '',
    ].filter(Boolean).join(' · ')
  }

  /** Name, note, scan depth, and the keyword matching of every entry at once. */
  function settingsPanel() {
    const d = state.detail
    const name = el('input', { value: d.name, maxlength: '100', 'aria-label': t`名称` })
    name.addEventListener('change', guard(async () => {
      if (!name.value.trim()) {
        name.value = d.name
        throw new Error(t`名字不能空着`)
      }
      if (name.value.trim() !== d.name) await saveInfo({ name: name.value }, t`已改名`)
      name.value = d.name
    }))
    const depth = el('input', { type: 'number', min: '1', max: '100', step: '1', value: d.scanDepth ?? '', placeholder: t`跟随设置（${getScanDepth()}）`, 'aria-label': t`扫描深度` })
    depth.addEventListener('change', guard(async () => {
      await saveInfo({ scanDepth: depth.value === '' ? null : Number(depth.value) }, t`已保存，下一轮生效`)
      depth.value = d.scanDepth ?? ''
    }))
    const note = el('textarea', { rows: '3', maxlength: '4000', placeholder: t`只给自己看，不发给模型`, 'aria-label': t`备注` })
    note.value = d.description
    note.addEventListener('change', guard(async () => {
      if (note.value !== d.description) await saveInfo({ description: note.value }, t`已保存`)
    }))
    const global = el('input', { type: 'checkbox', class: 'switch', checked: Boolean(navOf(d.id)?.global) })
    global.addEventListener('change', guard(async () => {
      try {
        await saveGlobal(global.checked)
      } catch (error) {
        global.checked = !global.checked
        throw error
      }
    }))
    return panel('settings', [el('span', { text: t`书的设置` }), el('span', { class: 'book-panel-sub', id: 'book-settings-sub', text: settingsSummary() })], [
      el('label', { class: 'check-row book-check book-global' }, [global, el('span', { text: t`全局：所有对话都用` })]),
      el('p', { class: 'prompt-note', text: t`打开后，每张卡的对话都用这本，不用一张张挂；和挂在卡上的同时开着也只算一次。常驻条目写在对话开局时的固定前缀里，进行中的对话要「应用到当前对话」才会用上。` }),
      el('div', { class: 'prompt-fields book-fields' }, [
        field(t`名称`, name),
        field(t`扫描深度`, depth),
      ]),
      el('p', { class: 'prompt-note', text: t`扫描深度：在最近几条消息里找这本书的关键词，空着跟随「设置 → 扫描与状态」。只影响这本的关键词条目，下一轮就生效。` }),
      field(t`备注`, note, 'wide'),
      el('div', { class: 'book-match' }, [
        el('span', { class: 'book-match-label', text: t`整本的关键词` }),
        matchAll('caseSensitive', t`区分大小写`),
        matchAll('wholeWords', t`整词匹配`),
      ]),
      el('p', { class: 'prompt-note', text: t`勾上或取消，就套用到这本的每个条目；单个条目在它的编辑里改。整词匹配只对英文这类用空格分词的关键词起作用。` }),
    ])
  }

  /** A box for one matching rule over the whole book: ticked when all have it, half when some do. */
  function matchAll(key, label) {
    const entries = state.detail.entries
    const on = entries.filter(e => e[key]).length
    const box = el('input', { type: 'checkbox', checked: entries.length > 0 && on === entries.length, disabled: !entries.length })
    box.indeterminate = on > 0 && on < entries.length
    box.addEventListener('change', guard(async () => {
      const value = box.checked
      await save({ entries: entries.map(e => ({ uid: e.uid, [key]: value })) }, { quiet: true })
      toast(value ? t`这本的 ${entries.length} 个条目都开了「${label}」` : t`这本的 ${entries.length} 个条目都关了「${label}」`)
      redraw()
    }))
    return el('label', { class: 'check-row book-check' }, [box, el('span', { text: label }), el('span', { class: 'book-panel-sub', text: `${on}/${entries.length}` })])
  }

  /** Every card, ticked when it uses this book; a tick saves at once. */
  function cardsPanel() {
    const id = state.detail.id
    const cards = getCards()
    const using = new Set(usedBy(id).map(c => c.id))
    const list = el('div', { class: 'book-cards' }, cards.map(c => {
      const box = el('input', { type: 'checkbox', value: c.id, checked: using.has(c.id) })
      box.addEventListener('change', guard(async () => {
        try {
          await saveCards(list, c, box.checked)
        } catch (error) {
          box.checked = !box.checked
          throw error
        }
      }))
      return el('label', { class: 'check-row book-check' }, [
        box,
        el('span', { class: 'book-card-name', text: c.name }),
        c.group ? el('span', { class: 'book-panel-sub', text: c.group }) : null,
        c.archived ? el('span', { class: 'book-panel-sub', text: t`已归档` }) : null,
      ])
    }))
    const global = navOf(id)?.global
    return panel('cards', [el('span', { text: t`用到它的卡` }), el('span', { class: 'book-panel-sub', text: global ? t`全局：每张卡都用` : using.size ? t`${using.size} 张` : t`还没有` })], [
      global ? el('p', { class: 'book-global-note', text: t`这本是全局的，每张卡的对话都用，不用在这里勾。这里勾上的卡在取消全局后照旧挂着。` }) : null,
      cards.length ? list : el('p', { class: 'prompt-note', text: t`还没有角色卡。` }),
      el('p', { class: 'prompt-note', text: t`勾上的卡，它的每个对话都用这本：关键词条目下一轮就生效；常驻条目写在对话开局时的固定前缀里，进行中的对话要「应用到当前对话」或重建前缀。` }),
    ])
  }

  /** 全局 on or off: every chat takes the book on or lets it go, the open one's prefix included. */
  async function saveGlobal(on) {
    const id = state.detail.id
    const { prefix } = await api(`/api/worldbooks/${id}/global`, { method: 'PUT', body: { global: on } })
    const nav = navOf(id)
    if (nav) nav.global = on
    if (prefix && getChat()) {
      state.stale.add(id)
      state.remounted.add(id)
    }
    await onChanged?.({ globals: true })
    renderNav()
    redraw()
    toast(on ? t`已设为全局：每张卡的对话都用这本` : t`不再是全局：只有挂着它的卡用`)
  }

  async function saveCards(list, card, ticked) {
    const id = state.detail.id
    const ids = [...list.querySelectorAll('input:checked')].map(box => box.value)
    const { changed } = await api(`/api/worldbooks/${id}/cards`, { method: 'PUT', body: { ids } })
    // The settings page's tick for its card follows.
    if (state.card?.id === card.id && changed.includes(card.id)) {
      if (ticked) state.mounted.add(id)
      else state.mounted.delete(id)
    }
    // The open chat's card took it on or let it go: its prefix is behind if the book has constant entries.
    const chat = getChat()
    if (chat && changed.includes(chat.cardId) && state.detail.entries.some(inPrefix)) {
      state.stale.add(id)
      state.remounted.add(id)
    }
    await onChanged?.({ mounts: [id] })
    renderNav()
    redraw()
    toast(ticked ? t`「${card.name}」挂上了这本` : t`「${card.name}」不再挂这本`)
  }

  /** The bar over the entries in 多选. */
  function bulkBar() {
    const d = state.detail
    const n = state.picked.size
    const others = state.books.filter(b => !b.own && b.id !== d.id)
    const target = el('select', { 'aria-label': t`复制或移动到` }, [
      ...others.map(b => el('option', { value: b.id, text: b.name, selected: b.id === state.target })),
      el('option', { value: '', text: t`新建一本…`, selected: state.target === '' }),
    ])
    target.addEventListener('change', () => (state.target = target.value))
    const none = !n
    return el('div', { class: 'book-bulk', id: 'book-bulk' }, [
      el('span', { class: 'book-bulk-count', text: t`已选 ${n} 条` }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`全选`, title: t`选中搜索出来的全部条目`, onclick: pickAll }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`全不选`, disabled: none, onclick: () => { state.picked.clear(); redraw() } }),
      el('span', { class: 'book-bulk-gap' }),
      el('button', { type: 'button', class: 'btn small', text: t`启用`, disabled: none, onclick: guard(() => switchPicked(true)) }),
      el('button', { type: 'button', class: 'btn small', text: t`停用`, disabled: none, onclick: guard(() => switchPicked(false)) }),
      el('span', { class: 'book-bulk-to' }, [
        target,
        el('button', { type: 'button', class: 'btn small', text: t`复制`, disabled: none, onclick: guard(() => transfer(target.value, false)) }),
        el('button', { type: 'button', class: 'btn small', text: t`移动`, disabled: none, onclick: guard(() => transfer(target.value, true)) }),
      ]),
      el('button', { type: 'button', class: 'btn small danger', text: t`删除`, disabled: none, onclick: guard(removePicked) }),
    ])
  }

  function togglePicking() {
    state.picking = !state.picking
    state.picked.clear()
    redraw()
  }

  function pickAll() {
    for (const row of document.querySelectorAll('#book-entries .prow')) if (!row.hidden) state.picked.add(row.dataset.uid)
    redraw()
  }

  function entryRow(e) {
    const more = el('div', { class: 'prow-more' }, el('div'))
    const row = el('li', { class: `prow${e.enabled ? '' : ' off'}${state.open.has(e.uid) ? ' open' : ''}${state.picked.has(e.uid) ? ' picked' : ''}`, 'data-uid': e.uid }, [line(), more])
    if (state.open.has(e.uid)) fillEditor(more, e, row)

    /** Switch, name, keys, tag and size: built again after each save. */
    function line() {
      const pick = el('input', { type: 'checkbox', class: 'book-pick', checked: state.picked.has(e.uid), 'aria-label': t`选中「${titleOf(e)}」` })
      pick.addEventListener('change', () => setPicked(pick.checked))
      const toggle = el('input', { type: 'checkbox', class: 'switch', checked: e.enabled, 'aria-label': t`启用「${titleOf(e)}」` })
      toggle.addEventListener('change', guard(async () => {
        const enabled = toggle.checked
        row.classList.toggle('off', !enabled)
        try {
          await save({ entries: [{ uid: e.uid, enabled }] }, { quiet: true })
        } catch (error) {
          toggle.checked = !enabled
          row.classList.toggle('off', enabled)
          throw error
        }
      }))
      const [label, cls, tip] = kindOf(e)
      const opened = state.open.has(e.uid)
      const name = el('button', { type: 'button', class: 'prow-name', text: titleOf(e), title: state.picking ? t`选中或取消` : t`展开编辑`, 'aria-expanded': String(opened), onclick: expand })
      // In 多选 the whole line ticks the entry, apart from its own controls.
      const tick = event => {
        if (state.picking && !event.target.closest('input, button')) setPicked(!state.picked.has(e.uid))
      }
      return el('div', { class: 'prow-line', onclick: tick }, [
        pick,
        toggle,
        name,
        e.keys.length ? el('span', { class: 'book-keys', title: e.keys.join(', '), text: e.keys.join(t`、`) }) : null,
        el('span', { class: `strategy ${cls}`, title: tip, text: label }),
        el('span', { class: 'prow-size', text: t`${e.content.length.toLocaleString()} 字` }),
        el('button', { type: 'button', class: 'prow-edit', title: t`编辑名称、关键词、位置和内容`, 'aria-label': t`编辑「${titleOf(e)}」`, text: '✎', onclick: () => expand(true) }),
      ])
    }
    /** In 多选 a click on the name ticks the entry; the pen still opens it. */
    function expand(edit = false) {
      if (state.picking && edit !== true) {
        setPicked(!state.picked.has(e.uid))
        return
      }
      const opening = !row.classList.contains('open')
      if (opening) {
        fillEditor(more, e, row)
        state.open.add(e.uid)
        // Next frame, so the grid-row transition runs from 0fr.
        requestAnimationFrame(() => row.classList.add('open'))
      } else {
        state.open.delete(e.uid)
        row.classList.remove('open')
      }
      row.querySelector('.prow-name')?.setAttribute('aria-expanded', String(opening))
    }
    function setPicked(on) {
      if (on) state.picked.add(e.uid)
      else state.picked.delete(e.uid)
      row.classList.toggle('picked', on)
      const box = row.querySelector('.book-pick')
      if (box) box.checked = on
      $('book-bulk')?.replaceWith(bulkBar())
    }
    row.refresh = () => {
      row.querySelector('.prow-line').replaceWith(line())
      row.classList.toggle('off', !e.enabled)
      const note = row.querySelector('.prompt-note')
      if (note) note.textContent = noteOf(e)
    }
    return row
  }

  /** Name, trigger, position, order, keys, matching and the text; each saves when it changes. */
  function fillEditor(more, e, row) {
    const holder = more.firstChild
    if (holder.firstChild) return
    const name = el('input', { value: e.comment, maxlength: '200', placeholder: t`没有名称`, 'aria-label': t`名称` })
    const kind = el('select', { 'aria-label': t`触发方式` }, [
      el('option', { value: 'constant', text: t`常驻`, selected: e.constant }),
      el('option', { value: 'keyword', text: t`关键词`, selected: !e.constant }),
    ])
    const known = POSITIONS.some(([value]) => value === e.position)
    const position = el('select', { 'aria-label': t`位置` }, [
      ...POSITIONS.map(([value, text]) => el('option', { value: String(value), text, selected: value === e.position })),
      // Positions this app treats like one of the above keep their SillyTavern number until changed.
      known ? null : el('option', { value: String(e.position), text: t`保持原样（SillyTavern 位置 ${e.position}）`, selected: true }),
    ])
    const order = el('input', { type: 'number', step: '1', value: String(e.order), 'aria-label': t`顺序` })
    const keys = el('input', { value: e.keys.join(', '), placeholder: t`用逗号分开，例如：雪, 小雪`, spellcheck: 'false', 'aria-label': t`关键词` })
    const secondary = e.secondaryKeys?.length ? el('input', { value: e.secondaryKeys.join(', '), spellcheck: 'false', 'aria-label': t`次要关键词` }) : null
    const area = el('textarea', { spellcheck: 'false', 'aria-label': t`内容` })
    area.value = e.content

    const edit = (control, change, after) => control.addEventListener('change', guard(async () => {
      await save({ entries: [{ uid: e.uid, ...change() }] })
      row.refresh()
      after?.()
    }))
    name.addEventListener('change', guard(async () => {
      if (name.value.trim() === e.comment) return
      await save({ entries: [{ uid: e.uid, comment: name.value }] })
      row.refresh()
    }))
    edit(kind, () => ({ constant: kind.value === 'constant' }))
    edit(position, () => ({ position: Number(position.value) }))
    edit(order, () => ({ order: Number(order.value) }))
    // Keys come back cleaned, written the way the field shows them.
    edit(keys, () => ({ keys: splitKeys(keys.value) }), () => (keys.value = e.keys.join(', ')))
    if (secondary) edit(secondary, () => ({ secondaryKeys: splitKeys(secondary.value) }), () => (secondary.value = e.secondaryKeys.join(', ')))
    area.addEventListener('change', guard(async () => {
      if (area.value === e.content) return
      await save({ entries: [{ uid: e.uid, content: area.value }] })
      row.refresh()
    }))
    const match = (key, label, tip) => {
      const box = el('input', { type: 'checkbox', checked: e[key] })
      box.addEventListener('change', guard(async () => {
        try {
          await save({ entries: [{ uid: e.uid, [key]: box.checked }] })
        } catch (error) {
          box.checked = !box.checked
          throw error
        }
      }))
      return el('label', { class: 'check-row book-check', title: tip }, [box, el('span', { text: label })])
    }

    holder.append(el('div', { class: 'prompt-editor' }, [
      el('div', { class: 'prompt-fields' }, [
        field(t`名称`, name),
        field(t`触发方式`, kind),
        field(t`位置`, position),
        field(t`顺序`, order),
        field(t`关键词`, keys, 'wide'),
        secondary ? field(t`次要关键词`, secondary, 'wide') : null,
        el('div', { class: 'prompt-field wide book-match' }, [
          match('caseSensitive', t`区分大小写`, t`关键词的大小写要和对话里一致才算提到`),
          match('wholeWords', t`整词匹配`, t`英文关键词要作为完整的词出现，lamp 不算提到 lamps`),
        ]),
      ]),
      el('p', { class: 'prompt-note', text: noteOf(e) }),
      area,
      el('div', { class: 'prompt-actions' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: t`按意见改`, title: t`在「对话修改」里说说这一条想怎么改`, onclick: () => talkAbout({ id: `entry:${e.uid}`, label: titleOf(e) }) }),
        el('button', { type: 'button', class: 'btn small danger', text: t`删除条目`, onclick: guard(() => removeEntry(e)) }),
      ]),
    ]))
  }

  function field(label, control, extra = '') {
    return el('label', { class: `prompt-field${extra ? ` ${extra}` : ''}` }, [el('span', { text: label }), control])
  }

  function filterRows() {
    const terms = searchTerms(state.query)
    for (const row of document.querySelectorAll('#book-entries .prow')) {
      const e = state.detail.entries.find(x => x.uid === row.dataset.uid)
      row.hidden = terms.length > 0 && !(e && matchesTerms(entryText(e), terms))
    }
  }

  /** The book's entries arrived again (a save, a move): kept objects stay bound to open editors. */
  function takeEntries(entries) {
    const byUid = new Map(state.detail.entries.map(e => [e.uid, e]))
    state.detail.entries = entries.map(fresh => Object.assign(byUid.get(fresh.uid) ?? {}, fresh))
    const nav = navOf(state.detail.id)
    if (nav) nav.counts = countEntries(state.detail.entries)
    const kept = new Set(entries.map(e => e.uid))
    for (const uid of [...state.picked]) if (!kept.has(uid)) state.picked.delete(uid)
  }

  /** What a save that reached the prefix says. */
  function prefixNote(id) {
    return chatUses(getChat(), id) ? t`已保存。当前对话还在用改动前的固定前缀，点「应用到当前对话」后生效。` : t`已保存。常驻条目写在对话开局时的固定前缀里：新对话直接用新的，进行中的对话要在「设置 → 更多」里重建前缀。`
  }

  /**
   * Save a patch (server/worldbook.mjs editBook). Entries keep their objects,
   * so open editors stay bound to them. A switch flipped says nothing unless
   * it reached the prefix.
   */
  async function save(patch, { quiet = false } = {}) {
    const id = state.selected
    const result = await api(urlOf(id), { method: 'PUT', body: patch })
    takeEntries(result.entries)
    if (result.prefix) state.stale.add(id)
    renderNav()
    renderHead()
    onChanged?.()
    if (result.prefix) toast(prefixNote(id), 6000)
    else if (!quiet) toast(t`已保存，下一轮生效`)
    return result
  }

  /** The book's own fields (server/worldbook.mjs editBookInfo); none of them is in a prefix. */
  async function saveInfo(change, said) {
    const result = await api(urlOf(state.selected), { method: 'PUT', body: change })
    Object.assign(state.detail, { name: result.name, description: result.description, scanDepth: result.scanDepth })
    const nav = navOf(state.selected)
    if (nav) nav.name = result.name
    renderNav()
    renderHead()
    const sub = $('book-settings-sub')
    if (sub) sub.textContent = settingsSummary()
    onChanged?.()
    toast(said)
  }

  /** The entries drawn again where they were (the window scrolls as one page). */
  function redraw() {
    const main = $('book-main')
    const scroll = main.scrollTop
    renderMain()
    main.scrollTop = scroll
  }

  /** A save that adds or removes rows: the list is drawn again where it was. */
  async function restructure(patch) {
    const result = await save(patch, { quiet: true })
    redraw()
    return result
  }

  async function addEntry() {
    const { added } = await restructure({ add: { comment: t`新条目` } })
    if (!added) return
    state.open.add(added)
    redraw()
    const row = document.querySelector(`#book-entries .prow[data-uid="${CSS.escape(added)}"]`)
    row?.classList.add('open')
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('.prompt-field input')?.select()
  }

  async function removeEntry(e) {
    if (!confirm(t`删除条目「${titleOf(e)}」？`)) return
    state.open.delete(e.uid)
    await restructure({ remove: [e.uid] })
    toast(t`已删除「${titleOf(e)}」`)
  }

  // ─── Many entries at once ─────────────────────────────────────────────
  async function switchPicked(enabled) {
    const uids = [...state.picked]
    const { prefix } = await save({ entries: uids.map(uid => ({ uid, enabled })) }, { quiet: true })
    redraw()
    // One that reached the prefix has said so already.
    if (!prefix) toast(enabled ? t`已启用 ${uids.length} 条` : t`已停用 ${uids.length} 条`)
  }

  async function removePicked() {
    const uids = [...state.picked]
    if (!confirm(t`删除选中的 ${uids.length} 个条目？`)) return
    for (const uid of uids) state.open.delete(uid)
    await restructure({ remove: uids })
    toast(t`已删除 ${uids.length} 条`)
  }

  /** Copies (or moves) the ticked entries to another imported book, or to a new one (`to` empty). */
  async function transfer(to, move) {
    const uids = [...state.picked]
    let name = ''
    if (!to) {
      const own = navOf(state.selected)?.own
      name = prompt(t`新世界书的名字`, t`${own ? state.card?.name ?? '' : state.detail.name}（摘录）`)?.trim() ?? ''
      if (!name) return
    }
    const from = state.selected
    const result = await api('/api/worldbooks/transfer', { method: 'POST', body: { from, to, uids, move, name } })
    if (move) {
      takeEntries(result.from.entries)
      for (const uid of uids) state.open.delete(uid)
      if (result.from.prefix) state.stale.add(from)
    }
    if (result.to.prefix) state.stale.add(result.to.id)
    // A new book is where the next ones go too.
    state.target = result.to.id
    state.picked.clear()
    await refreshBooks()
    redraw()
    await onChanged?.()
    const said = move ? t`已把 ${uids.length} 条移到「${result.to.name}」` : t`已把 ${uids.length} 条复制到「${result.to.name}」`
    // Constant entries left or arrived in a book the open chat uses.
    const behind = (move && result.from.prefix && chatUses(getChat(), from)) || (result.to.prefix && chatUses(getChat(), result.to.id))
    toast(behind ? [said, t`当前对话的固定前缀还是改动前的版本，要「应用到当前对话」才会跟着变。`].join(t`。`) : said, behind ? 6000 : 3000)
  }

  // ─── 对话修改 (talk-dialog.js) ─────────────────────────────────────────
  function talkButton() {
    return el('button', { class: 'btn small', type: 'button', text: t`对话修改`, title: t`说说想怎么改，向导把要改的条目整条写出来，勾上的才会改进书里`, onclick: () => talkAbout() })
  }

  /** The talk on the book shown; `aim` keeps the first request to one entry. */
  function talkAbout(aim = null) {
    const id = state.selected
    const own = navOf(id)?.own
    const empty = () => !state.detail?.entries.length
    openTalk?.({
      url: `/api/talk/book/${id}`,
      title: t`对话修改世界书`,
      name: own ? t`「${state.card?.name ?? ''}」卡里自带` : state.detail.name,
      aim,
      intro: () => (empty()
        ? t`说说这本世界书写什么：世界的规则、人物、地点、组织……向导一条条写出来，勾上的才会写进书里，写完还能接着说怎么改。`
        : t`说说想怎么改这本世界书：向导把要改的条目整条写出来，改前改后对照着给你看，勾上的才会改进书里。也可以只是问问，比如哪些设定互相矛盾。`),
      ideas: () => (empty()
        ? [t`修仙世界：三个宗门、两座城，灵气正在枯竭`, t`现代都市：深夜才营业的花店和它的常客`]
        : [t`给人物条目补全关键词`, t`查查有没有互相矛盾的设定`, t`太长的条目拆成几条`]),
      placeholder: target => (target ? t`「${target.label}」想怎么改，比如：写短一点，加上她的口头禅` : empty() ? t`说说这本书写什么，比如：一座雨夜才开门的旧城` : t`说说想怎么改，比如：给每个人物补上外号当关键词`),
      busy: job => (job.step === 'pick' ? t`书比较长，先看目录挑要读的条目…` : job.chars ? t`正在写，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在读这本世界书…`),
      changeTitle: change => {
        if (change.kind === 'bookInfo') return t`书名和简介`
        if (change.kind === 'newEntry') return t`新条目 · ${change.name}`
        if (change.kind === 'removeEntry') return t`删除条目 · ${change.title || t`未命名条目`}`
        return t`条目 · ${change.title || t`未命名条目`}`
      },
      changeWhere: change => {
        if (change.kind === 'bookInfo') return [t`不发给模型`, 'off', t`给玩家看的`]
        if (change.enabled === false) return [t`停用`, 'off', t`不再发给模型`]
        const constant = change.mode ? change.mode === 'constant' : change.constant
        return constant ? [t`常驻`, 'on', t`写进对话开局时的固定前缀`] : [t`关键词`, 'key', t`最近的对话提到关键词时随消息发送`]
      },
      changeNotes: change => {
        const notes = []
        if (change.kind === 'bookInfo' && change.name) notes.push(t`书名：${change.beforeName} → ${change.name}`)
        if (change.kind === 'entry' && change.name) notes.push(t`名称：${change.title || t`未命名条目`} → ${change.name}`)
        if (change.kind === 'newEntry' || change.keys) notes.push(t`关键词：${(change.keys ?? []).join(t`、`) || t`（无）`}`)
        if (change.mode) notes.push(change.mode === 'constant' ? t`改成常驻：写进对话开局时的固定前缀` : t`改成关键词触发`)
        if (change.kind === 'newEntry' && change.constant) notes.push(t`常驻：写进对话开局时的固定前缀`)
        if (change.enabled !== undefined) notes.push(change.enabled ? t`启用` : t`停用`)
        return notes
      },
      targetLabel: target => (target === 'book' ? t`书名和简介` : t`条目 ${target.slice(6)}`),
      onApplied: result => talked(id, result, t`已改进书里：${result.applied} 处`),
      onUndone: result => talked(id, result, t`已撤销这次修改`),
    })
  }

  /** What the talk applied or undid: the book drawn again, the prefix bar if it reached it. */
  async function talked(id, result, said) {
    if (result.prefix) state.stale.add(id)
    if (state.selected === id) {
      state.detail = { ...state.detail, ...result.book, entries: state.detail.entries }
      takeEntries(result.book.entries)
      redraw()
    }
    await refreshBooks()
    await onChanged?.()
    // Constant entries changed in a book the open chat uses.
    const behind = result.prefix && chatUses(getChat(), id)
    toast(behind ? [said, t`当前对话的固定前缀还是改动前的版本，要「应用到当前对话」才会跟着变。`].join(t`。`) : said, behind ? 6000 : 3000)
  }

  // ─── Whole books ──────────────────────────────────────────────────────
  async function exportBook() {
    const file = await api(`/api/worldbooks/${state.selected}/export`)
    saveFile(t`世界书-${file.name}.json`, JSON.stringify(file, null, 2), state.detail.complete
      ? t`可以在 SillyTavern 的「世界信息」里导入，也可以导入另一台设备的 CicaTavern。`
      : t`这本导入得早，没留下 SillyTavern 里另外的字段（深度、分组等），导出的是这里记得的部分。可以在 SillyTavern 的「世界信息」里导入。`)
  }

  async function copyBook() {
    const copy = await api(`/api/worldbooks/${state.selected}/copy`, { method: 'POST', body: {} })
    await refreshBooks()
    await select(copy.id)
    onChanged?.()
    toast(t`已复制为「${copy.name}」`)
  }

  async function removeBook() {
    const { id, name } = state.detail
    const users = usedBy(id)
    const question = users.length
      ? t`删除世界书「${name}」？\n\n挂着它的 ${users.length} 张卡会一起摘下：${users.map(c => c.name).join(t`、`)}。进行中的对话里，它的常驻条目要重建前缀后才去掉。`
      : t`删除世界书「${name}」？`
    if (!confirm(question)) return
    const { detached } = await api(`/api/worldbooks/${id}`, { method: 'DELETE' })
    state.mounted.delete(id)
    await onChanged?.({ mounts: [id] })
    await refreshBooks()
    await select(state.books[0]?.id ?? null)
    toast(detached.length ? t`已删除「${name}」，并从 ${detached.length} 张卡上摘下` : t`已删除「${name}」`)
  }

  async function newBook() {
    const book = await api('/api/worldbooks', { method: 'POST', body: {} })
    await refreshBooks()
    state.panels.add('settings')
    await select(book.id)
    dialog.querySelector('.preset-layout').classList.add('show-main')
    onChanged?.()
    dialog.querySelector('.book-panel[data-panel="settings"] input')?.select()
  }

  async function applyToChat() {
    const chat = getChat()
    if (!chat) return
    const view = await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
    for (const id of [...state.stale]) {
      if (!chatUses(view, id) && !state.remounted.has(id)) continue
      state.stale.delete(id)
      state.remounted.delete(id)
    }
    onChatChanged(view)
    renderHead()
    toast(t`已重建固定前缀，下一轮生效`)
  }

  $('book-new').addEventListener('click', guard(newBook))
  $('book-import').addEventListener('change', guard(async event => {
    const files = [...event.target.files]
    event.target.value = ''
    let last = null
    for (const file of files) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      last = await api('/api/worldbooks/import', { method: 'POST', body: { filename: file.name, data } })
    }
    if (!last) return
    await refreshBooks()
    await select(last.id)
    dialog.querySelector('.preset-layout').classList.add('show-main')
    onChanged?.()
    toast(t`已导入世界书「${last.name}」${last.entries} 条`)
  }))

  return { open: guard(open) }
}
