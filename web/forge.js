// 创作角色卡: making a card by talking it through (server/forge/).
//   Home:     say the idea in a sentence, or pick up a draft.
//   聊想法:   each round the guide says what it understood and asks a few key
//             questions; every option carries a sample line to choose by feel.
//             The sketch beside it fills in as choices are made; any item can
//             be edited or locked.
//   定方案:   the talk written up as a plan; comment on any part and have it revised.
//   动笔:     the plan written out step by step (progress shown; a stopped run carries on).
//   打磨:     read and edit the card, have any piece rewritten by a note, draw or
//             upload the avatar, save it as a card and export the PNG.
// The model works in the background; the window polls the draft while it does.
const STEPS = [
  ['discuss', '聊想法'],
  ['plan', '定方案'],
  ['write', '动笔'],
  ['polish', '打磨与头像'],
]
const IDEAS = ['雨夜便利店里遇到的神秘女孩，氛围安静一点', '修仙宗门里嘴硬心软的师姐', '末日废土上陪我赶路的旧型机器人', '民国旧宅的侦探事务所，我是新来的助手']
const STRATEGY = { constant: ['常驻', 'on'], keyword: ['提到时', 'key'], off: ['不发送', 'off'] }
const POSITION = { before: '角色定义前', after: '角色定义后', depth: '上下文末尾' }
const STAGE_TEXT = { discuss: '聊想法', plan: '定方案', write: '动笔', polish: '打磨与头像' }
const MANAGE_PROVIDERS = '__manage_providers__'
const ICON_LOCK = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>'
const ICON_OPEN = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="9" width="11" height="7.5" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 5.6-1.5"/></svg>'
const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>'
const ICON_LIST = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h9M7 10h9M7 15h9M4 5h.01M4 10h.01M4 15h.01"/></svg>'

function ago(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days === 1 ? '昨天' : `${days} 天前`
}

export function initForge({ api, el, toast, guard, openProviders, onCardSaved, startChatWith }) {
  const $ = id => document.getElementById(id)
  const dialog = $('forge-dialog')
  const state = {
    draft: null, // the open draft as the server shows it; null on the home view
    list: [],
    models: [],
    defaultModel: '',
    // Picks for the latest round: question id → { labels: Set, delegate, custom, other }.
    picks: new Map(),
    picksFor: '', // `${draftId}:${round}` the picks belong to
    notes: new Map(), // plan section → comment
    planText: '',
    idea: '',
    homeModel: '',
    poll: null,
    shown: '', // what the main area last showed, to re-render only on change
    open: new Set(), // entries shown in full on the polish view
    editing: null, // the piece being edited by hand: entry name, "开场白N", "description" or "notes"
    noteFor: null, // the piece a rewrite note is being written for
    noteText: '',
    avatarDesc: null, // the avatar scene as the user edits it; null = the plan's
  }
  const view = {}

  // ─── Skeleton ─────────────────────────────────────────────────────────
  function layout() {
    view.title = el('span', { class: 'forge-sub' })
    view.steps = el('ol', { class: 'forge-steps' })
    view.model = el('select', { class: 'forge-model', title: '和你聊、写方案用哪个模型', onchange: () => changeModel() })
    view.home = el('button', { type: 'button', class: 'btn ghost icon', title: '所有草稿', 'aria-label': '所有草稿', html: ICON_LIST, onclick: () => goHome() })
    const close = el('button', { type: 'button', class: 'btn ghost icon', title: '关闭（草稿会保留）', 'aria-label': '关闭', html: ICON_CLOSE, onclick: () => dialog.close() })
    view.main = el('div', { class: 'forge-main' })
    view.sketch = el('aside', { class: 'forge-sketch' })
    view.composer = el('textarea', {
      class: 'forge-input',
      rows: 2,
      placeholder: '也可以直接说想法，比如：想要她说话带点毒舌',
      oninput: () => updateFoot(),
      onkeydown: event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          send()
        }
      },
    })
    view.planText = el('textarea', { class: 'forge-input', rows: 2, placeholder: '对方案的总体意见，比如：配角太多了，只留店长', oninput: () => { state.planText = view.planText.value; updateFoot() } })
    view.pickCount = el('span', { class: 'forge-count' })
    view.undo = el('button', { type: 'button', class: 'btn ghost small', text: '撤回上一轮', title: '去掉你上一次的回答和向导对它的回复', onclick: () => undo() })
    view.toPlan = el('button', { type: 'button', class: 'btn', text: '差不多了，出方案', onclick: () => makePlan() })
    view.send = el('button', { type: 'button', class: 'btn primary', text: '继续聊', onclick: () => send() })
    view.back = el('button', { type: 'button', class: 'btn ghost', text: '回去接着聊', onclick: () => setStage('discuss') })
    view.revise = el('button', { type: 'button', class: 'btn', text: '按意见修改方案', onclick: () => revise() })
    view.write = el('button', { type: 'button', class: 'btn primary', text: '开始写这张卡', onclick: () => startWrite() })
    view.rewriteAll = el('button', { type: 'button', class: 'btn ghost', text: '按这个方案重写', title: '从头再写一遍：已写的内容和你的修改会被替换', onclick: () => startWrite(true) })
    view.toPlanBack = el('button', { type: 'button', class: 'btn ghost', text: '回到方案', onclick: () => setStage('plan') })
    view.saved = el('span', { class: 'forge-count' })
    view.chat = el('button', { type: 'button', class: 'btn', text: '开始对话', onclick: () => startChat() })
    view.png = el('a', { class: 'btn', text: '导出 PNG', title: '图片里带着整张卡，SillyTavern 可以直接导入' })
    view.save = el('button', { type: 'button', class: 'btn primary', text: '保存为角色卡', onclick: () => saveCard() })
    view.polishFoot = el('div', { class: 'forge-foot' }, [el('div', { class: 'forge-actions' }, [view.toPlanBack, el('span', { class: 'grow' }), view.saved, view.png, view.chat, view.save])])
    view.discussFoot = el('div', { class: 'forge-foot' }, [view.composer, el('div', { class: 'forge-actions' }, [view.pickCount, el('span', { class: 'grow' }), view.undo, view.toPlan, view.send])])
    view.planFoot = el('div', { class: 'forge-foot' }, [view.planText, el('div', { class: 'forge-actions' }, [view.back, el('span', { class: 'grow' }), view.rewriteAll, view.revise, view.write])])
    view.body = el('div', { class: 'forge-body' }, [view.main, view.sketch])
    dialog.replaceChildren(
      el('div', { class: 'forge' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: '创作角色卡' }), view.title]),
          view.steps,
          el('div', { class: 'forge-tools' }, [view.model, view.home, close]),
        ]),
        view.body,
        view.discussFoot,
        view.planFoot,
        view.polishFoot,
      ]),
    )
  }

  // ─── Data ─────────────────────────────────────────────────────────────
  async function loadModels() {
    const data = await api('/api/models').catch(() => ({ choices: [], defaultModel: '' }))
    state.models = data.choices.filter(m => m.id.includes('/'))
    state.defaultModel = data.defaultModel || ''
  }

  function apply(draft) {
    const before = state.draft
    state.draft = draft
    // A new round, or the same round answered again (换一组问题): new questions, fresh picks.
    const round = `${draft.id}:${draft.rounds.length}:${draft.rounds.at(-1)?.assistant?.at ?? ''}`
    if (state.picksFor !== round) {
      state.picks = new Map()
      state.picksFor = round
    }
    if (before?.id !== draft.id) {
      state.notes = new Map()
      state.planText = ''
      view.composer.value = ''
      view.planText.value = ''
    }
    render()
    schedule()
  }

  function schedule() {
    clearTimeout(state.poll)
    if (!state.draft?.job || !dialog.open) return
    const id = state.draft.id
    state.poll = setTimeout(async () => {
      try {
        if (state.draft?.id === id) apply(await api(`/api/forge/${id}`))
      } catch {
        schedule()
      }
    }, 900)
  }

  // ─── Rendering ────────────────────────────────────────────────────────
  function render() {
    const draft = state.draft
    view.title.textContent = draft ? draft.title : ''
    renderSteps()
    renderModels()
    view.home.hidden = !draft
    view.body.classList.toggle('home', !draft)
    // Writing and polishing are about the card itself: the talk's sketch steps aside.
    view.body.classList.toggle('wide', Boolean(draft && (draft.stage === 'write' || draft.stage === 'polish')))
    view.discussFoot.hidden = !draft || draft.stage !== 'discuss'
    view.planFoot.hidden = !draft || draft.stage !== 'plan'
    view.polishFoot.hidden = !draft || draft.stage !== 'polish'
    renderMain()
    renderSketch()
    updateFoot()
  }

  function renderSteps() {
    const draft = state.draft
    const at = draft ? STEPS.findIndex(([id]) => id === draft.stage) : -1
    view.steps.replaceChildren(
      ...STEPS.map(([id, label], i) => {
        const has = { discuss: true, plan: Boolean(draft?.plan), write: Boolean(draft?.card), polish: Boolean(draft?.card?.writtenAt) }
        const reachable = draft && !draft.job && has[id]
        const done = i < at || (has[id] && id !== 'write' && i !== at) || (id === 'write' && draft?.card?.writtenAt)
        return el('li', { class: i === at ? 'now' : done ? 'done' : '' }, [
          el('button', { type: 'button', disabled: !reachable || i === at, onclick: () => setStage(id) }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { text: label })]),
        ])
      }),
    )
  }

  function renderModels() {
    const draft = state.draft
    const current = draft ? draft.model : state.homeModel
    const known = state.models.some(m => m.id === state.defaultModel)
    const label = m => `${m.group} · ${m.label}`
    view.model.replaceChildren(
      ...[
        el('option', { value: '', selected: !current, text: known ? `默认模型（${label(state.models.find(m => m.id === state.defaultModel))}）` : '默认模型（还没选）' }),
        ...state.models.map(m => el('option', { value: m.id, selected: m.id === current, text: label(m) })),
        current && !state.models.some(m => m.id === current) ? el('option', { value: current, selected: true, text: `${current}（不可用）` }) : null,
        el('option', { value: MANAGE_PROVIDERS, text: '管理模型供应商…' }),
      ].filter(Boolean),
    )
    view.model.disabled = Boolean(draft?.job)
  }

  /** In the talk, keep the reader at the bottom when they were there; elsewhere, where they were. */
  function keepScroll(fn, stick) {
    const box = view.main
    const atBottom = stick && box.scrollHeight - box.scrollTop - box.clientHeight < 80
    const top = box.scrollTop
    fn()
    box.scrollTop = atBottom ? box.scrollHeight : top
  }

  function renderMain() {
    const draft = state.draft
    const key = draft ? JSON.stringify([draft.id, draft.stage, draft.rounds.length, draft.rounds.at(-1)?.assistant?.at, draft.job, draft.error, draft.plan ? draft.updatedAt : '', state.editing, state.noteFor, [...state.open].join()]) : `home:${state.list.length}:${state.list.map(d => d.updatedAt).join()}`
    if (key === state.shown) return
    // A different draft or stage starts at its top (the talk at its newest round).
    const place = draft ? `${draft.id}:${draft.stage}` : 'home'
    const first = state.place !== place
    state.place = place
    state.shown = key
    keepScroll(() => {
      if (!draft) view.main.replaceChildren(homeView())
      else if (draft.stage === 'polish' && draft.card) view.main.replaceChildren(polishView(draft))
      else if (draft.stage === 'write' && draft.card) view.main.replaceChildren(writeView(draft))
      else if (draft.stage === 'plan' && draft.plan && !(draft.job?.kind === 'discuss')) view.main.replaceChildren(planView(draft))
      else view.main.replaceChildren(threadView(draft))
    }, draft?.stage === 'discuss')
    if (first) view.main.scrollTop = draft && draft.stage !== 'discuss' ? 0 : view.main.scrollHeight
  }

  // ─── Home ─────────────────────────────────────────────────────────────
  function homeView() {
    const idea = el('textarea', {
      class: 'forge-idea',
      rows: 3,
      placeholder: '比如：雨夜便利店里遇到的神秘女孩，氛围安静一点',
      oninput: () => (state.idea = idea.value),
      onkeydown: event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault()
          start()
        }
      },
    })
    idea.value = state.idea
    const drafts = state.list.map(d =>
      el('li', { onclick: () => openDraft(d.id) }, [
        el('div', { class: 'item-main' }, [
          el('div', { class: 'item-title' }, [d.title, d.busy ? el('span', { class: 'busy-dot', title: '正在写' }) : null]),
          el('div', { class: 'item-sub', text: `${STAGE_TEXT[d.stage] ?? d.stage} · 聊了 ${d.rounds} 轮 · ${ago(d.updatedAt)}` }),
        ]),
        el('button', { type: 'button', class: 'btn ghost small danger', text: '删除', onclick: event => { event.stopPropagation(); removeDraft(d) } }),
      ]),
    )
    return el('div', { class: 'forge-home' }, [
      el('h3', { class: 'forge-hero', text: '想要一张什么样的卡？' }),
      el('p', { class: 'forge-lead', text: '一句话就够。说不清楚也没关系：向导会一轮轮给你几个具体的选择，每个选项都附一句试读，凭感觉挑，慢慢就聊清楚了。' }),
      idea,
      el('div', { class: 'forge-ideas' }, IDEAS.map(text => el('button', { type: 'button', class: 'chip', text, onclick: () => { state.idea = idea.value = text; idea.focus() } }))),
      el('div', { class: 'forge-start' }, [el('span', { class: 'hint', text: '右上角可以换模型。写卡要动脑筋，强一点的模型效果更好。' }), el('button', { type: 'button', class: 'btn primary', text: '开始聊', onclick: () => start() })]),
      drafts.length ? el('h4', { class: 'forge-h', text: '继续创作' }) : null,
      drafts.length ? el('ul', { class: 'forge-drafts' }, drafts) : null,
    ])
  }

  // ─── 聊想法 ───────────────────────────────────────────────────────────
  function threadView(draft) {
    const items = []
    draft.rounds.forEach((round, i) => {
      const last = i === draft.rounds.length - 1
      items.push(youBubble(round.user, i === 0))
      if (round.assistant) items.push(sayBlock(round.assistant, last && !draft.job && draft.stage === 'discuss'))
    })
    const last = draft.rounds.at(-1)
    if (draft.job) items.push(busyBlock(draft))
    else if (draft.error) items.push(errorBlock(draft.error))
    else if (!last.assistant) items.push(errorBlock({ message: '这一轮还没有回复。' }))
    if (draft.stage === 'plan' && draft.job?.kind === 'discuss') items.push(el('p', { class: 'hint', text: '方案会在这一轮聊完后保留。' }))
    return el('div', { class: 'forge-thread' }, items)
  }

  function youBubble(user, first) {
    const parts = []
    if (!first) for (const pick of user.picks) parts.push(el('div', { class: 'forge-picked' }, [el('span', { class: 'q', text: pick.title }), el('span', { class: 'a', text: pick.delegate ? '你来定' : pick.custom ? `都不是：${pick.custom}` : pick.labels.join('、') })]))
    if (user.text) parts.push(el('p', { text: user.text }))
    return el('div', { class: 'forge-you' }, parts)
  }

  function sayBlock(assistant, live) {
    const paragraphs = assistant.reply.split(/\n+/).filter(Boolean).map(p => el('p', { text: p }))
    const questions = live ? assistant.questions.map(questionCard) : []
    const asked = !live && assistant.questions.length ? el('p', { class: 'forge-asked', text: `问了：${assistant.questions.map(q => q.title).join(' · ')}` }) : null
    const note = live && assistant.unreadable ? el('p', { class: 'hint warn', text: '这次回复的格式不完整，草图没有跟着更新。可以点「换一组问题」重来。' }) : null
    const tools = live
      ? el('div', { class: 'forge-say-tools' }, [
          el('span', { class: 'forge-by', text: assistant.model }),
          el('button', { type: 'button', class: 'btn ghost small', text: '换一组问题', title: '让向导重新回这一轮', onclick: () => retry() }),
        ])
      : null
    return el('div', { class: 'forge-say' }, [el('div', { class: 'forge-voice' }, paragraphs), note, ...questions, asked, tools])
  }

  function busyBlock(draft) {
    const job = draft.job
    const stop = el('button', { type: 'button', class: 'btn ghost small', text: '停下', onclick: () => stopJob() })
    if (job.kind === 'plan') {
      return el('div', { class: 'forge-say busy' }, [
        el('p', { class: 'forge-working' }, [el('span', { class: 'dots' }), `正在把聊过的内容写成创作方案${job.chars ? `（已写 ${job.chars} 字）` : ''}，通常要一两分钟。可以关掉窗口，回来再看。`]),
        el('div', { class: 'forge-say-tools' }, [stop]),
      ])
    }
    const partial = job.partial ? job.partial.split(/\n+/).filter(Boolean).map(p => el('p', { text: p })) : []
    return el('div', { class: 'forge-say busy' }, [
      el('div', { class: 'forge-voice' }, partial),
      el('p', { class: 'forge-working' }, [el('span', { class: 'dots' }), partial.length ? '在想接下来问什么…' : '向导在想…']),
      el('div', { class: 'forge-say-tools' }, [stop]),
    ])
  }

  function errorBlock(error) {
    return el('div', { class: 'forge-error' }, [
      el('p', { text: error.message }),
      el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn small', text: '重试', onclick: () => retry() })]),
    ])
  }

  function pickOf(id) {
    if (!state.picks.has(id)) state.picks.set(id, { labels: new Set(), delegate: false, custom: '', other: false })
    return state.picks.get(id)
  }

  function questionCard(question) {
    const pick = pickOf(question.id)
    const card = el('section', { class: `forge-q ${question.kind}` })
    const paint = () => {
      for (const button of card.querySelectorAll('.forge-opt')) button.setAttribute('aria-pressed', String(pick.labels.has(button.dataset.label)))
      delegate.setAttribute('aria-pressed', String(pick.delegate))
      other.setAttribute('aria-pressed', String(pick.other))
      custom.hidden = !pick.other
      updateFoot()
    }
    const options = question.options.map(option =>
      el('button', {
        type: 'button',
        class: 'forge-opt',
        'data-label': option.label,
        onclick: () => {
          if (question.kind === 'multi') pick.labels.has(option.label) ? pick.labels.delete(option.label) : pick.labels.add(option.label)
          else pick.labels = pick.labels.has(option.label) ? new Set() : new Set([option.label])
          pick.delegate = false
          pick.other = false
          pick.custom = ''
          paint()
        },
      }, [
        el('b', { text: option.label }),
        option.detail ? el('span', { class: 'detail', text: option.detail }) : null,
        option.sample ? el('span', { class: 'sample', text: option.sample }) : null,
      ]),
    )
    const delegate = el('button', { type: 'button', class: 'chip', text: '你来定', title: '交给向导挑最合适的', onclick: () => { pick.delegate = !pick.delegate; pick.labels = new Set(); pick.other = false; paint() } })
    const other = el('button', { type: 'button', class: 'chip', text: '都不是…', onclick: () => { pick.other = !pick.other; pick.labels = new Set(); pick.delegate = false; paint(); if (pick.other) custom.focus() } })
    const custom = el('input', { type: 'text', class: 'forge-custom', placeholder: '说说你想要的', oninput: () => { pick.custom = custom.value.trim(); updateFoot() } })
    custom.value = pick.custom
    card.append(
      ...[
        el('header', {}, [el('h3', { text: question.title }), question.kind === 'multi' ? el('span', { class: 'tag', text: '可多选' }) : null, question.kind === 'taste' ? el('span', { class: 'tag', text: '凭感觉挑一段' }) : null]),
        question.why ? el('p', { class: 'why', text: question.why }) : null,
        el('div', { class: 'forge-opts' }, options),
        el('div', { class: 'forge-more' }, [delegate, other, custom]),
      ].filter(Boolean),
    )
    paint()
    return card
  }

  /** The picks as the server takes them; questions without an answer are left out. */
  function picksList() {
    const draft = state.draft
    const questions = draft?.rounds.at(-1)?.assistant?.questions ?? []
    return questions
      .map(q => {
        const pick = state.picks.get(q.id)
        if (!pick) return null
        const custom = pick.other ? pick.custom : ''
        if (!pick.labels.size && !pick.delegate && !custom) return null
        return { id: q.id, labels: [...pick.labels], delegate: pick.delegate, custom }
      })
      .filter(Boolean)
  }

  function updateFoot() {
    const draft = state.draft
    if (!draft) return
    const busy = Boolean(draft.job)
    const waiting = !draft.rounds.at(-1)?.assistant
    const picks = picksList().length
    const asked = draft.rounds.at(-1)?.assistant?.questions.length ?? 0
    view.pickCount.textContent = asked ? `${picks} / ${asked} 个问题已选` : ''
    view.send.disabled = busy || waiting || (!picks && !view.composer.value.trim())
    view.toPlan.disabled = busy || !draft.rounds.some(r => r.assistant)
    view.toPlan.classList.toggle('ready', draft.brief.readiness >= 75)
    view.undo.hidden = draft.rounds.length < 2
    view.undo.disabled = busy
    view.composer.disabled = busy
    const notes = [...state.notes.values()].some(Boolean) || state.planText.trim()
    view.revise.disabled = busy || !notes
    view.revise.classList.toggle('primary', Boolean(notes))
    view.back.disabled = busy
    view.planText.disabled = busy
    // 定方案 → 动笔: once written, the main button goes back to the card; writing again is the quiet one.
    const card = draft.card
    view.write.textContent = card?.writtenAt ? '回到打磨' : card ? '接着写' : '开始写这张卡'
    view.write.disabled = busy || Boolean(notes) || !draft.plan
    view.write.title = notes ? '先按意见改好方案，再动笔' : ''
    view.write.classList.toggle('primary', !notes)
    view.rewriteAll.hidden = !card
    view.rewriteAll.disabled = busy
    // 打磨: save, then talk to it or take the PNG.
    const savedId = card?.savedCardId
    view.save.textContent = savedId ? '更新这张卡' : '保存为角色卡'
    view.save.disabled = busy
    view.chat.hidden = !savedId
    view.png.hidden = !savedId
    if (savedId) {
      view.png.href = `/api/cards/${savedId}/avatar?v=${encodeURIComponent(card.savedAt ?? '')}`
      view.png.download = `${draft.title}.png`
    }
    view.saved.textContent = savedId ? `已保存 ${ago(card.savedAt)}` : ''
    view.toPlanBack.disabled = busy
  }

  // ─── 设定草图 ─────────────────────────────────────────────────────────
  function renderSketch() {
    const draft = state.draft
    if (!draft) {
      view.sketch.replaceChildren()
      return
    }
    const brief = draft.brief
    // Do not pull an item out from under the user while they are editing it.
    if (view.sketch.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return
    const ready = brief.readiness
    const items = brief.items.map((item, index) => sketchItem(item, index))
    const title = el('input', { class: 'sketch-title', value: brief.title, placeholder: '卡的暂定名', 'aria-label': '卡的暂定名', onchange: () => saveBrief({ title: title.value }) })
    // On a phone the sketch folds to its title row; a tap opens it.
    const head = el('div', {
      class: 'sketch-head',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(state.sketchOpen === true),
      onclick: () => {
        state.sketchOpen = !state.sketchOpen
        view.sketch.classList.toggle('open', state.sketchOpen)
        head.setAttribute('aria-expanded', String(state.sketchOpen))
      },
    }, [el('span', { class: 'sketch-label', text: '设定草图' }), el('span', { class: 'sketch-pct', text: `成形 ${ready}%` })])
    view.sketch.classList.toggle('open', state.sketchOpen === true)
    view.sketch.replaceChildren(
      ...[
        head,
        el('div', { class: 'sketch-bar' }, [el('i', { style: `width: ${ready}%` })]),
        el('p', { class: 'sketch-hint', text: ready >= 75 ? '关键的几件事都清楚了：可以出方案，也可以接着细化。' : '点任何一项可以直接改；锁上的项向导不会再动。' }),
        title,
        items.length ? el('ul', { class: 'sketch-items' }, items) : el('p', { class: 'sketch-empty', text: '聊一轮之后，这里会出现舞台、角色、关系这些设定。' }),
        brief.open.length ? el('div', { class: 'sketch-open' }, [el('span', { class: 'sketch-label', text: '还没定' }), ...brief.open.map(text => el('span', { class: 'chip quiet', text }))]) : null,
      ].filter(Boolean),
    )
  }

  function sketchItem(item, index) {
    const value = el('div', { class: 'sketch-value', tabindex: '0', role: 'button', title: '点一下修改', text: item.value || '（空）' })
    const edit = () => {
      const box = el('textarea', { class: 'sketch-edit', rows: 3 })
      box.value = item.value
      const done = save => {
        if (save && box.value.trim() !== item.value) changeItem(index, { value: box.value.trim(), by: 'user' })
        else renderSketch()
      }
      box.addEventListener('blur', () => done(true))
      box.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          event.preventDefault()
          box.blur()
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) box.blur()
      })
      value.replaceWith(box)
      box.focus()
    }
    value.addEventListener('click', edit)
    value.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        edit()
      }
    })
    const lock = el('button', {
      type: 'button',
      class: `sketch-lock${item.locked ? ' on' : ''}`,
      title: item.locked ? '已锁定：向导不会再改它。点一下解锁' : '锁定：向导之后不会再改它',
      'aria-label': item.locked ? '解锁' : '锁定',
      'aria-pressed': String(item.locked),
      html: item.locked ? ICON_LOCK : ICON_OPEN,
      onclick: () => changeItem(index, { locked: !item.locked, by: item.locked ? item.by : 'user' }),
    })
    return el('li', { class: item.locked ? 'locked' : '' }, [
      el('div', { class: 'sketch-row' }, [el('span', { class: 'sketch-key', text: item.label }), el('span', { class: `sketch-by ${item.by}`, text: item.by === 'user' ? '你定的' : '向导补的' }), lock]),
      value,
    ])
  }

  const changeItem = guard(async (index, patch) => {
    const items = state.draft.brief.items.map((item, i) => (i === index ? { ...item, ...patch } : item))
    await saveBrief({ items })
  })

  const saveBrief = guard(async patch => {
    const brief = { title: state.draft.brief.title, items: state.draft.brief.items, ...patch }
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { brief } }))
  })

  // ─── 定方案 ───────────────────────────────────────────────────────────
  function planView(draft) {
    const plan = draft.plan
    const core = plan.characters.filter(c => c.kind === 'core')
    const npcs = plan.characters.filter(c => c.kind === 'npc')
    const fields = pairs => el('dl', { class: 'plan-fields' }, pairs.filter(([, v]) => v && (!Array.isArray(v) || v.length)).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: Array.isArray(v) ? v.join('；') : v })]))
    const bullets = (items, cls = '') => el('ul', { class: `plan-list ${cls}` }, items.map(text => el('li', { text })))
    const sections = [
      section('概要', [
        el('p', { class: 'plan-name', text: plan.name }),
        plan.summary ? el('p', { class: 'plan-summary', text: plan.summary }) : null,
        draft.planModel ? el('p', { class: 'hint', text: `方案由 ${draft.planModel} 写` }) : null,
      ]),
      plan.warnings.length ? el('div', { class: 'plan-warn' }, [el('b', { text: '写之前看一眼' }), bullets(plan.warnings)]) : null,
      plan.assumptions.length
        ? section('向导补的设定', [el('p', { class: 'hint', text: '这些是你没说过、向导替你补上的。不合意的，在下面写一句就会改掉。' }), bullets(plan.assumptions, 'assumed')], 'lamp')
        : null,
      section('你的身份', [fields([['身份', plan.user_role.identity], ['限制', plan.user_role.constraints]])]),
      section('舞台', [
        fields([['类型', plan.world.kind], ['概述', plan.world.overview]]),
        plan.world.rules.length ? el('h5', { text: '和常识不同的规则' }) : null,
        plan.world.rules.length ? bullets(plan.world.rules) : null,
        plan.world.places.length ? el('h5', { text: '地点' }) : null,
        ...plan.world.places.map(p => fields([[p.name, [p.description, p.scenes.length ? `场所：${p.scenes.join('、')}` : ''].filter(Boolean).join(' ')]])),
        plan.world.factions.length ? el('h5', { text: '势力' }) : null,
        ...plan.world.factions.map(f => fields([[f.name, f.description]])),
        plan.world.history.length ? el('h5', { text: '往事' }) : null,
        plan.world.history.length ? bullets(plan.world.history.map(h => [h.event, h.impact].filter(Boolean).join('：'))) : null,
      ]),
      section('角色', [...core.map(c => characterCard(c, fields)), ...npcs.map(c => characterCard(c, fields))]),
      section('文风与扮演', [
        fields([['视角', plan.style.perspective], ['语言', plan.style.tone], ['氛围', plan.style.mood], ['参照', plan.style.reference], ['特别要求', plan.style.special]]),
        plan.play_rules.length ? el('h5', { text: '扮演准则' }) : null,
        plan.play_rules.length ? bullets(plan.play_rules) : null,
      ]),
      section('状态记录', [
        plan.tracking.enabled
          ? el('table', { class: 'plan-vars' }, [
              el('tr', {}, ['变量', '初始', '范围', '怎么变'].map(t => el('th', { text: t }))),
              ...plan.tracking.variables.map(v => el('tr', {}, [v.path, v.initial, v.range, v.check].map(t => el('td', { text: t })))),
            ])
          : el('p', { class: 'hint', text: '不记录会变化的数值。想要好感度、体力这类数值，在下面写一句。' }),
      ]),
      section('开场白', [el('ol', { class: 'plan-list' }, plan.greetings.map(g => el('li', {}, [el('b', { text: g.title }), el('span', { text: ` ${[g.scene, g.situation].filter(Boolean).join('：')}（${g.length} 字）` })])))]),
      section('世界书', [
        el('p', { class: 'hint', text: '常驻的每轮都在；「提到时」的只在对话里出现关键词时才交给模型，省上下文。这些按规则自动配好。' }),
        el('ul', { class: 'plan-entries' }, plan.entries.map(entryRow)),
      ]),
      section('头像', [fields([['画谁', plan.avatar.character], ['样子', plan.avatar.description]])]),
    ]
    return el('div', { class: 'forge-plan' }, [
      draft.job?.kind === 'plan' ? busyBlock(draft) : draft.error ? errorBlock(draft.error) : null,
      el('p', { class: 'forge-lead', text: '方案出来了。哪里不合意，就在那一块点「提意见」写一句，写完点下面的「按意见修改方案」；也可以回去接着聊。' }),
      ...sections,
    ])
  }

  function characterCard(c, fields) {
    const p = c.personality
    return el('div', { class: 'plan-char' }, [
      el('div', { class: 'plan-char-head' }, [el('b', { text: c.name }), el('span', { class: `tag${c.kind === 'npc' ? ' off' : ''}`, text: c.kind === 'npc' ? '配角' : '核心角色' }), c.aliases.length ? el('span', { class: 'hint', text: `也叫 ${c.aliases.join('、')}` }) : null]),
      fields([
        ['身份', [c.identity, c.age, c.gender].filter(Boolean).join('，')],
        ['和你', c.relationship],
        ['外貌', c.appearance],
        ['穿着', c.outfit],
        ['性格', [p.base && `底色「${p.base}」`, p.main.length && `主色调${p.main.map(m => `「${m}」`).join('')}`, p.accent.length && `点缀${p.accent.map(m => `「${m}」`).join('')}`].filter(Boolean).join('，')],
        ['说话', c.voice],
        ['作用', c.role],
        ['几副面孔', c.facets ? '会写不同处境下判若两人的几面' : ''],
      ]),
    ])
  }

  function entryRow(entry) {
    const [text, cls] = STRATEGY[entry.strategy] ?? ['', '']
    return el('li', {}, [
      el('div', { class: 'plan-entry-head' }, [el('b', { text: entry.name }), el('span', { class: `strategy ${cls}`, text: text }), el('span', { class: 'hint', text: POSITION[entry.position] })]),
      el('div', { class: 'plan-entry-sub' }, [entry.purpose, entry.strategy === 'keyword' && entry.keywords.length ? `　关键词：${entry.keywords.join('、')}` : ''].join('')),
    ])
  }

  function section(title, children, tone = '') {
    const note = el('textarea', { class: 'plan-note', rows: 2, placeholder: `关于「${title}」想怎么改`, oninput: () => { state.notes.set(title, note.value); updateFoot() } })
    note.value = state.notes.get(title) ?? ''
    note.hidden = !note.value
    const toggle = el('button', { type: 'button', class: 'btn ghost small', text: '提意见', onclick: () => { note.hidden = !note.hidden; if (!note.hidden) note.focus() } })
    return el('section', { class: `plan-card ${tone}` }, [el('header', {}, [el('h4', { text: title }), toggle]), ...children.filter(Boolean), note])
  }

  // ─── 动笔 ─────────────────────────────────────────────────────────────
  function writeView(draft) {
    const job = draft.job
    const steps = draft.writing.map(step => {
      const mark = { done: '✓', running: '', failed: '!', waiting: '' }[step.state]
      const extra = step.state === 'running' && job?.chars ? `已写 ${job.chars} 字` : step.state === 'failed' ? '没写成' : ''
      return el('li', { class: step.state }, [el('span', { class: 'mark', text: mark }), el('span', { class: 'label', text: step.label }), extra ? el('span', { class: 'extra', text: extra }) : null])
    })
    const written = draft.card.entries.filter(e => e.content && e.type !== '状态')
    const running = Boolean(job)
    return el('div', { class: 'forge-write' }, [
      el('h3', { class: 'forge-hero', text: running ? '正在写这张卡' : draft.error ? '写到一半停下了' : '还差几步' }),
      el('p', { class: 'forge-lead', text: running ? '按方案一步步写：先写世界和角色，后面的参照前面的保持一致；最后检查一遍套话和前后矛盾。可以关掉窗口，回来再看。' : '已经写好的部分都留着，从停下的地方接着写。' }),
      el('ol', { class: 'write-steps' }, steps),
      draft.error ? el('div', { class: 'forge-error' }, [el('p', { text: draft.error.message })]) : null,
      el('div', { class: 'row' }, [
        running ? el('button', { type: 'button', class: 'btn', text: '停下', onclick: () => stopJob() }) : el('button', { type: 'button', class: 'btn primary', text: '接着写', onclick: () => startWrite() }),
      ]),
      written.length ? el('p', { class: 'hint', text: `已写好：${written.map(e => e.name).join('、')}` }) : null,
    ])
  }

  // ─── 打磨与头像 ───────────────────────────────────────────────────────
  function polishView(draft) {
    const card = draft.card
    const busy = Boolean(draft.job)
    const working = target => busy && draft.job.step === target
    const checks = card.checks ?? []
    const byOrder = [...card.entries].sort((a, b) => a.order - b.order)
    return el('div', { class: 'forge-polish' }, [
      draft.error && draft.error.kind !== 'avatar' ? errorBlock(draft.error) : null,
      avatarHero(draft),
      checks.length
        ? el('section', { class: 'plan-card lamp' }, [
            el('header', {}, [el('h4', { text: `还有 ${checks.length} 处可能的套话` })]),
            el('p', { class: 'hint', text: '程序按常见套话扫出来的，不一定都要改。点「按这条改」让向导改写那一段。' }),
            el('ul', { class: 'check-list' }, checks.slice(0, 20).map(hit => el('li', {}, [
              el('span', { class: 'check-where', text: hit.target }),
              el('span', { class: 'tag', text: hit.label }),
              el('span', { class: 'check-text', text: `…${hit.excerpt}…` }),
              el('button', { type: 'button', class: 'btn ghost small', text: '按这条改', disabled: busy, onclick: () => rewrite(hit.target, `去掉这里的「${hit.label}」：「${hit.excerpt.trim()}」，换成具体的写法`) }),
            ]))),
          ])
        : el('p', { class: 'hint', text: card.issuesFound ? `检查过了：向导挑出 ${card.issuesFound} 处毛病，已经改好。` : '检查过了，没有发现常见的套话。' }),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: '开场白' })]),
        ...card.greetings.map((g, i) => pieceBlock({ target: `开场白${i + 1}`, title: g.title || `开场 ${i + 1}`, text: g.text, reading: true, working: working(`开场白${i + 1}`), busy })),
      ]),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: `世界书 · ${card.entries.length} 条` })]),
        el('p', { class: 'hint', text: '按发给模型的顺序排列。点条目名展开；状态记录的几条由程序生成。' }),
        ...byOrder.map(entry => entryBlock(entry, { busy, working: working(entry.name) })),
      ]),
      el('section', { class: 'plan-card' }, [
        el('header', {}, [el('h4', { text: '卡片信息' })]),
        pieceBlock({ target: 'description', title: '角色描述（发给模型，几行速览）', text: card.description, busy, noRewrite: true }),
        pieceBlock({ target: 'notes', title: '创作者备注（给玩家看，不发给模型）', text: card.creatorNotes, busy, noRewrite: true }),
      ]),
    ])
  }

  /** One editable piece: an opening, an entry's text, or a card field. */
  function pieceBlock({ target, title, text, reading = false, working = false, busy = false, noRewrite = false, head = null }) {
    const editing = state.editing === target
    const noting = state.noteFor === target
    const body = editing
      ? (() => {
          const box = el('textarea', { class: 'piece-edit', rows: Math.min(24, Math.max(6, text.split('\n').length + 2)) })
          box.value = text
          return el('div', {}, [
            box,
            el('div', { class: 'row end' }, [
              el('button', { type: 'button', class: 'btn ghost small', text: '取消', onclick: () => { state.editing = null; state.shown = ''; renderMain() } }),
              el('button', { type: 'button', class: 'btn small primary', text: '保存修改', onclick: () => saveEdit(target, box.value) }),
            ]),
          ])
        })()
      : reading && text
        ? el('div', { class: 'piece-read' }, text.split(/\n+/).filter(Boolean).map(p => el('p', { text: p })))
        : el('div', { class: reading ? 'piece-read' : 'piece-text', text: text || '（空）' })
    const note = noting
      ? (() => {
          const input = el('input', { type: 'text', class: 'piece-note', placeholder: '想怎么改，比如：再短一点；她不该这么快就信任你', onkeydown: event => { if (event.key === 'Enter' && !event.isComposing) rewrite(target, input.value) } })
          input.value = state.noteText
          input.addEventListener('input', () => (state.noteText = input.value))
          queueMicrotask(() => input.focus())
          return el('div', { class: 'piece-noting' }, [input, el('button', { type: 'button', class: 'btn small primary', text: '重写', onclick: () => rewrite(target, input.value) }), el('button', { type: 'button', class: 'btn ghost small', text: '算了', onclick: () => { state.noteFor = null; state.shown = ''; renderMain() } })])
        })()
      : null
    const tools = editing || noting
      ? null
      : el('div', { class: 'piece-tools' }, [
          working ? el('span', { class: 'forge-working' }, [el('span', { class: 'dots' }), '正在重写…']) : null,
          el('button', { type: 'button', class: 'btn ghost small', text: '编辑', disabled: busy, onclick: () => { state.editing = target; state.noteFor = null; state.shown = ''; renderMain() } }),
          noRewrite ? null : el('button', { type: 'button', class: 'btn ghost small', text: '按意见重写', disabled: busy, onclick: () => { state.noteFor = target; state.noteText = ''; state.editing = null; state.shown = ''; renderMain() } }),
        ])
    return el('div', { class: `piece${working ? ' working' : ''}` }, [el('div', { class: 'piece-head' }, [head ?? el('b', { text: title }), tools]), note, body])
  }

  function entryBlock(entry, { busy, working }) {
    const [text, cls] = STRATEGY[entry.strategy] ?? ['', '']
    const open = state.open.has(entry.name) || state.editing === entry.name || state.noteFor === entry.name || working
    const generated = entry.type === '状态'
    const head = el('button', { type: 'button', class: 'entry-toggle', 'aria-expanded': String(open), onclick: () => { open ? state.open.delete(entry.name) : state.open.add(entry.name); state.shown = ''; renderMain() } }, [
      el('b', { text: entry.name }),
      el('span', { class: `strategy ${cls}`, text }),
      el('span', { class: 'hint', text: POSITION[entry.position] }),
      entry.strategy === 'keyword' ? el('span', { class: 'hint', text: `关键词：${entry.keywords.join('、')}` }) : null,
      open ? null : el('span', { class: 'hint', text: `${entry.content.length} 字` }),
    ])
    if (!open) return el('div', { class: 'piece folded' }, [el('div', { class: 'piece-head' }, [head])])
    return pieceBlock({ target: entry.name, title: entry.name, text: entry.content, busy, working, noRewrite: generated, head })
  }

  function avatarHero(draft) {
    const card = draft.card
    const plan = draft.plan
    const drawing = draft.job?.kind === 'avatar'
    const picture = card.avatar
      ? el('img', { class: 'hero-img', src: `/api/forge/${draft.id}/avatar?t=${encodeURIComponent(card.avatar.at)}`, alt: `${plan.name}的头像` })
      : el('div', { class: 'hero-img blank' }, [el('span', { text: [...plan.name][0] ?? '?' })])
    const scene = el('textarea', { class: 'hero-scene', rows: 3, placeholder: 'English tags for the picture: 1girl, wet hair, raincoat, convenience store, night, rain' })
    // An uploaded picture has no scene of its own: show the plan's.
    scene.value = state.avatarDesc ?? (card.avatar?.description || plan.avatar.tags)
    scene.addEventListener('input', () => (state.avatarDesc = scene.value))
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: () => uploadAvatar(upload.files[0]) })
    const error = draft.error?.kind === 'avatar' ? el('p', { class: 'hint warn', text: draft.error.message }) : null
    return el('section', { class: 'forge-hero-card' }, [
      el('div', { class: `hero-frame${drawing ? ' drawing' : ''}` }, [picture, drawing ? el('span', { class: 'hero-busy' }, [el('span', { class: 'dots' }), '正在画…']) : null]),
      el('div', { class: 'hero-body' }, [
        el('p', { class: 'plan-name', text: plan.name }),
        plan.summary ? el('p', { class: 'plan-summary', text: plan.summary }) : null,
        el('p', { class: 'hint', text: card.avatar ? `头像${card.avatar.source === 'upload' ? '是你上传的' : `由 ${card.avatar.backend || '画图后端'} 画`}。` : '还没有头像：用「配图」里设好的画图方式画一张，或者上传一张；都没有的话，保存时会做一张带名字的头像。' }),
        el('label', { class: 'hero-label', text: '画面描述' }),
        scene,
        error,
        el('div', { class: 'row' }, [
          drawing
            ? el('button', { type: 'button', class: 'btn', text: '停下', onclick: () => stopJob() })
            : el('button', { type: 'button', class: 'btn', text: card.avatar ? '换一张' : '画头像', disabled: Boolean(draft.job), onclick: () => drawAvatar(scene.value) }),
          el('button', { type: 'button', class: 'btn ghost', text: '上传图片', disabled: Boolean(draft.job), onclick: () => upload.click() }),
          upload,
        ]),
      ]),
    ])
  }

  /** A name card for a card without a picture: the first character large, on a quiet colour from the name. */
  function nameCard(name) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 768
    const g = canvas.getContext('2d')
    const hues = [198, 28, 160, 340, 255, 45]
    const hue = hues[[...name].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % hues.length]
    g.fillStyle = `hsl(${hue} 26% 20%)`
    g.fillRect(0, 0, 512, 768)
    g.fillStyle = `hsl(${hue} 50% 72% / .16)`
    g.beginPath()
    g.arc(372, 210, 128, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = `hsl(${hue} 30% 92%)`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = '600 230px "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif'
    g.fillText([...name][0] ?? '?', 256, 400)
    g.font = '500 44px "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif'
    g.fillText([...name].slice(0, 10).join(''), 256, 640)
    return canvas.toDataURL('image/png')
  }

  /** Any picture the page can load, as PNG (cards carry their data in PNG text chunks). */
  async function pngOf(url) {
    const img = new Image()
    // onload rather than decode(): decode() can wait forever while the page is in the background.
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('读不了头像图片，换一张试试'))
      img.src = url
    })
    const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }

  // ─── Actions ──────────────────────────────────────────────────────────
  const start = guard(async () => {
    const text = state.idea.trim()
    if (!text) {
      toast('先说说你想要一张什么样的卡，一句话也行')
      return
    }
    const draft = await api('/api/forge', { method: 'POST', body: { text, model: state.homeModel } })
    state.idea = ''
    apply(draft)
  })

  const send = guard(async () => {
    const draft = state.draft
    if (view.send.disabled) return
    const body = { text: view.composer.value.trim(), picks: picksList() }
    const next = await api(`/api/forge/${draft.id}/say`, { method: 'POST', body })
    view.composer.value = ''
    apply(next)
  })

  const makePlan = guard(async () => {
    const draft = state.draft
    if (draft.brief.readiness < 50 && !confirm('关键的设定还没聊清楚，现在出方案，向导会补很多它自己的设想。还是现在出？')) return
    // Words typed but not sent still count.
    if (view.composer.value.trim() || picksList().length) {
      if (!confirm('输入框里还有没发出去的话。先出方案的话，这些不会算进去。继续？')) return
    }
    apply(await api(`/api/forge/${draft.id}/plan`, { method: 'POST' }))
  })

  const revise = guard(async () => {
    const notes = [...state.notes.entries()].filter(([, text]) => text.trim()).map(([section, text]) => ({ section, text }))
    const next = await api(`/api/forge/${state.draft.id}/revise`, { method: 'POST', body: { text: state.planText, notes } })
    state.notes = new Map()
    state.planText = view.planText.value = ''
    apply(next)
  })

  const retry = guard(async () => apply(await api(`/api/forge/${state.draft.id}/retry`, { method: 'POST' })))
  const undo = guard(async () => {
    if (!confirm('撤回你上一次的回答和向导对它的回复？')) return
    apply(await api(`/api/forge/${state.draft.id}/undo`, { method: 'POST' }))
  })
  const stopJob = guard(async () => {
    await api(`/api/forge/${state.draft.id}/stop`, { method: 'POST' })
    apply(await api(`/api/forge/${state.draft.id}`))
  })
  const startWrite = guard(async (restart = false) => {
    const draft = state.draft
    if (draft.card?.writtenAt && !restart) return setStage('polish')
    if (restart && !confirm('按现在的方案从头再写一遍？已经写好的内容和你的修改都会被替换（头像保留）。')) return
    state.open = new Set()
    apply(await api(`/api/forge/${draft.id}/write`, { method: 'POST', body: { restart } }))
  })

  const rewrite = guard(async (target, note) => {
    const text = String(note ?? '').trim()
    if (!text) {
      toast('先写下想怎么改')
      return
    }
    state.noteFor = null
    state.noteText = ''
    state.open.add(target)
    apply(await api(`/api/forge/${state.draft.id}/rewrite`, { method: 'POST', body: { target, note: text } }))
  })

  const saveEdit = guard(async (target, text) => {
    const body = target === 'description' ? { description: text } : target === 'notes' ? { creatorNotes: text } : /^开场白\d+$/.test(target) ? { greetings: state.draft.card.greetings.map((g, i) => (`开场白${i + 1}` === target ? text : g.text)) } : { entries: [{ name: target, content: text }] }
    const next = await api(`/api/forge/${state.draft.id}/card`, { method: 'PUT', body })
    state.editing = null
    apply(next)
  })

  const drawAvatar = guard(async description => {
    apply(await api(`/api/forge/${state.draft.id}/avatar`, { method: 'POST', body: { description } }))
  })

  const uploadAvatar = guard(async file => {
    if (!file) return
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('读不了这张图片'))
      reader.readAsDataURL(file)
    })
    apply(await api(`/api/forge/${state.draft.id}/avatar`, { method: 'PUT', body: { image } }))
  })

  const saveCard = guard(async () => {
    const draft = state.draft
    const avatar = draft.card.avatar ? await pngOf(`/api/forge/${draft.id}/avatar?t=${encodeURIComponent(draft.card.avatar.at)}`) : nameCard(draft.plan.name)
    const result = await api(`/api/forge/${draft.id}/save`, { method: 'POST', body: { avatar } })
    apply(result.draft)
    await onCardSaved?.(result.card.id)
    toast(result.updated ? `「${result.card.name}」已更新，原来的对话都还在。` : `已保存为角色卡「${result.card.name}」，在左边的角色卡列表里。角色名册（长相、衣着）也一起建好了。`)
  })

  const startChat = guard(async () => {
    const id = state.draft?.card?.savedCardId
    if (!id) return
    dialog.close()
    await startChatWith?.(id)
  })

  const setStage = guard(async stage => {
    if (!state.draft || stage === state.draft.stage || !STAGE_TEXT[stage]) return
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { stage } }))
  })

  const changeModel = guard(async () => {
    const value = view.model.value
    if (value === MANAGE_PROVIDERS) {
      renderModels()
      openProviders?.()
      return
    }
    if (!state.draft) {
      state.homeModel = value
      return
    }
    apply(await api(`/api/forge/${state.draft.id}`, { method: 'PUT', body: { model: value } }))
  })

  const openDraft = guard(async id => {
    state.shown = ''
    apply(await api(`/api/forge/${id}`))
  })

  const removeDraft = guard(async draft => {
    if (!confirm(`删除草稿「${draft.title}」？聊过的内容和方案都会删掉。`)) return
    await api(`/api/forge/${draft.id}`, { method: 'DELETE' })
    await goHome()
  })

  const goHome = guard(async () => {
    clearTimeout(state.poll)
    state.draft = null
    state.shown = ''
    state.list = await api('/api/forge')
    render()
  })

  dialog.addEventListener('close', () => clearTimeout(state.poll))
  // Esc while editing a sketch item only ends the edit (handled there).

  return {
    async open() {
      if (!view.main) layout()
      await loadModels()
      if (!dialog.open) dialog.showModal()
      if (state.draft) {
        state.shown = ''
        await openDraft(state.draft.id)
      } else await goHome()
    },
  }
}
