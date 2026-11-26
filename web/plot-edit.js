// 剧本 of a card (plans/22): the list (new, copy, import, export, default, delete) and the editor of one: an outline of
// its 幕 on the left, the one picked on the right, a check of its shape and its route map. Saved whole to the card
// (PUT /api/cards/:id/plots); chats already on a plot keep their own copy, which the same editor changes while playing
// (存回卡里, 另存为新剧本). The guide writes and changes plots too (web/plot-draft.js). Also the picker that puts a plot on
// a chat, and the endings reached on each (结局收集).
import { t } from '/i18n.js'
import { cleanPlot, ENDINGS, MAX_EXITS, MAX_POINTS, MAX_SCENES, MAX_SIDES, MAX_VARS, newPlotId, OPS, plotProblems, sceneOf, startProgress } from '/shared/plot.js'

const FILE_FORMAT = 'cicatavern-plot'
const ENDING_NAMES = () => ({ good: t`圆满`, normal: t`普通`, sad: t`遗憾`, hidden: t`隐藏` })
const TIGHT_NAMES = () => ({ loose: t`宽松`, steady: t`适中`, tight: t`严格` })
// The story's own endings (a side line's end only its part).
const countEndings = plot => plot.scenes.filter(scene => scene.ending && !scene.side).length
const draftUi = () => import('/plot-draft.js')

/** A structure problem (plotProblems) in the page's language. */
export function problemText(item) {
  const title = item.title ?? ''
  return {
    empty: t`剧本里还没有幕`,
    noExit: t`「${title}」既没有出口也不是结局`,
    unreached: t`从开头走不到「${title}」`,
    longWhat: t`「${title}」的梗概有点长，模型不容易抓住重点`,
    noWhat: t`「${title}」还没写要发生什么`,
    vagueFork: t`「${title}」有岔路，但有的出口没写什么时候走`,
    noEnding: t`还没有结局：至少把一幕标成结局`,
    sideNoEnding: t`支线「${title}」还没有结局`,
    sameWhen: t`「${title}」有两个出口的条件一样，模型分不开`,
    fewEndings: t`有岔路，但只有一个结局：岔路最后都走到同一个地方`,
  }[item.kind] ?? item.text
}

/** 达成过 n 个结局 (where the plot is chosen: an imported one does not say how many it has), or ''. */
export function reachedLine(plot, reached = {}) {
  const got = plot.scenes.filter(scene => scene.ending && reached?.[scene.id]).length
  return got ? t`达成过 ${got} 个结局` : ''
}

/** 达成 n / m 个结局, from the card's 结局收集 ({ [scene id]: { at, title, kind } } of one plot). */
export function endingsLine(plot, reached = {}) {
  const ends = plot.scenes.filter(scene => scene.ending && !scene.side)
  const got = ends.filter(scene => reached[scene.id]).length
  return ends.length ? t`达成 ${got} / ${ends.length} 个结局` : ''
}

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 1)], { type: 'application/json' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A plot to start from: a first scene that is also its ending, ready to grow. */
function blankPlot() {
  const first = newPlotId('s')
  const end = newPlotId('s', new Set([first]))
  return cleanPlot({ name: t`新剧本`, scenes: [{ id: first, title: t`开场`, what: '', exits: [{ to: end }] }, { id: end, title: t`结局`, ending: { kind: 'good', text: '' } }] })
}

/**
 * The card's plots in a dialog. `deps`: { api, el, guard, toast, cardId, cardName, onSaved(plots) }; `open`: a plot id to
 * open in the editor straight away. `chat` (with `setChat`): the copy that chat plays, in the editor alone (改剧本 while
 * playing): saved to the chat; 存回卡里 and 另存为新剧本 put it in the card's. `forge`: the id of a card being made in
 * 创作角色卡 instead of `cardId` (its plots kept with the draft, saved with the card; no chats on it yet). `fromChat`: the
 * id of the card's chat open now, whose model the guide writes with.
 */
export async function openPlots({ api, el, guard, toast, cardId, cardName, onSaved = () => {}, forge = '', fromChat = '' }, { open = null, chat = null, setChat = () => {}, write = false } = {}) {
  const plotsUrl = forge ? `/api/forge/${forge}/plots` : `/api/cards/${cardId}/plots`
  const draftKey = forge ? `forge-${forge}` : `card-${cardId}`
  const [loaded, detail, chats] = await Promise.all([
    api(plotsUrl),
    // The card's openings (a plot may name one) and its chats (which play which plot).
    forge ? null : api(`/api/cards/${cardId}`).catch(() => null),
    forge ? [] : api(`/api/chats?cardId=${cardId}`).catch(() => []),
  ])
  const greetings = loaded.greetings ?? detail?.greetingTexts ?? []
  const state = { plots: loaded.plots, defaultPlot: loaded.defaultPlot, endings: loaded.endings ?? {}, editing: null, scene: null, dirty: false }
  const dialog = el('dialog', { class: 'dialog wide plot-dialog', 'aria-label': t`剧本` })
  const body = el('div', { class: 'plot-dialog-body' })
  dialog.append(body)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.addEventListener('cancel', event => {
    if (state.editing && state.dirty && !confirm(t`这个剧本改了还没保存，确定关掉？`)) event.preventDefault()
  })

  async function save(plots = state.plots, defaultPlot = state.defaultPlot) {
    const saved = await api(plotsUrl, { method: 'PUT', body: { plots, defaultPlot } })
    state.plots = saved.plots
    state.defaultPlot = saved.defaultPlot
    state.endings = saved.endings ?? state.endings
    onSaved(saved)
    return saved
  }

  // 结局收集: the endings reached, with when; those not reached yet are ？？？.
  function endingsBox(plot) {
    // 创作角色卡: no chat has played it yet.
    if (forge) return null
    const reached = state.endings[plot.id] ?? {}
    const line = endingsLine(plot, reached)
    if (!line) return null
    const ends = plot.scenes.filter(scene => scene.ending && !scene.side)
    return el('details', { class: 'plot-endings' }, [
      el('summary', { class: 'small', text: line }),
      el('ul', {}, ends.map(scene => {
        const got = reached[scene.id]
        return el('li', { class: got ? 'got' : '' }, got
          ? [el('span', { class: `plot-badge end ${scene.ending.kind}`, text: ENDING_NAMES()[scene.ending.kind] }), el('span', { text: scene.title }), el('small', { class: 'muted', text: new Date(got.at).toLocaleDateString() })]
          : [el('span', { class: 'muted', text: t`？？？` })])
      })),
    ])
  }

  // The chats of the card on this plot (each with its own copy of it).
  function usedBy(plot) {
    const on = (Array.isArray(chats) ? chats : []).filter(chat => chat.plot?.id === plot.id)
    if (!on.length) return null
    return el('p', { class: 'muted small plot-used', title: on.map(chat => chat.title).join('\n'), text: on.length > 2 ? t`在用的对话：${on.slice(0, 2).map(chat => chat.title).join(t`、`)} 等 ${on.length} 段` : t`在用的对话：${on.map(chat => chat.title).join(t`、`)}` })
  }

  // 让向导写一份: the guide's window (its settings in full), the plot taken goes in and opens in the editor.
  async function writeOne() {
    const { openPlotDraft } = await draftUi()
    await openPlotDraft({ api, el, guard, toast, problemText }, { key: draftKey, mode: 'write', openings: greetings, chatId: fromChat, onTake: async plot => {
      const id = newPlotId('plot', new Set(state.plots.map(item => item.id)))
      await save([...state.plots, { ...plot, id, source: 'own' }], state.defaultPlot || (forge ? id : ''))
      toast(t`已放进剧本「${plot.name}」`)
      drawEditor(id)
    } })
  }

  // ─── The list ───────────────────────────────────────────────────────────
  function drawList() {
    state.editing = null
    // Ours (.json), or a story's shape from Twine (.twee, .tw, its .html) or Ink (.ink): web/shared/plot-import.js.
    const file = el('input', { type: 'file', accept: '.json,application/json,.twee,.tw,.html,.htm,.ink,.txt', hidden: true })
    file.addEventListener('change', guard(async () => {
      const picked = file.files[0]
      file.value = ''
      if (!picked) return
      const text = await picked.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        // not ours: Twine or Ink, below
      }
      const plot = data ? cleanPlot(data?.format === FILE_FORMAT ? data.plot : data) : (await import('/shared/plot-import.js')).plotFromFile(picked.name, text)
      if (!plot) throw new Error(t`这个文件不是剧本`)
      await save([...state.plots, { ...plot, id: newPlotId('plot', new Set(state.plots.map(item => item.id))), source: 'imported' }])
      toast(t`已导入「${plot.name}」`)
      drawList()
    }))
    const rows = state.plots.map(plot => {
      const { blocking } = plotProblems(plot)
      return el('li', { class: 'plot-row' }, [
        el('div', { class: 'plot-row-main' }, [
          el('b', { text: plot.name }),
          plot.id === state.defaultPlot ? el('span', { class: 'plot-badge', text: t`默认` }) : null,
          plot.source === 'imported' ? el('span', { class: 'plot-badge soft', text: t`别人做的` }) : null,
          blocking.length ? el('span', { class: 'plot-badge warn', text: t`还不能用`, title: problemText(blocking[0]) }) : null,
          el('p', { class: 'muted small', text: [plot.intro, t`${plot.scenes.length} 幕 · ${countEndings(plot)} 个结局 · ${TIGHT_NAMES()[plot.tightness]}`].filter(Boolean).join(' · ') }),
          endingsBox(plot),
          usedBy(plot),
        ].filter(Boolean)),
        el('div', { class: 'plot-row-tools' }, [
          el('button', { type: 'button', class: 'btn small', text: t`编辑`, onclick: () => drawEditor(plot.id) }),
          el('button', { type: 'button', class: 'btn small ghost', text: plot.id === state.defaultPlot ? t`取消默认` : t`设为默认`, title: t`开新对话时默认选它`, onclick: guard(async () => {
            await save(state.plots, plot.id === state.defaultPlot ? '' : plot.id)
            drawList()
          }) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`复制`, onclick: guard(async () => {
            await save([...state.plots, { ...structuredClone(plot), id: newPlotId('plot', new Set(state.plots.map(item => item.id))), name: t`${plot.name}（副本）`, source: 'own' }])
            drawList()
          }) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`导出`, onclick: () => download(`${plot.name}.cicaplot.json`, { format: FILE_FORMAT, version: 1, plot }) }),
          el('button', { type: 'button', class: 'btn small ghost danger', text: t`删除`, onclick: guard(async () => {
            if (!confirm(t`删除剧本「${plot.name}」？正在用它的对话有自己的一份，不受影响。`)) return
            await save(state.plots.filter(item => item.id !== plot.id))
            drawList()
          }) }),
        ]),
      ])
    })
    body.replaceChildren(
      el('div', { class: 'plot-dialog-head' }, [
        el('h2', { text: t`「${cardName}」的剧本` }),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`关闭`, onclick: () => dialog.close() }),
      ]),
      el('p', { class: 'muted small', text: t`剧本让故事按写好的路线走：一幕一幕往下，有岔路和结局。开新对话时选一个，玩到一半也能从顶栏「剧本」挂上。` }),
      rows.length ? el('ul', { class: 'plot-list' }, rows) : el('p', { class: 'plot-empty', text: t`还没有剧本。新建一个，或者导入别人分享的剧本文件。` }),
      el('div', { class: 'row end' }, [
        file,
        el('button', { type: 'button', class: 'btn small', text: t`导入…`, onclick: () => file.click() }),
        el('button', { type: 'button', class: 'btn small', text: t`让向导写一份`, title: t`写一句想法或贴一段大纲，向导读这张卡写剧本`, onclick: guard(() => writeOne()) }),
        el('button', { type: 'button', class: 'btn small primary', text: t`新建剧本`, onclick: guard(async () => {
          const plot = { ...blankPlot(), id: newPlotId('plot', new Set(state.plots.map(item => item.id))) }
          await save([...state.plots, plot])
          drawEditor(plot.id)
        }) }),
      ]),
    )
  }

  // ─── The editor ─────────────────────────────────────────────────────────
  function drawEditor(id) {
    const original = chat ? state.copy : state.plots.find(plot => plot.id === id)
    if (!original) return drawList()
    state.editing = structuredClone(original)
    state.scene = state.editing.start
    state.dirty = false
    state.undo = []
    state.snap = JSON.stringify(state.editing)
    drawEditing()
  }

  // 撤销: each change keeps the plot as it was before it; typing in one box is one step (until a pause).
  const touch = (kind = 'edit') => {
    const now = Date.now()
    if (!(kind === 'type' && state.typing === kind && now - state.typedAt < 1500)) state.undo = [...(state.undo ?? []), state.snap].slice(-60)
    state.typing = kind
    state.typedAt = now
    state.snap = JSON.stringify(state.editing)
    state.dirty = true
  }
  const undo = () => {
    const before = state.undo?.pop()
    if (!before) return
    state.editing = JSON.parse(before)
    state.snap = before
    state.typing = ''
    if (!sceneOf(state.editing, state.scene)) state.scene = state.editing.start
    drawEditing()
  }

  // 帮我写: the guide writes one box of one scene; the editor takes it as the player's own typing (撤销 undoes it).
  async function helpWrite(scene, fieldName) {
    const plot = state.editing
    state.helping = `${scene.id}:${fieldName}`
    drawEditing()
    try {
      const url = `/api/plot-drafts/${chat ? `chat-${chat.id}` : draftKey}`
      let view = await api(url, { method: 'POST', body: { kind: 'field', plot: cleanPlot(plot), scene: scene.id, field: fieldName } })
      while (view.job) {
        await new Promise(resolve => setTimeout(resolve, 800))
        view = await api(url)
      }
      if (view.error) throw new Error(view.error.message)
      const value = view.result?.value
      const target = sceneOf(state.editing, scene.id)
      if (!value || !target) return
      if (fieldName === 'points') target.points = value.map(text => ({ id: newPlotId('p', new Set(target.points.map(point => point.id))), text }))
      else if (fieldName === 'ending') target.ending = { ...(target.ending ?? { kind: 'normal' }), text: value }
      else target[fieldName] = value
      touch()
    } finally {
      state.helping = ''
      drawEditing()
    }
  }

  /** A scene moved to another line: its ways across lines go (a way on stays on its line), and the ways to it. */
  function moveScene(scene, side) {
    const plot = state.editing
    if (side) scene.side = side
    else delete scene.side
    const lineOf = item => item?.side ?? ''
    scene.exits = scene.exits.filter(exit => lineOf(sceneOf(plot, exit.to)) === lineOf(scene))
    for (const item of plot.scenes) if (lineOf(item) !== lineOf(scene)) item.exits = item.exits.filter(exit => exit.to !== scene.id)
    if (!side && !plot.scenes.some(item => item.id === plot.start && !item.side)) plot.start = scene.id
    touch()
    drawEditing()
  }

  /** 支线: up to MAX_SIDES small stories beside the main one, each opened by a scene of the main line. */
  function sidesBox() {
    const plot = state.editing
    const sides = plot.sides ?? []
    const mains = plot.scenes.filter(scene => !scene.side)
    const rows = sides.map(side => {
      const name = el('input', { type: 'text', maxlength: '20', value: side.name })
      name.addEventListener('input', () => {
        side.name = name.value
        touch()
      })
      const opens = el('select', { 'aria-label': t`什么时候开` }, [['', t`一开始就开`], ...mains.map(scene => [scene.id, t`走到「${scene.title}」时开`])].map(([v, label]) => el('option', { value: v, text: label, selected: v === side.opens })))
      opens.addEventListener('change', () => {
        side.opens = opens.value
        touch()
      })
      const own = plot.scenes.filter(scene => scene.side === side.id)
      return el('div', { class: 'plot-side-row' }, [
        name,
        opens,
        el('button', { type: 'button', class: 'btn small ghost', text: t`${own.length} 幕`, title: t`看这条支线的第一幕`, onclick: () => {
          state.scene = side.start
          drawEditing()
        } }),
        el('button', { type: 'button', class: 'btn small ghost danger', text: '×', title: t`删掉这条支线`, onclick: () => {
          if (!confirm(t`删掉支线「${side.name}」和它的 ${own.length} 幕？`)) return
          plot.sides = sides.filter(item => item !== side)
          plot.scenes = plot.scenes.filter(scene => scene.side !== side.id)
          for (const scene of plot.scenes) scene.exits = scene.exits.filter(exit => sceneOf(plot, exit.to))
          if (!sceneOf(plot, state.scene)) state.scene = plot.start
          touch()
          drawEditing()
        } }),
      ])
    })
    return el('details', { class: 'plot-sides-edit', open: sides.length > 0 }, [
      el('summary', { text: sides.length ? t`支线（${sides.length}）` : t`支线` }),
      el('p', { class: 'muted small', text: t`和主线并行的小故事，最多 ${MAX_SIDES} 条，各走各的、各有结局。走到主线上的某一幕时开，开了以后模型在玩家往那边走时穿插着演。` }),
      ...rows,
      el('button', { type: 'button', class: 'btn small', text: t`加一条支线`, disabled: sides.length >= MAX_SIDES || plot.scenes.length + 2 > MAX_SCENES, onclick: () => {
        const taken = new Set(plot.scenes.map(scene => scene.id))
        const id = newPlotId('side', new Set(sides.map(side => side.id)))
        const first = newPlotId('s', taken)
        taken.add(first)
        const end = newPlotId('s', taken)
        plot.sides = [...sides, { id, name: t`支线${sides.length + 1}`, start: first, opens: '' }]
        plot.scenes.push(
          { id: first, side: id, title: t`支线开头`, chapter: '', what: '', points: [], done: '', style: '', minTurns: 1, maxTurns: null, exits: [{ to: end, when: '', hint: '' }], ending: null },
          { id: end, side: id, title: t`支线结局`, chapter: '', what: '', points: [], done: '', style: '', minTurns: 1, maxTurns: null, exits: [], ending: { kind: 'normal', text: '' } },
        )
        state.scene = first
        touch()
        drawEditing()
      } }),
    ])
  }

  function drawEditing() {
    const plot = state.editing
    const { blocking, hints } = plotProblems(plot)
    const bad = new Set(blocking.map(item => item.scene).filter(Boolean))
    const field = (label, input, hint = '') => el('label', { class: 'plot-field' }, [typeof label === 'string' ? el('span', { text: label }) : label, input, hint ? el('small', { class: 'muted', text: hint }) : null].filter(Boolean))
    // A label with 帮我写 beside it.
    const helped = (label, fieldName) => el('span', { class: 'plot-field-label' }, [
      el('span', { text: label }),
      el('button', { type: 'button', class: 'btn small ghost plot-help', text: state.helping === `${state.scene}:${fieldName}` ? t`向导在写……` : t`帮我写`, disabled: Boolean(state.helping), title: t`让向导按这张卡和前后的幕只写这一格`, onclick: guard(event => {
        event.preventDefault()
        return helpWrite(sceneOf(state.editing, state.scene) ?? state.editing.scenes[0], fieldName)
      }) }),
    ])
    const text = (value, max, onInput, { area = false, rows = 3, placeholder = '' } = {}) => {
      const input = el(area ? 'textarea' : 'input', { ...(area ? { rows: String(rows) } : { type: 'text' }), maxlength: String(max), placeholder })
      input.value = value ?? ''
      input.addEventListener('input', () => {
        onInput(input.value)
        touch('type')
      })
      return input
    }
    const select = (options, value, onChange) => {
      const box = el('select', {}, options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })))
      box.addEventListener('change', () => {
        onChange(box.value)
        touch()
        drawEditing()
      })
      return box
    }
    const top = el('div', { class: 'plot-top' }, [
      field(t`名称`, text(plot.name, 40, v => { plot.name = v })),
      field(t`简介`, text(plot.intro, 200, v => { plot.intro = v }, { placeholder: t`给玩家看的一两句，不剧透` })),
      field(t`故事总览`, text(plot.summary, 300, v => { plot.summary = v }, { placeholder: t`给模型看的：整个故事讲什么` })),
      field(t`剧本约束`, select(Object.entries(TIGHT_NAMES()), plot.tightness, v => { plot.tightness = v })),
      greetings.length > 1 ? field(t`配哪个开场白`, select([['', t`不指定`], ...greetings.map((text, index) => [String(index), `${index + 1}. ${text.replace(/\s+/g, ' ').slice(0, 24)}`])], plot.greeting === null || plot.greeting === undefined ? '' : String(plot.greeting), v => { plot.greeting = v === '' ? null : Number(v) })) : null,
    ].filter(Boolean))
    // Outline: the scenes in order, each with what it is.
    // 拖动换顺序: a scene dropped on another goes before it.
    const drag = scene => ({
      draggable: 'true',
      ondragstart: event => {
        state.dragging = scene.id
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', scene.id)
      },
      ondragover: event => {
        if (!state.dragging || state.dragging === scene.id) return
        event.preventDefault()
        event.currentTarget.classList.add('drop')
      },
      ondragleave: event => event.currentTarget.classList.remove('drop'),
      ondrop: event => {
        event.preventDefault()
        const moving = sceneOf(plot, state.dragging)
        state.dragging = null
        if (!moving || moving === scene) return
        plot.scenes = plot.scenes.filter(item => item !== moving)
        plot.scenes.splice(plot.scenes.indexOf(scene), 0, moving)
        touch()
        drawEditing()
      },
      ondragend: () => {
        state.dragging = null
      },
    })
    const outline = el('ol', { class: 'plot-outline' }, plot.scenes.map((scene, index) => el('li', {
      class: `${scene.id === state.scene ? 'picked' : ''}${bad.has(scene.id) ? ' bad' : ''}`,
      title: t`拖动换顺序`,
      ...drag(scene),
    }, [el('button', { type: 'button', onclick: () => {
      state.scene = scene.id
      drawEditing()
    } }, [
      el('span', { class: 'plot-num', text: String(index + 1) }),
      el('span', { class: 'plot-otitle', text: `${scene.chapter ? `${scene.chapter} · ` : ''}${scene.title}` }),
      scene.id === plot.start ? el('span', { class: 'plot-badge', text: t`起点` }) : null,
      scene.side ? el('span', { class: 'plot-badge soft', text: t`支线 · ${(plot.sides ?? []).find(side => side.id === scene.side)?.name ?? ''}` }) : null,
      scene.ending ? el('span', { class: `plot-badge end ${scene.ending.kind}`, text: t`${ENDING_NAMES()[scene.ending.kind]}结局` }) : el('span', { class: 'muted small', text: scene.exits.length ? `→ ${scene.exits.map(exit => sceneOf(plot, exit.to)?.title ?? '').join(' / ')}` : t`（没有出口）` }),
    ].filter(Boolean))])))
    const scene = sceneOf(plot, state.scene) ?? plot.scenes[0]
    const move = step => {
      const index = plot.scenes.indexOf(scene)
      const to = index + step
      if (to < 0 || to >= plot.scenes.length) return
      plot.scenes.splice(index, 1)
      plot.scenes.splice(to, 0, scene)
      touch()
      drawEditing()
    }
    const outlineTools = el('div', { class: 'plot-outline-tools' }, [
      el('button', { type: 'button', class: 'btn small', text: t`加一幕`, disabled: plot.scenes.length >= MAX_SCENES, onclick: () => {
        const id = newPlotId('s', new Set(plot.scenes.map(item => item.id)))
        plot.scenes.splice(plot.scenes.indexOf(scene) + 1, 0, { id, title: t`第 ${plot.scenes.length + 1} 幕`, chapter: scene.chapter, what: '', points: [], done: '', style: '', minTurns: 2, maxTurns: null, exits: [], ending: null, ...(scene.side ? { side: scene.side } : {}) })
        if (!scene.ending && scene.exits.length < MAX_EXITS && !scene.exits.length) scene.exits.push({ to: id, when: '', hint: '' })
        state.scene = id
        touch()
        drawEditing()
      } }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↑', title: t`往前挪`, onclick: () => move(-1) }),
      el('button', { type: 'button', class: 'btn small ghost', text: '↓', title: t`往后挪`, onclick: () => move(1) }),
      el('button', { type: 'button', class: 'btn small ghost danger', text: t`删除这一幕`, disabled: plot.scenes.length <= 1, onclick: () => {
        if (!confirm(t`删除「${scene.title}」？通往它的出口也会去掉。`)) return
        plot.scenes = plot.scenes.filter(item => item !== scene)
        for (const item of plot.scenes) item.exits = item.exits.filter(exit => exit.to !== scene.id && exit.needs?.seen !== scene.id && exit.needs?.unseen !== scene.id)
        if (plot.start === scene.id) plot.start = plot.scenes[0].id
        state.scene = plot.start
        touch()
        drawEditing()
      } }),
    ])
    const lineOf = item => item?.side ?? ''
    const others = plot.scenes.filter(item => item !== scene && lineOf(item) === lineOf(scene)).map(item => [item.id, item.title])
    const points = Array.from({ length: MAX_POINTS }, (_, i) => text(scene.points[i]?.text ?? '', 80, v => {
      const list = Array.from({ length: MAX_POINTS }, (_, j) => (j === i ? { id: scene.points[j]?.id, text: v } : scene.points[j] ?? { text: '' }))
      scene.points = list.filter(point => point.text.trim()).map(point => ({ id: point.id || newPlotId('p', new Set(scene.points.map(item => item.id))), text: point.text }))
    }, { placeholder: i ? '' : t`必须出现的事、人物或物件` }))
    const number = (value, onInput, { min = 0, max = 99, blank = false } = {}) => {
      const input = el('input', { type: 'number', min: String(min), max: String(max), class: 'plot-number' })
      input.value = value ?? ''
      if (blank) input.placeholder = t`不限`
      input.addEventListener('input', () => {
        onInput(input.value === '' ? null : Number(input.value))
        touch()
      })
      return input
    }
    // 程序判的条件: one kind per exit here (a plot from elsewhere may have more; they stay until this one is changed).
    const needOf = exit => (exit.needs?.vars?.length ? 'var' : exit.needs?.check ? `check:${exit.needs.check}` : exit.needs?.battle ? `battle:${exit.needs.battle}` : exit.needs?.seen ? `seen:${exit.needs.seen}` : exit.needs?.unseen ? `unseen:${exit.needs.unseen}` : '')
    const needs = [
      ['', t`不限`],
      ['var', t`变量满足条件才开`],
      ['check:pass', t`这一幕检定成功才开`],
      ['check:fail', t`这一幕检定失败才开`],
      ['battle:won', t`这一幕战斗打赢才开`],
      ['battle:lost', t`这一幕战斗打输才开`],
      ...plot.scenes.map(item => [`seen:${item.id}`, t`走过「${item.title}」才开`]),
      ...plot.scenes.map(item => [`unseen:${item.id}`, t`没走过「${item.title}」才开`]),
    ]
    const ruled = exit => Boolean(exit.needs?.vars?.length || exit.needs?.check || exit.needs?.battle)
    const varRows = exit => el('div', { class: 'plot-vars' }, [
      ...exit.needs.vars.map((cond, i) => el('div', { class: 'plot-var' }, [
        text(cond.path, 80, v => { cond.path = v }, { placeholder: t`变量，比如 好感度` }),
        select(OPS.map(op => [op, { '>=': '≥', '<=': '≤', '!=': '≠' }[op] ?? op]), cond.op, v => { cond.op = v }),
        text(String(cond.value ?? ''), 40, v => { cond.value = v }, { placeholder: '60' }),
        exit.needs.vars.length > 1 ? el('button', { type: 'button', class: 'btn small ghost danger', text: '×', onclick: () => {
          exit.needs.vars.splice(i, 1)
          touch()
          drawEditing()
        } }) : null,
      ].filter(Boolean))),
      exit.needs.vars.length < MAX_VARS ? el('button', { type: 'button', class: 'btn small ghost', text: t`再加一条（都满足才开）`, onclick: () => {
        exit.needs.vars.push({ path: '', op: '>=', value: '' })
        touch()
        drawEditing()
      } }) : null,
      el('small', { class: 'muted', text: t`变量名照状态栏里的写；MVU 卡不用写 stat_data。` }),
    ].filter(Boolean))
    const autoBox = exit => {
      const box = el('input', { type: 'checkbox', checked: exit.auto === true })
      box.addEventListener('change', () => {
        if (box.checked) exit.auto = true
        else delete exit.auto
        touch()
      })
      return el('label', { class: 'plot-check small' }, [box, el('span', { text: t`满足就走（不等模型）` })])
    }
    const exitRows = scene.ending ? [] : scene.exits.map((exit, index) => el('div', { class: 'plot-exit-wrap' }, [
      el('div', { class: 'plot-exit' }, [
        el('span', { class: 'plot-num', text: String(index + 1) }),
        select(others.length ? others : [['', t`（没有别的幕）`]], exit.to, v => { exit.to = v }),
        text(exit.when, 120, v => { exit.when = v }, { placeholder: t`什么时候走这条：玩家答应同行` }),
        text(exit.hint, 40, v => { exit.hint = v }, { placeholder: t`岔路卡上的说法（可空）` }),
        select(needs, needOf(exit), v => {
          delete exit.auto
          if (!v) delete exit.needs
          else if (v === 'var') exit.needs = { vars: [{ path: '', op: '>=', value: '' }] }
          else {
            const [kind, id] = v.split(':')
            exit.needs = { [kind]: id }
          }
        }),
        el('button', { type: 'button', class: 'btn small ghost danger', text: '×', title: t`去掉这个出口`, onclick: () => {
          scene.exits.splice(index, 1)
          touch()
          drawEditing()
        } }),
      ]),
      exit.needs?.vars?.length || ruled(exit) ? el('div', { class: 'plot-exit-more' }, [exit.needs?.vars?.length ? varRows(exit) : null, ruled(exit) ? autoBox(exit) : null].filter(Boolean)) : null,
    ].filter(Boolean)))
    const endingBox = el('input', { type: 'checkbox', checked: Boolean(scene.ending) })
    endingBox.addEventListener('change', () => {
      scene.ending = endingBox.checked ? { kind: 'good', text: '' } : null
      if (scene.ending) scene.exits = []
      touch()
      drawEditing()
    })
    const form = el('div', { class: 'plot-form' }, [
      el('div', { class: 'plot-form-head' }, [
        el('h3', { text: scene.title }),
        scene.side
          ? (plot.sides ?? []).find(side => side.id === scene.side)?.start === scene.id ? el('span', { class: 'plot-badge', text: t`支线起点` }) : el('button', { type: 'button', class: 'btn small ghost', text: t`设为这条支线的起点`, onclick: () => {
            plot.sides.find(side => side.id === scene.side).start = scene.id
            touch()
            drawEditing()
          } })
          : scene.id === plot.start ? el('span', { class: 'plot-badge', text: t`起点` }) : el('button', { type: 'button', class: 'btn small ghost', text: t`设为起点`, onclick: () => {
            plot.start = scene.id
            touch()
            drawEditing()
          } }),
        plot.sides?.length ? select([['', t`主线`], ...plot.sides.map(side => [side.id, t`支线 · ${side.name}`])], scene.side ?? '', v => moveScene(scene, v)) : null,
      ]),
      el('div', { class: 'plot-grid' }, [
        field(t`标题`, text(scene.title, 40, v => { scene.title = v })),
        field(t`章（可空）`, text(scene.chapter, 30, v => { scene.chapter = v }, { placeholder: t`第一章` })),
      ]),
      field(helped(t`要发生什么`, 'what'), text(scene.what, 400, v => { scene.what = v }, { area: true, rows: 3, placeholder: t`一两百字以内：这一幕的事` })),
      field(helped(t`要点（最多 ${MAX_POINTS} 条）`, 'points'), el('div', { class: 'plot-points-edit' }, points), t`模型演到一条就会打勾`),
      field(helped(t`演到什么算完`, 'done'), text(scene.done, 120, v => { scene.done = v }, { placeholder: t`两人说上了话` })),
      field(helped(t`写法（可空）`, 'style'), text(scene.style, 200, v => { scene.style = v }, { placeholder: t`这一幕的气氛、节奏、禁忌` })),
      el('div', { class: 'plot-grid' }, [
        field(t`至少演几轮`, number(scene.minTurns, v => { scene.minTurns = v ?? 0 }, { max: 50 })),
        field(t`最多几轮（超过就催收尾）`, number(scene.maxTurns, v => { scene.maxTurns = v }, { min: 1, blank: true })),
      ]),
      el('label', { class: 'plot-check' }, [endingBox, el('span', { text: t`这一幕是结局` })]),
      scene.ending ? el('div', { class: 'plot-grid' }, [
        field(t`结局类型`, select(ENDINGS.map(kind => [kind, ENDING_NAMES()[kind]]), scene.ending.kind, v => { scene.ending.kind = v })),
        field(helped(t`收场要求`, 'ending'), text(scene.ending.text, 200, v => { scene.ending.text = v }, { placeholder: t`在海边把话说开` })),
      ]) : el('div', { class: 'plot-exits' }, [
        el('h4', { text: t`出口（最多 ${MAX_EXITS} 个；两个以上就是岔路）` }),
        ...exitRows,
        el('button', { type: 'button', class: 'btn small', text: t`加出口`, disabled: scene.exits.length >= MAX_EXITS || !others.length, onclick: () => {
          scene.exits.push({ to: others[0][0], when: '', hint: '' })
          touch()
          drawEditing()
        } }),
      ]),
    ].filter(Boolean))
    const problems = el('div', { class: 'plot-problems' }, [
      ...blocking.map(item => el('p', { class: 'bad small', text: `⚠ ${problemText(item)}` })),
      ...hints.slice(0, 4).map(item => el('p', { class: 'muted small', text: `· ${problemText(item)}` })),
      !blocking.length && !hints.length ? el('p', { class: 'ok small', text: t`结构没问题` }) : null,
    ].filter(Boolean))
    const mapBox = el('div', { class: 'plot-preview', hidden: true })
    body.replaceChildren(
      el('div', { class: 'plot-dialog-head' }, [
        chat ? null : el('button', { type: 'button', class: 'btn small ghost', text: t`← 全部剧本`, onclick: () => {
          if (state.dirty && !confirm(t`这个剧本改了还没保存，确定返回？`)) return
          drawList()
        } }),
        el('h2', { text: chat ? t`这段对话的剧本：${plot.name || t`未命名剧本`}` : plot.name || t`未命名剧本` }),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn small', text: t`问问向导改`, title: t`说一句想怎么改，向导列出改动，逐条勾选`, onclick: guard(async () => {
          const { openPlotDraft } = await draftUi()
          const locked = chat ? [...new Set(chat.plot.progress.seen)] : []
          await openPlotDraft({ api, el, guard, toast, problemText }, { key: chat ? `chat-${chat.id}` : draftKey, mode: 'edit', plot: cleanPlot(plot), locked, chatId: fromChat, onTake: changed => {
            state.editing = structuredClone({ ...changed, id: plot.id, source: plot.source })
            if (!sceneOf(state.editing, state.scene)) state.scene = state.editing.start
            touch()
            drawEditing()
            toast(t`改动放进来了，看过再保存`)
          } })
        }) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`撤销`, title: t`撤销上一步（这次打开以来的）`, disabled: !state.undo?.length, onclick: undo }),
        el('button', { type: 'button', class: 'btn small', text: t`预览路线图`, onclick: guard(async () => {
          mapBox.hidden = !mapBox.hidden
          if (mapBox.hidden) return
          const { plotMap } = await import('/plot-map.js')
          const copy = cleanPlot(plot)
          mapBox.replaceChildren(plotMap({ copy, progress: startProgress(copy), spoiler: 'all' }, { el, guard, preview: true, onJump: id => {
            state.scene = id
            drawEditing()
          }, onSpoiler: () => {} }))
        }) }),
        chat ? el('button', { type: 'button', class: 'btn small ghost', text: t`存回卡里`, title: t`用这一份覆盖卡里的原稿`, onclick: guard(async () => {
          if (!confirm(t`用这段对话里的「${plot.name}」覆盖卡里的原稿？别的对话不受影响。`)) return
          const cleaned = cleanPlot(plot)
          const known = state.plots.some(item => item.id === plot.id)
          await save(known ? state.plots.map(item => (item.id === plot.id ? { ...cleaned, source: item.source } : item)) : [...state.plots, { ...cleaned, source: 'own' }])
          // The chat takes the card's as now saved: no 有新版本 for what it just wrote.
          if (!state.dirty) setChat(await api(`/api/chats/${chat.id}/plot`, { method: 'PUT', body: { action: 'refresh' } }))
          toast(t`已存回卡里`)
        }) }) : null,
        chat ? el('button', { type: 'button', class: 'btn small ghost', text: t`另存为新剧本`, onclick: guard(async () => {
          const cleaned = cleanPlot(plot)
          await save([...state.plots, { ...cleaned, id: newPlotId('plot', new Set(state.plots.map(item => item.id))), name: t`${cleaned.name}（另存）`, source: 'own' }])
          toast(t`已另存为新剧本`)
        }) }) : null,
        el('button', { type: 'button', class: 'btn small primary', text: t`保存`, onclick: guard(async () => {
          const cleaned = cleanPlot(plot)
          if (chat) {
            const answer = await api(`/api/chats/${chat.id}/plot`, { method: 'PUT', body: { action: 'edit', copy: cleaned } })
            setChat(answer)
            state.copy = answer.plot?.copy ?? cleaned
            state.editing = structuredClone(state.copy)
          } else {
            await save(state.plots.map(item => (item.id === plot.id ? cleaned : item)))
            state.editing = structuredClone(state.plots.find(item => item.id === plot.id))
          }
          state.dirty = false
          state.snap = JSON.stringify(state.editing)
          toast(blocking.length ? t`已保存；这个剧本还不能用：${problemText(blocking[0])}` : t`已保存`)
          drawEditing()
        }) }),
      ].filter(Boolean)),
      top,
      sidesBox(),
      problems,
      mapBox,
      el('div', { class: 'plot-columns' }, [el('div', { class: 'plot-left' }, [outline, outlineTools]), form]),
    )
  }

  if (chat?.plot?.copy) {
    state.copy = chat.plot.copy
    drawEditor(chat.plot.copy.id)
  } else if (open && state.plots.some(plot => plot.id === open)) drawEditor(open)
  else drawList()
  // Opened to write one (创作角色卡 → 剧本 → 让向导写一份): the guide's window over the list.
  if (write) setTimeout(() => guard(writeOne)(), 0)
  dialog.showModal()
}

/**
 * 用剧本 on a chat already going: pick one of the card's plots and the scene to start at. → resolves when put on.
 * `deps`: { api, el, guard, cardId, cardName, chat, setChat, manage(), fromChat(): 把这段对话整理成剧本 }.
 */
export async function pickPlot({ api, el, guard, cardId, cardName, chat, setChat, manage, fromChat = null }) {
  const { plots, defaultPlot, endings = {} } = await api(`/api/cards/${cardId}/plots`)
  const dialog = el('dialog', { class: 'dialog plot-pick', 'aria-label': t`用剧本` })
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  let picked = plots.find(plot => plot.id === defaultPlot) ?? plots[0] ?? null
  // 让向导看看: the scene the guide named for each plot asked about.
  const suggested = {}
  let asking = false
  const draw = () => {
    const starts = picked ? picked.scenes.filter(scene => !scene.side).map(scene => [scene.id, scene.title]) : []
    const chosen = suggested[picked?.id]?.at ?? picked?.start
    const start = el('select', {}, starts.map(([id, title]) => el('option', { value: id, text: picked.source === 'imported' && id !== picked.start && id !== suggested[picked.id]?.at ? t`第 ${starts.findIndex(([s]) => s === id) + 1} 幕` : title, selected: id === chosen })))
    dialog.replaceChildren(
      el('h2', { text: t`给这段对话用剧本` }),
      plots.length
        ? el('div', { class: 'plot-choices' }, plots.map(plot => {
          const { blocking } = plotProblems(plot)
          const radio = el('input', { type: 'radio', name: 'plot-pick', checked: plot === picked, disabled: blocking.length > 0 })
          radio.addEventListener('change', () => {
            picked = plot
            draw()
          })
          return el('label', { class: `plot-choice${blocking.length ? ' off' : ''}` }, [radio, el('span', {}, [
            el('b', { text: plot.name }),
            el('small', { class: 'muted', text: blocking.length ? problemText(blocking[0]) : [plot.intro, plot.source === 'imported' ? t`${plot.scenes.length} 幕 · 多个结局` : t`${plot.scenes.length} 幕 · ${countEndings(plot)} 个结局`, reachedLine(plot, endings[plot.id])].filter(Boolean).join(' · ') }),
          ])])
        }))
        : el('p', { class: 'muted', text: t`「${cardName}」还没有剧本。` }),
      picked ? el('label', { class: 'plot-field' }, [el('span', { text: t`从哪一幕开始` }), start, el('small', { class: 'muted', text: suggested[picked.id]?.why ? t`向导：${suggested[picked.id].why}` : t`故事已经走了一段时，选最接近现在的一幕` })]) : null,
      picked && chat.path?.length > 2 ? el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small ghost', text: asking ? t`向导在看……` : t`让向导看看从哪一幕开始`, disabled: asking, title: t`向导读最近几轮，选剧本里最接近现在的一幕`, onclick: guard(async () => {
        asking = true
        draw()
        try {
          const url = `/api/plot-drafts/chat-${chat.id}`
          let view = await api(url, { method: 'POST', body: { kind: 'where', plot: picked } })
          while (view.job) {
            await new Promise(resolve => setTimeout(resolve, 800))
            view = await api(url)
          }
          if (view.error) throw new Error(view.error.message)
          if (view.result?.at) suggested[picked.id] = { at: view.result.at, why: view.result.why }
        } finally {
          asking = false
          draw()
        }
      }) })]) : null,
      el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: t`管理剧本…`, onclick: () => {
          dialog.close()
          manage()
        } }),
        fromChat ? el('button', { type: 'button', class: 'btn small ghost', text: t`整理成剧本…`, title: t`把这段对话走过的路整理成一份新剧本，放进卡里，能重玩`, onclick: () => {
          dialog.close()
          fromChat()
        } }) : null,
        el('button', { type: 'button', class: 'btn small', text: t`取消`, onclick: () => dialog.close() }),
        picked ? el('button', { type: 'button', class: 'btn small primary', text: t`用这个剧本`, onclick: guard(async () => {
          const answer = await api(`/api/chats/${chat.id}/plot`, { method: 'PUT', body: { action: 'use', plotId: picked.id, start: start.value } })
          setChat(answer)
          dialog.close()
        }) }) : null,
      ].filter(Boolean)),
    )
  }
  draw()
  dialog.showModal()
}
