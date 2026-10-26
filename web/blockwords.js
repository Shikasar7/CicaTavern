// 屏蔽词 (设置 → 屏蔽词): words taken out of, masked in or swapped in what is
// sent to the model and what the chat shows (web/shared/blockwords.js), one
// list for every chat, each with its own switch. A save says whether the open
// chat's next turn writes the cache again, and from where (PUT /api/blockwords).
// web/app.js loads this file when the window is first opened, so a server
// started before the file existed still serves the page.
import { t } from '/i18n.js'
import { blockReport, normalizeBlockWords } from '/shared/blockwords.js'

const MODE_LABEL = { remove: t`去掉`, mask: t`遮成 *`, replace: t`换成` }
const SCOPE_LABEL = { both: t`显示和发送都改`, display: t`只改显示`, prompt: t`只改发给模型的` }
const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>'
// A reply to try the words on when no chat is open.
const SAMPLE = t`她把伞收起来，抖了抖水。「进来坐吧，外面雨大。」`
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)

let dialog = null

/** What a save did to the cache, as the server worked it out for the open chat. */
function savedNote(impact) {
  if (!impact?.prompt) return t`已保存，只影响显示，不影响缓存。`
  if (!impact.chat) return t`已保存。会改发给模型的内容：用到这些词的对话，下一轮从词第一次出现的地方起重新写入一次缓存。`
  const session = impact.subscription ? t`Claude 订阅的会话里已经发过的轮次不会改，从下一轮发出的内容起生效。` : ''
  if (impact.system) return t`已保存。当前对话的系统提示词（角色卡、预设、常驻世界书）里有改动的词：下一轮整段重新写入一次缓存。${session}`
  if (impact.subscription) return t`已保存。缓存不受影响：${session}`
  if (impact.turnsAgo === null || impact.turnsAgo === undefined) return t`已保存。当前对话发给模型的内容里没有改动的词，缓存不受影响。`
  if (impact.turnsAgo === 0) return t`已保存。当前对话只有最新一轮里有改动的词，缓存几乎不受影响。`
  return t`已保存。当前对话从往前数第 ${impact.turnsAgo} 轮起的内容变了：下一轮从那里起重新写入一次缓存，更早的照常命中。`
}

/** How an entry reads in the list: 「猫」→「狗」, and what else is set. */
function describe(word) {
  const to = word.mode === 'replace' ? t`「${word.replacement}」` : word.mode === 'mask' ? '*'.repeat([...word.word].length) : t`去掉`
  const notes = [
    SCOPE_LABEL[word.scope],
    word.caseSensitive ? t`区分大小写` : '',
    word.wholeWord ? t`整词` : '',
    word.exceptions.length ? t`例外：${word.exceptions.join(t`、`)}` : '',
  ]
  return { to, sub: notes.filter(Boolean).join(' · ') }
}

/**
 * @param deps - { api, el, toast, guard, getChat() → the open chat or null, onChanged(words) after a save,
 *   subscription: this edition has the Claude subscription }
 */
export async function openBlockWords({ api, el, toast, guard, getChat, onChanged, subscription = false }) {
  dialog ??= document.body.appendChild(el('dialog', { class: 'dialog blockwords', 'aria-label': t`屏蔽词` }))
  const state = { words: (await api('/api/blockwords')).words, editing: null }
  const chat = getChat()
  const latest = chat?.path?.findLast(node => node.role === 'assistant')
  const sampleText = String(latest?.raw ?? latest?.text ?? '').slice(0, 4000) || SAMPLE
  const editingId = () => state.editing?.id ?? null

  async function save(words) {
    const result = await api('/api/blockwords', { method: 'PUT', body: { words, chatId: getChat()?.id ?? '' } })
    state.words = result.words
    onChanged(result.words)
    toast(savedNote(result.impact), result.impact?.prompt ? 7000 : 3000)
    render()
  }

  // ─── The form: a new entry, or the one being edited ─────────────────
  const wordsBox = el('textarea', { rows: 2, spellcheck: 'false', placeholder: t`一行一个，可以一次加好几个` })
  const replacement = el('input', { maxlength: 200, placeholder: t`换成的词`, 'aria-label': t`换成的词` })
  let mode = 'remove'
  let scope = 'both'
  const seg = (labels, pick) => {
    const box = el('div', { class: 'seg' }, Object.entries(labels).map(([value, text]) => el('button', { type: 'button', 'data-value': value, text })))
    box.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button) return
      pick(button.dataset.value)
      changed()
    })
    return box
  }
  const modeSeg = seg(MODE_LABEL, value => { mode = value })
  const scopeSeg = seg(SCOPE_LABEL, value => { scope = value })
  const caseSensitive = el('input', { type: 'checkbox' })
  const wholeWord = el('input', { type: 'checkbox' })
  const exceptions = el('input', { spellcheck: 'false', placeholder: t`例如屏蔽「猫」时写：熊猫 猫头鹰` })
  const more = el('details', { class: 'bw-more' }, [
    el('summary', { text: t`更多：大小写、整词、例外` }),
    el('label', { class: 'check-row' }, [caseSensitive, t`区分大小写（只对字母有用）`]),
    el('label', { class: 'check-row' }, [wholeWord, t`整词匹配`]),
    el('p', { class: 'hint', text: t`整词只看字母和数字：屏蔽 cat 时不动 catalog。中文没有词与词之间的空格，整词对中文不起作用；不想动的长词写在下面的「例外」里。` }),
    el('label', {}, [t`例外（含有这个词、但不要动的词，用空格或逗号隔开）`, exceptions]),
  ])
  const formNote = el('p', { class: 'hint bw-form-note' })
  const submit = el('button', { type: 'button', class: 'btn primary' })
  const cancel = el('button', { type: 'button', class: 'btn ghost', text: t`取消` })

  const linesOf = () => [...new Set(wordsBox.value.split('\n').map(line => line.trim()).filter(Boolean))]
  const listOf = text => [...new Set(text.split(/[\s,，、;；]+/).map(item => item.trim()).filter(Boolean))]
  /** The entries the form describes, one per line. */
  function drafts() {
    return normalizeBlockWords(linesOf().map((word, index) => ({
      id: index === 0 && state.editing ? state.editing.id : newId(),
      word,
      mode,
      replacement: replacement.value,
      scope,
      caseSensitive: caseSensitive.checked,
      wholeWord: wholeWord.checked,
      exceptions: listOf(exceptions.value),
      disabled: index === 0 && state.editing ? state.editing.disabled : false,
    })))
  }

  function fill(word) {
    state.editing = word
    wordsBox.value = word?.word ?? ''
    mode = word?.mode ?? 'remove'
    scope = word?.scope ?? 'both'
    replacement.value = word?.replacement ?? ''
    caseSensitive.checked = word?.caseSensitive ?? false
    wholeWord.checked = word?.wholeWord ?? false
    exceptions.value = word?.exceptions.join(' ') ?? ''
    more.open = Boolean(word && (word.caseSensitive || word.wholeWord || word.exceptions.length))
    changed()
  }

  /** Words the list has already, apart from the one being edited. */
  const taken = () => new Set(state.words.filter(w => w.id !== editingId()).map(w => w.word))

  /** The list as the form would leave it: for the test box and the save. An edited entry keeps its place. */
  function withDrafts() {
    const [first, ...rest] = drafts()
    const have = taken()
    const fresh = (state.editing ? rest : [first, ...rest]).filter(w => w && !have.has(w.word))
    const at = state.words.findIndex(w => w.id === editingId())
    if (at < 0) return [...state.words, ...fresh]
    return [...state.words.slice(0, at), ...(first ? [first] : []), ...fresh, ...state.words.slice(at + 1)]
  }

  function changed() {
    for (const button of modeSeg.children) button.setAttribute('aria-pressed', String(button.dataset.value === mode))
    for (const button of scopeSeg.children) button.setAttribute('aria-pressed', String(button.dataset.value === scope))
    replacement.hidden = mode !== 'replace'
    const lines = linesOf()
    const have = taken()
    const repeated = lines.filter(word => have.has(word))
    const empty = mode === 'replace' && !replacement.value
    formNote.textContent = empty ? t`写上要换成的词，或者选「去掉」。` : repeated.length && !state.editing ? t`已经有了，不会重复添加：${repeated.join(t`、`)}` : ''
    submit.textContent = state.editing ? t`保存` : lines.length > 1 ? t`添加 ${lines.length} 个` : t`添加`
    submit.disabled = !lines.length || empty || (!state.editing && lines.every(word => have.has(word)))
    cancel.hidden = !state.editing
    runTest()
  }
  for (const input of [wordsBox, replacement, exceptions]) input.addEventListener('input', changed)
  for (const input of [caseSensitive, wholeWord]) input.addEventListener('change', changed)

  submit.addEventListener('click', guard(async () => {
    await save(withDrafts())
    fill(null)
    renderList()
  }))
  cancel.addEventListener('click', () => fill(null))

  // ─── The test box: the open chat's latest reply, through the list as the form would leave it ───
  const sample = el('textarea', { class: 'mono', rows: 4, spellcheck: 'false', 'aria-label': t`试一试的文字` })
  sample.value = sampleText
  sample.addEventListener('input', () => runTest())
  const results = el('div', { class: 'bw-results' })
  function runTest() {
    const words = withDrafts()
    const sent = blockReport(sample.value, words, { target: 'prompt' })
    const shown = blockReport(sample.value, words, { target: 'display' })
    const out = (label, report) => el('div', { class: 'regex-out' }, [el('span', { text: report.hits ? t`${label} · 改了 ${report.hits} 处` : t`${label} · 没有改动` }), el('pre', { text: report.text || t`（空）` })])
    results.replaceChildren(...(sent.text === shown.text ? [out(t`发给模型和显示出来`, sent)] : [out(t`发给模型`, sent), out(t`显示出来`, shown)]))
  }

  // ─── The list ───────────────────────────────────────────────────────
  const list = el('ul', { class: 'bw-list' })
  const counts = el('span', { class: 'bw-count' })
  function renderList() {
    const on = state.words.filter(w => !w.disabled).length
    counts.textContent = state.words.length ? t`${state.words.length} 个，开着 ${on} 个` : ''
    if (!state.words.length) {
      list.replaceChildren(el('li', { class: 'bw-empty', text: t`还没有屏蔽词。在上面写一个，选好怎么处理，点「添加」。` }))
      return
    }
    list.replaceChildren(...state.words.map(word => {
      const { to, sub } = describe(word)
      const toggle = el('input', { type: 'checkbox', class: 'switch', checked: !word.disabled, 'aria-label': t`启用「${word.word}」` })
      toggle.addEventListener('change', guard(async () => {
        await save(state.words.map(w => (w.id === word.id ? { ...w, disabled: !toggle.checked } : w)))
      }))
      return el('li', { class: [word.disabled ? 'off' : '', editingId() === word.id ? 'active' : ''].join(' ').trim() }, [
        toggle,
        el('div', { class: 'bw-main' }, [
          el('div', { class: 'bw-title' }, [el('span', { class: 'bw-word', text: word.word }), el('span', { class: 'bw-arrow', text: '→' }), el('span', { class: 'bw-to', text: to })]),
          el('div', { class: 'bw-sub', text: sub }),
        ]),
        el('button', { type: 'button', class: 'btn ghost small', text: t`改`, onclick: () => { fill(word); render(); wordsBox.focus() } }),
        el('button', { type: 'button', class: 'btn ghost small danger', text: t`删除`, onclick: guard(async () => {
          if (!confirm(t`删除屏蔽词「${word.word}」？`)) return
          if (editingId() === word.id) fill(null)
          await save(state.words.filter(w => w.id !== word.id))
        }) }),
      ])
    }))
  }

  function render() {
    renderList()
    changed()
  }

  const row = (label, ...controls) => el('div', { class: 'bw-row' }, [el('span', { class: 'bw-label', text: label }), ...controls])
  dialog.replaceChildren(...[
    el('form', { method: 'dialog', class: 'preset-close' }, [el('button', { class: 'btn ghost icon', 'aria-label': t`关闭`, html: ICON_CLOSE })]),
    el('h2', { text: t`屏蔽词` }),
    el('p', { class: 'hint bw-intro', text: t`把某些词从发给模型的内容和显示出来的文字里去掉、遮住，或换成别的词。只在发送和显示的时候换，存下来的原文不变，关掉或删掉就恢复。所有对话都用这一份。` }),
    el('section', { class: 'bw-form' }, [
      el('label', {}, [t`屏蔽词`, wordsBox]),
      row(t`处理`, modeSeg, replacement),
      row(t`作用于`, scopeSeg),
      more,
      formNote,
      el('div', { class: 'row end' }, [cancel, submit]),
    ]),
    el('h3', { class: 'bw-head' }, [t`列表`, counts]),
    list,
    el('details', { class: 'bw-test' }, [el('summary', { text: chat ? t`试一试（当前对话的最新回复，可以改）` : t`试一试` }), sample, results]),
    el('p', { class: 'hint', text: t`发给模型的：在卡、预设和全局正则之后最后才换，所以角色卡、预设、世界书、历史和你的输入里都会换掉；世界书的关键词照原文触发。显示的：在卡的显示正则之前换，读出来的、配图拿去的也是换过的。` }),
    el('p', { class: 'hint', text: t`缓存：发出去的内容每轮都一样，缓存照常命中。改了会改发送内容的词以后，用到它的对话下一轮从它第一次出现的地方起重新写入一次缓存：出现在角色卡、预设、常驻世界书里就是整段，只出现在某一轮里就从那一轮起；只改显示的不影响缓存。` }),
    subscription ? el('p', { class: 'hint', text: t`Claude 订阅的会话自己存着发过的内容：之前的轮次不会跟着改，改动只对之后发出的内容生效。` }) : null,
  ].filter(Boolean))
  fill(null)
  render()
  if (!dialog.open) dialog.showModal()
}
