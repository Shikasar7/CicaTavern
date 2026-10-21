// 世界书条目 (设置 → 世界书与状态 → 挂载的世界书 → 查看条目): the entries of a
// card's own worldbook and of the imported ones, each with its switch and an
// editor, in the preset window's layout. A chat renders its constant entries
// into the frozen prefix when it starts, so an edit that reaches them leaves the
// open chat on the old text until the prefix is applied again (the bar the
// preset window shows too); keyword entries and templated ones are read every turn.
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

const titleOf = e => e.comment || e.content.replace(/\s+/g, ' ').trim().slice(0, 24) || t`未命名条目`
const splitKeys = text => text.split(/[,，]/).map(key => key.trim()).filter(Boolean)

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
 * @param deps - { api, el, toast, guard, getChat, getCards, isGenerating, onChatChanged(chatView), onChanged() }
 *   onChanged runs after every save, so the settings page can count again.
 */
export function initBooks({ api, el, toast, guard, getChat, getCards, isGenerating, onChatChanged, onChanged }) {
  const $ = id => document.getElementById(id)
  const dialog = $('book-dialog')
  const state = {
    card: null, // the card the settings page is for
    books: [], // nav: [{ id, name, own, counts }]; a card's own book is card-<card id>, as chats know it
    mounted: new Set(), // imported books ticked for the card in the settings page
    selected: null,
    detail: null, // { id, name, entries }
    query: '',
    open: new Set(), // expanded entry uids
    stale: new Set(), // book ids edited in the prefix since the open chat applied them
  }
  const urlOf = id => (id.startsWith('card-') ? `/api/cards/${id.slice(5)}/book` : `/api/worldbooks/${id}`)
  const navOf = id => state.books.find(b => b.id === id)

  /** Whether the open chat has this book in its prefix: its card's own, or one its card has mounted. */
  function chatUses(chat, id) {
    if (!chat) return false
    if (id === `card-${chat.cardId}`) return true
    return (getCards().find(c => c.id === chat.cardId)?.worldbookIds ?? []).includes(id)
  }

  /**
   * @param card - the card summary the settings page is for.
   * @param books - imported books (GET /api/worldbooks).
   * @param mounted - ids of the books ticked for the card.
   * @param select - the book to show: card-<id> or an imported one's id.
   */
  async function open({ card, books, mounted = [], select: wanted }) {
    state.card = card
    state.mounted = new Set(mounted)
    state.books = [
      ...(card?.bookEntries ? [{ id: `card-${card.id}`, name: t`卡里自带`, own: true, counts: { entries: card.bookEntries, enabled: card.bookEnabled, constant: card.bookConstant } }] : []),
      ...books.map(b => ({ id: b.id, name: b.name, own: false, counts: { entries: b.entries, enabled: b.enabled, constant: b.constant } })),
    ]
    if (!state.books.length) return
    await select(navOf(wanted) ? wanted : state.books[0].id)
    if (!dialog.open) dialog.showModal()
    // On a phone, straight to the book that was picked (style.css .show-main).
    dialog.querySelector('.preset-layout').classList.toggle('show-main', Boolean(wanted))
  }

  async function select(id) {
    state.selected = id
    state.query = ''
    state.open.clear()
    state.detail = await api(urlOf(id))
    renderNav()
    renderMain()
  }

  function renderNav() {
    $('book-list').replaceChildren(...state.books.map(b => {
      const tag = b.own ? t`始终生效` : state.mounted.has(b.id) ? t`已挂载` : ''
      return el('li', { class: state.selected === b.id ? 'active' : '', onclick: () => guard(select)(b.id) }, [
        el('div', { class: 'item-title' }, [el('span', { class: 'item-main', text: b.name }), tag ? el('span', { class: 'tag', text: tag }) : null]),
        el('div', { class: 'item-sub', text: countText(b.counts) }),
      ])
    }))
  }

  // ─── Main column ──────────────────────────────────────────────────────
  /** Title, what the book is to the card, and the apply bar. */
  function headParts() {
    const detail = state.detail
    const own = navOf(detail.id)?.own
    const chat = getChat()
    const stale = state.stale.has(detail.id) && chatUses(chat, detail.id)
    const where = own
      ? t`「${state.card.name}」卡里自带，这张卡的每个对话都用。重新导入这张卡来更新时，会换成文件里的版本，这里的修改不保留。`
      : state.mounted.has(detail.id)
        ? t`挂在「${state.card.name}」上。挂着这本的每张卡都会用到这里的修改。`
        : t`没挂在「${state.card.name}」上：在「挂载的世界书」里勾上才对这张卡生效。`
    return [
      el('header', { class: 'preset-head' }, [
        el('h3', { class: 'preset-title', text: own ? t`卡里自带的世界书` : detail.name }),
        el('div', { class: 'preset-meta', text: [countText(countEntries(detail.entries)), where].join(t`。`) }),
      ]),
      stale ? el('div', { class: 'preset-apply' }, [
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
    const search = el('input', { type: 'search', placeholder: t`搜索条目名称、关键词或内容`, value: state.query })
    search.addEventListener('input', () => { state.query = search.value.trim().toLowerCase(); filterRows() })
    $('book-main').replaceChildren(
      el('div', { id: 'book-headwrap' }, headParts().filter(Boolean)),
      el('div', { class: 'preset-tools' }, [
        search,
        el('button', { type: 'button', class: 'btn small', text: t`＋ 新增条目`, onclick: guard(addEntry) }),
      ]),
      detail.entries.length
        ? el('ul', { class: 'prompt-list book-entries', id: 'book-entries' }, detail.entries.map(entryRow))
        : el('p', { class: 'preset-empty', text: t`这本世界书还没有条目。` }),
    )
    filterRows()
  }

  function entryRow(e) {
    const more = el('div', { class: 'prow-more' }, el('div'))
    const row = el('li', { class: `prow${e.enabled ? '' : ' off'}${state.open.has(e.uid) ? ' open' : ''}`, 'data-uid': e.uid }, [line(), more])
    if (state.open.has(e.uid)) fillEditor(more, e, row)

    /** Switch, name, keys, tag and size: built again after each save. */
    function line() {
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
      const name = el('button', { type: 'button', class: 'prow-name', text: titleOf(e), title: t`展开编辑`, 'aria-expanded': String(opened), onclick: expand })
      return el('div', { class: 'prow-line' }, [
        toggle,
        name,
        e.keys.length ? el('span', { class: 'book-keys', title: e.keys.join(', '), text: e.keys.join(t`、`) }) : null,
        el('span', { class: `strategy ${cls}`, title: tip, text: label }),
        el('span', { class: 'prow-size', text: t`${e.content.length.toLocaleString()} 字` }),
        el('button', { type: 'button', class: 'prow-edit', title: t`编辑名称、关键词、位置和内容`, 'aria-label': t`编辑「${titleOf(e)}」`, text: '✎', onclick: expand }),
      ])
    }
    function expand() {
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
    row.refresh = () => {
      row.querySelector('.prow-line').replaceWith(line())
      row.classList.toggle('off', !e.enabled)
      const note = row.querySelector('.prompt-note')
      if (note) note.textContent = noteOf(e)
    }
    return row
  }

  /** Name, trigger, position, order, keys and the text; each saves when it changes. */
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

    holder.append(el('div', { class: 'prompt-editor' }, [
      el('div', { class: 'prompt-fields' }, [
        editorField(t`名称`, name),
        editorField(t`触发方式`, kind),
        editorField(t`位置`, position),
        editorField(t`顺序`, order),
        editorField(t`关键词`, keys, 'wide'),
        secondary ? editorField(t`次要关键词`, secondary, 'wide') : null,
      ]),
      el('p', { class: 'prompt-note', text: noteOf(e) }),
      area,
      el('div', { class: 'prompt-actions' }, [
        el('button', { type: 'button', class: 'btn small danger', text: t`删除条目`, onclick: guard(() => removeEntry(e)) }),
      ]),
    ]))
  }

  function editorField(label, control, extra = '') {
    return el('label', { class: `prompt-field${extra ? ` ${extra}` : ''}` }, [el('span', { text: label }), control])
  }

  function filterRows() {
    const q = state.query
    for (const row of document.querySelectorAll('#book-entries .prow')) {
      const e = state.detail.entries.find(x => x.uid === row.dataset.uid)
      const text = `${e?.comment ?? ''}\n${e?.keys.join('\n') ?? ''}\n${e?.content ?? ''}`.toLowerCase()
      row.hidden = Boolean(q) && !text.includes(q)
    }
  }

  /**
   * Save a patch (server/worldbook.mjs editBook). Entries keep their objects,
   * so open editors stay bound to them. A switch flipped says nothing unless
   * it reached the prefix.
   */
  async function save(patch, { quiet = false } = {}) {
    const id = state.selected
    const result = await api(urlOf(id), { method: 'PUT', body: patch })
    const byUid = new Map(state.detail.entries.map(e => [e.uid, e]))
    state.detail.entries = result.entries.map(fresh => Object.assign(byUid.get(fresh.uid) ?? {}, fresh))
    const nav = navOf(id)
    if (nav) nav.counts = countEntries(state.detail.entries)
    if (result.prefix) state.stale.add(id)
    renderNav()
    renderHead()
    onChanged?.()
    const shown = result.prefix && chatUses(getChat(), id)
    if (result.prefix) toast(shown ? t`已保存。当前对话还在用改动前的固定前缀，点「应用到当前对话」后生效。` : t`已保存。常驻条目写在对话开局时的固定前缀里：新对话直接用新的，进行中的对话要在「设置 → 更多」里重建前缀。`, 6000)
    else if (!quiet) toast(t`已保存，下一轮生效`)
    return result
  }

  /** A save that adds or removes rows: the list is drawn again where it was. */
  async function restructure(patch) {
    const scroll = $('book-entries')?.scrollTop ?? 0
    const result = await save(patch, { quiet: true })
    renderMain()
    const list = $('book-entries')
    if (list) list.scrollTop = scroll
    return result
  }

  async function addEntry() {
    const { added } = await restructure({ add: { comment: t`新条目` } })
    if (!added) return
    state.open.add(added)
    renderMain()
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

  async function applyToChat() {
    const chat = getChat()
    if (!chat) return
    const view = await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
    for (const id of [...state.stale]) if (chatUses(view, id)) state.stale.delete(id)
    onChatChanged(view)
    renderHead()
    toast(t`已重建固定前缀，下一轮生效`)
  }

  return { open: guard(open) }
}
