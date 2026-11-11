// 对话修改's talk, for 修改角色卡 (card-edit.js) and for a worldbook or a preset
// (talk-dialog.js): the thread of requests and the model's proposals, each
// change shown as before and after with a box to tick, the box the next request
// is written in, and the model to use. The server keeps the session
// (server/forge/index.mjs) and runs the model in the background; the talk polls
// it while a job runs. The window around it belongs to whoever made it.
import { t } from '/i18n.js'
import { decodeTextFile, diffLines, foldSame } from '/shared/card-edit.js'

// On a phone the keyboard's Enter key starts a new line (it has no Shift+Enter); the button sends.
const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)')

const MANAGE_PROVIDERS = '__manage__'

// What 附文件 reads: anything of text (decodeTextFile tells the rest apart) and a PNG with a card in it.
export const REFERENCE_FILES = '.txt,.md,.markdown,.json,.jsonl,.yaml,.yml,.csv,.tsv,.log,.html,.htm,.xml,.ini,.srt,.ass,.png,text/*,image/png'
const MAX_FILE = 16 * 1024 * 1024
const PNG_START = [0x89, 0x50, 0x4e, 0x47]
const CHAT_SPANS = [[20, () => t`最近 20 轮`], [50, () => t`最近 50 轮`], [100, () => t`最近 100 轮`], [0, () => t`全部`]]

const base64Of = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

/** What the server gets for a file from 附文件: the bytes of a PNG, else the text, decoded here where every encoding is at hand. */
export async function referenceBody(file) {
  if (file.size > MAX_FILE) throw new Error(t`「${file.name}」太大了，附的文件不能超过 16 MB`)
  const buffer = await file.arrayBuffer()
  const start = new Uint8Array(buffer).subarray(0, PNG_START.length)
  if (PNG_START.every((byte, i) => start[i] === byte)) return { filename: file.name, data: await base64Of(file) }
  const text = decodeTextFile(buffer)
  if (text === null) throw new Error(t`「${file.name}」读不了。能读 txt、md、json 这类文本文件和带角色卡的 PNG，Word 和 PDF 先另存成 txt`)
  return { name: file.name, text }
}

const chars = n => n.toLocaleString()

function referenceTip(item) {
  if (item.kind === 'chat') return item.rounds < item.total ? t`只放得下最近的 ${item.rounds} 轮（共 ${item.total} 轮）。点开看向导读到的内容` : t`共 ${item.rounds} 轮。点开看向导读到的内容`
  if (item.chars >= item.total) return t`点开看向导读到的内容`
  return item.kind === 'file' ? t`文件太长，只读了前 ${chars(item.chars)} 字（共 ${chars(item.total)} 字）。点开看向导读到的内容` : t`内容太长，长的条目只读了开头（共 ${chars(item.total)} 字）。点开看向导读到的内容`
}

/**
 * References as chips, each with what it is when that was worked out from the file.
 * @param open - a tap on one: what the model reads of it. @param drop - its ×.
 * @param locked - they cannot be taken off for now. @param label - what goes before them.
 * @param studied - the wizard's: a card it only studies says so, and how little of it the model reads (`brief`).
 */
export function referenceChips(el, items, { open, drop, locked = false, label = t`向导读：`, studied = false }) {
  const kind = item => (item.kind === 'card' ? t`角色卡` : item.kind === 'book' ? t`世界书` : '')
  const onlyShape = item => studied && Boolean(item.structure) && item.mode !== 'content'
  return [
    el('span', { class: 'ce-refs-note', text: label }),
    ...items.map(item => el('span', { class: 'ce-ref' }, [
      el('button', { type: 'button', class: 'ce-ref-name', title: onlyShape(item) ? t`只学结构：向导读不到这张卡的内容，只读到它的规模和玩法（${chars(item.brief?.length ?? 0)} 字）。点开看向导读到的内容；要用原文，选下面的「使用原文…」` : referenceTip(item), onclick: () => open(item) }, [
        el('span', { text: item.name }),
        el('small', { text: onlyShape(item) ? t`角色卡 · 只学结构` : kind(item) ? t`${kind(item)} · ${chars(item.chars)} 字` : t`${chars(item.chars)} 字` }),
      ]),
      el('button', { type: 'button', class: 'ce-ref-off', disabled: locked, 'aria-label': t`去掉「${item.name}」`, title: t`去掉`, text: '×', onclick: () => drop(item) }),
    ])),
  ]
}

/** A change as before and after: lines that differ, and inside a changed line the words that do. */
export function diffView(el, before, after) {
  const lines = foldSame(diffLines(before, after), 1)
  return el('div', { class: 'ce-diff' }, lines.map(line => {
    if (line.op === 'skip') return el('div', { class: 'ce-line skip', text: t`…没改的 ${line.count} 行…` })
    if (line.op === 'change') return el('div', { class: 'ce-line change' }, line.parts.map(part => (part.op === 'same' ? part.text : el(part.op === 'del' ? 'del' : 'ins', { text: part.text }))))
    return el('div', { class: `ce-line ${line.op}`, text: line.text || ' ' })
  }))
}

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
 *   references (optional): files and chats can go along ({url}/references):
 *     { chats(): this card's chats ({ id, title, turns }), current(): the one open here, if any }
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
    applying: false, // a proposal is going in: no new request meanwhile
    referencesShown: '', // the references last listed
    readingId: '', // the reference open below the list
    otherPick: { key: '', model: '' }, // 换个模型重写: the model picked under the latest turn (key: which turn)
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
  view.references = el('div', { class: 'ce-refs', hidden: true })
  view.reader = el('div', { class: 'ce-ref-reader', hidden: true })
  view.reading = el('div', { class: 'ce-ref-text', hidden: true })
  view.file = el('input', { type: 'file', accept: REFERENCE_FILES, multiple: true, hidden: true, onchange: () => addFiles() })
  view.attach = spec.references ? el('button', { type: 'button', class: 'btn ghost small', text: t`附文件`, title: t`附文件给向导读：设定、小说原文（txt、md），另一张卡（PNG、JSON），或世界书`, onclick: () => view.file.click() }) : null
  view.readChat = spec.references ? el('button', { type: 'button', class: 'btn ghost small', text: t`读对话`, title: t`让向导读这张卡玩过的一段对话，把里面出场的角色和发生的事写进设定`, onclick: () => openReader() }) : null
  view.compose = el('div', { class: 'ce-compose' }, [view.targetChip, view.references, view.reading, view.reader, view.composer, el('div', { class: 'forge-actions' }, [view.attach, view.readChat, view.file, el('span', { class: 'grow' }), view.stop, view.send])])

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
    renderReferences()
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
    const key = JSON.stringify([spec.url(), session?.turns.map(turn => [turn.user.at, turn.assistant?.at, turn.outcome?.at, turn.outcome?.undone]), session?.job?.startedAt, session?.job?.step, session?.error, session?.undo, [...state.folded].join(), state.models.length])
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
    // The latest answer written again (换个模型重写) stays while the new one is on its way, and when that fails.
    const job = last ? state.session.job : null
    const error = last && !job && !turn.outcome ? state.session.error : null
    return el('div', { class: 'ce-turn' }, [
      el('div', { class: 'forge-you' }, [
        turn.user.target ? el('div', { class: 'ce-aimed', text: t`只改：${state.labels.get(turn.user.target) ?? spec.targetLabel(turn.user.target)}` }) : null,
        el('p', { text: turn.user.text }),
      ]),
      turn.assistant ? answerBlock(turn, last) : null,
      job ? busyBlock() : null,
      error ? el('div', { class: 'forge-error' }, [el('p', { text: error.message }), el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: t`重试`, onclick: () => retry() })]), otherModel(turn, error)]) : null,
      last && turn.assistant && !turn.outcome && !job && !error ? otherModel(turn, null) : null,
    ])
  }

  /**
   * 换个模型重写: the latest request answered again by another model, this once (the talk keeps its own). Under an
   * error, and under an answer whose changes have not been taken or set aside. Nothing is sent till the button.
   */
  function otherModel(turn, error) {
    const choices = state.models.filter(m => m.id !== error?.model)
    if (!choices.length) return null
    const key = `${spec.url()}:${turn.user.at}:${turn.assistant?.at ?? ''}:${error?.message ?? ''}`
    if (state.otherPick.key !== key || !choices.some(m => m.id === state.otherPick.model)) state.otherPick = { key, model: '' }
    const pick = state.otherPick
    const go = el('button', { type: 'button', class: 'btn small', disabled: !pick.model, text: t`换这个模型重写`, onclick: () => retry(pick.model, Boolean(turn.assistant)) })
    const select = el('select', { class: 'forge-model', 'aria-label': t`换哪个模型重写这一次`, onchange: () => {
      pick.model = select.value
      go.disabled = !pick.model
    } }, [
      el('option', { value: '', text: t`换个模型…` }),
      ...choices.map(m => el('option', { value: m.id, selected: m.id === pick.model, text: `${m.group} · ${m.label}` })),
    ])
    const words = turn.assistant && !error
      ? t`不满意可以换个模型重写这一次：只这一次用它，这里的模型不变；新的写出来之前，上面这份还在。`
      : t`可以换个模型重写这一次：只这一次用它，这里的模型不变。`
    return el('div', { class: 'forge-other' }, [el('p', { class: 'hint forge-other-cost', text: words }), el('div', { class: 'row' }, [select, go])])
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
    // Being written again (换个模型重写): it shows, with nothing to decide till the new one is in.
    const redoing = last && Boolean(state.session.job)
    const waiting = last && changes.length && !turn.outcome && !redoing
    const applied = new Set(turn.outcome?.undone ? [] : turn.outcome?.applied ?? [])
    const undo = spec.undo && last && state.session.undo
    return el('div', { class: 'forge-say' }, [
      reply ? el('div', { class: 'forge-voice' }, reply.split(/\n+/).filter(Boolean).map(p => el('p', { text: p }))) : null,
      el('div', { class: 'forge-by', text: model }),
      changes.length ? el('div', { class: `ce-changes${waiting ? '' : ' done'}` }, changes.map(change => changeBlock(change, { waiting, applied: applied.has(change.id) }))) : null,
      !changes.length ? missedNote(turn, last) : null,
      waiting
        ? el('div', { class: 'forge-actions ce-decide' }, [
            el('button', { type: 'button', class: 'btn ghost small', text: t`放弃`, onclick: () => discard() }),
            el('span', { class: 'grow' }),
            (view.applyPicked = el('button', { type: 'button', class: 'btn primary small', onclick: () => applyPicked() })),
          ])
        : changes.length && !redoing
          ? el('div', { class: 'ce-outcome-row' }, [
              el('p', { class: 'ce-outcome', text: outcomeOf(turn, changes) }),
              undo ? el('button', { type: 'button', class: 'btn ghost small', text: t`撤销这次修改`, title: t`改回采用之前的样子`, onclick: () => undoApplied() }) : null,
            ])
          : null,
    ])
  }

  /**
   * An answer with nothing to take in. When it said it changed things (the server asked it once more and
   * still got none), say why, so a reply reading "done" is not taken for done; the latest can be asked again.
   */
  function missedNote(turn, last) {
    const missed = turn.assistant.missed
    if (!missed) return el('p', { class: 'ce-outcome', text: t`这次没有提出改动。` })
    const unshown = missed.dropped.filter(item => item.reason === 'unshown').map(item => t`「${item.name}」`)
    const text = unshown.length
      ? t`没有改动可以采用：模型想改的${unshown.join('')}这次没有附上全文，改不了。可以只改那一处（点它旁边的「按意见改」），或者换个说法。`
      : t`没有改动可以采用：模型说改了，但没有按格式写出改动的内容（追问过一次），所以什么都没有变。可以再问一次，或者换个模型。`
    return el('div', { class: 'ce-outcome-row' }, [
      el('p', { class: 'ce-outcome warn', text }),
      last && !unshown.length ? el('button', { type: 'button', class: 'btn ghost small', text: t`再问一次`, disabled: Boolean(state.session.job), onclick: () => askAgain(turn) }) : null,
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

  const diffBox = (before, after) => diffView(el, before, after)

  // ─── What goes with a request ─────────────────────────────────────────
  function renderReferences() {
    if (!spec.references) return
    const references = state.session?.references ?? []
    const key = JSON.stringify(references.map(item => item.id))
    view.references.hidden = !references.length
    if (key === state.referencesShown) return
    state.referencesShown = key
    if (state.readingId && !references.some(item => item.id === state.readingId)) closeReading()
    view.references.replaceChildren(...referenceChips(el, references, { open: toggleReading, drop: dropReference }))
  }

  function closeReading() {
    state.readingId = ''
    view.reading.hidden = true
    view.reading.replaceChildren()
  }

  const toggleReading = guard(async item => {
    if (state.readingId === item.id) return closeReading()
    const { text } = await api(`${spec.url()}/references/${item.id}`)
    state.readingId = item.id
    view.reading.replaceChildren(el('pre', { text }))
    view.reading.hidden = false
  })

  const dropReference = guard(async item => load(await api(`${spec.url()}/references/${item.id}`, { method: 'DELETE' })))

  const addFiles = guard(async () => {
    const files = [...view.file.files]
    view.file.value = ''
    for (const file of files) load(await api(`${spec.url()}/references`, { method: 'POST', body: await referenceBody(file) }))
  })

  /** 读对话: which chat of this card, how far back, and whose part of it. */
  const openReader = guard(async () => {
    if (!view.reader.hidden) {
      view.reader.hidden = true
      return
    }
    const chats = await spec.references.chats()
    if (!chats.length) throw new Error(t`这张卡还没有对话`)
    const current = spec.references.current()
    const chat = el('select', { 'aria-label': t`读哪段对话` }, chats.map(item => el('option', { value: item.id, selected: item.id === current, text: t`${item.title || t`未命名对话`}（${item.turns} 轮）` })))
    const span = el('select', { 'aria-label': t`读多少` }, CHAT_SPANS.map(([value, label], index) => el('option', { value: String(value), selected: index === 1, text: label() })))
    const names = el('input', { type: 'text', maxlength: 120, placeholder: t`只看提到这些名字的轮次（可不填）`, 'aria-label': t`只看提到这些名字的轮次` })
    const read = guard(async () => {
      load(await api(`${spec.url()}/references`, { method: 'POST', body: { chatId: chat.value, turns: Number(span.value), names: names.value } }))
      view.reader.hidden = true
    })
    view.reader.replaceChildren(
      chat, span, names,
      el('div', { class: 'forge-actions' }, [
        el('p', { class: 'hint', text: t`向导会读到这段对话的摘要、记忆簿、当前变量和原文，之后每次发送都带上，读得越多花的额度越多。` }),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn ghost small', text: t`取消`, onclick: () => { view.reader.hidden = true } }),
        el('button', { type: 'button', class: 'btn primary small', text: t`读这段`, onclick: read }),
      ]),
    )
    view.reader.hidden = false
  })

  // ─── The request box ──────────────────────────────────────────────────
  function updateFoot() {
    const busy = Boolean(state.session?.job)
    view.send.hidden = busy
    view.stop.hidden = !busy
    view.send.disabled = !view.composer.value.trim() || state.applying
    view.composer.disabled = busy || state.applying
    view.model.disabled = busy
    if (view.attach) view.attach.disabled = view.readChat.disabled = busy || state.applying
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

  // `model`: 换这个模型重写, another model for this once. `redo`: over an answer that is there.
  const retry = guard(async (model = '', redo = false) => {
    await spec.beforeAsk?.()
    load(await api(`${spec.url()}/retry`, { method: 'POST', body: { model, redo } }))
    scroll()
  })

  // The same request again, as a new turn (the one before came back without changes).
  const askAgain = guard(async turn => {
    if (state.session?.job) return
    await spec.beforeAsk?.()
    load(await api(spec.url(), { method: 'POST', body: { text: turn.user.text, target: turn.user.target ?? '', context: (await spec.context?.()) ?? null } }))
    scroll()
  })

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
    state.applying = true
    updateFoot()
    let result
    try {
      result = await api(`${spec.url()}/apply`, { method: 'POST', body: { ids: [...state.picked] } })
    } finally {
      state.applying = false
      updateFoot()
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
    /** Words for the box, for the user to read and send. */
    say(text) {
      view.composer.value = text
      view.composer.dispatchEvent(new Event('input', { bubbles: true }))
      view.composer.focus()
    },
    /** A fresh start when the talk turns to another card, book or preset. */
    reset() {
      clearTimeout(state.poll)
      state.target = null
      state.labels.clear()
      state.shown = ''
      state.pickedFor = ''
      state.referencesShown = ''
      view.composer.value = ''
      view.reader.hidden = true
      closeReading()
    },
    stop: () => clearTimeout(state.poll),
  }
}
