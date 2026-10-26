// 对话修改's talk, for 修改角色卡 (card-edit.js) and for a worldbook or a preset
// (talk-dialog.js): the thread of requests and the model's proposals, each
// change shown as before and after with a box to tick, the box the next request
// is written in, and the model to use. The server keeps the session
// (server/forge/index.mjs) and runs the model in the background; the talk polls
// it while a job runs. The window around it belongs to whoever made it.
import { t } from '/i18n.js'
import { diffLines, foldSame } from '/shared/card-edit.js'

// On a phone the keyboard's Enter key starts a new line (it has no Shift+Enter); the button sends.
const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)')

const MANAGE_PROVIDERS = '__manage__'

/**
 * @param deps - { api, el, guard, openProviders }
 * @param spec - what is being changed:
 *   url(): the session (GET, POST to ask, PUT the model, DELETE; /retry, /stop, /discard, /apply, /undo)
 *   isOpen(): whether its window is open (polling stops when it is not)
 *   intro(), ideas(): what an empty talk says and offers to start with
 *   placeholder(target): what the empty request box says
 *   busy(job): what a job in progress says
 *   changeTitle(change), changeWhere(change) → [label, class, tip], changeNotes(change) → [text]
 *   targetLabel(id): a target the request was kept to, when it was not aimed here
 *   changeBody(change, { el, diffBox }) (optional): what an open change shows under its
 *     title, in place of the notes and the before-and-after (a regex's trial, a palette)
 *   canTake(change) (optional): false for a change that cannot go in (a pattern that does not compile)
 *   context() (optional): sent along with a request (the latest reply, the colours on screen)
 *   beforeAsk(): awaited before a request or an apply (修改角色卡's saves)
 *   onApplied(result), onUndone(result): what was taken in, or taken back (undo)
 *   undo: the last applied proposal can be taken back
 */
export function createTalk({ api, el, guard, openProviders }, spec) {
  const state = {
    session: null,
    models: [],
    defaultModel: '',
    target: null, // { id, label }: the next request is kept to this piece
    labels: new Map(), // target id → label, as it was aimed
    picked: new Set(), // ticked changes of the waiting proposal
    pickedFor: '', // the proposal they belong to
    folded: new Set(), // changes shown closed
    poll: null,
    shown: '', // what the thread last showed
    modelsShown: '',
  }
  const view = {}
  view.thread = el('div', { class: 'ce-thread' })
  view.targetChip = el('div', { class: 'ce-target', hidden: true })
  view.composer = el('textarea', {
    class: 'forge-input',
    rows: 2,
    oninput: () => updateFoot(),
    onkeydown: event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touchKeyboard.matches) {
        event.preventDefault()
        ask()
      }
    },
  })
  view.send = el('button', { type: 'button', class: 'btn primary', text: t`发送`, onclick: () => ask() })
  view.stop = el('button', { type: 'button', class: 'btn', text: t`停下`, hidden: true, onclick: () => stopJob() })
  view.clear = el('button', { type: 'button', class: 'btn ghost small', text: t`清空对话`, title: t`忘掉这里聊过的内容（已经改进去的不受影响）`, onclick: () => clearTalk() })
  view.model = el('select', { class: 'forge-model', title: t`对话修改用哪个模型`, onchange: () => changeModel() })
  view.compose = el('div', { class: 'ce-compose' }, [view.targetChip, view.composer, el('div', { class: 'forge-actions' }, [el('span', { class: 'grow' }), view.stop, view.send])])

  // ─── Data ─────────────────────────────────────────────────────────────
  async function loadModels() {
    const data = await api('/api/models').catch(() => ({ choices: [], defaultModel: '' }))
    state.models = data.choices.filter(m => m.id.includes('/'))
    state.defaultModel = data.defaultModel || ''
  }

  function load(session) {
    state.session = session
    const waiting = proposal()
    const key = waiting ? `${session.turns.length}:${waiting.assistant.at}` : ''
    if (key !== state.pickedFor) {
      // A new proposal starts with everything ticked that can go in.
      state.pickedFor = key
      state.picked = new Set(waiting?.assistant.changes.filter(c => spec.canTake?.(c) !== false).map(c => c.id) ?? [])
      state.folded = new Set(waiting && waiting.assistant.changes.length > 4 ? waiting.assistant.changes.map(c => c.id) : [])
    }
    renderModels()
    renderThread()
    updateFoot()
    schedule()
  }

  /** The last turn when its changes wait for an answer. */
  function proposal() {
    const last = state.session?.turns.at(-1)
    return last?.assistant?.changes.length && !last.outcome ? last : null
  }

  function schedule() {
    clearTimeout(state.poll)
    if (!state.session?.job || !spec.isOpen()) return
    const url = spec.url()
    state.poll = setTimeout(async () => {
      try {
        if (spec.url() === url) load(await api(url))
      } catch {
        schedule()
      }
    }, 900)
  }

  // ─── The thread ───────────────────────────────────────────────────────
  function renderThread() {
    const session = state.session
    const key = JSON.stringify([spec.url(), session?.turns.map(turn => [turn.user.at, turn.assistant?.at, turn.outcome?.at, turn.outcome?.undone]), session?.job?.startedAt, session?.job?.step, session?.error, session?.undo, [...state.folded].join()])
    view.clear.hidden = !session?.turns.length
    if (key === state.shown) {
      if (session?.job) fillBusy(session.job)
      return
    }
    state.shown = key
    const atBottom = view.thread.scrollHeight - view.thread.scrollTop - view.thread.clientHeight < 80
    const turns = session?.turns ?? []
    view.thread.replaceChildren(
      ...(turns.length ? [] : [intro()]),
      ...turns.map((turn, i) => turnBlock(turn, i === turns.length - 1)),
    )
    if (session?.job) fillBusy(session.job)
    pickedCount()
    if (atBottom || session?.job) scroll()
  }

  /** The apply button says how many changes are ticked. */
  function pickedCount() {
    if (!view.applyPicked?.isConnected) return
    view.applyPicked.textContent = t`采用勾选的 ${state.picked.size} 处`
    view.applyPicked.disabled = !state.picked.size
  }

  function scroll() {
    view.thread.scrollTop = view.thread.scrollHeight
  }

  function intro() {
    return el('div', { class: 'ce-intro' }, [
      el('p', { text: spec.intro() }),
      el('div', { class: 'forge-ideas' }, spec.ideas().map(text => el('button', { type: 'button', class: 'chip', text, onclick: () => { view.composer.value = text; updateFoot(); view.composer.focus() } }))),
    ])
  }

  function turnBlock(turn, last) {
    const job = last && !turn.assistant ? state.session.job : null
    const error = last && !turn.assistant && !job ? state.session.error : null
    return el('div', { class: 'ce-turn' }, [
      el('div', { class: 'forge-you' }, [
        turn.user.target ? el('div', { class: 'ce-aimed', text: t`只改：${state.labels.get(turn.user.target) ?? spec.targetLabel(turn.user.target)}` }) : null,
        el('p', { text: turn.user.text }),
      ]),
      job ? busyBlock() : null,
      error ? el('div', { class: 'forge-error' }, [el('p', { text: error.message }), el('button', { type: 'button', class: 'btn small', text: t`重试`, onclick: () => retry() })]) : null,
      turn.assistant ? answerBlock(turn, last) : null,
    ])
  }

  function busyBlock() {
    view.busyText = el('div', { class: 'ce-partial' })
    view.busyLine = el('span')
    return el('div', { class: 'forge-say' }, [el('div', { class: 'forge-working' }, [el('span', { class: 'dots' }), view.busyLine]), view.busyText])
  }

  function fillBusy(job) {
    if (!view.busyLine?.isConnected) return
    view.busyLine.textContent = spec.busy(job)
    view.busyText.replaceChildren(...String(job.partial ?? '').split(/\n+/).filter(Boolean).map(p => el('p', { text: p })))
  }

  function outcomeOf(turn, changes) {
    const applied = turn.outcome?.applied?.length ?? 0
    if (turn.outcome?.undone) return t`采用了 ${applied} 处，后来撤销了`
    return turn.outcome?.applied ? t`采用了 ${applied} 处，共 ${changes.length} 处` : t`没有采用`
  }

  function answerBlock(turn, last) {
    const { reply, changes, model } = turn.assistant
    const waiting = last && changes.length && !turn.outcome
    const applied = new Set(turn.outcome?.undone ? [] : turn.outcome?.applied ?? [])
    const undo = spec.undo && last && state.session.undo
    return el('div', { class: 'forge-say' }, [
      reply ? el('div', { class: 'forge-voice' }, reply.split(/\n+/).filter(Boolean).map(p => el('p', { text: p }))) : null,
      el('div', { class: 'forge-by', text: model }),
      changes.length ? el('div', { class: `ce-changes${waiting ? '' : ' done'}` }, changes.map(change => changeBlock(change, { waiting, applied: applied.has(change.id) }))) : null,
      !changes.length ? el('p', { class: 'ce-outcome', text: t`这次没有提出改动。` }) : null,
      waiting
        ? el('div', { class: 'forge-actions ce-decide' }, [
            el('button', { type: 'button', class: 'btn ghost small', text: t`放弃`, onclick: () => discard() }),
            el('span', { class: 'grow' }),
            (view.applyPicked = el('button', { type: 'button', class: 'btn primary small', onclick: () => applyPicked() })),
          ])
        : changes.length
          ? el('div', { class: 'ce-outcome-row' }, [
              el('p', { class: 'ce-outcome', text: outcomeOf(turn, changes) }),
              undo ? el('button', { type: 'button', class: 'btn ghost small', text: t`撤销这次修改`, title: t`改回采用之前的样子`, onclick: () => undoApplied() }) : null,
            ])
          : null,
    ])
  }

  function changeBlock(change, { waiting, applied }) {
    const [where, cls, tip] = spec.changeWhere(change)
    const open = !state.folded.has(change.id)
    const title = spec.changeTitle(change)
    const toggle = () => {
      open ? state.folded.add(change.id) : state.folded.delete(change.id)
      renderThread()
    }
    const head = el('div', { class: 'ce-change-head' }, [
      waiting
        ? el('input', { type: 'checkbox', checked: state.picked.has(change.id), disabled: spec.canTake?.(change) === false, 'aria-label': t`采用「${title}」`, onchange: event => { event.target.checked ? state.picked.add(change.id) : state.picked.delete(change.id); pickedCount() } })
        : el('span', { class: `ce-mark${applied ? ' on' : ''}`, text: applied ? '✓' : '–' }),
      el('button', { type: 'button', class: 'ce-change-title', 'aria-expanded': String(open), onclick: toggle, text: title }),
      where ? el('span', { class: `strategy ${cls}`, title: tip, text: where }) : null,
    ])
    if (!open) return el('div', { class: 'ce-change folded' }, [head])
    const body = spec.changeBody?.(change, { el, diffBox })
    if (body) return el('div', { class: 'ce-change' }, [head, ...body])
    const notes = spec.changeNotes(change)
    const before = /^new/.test(change.kind) ? '' : change.before ?? ''
    const after = /^remove/.test(change.kind) ? '' : change.after ?? ''
    return el('div', { class: 'ce-change' }, [
      head,
      notes.length ? el('p', { class: 'ce-change-note', text: notes.join(t`；`) }) : null,
      before === after ? null : diffBox(before, after),
    ])
  }

  function diffBox(before, after) {
    const lines = foldSame(diffLines(before, after), 1)
    return el('div', { class: 'ce-diff' }, lines.map(line => {
      if (line.op === 'skip') return el('div', { class: 'ce-line skip', text: t`…没改的 ${line.count} 行…` })
      if (line.op === 'change') return el('div', { class: 'ce-line change' }, line.parts.map(part => (part.op === 'same' ? part.text : el(part.op === 'del' ? 'del' : 'ins', { text: part.text }))))
      return el('div', { class: `ce-line ${line.op}`, text: line.text || ' ' })
    }))
  }

  // ─── The request box ──────────────────────────────────────────────────
  function updateFoot() {
    const busy = Boolean(state.session?.job)
    view.send.hidden = busy
    view.stop.hidden = !busy
    view.send.disabled = !view.composer.value.trim()
    view.composer.disabled = busy
    view.model.disabled = busy
    view.targetChip.hidden = !state.target
    if (state.target) {
      view.targetChip.replaceChildren(
        el('span', { text: t`只改：${state.target.label}` }),
        el('button', { type: 'button', class: 'btn ghost small', 'aria-label': t`不限定`, text: '×', onclick: () => aim(null) }),
      )
    }
    view.composer.placeholder = spec.placeholder(state.target)
  }

  /** Keep the next request to one piece (`id` null: to anything). */
  function aim(id, label) {
    state.target = id ? { id, label } : null
    if (id) state.labels.set(id, label)
    updateFoot()
    view.composer.focus()
  }

  /** `force`: rebuild even when nothing changed (to put the choice back after 管理模型供应商…). */
  function renderModels(force = false) {
    const current = state.session?.model ?? ''
    const known = state.models.find(m => m.id === state.defaultModel)
    const label = m => `${m.group} · ${m.label}`
    const key = JSON.stringify([current, state.defaultModel, state.models.map(label)])
    if (!force && key === state.modelsShown) return
    state.modelsShown = key
    view.model.replaceChildren(
      ...[
        el('option', { value: '', selected: !current, text: known ? t`默认模型（${label(known)}）` : t`默认模型（还没选）` }),
        ...state.models.map(m => el('option', { value: m.id, selected: m.id === current, text: label(m) })),
        current && !state.models.some(m => m.id === current) ? el('option', { value: current, selected: true, text: t`${current}（不可用）` }) : null,
        el('option', { value: MANAGE_PROVIDERS, text: t`管理模型供应商…` }),
      ].filter(Boolean),
    )
  }

  const changeModel = guard(async () => {
    const value = view.model.value
    if (value === MANAGE_PROVIDERS) {
      renderModels(true)
      openProviders?.()
      return
    }
    load(await api(spec.url(), { method: 'PUT', body: { model: value } }))
  })

  const ask = guard(async () => {
    const text = view.composer.value.trim()
    if (!text || state.session?.job) return
    if (proposal() && !confirm(t`上一次的改动还没采用。发新的要求会把它放下，继续？`)) return
    await spec.beforeAsk?.()
    const session = await api(spec.url(), { method: 'POST', body: { text, target: state.target?.id ?? '', context: (await spec.context?.()) ?? null } })
    view.composer.value = ''
    state.target = null
    load(session)
    scroll()
  })

  const retry = guard(async () => load(await api(`${spec.url()}/retry`, { method: 'POST' })))

  const stopJob = guard(async () => {
    await api(`${spec.url()}/stop`, { method: 'POST' })
    load(await api(spec.url()))
  })

  const discard = guard(async () => load(await api(`${spec.url()}/discard`, { method: 'POST' })))

  const clearTalk = guard(async () => {
    if (!confirm(t`清空这里聊过的内容？已经改进去的不受影响。`)) return
    load(await api(spec.url(), { method: 'DELETE' }))
  })

  const applyPicked = guard(async () => {
    await spec.beforeAsk?.()
    // Taking in a picture to draw takes a while: the button says so meanwhile.
    const button = view.applyPicked
    button.disabled = true
    button.textContent = t`正在采用…`
    let result
    try {
      result = await api(`${spec.url()}/apply`, { method: 'POST', body: { ids: [...state.picked] } })
    } finally {
      if (button.isConnected) pickedCount()
    }
    load(result.session)
    await spec.onApplied(result)
  })

  const undoApplied = guard(async () => {
    if (!confirm(t`撤销这次修改，改回采用之前的样子？`)) return
    const result = await api(`${spec.url()}/undo`, { method: 'POST' })
    load(result.session)
    await spec.onUndone?.(result)
  })

  return {
    thread: view.thread,
    compose: view.compose,
    clear: view.clear,
    model: view.model,
    loadModels,
    load,
    aim,
    scroll,
    /** A fresh start when the talk turns to another card, book or preset. */
    reset() {
      clearTimeout(state.poll)
      state.target = null
      state.labels.clear()
      state.shown = ''
      state.pickedFor = ''
      view.composer.value = ''
    },
    stop: () => clearTimeout(state.poll),
  }
}
