// 剧本 while playing (plans/22): the bar above the input box with the scene the story plays and how far it has come,
// the scene's card under it (its points, 这一幕演完了, the plot's settings), the 岔路 card, and 故事岔开了 when the story
// left the scene. What the player changes here goes with the next turn (server/plot.mjs changePlot); the chat that comes
// back is drawn. While a turn is to be sent from an earlier reply (从这里分支, 回到岔路口) the bar shows the story there.
import { t } from '/i18n.js'
import { applySet, exitLacks, MAX_PACE, progressOn, sceneOf, shown, strayOf, turnsOf } from '/shared/plot.js'

const TIGHTNESS = () => [['loose', t`宽松`, t`这一幕只是个方向，玩家往别处走就跟着走`], ['steady', t`适中`, t`要点陆续出现，偏离时两三轮内带回来`], ['tight', t`严格`, t`要点必须出现，偏离时用剧情把场面带回来`]]
const PACES = () => ({ '-3': [t`极慢`, t`只写眼前，玩家碰到要点才写`], '-2': [t`很慢`, t`几轮才演到一条要点`], '-1': [t`偏慢`, t`一轮最多演到一条要点`], 0: [t`适中`, t`照剧本写的来`], 1: [t`偏快`, t`每轮都有进展`], 2: [t`很快`, t`每轮至少演到一条要点`], 3: [t`极快`, t`略写过渡，一两轮演完一幕`] })
const SPOILERS = () => [['blind', t`只显示走过的`, t`只看走过的路`], ['outline', t`显示幕名`, t`没走过的幕只看标题`], ['all', t`全部显示`, t`什么都显示`]]
const STEP = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 5 5-5 5M11 5l5 5-5 5" /></svg>'
const ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5h8.5l2 2v11H5z" /><path d="M8 8h5M8 11h5M8 14h3" /></svg>'
const FORK = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="4.5" r="1.8" /><circle cx="5" cy="15.5" r="1.8" /><circle cx="15" cy="15.5" r="1.8" /><path d="M10 6.3v3.2c0 1.6-5 2.2-5 4.2M10 9.5c0 1.6 5 2.2 5 4.2" /></svg>'

const OP_SIGNS = { '>=': '≥', '<=': '≤', '!=': '≠' }
// 剧本条 hidden on this device (the plot works on); the route map shows it again.
const BAR_KEY = 'cicatavern.plotBarHidden'
// 剧本设置 folded or open on this device: the card is drawn anew at every change of the chat.
const SETTINGS_KEY = 'cicatavern.plotSettingsOpen'
function settingsOpen() {
  try {
    return localStorage.getItem(SETTINGS_KEY) === '1'
  } catch {
    return false
  }
}
function setSettingsOpen(open) {
  try {
    localStorage.setItem(SETTINGS_KEY, open ? '1' : '0')
  } catch {}
}
export function barHidden() {
  try {
    return localStorage.getItem(BAR_KEY) === '1'
  } catch {
    return false
  }
}
export function setBarHidden(hidden) {
  try {
    if (hidden) localStorage.setItem(BAR_KEY, '1')
    else localStorage.removeItem(BAR_KEY)
  } catch {
    // a private window: for this visit only
  }
}

/** What an exit still needs, in words (exitLacks); `titleOf` names a scene as the reader may see it. */
export function lackText(lack, titleOf) {
  if (lack.kind === 'seen') return t`要先走过「${titleOf(lack.scene)}」`
  if (lack.kind === 'unseen') return t`走过「${titleOf(lack.scene)}」就不开了`
  if (lack.kind === 'check') return lack.want === 'pass' ? t`要这一幕的检定成功` : t`要这一幕的检定失败`
  if (lack.kind === 'battle') return lack.want === 'won' ? t`要这一幕的战斗打赢` : t`要这一幕的战斗打输`
  return t`要 ${lack.path} ${OP_SIGNS[lack.op] ?? lack.op} ${lack.value}`
}

/**
 * The plot as the bar shows it: the chat's (plotView), or, sending from an earlier reply `from`, the story there
 * (the progress on the way to it, the change kept for it).
 */
export function viewAt(chat, from = null) {
  const view = chat?.plot
  if (!view) return null
  const tip = chat.path.at(-1)
  const state = (id => chat.path.slice(0, id + 1).findLast(node => node.role === 'assistant')?.state ?? null)
  if (!from || from === tip?.id) return { ...view, state: state(chat.path.length - 1) }
  const at = chat.path.findIndex(node => node.id === from)
  if (at < 0) return { ...view, state: state(chat.path.length - 1) }
  const way = chat.path.slice(0, at + 1)
  const kept = way.filter((node, index) => !node.hidden && !(node.role === 'user' && way[index + 1]?.hidden))
  const pending = view.pendingAfter?.after === from ? view.pendingAfter.set : null
  const base = progressOn(view.copy, kept, view.start)
  return { ...view, pending, progress: pending ? applySet(view.copy, base, pending) : base, state: state(at), branching: true }
}

/**
 * @param deps - { api, el, guard, toast, getChat, setChat, getFrom(): the reply a turn is sent from, if not the latest,
 *   openMap(): the route map, newChat(), editCopy(): the chat's copy in the editor, askGuide(kind): the guide on the
 *   chat's copy ('edit': 问问向导改, 'detour': 就这样走), cardPlot(chat): the card's own plot the copy came from, if
 *   the page has it (卡里的剧本有新版本), canGo() and go(): whether a turn can be sent now, and sending it }
 * @returns { sync(chat), act(body) }: sync after each drawing of the chat.
 */
export function initPlot({ api, el, guard, toast, getChat, setChat, getFrom = () => null, openMap, newChat, editCopy = () => {}, askGuide = () => {}, cardPlot = () => null, canGo = () => false, go = () => {} }) {
  const bar = document.getElementById('plot-bar')
  const state = { open: false, fork: false, chatId: null, asked: '' }

  async function act(body) {
    const chat = getChat()
    if (!chat) return
    // Sent from an earlier reply: the change goes with that one.
    const from = getFrom()
    const earlier = from && from !== chat.path.at(-1)?.id && chat.path.find(node => node.id === from)?.role === 'assistant'
    const answer = await api(`/api/chats/${chat.id}/plot`, { method: 'PUT', body: earlier && !body.after ? { ...body, after: from } : body })
    if (getChat()?.id === chat.id) setChat(answer)
  }

  // What the bar says of a scene: its title where the reader may see it.
  const titleOf = (view, id) => {
    const scene = sceneOf(view.copy, id)
    return shown(scene, view.spoiler, view.progress) === 'none' ? t`？` : scene?.title ?? t`？`
  }

  function exitsOf(view) {
    const scene = sceneOf(view.copy, view.progress.at)
    if (!scene || scene.ending) return []
    return scene.exits.map(exit => {
      const lacks = exitLacks(exit, view.progress, view.state)
      return { exit, open: !lacks.length, lacks, target: sceneOf(view.copy, exit.to) }
    })
  }

  function sync(chat) {
    const view = viewAt(chat, getFrom())
    if (chat?.id !== state.chatId) {
      state.chatId = chat?.id ?? null
      state.open = false
      state.fork = false
    }
    if (!view || barHidden()) {
      bar.hidden = true
      bar.replaceChildren()
      return
    }
    const scene = sceneOf(view.copy, view.progress.at)
    const exits = exitsOf(view)
    const open = exits.filter(item => item.open)
    // 到岔路主动问我: the card comes by itself once the scene is well under way (once per scene).
    const ripe = scene && (view.progress.turns >= Math.max(1, turnsOf(scene, view.pace).min) || (scene.points.length && view.progress.ticks.length * 2 >= scene.points.length))
    const key = `${chat.id}:${view.progress.at}:${view.progress.seen.length}`
    if (view.askAtFork && !view.paused && open.length > 1 && ripe && state.asked !== key && !view.pending) {
      state.asked = key
      state.fork = true
    }
    bar.hidden = false
    bar.classList.toggle('resting', view.paused || Boolean(view.progress.ended))
    const walked = view.progress.seen.length
    const dots = el('span', { class: 'plot-dots', 'aria-label': t`走过 ${walked} 幕` }, [
      ...Array.from({ length: Math.min(walked, 5) }, () => el('i', { class: 'walked' })),
      walked > 5 ? el('b', { text: '…' }) : null,
      el('i', { class: `now${scene?.ending ? ' ending' : ''}` }),
      !scene?.ending && open.length > 1
        ? el('button', { type: 'button', class: 'plot-fork', html: FORK, title: t`岔路：自己选一条`, 'aria-expanded': String(state.fork), onclick: () => {
          state.fork = !state.fork
          sync(getChat())
        } })
        : !scene?.ending ? el('i', { class: 'ahead' }) : null,
    ].filter(Boolean))
    const where = view.progress.ended ? t`结局 · ${scene.title}` : `${scene.chapter ? `${scene.chapter} · ` : ''}${scene.title}`
    // 支线: those open and not played out.
    const lines = sideLines(view)
    const going = lines.filter(item => !item.line.ended)
    const note = view.paused ? t`剧本已暂停`
      : view.progress.ended ? t`剧本演完了`
        : view.pending?.at ? t`下一轮去「${titleOf(view, view.pending.at)}」`
          : view.pending?.ended ? t`下一轮收尾`
            : view.pending?.push ? pushNote(view, scene)
            : view.pending?.pull ? t`下一轮把故事拉回这一幕`
              : view.pending?.side ? t`下一轮支线「${lines.find(item => item.side.id === view.pending.side.id)?.side.name ?? ''}」往下走`
              : view.branching ? t`从这里分支：按这时的进度走` : ''
    const line = el('div', { class: 'plot-line' }, [
      el('span', { class: 'plot-mark', html: ICON, title: view.copy.name }),
      el('button', { type: 'button', class: 'plot-where', text: where, title: t`「${view.copy.name}」：点开看这一幕`, 'aria-expanded': String(state.open), onclick: () => {
        state.open = !state.open
        sync(getChat())
      } }),
      dots,
      going.length ? el('span', { class: 'plot-side-chip', text: t`支线 ${going.length}`, title: going.map(item => item.side.name).join(t`、`) }) : null,
      note ? el('span', { class: 'plot-note muted', text: note }) : null,
      view.pending?.push && canGo() ? el('button', { type: 'button', class: 'btn small', text: t`现在就走`, title: t`输入框里写了什么就发什么，空着就发「（顺着剧情往下走）」`, onclick: () => go() }) : null,
      view.pending ? el('button', { type: 'button', class: 'btn small ghost', text: t`撤销`, title: t`不要刚才的改动`, onclick: guard(() => act({ action: 'undo' })) }) : null,
      el('span', { class: 'plot-actions' }, [
        pushable(view) && !view.pending ? el('button', { type: 'button', class: 'btn small ghost plot-push', html: STEP, title: t`推进一步：下一轮演这一幕的下一条要点`, 'aria-label': t`推进一步`, onclick: guard(() => act({ action: 'push', how: 'step' })) }) : null,
        el('button', { type: 'button', class: 'btn small ghost', text: t`路线图`, onclick: guard(() => openMap()) }),
        el('button', { type: 'button', class: 'btn small ghost', text: state.open ? t`收起` : t`▾`, title: t`这一幕和剧本的设置`, 'aria-expanded': String(state.open), onclick: () => {
          state.open = !state.open
          sync(getChat())
        } }),
      ]),
    ].filter(Boolean))
    const parts = [line]
    // 故事岔开了: the model said so, or the scene ran past its turns; four ways on.
    const stray = view.paused || view.pending ? null : strayOf(view.copy, view.progress, view.pace)
    if (stray) parts.push(strayRow(view, stray))
    // 卡里的剧本有新版本: changed in the card since this chat took its copy, and not left be.
    const card = view.branching ? null : cardPlot(chat)
    if (card?.updatedAt && card.updatedAt !== view.copy.updatedAt && card.updatedAt !== view.seenUpdate) parts.push(newerRow(view, card))
    // 模型没写进度: three replies in a row without the mark asked for.
    if (!stray && !view.paused && !view.progress.ended && view.judge?.by !== 'helper' && !view.hushSilent && (view.progress.silent ?? 0) >= 3) parts.push(silentRow())
    if (state.fork && !view.paused && !view.progress.ended) parts.push(forkCard(view, exits))
    if (state.open) parts.push(sceneCard(view, scene, exits))
    bar.replaceChildren(...parts)
  }

  function strayRow(view, stray) {
    return el('div', { class: 'plot-stray', role: 'status' }, [
      el('span', { class: 'plot-stray-text', text: stray === 'astray' ? t`故事岔开了：这几轮离「${titleOf(view, view.progress.at)}」越来越远` : t`这一幕已经演了 ${view.progress.turns} 轮，比预计的久了` }),
      el('span', { class: 'plot-stray-tools' }, [
        el('button', { type: 'button', class: 'btn small', text: t`拉回来`, title: t`下一轮用故事里的事把场面带回这一幕`, onclick: guard(() => act({ action: 'pull' })) }),
        el('button', { type: 'button', class: 'btn small', text: t`就这样走`, title: t`让向导把岔开的这段写成新的一幕，接回剧本`, onclick: guard(() => askGuide('detour')) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`暂停剧本`, onclick: guard(() => act({ action: 'pause' })) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`不用管`, title: t`这一幕不再提醒`, onclick: guard(() => act({ action: 'quiet' })) }),
      ]),
    ])
  }

  /** 支线 opened on the story: [{ side, line, scene }]. */
  function sideLines(view) {
    return (view.copy.sides ?? []).map(side => ({ side, line: view.progress.sides?.[side.id], scene: sceneOf(view.copy, view.progress.sides?.[side.id]?.at) })).filter(item => item.line && item.scene)
  }

  /** The side lines in the scene's card: where each is, and the player moving one on. */
  function sideBox(view) {
    const lines = sideLines(view)
    if (!lines.length) return null
    return el('div', { class: 'plot-sides' }, [
      el('h5', { text: t`支线` }),
      ...lines.map(({ side, line, scene }) => {
        const walked = { ...line, seen: [...view.progress.seen, view.progress.at, ...line.seen] }
        const ways = scene.ending ? [] : scene.exits.filter(exit => exitLacks(exit, walked, view.state).length === 0)
        const tools = line.ended ? [el('span', { class: 'muted small', text: t`演完了` })]
          : scene.ending ? [el('button', { type: 'button', class: 'btn small ghost', text: t`这一段收尾了`, onclick: guard(() => act({ action: 'side', id: side.id, ended: true })) })]
            : ways.length === 1 ? [el('button', { type: 'button', class: 'btn small ghost', text: t`这一段演完了`, onclick: guard(() => act({ action: 'side', id: side.id, to: ways[0].to })) })]
              : ways.map(exit => el('button', { type: 'button', class: 'btn small ghost', text: exit.hint || titleOf(view, exit.to), title: exit.when, onclick: guard(() => act({ action: 'side', id: side.id, to: exit.to })) }))
        return el('div', { class: `plot-side${line.ended ? ' ended' : ''}` }, [
          el('span', { class: 'plot-side-name', text: side.name }),
          el('span', { class: 'plot-side-at', text: line.ended ? t`结局 · ${scene.title}` : scene.title, title: scene.what }),
          el('span', { class: 'plot-side-tools' }, tools),
        ])
      }),
    ])
  }

  function silentRow() {
    return el('div', { class: 'plot-stray', role: 'status' }, [
      el('span', { class: 'plot-stray-text', text: t`模型这几轮都没写进度，剧本走不动` }),
      el('span', { class: 'plot-stray-tools' }, [
        el('button', { type: 'button', class: 'btn small', text: t`改用辅助模型判断`, title: t`每几轮让辅助模型看一眼故事，替它判断演到哪了；多花一点用量`, onclick: guard(() => act({ action: 'settings', judge: 'helper' })) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`知道了`, title: t`不再提示；可以自己点「这一幕演完了」往下走`, onclick: guard(() => act({ action: 'settings', hushSilent: true })) }),
      ]),
    ])
  }

  function newerRow(view, card) {
    return el('div', { class: 'plot-stray plot-newer', role: 'status' }, [
      el('span', { class: 'plot-stray-text', text: t`卡里的「${card.name}」改过了` }),
      el('span', { class: 'plot-stray-tools' }, [
        el('button', { type: 'button', class: 'btn small', text: t`换成新版`, title: t`这段对话改用卡里现在的剧本，进度照旧`, onclick: guard(async () => {
          if (view.version > 1 && !confirm(t`这段对话里改过剧本，换成新版会盖掉这些改动。确定？`)) return
          await act({ action: 'refresh' })
          toast(t`已换成新版`)
        }) }),
        el('button', { type: 'button', class: 'btn small ghost', text: t`不管`, title: t`接着用这段对话的那份，这一版不再提示`, onclick: guard(() => act({ action: 'keep', updatedAt: card.updatedAt })) }),
      ]),
    ])
  }

  function forkCard(view, exits) {
    return el('div', { class: 'plot-forks', role: 'group', 'aria-label': t`岔路` }, [
      el('div', { class: 'plot-forks-head' }, [el('span', { html: FORK }), el('b', { text: t`岔路` }), el('span', { class: 'muted small', text: t`选一条，下一轮照着走；不选就按你的行动来定` })]),
      ...exits.map(({ exit, open, lacks, target }) => {
        const seen = shown(target, view.spoiler, view.progress)
        const label = exit.hint || (seen === 'none' ? t`？（还没发现的路）` : target.title)
        const why = lacks.map(lack => lackText(lack, id => titleOf(view, id))).join(t`；`)
        return open
          ? el('button', { type: 'button', class: 'plot-way', onclick: guard(async () => {
            state.fork = false
            await act({ action: 'exit', to: exit.to })
          }) }, [el('span', { text: label }), exit.when && view.spoiler !== 'blind' ? el('small', { class: 'muted', text: exit.when }) : null].filter(Boolean))
          : el('div', { class: 'plot-way locked', title: view.spoiler === 'blind' ? t`条件还没满足` : why }, [
            el('span', { text: view.spoiler === 'blind' ? t`🔒 还没解锁` : t`🔒 ${label}` }),
            view.spoiler !== 'blind' && why ? el('small', { text: why }) : null,
          ].filter(Boolean))
      }),
      el('button', { type: 'button', class: 'btn small ghost plot-self', text: t`我自己写`, onclick: () => {
        state.fork = false
        sync(getChat())
        document.getElementById('input')?.focus()
      } }),
    ])
  }

  function everyPick(view) {
    const box = el('select', { 'aria-label': t`隔几轮看一次` }, [2, 3, 4, 5, 6].map(n => el('option', { value: String(n), text: t`每 ${n} 轮`, selected: n === (view.judge?.every ?? 3) })))
    box.addEventListener('change', guard(() => act({ action: 'settings', every: Number(box.value) })))
    return box
  }

  // 主动推进: something is left to play, and the plot runs.
  const pushable = view => !view.paused && !view.progress.ended
  function pushNote(view, scene) {
    const { how, point } = view.pending.push
    if (how === 'scene') return scene.ending ? t`下一轮把结局写完` : exitsOf(view).filter(item => item.open).length > 1 ? t`下一轮走到岔路口` : t`下一轮演完这一幕`
    const ticked = new Set(view.progress.ticks)
    const next = scene.points.find(item => item.id === point) ?? scene.points.find(item => !ticked.has(item.id))
    return next ? t`下一轮演：${next.text}` : t`下一轮推进一步`
  }

  /** 推进速度: a slider, its name and what the scene takes at it; kept when let go. */
  function paceControl(view, scene) {
    const range = el('input', { type: 'range', class: 'plot-pace', min: -MAX_PACE, max: MAX_PACE, step: 1, value: view.pace ?? 0, 'aria-label': t`推进速度` })
    const name = el('b', { class: 'plot-pace-name' })
    const note = el('span', { class: 'muted small plot-pace-note' })
    const show = () => {
      const pace = Number(range.value)
      const { min, max } = turnsOf(scene, pace)
      name.textContent = PACES()[pace][0]
      note.textContent = `${PACES()[pace][1]}${t`；`}${max ? t`这一幕 ${min} 到 ${max} 轮` : t`这一幕至少 ${min} 轮`}`
    }
    range.addEventListener('input', show)
    range.addEventListener('change', guard(() => act({ action: 'settings', pace: Number(range.value) })))
    show()
    return [range, name, note]
  }

  function sceneCard(view, scene, exits) {
    const ticked = new Set(view.progress.ticks)
    const pendingTicks = new Set(view.pending?.ticks ?? [])
    const open = exits.filter(item => item.open)
    const finish = guard(async () => {
      if (scene.ending) return act({ action: 'end' })
      if (open.length === 1) return act({ action: 'exit', to: open[0].exit.to })
      state.fork = true
      sync(getChat())
    })
    const segment = (items, value, action) => el('div', { class: 'plot-seg', role: 'group' }, items.map(([id, name, tip]) => el('button', {
      type: 'button', class: 'btn small', text: name, title: tip, 'aria-pressed': String(id === value), onclick: guard(() => act({ action: 'settings', [action]: id })),
    })))
    const ask = el('input', { type: 'checkbox', checked: view.askAtFork })
    ask.addEventListener('change', guard(() => act({ action: 'settings', askAtFork: ask.checked })))
    const judges = [['model', t`模型自己写`, t`模型在每条回复最后写一行看不到的进度`], ['helper', t`辅助模型看`, t`每几轮让辅助模型看一眼故事判断进度；适合不写进度的模型，多花一点用量`]]
    const judgeBy = view.judge?.by ?? 'model'
    const nameOf = (items, id) => items.find(([key]) => key === id)?.[1] ?? ''
    const planned = turnsOf(scene, view.pace)
    const late = planned.max && view.progress.turns >= planned.max
    // A setting a line of its own: its name, then what can be picked.
    const setting = (name, ...controls) => el('div', { class: 'plot-set' }, [el('span', { class: 'plot-set-name', text: name }), el('div', { class: 'plot-set-controls' }, controls.filter(Boolean))])
    const settings = el('details', { class: 'plot-settings', open: settingsOpen() }, [
      el('summary', {}, [
        el('span', { text: t`剧本设置` }),
        el('span', { class: 'plot-settings-now', text: [nameOf(TIGHTNESS(), view.tightness), view.pace ? t`推进${PACES()[view.pace][0]}` : '', nameOf(SPOILERS(), view.spoiler), nameOf(judges, judgeBy)].filter(Boolean).join(' · ') }),
      ]),
      el('div', { class: 'plot-set-list' }, [
        setting(t`剧本约束`, segment(TIGHTNESS(), view.tightness, 'tightness')),
        setting(t`推进速度`, ...paceControl(view, scene)),
        setting(t`路线图显示`, segment(SPOILERS(), view.spoiler, 'spoiler')),
        setting(t`进度`, segment(judges, judgeBy, 'judge'), judgeBy === 'helper' ? everyPick(view) : null),
        setting(t`岔路`, el('label', { class: 'plot-ask small' }, [ask, el('span', { text: t`到岔路主动问我` })])),
      ]),
      el('div', { class: 'plot-set-foot' }, [
        el('button', { type: 'button', class: 'btn small ghost', text: t`隐藏剧本条`, title: t`剧本照常生效；在路线图上可以再显示出来`, onclick: () => {
          setBarHidden(true)
          sync(getChat())
          toast(t`剧本条藏起来了：剧本照常生效，顶栏「剧本」打开路线图可以再显示`)
        } }),
        el('button', { type: 'button', class: 'btn small ghost danger plot-stop', text: t`停用剧本`, onclick: guard(async () => {
          if (!confirm(t`停用「${view.copy.name}」？之后不再带剧本，已经演过的不受影响；想再用可以从对话菜单重新挂上。`)) return
          await act({ action: 'stop' })
          toast(t`已停用剧本`)
        }) }),
      ]),
    ])
    settings.addEventListener('toggle', () => setSettingsOpen(settings.open))
    return el('div', { class: 'plot-card' }, [
      el('div', { class: 'plot-scene' }, [
        el('div', { class: 'plot-scene-head' }, [
          el('h4', { text: scene.title }),
          el('span', { class: `plot-turns${late ? ' late' : ''}`, text: late ? t`已演 ${view.progress.turns} 轮，比预计的久了` : t`已演 ${view.progress.turns} 轮` }),
        ]),
        scene.what ? el('p', { class: 'plot-what', text: scene.what }) : null,
        scene.points.length ? el('div', { class: 'plot-points-head' }, [
          el('span', { class: 'plot-points-name', text: t`要点` }),
          el('span', { class: 'plot-points-hint', text: t`模型演到哪条会自动打勾；它漏标了可以自己勾上` }),
        ]) : null,
        scene.points.length ? el('ul', { class: 'plot-points' }, scene.points.map(point => {
          const done = ticked.has(point.id) || pendingTicks.has(point.id)
          const box = el('input', { type: 'checkbox', checked: done, disabled: done, 'aria-label': point.text })
          box.addEventListener('change', guard(() => act({ action: 'tick', ticks: [point.id] })))
          return el('li', { class: done ? 'done' : '' }, [
            el('label', {}, [box, el('span', { text: point.text })]),
            !done && pushable(view) ? el('button', { type: 'button', class: `btn small ghost plot-point-push${view.pending?.push?.point === point.id ? ' on' : ''}`, text: t`演这条`, title: t`下一轮就演这条要点`, onclick: guard(() => act({ action: 'push', how: 'step', point: point.id })) }) : null,
          ].filter(Boolean))
        })) : null,
        scene.done ? el('p', { class: 'plot-done', text: t`演到这里算完：${scene.done}` }) : null,
      ].filter(Boolean)),
      sideBox(view),
      el('div', { class: 'plot-buttons' }, [
        ...(view.progress.ended
          ? [
            el('button', { type: 'button', class: 'btn small', text: t`继续写下去`, title: t`不用剧本了，接着自由写`, onclick: guard(() => act({ action: 'stop' })) }),
            el('button', { type: 'button', class: 'btn small', text: t`回到岔路口`, title: t`在路线图上点一个走过的岔路口，换一条路`, onclick: guard(() => openMap({ fork: true })) }),
            el('button', { type: 'button', class: 'btn small', text: t`开新对话`, onclick: guard(() => newChat()) }),
          ]
          : [
            pushable(view) ? el('button', { type: 'button', class: 'btn small primary', text: t`推进一步`, title: t`下一轮演这一幕的下一条要点；要点都演到了就往结尾走一步`, onclick: guard(() => act({ action: 'push', how: 'step' })) }) : null,
            pushable(view) ? el('button', { type: 'button', class: 'btn small', text: scene.ending ? t`写完结局` : open.length > 1 ? t`推到岔路口` : t`推到收尾`, title: scene.ending ? t`下一轮把结局写完` : open.length > 1 ? t`下一轮走到要选路的地方，停下来等你选` : t`下一轮把这一幕演完，再下一轮进下一幕；不等「至少演几轮」`, onclick: guard(() => act({ action: 'push', how: 'scene' })) }) : null,
            el('button', { type: 'button', class: 'btn small', text: scene.ending ? t`收尾，结束剧本` : t`这一幕演完了`, title: t`不再演这一幕，下一轮直接往下走`, onclick: finish }),
            el('button', { type: 'button', class: 'btn small', text: view.paused ? t`恢复剧本` : t`暂停剧本`, title: view.paused ? '' : t`暂停期间不带剧本，随时恢复`, onclick: guard(() => act({ action: view.paused ? 'resume' : 'pause' })) }),
          ].filter(Boolean)),
        el('div', { class: 'plot-edits' }, [
          el('button', { type: 'button', class: 'btn small ghost', text: t`改剧本`, title: t`改这段对话用的剧本，卡里的原稿不变`, onclick: guard(() => editCopy()) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`问问向导改`, title: t`说一句想怎么改，向导列出改动，逐条勾选；走过的幕不改`, onclick: guard(() => askGuide('edit')) }),
          el('button', { type: 'button', class: 'btn small ghost', text: t`整理成剧本`, title: t`把这段对话走过的路整理成一份新剧本，放进卡里，能重玩`, onclick: guard(() => askGuide('fromChat')) }),
        ]),
      ]),
      settings,
    ])
  }

  return { sync, act }
}
