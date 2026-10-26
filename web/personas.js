// 你的角色 and 文风 (设置 → 写作): the player's personas and writing styles,
// each a list laid out as the 预设 and 正则 windows are: the list on the left,
// one item on the right with its fields, the cards that pick it, and what it
// means for the open chat. A new chat takes its card's pick, else the default,
// and keeps it (server/chats.mjs): changing a pick, the default or an item's
// text later leaves chats already started as they are, until 用于当前对话 (or
// 应用到当前对话 after an edit) builds the open one's prefix again, and the
// next turn writes the cache once more. Files go out in SillyTavern's shapes
// (web/shared/personas.js).
import { lang, t, zh } from '/i18n.js'
import { cardsOf, DEFAULT_ITEM, pickFor, stPersonas, stStyles } from '/shared/personas.js'
// For 设置 → 写作 (app.js), which loads this module when it opens.
export { cardPick, defaultOf, itemOf } from '/shared/personas.js'

/** The default persona name is the Chinese 你 (for the model); an English page says You. */
export const personaName = name => (name === zh`你` ? t`你` : name)

const KINDS = {
  persona: {
    url: '/api/personas',
    chatKey: 'personaId',
    title: t`你的角色`,
    label: item => (item.title ? `${personaName(item.name)} · ${item.title}` : personaName(item.name)),
    sub: item => item.description.trim().slice(0, 60) || t`没写角色设定`,
    note: t`新对话用卡指定的角色，卡没指定就用默认的；对话开始后一直用开局时那个，名字和设定写在它的固定前缀里。`,
    empty: { name: zh`你` },
  },
  style: {
    url: '/api/styles',
    chatKey: 'styleId',
    title: t`文风`,
    label: item => item.name || t`我的文风`,
    sub: item => item.text.trim().slice(0, 60) || t`没写要求`,
    note: t`新对话用卡指定的文风，卡没指定就用默认的；对话开始后一直用开局时那个，写在它的固定前缀里。写作语言和字数在「设置 → 写作 → 语言与字数」。`,
    empty: { name: '' },
  },
}

/**
 * @param getChat - the open chat (its view: cardId, names, personaId, styleId).
 * @param getCardId - the card the window speaks of: the open chat's, else the chosen one.
 * @param getCards - the card list (each { id, name, group, archived }).
 * @param onChatChanged - (chat view) after the open chat's prefix was built again.
 * @param onListChanged - (kind, list) after a list was saved.
 */
export function initPersonas({ api, el, toast, guard, saveFile, getChat, getCardId, getCards, isGenerating, onChatChanged, onListChanged }) {
  const $ = id => document.getElementById(id)
  const dialog = $('persona-dialog')
  const layout = dialog.querySelector('.preset-layout')
  const lists = { persona: null, style: null }
  const state = {
    kind: 'persona',
    selected: null,
    panels: new Set(),
    // Items edited while the open chat uses them: id → the persona's name before (its chat may go by it).
    stale: new Map(),
  }
  // Field saves one after another: a change and the window closing never save twice at once.
  let saving = Promise.resolve()
  // The shown item's save, for what was typed and not yet saved when the window closes.
  let pendingSave = null

  const kind = () => KINDS[state.kind]
  const list = () => lists[state.kind]
  const shown = () => list().items.find(item => item.id === state.selected) ?? list().items.find(item => item.id === list().defaultId)
  /** What the open chat uses of a kind (as the server works it out, chats.mjs chatPicks), or null. */
  const chatUses = (of = state.kind) => {
    const chat = getChat()
    return chat && lists[of] ? pickFor(lists[of], chat.cardId, chat[KINDS[of].chatKey] ?? DEFAULT_ITEM) : null
  }
  async function load(of) {
    lists[of] = await api(KINDS[of].url)
    onListChanged?.(of, lists[of])
    return lists[of]
  }

  /** The window on a kind, at `selectId` (else the open chat's, else the default). */
  async function open(of = 'persona', selectId = null) {
    await saving
    if (of !== state.kind) state.stale.clear()
    state.kind = of
    await load(of)
    const wanted = selectId ?? chatUses()?.id ?? list().defaultId
    state.selected = list().items.some(item => item.id === wanted) ? wanted : list().defaultId
    $('persona-title').textContent = kind().title
    $('persona-note').textContent = kind().note
    $('persona-new').title = of === 'persona' ? t`新建一个角色：你在故事里的名字和设定` : t`新建一个文风`
    $('persona-import-label').title = of === 'persona'
      ? t`导入 SillyTavern 角色管理里「备份」出来的文件，或者本应用导出的角色（.json）`
      : t`导入 SillyTavern 的系统提示词（.json）、本应用导出的文风，或者一个写着要求的文本文件（.txt、.md）`
    renderNav()
    renderMain()
    layout.classList.toggle('show-main', Boolean(selectId))
    if (!dialog.open) dialog.showModal()
  }

  function select(id) {
    state.selected = id
    renderNav()
    renderMain()
  }

  // ─── The list ─────────────────────────────────────────────────────────
  function renderNav() {
    const here = getCardId()
    const uses = chatUses()
    const item = one => {
      const cards = cardsOf(list(), one.id)
      const tags = [
        one.id === list().defaultId ? el('span', { class: 'tag', text: t`默认` }) : null,
        uses?.id === one.id ? el('span', { class: 'tag', text: t`当前对话` }) : null,
        here && cards.includes(here) ? el('span', { class: 'tag', text: t`这张卡指定` }) : cards.length ? el('span', { class: 'tag off', text: t`${cards.length} 张卡` }) : null,
      ]
      return el('li', { class: state.selected === one.id ? 'active' : '', onclick: () => select(one.id) }, [
        el('div', { class: 'item-title' }, [el('span', { class: 'item-main', text: kind().label(one) }), ...tags]),
        el('div', { class: 'item-sub', text: kind().sub(one) }),
      ])
    }
    $('persona-list').replaceChildren(...list().items.map(item))
  }

  // ─── One item ─────────────────────────────────────────────────────────
  function whereText(item) {
    const cards = cardsOf(list(), item.id)
    const parts = []
    if (item.id === list().defaultId) parts.push(t`默认：卡没指定的新对话都用它`)
    if (cards.length) parts.push(t`${cards.length} 张卡指定了它，这些卡新开的对话用它`)
    if (!parts.length) parts.push(t`还没有卡指定它：设为默认，或者在下面「指定它的卡」里勾上`)
    if (chatUses()?.id === item.id) parts.push(t`当前对话正在用`)
    return parts.join(t`。`) + t`。`
  }

  function headParts(item) {
    const chat = getChat()
    const isDefault = item.id === list().defaultId
    const inChat = chatUses()?.id === item.id
    const stale = inChat && state.stale.has(item.id)
    const actions = el('div', { class: 'preset-actions' }, [
      el('button', { class: 'btn small', type: 'button', disabled: isDefault, text: isDefault ? t`已是默认` : t`设为默认`, title: t`卡没指定的新对话用它；已经开始的对话不变`, onclick: guard(setDefault) }),
      chat ? el('button', {
        class: 'btn small', type: 'button', disabled: inChat || isGenerating(),
        text: inChat ? t`当前对话正在用` : t`用于当前对话`,
        title: state.kind === 'persona' ? t`当前对话改用这个角色：故事里你的名字和设定跟着换，之前写下的不变；重建固定前缀，下一轮多写一次缓存` : t`当前对话改用这个文风：重建固定前缀，下一轮多写一次缓存`,
        onclick: guard(useInChat),
      }) : null,
      el('button', { class: 'btn small', type: 'button', text: t`复制一份`, title: t`复制出一个一样的，改它不影响原来这个；新的先没有卡指定`, onclick: guard(copy) }),
      el('button', { class: 'btn small', type: 'button', text: t`导出`, title: exportTitle(), onclick: () => exportItems([item]) }),
      el('button', { class: 'btn small danger', type: 'button', disabled: isDefault, text: t`删除`, title: isDefault ? t`默认的不能删：先把另一个设为默认` : '', onclick: guard(remove) }),
    ])
    return [
      el('header', { class: 'preset-head' }, [
        el('h3', { class: 'preset-title', text: kind().label(item) }),
        el('div', { class: 'preset-meta', text: whereText(item) }),
        actions,
      ]),
      stale ? el('div', { class: 'preset-apply' }, [
        el('span', { text: t`当前对话的固定前缀还是改动前的版本。应用后，下一轮会重新写入一次缓存。` }),
        el('button', { class: 'btn small primary', type: 'button', disabled: isGenerating(), text: t`应用到当前对话`, onclick: guard(applyEdit) }),
      ]) : null,
    ].filter(Boolean)
  }

  function renderMain() {
    const item = shown()
    $('persona-main').replaceChildren(
      el('div', { id: 'persona-headwrap' }, headParts(item)),
      fieldsFor(item),
      el('div', { class: 'book-panels' }, [cardsPanel(item)]),
    )
  }

  /** Header and list drawn again, the fields left as they are (one may be being typed in). */
  function redrawHead() {
    renderNav()
    $('persona-headwrap')?.replaceChildren(...headParts(shown()))
  }

  const field = (text, control, hint = '') => el('label', { class: 'prompt-field' }, [el('span', { text }), control, hint ? el('span', { class: 'prompt-note', text: hint }) : null])

  /** The item's own fields; each saves when it is left (and when the window closes). */
  function fieldsFor(item) {
    const inputs = {}
    const save = () => {
      const change = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]))
      saving = saving.catch(() => {}).then(() => saveFields(item.id, change))
      return saving
    }
    const input = (key, attrs) => {
      const node = el(key === 'description' || key === 'text' ? 'textarea' : 'input', attrs)
      // The default name 你 shows as the field's hint on an English page; left empty, it stays 你.
      node.value = key === 'name' && state.kind === 'persona' && lang !== 'zh' && item.name === zh`你` ? '' : item[key]
      node.addEventListener('change', guard(save))
      inputs[key] = node
      return node
    }
    pendingSave = save
    if (state.kind === 'persona') {
      return el('div', { class: 'persona-form' }, [
        el('div', { class: 'persona-row' }, [
          field(t`名字`, input('name', { maxlength: '80', placeholder: t`你`, 'aria-label': t`名字` }), t`故事里怎么称呼你，也就是 {{user}}`),
          field(t`备注`, input('title', { maxlength: '80', placeholder: t`比如：现代都市版`, 'aria-label': t`备注` }), t`只在列表里显示，不发给模型`),
        ]),
        field(t`角色设定`, input('description', { rows: '10', placeholder: t`你是谁、长什么样、和角色是什么关系……可以用 {{char}} 和 {{user}}`, 'aria-label': t`角色设定` }), t`写进固定前缀的「玩家角色」一节。卡里自带了主角名字的，只有这里的名字和卡里的一样、或者卡指定了这个角色时，才会带上这段设定。`),
      ])
    }
    return el('div', { class: 'persona-form' }, [
      field(t`名称`, input('name', { maxlength: '80', placeholder: t`我的文风`, 'aria-label': t`名称` }), t`只在列表里显示，不发给模型`),
      field(t`文风与写作要求`, input('text', { rows: '10', placeholder: t`例如：第三人称限知视角，白描为主，少用形容词堆砌；对白口语化。`, 'aria-label': t`文风与写作要求` }), t`写进固定前缀的「文风与写作要求」一节，用什么预设都在。`),
    ])
  }

  async function saveFields(id, change) {
    const before = list().items.find(item => item.id === id)
    if (state.kind === 'persona' && !change.name.trim()) change.name = zh`你`
    if (!before || Object.keys(change).every(key => change[key] === before[key])) return
    const { item, list: saved } = await api(`${kind().url}/${id}`, { method: 'PUT', body: change })
    lists[state.kind] = saved
    onListChanged?.(state.kind, saved)
    const inChat = chatUses()?.id === id
    if (inChat && !state.stale.has(id)) state.stale.set(id, before.name)
    if (state.selected === id && dialog.open) redrawHead()
    const said = item.id === list().defaultId || cardsOf(list(), id).length ? t`已保存，之后新开的对话用新的` : t`已保存`
    toast(inChat ? [said, t`当前对话的固定前缀还是改动前的版本，要「应用到当前对话」才会跟着变。`].join(t`。`) : said, inChat ? 6000 : 3000)
  }

  /** Every card, ticked when it picks this item; a tick saves at once. */
  function cardsPanel(item) {
    const cards = getCards()
    const box = el('div', { class: 'book-cards' }, cards.map(card => {
      const other = list().cards[card.id]
      const tick = el('input', { type: 'checkbox', value: card.id, checked: other === item.id })
      tick.addEventListener('change', guard(async () => {
        try {
          await saveCards(item, box, card)
        } catch (error) {
          tick.checked = !tick.checked
          throw error
        }
      }))
      const otherItem = other && other !== item.id ? list().items.find(one => one.id === other) : null
      return el('label', { class: 'check-row book-check' }, [
        tick,
        el('span', { class: 'book-card-name', text: card.name }),
        otherItem ? el('span', { class: 'book-panel-sub', text: t`现在指定：${kind().label(otherItem)}` }) : null,
        card.archived ? el('span', { class: 'book-panel-sub', text: t`已归档` }) : null,
      ])
    }))
    const n = cardsOf(list(), item.id).length
    const details = el('details', { class: 'book-panel' }, [
      el('summary', {}, [el('span', { text: t`指定它的卡` }), el('span', { class: 'book-panel-sub', text: n ? t`${n} 张` : t`还没有` })]),
      el('div', { class: 'book-panel-body' }, [
        cards.length ? box : el('p', { class: 'prompt-note', text: t`还没有角色卡。` }),
        el('p', { class: 'prompt-note', text: state.kind === 'persona'
          ? t`勾上的卡，新开的对话用这个角色（名字也用它的，不用卡里自带的主角名）。一张卡只能指定一个，勾在这里就从别的那个摘下；没指定的卡用默认的。已经开始的对话不跟着换。导出角色卡时不会带上你的角色。`
          : t`勾上的卡，新开的对话用这个文风。一张卡只能指定一个，勾在这里就从别的那个摘下；没指定的卡用默认的。已经开始的对话不跟着换。导出角色卡时不会带上。` }),
      ]),
    ])
    details.open = state.panels.has('cards')
    details.addEventListener('toggle', () => (details.open ? state.panels.add('cards') : state.panels.delete('cards')))
    return details
  }

  async function saveCards(item, box, card) {
    const ids = [...box.querySelectorAll('input:checked')].map(tick => tick.value)
    const { list: saved } = await api(`${kind().url}/${item.id}/cards`, { method: 'PUT', body: { ids } })
    lists[state.kind] = saved
    onListChanged?.(state.kind, saved)
    renderNav()
    renderMain()
    const picked = saved.cards[card.id] === item.id
    toast(picked ? t`「${card.name}」新开的对话用「${kind().label(item)}」` : t`「${card.name}」不再指定，新开的对话用默认的`)
    await offerSwitch(card.id, [state.kind])
  }

  // ─── Whole items ──────────────────────────────────────────────────────
  async function create() {
    await saving
    const name = prompt(state.kind === 'persona' ? t`新角色的名字（故事里怎么称呼你）` : t`新文风的名称`, state.kind === 'persona' ? '' : t`新文风`)?.trim()
    if (name == null) return
    const body = state.kind === 'persona' ? { name: name || zh`你` } : { name }
    const { item, list: saved } = await api(kind().url, { method: 'POST', body })
    lists[state.kind] = saved
    onListChanged?.(state.kind, saved)
    select(item.id)
    layout.classList.add('show-main')
    $('persona-main').querySelector('textarea')?.focus()
  }

  async function copy() {
    await saving
    const { item, list: saved } = await api(`${kind().url}/${shown().id}/copy`, { method: 'POST', body: {} })
    lists[state.kind] = saved
    onListChanged?.(state.kind, saved)
    select(item.id)
    toast(t`已复制为「${kind().label(item)}」，还没有卡指定它`)
  }

  async function remove() {
    await saving
    const item = shown()
    const n = cardsOf(list(), item.id).length
    const what = n ? t`指定它的 ${n} 张卡改用默认的。` : ''
    if (!confirm(t`删除「${kind().label(item)}」？${what}正在用它的对话，下次重建固定前缀时改用卡指定的或默认的。`)) return
    lists[state.kind] = await api(`${kind().url}/${item.id}`, { method: 'DELETE' })
    onListChanged?.(state.kind, list())
    state.stale.delete(item.id)
    select(list().defaultId)
    layout.classList.remove('show-main')
    toast(t`已删除`)
  }

  async function setDefault() {
    await saving
    const item = shown()
    lists[state.kind] = await api(`${kind().url}/${item.id}/default`, { method: 'POST', body: {} })
    onListChanged?.(state.kind, list())
    redrawHead()
    toast(t`卡没指定的新对话改用「${kind().label(item)}」。已经开始的对话不变。`)
  }

  async function useInChat() {
    await saving
    const chat = getChat()
    if (!chat || isGenerating()) return
    const item = shown()
    const view = await api(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { [kind().chatKey]: item.id } })
    state.stale.delete(item.id)
    onChatChanged(view)
    redrawHead()
    toast(state.kind === 'persona'
      ? t`当前对话改用「${kind().label(item)}」，故事里你叫「${personaName(view.names.user)}」。下一轮会重新写入一次缓存。`
      : t`当前对话改用「${kind().label(item)}」。下一轮会重新写入一次缓存。`, 6000)
  }

  /** An item the open chat uses was edited: its prefix built again (a renamed persona renames the player too). */
  async function applyEdit() {
    await saving
    const chat = getChat()
    if (!chat || isGenerating()) return
    const item = shown()
    const before = state.stale.get(item.id)
    const rename = state.kind === 'persona' && chat.names.user === before && item.name !== before
    const view = rename
      ? await api(`/api/chats/${chat.id}/picks`, { method: 'POST', body: { personaId: item.id } })
      : await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: {} })
    state.stale.delete(item.id)
    onChatChanged(view)
    redrawHead()
    toast(t`已应用到当前对话。下一轮会重新写入一次缓存。`)
  }

  function exportTitle() {
    return state.kind === 'persona'
      ? t`存成 SillyTavern 角色管理的备份文件：可以在 SillyTavern 里「恢复」，也可以导入另一台设备的 CicaTavern`
      : t`存成 SillyTavern 的系统提示词文件：可以在 SillyTavern 的「高级格式」里导入，也可以导入另一台设备的 CicaTavern`
  }

  function exportItems(items) {
    const one = items.length === 1
    const name = one ? kind().label(items[0]).slice(0, 40) : kind().title
    if (state.kind === 'persona') {
      saveFile(t`角色-${name}.json`, JSON.stringify(stPersonas(items), null, 2), one
        ? t`已导出 1 个角色。可以在 SillyTavern 的角色管理里「恢复」，也可以导入另一台设备的 CicaTavern。`
        : t`已导出 ${items.length} 个角色。可以在 SillyTavern 的角色管理里「恢复」，也可以导入另一台设备的 CicaTavern。`)
      return
    }
    const named = items.map(item => ({ ...item, name: kind().label(item) }))
    saveFile(t`文风-${name}.json`, JSON.stringify(stStyles(named), null, 2), one
      ? t`已导出 1 个文风。可以在 SillyTavern 的「高级格式」里作为系统提示词导入，也可以导入另一台设备的 CicaTavern。`
      : t`已导出 ${items.length} 个文风。SillyTavern 一次只认一个，整份可以导入另一台设备的 CicaTavern。`)
  }

  async function importFiles(files) {
    await saving
    let added = []
    let skipped = 0
    for (const file of files) {
      const result = await api(`${kind().url}/import`, { method: 'POST', body: { text: await file.text(), filename: file.name } })
      lists[state.kind] = result.list
      added = [...added, ...result.added]
      skipped += result.skipped
    }
    onListChanged?.(state.kind, list())
    if (added.length) select(added.at(-1).id)
    else renderNav()
    const already = skipped ? t`${skipped} 个这里已经有了，跳过` : ''
    const said = state.kind === 'persona' ? t`已导入 ${added.length} 个角色` : t`已导入 ${added.length} 个文风`
    toast(added.length ? [said, already].filter(Boolean).join(t`，`) : already || t`没有导入`)
  }

  // ─── The open chat on a card whose pick changed ───────────────────────
  /**
   * After a card's picks changed (here, or in 设置 → 写作): when the open chat is on that card and uses something
   * else, ask whether it switches too. → whether it did.
   */
  async function offerSwitch(cardId, kinds) {
    const chat = getChat()
    if (!chat || chat.cardId !== cardId || isGenerating()) return false
    // As saved now: the picks may have changed outside this window (设置 → 写作).
    for (const of of kinds) await load(of)
    const changes = kinds
      .map(of => ({ of, uses: chatUses(of), wants: pickFor(lists[of], cardId) }))
      .filter(change => change.uses && change.uses.id !== change.wants.id)
    if (!changes.length) return false
    const lines = changes.map(({ of, uses, wants }) => t`${KINDS[of].title}：当前对话用「${KINDS[of].label(uses)}」，这张卡现在指定「${KINDS[of].label(wants)}」`)
    const renamed = changes.some(change => change.of === 'persona') ? t`\n故事里你的名字会跟着换，之前写下的内容不变。` : ''
    const ok = confirm(t`${lines.join('\n')}\n\n当前对话也跟着换吗？会重建这个对话的固定前缀（历史不变），下一轮会重新写入一次缓存。${renamed}\n\n取消：当前对话照旧，这张卡之后新开的对话用新指定的。`)
    if (!ok) return false
    const body = Object.fromEntries(changes.map(({ of }) => [KINDS[of].chatKey, '']))
    onChatChanged(await api(`/api/chats/${chat.id}/picks`, { method: 'POST', body }))
    if (dialog.open) redrawHead()
    toast(t`已应用到当前对话。下一轮会重新写入一次缓存。`)
    return true
  }

  $('persona-new').addEventListener('click', guard(create))
  $('persona-export-all').addEventListener('click', () => exportItems(list().items))
  $('persona-import').addEventListener('change', guard(async event => {
    const files = [...event.target.files]
    event.target.value = ''
    if (files.length) await importFiles(files)
  }))
  // What was typed in a field and not yet saved, saved as the window closes.
  dialog.addEventListener('close', () => {
    pendingSave?.()?.catch(error => toast(error.message, 6000))
  })

  // offerSwitch unguarded: its answer (switched or not) is what 设置 says after saving.
  return { open: guard(open), offerSwitch, load }
}
