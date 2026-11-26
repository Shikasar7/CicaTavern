// 剧本 on a chat (plans/22): the copy of a card's plot a chat plays (chat.plot), what the page gets of it, and the
// player's changes to it. The plot's own shape, the progress and the turn's block are web/shared/plot.js; the engine
// sends the block and keeps each reply's progress (node.plot).
import { applySet, cleanPace, cleanPlot, MAX_EXITS, MAX_SCENES, newPlotId, plotProblems, progressOn, sceneOf, SPOILERS, TIGHTNESS, turnsOf } from '../web/shared/plot.js'
import { pathTo } from './chats.mjs'
import { msg } from './i18n.mjs'
import { withoutHidden } from './recap.mjs'
import { httpError } from './store.mjs'

/**
 * chat.plot for a chat starting on (or put on) card plot `plot`: { copy, start, tightness, spoiler, askAtFork, paused,
 * pending, version }, and pace (推进速度) once the player set one. Its own copy: changing it in the chat leaves the card's alone. Refused while its shape is broken.
 */
export function chatPlot(plot, { start = null, spoiler = 'all' } = {}) {
  const copy = cleanPlot(plot)
  if (!copy) throw httpError(400, msg`这个剧本里还没有幕`)
  const { blocking } = plotProblems(copy)
  if (blocking.length) throw httpError(400, msg`这个剧本还不能用：${blocking[0].text}`)
  return {
    copy,
    start: sceneOf(copy, start) ? start : copy.start,
    tightness: copy.tightness,
    spoiler: SPOILERS.includes(spoiler) ? spoiler : 'all',
    askAtFork: false,
    paused: false,
    pending: null,
    version: 1,
  }
}

/** The progress on the chat's active path `active`, with the player's change not yet sent on it. */
export function currentProgress(chat, active) {
  const plot = chat.plot
  if (!plot?.copy) return null
  const base = progressOn(plot.copy, withoutHidden(active), plot.start)
  const tip = active.at(-1)
  return plot.pending?.after === tip?.id ? applySet(plot.copy, base, plot.pending.set) : base
}

/** What the page gets of a chat's plot (chats.mjs chatView). */
export function plotView(chat, active) {
  const plot = chat.plot
  if (!plot?.copy) return null
  return {
    copy: plot.copy,
    start: plot.start,
    tightness: plot.tightness,
    pace: cleanPace(plot.pace),
    spoiler: plot.spoiler,
    askAtFork: Boolean(plot.askAtFork),
    paused: Boolean(plot.paused),
    pending: plot.pending?.after === active.at(-1)?.id ? plot.pending.set : null,
    // A change kept for a turn sent from an earlier reply (从这里分支, 回到岔路口): the page shows it while branching there.
    pendingAfter: plot.pending && plot.pending.after !== active.at(-1)?.id ? { after: plot.pending.after, set: plot.pending.set } : null,
    version: plot.version ?? 1,
    // 卡里的剧本有新版本: the card's update the player said to leave be (keep).
    seenUpdate: plot.seenUpdate ?? '',
    judge: { by: plot.judge?.by === 'helper' ? 'helper' : 'model', every: plot.judge?.every ?? 3 },
    hushSilent: Boolean(plot.hushSilent),
    progress: currentProgress(chat, active),
  }
}

/**
 * chat.plot after the player's action (changed in place on `chat`). `tip`: the node the next turn follows.
 *   settings { tightness?, pace?, spoiler?, askAtFork? }; pause; resume; stop (the plot taken off);
 *   jump { at }, exit { to }, tick { ticks }, end: the progress changed, sent with the next turn (pending);
 *   push { how, point? } (主动推进: the next turn plays a step of the scene, or the rest of it);
 *   pull (拉回来: the next turn brings the story back), quiet (不用管: no more 故事岔开了 in this scene);
 *   detour { scene, back } (就这样走: a scene of what the story did instead, put in after the one now, and gone to);
 *   undo: that change dropped; edit { copy }: the chat's copy written over (its progress kept where it fits).
 * `tip` is the reply the change goes with: the latest, or an earlier one the next turn is sent from (回到岔路口).
 */
export function changePlot(chat, body, tip) {
  const plot = chat.plot
  if (!plot?.copy) throw httpError(409, msg`这段对话没有在用剧本`)
  const action = body?.action
  const set = change => {
    // One of these at a time: where the next turn goes, or how it gets there.
    const { push: _push, pull: _pull, ...rest } = plot.pending?.after === tip.id ? plot.pending.set : {}
    const before = change.at || change.push || change.pull || change.ended ? rest : { ...rest, ...(_push ? { push: _push } : {}), ...(_pull ? { pull: _pull } : {}) }
    plot.pending = { after: tip.id, set: { ...before, ...change, ...(change.ticks ? { ticks: [...new Set([...(before.ticks ?? []), ...change.ticks])] } : {}) } }
  }
  if (action === 'settings') {
    if (TIGHTNESS.includes(body.tightness)) plot.tightness = body.tightness
    if (typeof body.pace === 'number') plot.pace = cleanPace(body.pace)
    if (SPOILERS.includes(body.spoiler)) plot.spoiler = body.spoiler
    if (typeof body.askAtFork === 'boolean') plot.askAtFork = body.askAtFork
    // 谁来判断进度: the model's own mark, or the helper every few turns.
    if (body.judge === 'model' || body.judge === 'helper') plot.judge = { by: body.judge, every: plot.judge?.every ?? 3 }
    if (body.every !== undefined) plot.judge = { by: plot.judge?.by ?? 'model', every: Math.min(6, Math.max(2, Math.round(Number(body.every)) || 3)) }
    if (typeof body.hushSilent === 'boolean') plot.hushSilent = body.hushSilent
  } else if (action === 'pause') plot.paused = true
  else if (action === 'resume') plot.paused = false
  else if (action === 'stop') delete chat.plot
  else if (action === 'jump' || action === 'exit') {
    const to = String((action === 'jump' ? body.at : body.to) ?? '')
    if (!sceneOf(plot.copy, to)) throw httpError(400, msg`剧本里没有这一幕`)
    // A scene of a side line: that line goes there (opened if it was not); the main story stays where it is.
    const side = sceneOf(plot.copy, to).side
    if (side) set({ side: { id: side, to } })
    else set({ at: to, ...(action === 'exit' ? { picked: true } : {}) })
  } else if (action === 'tick') {
    const ticks = (Array.isArray(body.ticks) ? body.ticks : []).filter(id => typeof id === 'string').slice(0, 10)
    set({ ticks })
  } else if (action === 'end') set({ ended: true })
  else if (action === 'keep') plot.seenUpdate = String(body.updatedAt ?? '').slice(0, 40)
  else if (action === 'push') {
    const now = currentProgress(chat, pathTo(chat, tip.id))
    const scene = sceneOf(plot.copy, now?.at)
    if (!scene || now.ended) throw httpError(409, msg`剧本已经演完了`)
    const point = scene.points.find(item => item.id === body.point)?.id
    set({ push: body.how === 'scene' ? { how: 'scene' } : { how: 'step', ...(point ? { point } : {}) } })
  }
  else if (action === 'pull') set({ pull: true })
  else if (action === 'quiet') set({ quiet: true })
  else if (action === 'side') {
    // 支线: a way taken on one, or its ending played out, by the player.
    const side = plot.copy.sides?.find(item => item.id === body.id)
    if (!side) throw httpError(400, msg`剧本里没有这条支线`)
    if (body.ended === true) set({ side: { id: side.id, ended: true } })
    else if (sceneOf(plot.copy, body.to)?.side === side.id) set({ side: { id: side.id, to: body.to } })
    else throw httpError(400, msg`剧本里没有这一幕`)
  }
  else if (action === 'detour') {
    const id = newPlotId('s', new Set(plot.copy.scenes.map(scene => scene.id)))
    const now = currentProgress(chat, pathTo(chat, tip.id))?.at
    const back = sceneOf(plot.copy, body.back) ? body.back : now
    const scene = { ...(body.scene ?? {}), id, exits: back ? [{ to: back, when: '', hint: '' }] : [], ending: null }
    const index = plot.copy.scenes.findIndex(item => item.id === now)
    // The scene it went off from leads into it (once: closed when it has been played), so the map shows where it is.
    const scenes = plot.copy.scenes.map(item => (item.id === now && !item.ending && item.exits.length < MAX_EXITS
      ? { ...item, exits: [...item.exits, { to: id, when: '', hint: '', needs: { unseen: id } }] }
      : item))
    scenes.splice(index < 0 ? scenes.length : index + 1, 0, scene)
    const copy = cleanPlot({ ...plot.copy, scenes })
    if (!copy || !sceneOf(copy, id) || copy.scenes.length > MAX_SCENES || scenes.length > MAX_SCENES) throw httpError(400, msg`剧本已经有 ${MAX_SCENES} 幕了`)
    plot.copy = copy
    plot.version = (plot.version ?? 1) + 1
    set({ at: id })
  } else if (action === 'undo') plot.pending = null
  else if (action === 'edit') {
    const copy = cleanPlot({ ...body.copy, id: plot.copy.id })
    if (!copy) throw httpError(400, msg`剧本里至少要有一幕`)
    plot.copy = copy
    if (!sceneOf(copy, plot.start)) plot.start = copy.start
    plot.version = (plot.version ?? 1) + 1
  } else throw httpError(400, msg`不认识的操作`)
  return chat
}

/**
 * 换成新版: the chat's copy replaced by the card's plot as it is now (`plots`, the card's); the progress stays where it
 * fits (progressOn falls back to the latest scene still there). → the chat, changed in place.
 */
export function refreshPlot(chat, plots) {
  if (!chat.plot?.copy) throw httpError(409, msg`这段对话没有在用剧本`)
  const plot = (plots ?? []).find(item => item.id === chat.plot.copy.id)
  if (!plot) throw httpError(404, msg`这个剧本不在了`)
  const copy = cleanPlot(plot)
  chat.plot = { ...chat.plot, copy, start: sceneOf(copy, chat.plot.start) && !sceneOf(copy, chat.plot.start).side ? chat.plot.start : copy.start, version: (chat.plot.version ?? 1) + 1, seenUpdate: plot.updatedAt ?? '' }
  return chat
}

// ─── 辅助模型判断 (plans/22 十三·3) ────────────────────────────────────────────

/** The JSON in a model's answer: the ```json block, else from the first { to the last }, stray commas forgiven. */
export function jsonIn(text) {
  const source = String(text ?? '')
  const fenced = source.match(/```(?:json)?\s*\n([\s\S]*?)```/i)?.[1] ?? source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1)
  if (!fenced.trim()) return null
  const tries = [fenced, fenced.replace(/,\s*([}\]])/g, '$1'), fenced.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')]
  for (const attempt of tries) {
    try {
      const value = JSON.parse(attempt)
      if (value && typeof value === 'object') return value
    } catch {
      // the next, more forgiving way
    }
  }
  return null
}

/**
 * The helper's question: has the story played this scene's points, is the scene done, which way did it go. `sent`
 * is what the turn was told (its scene, points and open exits, in order); `story` the last turns (roster.mjs
 * chatMaterial).
 */
export function judgeRequest(plot, progress, sent, story) {
  const scene = sceneOf(plot, sent.at)
  const { min } = turnsOf(scene, sent.pace)
  const ticked = new Set(progress.ticks ?? [])
  const points = sent.points.map((id, index) => `${index + 1}. ${scene.points.find(point => point.id === id)?.text ?? ''}${ticked.has(id) ? '（之前已经演到）' : ''}`)
  const ways = sent.exits.map((to, index) => {
    const exit = scene.exits.find(item => item.to === to)
    return `${index + 1}. ${exit?.when ? `当${exit.when.replace(/^当/, '')}` : '演完后'} → 去「${sceneOf(plot, to)?.title ?? ''}」`
  })
  const lines = [
    `当前这一幕：「${scene.title}」`,
    scene.what ? `要发生什么：${scene.what}` : '',
    points.length ? ['要点：', ...points].join('\n') : '',
    scene.done ? `演到什么算完：${scene.done}` : '',
    `这一幕连这一轮已经演了 ${(progress.turns ?? 0) + 1} 轮${min ? `，至少要演 ${min} 轮` : ''}。`,
    scene.ending ? '这一幕是结局：收场写完了就算演完。' : ways.length ? ['演完后能走的路：', ...ways].join('\n') : '',
  ].filter(Boolean)
  // 支线: the ones the turn listed, numbered as it did.
  const sides = (sent.sides ?? []).map((item, index) => {
    const side = (plot.sides ?? []).find(entry => entry.id === item.id)
    const at = sceneOf(plot, item.at)
    if (!side || !at) return ''
    const sideWays = item.exits.map((to, j) => {
      const exit = at.exits.find(entry => entry.to === to)
      return `${j + 1}. ${exit?.when ? `当${exit.when.replace(/^当/, '')}` : '演完后'} → 「${sceneOf(plot, to)?.title ?? ''}」`
    })
    return [
      `支线${index + 1}「${side.name}」现在是「${at.title}」${at.what ? `：${at.what}` : ''}`,
      item.points.length ? `要点：${item.points.map((id, j) => `${j + 1}. ${at.points.find(point => point.id === id)?.text ?? ''}`).join('；')}` : '',
      at.done ? `演到什么算完：${at.done}` : '',
      at.ending ? '这一段是这条支线的结局。' : sideWays.length ? `演完后：${sideWays.join('；')}` : '',
    ].filter(Boolean).join('\n')
  }).filter(Boolean)
  if (sides.length) lines.push('', '支线（和主线并行的小故事）：', ...sides)
  return {
    system: '你替一段互动故事核对剧本走到了哪里。只看故事里真的写出来的事，不猜，不替故事往下编。只回一个 JSON。',
    messages: [{
      role: 'user',
      content: [
        ['<剧本这一幕>', ...lines, '</剧本这一幕>'].join('\n'),
        ['<最近的故事>', story || '（还没有）', '</最近的故事>'].join('\n'),
        '看最近的故事（最后一段最要紧）回答：哪几个要点已经在故事里演到了；这一幕是不是已经演完了；演完了的话，按故事里玩家做的事走的是哪条路；玩家是不是明显离开了这一幕的剧本。',
        sides.length
          ? '只回 JSON：{ "points": [演到的要点序号], "done": true 或 false, "exit": 路的序号或 null, "astray": true 或 false, "sides": [{ "n": 支线编号, "points": [要点序号], "done": true 或 false, "exit": 路的序号或 null }] }。支线只写这几轮有进展的。'
          : '只回 JSON：{ "points": [演到的要点序号], "done": true 或 false, "exit": 路的序号或 null, "astray": true 或 false }',
      ].join('\n\n'),
    }],
    maxTokens: 400,
  }
}


/** The helper's answer as a mark (takePlotMark's shape), or null when it says nothing readable. */
export function readJudge(text) {
  const value = jsonIn(text)
  if (!value) return null
  const points = (Array.isArray(value.points) ? value.points : []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  const yes = v => v === true || /^(true|yes|是|1)$/i.test(String(v ?? ''))
  const exitOf = raw => (Number.isInteger(Number(raw)) && Number(raw) > 0 ? String(Number(raw)) : '')
  const numbers = list => (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isInteger(n) && n > 0)
  // 支线: by the number the question gave each.
  const sides = {}
  for (const item of Array.isArray(value.sides) ? value.sides : []) {
    const n = Number(item?.n)
    if (Number.isInteger(n) && n > 0) sides[n] = { points: numbers(item.points), done: yes(item.done), exit: exitOf(item.exit) }
  }
  return { points, done: yes(value.done), exit: exitOf(value.exit), astray: yes(value.astray), ...(Object.keys(sides).length ? { sides } : {}) }
}
