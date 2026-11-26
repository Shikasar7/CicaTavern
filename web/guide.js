// 剧情向导 (plans/21): a panel beside the story to talk it over with an assistant, and the bar above the input box of
// the plan the story follows. The server keeps the talk (server/guide.mjs) and writes each answer in the background:
// the panel reads it again while one is being written. The plan is the chat's (chat.guide, its view from
// server/guide-text.mjs guideView): taking, changing and ending it answer with the chat.
import { t } from '/i18n.js'
import { markdownHtml } from '/render.js'

const STRENGTHS = () => [
  ['hint', t`只铺垫`, t`这几轮只埋下迹象，不让它真的发生`],
  ['steady', t`自然推进`, t`顺着当下的情节一点点靠近，几轮之内自然发生`],
  ['soon', t`尽快引爆`, t`一两轮之内找个契机让它发生`],
]
const strengthName = key => (STRENGTHS().find(([id]) => id === key) ?? STRENGTHS()[1])[1]
const IDEAS = () => [t`接下来可以怎么发展？`, t`她现在对我是什么态度？为什么？`, t`有哪些埋下了还没收的伏笔？`, t`这种故事怎么写才好看？`]
const POLL_MS = 900
const SPOT_KEY = 'cicatavern.guideDock'
const SIZE_KEY = 'cicatavern.guideSize'
// On a phone the keyboard's Enter key starts a new line (it has no Shift+Enter); the button sends.
const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)')
const phone = matchMedia('(max-width: 560px)')

const ICON_COMPASS = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" /><path d="M12.9 7.1 11.2 11.2 7.1 12.9 8.8 8.8Z" /></svg>'

/**
 * @param deps - { api, el, guard, toast, getChat, setChat, getModels, openProviders, branchFrom(id, label): the next turn sent
 *   from an earlier reply (回到岔路口 on the route map), plotActions: { use, write, fromChat, manage, edit, count }: the
 *   剧本 tab's ways in, for a chat on a plot or not }
 * @returns { open({ tab }), sync(chat) }: sync after each drawing of the chat (its bar, the panel following another
 *   chat). A chat on a 剧本 has a second tab in the panel, its route map (web/plot-map.js).
 */
export function initGuide({ api, el, guard, toast, getChat, setChat, getModels, openProviders, branchFrom = () => {}, plotActions = null }) {
  const bar = document.getElementById('guide-bar')
  const state = { chatId: null, view: null, poll: null, editing: false, strength: {}, drawn: '', tab: 'talk', mapKey: '' }

  // ─── The panel ──────────────────────────────────────────────────────────
  const title = el('h2', { class: 'guide-title', html: `${ICON_COMPASS}<span>${t`剧情向导`}</span>` })
  const model = el('select', { class: 'guide-model', 'aria-label': t`向导用哪个模型` })
  const read = el('span', { class: 'guide-read muted small' })
  const clearButton = el('button', { type: 'button', class: 'btn small ghost', text: t`清空`, title: t`清空和向导的对话；正在进行的引导不受影响` })
  const closeButton = el('button', { type: 'button', class: 'btn small ghost', text: t`收起`, title: t`收起窗口；按「剧情向导」再打开` })
  const tabs = el('div', { class: 'guide-tabs', role: 'tablist', hidden: true }, [
    el('button', { type: 'button', role: 'tab', 'data-tab': 'talk', text: t`向导` }),
    el('button', { type: 'button', role: 'tab', 'data-tab': 'plot', text: t`剧本` }),
  ])
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab
    if (tab) showTab(tab)
  })
  const head = el('div', { class: 'guide-head' }, [title, tabs, el('div', { class: 'guide-tools' }, [clearButton, closeButton])])
  const sub = el('div', { class: 'guide-sub' }, [model, read])
  const thread = el('div', { class: 'guide-thread', 'aria-live': 'polite' })
  const mapBox = el('div', { class: 'guide-map', hidden: true })
  const input = el('textarea', { class: 'guide-input', rows: '2', placeholder: t`问问剧情、人物，或者想让故事往哪走` })
  const send = el('button', { type: 'button', class: 'btn small primary', text: t`发送` })
  const stop = el('button', { type: 'button', class: 'btn small', text: t`停止`, hidden: true })
  const compose = el('div', { class: 'guide-compose' }, [input, el('div', { class: 'guide-send' }, [stop, send])])
  const panel = el('section', { class: 'guide-panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': t`剧情向导`, hidden: true }, [head, sub, thread, mapBox, compose])
  document.body.append(panel)
  const isOpen = () => !panel.hidden

  // Docked above the input box, bottom right; dragged by its title row to where the player wants it, and resized by its
  // edges and corners, both kept on this device; a double click there puts it back. A phone has it as a sheet from the
  // bottom.
  let spot = (() => {
    try {
      const kept = JSON.parse(localStorage.getItem(SPOT_KEY) || 'null')
      return kept && Number.isFinite(kept.x) && Number.isFinite(kept.y) ? kept : null
    } catch {
      return null
    }
  })()
  const keepSpot = () => {
    try {
      if (spot) localStorage.setItem(SPOT_KEY, JSON.stringify(spot))
      else localStorage.removeItem(SPOT_KEY)
    } catch {}
  }
  function place() {
    const vn = document.querySelector('.stage.vn-on')
    const under = vn ? vn.querySelector('.vn-box') : document.getElementById('composer')
    const top = under?.getBoundingClientRect().top ?? 0
    // Above the input box (and the 剧本 bar, open or not) while there is room for the panel; else over it, at the foot.
    const room = top - 20
    const above = top > 0 && room >= 280
    panel.style.setProperty('--dock-bottom', `${above ? Math.max(12, Math.round(window.innerHeight - top + 8)) : top > 0 ? 12 : 96}px`)
    panel.style.setProperty('--dock-room', above ? `${Math.round(room)}px` : 'none')
    const moved = Boolean(spot) && !phone.matches
    panel.classList.toggle('moved', moved)
    if (!moved) return
    const x = Math.min(Math.max(0, spot.x), Math.max(0, window.innerWidth - panel.offsetWidth))
    const y = Math.min(Math.max(0, spot.y), Math.max(0, window.innerHeight - panel.offsetHeight))
    panel.style.setProperty('--dock-x', `${Math.round(x)}px`)
    panel.style.setProperty('--dock-y', `${Math.round(y)}px`)
    spot = { x, y }
  }
  window.addEventListener('resize', () => isOpen() && place())
  // The input box growing (the 剧本 bar's card opened, a long line typed): the panel keeps above it.
  const composer = document.getElementById('composer')
  if (composer && typeof ResizeObserver === 'function') new ResizeObserver(() => isOpen() && place()).observe(composer)
  head.addEventListener('pointerdown', event => {
    if (phone.matches || event.button !== 0 || event.target.closest('button')) return
    event.preventDefault()
    const box = panel.getBoundingClientRect()
    const dx = event.clientX - box.left
    const dy = event.clientY - box.top
    panel.classList.add('dragging')
    const move = moved => {
      spot = { x: moved.clientX - dx, y: moved.clientY - dy }
      place()
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      panel.classList.remove('dragging')
      keepSpot()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  })
  // The size the player gave it (--size-w, --size-h in style.css). Resized by a top or left edge while docked, it stays
  // docked above the input box; by a right or bottom edge it stays where the player put it.
  let size = null
  let forgetSize = () => {}
  const applySize = () => {
    for (const [name, value] of [['--size-w', size?.w], ['--size-h', size?.h]]) {
      if (value) panel.style.setProperty(name, `${Math.round(value)}px`)
      else panel.style.removeProperty(name)
    }
  }
  // Loaded when it can be: an older server that has not the file still has the panel, without resizing.
  import('/resize-grips.js').then(({ addResizeGrips, readSize, keepSize }) => {
    size = readSize(SIZE_KEY)
    applySize()
    forgetSize = () => keepSize(SIZE_KEY, null)
    addResizeGrips(panel, {
      el,
      min: { w: 300, h: 260 },
      allowed: () => !phone.matches,
      onResize: (box, edge) => {
        size = { w: box.w, h: box.h }
        applySize()
        if (spot || /[es]/.test(edge)) spot = { x: box.left, y: box.top }
        place()
      },
      onEnd: () => {
        keepSize(SIZE_KEY, size)
        keepSpot()
      },
    })
  }).catch(() => {})
  head.addEventListener('dblclick', event => {
    if (event.target.closest('button')) return
    spot = null
    keepSpot()
    size = null
    applySize()
    forgetSize()
    place()
  })
  head.title = t`按住标题拖到想放的地方，拖边角调大小；双击标题回到右下角、恢复原来的大小`
  const stage = document.querySelector('.stage')
  if (stage) new MutationObserver(() => isOpen() && requestAnimationFrame(place)).observe(stage, { attributes: true, attributeFilter: ['class'] })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen() && panel.contains(document.activeElement)) close()
  })

  const url = () => `/api/chats/${state.chatId}/guide`

  function close() {
    panel.hidden = true
    clearTimeout(state.poll)
    document.getElementById('guide-open')?.setAttribute('aria-expanded', 'false')
  }

  // ─── The 剧本 tab ─────────────────────────────────────────────────────────
  function showTab(tab) {
    const chat = getChat()
    // The 剧本 tab is there for a chat on a plot, and, with the page's ways in, for one on none yet.
    const plotTab = Boolean(chat?.plot || plotActions)
    state.tab = tab === 'plot' && plotTab ? 'plot' : 'talk'
    const onPlot = state.tab === 'plot'
    tabs.hidden = !plotTab
    for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.tab === state.tab))
    for (const part of [sub, thread, compose]) part.hidden = onPlot
    mapBox.hidden = !onPlot
    clearButton.hidden = onPlot
    if (onPlot) drawMap(chat)
  }

  // 剧本 tab, on no plot yet: what a plot is, and the ways to one.
  function drawWaysIn(chat) {
    const key = JSON.stringify([chat.id, 'none', plotActions.count()])
    if (key === state.mapKey && mapBox.childElementCount) return
    state.mapKey = key
    const many = plotActions.count()
    const button = (text, hint, run, primary = false) => el('button', { type: 'button', class: `guide-way${primary ? ' primary' : ''}`, onclick: guard(() => run()) }, [el('b', { text }), el('span', { class: 'muted small', text: hint })])
    mapBox.replaceChildren(el('div', { class: 'guide-plot-none' }, [
      el('p', { class: 'muted small', text: t`剧本让故事按写好的路线走：一幕一幕往下，有岔路和结局。这段对话还没用剧本。` }),
      button(t`用剧本…`, many ? t`这张卡有 ${many} 个剧本，挑一个给这段对话用上` : t`这张卡还没有剧本，打开后可以去管理剧本里新建`, plotActions.use, many > 0),
      button(t`让向导写一份`, t`写一句想法，向导读这张卡写剧本，先出大纲`, plotActions.write, !many),
      chat.path.length > 2 ? button(t`把这段对话整理成剧本`, t`走过的路排成主线，再加几处岔路和结局`, plotActions.fromChat) : null,
      button(t`管理剧本…`, t`新建、编辑、导入、导出这张卡的剧本`, plotActions.manage),
    ].filter(Boolean)))
  }

  async function drawMap(chat) {
    if (!chat.plot) return drawWaysIn(chat)
    const view = chat.plot
    const key = JSON.stringify([chat.id, view.version, view.spoiler, view.progress, view.pending, state.forks, chat.path.length, localStorage.getItem('cicatavern.plotBarHidden')])
    if (key === state.mapKey && mapBox.childElementCount) return
    state.mapKey = key
    const { plotMap } = await import('/plot-map.js')
    const act = async body => {
      const answer = await api(`/api/chats/${chat.id}/plot`, { method: 'PUT', body })
      if (getChat()?.id === chat.id) setChat(answer)
    }
    // 回到岔路口: the way picked goes with the reply it leaves from, and the next turn is sent from there.
    const onBranch = async (after, to, title) => {
      await act({ action: 'exit', to, after })
      state.forks = false
      branchFrom(after, t`从岔路「${title}」换一条路：发出去的这一轮是一条新分支`)
      if (phone.matches) close()
    }
    const { barHidden, setBarHidden } = await import('/plot.js')
    const onShowBar = barHidden() ? () => {
      setBarHidden(false)
      state.mapKey = ''
      setChat(getChat())
    } : null
    let map
    try {
      map = plotMap(view, { el, guard, path: chat.path, onBranch, forks: state.forks, onShowBar, onJump: at => act({ action: 'jump', at }), onSpoiler: spoiler => act({ action: 'settings', spoiler }) })
    } catch (error) {
      // Not drawn: the old map stays, so the next change of the chat tries again rather than counting it done.
      state.mapKey = ''
      throw error
    }
    mapBox.replaceChildren(
      map,
      plotActions ? el('div', { class: 'guide-plot-tools' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: t`改剧本`, title: t`改这段对话用的剧本，卡里的原稿不变`, onclick: guard(() => plotActions.edit()) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`整理成剧本`, title: t`把这段对话走过的路整理成一份新剧本，放进卡里，能重玩`, onclick: guard(() => plotActions.fromChat()) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`管理剧本…`, onclick: guard(() => plotActions.manage()) }),
      ]) : '',
    )
  }

  async function open({ tab = null, fork = false } = {}) {
    const chat = getChat()
    if (!chat) return
    state.forks = Boolean(fork)
    if (state.chatId !== chat.id) {
      state.chatId = chat.id
      state.view = null
      state.drawn = ''
      thread.replaceChildren()
    }
    panel.hidden = false
    document.getElementById('guide-open')?.setAttribute('aria-expanded', 'true')
    place()
    showTab(tab ?? (state.tab === 'plot' ? 'plot' : 'talk'))
    renderModels()
    await load(await api(url()))
    if (state.tab === 'plot') return
    if (!touchKeyboard.matches) input.focus()
  }

  // ─── The talk ───────────────────────────────────────────────────────────
  function load(view) {
    if (!view || state.chatId !== getChat()?.id) return
    state.view = view
    renderModels()
    renderThread()
    schedule()
  }

  function schedule() {
    clearTimeout(state.poll)
    if (!state.view?.job || !isOpen()) return
    const asked = url()
    state.poll = setTimeout(async () => {
      if (asked !== url() || !isOpen()) return
      try {
        load(await api(asked))
      } catch {
        schedule()
      }
    }, POLL_MS)
  }

  function renderModels() {
    const picked = state.view?.model ?? 'chat'
    const named = (getModels?.() ?? []).filter(m => m.id.includes('/'))
    const gone = picked !== 'chat' && picked !== 'helper' && !named.some(m => m.id === picked)
    model.replaceChildren(...[
      el('option', { value: 'chat', text: t`对话模型：带着整段剧情看，更准`, selected: picked === 'chat' }),
      el('option', { value: 'helper', text: t`辅助模型：只看摘要和最近 20 轮，省钱`, selected: picked === 'helper' }),
      named.length ? el('optgroup', { label: t`指定模型：只看摘要和最近 20 轮` }, named.map(m => el('option', { value: m.id, text: `${m.group ?? ''} · ${m.label}`, selected: m.id === picked }))) : null,
      gone ? el('option', { value: picked, text: t`${picked}（已不在模型列表里，改用辅助模型）`, selected: true }) : null,
      el('option', { value: '__providers', text: t`管理供应商…` }),
    ].filter(Boolean))
    model.title = t`对话模型是订阅的模型时，向导改用辅助模型`
    const turns = state.view?.storyTurns ?? 0
    read.textContent = turns ? t`故事到第 ${turns} 轮` : t`故事还没开始`
  }

  model.addEventListener('change', guard(async () => {
    if (model.value === '__providers') {
      renderModels()
      openProviders?.()
      return
    }
    load(await api(`${url()}/model`, { method: 'PUT', body: { model: model.value } }))
  }))

  // Only what changed is drawn again: a poll mostly brings the answer's next few words.
  function renderThread() {
    const view = state.view
    const key = JSON.stringify([view.turns, Boolean(view.job), view.error, getChat()?.guide?.plan?.goal ?? ''])
    const busy = Boolean(view.job)
    send.disabled = busy
    stop.hidden = !busy
    if (key === state.drawn) {
      const live = thread.querySelector('.guide-live')
      if (live) fillLive(live, view.job)
      return
    }
    state.drawn = key
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80
    const items = []
    if (!view.turns.length) items.push(introBlock())
    for (const turn of view.turns) items.push(...turnBlocks(turn))
    if (busy) {
      const live = el('div', { class: 'guide-say guide-live' })
      fillLive(live, view.job)
      items.push(live)
    }
    if (view.error) {
      items.push(el('div', { class: 'guide-error' }, [
        el('span', { text: view.error.message }),
        el('button', { type: 'button', class: 'btn small', text: t`重试`, onclick: guard(retry) }),
      ]))
    }
    thread.replaceChildren(...items)
    if (nearBottom || busy) thread.scrollTop = thread.scrollHeight
  }

  function fillLive(live, job) {
    // What comes after a plan's opening tag is the plan being written: its card comes when the answer is done.
    const partial = String(job?.partial ?? '')
    const cut = partial.search(/[<＜]\s*剧情方案/)
    const shown = cut >= 0 ? partial.slice(0, cut) : partial
    live.innerHTML = shown.trim() ? markdownHtml(shown) : ''
    live.append(el('p', { class: 'guide-busy muted small', text: cut >= 0 ? t`正在写方案…` : shown.trim() ? t`还在写…` : t`正在看故事、想回答…` }))
  }

  function introBlock() {
    return el('div', { class: 'guide-intro' }, [
      el('p', { text: t`向导在幕后陪你聊这段故事：人物为什么这样做、接下来可以怎么走、这种故事怎么写好看。它说的话不会进故事。` }),
      el('p', { class: 'muted small', text: t`想让故事往某个方向走时，让它出方案；采用后，方案会每轮悄悄带给讲故事的模型。` }),
      el('div', { class: 'guide-ideas' }, IDEAS().map(idea => el('button', { type: 'button', class: 'btn small ghost', text: idea, onclick: () => {
        input.value = idea
        input.focus()
      } }))),
    ])
  }

  function turnBlocks(turn) {
    if (turn.note) return [el('p', { class: 'guide-note', text: turn.note })]
    const blocks = [el('div', { class: 'guide-you', text: turn.user.text })]
    const answer = turn.assistant
    if (!answer) return blocks
    const behind = (state.view.storyTurns ?? 0) - (turn.user.read ?? 0)
    blocks.push(el('div', { class: 'guide-say', html: markdownHtml(answer.text) }))
    for (const [index, plan] of (answer.plans ?? []).entries()) blocks.push(planCard(plan, `${turn.user.at}:${index}`))
    if (behind > 0) blocks.push(el('p', { class: 'guide-by muted small', text: t`这是故事第 ${turn.user.read} 轮时说的，之后又过了 ${behind} 轮` }))
    return blocks
  }

  function planCard(plan, key) {
    const following = getChat()?.guide?.plan?.goal === plan.goal
    const picked = state.strength[key] ?? 'steady'
    const list = (label, items) => (items.length ? [el('h5', { text: label }), el('ul', {}, items.map(item => el('li', { text: item })))] : [])
    const strengths = el('div', { class: 'guide-strengths', role: 'group', 'aria-label': t`节奏` }, STRENGTHS().map(([id, name, tip]) => el('button', {
      type: 'button',
      class: 'btn small',
      text: name,
      title: tip,
      'aria-pressed': String(id === picked),
      onclick: () => {
        state.strength[key] = id
        for (const button of strengths.children) button.setAttribute('aria-pressed', String(button === strengths.children[STRENGTHS().findIndex(([s]) => s === id)]))
      },
    })))
    return el('div', { class: `guide-plan${following ? ' following' : ''}` }, [
      el('h4', { text: plan.goal }),
      ...list(t`怎么起头`, plan.start ?? []),
      ...list(t`要注意`, plan.notes ?? []),
      following
        ? el('p', { class: 'guide-following small', text: t`正在按这个方案引导` })
        : el('div', { class: 'guide-plan-foot' }, [
          strengths,
          el('button', {
            type: 'button',
            class: 'btn small primary',
            text: getChat()?.guide ? t`换成这个` : t`开始引导`,
            title: t`之后正常玩：每轮会把这个方向悄悄带给讲故事的模型，玩家的行动永远优先`,
            onclick: guard(async () => {
              if (getChat()?.guide && !confirm(t`换成这个方案？正在进行的引导会停下。`)) return
              await act({ action: 'adopt', plan, strength: state.strength[key] ?? 'steady' })
              toast(t`开始引导：之后正常玩就好`)
            }),
          }),
        ]),
    ])
  }

  const ask = guard(async () => {
    const text = input.value.trim()
    if (!text || state.view?.job) return
    send.disabled = true
    try {
      load(await api(url(), { method: 'POST', body: { text } }))
      input.value = ''
    } finally {
      send.disabled = Boolean(state.view?.job)
    }
  })
  async function retry() {
    load(await api(`${url()}/retry`, { method: 'POST', body: {} }))
  }
  send.addEventListener('click', ask)
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || touchKeyboard.matches) return
    event.preventDefault()
    ask()
  })
  stop.addEventListener('click', guard(async () => load(await api(`${url()}/stop`, { method: 'POST', body: {} }))))
  clearButton.addEventListener('click', guard(async () => {
    if (!confirm(t`清空和向导的对话？正在进行的引导不受影响。`)) return
    clearTimeout(state.poll)
    load(await api(url(), { method: 'DELETE' }))
  }))
  closeButton.addEventListener('click', close)

  // ─── The plan being followed ────────────────────────────────────────────
  /** Takes, changes or ends the plan; the chat that comes back is drawn (its bar with it), the talk too. */
  async function act(body) {
    const chat = getChat()
    if (!chat) return
    const answer = await api(`/api/chats/${chat.id}/guide/active`, { method: 'PUT', body })
    if (getChat()?.id !== chat.id) return
    setChat(answer.chat)
    if (state.chatId === chat.id && answer.guide) load(answer.guide)
  }

  function renderBar(chat) {
    const guide = chat?.guide
    if (!guide) {
      state.editing = false
      bar.hidden = true
      bar.replaceChildren()
      return
    }
    bar.hidden = false
    bar.classList.toggle('resting', !guide.on)
    const line = el('div', { class: 'guide-line' }, [
      el('span', { class: 'guide-mark', html: ICON_COMPASS, title: t`剧情向导` }),
      el('span', { class: 'guide-pace', text: strengthName(guide.strength) }),
      el('span', { class: 'guide-goal', text: guide.plan.goal, title: guide.plan.goal }),
      el('span', { class: 'guide-count muted', text: guide.held ? t`剧本进行中，引导暂不生效` : guide.on ? (guide.turns ? t`已引导 ${guide.turns} 轮` : t`下一轮开始`) : t`这个分支在开始引导之前，不生效` }),
      el('span', { class: 'guide-actions' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: state.editing ? t`收起` : t`看 / 改`, 'aria-expanded': String(state.editing), onclick: () => {
          state.editing = !state.editing
          renderBar(getChat())
        } }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`完成`, title: t`这件事已经演到了，停止引导`, onclick: guard(() => act({ action: 'done' })) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`停`, title: t`不要这个方向了，停止引导`, onclick: guard(() => act({ action: 'stop' })) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`问问向导`, onclick: guard(open) }),
      ]),
    ])
    const parts = [line]
    if (state.editing) parts.push(editBlock(guide))
    bar.replaceChildren(...parts)
  }

  function editBlock(guide) {
    const text = el('textarea', { class: 'guide-edit-text', rows: '6', 'aria-label': t`每轮带给模型的幕后方向` })
    text.value = guide.text
    const strengths = el('div', { class: 'guide-strengths', role: 'group', 'aria-label': t`节奏` }, STRENGTHS().map(([id, name, tip]) => el('button', {
      type: 'button',
      class: 'btn small',
      text: name,
      title: tip,
      'aria-pressed': String(id === guide.strength),
      onclick: guard(() => act({ action: 'strength', strength: id })),
    })))
    return el('div', { class: 'guide-edit' }, [
      el('p', { class: 'muted small', text: t`这段话每轮跟在你的消息后面，悄悄带给讲故事的模型。可以直接改；「节奏：」那一行留着，上面三个按钮就照样能切。` }),
      strengths,
      text,
      el('div', { class: 'guide-edit-foot' }, [
        guide.edited ? el('button', { type: 'button', class: 'btn small ghost', text: t`恢复默认`, onclick: guard(() => act({ action: 'edit', text: '' })) }) : null,
        el('button', { type: 'button', class: 'btn small primary', text: t`保存`, onclick: guard(async () => {
          await act({ action: 'edit', text: text.value })
          toast(t`已保存，下一轮起生效`)
        }) }),
      ].filter(Boolean)),
    ])
  }

  /** After each drawing of the chat: its bar, and the panel when it shows another chat now. */
  function sync(chat) {
    renderBar(chat)
    if (!isOpen()) return
    // The bar came or went: the docked panel stays above the input box.
    requestAnimationFrame(place)
    if (chat && chat.id === state.chatId) showTab(state.tab)
    if (!chat) return close()
    if (chat.id !== state.chatId) open().catch(() => {})
    else if (state.view) {
      // A plan taken or ended elsewhere: the cards' buttons follow.
      state.drawn = ''
      renderThread()
    }
  }

  return { open: guard(open), sync }
}
