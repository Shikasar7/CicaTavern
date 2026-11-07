// 角色卡自检 over a card's own session (edit-check-<card id>, beside the 对话修改 ones): what the program finds is worked
// out each time the window asks, so it is never out of date; what is kept is what cost something or was decided: the
// model's suggestions, what was ignored, and what was taken in, to take back. Findings go in one at a time, each
// remembering what it touched, so any of them can be undone later. The model's step runs as a draft's jobs do.
// The last 试玩体检's problems are listed too (from: 'trial'): the model is asked for changes to those only when the
// user picks one, and a problem a taken change answers is left out until that change is undone.
import { readFile } from 'node:fs/promises'
import { rawOfPicture } from '../cards.mjs'
import { latestState } from '../chats.mjs'
import { estimateTokens } from '../context.mjs'
import { msg } from '../i18n.mjs'
import { estimateCost } from '../models.mjs'
import { isProviderRef, refLabel } from '../providers.mjs'
import { helperScriptsOf } from '../schema.mjs'
import { httpError, newId } from '../store.mjs'
import { initialState } from '../worldbook.mjs'
import { getPath, splitPath } from '../../web/shared/vars.js'
import { applyFinding, changedPieces, rebased, restorePieces, snapshot, staleChange, withEdits } from './check-apply.mjs'
import { DEFAULT_FOCUS, checkRequest, cleanFocus, readCheck, restRequests, unreadable, vetSuggestions, withinPart } from './check-model.mjs'
import { STATUS_TUNE, cardFacts, checkCard, drawsOwnBar, startingState, statusTuning } from './check.mjs'
import { reportOutdated, trialFindings } from './trial.mjs'

const PREFIX = 'edit-check-'

/** The scripts in a card's file, read only for a card that has any; null when its picture is not that file. */
export async function helpersOf(store, card) {
  if (!card.helperScripts || !card.hasAvatar) return null
  const picture = await readFile(store.avatarPath(card.id)).catch(() => null)
  const raw = picture ? rawOfPicture(picture) : null
  const scripts = raw ? helperScriptsOf((raw.data ?? raw).extensions) : null
  return scripts?.length ? scripts : null
}
const MAX_RECORDS = 200
const MAX_IGNORED = 500
// What a model writes back, thinking included, for the estimate: 19 000 to 28 000 whatever the card's size (ark, 2026-11).
const OUTPUT_TOKENS = 20000

/** A trial suggestion's for="…" as the problems it answers; with one problem asked about, it is that one. */
function answersOf(numbers, asked) {
  if (!numbers?.length) return asked.length === 1 ? [asked[0].id] : []
  return [...new Set(numbers.map(n => asked[n - 1]?.id).filter(Boolean))]
}

/**
 * @param deps - from createForge: { store, load, save, serial, run, jobs, removeFile(id), cutNote(result),
 *   trialReport(cardId): the card's last 试玩体检 report, or null }
 */
export function createCheck({ store, load, save, serial, run, jobs, removeFile, cutNote, trialReport = async () => null }) {
  const idOf = cardId => `${PREFIX}${cardId}`

  /** The last trial's report and its problems still open. */
  async function trialOf(card, session) {
    const report = await trialReport(card.id).catch(() => null)
    const answered = new Set((session.suggestions ?? []).filter(item => item.taken).flatMap(item => item.answers ?? []))
    return { report, items: trialFindings(report, card).filter(item => !answered.has(item.id)) }
  }

  async function loadCheck(cardId) {
    const card = await store.getCard(cardId)
    const session = await load(idOf(cardId)).catch(error => {
      if (error.status !== 404) throw error
      const now = new Date().toISOString()
      return { id: idOf(cardId), kind: 'card', cardId, createdAt: now, updatedAt: now, model: '', job: null, error: null, focus: DEFAULT_FOCUS, suggestions: [], ignored: [], records: [] }
    })
    session.cardName = card.name
    return { card, session }
  }

  /** What sending it would come to: the model, the tokens and, for a model with a price, the money. */
  async function estimateOf(card, session, found, trial = null) {
    const state = initialState(card.book ? [card.book] : [])
    const { request, shown } = checkRequest(card, found, { focus: session.focus, state, trial, outdated: Boolean(trial?.some(item => item.outdated)) })
    const tokensOf = asked => estimateTokens(`${asked.system}${asked.messages[0].content}`)
    const input = tokensOf(request)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    const costOf = (input, output) => (ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output }) : null)
    // 全本检查, offered only when the ask leaves entries out: what its batches come to on top of it.
    const rest = trial ? null : restRequests(card, shown, { focus: session.focus, state })
    const restInput = rest?.parts.reduce((n, part) => n + tokensOf(part.request), 0) ?? 0
    return {
      ready,
      model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '',
      chars: request.messages[0].content.length,
      input,
      output: OUTPUT_TOKENS,
      cost: costOf(input, OUTPUT_TOKENS),
      shown: shown.length,
      entries: (card.book?.entries ?? []).length,
      rest: rest?.parts.length
        ? { parts: rest.parts.length, entries: rest.parts.reduce((n, part) => n + part.uids.length, 0), long: rest.long, left: rest.left, input: restInput, output: OUTPUT_TOKENS * rest.parts.length, cost: costOf(restInput, OUTPUT_TOKENS * rest.parts.length) }
        : null,
    }
  }

  /** The session as the page sees it: every finding, program's and model's, those ignored and those taken in apart. */
  /**
   * A status bar taken in that shows variables the card's chats under way don't have (an older card's chats keep
   * the variables they started with, and the checks read only the starting ones): those rows stay empty there until
   * a reply writes them. { chats, labels } for the page to say so, null when every chat has them.
   */
  async function chatGaps(card, barBefore) {
    if (JSON.stringify(barBefore) === JSON.stringify(card.statusBar ?? null)) return null
    const old = new Set((barBefore?.fields ?? []).filter(field => field.show !== 'hidden').map(field => field.path))
    const fields = (card.statusBar?.fields ?? []).filter(field => field.show !== 'hidden' && !old.has(field.path))
    if (!fields.length) return null
    const labels = new Map()
    let chats = 0
    for (const chat of await store.listChats(card.id).catch(() => [])) {
      const state = latestState(chat)
      if (!state) continue
      const lost = fields.filter(field => getPath(state, field.path) === undefined)
      if (!lost.length) continue
      chats += 1
      for (const field of lost) labels.set(field.path, field.label || splitPath(field.path).at(-1))
    }
    return chats ? { chats, labels: [...labels.values()] } : null
  }

  async function view(card, session) {
    const helpers = await helpersOf(store, card)
    const found = checkCard(card, { helpers })
    const ignored = new Set(session.ignored ?? [])
    const job = jobs.get(session.id)
    // A suggestion the card has moved on under is out of date only when its edit can no longer be placed (rebased).
    const open = (session.suggestions ?? []).filter(item => !item.taken).map(item => (rebased(card, item) ? item : { ...item, stale: true }))
    const trial = await trialOf(card, session)
    const all = [...found, ...trial.items, ...open]
    const trialOpen = trial.items.filter(item => !ignored.has(item.id))
    return {
      cardId: card.id,
      name: card.name,
      model: session.model ?? '',
      focus: session.focus ?? DEFAULT_FOCUS,
      facts: cardFacts(card, { helpers }),
      state: startingState(card, { helpers }),
      statusTune: statusTuning(card, { helpers }),
      ownBar: !card.statusBar && drawsOwnBar(card),
      findings: all.filter(item => !ignored.has(item.id)),
      ignored: all.filter(item => ignored.has(item.id)),
      reply: session.reply ?? '',
      askedAt: session.askedAt ?? null,
      askedModel: session.askedModel ?? '',
      // The last 全本检查: { total, done, entries, long, left }; done < total when it stopped part way.
      whole: session.whole ?? null,
      records: (session.records ?? []).map(({ id, batch, title, at, prefix }) => ({ id, batch, title, at, prefix })),
      estimate: await estimateOf(card, session, found),
      // The report the trial problems come from; the estimate is for asking about all of them still open.
      trial: trial.report
        ? {
            at: trial.report.at,
            model: trial.report.model ?? '',
            outdated: reportOutdated(trial.report, card),
            reply: session.trialReply ?? '',
            askedModel: session.trialAskedModel ?? '',
            estimate: trialOpen.length ? await estimateOf(card, session, found, trialOpen) : null,
          }
        : null,
      job: job ? { kind: job.kind, step: job.step, startedAt: job.startedAt, chars: job.partial.length } : null,
      error: session.error ?? null,
    }
  }

  /**
   * @param trialIds - the trial's problems to ask about, in place of the focus picks; null for the usual look.
   * @param whole - 全本检查: after the usual ask, the entries it left out, a batch at a time.
   */
  async function checkWork(ctx, cardId, trialIds = null, whole = false) {
    const { card, session } = await loadCheck(cardId)
    const helpers = await helpersOf(store, card)
    const found = checkCard(card, { helpers })
    const asked = trialIds ? (await trialOf(card, session)).items.filter(item => trialIds.includes(item.id)) : null
    if (asked && !asked.length) throw new Error(msg`试玩报告里没有这些问题了，刷新一下再看`)
    ctx.step('read')
    const state = initialState(card.book ? [card.book] : [])
    const { request, shown, clipped } = checkRequest(card, found, { focus: session.focus, reply: ctx.languages.reply, state, trial: asked, outdated: Boolean(asked?.some(item => item.outdated)) })
    const result = await ctx.call(request)
    const read = readCheck(result.text, card, { shown, clipped })
    if (!read.reply && !read.suggestions.length) throw new Error(`${unreadable(ctx.label)}${cutNote(result)}`)
    ctx.step('vet')
    const vetted = vetSuggestions(card, read.suggestions, { helpers })
    // A trial's suggestions say which problems they answer, and keep apart from the usual look's.
    const suggestions = asked ? vetted.map(({ for: numbers, ...item }) => ({ ...item, id: item.id.replace(/^model:/, 'model-trial:'), trial: true, answers: answersOf(numbers, asked) })) : vetted.map(({ for: _, ...item }) => item)
    const fresh = new Set(suggestions.map(item => item.id))
    const rest = whole && !asked ? restRequests(card, shown, { focus: session.focus, reply: ctx.languages.reply, state }) : { parts: [], long: 0, left: 0 }
    const askedIds = new Set(asked?.map(item => item.id))
    // What was taken in stays, to be undone; of the rest, what the new answer is about gives way to it.
    const replaced = item => (asked ? item.trial && (!item.answers?.length || item.answers.some(id => askedIds.has(id))) : !item.trial)
    await ctx.update(draft => {
      draft.suggestions = [...(draft.suggestions ?? []).filter(item => item.taken || (!replaced(item) && !fresh.has(item.id))), ...suggestions]
      const at = new Date().toISOString()
      if (asked) Object.assign(draft, { trialReply: read.reply, trialAskedAt: at, trialAskedModel: ctx.label })
      else Object.assign(draft, { reply: read.reply, askedAt: at, askedModel: ctx.label, whole: rest.parts.length ? { total: rest.parts.length, done: 0, entries: rest.parts.reduce((n, part) => n + part.uids.length, 0), long: rest.long, left: rest.left } : null })
    })
    // Each batch's suggestions are kept as it comes in: stopped part way, what the batches before found stays.
    for (const [i, part] of rest.parts.entries()) {
      ctx.step(`part:${i + 1}:${rest.parts.length}`)
      try {
        const answer = await ctx.call(part.request)
        const more = readCheck(answer.text, card, { shown: part.uids })
        if (!more.reply && !more.suggestions.length) throw new Error(`${unreadable(ctx.label)}${cutNote(answer)}`)
        const kept = vetSuggestions(card, withinPart(more.suggestions, part.uids), { helpers }).map(({ for: _, ...item }) => item)
        await ctx.update(draft => {
          const have = new Set((draft.suggestions ?? []).map(item => item.id))
          draft.suggestions = [...(draft.suggestions ?? []), ...kept.filter(item => !have.has(item.id))]
          draft.whole = { ...draft.whole, done: i + 1 }
        })
      } catch (error) {
        if (!ctx.signal.aborted) error.message = `${msg`全本检查停在第 ${i + 1} 批，前面几批的建议留着。`}${error.message}`
        throw error
      }
    }
  }

  const change = (cardId, fn) =>
    serial(idOf(cardId), async () => {
      const { card, session } = await loadCheck(cardId)
      const out = await fn(card, session)
      await save(session)
      return out ?? view(card, session)
    })

  const refuseWhileBusy = cardId => {
    if (jobs.has(idOf(cardId))) throw httpError(409, msg`模型还在看这张卡，等它看完或先停下`)
  }

  return {
    async checkGet(cardId) {
      const { card, session } = await loadCheck(cardId)
      return view(card, session)
    },

    /** The model to ask, the things to look at, and what is ignored or brought back. */
    checkUpdate(cardId, { model, focus, ignore, restore } = {}) {
      return change(cardId, (_, session) => {
        if (typeof model === 'string') session.model = model.trim().slice(0, 200)
        if (focus !== undefined) session.focus = cleanFocus(focus)
        const ignored = new Set(session.ignored ?? [])
        if (typeof ignore === 'string' && ignore) ignored.add(ignore)
        if (typeof restore === 'string') ignored.delete(restore)
        session.ignored = [...ignored].slice(-MAX_IGNORED)
      })
    },

    /**
     * Ask the model what is worth improving: sent only by this. `trial`: ids of the last trial's problems, to ask for
     * changes to those instead. `whole`: 全本检查, the entries the ask leaves out asked about after it in batches.
     */
    async checkAsk(cardId, { focus, trial, whole } = {}) {
      const key = idOf(cardId)
      const trialIds = Array.isArray(trial) ? trial.filter(id => typeof id === 'string').slice(0, 50) : null
      const session = await serial(key, async () => {
        refuseWhileBusy(cardId)
        const { card, session } = await loadCheck(cardId)
        if (trialIds && !(await trialOf(card, session)).items.some(item => trialIds.includes(item.id))) throw httpError(409, msg`试玩报告里没有这些问题了，刷新一下再看`)
        if (focus !== undefined) session.focus = cleanFocus(focus)
        return session
      })
      await run(session, trialIds ? 'check-trial' : 'check', ctx => checkWork(ctx, cardId, trialIds, whole === true && !trialIds))
      const { card, session: fresh } = await loadCheck(cardId)
      return view(card, fresh)
    },

    checkStop(cardId) {
      const job = jobs.get(idOf(cardId))
      job?.controller.abort()
      return { stopped: Boolean(job) }
    },

    /**
     * Take findings in, in the order given: `items`, [{ id, edits }] (edits: check-apply.mjs withEdits). The program's
     * are found again on the card as it stands, one change can have made the next out of date.
     * @returns { view, card, applied, prefix }
     */
    async checkApply(cardId, { items } = {}) {
      refuseWhileBusy(cardId)
      return serial(idOf(cardId), async () => {
        const { card, session } = await loadCheck(cardId)
        const helpers = await helpersOf(store, card)
        let found = checkCard(card, { helpers })
        const batch = newId()
        const records = []
        let applied = 0
        let prefix = false
        const barBefore = card.statusBar ?? null
        // Suggestions that could not go in with the rest (their words were changed by one before them), by title.
        const skipped = []
        for (const { id, edits } of Array.isArray(items) ? items : []) {
          const suggestion = (session.suggestions ?? []).find(item => item.id === id && !item.taken)
          if (suggestion?.broken) continue
          let finding = suggestion ?? (id === STATUS_TUNE ? statusTuning(card, { helpers }) : found.find(item => item.id === id))
          if (finding && !suggestion && finding.changes.some(item => staleChange(card, item))) {
            found = checkCard(card, { helpers })
            finding = found.find(item => item.id === id)
          }
          if (!finding?.changes.length) continue
          // Written against the card as it was: made again on it as it is now (one before it in this go may have added
          // to the same entry), or left in the list and named.
          const ready = suggestion ? rebased(card, withEdits(card, finding, edits)) : withEdits(card, finding, edits)
          if (!ready) {
            skipped.push(finding.title)
            continue
          }
          const before = snapshot(card)
          const done = applyFinding(card, ready)
          applied += done.applied
          prefix ||= done.prefix
          const at = new Date().toISOString()
          records.push({ id: newId(), batch, finding: id, title: finding.title, at, prefix: done.prefix, pieces: changedPieces(before, card) })
          if (suggestion) suggestion.taken = true
        }
        if (!records.length && skipped.length) throw httpError(409, msg`「${skipped.join(msg`」「`)}」要改的那段已经变了，对不上了：可以让模型再看看`)
        if (!records.length) throw httpError(409, msg`没有可以采用的建议，刷新一下再看`)
        await store.saveCard(card)
        session.records = [...(session.records ?? []), ...records].slice(-MAX_RECORDS)
        await save(session)
        return { view: await view(card, session), card, applied, taken: records.length, skipped, prefix, chatGaps: await chatGaps(card, barBefore) }
      })
    },

    /** Take back one thing taken in (`record`) or all that went in together (`batch`), the latest first. */
    async checkUndo(cardId, { record, batch } = {}) {
      refuseWhileBusy(cardId)
      return serial(idOf(cardId), async () => {
        const { card, session } = await loadCheck(cardId)
        const undone = (session.records ?? []).filter(item => item.id === record || (batch && item.batch === batch))
        if (!undone.length) throw httpError(409, msg`没有可以撤销的修改`)
        const copy = structuredClone(card)
        for (const item of [...undone].reverse()) restorePieces(copy, item.pieces)
        await store.saveCard(copy)
        const gone = new Set(undone.map(item => item.id))
        session.records = session.records.filter(item => !gone.has(item.id))
        for (const item of session.suggestions ?? []) if (undone.some(done => done.finding === item.id)) delete item.taken
        await save(session)
        return { view: await view(copy, session), card: copy, prefix: undone.some(item => item.prefix) }
      })
    },

    /** A deleted card's goes with it. */
    async dropCheck(cardId) {
      jobs.get(idOf(cardId))?.controller.abort()
      await removeFile(idOf(cardId))
    },
  }
}
