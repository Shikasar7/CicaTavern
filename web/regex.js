// 正则 (设置 → 写作 → 正则, and the importer): the regex scripts a chat runs —
// the global ones (every chat), then its preset's, then its card's — each with
// its own switch, an editor and a test box. Scripts come in SillyTavern's shape
// (web/shared/regex.js); a standalone SillyTavern regex file imports into the
// global ones. Saving one that changes what is sent tells the player the next
// turn writes the cache once more; display-only scripts never touch it.
import { t } from '/i18n.js'
import { applyScripts, PLACEMENT, regexFromString, scriptsInFile } from '/shared/regex.js'
import { HTML_LIKE } from '/render.js'

const EFFECT_LABEL = { both: t`显示和发送都改`, display: t`只改显示`, prompt: t`只改发给模型的` }
// A reply to try a script on when the chat has none yet.
const SAMPLE = t`她把伞收起来，抖了抖水。「进来坐吧。」` + '\n<state>{"好感": 12}</state>' // i18n-ignore: a variable block as cards write it

const effectOf = script => (script.markdownOnly ? 'display' : script.promptOnly ? 'prompt' : 'both')
/** Whether the script changes what the model reads again (so the cache is written once more). */
const touchesPrompt = script => Boolean(script) && !script.markdownOnly && (script.placement.includes(PLACEMENT.AI_OUTPUT) || script.placement.includes(PLACEMENT.USER_INPUT))
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)

const ON_LABEL = { ai: t`AI 回复`, user: t`用户输入`, both: t`AI 回复和用户输入`, none: t`不作用` }

/**
 * @param context - async () → { card: { id, name, scripts } | null, preset: { id, name, builtin, scripts } | null, sample, macros }
 * @param onChanged - (scope, id, scripts) after a scope's scripts were saved.
 * @param openTalk - talk-dialog.js: 对话修改 on a scope's scripts.
 */
export function initRegex({ api, el, toast, guard, context, onChanged, openTalk }) {
  const $ = id => document.getElementById(id)
  const dialog = $('regex-dialog')
  const state = { global: [], card: null, preset: null, selected: null, draft: null, sample: '', macros: text => text }

  /** scope → its scripts, label and whether it can change. */
  const scopes = () => [
    { key: 'global', title: t`全局`, note: t`所有对话`, scripts: state.global, editable: true },
    ...(state.preset ? [{ key: 'preset', title: t`预设`, note: state.preset.name, scripts: state.preset.scripts, editable: !state.preset.builtin }] : []),
    ...(state.card ? [{ key: 'card', title: t`角色卡`, note: state.card.name, scripts: state.card.scripts, editable: true }] : []),
  ]
  const scopeOf = key => scopes().find(s => s.key === key)

  async function save(key, scripts, { before, after } = {}) {
    const url = key === 'global' ? '/api/regex' : key === 'card' ? `/api/cards/${state.card.id}/regex` : `/api/presets/${state.preset.id}/regex`
    const saved = (await api(url, { method: 'PUT', body: { scripts } })).scripts
    if (key === 'global') state.global = saved
    else state[key].scripts = saved
    onChanged(key, key === 'global' ? '' : state[key].id, saved)
    toast(touchesPrompt(before) || touchesPrompt(after) ? t`已保存。会改发给模型的内容，下一轮会重新写入一次缓存。` : t`已保存，只影响显示，不影响缓存。`)
    return saved
  }

  function summary(script) {
    const where = [script.placement.includes(PLACEMENT.AI_OUTPUT) && t`AI 回复`, script.placement.includes(PLACEMENT.USER_INPUT) && t`用户输入`].filter(Boolean).join(t`、`) || t`不作用`
    return `${where} · ${EFFECT_LABEL[effectOf(script)]}`
  }

  function renderList() {
    const groups = scopes().map(scope => {
      const items = scope.scripts.map(script => {
        const toggle = el('input', { type: 'checkbox', class: 'switch', checked: !script.disabled, disabled: !scope.editable, 'aria-label': t`启用「${script.scriptName || script.findRegex}」` })
        toggle.addEventListener('click', event => event.stopPropagation())
        toggle.addEventListener('change', guard(async () => {
          const next = { ...script, disabled: !toggle.checked }
          await save(scope.key, scope.scripts.map(s => (s.id === script.id ? next : s)), { before: script, after: next })
          render()
        }))
        const li = el('li', { class: [state.selected?.scope === scope.key && state.selected.id === script.id ? 'active' : '', script.disabled ? 'off' : ''].join(' ').trim() }, [
          el('div', { class: 'regex-item' }, [
            el('div', { class: 'item-main' }, [
              el('div', { class: 'item-title', text: script.scriptName || script.findRegex }),
              el('div', { class: 'item-sub', text: summary(script) }),
            ]),
            toggle,
          ]),
        ])
        li.addEventListener('click', () => {
          state.selected = { scope: scope.key, id: script.id }
          state.draft = null
          render()
        })
        return li
      })
      return el('section', { class: 'regex-group' }, [
        el('h3', { class: 'regex-group-title' }, [
          scope.title,
          el('span', { text: scope.note }),
          scope.editable ? el('button', { type: 'button', class: 'btn ghost small', text: t`对话修改`, title: t`说说想让回复怎么变，向导写好正则，先拿最新回复试一遍`, onclick: () => talkAbout(scope.key) }) : null,
        ]),
        items.length ? el('ul', { class: 'preset-list' }, items) : el('p', { class: 'regex-empty', text: scope.key === 'global' ? t`还没有。点「新建」或「导入」。` : t`没有` }),
      ])
    })
    $('regex-list').replaceChildren(...groups)
  }

  /** The editor for one script (an existing one, or a new one not saved yet). */
  function renderEditor() {
    const main = $('regex-main')
    const scope = state.draft ? scopeOf(state.draft.scope) : scopeOf(state.selected?.scope)
    const original = state.draft ? null : scope?.scripts.find(s => s.id === state.selected.id)
    if (!state.draft && !original) {
      main.replaceChildren(el('div', { class: 'preset-empty' }, [
        el('p', { text: t`正则在显示或发送前改写文字：藏起变量块、换掉格式、删掉不想发给模型的部分。` }),
        el('p', { class: 'small', text: t`左边选一条来改，或者新建一条。卡和预设自带的也能在这里开关。` }),
      ]))
      return
    }
    const script = original ?? state.draft.script
    const editable = scope.editable
    const field = (label, control, hint) => el('label', {}, [label, control, hint ? el('span', { class: 'hint', text: hint }) : null])

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
      const keep = script.placement.filter(p => p !== PLACEMENT.AI_OUTPUT && p !== PLACEMENT.USER_INPUT)
      const depth = input => (input.value.trim() === '' ? null : Math.max(0, Math.floor(Number(input.value)) || 0))
      return {
        ...script,
        scriptName: name.value.trim(),
        findRegex: find.value.trim(),
        replaceString: replace.value,
        trimStrings: trims.value.split('\n').filter(Boolean),
        placement: [...(onUser.checked ? [PLACEMENT.USER_INPUT] : []), ...(onAi.checked ? [PLACEMENT.AI_OUTPUT] : []), ...keep],
        markdownOnly: effect === 'display',
        promptOnly: effect === 'prompt',
        minDepth: depth(minDepth),
        maxDepth: depth(maxDepth),
        substituteRegex: Number(macroMode.value),
      }
    }

    // The test box: the chat's latest reply (or a sample), run through this script alone.
    const sample = el('textarea', { class: 'mono', rows: 5, spellcheck: 'false' })
    sample.value = state.sample || SAMPLE
    const testOn = el('select', {}, [
      el('option', { value: String(PLACEMENT.AI_OUTPUT), text: t`当作 AI 回复` }),
      el('option', { value: String(PLACEMENT.USER_INPUT), text: t`当作用户输入` }),
    ])
    const results = el('div', { class: 'regex-results' })
    function runTest() {
      const draft = { ...current(), disabled: false }
      const regex = regexFromString(draft.findRegex)
      findNote.textContent = !draft.findRegex ? t`必填。可以写 /表达式/标志，也可以只写表达式。` : regex ? '' : t`这个表达式写得不对，浏览器读不出来`
      findNote.classList.toggle('bad', Boolean(draft.findRegex) && !regex)
      const placement = Number(testOn.value)
      const text = sample.value
      const run = target => applyScripts(text, [draft], { placement, target, macros: state.macros })
      const global = regex ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`) : null
      const hits = global ? [...text.matchAll(global)].length : 0
      const shown = run('display')
      const sent = run('prompt')
      results.replaceChildren(
        el('p', { class: 'hint', text: !regex ? '' : hits ? t`匹配到 ${hits} 处` : t`没有匹配到` }),
        el('div', { class: 'regex-out' }, [el('span', { text: t`显示出来` }), el('pre', { text: shown || t`（空）` })]),
        ...(sent === shown ? [el('p', { class: 'hint', text: t`发给模型的和显示的一样` })] : [el('div', { class: 'regex-out' }, [el('span', { text: t`发给模型` }), el('pre', { text: sent || t`（空）` })])]),
      )
    }

    const saveButton = el('button', { type: 'button', class: 'btn primary', text: state.draft ? t`添加` : t`保存`, disabled: !editable })
    // 保存 waits for a valid pattern and, on an existing script, for a change.
    const unchanged = () => !state.draft && JSON.stringify(current()) === JSON.stringify(script)
    const changed = () => {
      runTest()
      saveButton.disabled = !editable || !current().findRegex || !regexFromString(current().findRegex) || unchanged()
    }
    for (const input of [name, find, replace, trims, minDepth, maxDepth, sample]) input.addEventListener('input', changed)
    for (const input of [onAi, onUser, macroMode, testOn]) input.addEventListener('change', changed)

    // A new script goes to the global ones or this card's.
    const targets = scopes().filter(s => s.editable && s.key !== 'preset')
    const target = state.draft && targets.length > 1
      ? el('select', {}, targets.map(s => el('option', { value: s.key, text: s.key === 'global' ? t`全局（所有对话）` : t`这张角色卡：${s.note}`, selected: s.key === state.draft.scope })))
      : null
    target?.addEventListener('change', () => { state.draft.scope = target.value })

    saveButton.addEventListener('click', guard(async () => {
      const next = current()
      if (state.draft) {
        const into = scopeOf(state.draft.scope)
        await save(into.key, [...into.scripts, next], { after: next })
        state.selected = { scope: into.key, id: next.id }
        state.draft = null
      } else {
        await save(scope.key, scope.scripts.map(s => (s.id === script.id ? next : s)), { before: script, after: next })
      }
      render()
    }))
    const remove = !state.draft && editable ? el('button', { type: 'button', class: 'btn danger', text: t`删除` }) : null
    const aimed = !state.draft && editable
      ? el('button', { type: 'button', class: 'btn ghost', text: t`按意见改`, title: t`在「对话修改」里说说这一条想怎么改，或者问它为什么不生效`, onclick: () => talkAbout(scope.key, { id: `regex:${script.id}`, label: script.scriptName || script.findRegex }) })
      : null
    remove?.addEventListener('click', guard(async () => {
      if (!confirm(t`删除「${script.scriptName || script.findRegex}」？`)) return
      await save(scope.key, scope.scripts.filter(s => s.id !== script.id), { before: script })
      state.selected = null
      render()
    }))

    main.replaceChildren(
      el('div', { class: 'preset-head' }, [
        el('h2', { class: 'preset-title', text: state.draft ? t`新建正则` : script.scriptName || t`（没有名字）` }),
        el('div', { class: 'preset-meta', text: state.draft ? '' : scope.key === 'global' ? t`全局 · 所有对话都会用` : t`${scope.title}「${scope.note}」自带` }),
        !editable ? el('p', { class: 'hint', text: t`基础预设自带的正则：旧回复里的行动选项不再发给模型。不能改，也不能关。` }) : null,
      ]),
      el('div', { class: 'regex-form' }, [
        target ? field(t`放在`, target) : null,
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
      ]),
      el('div', { class: 'row end regex-actions' }, [aimed, remove, saveButton]),
    )
    changed()
  }

  function render() {
    renderList()
    renderEditor()
  }

  // ─── 对话修改 (talk-dialog.js) ─────────────────────────────────────────
  /** The talk on a scope's scripts; `aim` keeps the first request to one script. */
  function talkAbout(key, aim = null) {
    const scope = scopeOf(key)
    const id = key === 'global' ? 'global' : `${key}-${state[key].id}`
    openTalk?.({
      url: `/api/talk/regex/${id}`,
      title: t`对话修改正则`,
      name: key === 'global' ? t`全局` : t`${scope.title}「${scope.note}」`,
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
      context: () => ({ sample: state.sample }),
      targetLabel: target => {
        const script = scope.scripts.find(s => `regex:${s.id}` === target)
        return script?.scriptName || script?.findRegex || target.slice(6)
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

  /** What the talk saved or undid: the scope's scripts drawn again, the chat following them. */
  function talked(key, result, said) {
    const scripts = result.regex.scripts
    if (key === 'global') state.global = scripts
    else state[key].scripts = scripts
    onChanged(key, key === 'global' ? '' : state[key].id, scripts)
    if (state.selected?.scope === key && !scripts.some(s => s.id === state.selected.id)) state.selected = null
    if (dialog.open) render()
    toast(result.prefix ? [said, t`会改发给模型的内容，下一轮会重新写入一次缓存。`].join(t`。`) : said, result.prefix ? 6000 : 3000)
  }

  $('regex-new').addEventListener('click', () => {
    state.draft = {
      scope: 'global',
      script: { id: newId(), scriptName: '', findRegex: '', replaceString: '', trimStrings: [], placement: [PLACEMENT.AI_OUTPUT], disabled: false, markdownOnly: true, promptOnly: false, substituteRegex: 0, minDepth: null, maxDepth: null },
    }
    state.selected = null
    render()
  })
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
    await importScripts(scripts)
  }))

  /** SillyTavern scripts into the global ones. → how many were added. */
  async function importScripts(scripts) {
    const result = await api('/api/regex/import', { method: 'POST', body: { scripts } })
    state.global = result.scripts
    onChanged('global', '', result.scripts)
    if (dialog.open) render()
    toast(t`导入了 ${result.added} 条正则，放在全局，所有对话都会用`)
    return result.added
  }

  async function open() {
    const [global, ctx] = await Promise.all([api('/api/regex'), context()])
    state.global = global.scripts
    state.card = ctx.card
    state.preset = ctx.preset
    state.sample = ctx.sample ?? ''
    state.macros = ctx.macros ?? (text => text)
    state.draft = null
    if (state.selected && !scopeOf(state.selected.scope)?.scripts.some(s => s.id === state.selected.id)) state.selected = null
    render()
    if (!dialog.open) dialog.showModal()
  }

  return { open, importScripts }
}
