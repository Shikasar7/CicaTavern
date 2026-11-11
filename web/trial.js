// 试玩体检 (the card list's ⋯): a few rounds of a card on the real chat engine, with a report. Nothing is sent until the
// button here, which says first which model and about how much; the chat it plays in is never shown and goes when it ends
// (server/forge/trial.mjs). Loaded when asked for: a page already open from before an update goes on working without it.
import { t } from '/i18n.js'

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const MANAGE_PROVIDERS = '__manage__'
const count = n => Math.round(n).toLocaleString()
const MARK = { ok: '✓', warn: '!', error: '✕' }
const KIND_TEXT = { 抢话: t`抢话`, 出戏: t`出戏`, 矛盾: t`矛盾`, 放水: t`放水`, 重复: t`重复`, 数值: t`数值`, 事件: t`事件`, 其他: t`其他` }
const INTENT_TEXT = { go: t`顺着玩`, use: t`用东西`, ask: t`追问`, push: t`硬闯`, claim: t`说假话`, hand: t`让对方决定` }

/** @param deps - { api, el, toast, guard, copyText(text), openProviders, openEdit(cardId), openCheck(cardId) } */
export function initTrial({ api, el, toast, guard, copyText, openProviders, openEdit, openCheck }) {
  const dialog = document.getElementById('trial-dialog')
  const view = {}
  // forge: opened from 创作角色卡; changed: with edits made there after the save (the trial plays the saved card).
  const state = { cardId: '', data: null, models: [], defaultModel: '', poll: null, changed: false, forge: false }
  const url = (path = '') => `/api/cards/${state.cardId}/trial${path}`

  function layout() {
    view.sub = el('span', { class: 'forge-sub' })
    view.main = el('div', { class: 'forge-main cc-main' })
    dialog.replaceChildren(
      el('div', { class: 'forge cc' }, [
        el('header', { class: 'forge-head' }, [
          el('div', { class: 'forge-titles' }, [el('h2', { text: t`试玩体检` }), view.sub]),
          el('div', { class: 'forge-tools' }, [el('button', { type: 'button', class: 'btn ghost icon', title: t`关闭`, 'aria-label': t`关闭`, html: ICON_CLOSE, onclick: () => dialog.close() })]),
        ]),
        view.main,
      ]),
    )
  }

  function load(data) {
    const running = Boolean(state.data?.job)
    state.data = data
    view.sub.textContent = data.name
    render()
    if (running && !data.job && data.report && !data.error) view.main.scrollTop = 0
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

  // ─── Before it starts ──────────────────────────────────────
  const label = model => model.label || model.id

  function modelChoice() {
    const { model, job } = state.data
    const known = state.models.find(item => item.id === state.defaultModel)
    const select = el('select', { class: 'forge-model', title: t`用哪个模型玩`, disabled: Boolean(job), onchange: guard(async () => {
      if (select.value === MANAGE_PROVIDERS) {
        select.value = model
        openProviders()
        return
      }
      load(await api(url(), { method: 'PUT', body: { model: select.value } }))
    }) }, [
      el('option', { value: '', selected: !model, text: known ? t`默认模型（${label(known)}）` : t`默认模型（还没选）` }),
      ...state.models.map(item => el('option', { value: item.id, selected: item.id === model, text: label(item) })),
      el('option', { value: MANAGE_PROVIDERS, text: t`管理模型…` }),
    ])
    return select
  }

  // Who the stand-in plays as (server/forge/trial.mjs PLAYERS); 自己写 opens a line to describe one.
  const PLAYER_TEXT = { '': t`玩家：不指定`, eager: t`玩家：急性子`, quiet: t`玩家：话很少`, bargain: t`玩家：爱计较`, heart: t`玩家：只在意人`, wild: t`玩家：不按常理`, own: t`玩家：自己写…` }
  const PLAYER_HINT = { eager: t`爱行动，总想把事情往前推`, quiet: t`每次只说很短的一句，看卡能不能自己把故事撑起来`, bargain: t`总想多要好处、少付代价，看卡会不会放水`, heart: t`只想靠近眼前的人，看关系会不会进展得太快`, wild: t`爱做出格的事，看卡拉不拉得回来` }

  function playerChoice() {
    const { player, players, job } = state.data
    if (!players) return null
    const picked = state.ownPlayer ? 'own' : player.kind
    const select = el('select', { class: 'forge-model', title: t`扮玩家的模型照什么性子玩`, disabled: Boolean(job), onchange: guard(async () => {
      // 自己写: nothing to keep till something is written.
      state.ownPlayer = select.value === 'own'
      if (state.ownPlayer) return render()
      load(await api(url(), { method: 'PUT', body: { player: { kind: select.value } } }))
    }) }, players.map(kind => el('option', { value: kind, selected: kind === picked, text: PLAYER_TEXT[kind] ?? kind })))
    return select
  }

  /** Under the pickers: what the kind picked is for, or the line to describe a player of one's own. */
  function playerNote() {
    const { player, players, job } = state.data
    if (!players) return null
    if (state.ownPlayer || player.kind === 'own') {
      const box = el('input', { type: 'text', class: 'trial-player', maxlength: 200, disabled: Boolean(job), placeholder: t`这位玩家是什么样的人，比如：胆小，凡事先问清楚再动手`, 'aria-label': t`玩家是什么样的人`, onchange: guard(async () => {
        state.ownPlayer = Boolean(box.value.trim())
        load(await api(url(), { method: 'PUT', body: { player: { kind: 'own', text: box.value } } }))
      }) })
      box.value = player.kind === 'own' ? player.text : ''
      return box
    }
    return PLAYER_HINT[player.kind] ? el('p', { class: 'hint', text: PLAYER_HINT[player.kind] }) : null
  }

  function roundsChoice() {
    const { rounds, choices, job } = state.data
    const select = el('select', { class: 'forge-model', title: t`玩几回合`, disabled: Boolean(job), onchange: guard(async () => load(await api(url(), { method: 'PUT', body: { rounds: Number(select.value) } }))) },
      choices.map(n => el('option', { value: String(n), selected: n === rounds, text: t`${n} 回合` })))
    return select
  }

  function startCard() {
    const { estimate, job, report } = state.data
    const note = estimate.ready
      ? t`点了才发送。用 ${estimate.model} 玩，大约 ${count(estimate.input)} 输入、${count(estimate.output)} 输出 token${estimate.cost ? t`，约 $${estimate.cost.toFixed(2)}` : ''}。思考多的模型会更高，额度紧的话先选少一点。`
      : t`还没有可用的模型，先在「管理模型」里加一个。`
    return el('section', { class: 'plan-card cc-model' }, [
      el('h3', { text: t`让模型替你玩几回合` }),
      el('p', { class: 'hint', text: t`用这张卡真实地跑几回合：一个模型演卡，一个模型扮玩家，中途会故意试探，比如硬闯、说假话、让它替你决定。这一局不进你的对话列表，玩完就删。` }),
      el('p', { class: 'hint', text: note }),
      state.changed ? el('p', { class: 'ce-outcome warn', text: t`创作向导里还有没保存的改动：这里试玩的是上次保存的卡。想试最新的，先关掉这里，在向导里点「更新这张卡」。` }) : null,
      job
        ? el('div', { class: 'cc-send' }, [el('span', { class: 'hint', text: stepText(job.step) }), el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn ghost small', text: t`停下`, onclick: guard(stop) })])
        : el('div', { class: 'cc-send' }, [modelChoice(), roundsChoice(), playerChoice(), el('span', { class: 'grow' }), el('button', { type: 'button', class: 'btn primary small', text: report ? t`再玩一次` : t`开始试玩`, disabled: !estimate.ready, onclick: guard(start) })]),
      job ? null : playerNote(),
    ].filter(Boolean))
  }

  function stepText(step) {
    if (step === 'review') return t`在读这一局，挑毛病…`
    const [, now, total, who] = /^round:(\d+):(\d+):(\w+)$/.exec(step ?? '') ?? []
    if (!now) return t`准备中…`
    return who === 'player' ? t`第 ${now}/${total} 回合：玩家在想…` : t`第 ${now}/${total} 回合：模型在写…`
  }

  async function start() {
    if (state.data.report && !confirm(t`再玩一次会换掉这份报告，继续？`)) return
    load(await api(url('/run'), { method: 'POST' }))
  }

  async function stop() {
    await api(url('/stop'), { method: 'POST' })
    schedule()
  }

  // ─── The report ────────────────────────────────────────────
  function reportText(report) {
    const lines = [t`《${state.data.name}》试玩体检`, report.summary, ...report.lines.filter(line => line.level !== 'ok').map(line => `- ${line.text}`)]
    for (const issue of report.issues) lines.push(t`- 第 ${issue.round} 回合 · ${KIND_TEXT[issue.kind] ?? issue.kind}：${issue.what}${issue.fix ? t` 建议：${issue.fix}` : ''}`)
    return lines.filter(Boolean).join('\n')
  }

  function issueView(issue) {
    return el('div', { class: 'trial-issue' }, [
      el('div', { class: 'trial-issue-head' }, [el('span', { class: 'strategy key', text: KIND_TEXT[issue.kind] ?? issue.kind }), el('span', { class: 'hint', text: t`第 ${issue.round} 回合` })]),
      el('p', { text: issue.what }),
      issue.quote ? el('blockquote', { text: issue.quote }) : null,
      issue.fix ? el('p', { class: 'hint', text: t`改法：${issue.fix}` }) : null,
    ].filter(Boolean))
  }

  function roundView(round, i) {
    const bad = round.problems.length > 0
    return el('details', { class: 'trial-round' }, [
      el('summary', {}, [el('span', { text: t`第 ${i + 1} 回合` }), el('span', { class: 'hint', text: INTENT_TEXT[round.intent] ?? '' }), bad ? el('span', { class: 'trial-mark error', text: t`${round.problems.length} 个问题` }) : null].filter(Boolean)),
      el('p', { class: 'trial-you', text: round.input }),
      el('div', { class: 'trial-reply', text: round.shown }),
      ...round.problems.map(problem => el('p', { class: 'trial-mark error', text: problem.what })),
      round.changes?.length ? el('p', { class: 'hint', text: t`变量：${round.changes.join(t`、`)}` }) : null,
    ].filter(Boolean))
  }

  function report() {
    const data = state.data.report
    if (!data) return null
    const issues = data.issues.length
      ? data.issues.map(issueView)
      : [el('p', { class: 'hint', text: data.stopped ? t`提前停下了，没有读这一局。` : data.unread ? t`模型的审读没能读出来，上面程序查的结果不受影响。` : t`读下来没有挑出毛病。` })]
    const problems = data.issues.length + data.lines.filter(line => line.level !== 'ok').length
    return el('div', { class: 'cc-page-part' }, [
      el('section', { class: 'plan-card' }, [
        el('h3', { text: t`结果` }),
        el('p', { class: 'hint', text: t`${data.model} · 玩了 ${data.rounds.length} 回合${data.stopped ? t`（提前停下）` : ''} · 这一局用了 ${count(data.tokens.input)} 输入、${count(data.tokens.output)} 输出 token` }),
        data.player?.kind ? el('p', { class: 'hint', text: data.player.kind === 'own' ? t`玩家是照这句话扮的：${data.player.text}` : PLAYER_TEXT[data.player.kind] }) : null,
        // A report from before marks were kept (data.mark) cannot tell whether the card has changed since: said so, not as a fact.
        data.outdated ? el('p', { class: 'ce-outcome warn', text: data.mark ? t`这份报告之后卡改过了，有些问题可能已经改好，再玩一次可以确认。` : t`这份报告是旧版本做的，看不出之后卡改过没有。有些问题可能已经改好，再玩一次可以确认。` }) : null,
        data.summary ? el('p', { text: data.summary }) : null,
        el('ul', { class: 'trial-lines' }, data.lines.map(line => el('li', { class: `trial-line ${line.level}` }, [el('span', { class: 'trial-dot', text: MARK[line.level] }), el('span', { text: line.text })]))),
      ].filter(Boolean)),
      el('section', { class: 'plan-card' }, [el('h3', { text: t`读下来的问题` }), ...issues]),
      el('section', { class: 'plan-card' }, [el('h3', { text: t`这一局` }), ...data.rounds.map(roundView)]),
      // These fix the saved card, which the wizard's next 更新这张卡 writes over from its draft.
      state.forge ? el('p', { class: 'ce-outcome warn', text: t`「去修改这张卡」「在检查里修」改的是已经保存的卡，不是向导里的草稿。改完再在向导里点「更新这张卡」，会用草稿整张换掉这些修改。想留在向导里改，关掉这里，在开场白或条目上点「编辑」或「按意见重写」。` }) : null,
      el('div', { class: 'cc-send' }, [
        el('button', { type: 'button', class: 'btn ghost small', text: t`复制问题清单`, onclick: guard(async () => {
          await copyText(reportText(data))
          toast(state.forge ? t`已复制，可以对照着在向导里改开场白和条目。` : t`已复制，可以贴到「对话修改」里让向导改。`)
        }) }),
        el('button', { type: 'button', class: 'btn ghost small', text: t`去修改这张卡`, onclick: () => {
          dialog.close()
          openEdit(state.cardId)
        } }),
        // A page from before 检查这张卡 took the trial's problems has nothing to open them with.
        openCheck && problems ? el('span', { class: 'grow' }) : null,
        openCheck && problems ? el('button', { type: 'button', class: 'btn primary small', text: t`在检查里修`, title: t`这些问题会列在「检查这张卡」里：可以让模型出改法，改前改后看过再采用，采用后能撤销`, onclick: () => {
          dialog.close()
          openCheck(state.cardId)
        } }) : null,
      ].filter(Boolean)),
    ])
  }

  function render() {
    const top = view.main.scrollTop
    const { error } = state.data
    view.main.replaceChildren(el('div', { class: 'cc-page' }, [
      startCard(),
      error ? el('p', { class: 'trial-mark error', text: error.message }) : null,
      report(),
    ].filter(Boolean)))
    view.main.scrollTop = top
  }

  dialog.addEventListener('close', () => clearTimeout(state.poll))
  layout()

  return {
    /** Opens the window on a card. `forge`: from 创作角色卡; `changed`: it has edits not saved into the card yet. */
    async open(cardId, { changed = false, forge = false } = {}) {
      state.cardId = cardId
      state.ownPlayer = false
      state.changed = changed
      state.forge = forge
      state.data = null
      await loadModels()
      load(await api(url()))
      if (!dialog.open) dialog.showModal()
      schedule()
    },
  }
}
