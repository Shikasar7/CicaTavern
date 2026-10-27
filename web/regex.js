// 正则 (设置 → 写作 → 正则, and the importer): the regex scripts a chat runs —
// the global ones (every chat), then its preset's, then its card's own, then
// the 正则集 (regex sets) attached to its card — laid out as the 世界书 window
// is: the places on the left, one place's scripts on the right, each with its
// switch and an editor with a test box, or many at once (启用、停用、复制、移动、
// 导出、删除). A set is a named list of the player's own scripts, ticked for the
// cards it is for. Scripts come in SillyTavern's shape (web/shared/regex.js),
// and go out as SillyTavern's regex files. Saving one that changes what is sent
// tells the player the next turn writes the cache once more; display-only
// scripts never touch it.
import { t } from '/i18n.js'
import { applyScripts, effectFlags, effectOf, PLACEMENT, regexFromString, scriptsInFile, stScripts } from '/shared/regex.js'
import { HTML_LIKE } from '/render.js'
import { matchesTerms, searchTerms } from '/books.js'

const EFFECT_LABEL = { both: t`显示和发送都改`, display: t`只改显示`, prompt: t`只改发给模型的` }
// A reply to try a script on when the chat has none yet.
const SAMPLE = t`她把伞收起来，抖了抖水。「进来坐吧。」` + '\n<state>{"好感": 12}</state>' // i18n-ignore: a variable block as cards write it

/** Whether the script changes what the model reads again (so the cache is written once more). */
const touchesPrompt = script => Boolean(script) && effectOf(script) !== 'display' && (script.placement.includes(PLACEMENT.AI_OUTPUT) || script.placement.includes(PLACEMENT.USER_INPUT))
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
const titleOf = script => script.scriptName || script.findRegex
// What a place's search looks through.
const scriptText = s => `${s.scriptName}\n${s.findRegex}\n${s.replaceString}`

const ON_LABEL = { ai: t`AI 回复`, user: t`用户输入`, both: t`AI 回复和用户输入`, none: t`不作用` }

/**
 * @param context - async () → { card: { id, name, scripts } | null, preset: { id, name, builtin, scripts } | null, sample, macros, names }
 * @param getCards - the card list (each { id, name, group, archived }), for the cards a set is for.
 * @param onChanged - ({ global?, sets?, card?: { id, scripts }, preset?: { id, scripts } }) after scripts were saved.
 * @param openTalk - talk-dialog.js: 对话修改 on a place's scripts.
 */
export function initRegex({ api, el, toast, guard, saveFile, context, getCards, onChanged, openTalk }) {
  const $ = id => document.getElementById(id)
  const dialog = $('regex-dialog')
  const state = {
    global: [],
    sets: [], // [{ id, name, description, cardIds, scripts }], in the order they run
    card: null, // the open chat's card (or the chosen one) and its own scripts
    preset: null,
    selected: 'global', // the place shown: global, preset, card or set-<id>
    open: new Set(), // ids of the scripts whose editors are open
    draft: null, // a new script not added yet, in the place shown
    query: '',
    panels: new Set(), // open sections above a set's scripts: 'settings', 'cards'
    picking: false, // 多选
    picked: new Set(),
    target: null, // where 复制 / 移动 last went ('' a new set), kept while ticking more
    sample: '',
    macros: text => text,
    names: null,
  }
  // The rows of the place shown, by script id: drawn again in place, so an editor keeps what is being typed.
  const rows = new Map()

  /** Every place, in the order a chat runs them; each { key, kind, name, scripts, editable, set? }. */
  function places() {
    return [
      { key: 'global', kind: 'global', name: t`全局`, scripts: state.global, editable: true },
      // The built-in preset's name is its Chinese data name: shown in the page's language.
      ...(state.preset ? [{ key: 'preset', kind: 'preset', name: state.preset.builtin ? t`基础预设` : state.preset.name, scripts: state.preset.scripts, editable: !state.preset.builtin }] : []),
      ...(state.card ? [{ key: 'card', kind: 'card', name: state.card.name, scripts: state.card.scripts, editable: true }] : []),
      ...state.sets.map(set => ({ key: `set-${set.id}`, kind: 'set', name: set.name, scripts: set.scripts, editable: true, set })),
    ]
  }
  const placeOf = key => places().find(p => p.key === key)
  const shown = () => placeOf(state.selected) ?? placeOf('global')
  /** The place as the server and 对话修改 name it. */
  const serverKey = place => (place.kind === 'card' ? `card-${state.card.id}` : place.kind === 'preset' ? `preset-${state.preset.id}` : place.key)
  const placeOfServer = key => places().find(p => serverKey(p) === key)
  const urlOf = place => ({ global: '/api/regex', set: `/api/regex/sets/${place.set?.id}`, card: `/api/cards/${state.card?.id}/regex`, preset: `/api/presets/${state.preset?.id}/regex` })[place.kind]
  const usedBy = set => getCards().filter(c => set.cardIds.includes(c.id))
  /** Whether any chat runs the place: a set only once a card has it. */
  const live = place => place.kind !== 'set' || usedBy(place.set).length > 0
  /** "全局" / "预设「…」" / "角色卡「…」" / "正则集「…」": where scripts went, in sentences. */
  function label(place) {
    if (place.kind === 'global') return t`全局`
    if (place.kind === 'preset') return t`预设「${place.name}」`
    if (place.kind === 'card') return t`角色卡「${place.name}」`
    return t`正则集「${place.name}」`
  }

  /** A place's scripts as saved: kept here, and the page draws with them. */
  function take(place, scripts) {
    if (place.kind === 'global') {
      state.global = scripts
      onChanged({ global: scripts })
    } else if (place.kind === 'set') {
      place.set.scripts = scripts
      onChanged({ sets: state.sets })
    } else {
      state[place.kind].scripts = scripts
      onChanged({ [place.kind]: { id: state[place.kind].id, scripts } })
    }
  }

  /** What a save says: whether the next turn writes the cache again, or nothing runs it yet. */
  function savedNote(place, changed, said = t`已保存`) {
    if (!live(place)) return [said, t`这个正则集还没挂到卡上，暂时不生效。`].join(t`。`)
    return changed.some(touchesPrompt) ? [said, t`会改发给模型的内容，下一轮会重新写入一次缓存。`].join(t`。`) : t`${said}，只影响显示，不影响缓存。`
  }

  /** A place's whole list saved (`changed`: the scripts before and after, for what it says). */
  async function save(place, scripts, changed = [], said) {
    const saved = (await api(urlOf(place), { method: 'PUT', body: { scripts } })).scripts
    take(place, saved)
    renderNav()
    toast(savedNote(place, changed, said), changed.some(touchesPrompt) ? 6000 : 3000)
    return saved
  }

  /** The sets and the global scripts as the server has them now (after a set was made, copied or deleted). */
  async function reload() {
    const { scripts, sets } = await api('/api/regex')
    state.global = scripts
    state.sets = sets
    onChanged({ global: scripts, sets })
  }

  // ─── The places ───────────────────────────────────────────────────────
  function summary(scripts) {
    const on = scripts.filter(s => !s.disabled).length
    return scripts.length ? t`${scripts.length} 条（启用 ${on}）` : t`没有`
  }

  function navTag(place) {
    if (place.kind === 'global') return [t`所有对话`, '']
    if (place.kind === 'preset') return [t`预设自带`, '']
    if (place.kind === 'card') return [t`卡里自带`, '']
    const users = usedBy(place.set)
    if (state.card && users.some(c => c.id === state.card.id)) return [t`挂在这张卡上`, '']
    return users.length ? [t`${users.length} 张卡在用`, 'off'] : [t`没挂到卡上`, 'off']
  }

  function renderNav() {
    const item = place => {
      const [tag, cls] = navTag(place)
      return el('li', { class: state.selected === place.key ? 'active' : '', onclick: () => select(place.key) }, [
        el('div', { class: 'item-title' }, [el('span', { class: 'item-main', text: place.name }), tag ? el('span', { class: `tag${cls ? ` ${cls}` : ''}`, text: tag }) : null]),
        el('div', { class: 'item-sub', text: summary(place.scripts) }),
      ])
    }
    const all = places()
    const fixed = all.filter(p => p.kind !== 'set')
    const sets = all.filter(p => p.kind === 'set')
    $('regex-list').replaceChildren(
      el('ul', { class: 'preset-list' }, fixed.map(item)),
      el('h3', { class: 'regex-group-title' }, [t`正则集`, el('span', { text: t`挂到哪些卡，就只对那几张卡生效` })]),
      sets.length
        ? el('ul', { class: 'preset-list' }, sets.map(item))
        : el('p', { class: 'regex-empty', text: t`还没有。点「新建」建一个，或者在一组正则里多选后「复制」到新的正则集。` }),
    )
  }

  function select(key) {
    if (key !== state.selected) {
      state.selected = key
      state.open.clear()
      state.draft = null
      state.query = ''
      state.picking = false
      state.picked.clear()
      rows.clear()
    }
    renderNav()
    renderMain()
  }

  // ─── One place ────────────────────────────────────────────────────────
  /** Where the place runs, and in what order. */
  function whereText(place) {
    if (place.kind === 'global') return t`所有对话都用，最先运行。`
    if (place.kind === 'preset') return state.preset.builtin ? t`基础预设自带的正则：旧回复里的行动选项不再发给模型。不能改，也不能关。` : t`用这个预设的对话都用，在全局之后运行。`
    if (place.kind === 'card') return t`这张卡的每个对话都用，在全局和预设之后运行。重新导入这张卡来更新时，会换成文件里的版本，这里的修改不保留。`
    const users = usedBy(place.set)
    if (!users.length) return t`还没挂到卡上，不生效：在下面「用到它的卡」里勾上，就只对那几张卡生效。`
    return t`挂在 ${users.length} 张卡上，只对这些卡的对话生效，在卡里自带的正则之后运行。`
  }

  function headParts(place) {
    const n = place.scripts.length
    const actions = [
      place.editable ? el('button', { class: 'btn small', type: 'button', text: t`对话修改`, title: t`说说想让回复怎么变，向导写好正则，先拿最新回复试一遍`, onclick: () => talkAbout(place) }) : null,
      n ? el('button', { class: 'btn small', type: 'button', text: t`导出`, title: t`存成 SillyTavern 的正则文件：可以在 SillyTavern 的「正则」里导入，也可以导入另一台设备的 CicaTavern`, onclick: () => exportScripts(place, place.scripts, true) }) : null,
      place.kind === 'set'
        ? el('button', { class: 'btn small', type: 'button', text: t`复制一份`, title: t`复制出一个一样的正则集，改它不影响原来这个；新的先不挂到卡上`, onclick: guard(copySet) })
        : n ? el('button', { class: 'btn small', type: 'button', text: t`复制为正则集`, title: t`把这些正则复制成一个新的正则集，可以挂到别的卡上；这里的照旧`, onclick: guard(() => copyAsSet(place)) }) : null,
      place.kind === 'set' ? el('button', { class: 'btn small danger', type: 'button', text: t`删除`, onclick: guard(removeSet) }) : null,
    ].filter(Boolean)
    return el('header', { class: 'preset-head' }, [
      el('h3', { class: 'preset-title', text: { global: t`全局正则`, preset: t`预设「${place.name}」自带的正则`, card: t`「${place.name}」卡里自带的正则`, set: place.name }[place.kind] }),
      el('div', { class: 'preset-meta', text: [n ? summary(place.scripts) : t`还没有正则`, whereText(place)].join(t`。`) }),
      actions.length ? el('div', { class: 'preset-actions' }, actions) : null,
    ])
  }

  function renderMain() {
    const place = shown()
    const search = el('input', { type: 'search', placeholder: t`搜索名称、查找或替换的内容`, value: state.query, 'aria-label': t`搜索正则` })
    search.addEventListener('input', () => { state.query = search.value.trim(); filterRows() })
    const empty = !place.scripts.length && !state.draft
    $('regex-main').replaceChildren(...[
      el('div', { id: 'regex-headwrap' }, [headParts(place)]),
      place.kind === 'set' ? el('div', { class: 'book-panels' }, [settingsPanel(place.set), cardsPanel(place.set)]) : null,
      el('div', { class: 'preset-tools' }, [
        place.scripts.length ? search : el('span', { class: 'regex-tools-gap' }),
        place.scripts.length ? el('button', { type: 'button', class: `btn small${state.picking ? ' primary' : ''}`, text: state.picking ? t`完成` : t`多选`, title: t`勾选几条，一起启用、停用、复制、移动、导出或删除`, onclick: togglePicking }) : null,
        place.editable ? el('button', { type: 'button', class: 'btn small', text: t`＋ 新建正则`, onclick: addDraft }) : null,
      ]),
      state.picking ? bulkBar(place) : null,
      empty
        ? el('div', { class: 'preset-empty' }, place.editable ? [
            el('p', { text: t`正则在显示或发送前改写文字：藏起变量块、换掉格式、删掉不想发给模型的部分。` }),
            el('p', { class: 'small', text: place.kind === 'global' ? t`点「＋ 新建正则」写一条，或者左上角「导入」SillyTavern 导出的正则。` : t`点「＋ 新建正则」写一条，「导入」的正则会放进这里，也可以从别的地方多选后复制过来。` }),
            el('button', { type: 'button', class: 'btn small primary', text: t`用对话来写`, onclick: () => talkAbout(place) }),
          ] : [el('p', { text: t`没有正则。` })])
        : el('ul', { class: `prompt-list book-entries regex-scripts${state.picking ? ' picking' : ''}`, id: 'regex-scripts' }, [
            ...place.scripts.map(script => rowFor(place, script)),
            state.draft ? rowFor(place, state.draft, true) : null,
          ].filter(Boolean)),
    ].filter(Boolean))
    filterRows()
  }

  /** The list drawn again where it was (the window scrolls as one page). */
  function redraw() {
    const main = $('regex-main')
    const scroll = main.scrollTop
    renderMain()
    main.scrollTop = scroll
  }

  function filterRows() {
    const terms = searchTerms(state.query)
    const place = shown()
    for (const row of document.querySelectorAll('#regex-scripts .prow')) {
      const script = place.scripts.find(s => s.id === row.dataset.id)
      row.hidden = Boolean(script) && terms.length > 0 && !matchesTerms(scriptText(script), terms)
    }
  }

  // ─── A set's own fields and its cards ────────────────────────────────
  /** A section above the scripts that stays open or closed as the player left it. */
  function panel(key, summaryParts, body) {
    const box = el('details', { class: 'book-panel', 'data-panel': key }, [el('summary', {}, summaryParts), el('div', { class: 'book-panel-body' }, body)])
    box.open = state.panels.has(key)
    box.addEventListener('toggle', () => (box.open ? state.panels.add(key) : state.panels.delete(key)))
    return box
  }

  const field = (text, control, extra = '') => el('label', { class: `prompt-field${extra ? ` ${extra}` : ''}` }, [el('span', { text }), control])

  function settingsPanel(set) {
    const name = el('input', { value: set.name, maxlength: '80', 'aria-label': t`名称` })
    name.addEventListener('change', guard(async () => {
      if (!name.value.trim()) {
        name.value = set.name
        throw new Error(t`名字不能空着`)
      }
      if (name.value.trim() !== set.name) await saveInfo(set, { name: name.value }, t`已改名`)
      name.value = set.name
    }))
    const note = el('textarea', { rows: '3', maxlength: '4000', placeholder: t`只给自己看，不发给模型`, 'aria-label': t`备注` })
    note.value = set.description ?? ''
    note.addEventListener('change', guard(async () => {
      if (note.value !== (set.description ?? '')) await saveInfo(set, { description: note.value }, t`已保存`)
    }))
    return panel('settings', [el('span', { text: t`正则集的设置` }), el('span', { class: 'book-panel-sub', text: set.description?.trim() ? t`有备注` : '' })], [
      field(t`名称`, name),
      field(t`备注`, note, 'wide'),
    ])
  }

  async function saveInfo(set, change, said) {
    const saved = await api(`/api/regex/sets/${set.id}`, { method: 'PUT', body: change })
    Object.assign(set, { name: saved.name, description: saved.description })
    onChanged({ sets: state.sets })
    renderNav()
    $('regex-headwrap')?.replaceChildren(headParts(shown()))
    toast(said)
  }

  /** Every card, ticked when the set is for it; a tick saves at once. */
  function cardsPanel(set) {
    const cards = getCards()
    const using = new Set(set.cardIds)
    const list = el('div', { class: 'book-cards' }, cards.map(c => {
      const box = el('input', { type: 'checkbox', value: c.id, checked: using.has(c.id) })
      box.addEventListener('change', guard(async () => {
        try {
          await saveCards(set, list, c, box.checked)
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
    const n = usedBy(set).length
    return panel('cards', [el('span', { text: t`用到它的卡` }), el('span', { class: 'book-panel-sub', text: n ? t`${n} 张` : t`还没有` })], [
      cards.length ? list : el('p', { class: 'prompt-note', text: t`还没有角色卡。` }),
      el('p', { class: 'prompt-note', text: t`勾上的卡，它的每个对话都在卡里自带的正则之后运行这个正则集，别的卡不受影响。删掉一张卡时，它从这里摘下，正则集还在。导出角色卡时默认不带这些正则，「修改角色卡」的导出旁可以勾上带上。` }),
    ])
  }

  async function saveCards(set, list, card, ticked) {
    const ids = [...list.querySelectorAll('input:checked')].map(box => box.value)
    const result = await api(`/api/regex/sets/${set.id}/cards`, { method: 'PUT', body: { ids } })
    set.cardIds = result.set.cardIds
    onChanged({ sets: state.sets })
    renderNav()
    $('regex-headwrap')?.replaceChildren(headParts(shown()))
    const sub = list.closest('.book-panel')?.querySelector('summary .book-panel-sub')
    if (sub) sub.textContent = set.cardIds.length ? t`${set.cardIds.length} 张` : t`还没有`
    const said = ticked ? t`「${card.name}」挂上了这个正则集` : t`「${card.name}」不再挂这个正则集`
    const prompt = set.scripts.some(s => !s.disabled && touchesPrompt(s))
    toast(prompt ? [said, t`会改发给模型的内容，这张卡的对话下一轮会重新写入一次缓存。`].join(t`。`) : t`${said}，只影响显示，不影响缓存。`, prompt ? 6000 : 3000)
  }

  // ─── Whole places ─────────────────────────────────────────────────────
  /**
   * One script as it is, several (or a whole group: `whole`, named after it) as a list: SillyTavern's regex
   * file either way.
   */
  function exportScripts(place, scripts, whole = false) {
    const one = scripts.length === 1 && !whole
    const name = one ? titleOf(scripts[0]).slice(0, 40) : place.kind === 'global' ? t`全局` : place.name
    const file = one ? stScripts(scripts)[0] : stScripts(scripts)
    saveFile(`regex-${name}.json`, JSON.stringify(file, null, 2), scripts.length === 1
      ? t`已导出 1 条正则。可以在 SillyTavern 的「正则」里导入，也可以导入另一台设备的 CicaTavern。`
      : t`已导出 ${scripts.length} 条正则。可以在 SillyTavern 的「正则」里导入，也可以导入另一台设备的 CicaTavern。`)
  }

  async function copySet() {
    const copy = await api(`/api/regex/sets/${shown().set.id}/copy`, { method: 'POST', body: {} })
    await reload()
    state.panels.add('cards')
    select(`set-${copy.id}`)
    toast(t`已复制为「${copy.name}」，还没挂到卡上`)
  }

  /** The place's scripts as a new set (the global ones, a card's or a preset's own stay as they are). */
  async function copyAsSet(place) {
    const name = prompt(t`新正则集的名字`, place.kind === 'global' ? t`全局正则（副本）` : t`${place.name}（副本）`)?.trim()
    if (!name) return
    const result = await api('/api/regex/transfer', { method: 'POST', body: { from: serverKey(place), to: '', ids: place.scripts.map(s => s.id), move: false, name } })
    await reload()
    state.panels.add('cards')
    select(result.to.key)
    toast(t`已复制成正则集「${name}」。在「用到它的卡」里勾上要用它的卡。`, 6000)
  }

  async function removeSet() {
    const set = shown().set
    const users = usedBy(set)
    const question = users.length
      ? t`删除正则集「${set.name}」？\n\n挂着它的 ${users.length} 张卡会一起摘下：${users.map(c => c.name).join(t`、`)}。`
      : t`删除正则集「${set.name}」？`
    if (!confirm(question)) return
    await api(`/api/regex/sets/${set.id}`, { method: 'DELETE' })
    await reload()
    select('global')
    const prompt = users.length && set.scripts.some(s => !s.disabled && touchesPrompt(s))
    toast(prompt ? t`已删除「${set.name}」。挂着它的卡的对话发给模型的内容变了，下一轮会重新写入一次缓存。` : t`已删除「${set.name}」`, prompt ? 6000 : 3000)
  }

  async function newSet() {
    const set = await api('/api/regex/sets', { method: 'POST', body: {} })
    await reload()
    state.panels.add('settings')
    state.panels.add('cards')
    select(`set-${set.id}`)
    dialog.querySelector('.preset-layout').classList.add('show-main')
    dialog.querySelector('.book-panel[data-panel="settings"] input')?.select()
  }

  // ─── Many scripts at once ─────────────────────────────────────────────
  function togglePicking() {
    state.picking = !state.picking
    state.picked.clear()
    redraw()
  }

  /** Where ticked scripts can be copied or moved: every other place that can change, or a new set (''). */
  function targetsFor(place) {
    return places().filter(p => p.editable && p.key !== place.key)
  }

  function bulkBar(place) {
    const n = state.picked.size
    const none = !n
    const targets = targetsFor(place)
    if (state.target !== '' && !targets.some(p => p.key === state.target)) state.target = targets[0]?.key ?? ''
    const target = el('select', { 'aria-label': t`复制或移动到` }, [
      ...targets.map(p => el('option', { value: p.key, text: label(p), selected: p.key === state.target })),
      el('option', { value: '', text: t`新建正则集…`, selected: state.target === '' }),
    ])
    target.addEventListener('change', () => (state.target = target.value))
    const edit = place.editable
    return el('div', { class: 'book-bulk', id: 'regex-bulk' }, [
      el('span', { class: 'book-bulk-count', text: t`已选 ${n} 条` }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`全选`, title: t`选中搜索出来的全部正则`, onclick: pickAll }),
      el('button', { type: 'button', class: 'btn small ghost', text: t`全不选`, disabled: none, onclick: () => { state.picked.clear(); redraw() } }),
      el('span', { class: 'book-bulk-gap' }),
      edit ? el('button', { type: 'button', class: 'btn small', text: t`启用`, disabled: none, onclick: guard(() => switchPicked(true)) }) : null,
      edit ? el('button', { type: 'button', class: 'btn small', text: t`停用`, disabled: none, onclick: guard(() => switchPicked(false)) }) : null,
      el('span', { class: 'book-bulk-to' }, [
        target,
        el('button', { type: 'button', class: 'btn small', text: t`复制`, disabled: none, onclick: guard(() => transfer(target.value, false)) }),
        edit ? el('button', { type: 'button', class: 'btn small', text: t`移动`, disabled: none, onclick: guard(() => transfer(target.value, true)) }) : null,
      ]),
      el('button', { type: 'button', class: 'btn small', text: t`导出`, disabled: none, onclick: () => exportScripts(place, pickedScripts(place)) }),
      edit ? el('button', { type: 'button', class: 'btn small danger', text: t`删除`, disabled: none, onclick: guard(removePicked) }) : null,
    ])
  }

  const pickedScripts = place => place.scripts.filter(s => state.picked.has(s.id))

  function pickAll() {
    for (const row of document.querySelectorAll('#regex-scripts .prow')) if (!row.hidden && row.dataset.id !== 'draft') state.picked.add(row.dataset.id)
    redraw()
  }

  async function switchPicked(on) {
    const place = shown()
    const changed = pickedScripts(place).filter(s => s.disabled === on)
    if (!changed.length) return toast(on ? t`选中的都开着` : t`选中的都关着`)
    await save(place, place.scripts.map(s => (state.picked.has(s.id) ? { ...s, disabled: !on } : s)), changed, on ? t`已启用 ${changed.length} 条正则` : t`已停用 ${changed.length} 条正则`)
    redraw()
  }

  async function removePicked() {
    const place = shown()
    const picked = pickedScripts(place)
    if (!confirm(t`删除选中的 ${picked.length} 条正则？`)) return
    await save(place, place.scripts.filter(s => !state.picked.has(s.id)), picked.filter(s => !s.disabled), t`已删除 ${picked.length} 条正则`)
    for (const s of picked) {
      state.open.delete(s.id)
      rows.delete(s.id)
    }
    state.picked.clear()
    redraw()
  }

  /** The ticked scripts copied (or moved) to another place, or to a new set (`to` empty). */
  async function transfer(to, move) {
    const place = shown()
    const picked = pickedScripts(place)
    let name = ''
    if (!to) {
      name = prompt(t`新正则集的名字`, t`${place.kind === 'global' ? t`全局正则` : place.name}（摘录）`)?.trim() ?? ''
      if (!name) return
    }
    const into = to ? placeOf(to) : null
    const result = await api('/api/regex/transfer', { method: 'POST', body: { from: serverKey(place), to: into ? serverKey(into) : '', ids: picked.map(s => s.id), move, name } })
    if (into) take(into, result.to.scripts)
    else await reload()
    if (move) {
      take(place, result.from.scripts)
      for (const s of picked) {
        state.open.delete(s.id)
        rows.delete(s.id)
      }
    }
    const target = placeOfServer(result.to.key)
    // A new set is where the next ones go too.
    state.target = target?.key ?? ''
    state.picked.clear()
    renderNav()
    redraw()
    const where = target ? label(target) : name
    const said = move ? t`已把 ${picked.length} 条移到${where}` : t`已把 ${picked.length} 条复制到${where}`
    const prompt = picked.some(s => !s.disabled && touchesPrompt(s))
    const notes = [said]
    if (target && !live(target)) notes.push(t`这个正则集还没挂到卡上，暂时不生效`)
    else if (prompt) notes.push(t`会改发给模型的内容，用到的对话下一轮会重新写入一次缓存`)
    toast(notes.join(t`。`), notes.length > 1 ? 6000 : 3000)
  }

  // ─── One script ───────────────────────────────────────────────────────
  function addDraft() {
    state.draft = { id: newId(), scriptName: '', findRegex: '', replaceString: '', trimStrings: [], placement: [PLACEMENT.AI_OUTPUT], disabled: false, markdownOnly: true, promptOnly: false, substituteRegex: 0, minDepth: null, maxDepth: null }
    rows.delete('draft')
    redraw()
    const row = document.querySelector('#regex-scripts .prow[data-id="draft"]')
    row?.scrollIntoView({ block: 'center' })
    row?.querySelector('.regex-form input')?.focus()
  }

  function where(script) {
    return [script.placement.includes(PLACEMENT.AI_OUTPUT) && t`AI 回复`, script.placement.includes(PLACEMENT.USER_INPUT) && t`用户输入`].filter(Boolean).join(t`、`) || t`不作用`
  }

  /** The row of a script (kept while the place is shown, so an open editor keeps what is typed). */
  function rowFor(place, script, draft = false) {
    const key = draft ? 'draft' : script.id
    let row = rows.get(key)
    if (!row) {
      row = scriptRow(place, script.id, draft)
      rows.set(key, row)
    }
    row.refresh()
    return row
  }

  function scriptRow(place, id, draft) {
    /** The script as saved now (a switch or 多选 may have changed it since the row was made). */
    const stored = () => (draft ? state.draft : shown().scripts.find(s => s.id === id))
    const more = el('div', { class: 'prow-more' }, el('div'))
    const row = el('li', { class: 'prow', 'data-id': draft ? 'draft' : id }, [el('div', { class: 'prow-line' }), more])

    function line() {
      const script = stored()
      const pick = el('input', { type: 'checkbox', class: 'book-pick', checked: state.picked.has(id), disabled: draft, 'aria-label': t`选中「${titleOf(script) || t`新正则`}」` })
      pick.addEventListener('change', () => setPicked(pick.checked))
      const toggle = el('input', { type: 'checkbox', class: 'switch', checked: !script.disabled, disabled: !place.editable || draft, 'aria-label': t`启用「${titleOf(script) || t`新正则`}」` })
      toggle.addEventListener('change', guard(async () => {
        const before = stored()
        const after = { ...before, disabled: !toggle.checked }
        try {
          await save(shown(), shown().scripts.map(s => (s.id === id ? after : s)), [before, after])
        } catch (error) {
          toggle.checked = !toggle.checked
          throw error
        }
        row.refresh()
        renderNav()
      }))
      const effect = effectOf(script)
      const name = el('button', { type: 'button', class: 'prow-name', text: draft ? t`新建正则` : titleOf(script), title: state.picking ? t`选中或取消` : t`展开编辑`, 'aria-expanded': String(state.open.has(id) || draft), onclick: () => expand() })
      const tick = event => {
        if (state.picking && !draft && !event.target.closest('input, button')) setPicked(!state.picked.has(id))
      }
      return el('div', { class: 'prow-line', onclick: tick }, [
        pick,
        toggle,
        name,
        // A new one shows what it does once it is added.
        draft ? null : el('span', { class: 'prow-size', text: where(script) }),
        draft ? null : el('span', { class: `strategy ${effect === 'display' ? 'off' : 'key'}`, title: effect === 'display' ? t`发给模型的不变，不影响缓存` : t`会改发给模型的内容，改了下一轮会重新写入一次缓存`, text: EFFECT_LABEL[effect] }),
        draft ? null : el('button', { type: 'button', class: 'prow-edit', title: t`编辑查找、替换和作用范围，还能测试`, 'aria-label': t`编辑「${titleOf(script)}」`, text: '✎', onclick: () => expand(true) }),
      ])
    }
    function expand(edit = false) {
      if (draft) return
      if (state.picking && edit !== true) {
        setPicked(!state.picked.has(id))
        return
      }
      const opening = !row.classList.contains('open')
      if (opening) {
        fillEditor()
        state.open.add(id)
        requestAnimationFrame(() => row.classList.add('open'))
      } else {
        state.open.delete(id)
        row.classList.remove('open')
      }
      row.querySelector('.prow-name')?.setAttribute('aria-expanded', String(opening))
    }
    function setPicked(on) {
      if (on) state.picked.add(id)
      else state.picked.delete(id)
      row.classList.toggle('picked', on)
      const box = row.querySelector('.book-pick')
      if (box) box.checked = on
      $('regex-bulk')?.replaceWith(bulkBar(shown()))
    }
    function fillEditor() {
      const holder = more.firstChild
      if (!holder.firstChild) holder.append(editor(place, id, draft, stored, row))
    }
    row.refresh = () => {
      const script = stored()
      if (!script) return
      row.querySelector('.prow-line').replaceWith(line())
      row.classList.toggle('off', Boolean(script.disabled))
      row.classList.toggle('picked', state.picked.has(id))
      if (draft || state.open.has(id)) {
        fillEditor()
        row.classList.add('open')
      }
    }
    return row
  }

  /** The editor for one script (an existing one, or a new one not added yet). */
  function editor(place, id, draft, stored, row) {
    const script = stored()
    const editable = place.editable
    const field = (text, control, hint) => el('label', {}, [text, control, hint ? el('span', { class: 'hint', text: hint }) : null])

    const name = el('input', { value: script.scriptName, placeholder: t`例如 藏起变量块`, maxlength: 80, disabled: !editable })
    const find = el('input', { class: 'mono', value: script.findRegex, placeholder: '/<state>[\\s\\S]*?<\\/state>/g', spellcheck: 'false', disabled: !editable })
    const findNote = el('span', { class: 'hint' })
    const replace = el('textarea', { class: 'mono', rows: 3, spellcheck: 'false', placeholder: t`留空就是删掉匹配到的部分`, disabled: !editable })
    replace.value = script.replaceString
    const onAi = el('input', { type: 'checkbox', checked: script.placement.includes(PLACEMENT.AI_OUTPUT), disabled: !editable })
    const onUser = el('input', { type: 'checkbox', checked: script.placement.includes(PLACEMENT.USER_INPUT), disabled: !editable })
    let effect = effectOf(script)
    const effectSeg = el('div', { class: 'seg' }, Object.entries(EFFECT_LABEL).map(([value, text]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(value === effect), text, disabled: !editable })
      b.addEventListener('click', () => {
        effect = value
        for (const other of effectSeg.children) other.setAttribute('aria-pressed', String(other === b))
        changed()
      })
      return b
    }))
    const trims = el('textarea', { class: 'mono', rows: 2, spellcheck: 'false', placeholder: t`一行一个`, disabled: !editable })
    trims.value = script.trimStrings.join('\n')
    const depthBox = value => el('input', { type: 'number', min: 0, step: 1, value: value ?? '', placeholder: t`不限`, disabled: !editable })
    const minDepth = depthBox(script.minDepth)
    const maxDepth = depthBox(script.maxDepth)
    const macroMode = el('select', { disabled: !editable }, [
      el('option', { value: '0', text: t`不替换`, selected: script.substituteRegex === 0 }),
      el('option', { value: '1', text: t`原样替换`, selected: script.substituteRegex === 1 }),
      el('option', { value: '2', text: t`替换并转义`, selected: script.substituteRegex === 2 }),
    ])

    /** The script as the form now says. */
    const current = () => {
      const base = stored() ?? script
      const keep = base.placement.filter(p => p !== PLACEMENT.AI_OUTPUT && p !== PLACEMENT.USER_INPUT)
      const depth = input => (input.value.trim() === '' ? null : Math.max(0, Math.floor(Number(input.value)) || 0))
      return {
        ...base,
        scriptName: name.value.trim(),
        findRegex: find.value.trim(),
        replaceString: replace.value,
        trimStrings: trims.value.split('\n').filter(Boolean),
        placement: [...(onUser.checked ? [PLACEMENT.USER_INPUT] : []), ...(onAi.checked ? [PLACEMENT.AI_OUTPUT] : []), ...keep],
        ...effectFlags(effect, base),
        minDepth: depth(minDepth),
        maxDepth: depth(maxDepth),
        substituteRegex: Number(macroMode.value),
      }
    }

    // The test box: the chat's latest reply (or a sample), run through this script alone.
    const sample = el('textarea', { class: 'mono', rows: 5, spellcheck: 'false' })
    sample.value = state.sample || SAMPLE
    // A script only for the player's input is tried on it.
    const inputOnly = script.placement.includes(PLACEMENT.USER_INPUT) && !script.placement.includes(PLACEMENT.AI_OUTPUT)
    const testOn = el('select', {}, [
      el('option', { value: String(PLACEMENT.AI_OUTPUT), text: t`当作 AI 回复` }),
      el('option', { value: String(PLACEMENT.USER_INPUT), text: t`当作用户输入`, selected: inputOnly }),
    ])
    const results = el('div', { class: 'regex-results' })
    function runTest() {
      const trial = { ...current(), disabled: false }
      const regex = trial.findRegex ? regexFromString(trial.findRegex) : null
      findNote.textContent = !trial.findRegex ? t`必填。可以写 /表达式/标志，也可以只写表达式。` : regex ? '' : t`这个表达式写得不对，浏览器读不出来`
      findNote.classList.toggle('bad', Boolean(trial.findRegex) && !regex)
      const placement = Number(testOn.value)
      const text = sample.value
      const run = target => applyScripts(text, [trial], { placement, target, macros: state.macros })
      const global = regex ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`) : null
      const hits = global ? [...text.matchAll(global)].length : 0
      const shownText = run('display')
      const sent = run('prompt')
      results.replaceChildren(
        el('p', { class: 'hint', text: !regex ? '' : hits ? t`匹配到 ${hits} 处` : t`没有匹配到` }),
        el('div', { class: 'regex-out' }, [el('span', { text: t`显示出来` }), el('pre', { text: shownText || t`（空）` })]),
        ...(sent === shownText ? [el('p', { class: 'hint', text: t`发给模型的和显示的一样` })] : [el('div', { class: 'regex-out' }, [el('span', { text: t`发给模型` }), el('pre', { text: sent || t`（空）` })])]),
      )
    }

    const saveButton = el('button', { type: 'button', class: 'btn primary small', text: draft ? t`添加` : t`保存`, disabled: !editable })
    // 保存 waits for a valid pattern and, on an existing script, for a change.
    const unchanged = () => !draft && JSON.stringify(current()) === JSON.stringify(stored())
    const changed = () => {
      runTest()
      saveButton.disabled = !editable || !current().findRegex || !regexFromString(current().findRegex) || unchanged()
    }
    for (const input of [name, find, replace, trims, minDepth, maxDepth, sample]) input.addEventListener('input', changed)
    for (const input of [onAi, onUser, macroMode, testOn]) input.addEventListener('change', changed)

    saveButton.addEventListener('click', guard(async () => {
      const next = current()
      const into = shown()
      if (draft) {
        await save(into, [...into.scripts, next], [next], t`已添加`)
        state.draft = null
        rows.delete('draft')
        state.open.add(next.id)
        redraw()
        document.querySelector(`#regex-scripts .prow[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: 'nearest' })
        return
      }
      const before = stored()
      await save(into, into.scripts.map(s => (s.id === id ? next : s)), [before, next])
      row.refresh()
      renderNav()
      changed()
    }))
    const cancel = draft ? el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { state.draft = null; rows.delete('draft'); redraw() } }) : null
    const actions = draft ? [] : [
      editable ? el('button', { type: 'button', class: 'btn ghost small', text: t`按意见改`, title: t`在「对话修改」里说说这一条想怎么改，或者问它为什么不生效`, onclick: () => talkAbout(place, { id: `regex:${id}`, label: titleOf(stored()) }) }) : null,
      editable ? el('button', { type: 'button', class: 'btn ghost small', text: t`复制一条`, title: t`在这一组里复制出一条一样的，放在它后面`, onclick: guard(() => duplicate(id)) }) : null,
      el('button', { type: 'button', class: 'btn ghost small', text: t`导出`, title: t`这一条存成 SillyTavern 的正则文件`, onclick: () => exportScripts(place, [stored()]) }),
      editable ? el('button', { type: 'button', class: 'btn small danger', text: t`删除`, onclick: guard(() => removeOne(id)) }) : null,
    ]

    const form = el('div', { class: 'regex-form' }, [
      field(t`名称`, name),
      el('label', {}, [t`查找`, find, findNote]),
      field(t`替换为`, replace, t`$1、$<名字> 是捕获组，{{match}} 是整段匹配`),
      el('div', { class: 'regex-row' }, [
        el('span', { class: 'regex-label', text: t`作用于` }),
        el('label', { class: 'check-row' }, [onAi, t`AI 回复`]),
        el('label', { class: 'check-row' }, [onUser, t`用户输入`]),
      ]),
      el('div', { class: 'regex-row' }, [el('span', { class: 'regex-label', text: t`效果` }), effectSeg]),
      el('details', { class: 'regex-more' }, [
        el('summary', { text: t`更多：修剪、深度、宏` }),
        field(t`修剪（替换前从匹配里去掉这些文字）`, trims),
        el('div', { class: 'grid' }, [field(t`最小深度`, minDepth, t`0 是最新一条`), field(t`最大深度`, maxDepth)]),
        field(t`查找里的 {{char}} 这类宏`, macroMode),
      ]),
      el('div', { class: 'regex-test' }, [
        el('div', { class: 'regex-row' }, [el('span', { class: 'regex-label', text: t`测试` }), testOn]),
        sample,
        results,
      ]),
      el('div', { class: 'prompt-actions regex-actions' }, [...actions, cancel, editable ? saveButton : null].filter(Boolean)),
    ])
    changed()
    return form
  }

  /** A copy of a script right after it, with an id of its own. */
  async function duplicate(id) {
    const place = shown()
    const index = place.scripts.findIndex(s => s.id === id)
    const original = place.scripts[index]
    const copy = { ...original, id: newId(), scriptName: t`${titleOf(original)}（副本）` }
    await save(place, [...place.scripts.slice(0, index + 1), copy, ...place.scripts.slice(index + 1)], [copy], t`已复制`)
    state.open.add(copy.id)
    redraw()
    document.querySelector(`#regex-scripts .prow[data-id="${CSS.escape(copy.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  async function removeOne(id) {
    const place = shown()
    const script = place.scripts.find(s => s.id === id)
    if (!confirm(t`删除「${titleOf(script)}」？`)) return
    await save(place, place.scripts.filter(s => s.id !== id), script.disabled ? [] : [script], t`已删除`)
    state.open.delete(id)
    state.picked.delete(id)
    rows.delete(id)
    renderNav()
    redraw()
  }

  // ─── 对话修改 (talk-dialog.js) ─────────────────────────────────────────
  /** The talk on a place's scripts; `aim` keeps the first request to one script. */
  function talkAbout(place, aim = null) {
    const key = place.key
    openTalk?.({
      url: `/api/talk/regex/${serverKey(place)}`,
      title: t`对话修改正则`,
      name: place.kind === 'set' ? place.name : label(place),
      aim,
      intro: () => t`说说想让回复怎么变，或者哪条正则不管用：向导把要改的正则整条写出来，先拿当前对话的最新回复试一遍，给你看匹配到什么、变成什么，勾上的才会存进去。`,
      ideas: () => [t`把【】里的内容变成彩色小框`, t`藏起回复里的思维链`, t`这些正则分别在做什么？`],
      placeholder: target => (target ? t`「${target.label}」想怎么改，或者问它为什么不生效` : t`说说想让回复怎么变，比如：把状态栏那段藏起来`),
      busy: job => (job.step === 'check' ? t`拿最新回复试跑…` : job.chars ? t`正在写，已经写了 ${job.chars.toLocaleString()} 字…` : t`正在读这些正则…`),
      changeTitle: change => {
        if (change.kind === 'newRegex') return t`新正则 · ${change.name || change.find}`
        if (change.kind === 'removeRegex') return t`删除 · ${change.title}`
        return change.title
      },
      changeWhere: change => {
        if (change.kind === 'removeRegex') return ['', '', '']
        if (change.enabled === false) return [t`停用`, 'off', '']
        const effect = change.newEffect ?? change.effect
        return [EFFECT_LABEL[effect], effect === 'display' ? 'off' : 'key', effect === 'display' ? t`发给模型的不变，不影响缓存` : t`会改发给模型的内容，下一轮会重新写入一次缓存`]
      },
      changeNotes: () => [],
      changeBody: (change, { diffBox }) => regexBody(change, diffBox),
      canTake: change => !change.invalid,
      context: () => ({ sample: state.sample, names: state.names }),
      targetLabel: target => {
        const script = (placeOf(key) ?? place).scripts.find(s => `regex:${s.id}` === target)
        return script ? titleOf(script) : target.slice(6)
      },
      onApplied: result => talked(key, result, t`已存进正则：${result.applied} 处`),
      onUndone: result => talked(key, result, t`已撤销这次修改`),
    })
  }

  /** A proposed script: what changes in it, and how it did on the latest reply. */
  function regexBody(change, diffBox) {
    const notes = []
    if (change.kind === 'regex' && change.name) notes.push(t`名称：${change.title} → ${change.name}`)
    if (change.kind === 'newRegex' || change.newOn) notes.push(t`作用于：${ON_LABEL[change.newOn ?? change.on]}`)
    if (change.newEffect) notes.push(t`效果：${EFFECT_LABEL[change.newEffect]}`)
    if (change.enabled !== undefined) notes.push(change.enabled ? t`改为启用` : t`改为停用`)
    const [findBefore, findAfter] = change.kind === 'newRegex' ? ['', change.find] : change.kind === 'removeRegex' ? [change.find, ''] : [change.findBefore, change.findAfter]
    const [replaceBefore, replaceAfter] = change.kind === 'newRegex' ? ['', change.replace] : change.kind === 'removeRegex' ? [change.replace, ''] : [change.replaceBefore, change.replaceAfter]
    if (change.kind === 'newRegex' && !change.replace) notes.push(t`替换为空：删掉匹配到的部分`)
    return [
      notes.length ? el('p', { class: 'ce-change-note', text: notes.join(t`；`) }) : null,
      findBefore !== findAfter ? el('div', { class: 'talk-label', text: t`查找` }) : null,
      findBefore !== findAfter ? diffBox(findBefore, findAfter) : null,
      replaceBefore !== replaceAfter ? el('div', { class: 'talk-label', text: t`替换为` }) : null,
      replaceBefore !== replaceAfter ? diffBox(replaceBefore, replaceAfter) : null,
      change.kind === 'removeRegex' ? null : trialBox(change),
    ]
  }

  function trialBox(change) {
    if (change.invalid) return el('p', { class: 'talk-trial bad', text: t`这个表达式写得不对，读不出来，不能采用。` })
    const trial = change.trial
    if (!trial) return el('p', { class: 'talk-trial', text: t`这个对话还没有回复，没法试跑。` })
    if (trial.error === 'timeout') return el('p', { class: 'talk-trial bad', text: t`试跑超时：这个表达式在最新回复上卡住了，不建议采用。` })
    if (trial.error) return el('p', { class: 'talk-trial', text: t`没能试跑。` })
    if (!trial.matches) return el('p', { class: 'talk-trial warn', text: t`在最新回复里没有匹配到。` })
    return el('div', { class: 'talk-trial' }, [
      el('p', { text: t`在最新回复里匹配到 ${trial.matches} 处，前几处变成：` }),
      ...trial.samples.map(sample => el('div', { class: 'talk-trial-sample' }, [
        el('pre', { class: 'from', text: sample.match }),
        HTML_LIKE.test(sample.shown) ? htmlSample(sample.shown) : el('pre', { class: 'to', text: sample.shown || t`（删掉）` }),
      ])),
    ])
  }

  /** Block HTML a script puts in, as the chat shows it (render.js): in a sandboxed frame, where nothing it holds can run. */
  function htmlSample(html) {
    const style = getComputedStyle(document.documentElement)
    const head = `<!doctype html><meta charset="utf-8"><style>body{margin:4px 8px;font:14px/1.7 ${style.getPropertyValue('--serif')};color:${style.getPropertyValue('--ink')}}</style>`
    return el('iframe', { class: 'talk-trial-html', sandbox: '', srcdoc: head + html, title: t`显示出来的样子` })
  }

  /** What the talk saved or undid: the place's scripts drawn again, the chat following them. */
  function talked(key, result, said) {
    const place = placeOf(key)
    if (!place) return
    const scripts = result.regex.scripts
    take(place, scripts)
    const kept = new Set(scripts.map(s => s.id))
    for (const id of [...state.open]) if (!kept.has(id)) state.open.delete(id)
    for (const id of [...rows.keys()]) if (id !== 'draft' && !kept.has(id)) rows.delete(id)
    if (dialog.open) {
      renderNav()
      if (state.selected === key) redraw()
    }
    toast(result.prefix && live(place) ? [said, t`会改发给模型的内容，下一轮会重新写入一次缓存。`].join(t`。`) : said, result.prefix ? 6000 : 3000)
  }

  // ─── 新建 / 导入 ──────────────────────────────────────────────────────
  $('regex-new').addEventListener('click', guard(newSet))
  $('regex-import').addEventListener('change', guard(async event => {
    const files = [...event.target.files]
    event.target.value = ''
    const scripts = []
    for (const file of files) {
      try {
        scripts.push(...scriptsInFile(JSON.parse(await file.text())))
      } catch {
        toast(t`「${file.name}」不是 JSON`)
      }
    }
    if (!scripts.length) return
    // Into the place shown, when its scripts can change; else into the global ones.
    const place = shown().editable ? shown() : placeOf('global')
    const result = await api('/api/regex/import', { method: 'POST', body: { scripts, to: serverKey(place) } })
    take(place, result.scripts)
    select(place.key)
    dialog.querySelector('.preset-layout').classList.add('show-main')
    const said = place.kind === 'global' ? t`导入了 ${result.added} 条正则，放在全局，所有对话都会用` : t`导入了 ${result.added} 条正则，放在${label(place)}`
    toast(live(place) ? said : [said, t`这个正则集还没挂到卡上，在「用到它的卡」里勾上才生效`].join(t`。`), 6000)
  }))

  /** SillyTavern scripts into the global ones (the importer, for a regex file dropped anywhere). → how many were added. */
  async function importScripts(scripts) {
    const result = await api('/api/regex/import', { method: 'POST', body: { scripts } })
    state.global = result.scripts
    onChanged({ global: result.scripts })
    if (dialog.open) select(state.selected)
    toast(t`导入了 ${result.added} 条正则，放在全局，所有对话都会用`)
    return result.added
  }

  /** @param select - the place to show: global, preset, card or set-<id>; the one shown last when not given. */
  async function open({ select: wanted } = {}) {
    const [all, ctx] = await Promise.all([api('/api/regex'), context()])
    state.global = all.scripts
    state.sets = all.sets ?? []
    state.card = ctx.card
    state.preset = ctx.preset
    state.sample = ctx.sample ?? ''
    state.macros = ctx.macros ?? (text => text)
    state.names = ctx.names ?? null
    state.draft = null
    rows.clear()
    const key = wanted && placeOf(wanted) ? wanted : placeOf(state.selected) ? state.selected : 'global'
    state.selected = key
    const kept = new Set(shown().scripts.map(s => s.id))
    for (const id of [...state.open]) if (!kept.has(id)) state.open.delete(id)
    for (const id of [...state.picked]) if (!kept.has(id)) state.picked.delete(id)
    renderNav()
    renderMain()
    if (!dialog.open) dialog.showModal()
    dialog.querySelector('.preset-layout').classList.toggle('show-main', Boolean(wanted && placeOf(wanted)))
  }

  return { open, importScripts }
}
