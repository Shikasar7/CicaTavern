// 检查这张卡 (the card list's ⋯, 修改角色卡): what is wrong with a saved card and what could be better, in one list.
// The program's findings show as soon as the window opens and cost nothing (server/forge/check.mjs); the model is asked
// only by the button here, after it says which model and about how much (check-model.mjs). Each finding shows as before
// and after, and can be taken in as it is, written over first, or ignored; what was taken in can be taken back, one by
// one or all that went in together. Only safe fixes come ticked for 一键采用.
import { t } from '/i18n.js'
import { SHOWS, STATUS_THEMES, cleanStatusSpec, statusPages } from '/shared/status.js'
import { statusBar } from '/status.js'
import { diffView } from '/talk.js'

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const MANAGE_PROVIDERS = '__manage__'
// 按卡配色 in the theme list: not a theme, three colors of the card's own.
const OWN_COLORS = 'auto'
const FIRST_COLORS = { bg: '#f7f8f5', ink: '#1c2427', accent: '#2b5869' }
// A long look is left out of the editing box: the page would hang on it, and a model never wrote it.
const MAX_EDIT = 20000
const FOLD_OVER = 6

const LEVELS = [['error', t`会出错`, t`这些地方现在不起作用。`], ['warn', t`可能有问题`, t`能用，但多半不是作者想要的效果。`], ['tip', t`可以更好`, t`不改也能玩。`]]
const FOCUS = [['rules', t`玩法和变量`, t`规则打架、变量没写清、和开场白对不上`], ['tokens', t`省上下文`, t`常驻改关键词、重复条目、太宽的关键词`], ['look', t`美化`, t`状态栏显示什么、用什么主题`], ['style', t`文笔`, t`套话和前后矛盾。默认不查，别人的写法不去挑`]]
const SHOW_TEXT = { meter: t`进度条`, number: t`数字`, rating: t`星级`, text: t`文字`, long: t`长文字`, badge: t`徽章`, tags: t`标签`, list: t`列表`, stats: t`数值表`, table: t`表格`, flag: t`是或否`, hidden: t`不显示` }
const THEME_TEXT = { plain: t`朴素`, paper: t`纸张`, neon: t`霓虹`, pastel: t`柔和`, ink: t`水墨`, parchment: t`羊皮卷`, gothic: t`暗夜`, terminal: t`终端`, ocean: t`深海`, [OWN_COLORS]: t`按卡配色` }
const BRICK_TEXT = { books: t`册子`, selfcheck: t`写前自查`, events: t`随机事件`, judge: t`裁判表`, world: t`世界动态`, creation: t`建角页` }
// Findings about an entry's keywords: their box is the keywords, not its text.
const KEY_RULES = new Set(['key-joined', 'key-invalid', 'key-single', 'entry-unreachable'])

const count = n => n.toLocaleString()

/** @param deps - { api, el, toast, guard, getChat, isGenerating, openProviders, onChatChanged(chat), onCardChanged(cardId) } */
export function initCardCheck({ api, el, toast, guard, getChat, isGenerating, openProviders, onChatChanged, onCardChanged }) {
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
  function render() {
    const top = view.main.scrollTop
    const { findings, records, ignored } = state.data
    view.jobLine = null
    view.main.replaceChildren(
      el('div', { class: 'cc-page' }, [
        prefixBar(),
        summary(),
        ...LEVELS.map(([level, title, note]) => group(level, title, note, findings.filter(item => item.from === 'program' && item.level === level))),
        modelSection(findings.filter(item => item.from === 'model')),
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
      facts.helperScripts ? t`这张卡带了 ${facts.helperScripts} 个酒馆助手脚本，这里不运行，自检也读不到、改不了。` : '',
      facts.schema ? t`变量由卡里的脚本规定，是否能加新项不用查。` : '',
      facts.attachedBooks ? t`另外挂了 ${facts.attachedBooks} 本独立世界书，这里只查卡自带的。` : '',
      facts.remote.length ? t`美化要联网加载：${facts.remote.slice(0, 3).join(t`、`)}${facts.remote.length > 3 ? t` 等 ${facts.remote.length} 处` : ''}。` : '',
      state.fromForge ? t`这张卡是「创作角色卡」做的：在那边再点「更新这张卡」，会换回草稿里的内容，这里的修改不保留。` : '',
    ].filter(Boolean)
    return el('section', { class: 'cc-summary' }, [
      el('h3', { text: verdict(findings) }),
      el('p', { class: 'cc-facts', text: line }),
      ...notes.map(text => el('p', { class: 'hint', text })),
    ])
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
    if (change.kind === 'newEntry') notes.push(change.constant ? t`常驻：写进对话开局时的固定前缀` : t`关键词触发`)
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
      ...warnings.map(text => el('p', { class: 'ce-outcome warn', text })),
      ...(editing ? editBlocks(item) : item.manual ? [] : item.changes.map(changeBlock)),
      itemActions(item, canTake, editing),
    ])
  }

  function itemActions(item, canTake, editing) {
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
      ...(change.kind === 'statusBar' ? statusEditor(change, edit(change)) : change.kind === 'regex' || change.kind === 'newRegex' ? regexEditor(change, edit(change)) : textEditor(item, change, edit(change))),
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

  /** The bar's settings, the fields a row each: what it shows, how and on which page. It never turns into HTML to write by hand. */
  function statusEditor(change, edit) {
    edit.spec ??= structuredClone(change.spec)
    edit.paged ??= statusPages(edit.spec).length > 0
    const { spec } = edit
    const redraw = () => render()
    const preview = el('div', { class: 'status-preview cc-status-preview' })
    const drawPreview = () => {
      const shown = cleanStatusSpec(spec)
      preview.replaceChildren((shown && statusBar(el, shown, state.data.state, { collapsible: false, note: t`预览 · 初始值` })) || el('p', { class: 'hint', text: t`还没有要显示的项。` }))
    }
    const pickLook = name => {
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
    const look = spec.palette ? OWN_COLORS : spec.theme ?? 'plain'
    const theme = el('select', { 'aria-label': t`主题`, onchange: () => pickLook(theme.value) }, [...STATUS_THEMES, OWN_COLORS].map(name => el('option', { value: name, selected: look === name, text: THEME_TEXT[name] ?? name })))
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
    drawPreview()
    return [preview, el('div', { class: 'cc-status-top' }, [title, theme]), spec.palette ? colors() : null, paging, el('div', { class: 'cc-status-rows' }, spec.fields.map(row))]
  }

  // ─── The model ────────────────────────────────────────────────────────
  function modelChoice() {
    const { model } = state.data
    const known = state.models.find(item => item.id === state.defaultModel)
    const label = item => `${item.group} · ${item.label}`
    const select = el('select', { class: 'forge-model', title: t`让哪个模型看`, disabled: Boolean(state.data.job), onchange: guard(async () => {
      if (select.value === MANAGE_PROVIDERS) {
        select.value = model
        openProviders?.()
        return
      }
      load(await api(url(), { method: 'PUT', body: { model: select.value } }))
    }) }, [
      el('option', { value: '', selected: !model, text: known ? t`默认模型（${label(known)}）` : t`默认模型（还没选）` }),
      ...state.models.map(item => el('option', { value: item.id, selected: item.id === model, text: label(item) })),
      el('option', { value: MANAGE_PROVIDERS, text: t`管理模型供应商…` }),
    ])
    return select
  }

  function estimateLine({ estimate }) {
    if (!estimate.ready) return t`先在「模型供应商」里添加供应商，再选一个模型。`
    const money = estimate.cost == null ? '' : t`，大约 $${estimate.cost.toFixed(3)}`
    const whole = estimate.shown < estimate.entries ? t`世界书只附上 ${estimate.shown} 条全文，其余 ${estimate.entries - estimate.shown} 条给目录。` : ''
    return t`点了才发送。发给 ${estimate.model}：卡的内容约 ${count(estimate.chars)} 字，一共大约 ${count(estimate.input + estimate.output)} token${money}。${whole}`
  }

  function modelSection(items) {
    const data = state.data
    const job = data.job
    const boxes = FOCUS.map(([key, label, note]) => el('label', { class: 'check-row cc-focus', title: note }, [
      el('input', { type: 'checkbox', checked: data.focus.includes(key), disabled: Boolean(job), onchange: guard(async event => {
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
      el('p', { class: 'cc-estimate', text: estimateLine(data) }),
      job
        ? el('div', { class: 'cc-running' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), (view.jobLine = el('span', { text: jobText(job) }))]), el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: () => stop() })])
        : el('div', { class: 'cc-send' }, [modelChoice(), el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn primary small', disabled: !data.estimate.ready, text: data.askedAt ? t`再看一次` : t`发给模型看看`, onclick: () => ask() })]),
      data.error ? el('div', { class: 'forge-error' }, [el('p', { text: data.error.message })]) : null,
      data.reply ? el('div', { class: 'forge-voice cc-reply' }, data.reply.split(/\n+/).filter(Boolean).map(text => el('p', { text }))) : null,
      data.askedModel ? el('div', { class: 'forge-by', text: data.askedModel }) : null,
      items.length ? el('div', { class: 'cc-items' }, items.map(item => itemBlock(item))) : null,
    ])
  }

  function jobText(job) {
    if (job.chars) return t`模型正在写，已经写了 ${count(job.chars)} 字…`
    return t`模型正在读这张卡，已经 ${Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)} 秒。可能要几分钟，关掉窗口也会接着看。`
  }

  function fillJob() {
    if (state.data.job && view.jobLine?.isConnected) view.jobLine.textContent = jobText(state.data.job)
  }

  const ask = guard(async () => {
    if (state.data.findings.some(item => item.from === 'model') && !confirm(t`再看一次会换掉还没采用的模型建议，继续？`)) return
    load(await api(url('/ask'), { method: 'POST', body: { focus: state.data.focus } }))
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

  const take = guard(async items => {
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
    await afterChange(result, t`已改进卡里：${result.applied} 处`)
  })

  const takeTicked = () => take([...state.ticked].map(id => ({ id, ...(state.editing.has(id) ? { edits: state.editing.get(id) } : {}) })))

  /** What every change to the card is followed by: the list again, and the prefix of a chat on it. */
  async function afterChange(result, message) {
    load(result.check)
    if (result.prefix) {
      if (getChat()?.cardId === state.cardId) {
        state.stale = true
        render()
      } else toast(t`${message}。改的内容在对话开局时的固定前缀里：新对话直接用新的，进行中的对话要在「设置 → 更多」里重建前缀才会用上。`, 7000)
    } else toast(message)
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

  dialog.addEventListener('close', () => clearTimeout(state.poll))

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
        view.main.scrollTop = 0
      }
      const [data, edit] = await Promise.all([api(url()), api(`/api/cards/${cardId}/edit`), loadModels()])
      state.fromForge = edit.fromForge === true
      if (!dialog.open) dialog.showModal()
      load(data)
    }),
  }
}
