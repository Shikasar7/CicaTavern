// Preset manager: SillyTavern Chat Completion presets with their prompt toggles.
// Prompts marked 前缀 are rendered into a chat's frozen system prompt when it
// starts (or when the preset is applied to it again); 每轮 prompts are rendered
// into every turn, so toggling those takes effect on the next message.
import { t } from '/i18n.js'
import { BASIC_ID } from '/shared/basic.js'
import { BASIC_FIELDS, basicField } from '/basic-options.js'

// The built-in preset is '' in this list (the default setting); chats name it BASIC_ID.
// Chats from before it existed have none (null): they show here too, as not yet applied.
const listId = chat => (chat?.presetId === BASIC_ID ? '' : chat?.presetId ?? '')

// What each placement of the prompts after the chat history means for the player.
const POST_MODE_NOTES = {
  prefix: t`按原顺序放进固定前缀的末尾，每轮附一句提醒；只有骰子、引用玩家输入这类每轮变化的段落随消息发送。缓存最省，但离回复远，选项、状态这类正文后的块容易被漏掉。`,
  latest: t`和 SillyTavern 一样：每轮跟在最新一条消息后面，之前几轮的不再重发。选项、格式要求最不容易被漏；每轮多写一条玩家消息的缓存，很便宜。只对自定义供应商生效，Claude 订阅下同「每轮都留」。改了之后下一轮会重写一次缓存。历史会变，要在历史里多打一个缓存点：一些低价 Claude 中转处理不好，会多算 token、缓存时有时无，用这类中转时选「每轮都留」。`,
  turn: t`全部每轮随玩家消息发送，发过的留在历史里，每轮都会让上下文变长。历史不变，只在最新一条上打缓存点，各家中转都能稳定命中。`,
}

const MARKER_LABEL = {
  chatHistory: t`聊天记录`,
  charDescription: t`角色描述`,
  charPersonality: t`角色性格`,
  scenario: t`场景`,
  personaDescription: t`你的角色设定`,
  worldInfoBefore: t`世界书（角色之前）`,
  worldInfoAfter: t`世界书（角色之后）`,
  dialogueExamples: t`对话示例`,
}
const ROLE_LABEL = { user: t`用户`, assistant: 'AI' }
const ROLE_OPTIONS = [['system', t`系统`], ['user', t`用户`], ['assistant', t`AI 助手`]]
const PLACEMENT = {
  prefix: [t`前缀`, t`写进对话开局时的固定前缀：缓存友好，改动后要对当前对话点「应用」才生效`],
  turn: [t`每轮`, t`每轮随玩家消息发送（含每轮变化的宏，如 {{lastUserMessage}}、骰子）：改动下一轮就生效。发过的会留在历史里`],
  split: [t`部分每轮`, t`含每轮变化的宏的段落随玩家消息发送，其余段落写进固定前缀`],
}

/**
 * @param deps - { api, el, toast, guard, getChat, isGenerating, onChatChanged(chatView), onPresetEdited(id), onBasicChanged(settings) }
 */
/**
 * @param deps - { …, openTalk(options) (talk-dialog.js: 对话修改 on the preset shown) }
 */
export function initPresets({ api, el, toast, guard, saveFile, getChat, isGenerating, onChatChanged, onPresetEdited, onBasicChanged, openTalk }) {
  const $ = id => document.getElementById(id)
  const state = {
    list: [],
    defaultId: '',
    selected: null, // preset id, or '' for the built-in preset
    detail: null,
    query: '',
    open: new Set(), // expanded prompt ids
    stale: new Set(), // preset ids whose prefix changed since the current chat applied them
  }

  async function open(selectId) {
    const [list, settings] = await Promise.all([api('/api/presets'), api('/api/settings')])
    state.list = list
    state.defaultId = settings.presetId || ''
    const chat = getChat()
    const wanted = selectId ?? (chat ? listId(chat) : state.defaultId)
    await select(list.some(p => p.id === wanted) ? wanted : '')
    if (!$('preset-dialog').open) $('preset-dialog').showModal()
  }

  async function select(id) {
    state.selected = id
    state.query = ''
    state.open.clear()
    state.detail = await api(`/api/presets/${id || BASIC_ID}`)
    renderNav()
    renderMain()
  }

  async function refreshList() {
    state.list = await api('/api/presets')
    renderNav()
  }

  function renderNav() {
    const chat = getChat()
    const item = (id, name, sub) => {
      const tags = []
      if (state.defaultId === id) tags.push(el('span', { class: 'tag', text: t`默认` }))
      if (chat && listId(chat) === id) tags.push(el('span', { class: 'tag', text: t`当前对话` }))
      return el('li', { class: state.selected === id ? 'active' : '', onclick: () => guard(select)(id) }, [
        el('div', { class: 'item-title' }, [el('span', { class: 'item-main', text: name }), ...tags]),
        el('div', { class: 'item-sub', text: sub }),
      ])
    }
    $('preset-list').replaceChildren(
      item('', t`基础预设`, t`应用自带，轻量，选项可调`),
      ...state.list.map(p => item(p.id, p.name, t`启用 ${p.enabled}/${p.prompts} 条${p.regexScripts ? t`　正则 ${p.regexScripts}` : ''}`)),
    )
  }

  // ─── Main column ──────────────────────────────────────────────────────
  /** Title, meta line, actions and the apply bar: everything a toggle can change above the list. */
  function headParts() {
    const chat = getChat()
    const id = state.selected
    const detail = state.detail
    const isDefault = state.defaultId === (id ?? '')
    const inChat = chat && listId(chat) === (id ?? '')
    // A chat from before the built-in preset still has the plain built-in rules in its prefix.
    const stale = inChat && (state.stale.has(id) || (detail.builtin && !chat.presetId))

    const actions = el('div', { class: 'preset-actions' }, [
      el('button', { class: 'btn small', type: 'button', disabled: isDefault, text: isDefault ? t`已是新对话默认` : t`设为新对话默认`, onclick: guard(setDefault) }),
      chat ? el('button', {
        class: `btn small${stale ? ' primary' : ''}`, type: 'button', disabled: (inChat && !stale) || isGenerating(),
        text: inChat && !stale ? t`当前对话正在用` : t`用于当前对话`, onclick: guard(applyToChat),
      }) : null,
      detail.builtin ? null : el('button', { class: 'btn small', type: 'button', text: t`对话修改`, title: t`说说想怎么改，或者问问某一条在做什么：向导把要改的条目整条写出来，勾上的才会改进预设`, onclick: () => talkAbout() }),
      detail.builtin ? null : el('button', { class: 'btn small', type: 'button', text: t`导出`, title: t`连同在这里做的修改存成文件，用来搬到另一台设备（手机版）`, onclick: guard(exportPreset) }),
      detail.builtin ? null : el('button', { class: 'btn small danger', type: 'button', text: t`删除`, onclick: guard(remove) }),
    ])
    const applyBar = stale ? el('div', { class: 'preset-apply' }, [
      el('span', { text: detail.builtin && !chat.presetId ? t`当前对话开始时还没有基础预设，用的是旧的内置规则。应用后改用基础预设，下一轮会重新写入一次缓存。` : t`当前对话的固定前缀还是改动前的版本。应用后，下一轮会重新写入一次缓存。` }),
      el('button', { class: 'btn small primary', type: 'button', disabled: isGenerating(), text: t`应用到当前对话`, onclick: guard(applyToChat) }),
    ]) : null

    if (detail.builtin) {
      return [
        el('header', { class: 'preset-head' }, [
          el('h3', { class: 'preset-title', text: t`基础预设` }),
          el('div', { class: 'preset-meta', text: t`应用自带的轻量预设：叙述规则加上下面这些选项，固定前缀里约 ${detail.rules.length.toLocaleString()} 字。改了选项对新对话生效，正在进行的对话点「应用到当前对话」。你在设置里写的文风要求照常生效。` }),
          actions,
        ]),
        applyBar,
      ]
    }

    const prefixChars = sumChars(detail, 'prefix')
    const turnChars = sumChars(detail, 'turn')
    const ignored = [
      detail.params?.temperature != null ? t`温度 ${detail.params.temperature}` : '',
      detail.params?.maxTokens ? t`最大输出 ${detail.params.maxTokens}` : '',
    ].filter(Boolean)
    const meta = [
      t`启用 ${detail.enabled}/${detail.prompts.filter(p => !p.marker).length} 条：前缀约 ${prefixChars.toLocaleString()} 字，每轮约 ${turnChars.toLocaleString()} 字`,
      detail.regexScripts ? t`${detail.regexScripts} 条正则随预设生效` : '',
      detail.helperScripts ? t`${detail.helperScripts} 个酒馆助手脚本不执行（悬浮球之类的开关面板，可以把条目点「快捷」放到输入框旁）` : '',
      ignored.length ? t`${ignored.join(t`、`)} 不使用（用模型自己的默认值；供应商的最大输出在供应商设置里填）` : '',
    ].filter(Boolean)
    return [
      el('header', { class: 'preset-head' }, [
        el('h3', { class: 'preset-title', text: detail.name }),
        el('div', { class: 'preset-meta', text: meta.join(t`。`) + t`。` }),
        actions,
      ]),
      applyBar,
    ]
  }

  /** The built-in preset's page: its options, and what they add to the prompt. */
  function renderBasic(main, head) {
    const detail = state.detail
    const pick = guard(async (key, value) => {
      const settings = await api('/api/settings', { method: 'PUT', body: { basic: { ...detail.options, [key]: value } } })
      state.detail = await api(`/api/presets/${BASIC_ID}`)
      onBasicChanged?.(settings)
      if (BASIC_FIELDS.find(f => f.key === key)?.prompt !== false) markStale()
      renderHead()
      rules.textContent = state.detail.rules
    })
    const rules = el('pre', { class: 'basic-rules', text: detail.rules })
    main.replaceChildren(...[
      head,
      el('div', { class: 'basic-options' }, BASIC_FIELDS.map(field => basicField(el, field, detail.options[field.key], { onPick: pick }))),
      el('details', { class: 'basic-preview' }, [el('summary', { text: t`这些选项加进提示词的内容` }), rules]),
      state.list.length ? null : el('p', { class: 'basic-import', text: t`想用 SillyTavern 的预设：在它的「AI 响应配置」里导出预设 JSON（或用 SillyTavern/data/default-user/OpenAI Settings 里的文件），点左上角「导入」或拖进窗口。` }),
    ].filter(Boolean))
  }

  function renderMain() {
    const main = $('preset-main')
    const detail = state.detail
    const head = el('div', { id: 'preset-headwrap' }, headParts())
    if (detail.builtin) return renderBasic(main, head)
    const search = el('input', { type: 'search', placeholder: t`搜索条目名称或内容`, value: state.query })
    search.addEventListener('input', () => { state.query = search.value.trim().toLowerCase(); filterRows() })
    const mode = el('div', { class: 'seg', role: 'group', 'aria-label': t`聊天记录之后的条目` }, [
      modeButton('prefix', t`放进前缀`),
      modeButton('latest', t`同酒馆`),
      modeButton('turn', t`每轮都留`),
    ])

    main.replaceChildren(
      head,
      el('div', { class: 'preset-tools' }, [
        search,
        el('button', { type: 'button', class: 'btn small', text: t`＋ 新增条目`, onclick: guard(addPrompt) }),
        el('span', { class: 'seg-label', text: t`聊天记录之后的条目` }),
        mode,
        el('p', { class: 'seg-note', text: POST_MODE_NOTES[detail.postMode] ?? POST_MODE_NOTES.prefix }),
      ]),
      el('ul', { class: 'prompt-list', id: 'prompt-list' }, detail.prompts.map(promptRow)),
    )
    filterRows()
  }

  function modeButton(value, label) {
    return el('button', {
      type: 'button', 'aria-pressed': String(state.detail.postMode === value), text: label,
      onclick: guard(async () => {
        if (state.detail.postMode === value) return
        await save({ postMode: value })
        markStale()
        renderMain()
      }),
    })
  }

  function sumChars(detail, placement) {
    // A split prompt counts toward the prefix: its per-turn paragraphs are usually a few lines.
    const side = p => (p.placement === 'split' ? 'prefix' : p.placement)
    return detail.prompts.filter(p => p.enabled && side(p) === placement).reduce((n, p) => n + p.content.length, 0)
  }

  /** Pin an entry to the quick-switch panel beside the chat input. */
  function pinButton(p) {
    const pinned = () => (state.detail.quick ?? []).includes(p.id)
    const button = el('button', { type: 'button', class: `pin${pinned() ? ' on' : ''}`, text: t`快捷` })
    const label = () => button.setAttribute('title', pinned() ? t`已放进输入框旁的快捷开关，点击取消` : t`放进输入框旁的快捷开关，聊天时一键开关`)
    label()
    button.addEventListener('click', guard(async () => {
      const quick = pinned() ? state.detail.quick.filter(id => id !== p.id) : [...(state.detail.quick ?? []), p.id]
      await save({ quick }, false)
      state.detail.quick = quick
      button.classList.toggle('on', pinned())
      label()
    }))
    return button
  }

  function promptRow(p) {
    // Not "history": that class is the chat's 回看历史 panel, positioned over the top-right corner.
    if (p.id === 'chatHistory') return el('li', { class: 'prow marker chatlog', 'data-id': p.id, text: t`聊天记录` })
    let row = null
    const toggle = el('input', { type: 'checkbox', class: 'switch', checked: p.enabled, 'aria-label': t`启用「${p.name}」` })
    toggle.addEventListener('change', guard(async () => {
      const enabled = toggle.checked
      row.classList.toggle('off', !enabled)
      try {
        await save({ prompts: [{ id: p.id, enabled }] }, false)
        p.enabled = enabled
        if (p.placement !== 'turn') markStale()
        renderHead()
      } catch (error) {
        toggle.checked = !enabled
        row.classList.toggle('off', enabled)
        throw error
      }
    }))
    if (p.marker) {
      row = el('li', { class: `prow${p.enabled ? '' : ' off'}`, 'data-id': p.id }, [
        el('div', { class: 'prow-line' }, [
          toggle,
          el('span', { class: 'prow-name', text: MARKER_LABEL[p.id] ?? p.name }),
          el('span', { class: 'badge role', text: t`角色卡数据` }),
        ]),
      ])
      return row
    }
    const [label, tip] = PLACEMENT[p.placement] ?? PLACEMENT.prefix
    const name = el('button', { type: 'button', class: 'prow-name', text: p.name, title: t`展开编辑`, 'aria-expanded': String(state.open.has(p.id)) })
    const pencil = el('button', { type: 'button', class: 'prow-edit', title: t`编辑名称、角色、位置和内容`, 'aria-label': t`编辑「${p.name}」`, text: '✎' })
    const more = el('div', { class: 'prow-more' }, el('div'))
    row = el('li', { class: `prow${p.enabled ? '' : ' off'}${state.open.has(p.id) ? ' open' : ''}`, 'data-id': p.id }, [
      el('div', { class: 'prow-line' }, [
        toggle,
        name,
        ROLE_LABEL[p.role] ? el('span', { class: 'badge role', text: ROLE_LABEL[p.role] }) : null,
        p.absolute ? el('span', { class: 'badge role', title: t`聊天中，按深度排序`, text: `@${p.depth}` }) : null,
        el('span', { class: `badge place ${p.placement}`, title: tip, text: label }),
        el('span', { class: 'prow-size', text: t`${p.content.length.toLocaleString()} 字` }),
        pinButton(p),
        pencil,
      ]),
      more,
    ])
    if (state.open.has(p.id)) fillEditor(more, p)
    const expand = () => {
      const opening = !row.classList.contains('open')
      if (opening) {
        fillEditor(more, p)
        state.open.add(p.id)
        // Next frame, so the grid-row transition runs from 0fr.
        requestAnimationFrame(() => row.classList.add('open'))
      } else {
        state.open.delete(p.id)
        row.classList.remove('open')
      }
      name.setAttribute('aria-expanded', String(opening))
    }
    name.addEventListener('click', expand)
    pencil.addEventListener('click', expand)
    return row
  }

  /** SillyTavern's prompt editor: name, role, position (relative / in-chat at a depth), content, order. */
  function fillEditor(more, p) {
    const holder = more.firstChild
    if (holder.firstChild) return
    const title = el('input', { value: p.name, maxlength: '80', 'aria-label': t`名称` })
    const role = el('select', { 'aria-label': t`角色` }, ROLE_OPTIONS.map(([value, text]) => el('option', { value, text, selected: p.role === value })))
    const position = el('select', { 'aria-label': t`位置` }, [
      el('option', { value: 'relative', text: t`相对`, selected: !p.absolute }),
      el('option', { value: 'absolute', text: t`聊天中 @深度`, selected: p.absolute }),
    ])
    const depth = el('input', { type: 'number', min: '0', max: '999', step: '1', value: String(p.depth), 'aria-label': t`深度` })
    const depthField = editorField(t`深度`, depth)
    depthField.hidden = !p.absolute
    const area = el('textarea', { spellcheck: 'false' })
    area.value = p.content

    title.addEventListener('change', guard(async () => {
      if (!title.value.trim() || title.value.trim() === p.name) {
        title.value = p.name
        return
      }
      await restructure({ prompts: [{ id: p.id, title: title.value }] })
    }))
    role.addEventListener('change', guard(() => restructure({ prompts: [{ id: p.id, role: role.value }] })))
    position.addEventListener('change', guard(() => restructure({ prompts: [{ id: p.id, absolute: position.value === 'absolute' }] })))
    depth.addEventListener('change', guard(() => restructure({ prompts: [{ id: p.id, depth: Number(depth.value) }] })))
    area.addEventListener('change', guard(async () => {
      if (area.value === p.content) return
      await save({ prompts: [{ id: p.id, content: area.value }] }, false)
      p.content = area.value
      if (p.placement !== 'turn') markStale()
      const size = more.parentElement.querySelector('.prow-size')
      if (size) size.textContent = t`${p.content.length.toLocaleString()} 字`
      renderHead()
      toast(t`已保存这条内容`)
    }))

    const index = state.detail.prompts.findIndex(x => x.id === p.id)
    holder.append(
      el('div', { class: 'prompt-editor' }, [
        el('div', { class: 'prompt-fields' }, [
          editorField(t`名称`, title),
          editorField(t`角色`, role),
          editorField(t`位置`, position),
          depthField,
        ]),
        el('p', { class: 'prompt-note', text: t`发给模型的是合并后的文本：角色只是标记（对照 SillyTavern 用），不会拆成单独的用户 / AI 消息。「聊天中」的条目排进聊天记录之后的规则，深度大的在前；聊天记录之前的条目，位置和深度不起作用。` }),
        area,
        el('div', { class: 'prompt-actions' }, [
          el('button', { type: 'button', class: 'btn small ghost', text: t`↑ 上移`, disabled: index <= 0, onclick: guard(() => move(p.id, -1)) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`↓ 下移`, disabled: index >= state.detail.prompts.length - 1, onclick: guard(() => move(p.id, 1)) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`按意见改`, title: t`在「对话修改」里说说这一条想怎么改，或者问它在做什么`, onclick: () => talkAbout({ id: `prompt:${p.id}`, label: p.name }) }),
          el('button', { type: 'button', class: 'btn small danger', text: t`删除条目`, onclick: guard(() => removePrompt(p)) }),
        ]),
      ]),
    )
  }

  function editorField(label, control) {
    return el('label', { class: 'prompt-field' }, [el('span', { text: label }), control])
  }

  /** Save a change that moves badges or rows, then redraw the list where it was. */
  async function restructure(patch) {
    const scroll = $('prompt-list')?.scrollTop ?? 0
    await save(patch)
    markStale()
    renderMain()
    const list = $('prompt-list')
    if (list) list.scrollTop = scroll
  }

  async function addPrompt() {
    const before = new Set(state.detail.prompts.map(p => p.id))
    await restructure({ add: { name: t`新条目`, role: 'system', content: '' } })
    const added = state.detail.prompts.find(p => !before.has(p.id))
    if (!added) return
    state.open.add(added.id)
    renderMain()
    const row = document.querySelector(`#prompt-list .prow[data-id="${CSS.escape(added.id)}"]`)
    row?.classList.add('open')
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('.prompt-field input')?.select()
  }

  async function move(id, step) {
    const order = state.detail.prompts.map(p => p.id)
    const from = order.indexOf(id)
    const to = from + step
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, order.splice(from, 1)[0])
    await restructure({ order })
  }

  async function removePrompt(p) {
    if (!confirm(t`删除条目「${p.name}」？`)) return
    state.open.delete(p.id)
    await restructure({ remove: [p.id] })
    toast(t`已删除「${p.name}」`)
  }

  function filterRows() {
    const q = state.query
    for (const row of document.querySelectorAll('#prompt-list .prow')) {
      const p = state.detail.prompts.find(x => x.id === row.dataset.id)
      const text = `${p?.name ?? ''}\n${p?.content ?? ''}`.toLowerCase()
      row.hidden = Boolean(q) && (p?.marker || !text.includes(q))
    }
  }

  /** Refresh the header and apply bar only, so the list keeps its scroll, open rows and switch animations. */
  function renderHead() {
    $('preset-headwrap')?.replaceChildren(...headParts().filter(Boolean))
  }

  async function save(patch, rerender = true) {
    const detail = await api(`/api/presets/${state.selected}`, { method: 'PUT', body: patch })
    if (rerender) state.detail = detail
    else {
      state.detail.enabled = detail.enabled
      state.detail.postMode = detail.postMode
      syncPlacements(detail)
    }
    onPresetEdited?.(state.selected)
    await refreshList()
  }

  /** A toggle can move later prompts between 前缀 and 每轮; update their badges in place. */
  function syncPlacements(detail) {
    let moved = false
    for (const fresh of detail.prompts) {
      const local = state.detail.prompts.find(p => p.id === fresh.id)
      if (!local || local.placement === fresh.placement) continue
      local.placement = fresh.placement
      moved = true
      const badge = document.querySelector(`#prompt-list .prow[data-id="${CSS.escape(fresh.id)}"] .badge.place`)
      if (!badge) continue
      const [label, tip] = PLACEMENT[fresh.placement] ?? PLACEMENT.prefix
      badge.className = `badge place ${fresh.placement}`
      badge.textContent = label
      badge.title = tip
      badge.animate?.([{ opacity: 0.2 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' })
    }
    // Moving a prompt in or out of the prefix changes the prefix.
    if (moved) markStale()
  }

  function markStale() {
    const chat = getChat()
    if (chat && listId(chat) === state.selected) state.stale.add(state.selected)
  }

  // ─── 对话修改 (talk-dialog.js) ─────────────────────────────────────────
  /** The talk on the preset shown; `aim` keeps the first request to one prompt. */
  function talkAbout(aim = null) {
    const id = state.selected
    const nameOf = pid => MARKER_LABEL[pid] ?? state.detail?.prompts.find(p => p.id === pid)?.name ?? pid
    const where = place => {
      const [label, tip] = PLACEMENT[place] ?? PLACEMENT.prefix
      return [label, place === 'prefix' ? 'on' : 'key', tip]
    }
    openTalk?.({
      url: `/api/talk/preset/${id}`,
      title: t`对话修改预设`,
      name: state.detail.name,
      aim,
      intro: () => t`说说想怎么改这个预设，或者问问某一条在做什么：向导把要改的条目整条写出来，改前改后对照着给你看，勾上的才会改进预设。`,
      ideas: () => [t`这个预设大概在做什么？`, t`文风改得口语一些`, t`加一条：每轮回复不超过 600 字`],
      placeholder: target => (target ? t`「${target.label}」想怎么改，或者问它在做什么` : t`说说想怎么改，比如：结尾别再写总结`),
      busy: job => (job.step === 'pick' ? t`预设比较长，先看条目列表挑要读的…` : job.chars ? t`正在写，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在读这个预设…`),
      changeTitle: change => {
        if (change.kind === 'newPrompt') return t`新条目 · ${change.name}`
        if (change.kind === 'removePrompt') return t`删除条目 · ${change.title}`
        return change.marker ? nameOf(change.pid) : change.title
      },
      changeWhere: change => {
        if (change.kind === 'newPrompt' || change.marker) return ['', '', '']
        if (change.enabled === false) return [t`停用`, 'off', t`不再发给模型`]
        return where(change.place)
      },
      changeNotes: change => {
        const notes = []
        if (change.name) notes.push(t`名称：${change.title} → ${change.name}`)
        if (change.role) notes.push(t`角色：${ROLE_LABEL[change.role] ?? t`系统`}`)
        if (change.enabled !== undefined) notes.push(change.enabled ? t`改为启用` : t`改为停用`)
        if (change.kind === 'newPrompt') {
          notes.push(change.afterId ? t`放在「${nameOf(change.afterId)}」后面` : t`放在聊天记录之前`)
          if (change.role !== 'system') notes.push(t`角色：${ROLE_LABEL[change.role]}`)
        }
        return notes
      },
      targetLabel: target => nameOf(target.slice(7)),
      onApplied: result => talked(id, result, t`已改进预设：${result.applied} 处`),
      onUndone: result => talked(id, result, t`已撤销这次修改`),
    })
  }

  /** What the talk applied or undid: the preset drawn again, the apply bar if a chat uses it. */
  async function talked(id, result, said) {
    if (state.selected === id) state.detail = result.preset
    if (result.prefix) markStale()
    onPresetEdited?.(id)
    await refreshList()
    if (state.selected === id) renderMain()
    const chat = getChat()
    const behind = result.prefix && chat && listId(chat) === id
    toast(behind ? [said, t`当前对话的固定前缀还是改动前的版本，要「应用到当前对话」才会跟着变。`].join(t`。`) : said, behind ? 6000 : 3000)
  }

  async function setDefault() {
    await api('/api/settings', { method: 'PUT', body: { presetId: state.selected || '' } })
    state.defaultId = state.selected || ''
    renderNav()
    renderMain()
    toast(state.selected ? t`新对话默认使用「${state.detail.name}」` : t`新对话默认使用基础预设`)
  }

  async function applyToChat() {
    const chat = getChat()
    if (!chat) return
    const view = await api(`/api/chats/${chat.id}/preset`, { method: 'POST', body: { presetId: state.selected || BASIC_ID } })
    state.stale.delete(state.selected)
    onChatChanged(view)
    renderNav()
    renderMain()
    toast(t`这个对话改用「${view.presetId === BASIC_ID ? t`基础预设` : view.presetName}」。下一轮会重新写入一次缓存。`)
  }

  async function exportPreset() {
    const archive = await api(`/api/presets/${state.selected}/export`)
    saveFile(t`预设-${archive.preset.name}.json`, JSON.stringify(archive), t`预设已导出：在另一台设备的「预设」里点「导入」选这个文件`)
  }

  async function remove() {
    if (!confirm(t`删除预设「${state.detail.name}」？用它的对话会改用基础预设（下次应用时）。`)) return
    await api(`/api/presets/${state.selected}`, { method: 'DELETE' })
    onPresetEdited?.(state.selected)
    const [list, settings] = await Promise.all([api('/api/presets'), api('/api/settings')])
    state.list = list
    state.defaultId = settings.presetId || ''
    await select('')
  }

  $('preset-import').addEventListener('change', guard(async event => {
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
      last = await api('/api/presets/import', { method: 'POST', body: { filename: file.name, data } })
    }
    if (!last) return
    await refreshList()
    await select(last.id)
    toast(t`已导入预设「${last.name}」`)
  }))

  return { open: guard(open) }
}
