// 让向导写剧本、改剧本 (plans/22 十二·3): the guide writes a card's plot (an idea → an outline → each scene filled in,
// or an outline pasted and split into scenes), rewrites a plot as the player asks (the changes listed, taken one by
// one), and writes the scene a story went into when it left its plot (就这样走). The guide works in the background
// (server/plot-draft.mjs); this window reads it again while it writes. Nothing changes until the player takes it.
import { t } from '/i18n.js'
import { applyPlotChanges, plotChanges, plotProblems, sceneOf, startProgress } from '/shared/plot.js'

const POLL_MS = 900
const ENDING_NAMES = () => ({ good: t`圆满`, normal: t`普通`, sad: t`遗憾`, hidden: t`隐藏` })
const KIND_NAMES = () => ({ info: t`剧本信息`, add: t`新加`, change: t`修改`, remove: t`删除` })

/**
 * The guide on a plot, in a dialog.
 * @param deps - { api, el, guard, toast, problemText(item): a structure problem in words }
 * @param options - { key: 'card-<id>' | 'chat-<id>', mode: 'write' | 'edit' | 'detour' | 'fromChat' (从对话整理: the chat
 *   as a plot, taken as 'write' takes one), plot (edit, detour: the plot as
 *   it is), locked (edit: scenes already played, not changed), progress (detour: where the story is), titleOf(id),
 *   chatId (a card's plot written from a chat: that chat's model), onTake(result): 'write' and 'edit' a plot, 'detour' { scene, back } }
 */
export async function openPlotDraft({ api, el, guard, toast, problemText = item => item.text }, { key, mode, plot = null, locked = [], progress = null, titleOf = id => id, onTake, openings = [], chatId = '' }) {
  const url = `/api/plot-drafts/${key}`
  const state = {
    view: null, tab: 'idea', idea: '', paste: '', ask: '', more: '', scenes: 8, endings: 3, tightness: 'steady', picked: null, timer: null, fresh: false,
    // 写一份's finer settings: kept for the outline's revisions too.
    endingKinds: [], forks: 'some', sides: 0, chapters: 0, tone: '', avoid: '', opening: -1,
  }
  const settings = () => ({
    scenes: state.scenes, endings: state.endings, tightness: state.tightness, endingKinds: state.endingKinds, forks: state.forks,
    sides: state.sides, chapters: state.chapters, tone: state.tone, avoid: state.avoid, opening: openings[state.opening] ?? '',
  })
  const titles = { write: t`让向导写剧本`, edit: t`问问向导改`, detour: t`就这样走`, fromChat: t`把这段对话整理成剧本` }
  const dialog = el('dialog', { class: 'dialog wide plot-draft', 'aria-label': titles[mode] })
  const body = el('div', { class: 'plot-draft-body' })
  dialog.append(el('div', { class: 'plot-dialog-head' }, [
    el('h2', { text: titles[mode] }),
    el('span', { class: 'grow' }),
    el('button', { type: 'button', class: 'btn small ghost', text: t`关闭`, onclick: () => dialog.close() }),
  ]), body)
  document.body.append(dialog)
  dialog.addEventListener('close', () => {
    clearTimeout(state.timer)
    dialog.remove()
  })

  const fits = view => {
    if (view.job) return mode === 'write' ? ['outline', 'full', 'split', 'whole'].includes(view.kind) : view.kind === mode
    if (!view.result) return false
    if (mode === 'write') return ['outline', 'full', 'split', 'whole'].includes(view.kind)
    if (mode === 'fromChat') return view.kind === 'fromChat'
    if (mode === 'edit') return view.kind === 'edit' && view.result.plot?.id === plot?.id && state.fresh
    return view.kind === 'detour' && state.fresh
  }

  async function load(view = null) {
    clearTimeout(state.timer)
    state.view = view ?? (await api(chatId ? `${url}?chat=${encodeURIComponent(chatId)}` : url))
    if (!dialog.isConnected) return
    if (state.view.job) state.timer = setTimeout(() => load().catch(() => {}), POLL_MS)
    draw()
  }

  async function ask(kind, extra = {}) {
    state.fresh = true
    state.picked = null
    await load(await api(url, { method: 'POST', body: { kind, ...(chatId ? { chat: chatId } : {}), ...extra } }))
  }

  const stop = guard(async () => load(await api(`${url}/stop`, { method: 'POST' })))

  // ─── Pieces ─────────────────────────────────────────────────────────────
  const area = (value, onInput, { rows = 4, max = 8000, placeholder = '' } = {}) => {
    const input = el('textarea', { rows: String(rows), maxlength: String(max), placeholder })
    input.value = value
    input.addEventListener('input', () => onInput(input.value))
    return input
  }
  const select = (options, value, onChange) => {
    const box = el('select', {}, options.map(([v, label]) => el('option', { value: String(v), text: label, selected: String(v) === String(value) })))
    box.addEventListener('change', () => onChange(box.value))
    return box
  }
  const field = (label, input) => el('label', { class: 'plot-field' }, [el('span', { text: label }), input])

  // Which model writes, and where it is picked.
  function modelLine(view) {
    if (!view.model) return null
    const where = { forge: t`在创作页右上角换`, chat: t`在对话顶栏换`, helper: t`辅助模型，在「设置 → 配图与朗读」换`, default: t`默认模型，在「设置 → 模型」换` }[view.model.source]
    return el('p', { class: 'plot-draft-model muted small', text: view.job ? t`用「${view.model.label}」写` : t`用「${view.model.label}」写（${where}）` })
  }

  function writing(view) {
    const tail = view.job.partial.replace(/\s+/g, ' ').slice(-400)
    return el('div', { class: 'plot-draft-job' }, [
      el('p', { class: 'muted', text: t`向导在写……` }),
      el('p', { class: 'muted small', text: t`可以关掉这个窗口，写好了再打开看。` }),
      tail ? el('p', { class: 'plot-draft-partial small', text: tail }) : null,
      el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: stop })]),
    ])
  }

  function failed(view, retry) {
    return el('div', { class: 'plot-draft-error' }, [
      el('p', { class: 'bad small', text: view.error.message }),
      view.error.model ? el('p', { class: 'muted small', text: t`这次用的是「${view.error.model}」` }) : null,
      retry ? el('button', { type: 'button', class: 'btn small', text: t`再试一次`, onclick: guard(retry) }) : null,
    ].filter(Boolean))
  }

  // An outline has no scene written yet: only what is wrong with its shape.
  function problems(result, { outline = false } = {}) {
    const { blocking, hints: all } = plotProblems(result)
    const hints = outline ? [] : all
    return el('div', { class: 'plot-problems' }, [
      ...blocking.map(item => el('p', { class: 'bad small', text: `⚠ ${problemText(item)}` })),
      ...hints.slice(0, 3).map(item => el('p', { class: 'muted small', text: `· ${problemText(item)}` })),
      !blocking.length && !hints.length ? el('p', { class: 'ok small', text: t`结构没问题` }) : null,
    ])
  }

  // The plot drafted: its scenes in order, each with where it leads (an outline) or what happens (in full).
  function sceneList(result, { full }) {
    return el('ol', { class: 'plot-draft-scenes' }, result.scenes.map(scene => el('li', {}, [
      el('div', { class: 'plot-draft-scene-head' }, [
        el('b', { text: `${scene.chapter ? `${scene.chapter} · ` : ''}${scene.title}` }),
        scene.id === result.start ? el('span', { class: 'plot-badge', text: t`起点` }) : null,
        scene.ending ? el('span', { class: `plot-badge end ${scene.ending.kind}`, text: t`${ENDING_NAMES()[scene.ending.kind]}结局` }) : el('span', { class: 'muted small', text: `→ ${scene.exits.map(exit => sceneOf(result, exit.to)?.title ?? '').join(' / ')}` }),
      ]),
      scene.what ? el('p', { class: 'small', text: scene.what }) : null,
      full && scene.points.length ? el('p', { class: 'muted small', text: scene.points.map(point => `· ${point.text}`).join('  ') }) : null,
    ])))
  }

  async function mapOf(result) {
    const box = el('div', { class: 'plot-preview' })
    const { plotMap } = await import('/plot-map.js')
    box.append(plotMap({ copy: result, progress: startProgress(result), spoiler: 'all' }, { el, guard, preview: true, onJump: () => {}, onSpoiler: () => {} }))
    return box
  }

  // ─── 写一份 / 贴大纲 ──────────────────────────────────────────────────────
  function drawWrite(view) {
    const parts = []
    const tabs = el('div', { class: 'plot-seg', role: 'tablist' }, [['idea', t`写一份`], ['paste', t`贴大纲`]].map(([id, name]) => el('button', {
      type: 'button', class: 'btn small', role: 'tab', text: name, 'aria-pressed': String(state.tab === id), onclick: () => {
        state.tab = id
        draw()
      },
    })))
    parts.push(tabs)
    if (state.tab === 'idea') {
      parts.push(
        el('p', { class: 'muted small', text: t`写一句想法，向导读这张卡和它的世界书，先出大纲（幕和岔路），满意了再写完整。` }),
        area(state.idea, v => { state.idea = v }, { rows: 3, max: 1000, placeholder: t`一个从相识到看海的夏天，三个结局` }),
        el('div', { class: 'plot-draft-size' }, [
          field(t`大概几幕`, select([4, 6, 8, 10, 12, 16, 20].map(n => [n, String(n)]), state.scenes, v => { state.scenes = Number(v) })),
          field(t`几个结局`, select([1, 2, 3, 4].map(n => [n, String(n)]), state.endings, v => { state.endings = Number(v) })),
          field(t`岔路`, select([['few', t`少`], ['some', t`适中`], ['many', t`多`]], state.forks, v => { state.forks = v })),
          field(t`支线`, select([0, 1, 2, 3].map(n => [n, n ? t`${n} 条` : t`不要`]), state.sides, v => { state.sides = Number(v) })),
          field(t`分几章`, select([0, 2, 3, 4, 5, 6].map(n => [n, n ? t`${n} 章` : t`不分章`]), state.chapters, v => { state.chapters = Number(v) })),
          field(t`剧本约束`, select([['loose', t`宽松`], ['steady', t`适中`], ['tight', t`严格`]], state.tightness, v => { state.tightness = v })),
        ]),
        el('div', { class: 'plot-draft-kinds' }, [
          el('span', { class: 'muted small', text: t`结局要有哪几种（不选就交给向导）` }),
          ...[['good', t`圆满`], ['normal', t`普通`], ['sad', t`遗憾`], ['hidden', t`隐藏`]].map(([kind, name]) => {
            const box = el('input', { type: 'checkbox', checked: state.endingKinds.includes(kind) })
            box.addEventListener('change', () => {
              state.endingKinds = box.checked ? [...state.endingKinds, kind] : state.endingKinds.filter(item => item !== kind)
            })
            return el('label', { class: 'plot-check small' }, [box, el('span', { text: name })])
          }),
        ]),
        field(t`基调和写法（可空）`, area(state.tone, v => { state.tone = v }, { rows: 1, max: 200, placeholder: t`慢热，前半段日常，后半段有一次大的误会` })),
        field(t`不要写的（可空）`, area(state.avoid, v => { state.avoid = v }, { rows: 1, max: 200, placeholder: t`角色死亡、三角恋` })),
        openings.length ? field(t`剧本从哪个开场白接着走`, select([[-1, t`不指定`], ...openings.map((text, index) => [index, `${index + 1}. ${String(text).replace(/\s+/g, ' ').slice(0, 30)}`])], state.opening, v => { state.opening = Number(v) })) : null,
        el('div', { class: 'row end' }, [
          el('button', { type: 'button', class: 'btn small', text: t`直接写完整`, title: t`不先出大纲，一次写好每一幕`, disabled: Boolean(view.job), onclick: guard(() => ask('whole', { text: state.idea, ...settings() })) }),
          el('button', { type: 'button', class: 'btn small primary', text: t`先出大纲`, disabled: Boolean(view.job), onclick: guard(() => ask('outline', { text: state.idea, ...settings() })) }),
        ]),
      )
    } else {
      parts.push(
        el('p', { class: 'muted small', text: t`把手上的大纲整段贴进来，向导拆成幕和出口；说不清的地方它会列出来。` }),
        area(state.paste, v => { state.paste = v }, { rows: 8, placeholder: t`第一章：……` }),
        el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small primary', text: t`拆成幕`, disabled: Boolean(view.job), onclick: guard(async () => (state.paste.trim() ? ask('split', { text: state.paste }) : toast(t`先写点什么`))) })]),
      )
    }
    return parts
  }

  async function drawWriteResult(view) {
    const result = view.result.plot
    const outline = view.kind === 'outline'
    const parts = [
      el('div', { class: 'plot-draft-title' }, [
        el('h3', { text: result.name }),
        el('span', { class: 'muted small', text: t`${result.scenes.length} 幕 · ${result.scenes.filter(scene => scene.ending && !scene.side).length} 个结局${outline ? t` · 大纲` : ''}` }),
      ]),
      result.intro ? el('p', { class: 'small', text: result.intro }) : null,
      view.result.notes ? el('p', { class: 'plot-draft-notes small', text: view.result.notes }) : null,
      problems(result, { outline }),
      await mapOf(result),
      sceneList(result, { full: !outline }),
    ]
    if (outline) {
      parts.push(
        field(t`再改改`, area(state.more, v => { state.more = v }, { rows: 2, max: 1000, placeholder: t`这里再加一条路；结局太惨了` })),
        el('div', { class: 'row end' }, [
          el('button', { type: 'button', class: 'btn small', text: t`重新开始`, onclick: guard(() => load(Object.assign(view, { result: null }))) }),
          el('button', { type: 'button', class: 'btn small', text: t`按意见改大纲`, onclick: guard(async () => {
            if (!state.more.trim()) return toast(t`先写点什么`)
            const more = state.more
            state.more = ''
            await ask('outline', { ...settings(), plot: result, text: more, scenes: result.scenes.filter(scene => !scene.side).length, endings: result.scenes.filter(scene => scene.ending && !scene.side).length })
          }) }),
          el('button', { type: 'button', class: 'btn small primary', text: t`写完整`, onclick: guard(() => ask('full', { plot: result })) }),
        ]),
      )
    } else {
      parts.push(el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small', text: t`重新开始`, onclick: guard(() => load(Object.assign(view, { result: null }))) }),
        el('button', { type: 'button', class: 'btn small primary', text: t`放进剧本`, onclick: guard(async () => {
          await onTake(result)
          await api(url, { method: 'DELETE' }).catch(() => {})
          dialog.close()
        }) }),
      ]))
    }
    return parts
  }

  // ─── 从对话整理 ──────────────────────────────────────────────────────────
  function drawFromChat() {
    return [
      el('p', { class: 'muted small', text: t`向导读这段对话（压缩过的部分读摘要，再加最近 30 轮），把走过的路整理成剧本的主线，再挑两三处本可以换个选择的地方加上岔路和结局。整理好的剧本放进这张卡，可以重玩，也可以导出给别人。` }),
      el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small primary', text: t`开始整理`, onclick: guard(() => ask('fromChat')) })]),
    ]
  }

  // ─── 问问向导改 ──────────────────────────────────────────────────────────
  function drawEdit(view) {
    const lockedSet = new Set(view.result?.locked ?? locked)
    if (!view.result || !fits(view)) {
      return [
        el('p', { class: 'muted small', text: lockedSet.size ? t`说一句想怎么改。向导写出改动，你逐条决定要不要；已经演过的幕不会改。` : t`说一句想怎么改。向导写出改动，你逐条决定要不要。` }),
        area(state.ask, v => { state.ask = v }, { rows: 3, max: 2000, placeholder: t`中间加一场误会；第二个结局改成隐藏结局` }),
        el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small primary', text: t`让向导改`, disabled: Boolean(view.job), onclick: guard(async () => (state.ask.trim() ? ask('edit', { plot, text: state.ask }) : toast(t`先写点什么`))) })]),
      ]
    }
    const changes = plotChanges(plot, view.result.plot, { locked: lockedSet })
    if (!state.picked) state.picked = new Set(changes.map(change => change.id))
    const rows = changes.map(change => {
      const box = el('input', { type: 'checkbox', checked: state.picked.has(change.id) })
      box.addEventListener('change', () => {
        if (box.checked) state.picked.add(change.id)
        else state.picked.delete(change.id)
      })
      const after = change.scene ? sceneOf(view.result.plot, change.scene) : null
      return el('li', { class: `plot-change ${change.kind}` }, [el('label', {}, [
        box,
        el('span', { class: 'plot-change-kind', text: KIND_NAMES()[change.kind] }),
        el('span', { class: 'plot-change-title', text: change.was && change.was !== change.title ? `${change.was} → ${change.title}` : change.title }),
      ]), after?.what && change.kind !== 'remove' ? el('p', { class: 'muted small', text: after.what }) : null])
    })
    return [
      view.result.notes ? el('p', { class: 'plot-draft-notes small', text: view.result.notes }) : null,
      changes.length ? el('ul', { class: 'plot-changes' }, rows) : el('p', { class: 'muted', text: t`向导没有改动。` }),
      el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small', text: t`再改一次`, onclick: () => {
          state.fresh = false
          draw()
        } }),
        changes.length ? el('button', { type: 'button', class: 'btn small primary', text: t`用勾上的`, onclick: guard(async () => {
          if (!state.picked.size) return toast(t`一条也没勾`)
          await onTake(applyPlotChanges(plot, view.result.plot, state.picked, { locked: lockedSet }))
          dialog.close()
        }) }) : null,
      ]),
    ]
  }

  // ─── 就这样走 ────────────────────────────────────────────────────────────
  function drawDetour(view) {
    const result = view.result
    if (!result || !fits(view)) return [el('p', { class: 'muted', text: t`向导读最近几轮，把岔开的这段写成新的一幕，再接回剧本。` })]
    const scene = result.scene
    const options = [...new Set([progress?.at, ...(sceneOf(plot, progress?.at)?.exits ?? []).map(exit => exit.to), ...plot.scenes.filter(item => !progress?.seen.includes(item.id)).map(item => item.id)])].filter(id => id && sceneOf(plot, id))
    let back = options.includes(result.back) ? result.back : options[0]
    return [
      el('div', { class: 'plot-card' }, [
        el('div', { class: 'plot-scene' }, [
          el('h4', { text: scene.title }),
          scene.what ? el('p', { text: scene.what }) : null,
          scene.points.length ? el('ul', { class: 'plot-points' }, scene.points.map(point => el('li', { text: `· ${point.text}` }))) : null,
          scene.done ? el('p', { class: 'muted small', text: t`演到这里算完：${scene.done}` }) : null,
        ]),
      ]),
      field(t`演完后接回`, select(options.map(id => [id, titleOf(id)]), back, v => { back = v })),
      el('div', { class: 'row end' }, [
        el('button', { type: 'button', class: 'btn small', text: t`重新写`, onclick: guard(() => ask('detour')) }),
        el('button', { type: 'button', class: 'btn small primary', text: t`加进剧本`, title: t`加进这段对话用的剧本，下一轮就演它`, onclick: guard(async () => {
          await onTake({ scene, back })
          dialog.close()
        }) }),
      ]),
    ]
  }

  // Failed after its window was closed: said when it is opened again, too.
  const failedHere = view => state.fresh || (mode === 'write' ? ['outline', 'full', 'split', 'whole'].includes(view.kind) : mode === 'fromChat' && view.kind === 'fromChat')

  async function draw() {
    const view = state.view
    const parts = [modelLine(view)]
    if (view.job && fits(view)) parts.push(writing(view))
    else if (view.job) parts.push(el('p', { class: 'muted', text: t`向导还在写别的，等它写完或先停下。` }), el('div', { class: 'row end' }, [el('button', { type: 'button', class: 'btn small', text: t`停下`, onclick: stop })]))
    else {
      if (view.error && failedHere(view)) parts.push(failed(view, mode === 'detour' ? () => ask('detour') : null))
      if (mode === 'write') parts.push(...(view.result && fits(view) ? await drawWriteResult(view) : drawWrite(view)))
      else if (mode === 'fromChat') parts.push(...(view.result && fits(view) ? await drawWriteResult(view) : drawFromChat()))
      else if (mode === 'edit') parts.push(...drawEdit(view))
      else parts.push(...drawDetour(view))
    }
    if (dialog.isConnected) body.replaceChildren(...parts.filter(Boolean))
  }

  dialog.showModal()
  body.replaceChildren(el('p', { class: 'muted', text: t`读取中……` }))
  await load()
  // One of these being written already (the window closed meanwhile): its answer is this window's.
  if (state.view.job && fits(state.view)) state.fresh = true
  // 就这样走 starts at once, unless one is being written.
  if (mode === 'detour' && !state.view.job) await ask('detour')
}
