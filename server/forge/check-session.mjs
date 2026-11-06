// 角色卡自检 over a card's own session (edit-check-<card id>, beside the 对话修改 ones): what the program finds is worked
// out each time the window asks, so it is never out of date; what is kept is what cost something or was decided: the
// model's suggestions, what was ignored, and what was taken in, to take back. Findings go in one at a time, each
// remembering what it touched, so any of them can be undone later. The model's step runs as a draft's jobs do.
import { readFile } from 'node:fs/promises'
import { rawOfPicture } from '../cards.mjs'
import { estimateTokens } from '../context.mjs'
import { msg } from '../i18n.mjs'
import { estimateCost } from '../models.mjs'
import { isProviderRef, refLabel } from '../providers.mjs'
import { helperScriptsOf } from '../schema.mjs'
import { httpError, newId } from '../store.mjs'
import { initialState } from '../worldbook.mjs'
import { applyFinding, changedPieces, restorePieces, snapshot, staleChange, withEdits } from './check-apply.mjs'
import { DEFAULT_FOCUS, checkRequest, cleanFocus, readCheck, unreadable, vetSuggestions } from './check-model.mjs'
import { cardFacts, checkCard, startingState } from './check.mjs'

const PREFIX = 'edit-check-'
const MAX_RECORDS = 200
const MAX_IGNORED = 500
// What a model writes back, thinking included, for the estimate: 19 000 to 28 000 whatever the card's size (ark, 2026-11).
const OUTPUT_TOKENS = 20000

/**
 * @param deps - from createForge: { store, load, save, serial, run, jobs, removeFile(id), cutNote(result) }
 */
export function createCheck({ store, load, save, serial, run, jobs, removeFile, cutNote }) {
  const idOf = cardId => `${PREFIX}${cardId}`

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

  /** The scripts in a card's file, read only for a card that has any: they say whether a schema keeps its variables. */
  async function helpersOf(card) {
    if (!card.helperScripts || !card.hasAvatar) return null
    const picture = await readFile(store.avatarPath(card.id)).catch(() => null)
    const raw = picture ? rawOfPicture(picture) : null
    return raw ? helperScriptsOf((raw.data ?? raw).extensions) : null
  }

  /** What sending it would come to: the model, the tokens and, for a model with a price, the money. */
  async function estimateOf(card, session, found) {
    const { request, shown } = checkRequest(card, found, { focus: session.focus, state: initialState(card.book ? [card.book] : []) })
    const input = estimateTokens(`${request.system}${request.messages[0].content}`)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    return {
      ready,
      model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '',
      chars: request.messages[0].content.length,
      input,
      output: OUTPUT_TOKENS,
      cost: ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output: OUTPUT_TOKENS }) : null,
      shown: shown.length,
      entries: (card.book?.entries ?? []).length,
    }
  }

  /** The session as the page sees it: every finding, program's and model's, those ignored and those taken in apart. */
  async function view(card, session) {
    const helpers = await helpersOf(card)
    const found = checkCard(card, { helpers })
    const ignored = new Set(session.ignored ?? [])
    const job = jobs.get(session.id)
    const open = (session.suggestions ?? []).filter(item => !item.taken).map(item => (item.changes.some(change => staleChange(card, change)) ? { ...item, stale: true } : item))
    const all = [...found, ...open]
    return {
      cardId: card.id,
      name: card.name,
      model: session.model ?? '',
      focus: session.focus ?? DEFAULT_FOCUS,
      facts: cardFacts(card, { helpers }),
      state: startingState(card, { helpers }),
      findings: all.filter(item => !ignored.has(item.id)),
      ignored: all.filter(item => ignored.has(item.id)),
      reply: session.reply ?? '',
      askedAt: session.askedAt ?? null,
      askedModel: session.askedModel ?? '',
      records: (session.records ?? []).map(({ id, batch, title, at, prefix }) => ({ id, batch, title, at, prefix })),
      estimate: await estimateOf(card, session, found),
      job: job ? { step: job.step, startedAt: job.startedAt, chars: job.partial.length } : null,
      error: session.error ?? null,
    }
  }

  async function checkWork(ctx, cardId) {
    const { card, session } = await loadCheck(cardId)
    const helpers = await helpersOf(card)
    const found = checkCard(card, { helpers })
    ctx.step('read')
    const { request, shown, clipped } = checkRequest(card, found, { focus: session.focus, reply: ctx.languages.reply, state: initialState(card.book ? [card.book] : []) })
    const result = await ctx.call(request)
    const read = readCheck(result.text, card, { shown, clipped })
    if (!read.reply && !read.suggestions.length) throw new Error(`${unreadable(ctx.label)}${cutNote(result)}`)
    ctx.step('vet')
    const suggestions = vetSuggestions(card, read.suggestions, { helpers })
    await ctx.update(fresh => {
      // What was taken in stays, to be undone; the rest gives way to the new answer.
      fresh.suggestions = [...(fresh.suggestions ?? []).filter(item => item.taken), ...suggestions]
      fresh.reply = read.reply
      fresh.askedAt = new Date().toISOString()
      fresh.askedModel = ctx.label
    })
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

    /** Ask the model what is worth improving: sent only by this. */
    async checkAsk(cardId, { focus } = {}) {
      const key = idOf(cardId)
      const session = await serial(key, async () => {
        refuseWhileBusy(cardId)
        const { session } = await loadCheck(cardId)
        if (focus !== undefined) session.focus = cleanFocus(focus)
        return session
      })
      await run(session, 'check', ctx => checkWork(ctx, cardId))
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
        const helpers = await helpersOf(card)
        let found = checkCard(card, { helpers })
        const batch = newId()
        const records = []
        let applied = 0
        let prefix = false
        for (const { id, edits } of Array.isArray(items) ? items : []) {
          const suggestion = (session.suggestions ?? []).find(item => item.id === id && !item.taken)
          if (suggestion?.broken || (suggestion && suggestion.changes.some(item => staleChange(card, item)))) continue
          let finding = suggestion ?? found.find(item => item.id === id)
          if (finding && !suggestion && finding.changes.some(item => staleChange(card, item))) {
            found = checkCard(card, { helpers })
            finding = found.find(item => item.id === id)
          }
          if (!finding?.changes.length) continue
          const ready = withEdits(card, finding, edits)
          const before = snapshot(card)
          const done = applyFinding(card, ready)
          applied += done.applied
          prefix ||= done.prefix
          const at = new Date().toISOString()
          records.push({ id: newId(), batch, finding: id, title: finding.title, at, prefix: done.prefix, pieces: changedPieces(before, card) })
          if (suggestion) suggestion.taken = true
        }
        if (!records.length) throw httpError(409, msg`没有可以采用的建议，刷新一下再看`)
        await store.saveCard(card)
        session.records = [...(session.records ?? []), ...records].slice(-MAX_RECORDS)
        await save(session)
        return { view: await view(card, session), card, applied, prefix }
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
