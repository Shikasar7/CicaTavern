// Creating a card by talking it through (创作角色卡). A draft lives in
// <data>/forge/<id>.json and moves through stages:
//   discuss: rounds of talk; each round the model reflects what it understood,
//            asks a few key questions with options to pick by feel, and keeps a
//            sketch of the card that the user can edit and lock;
//   plan:    the talk written up as a plan (characters, world, entries, openings),
//            which the user can comment on and have revised;
//   write:   the plan written out in a few grouped calls, then checked for stock
//            phrasing and contradictions and fixed (write.mjs); a stopped or
//            failed run carries on from the step it was at;
//   polish:  the card to read and edit, any piece rewritten by a note, the
//            avatar drawn or uploaded; saved as a card (PNG with the card in it).
// A card already saved, imported or made here, can be changed the same way by
// talking (修改角色卡, edit.mjs), and so can a worldbook (book-edit.mjs) and a
// preset (preset-edit.mjs): a session per thing, edit-<card id>,
// edit-book-<book id> or edit-preset-<preset id>, kept in <data>/forge/edits/
// and run like a draft's jobs.
// Model calls run in the background: a request starts a job and returns the
// draft at once; the page polls the draft until the job is done. Closing the
// window loses nothing.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { cardSummary, normalizeCard, writeCardPng } from '../cards.mjs'
import { cleanCardMedia, drawChoiceOf } from '../media.mjs'
import { complete, isProviderRef, providerError, refLabel, resolveRef } from '../providers.mjs'
import { httpError, newId } from '../store.mjs'
import { chosenUserName, discussRequest, editBrief, editTracking, editUserName, emptyBrief, forgeLanguages, partialReply, planLanguage, planRequest, readDiscussion, readPlan, reviseRequest } from './prompts.mjs'
import { alignCard, applyIssues, cardJson, entriesRequest, greetingsRequest, initialState, lintCard, matchWritten, newCard, readIssues, readTagged, retrack, reviewRequest, rewriteRequest, stepDone, userTagged, writeSteps } from './write.mjs'
import { applyChanges, editRequest, ensureBook, readEdit } from './edit.mjs'
import { applyBookChanges, bookEditRequest, bookTooLong, pickRequest, readBookEdit, readPicked } from './book-edit.mjs'
import { applyPresetChanges, presetEditRequest, presetPickRequest, presetTooLong, readPickedPrompts, readPresetEdit } from './preset-edit.mjs'
import { applyRegexChanges, readRegexEdit, regexEditRequest, tryChanges } from './regex-edit.mjs'
import { cleanThemeContext, readThemeEdit, themeApplier, themeEditRequest } from './theme-edit.mjs'
import { cleanScripts } from '../regex.mjs'
import { BASIC_ID } from '../../web/shared/basic.js'
import { currentLanguage, msg } from '../i18n.mjs'

const ID = /^[a-zA-Z0-9_-]{1,64}$/
const EDIT = 'edit-'
const MAX_EDIT_TURNS = 30
const STAGES = ['discuss', 'plan', 'write', 'polish']
const MAX_ROUNDS = 40
const MAX_TEXT = 4000
const MAX_PIECE = 20000
const IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/
const MAX_IMAGE = 15 * 1024 * 1024
// Rewrites per run of the fix step; asks per writing step before giving up.
const FIX_PIECES = 6
const STEP_TRIES = 2

const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** The image type of a picture's bytes. */
function imageType(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  if (buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return 'png'
}

/**
 * @param draw - (input, signal, choice) → { buffer, backend }: one picture from the image
 *   backend set up in 配图, or the one `choice` picks for it ({ backend, model },
 *   media.drawCardArt); without it, avatars are upload-only.
 */
/**
 * @param drawBackdrop - (prompt, signal) → { buffer }: a picture behind the page, drawn as
 *   配图 is set up; storeBackdrop(buffer) → its file name (主题 → 对话修改, theme-edit.mjs).
 */
export function createForge(store, { proxyNow = () => null, ledger = null, draw = null, drawBackdrop = null, storeBackdrop = null } = {}) {
  const dir = path.join(store.dirs.root, 'forge')
  const fileOf = id => {
    if (!ID.test(String(id))) throw httpError(400, msg`无效的 ID`)
    return id.startsWith(EDIT) ? path.join(dir, 'edits', `${id}.json`) : path.join(dir, `${id}.json`)
  }
  const avatarFile = id => fileOf(id).replace(/\.json$/, '.avatar')
  // id → { kind, step, controller, partial, startedAt } of the job in progress.
  const jobs = new Map()
  // Talk sessions a proposal is going into, or a new request is starting on (until its job is in `jobs`).
  const talkBusy = new Set()

  async function load(id) {
    // Asked before reading: a job that ends during the read (it saves its end,
    // then leaves `jobs`) can leave this read with the file from before its end.
    const runningBefore = jobs.has(id)
    let draft
    try {
      draft = JSON.parse(await readFile(fileOf(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, msg`这张草稿不存在了`)
      throw error
    }
    // A job recorded on disk but not running here: the server stopped in the middle of it.
    if (draft.job && !runningBefore && !jobs.has(id)) {
      draft.error = { kind: draft.job.kind, message: msg`上次还没写完服务就停了，再试一次。` }
      draft.job = null
    }
    return draft
  }

  async function save(draft) {
    draft.updatedAt = new Date().toISOString()
    const file = fileOf(draft.id)
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${newId()}.tmp`
    await writeFile(tmp, JSON.stringify(draft, null, 1), 'utf8')
    // Windows refuses to replace a file another request is reading at that moment
    // (the page polls the draft while a job saves it), and a virus scanner can
    // hold a fresh file for a while: try again for up to about 2.5 seconds.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file)
        return draft
      } catch (error) {
        if (attempt >= 15 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
          await rm(tmp, { force: true })
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * (attempt + 1), 250)))
      }
    }
  }

  // Changes to one draft happen one at a time (a job's results, the user's edits).
  const queues = new Map()
  function serial(id, fn) {
    const next = (queues.get(id) ?? Promise.resolve()).then(fn)
    queues.set(id, next.catch(() => {}))
    return next
  }

  /** Load, change and save a draft without another change slipping in between. */
  const mutate = (id, fn) =>
    serial(id, async () => {
      const draft = await load(id)
      const out = await fn(draft)
      await save(draft)
      return out ?? draft
    })

  /** The writing steps with where each stands, for the progress list. */
  function stepsView(draft, job) {
    if (!draft.plan || !draft.card) return []
    const steps = writeSteps(draft.plan, draft.card)
    const next = steps.find(s => !stepDone(s, draft.card))
    return steps.map(step => ({
      id: step.id,
      label: step.label,
      state: stepDone(step, draft.card) ? 'done' : job?.step === step.id ? 'running' : step === next && draft.error?.kind === 'write' ? 'failed' : 'waiting',
    }))
  }

  /** The draft as the page sees it: the running job's progress included, raw answers left out. */
  function view(draft) {
    const job = jobs.get(draft.id)
    const card = draft.card
    return {
      id: draft.id,
      title: draft.plan?.name || draft.brief.title || draft.rounds[0]?.user.text.slice(0, 20) || msg`未命名`,
      stage: draft.stage,
      model: draft.model,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      rounds: draft.rounds.map(round => ({
        user: round.user,
        assistant: round.assistant ? { reply: round.assistant.reply, questions: round.assistant.questions, model: round.assistant.model, at: round.assistant.at, unreadable: round.assistant.unreadable === true } : null,
      })),
      brief: draft.brief,
      plan: draft.plan,
      planModel: draft.planModel ?? null,
      card: card
        ? {
            entries: card.entries,
            greetings: card.greetings,
            description: card.description,
            creatorNotes: card.creatorNotes,
            checks: card.checks,
            issuesFound: card.issuesFound ?? null,
            avatar: card.avatar,
            savedCardId: card.savedCardId,
            savedAt: card.savedAt ?? null,
            writtenAt: card.writtenAt ?? null,
          }
        : null,
      writing: stepsView(draft, job),
      job: job ? { kind: job.kind, step: job.step, startedAt: job.startedAt, partial: job.kind === 'discuss' ? partialReply(job.partial) : '', chars: job.partial.length } : null,
      error: draft.error ?? null,
    }
  }

  function summary(draft) {
    const shown = view(draft)
    return { id: draft.id, title: shown.title, stage: draft.stage, rounds: draft.rounds.length, updatedAt: draft.updatedAt, busy: jobs.has(draft.id), savedCardId: draft.card?.savedCardId ?? null, avatar: Boolean(draft.card?.avatar) }
  }

  /** The provider model the draft talks to: its own pick, else the default model. */
  async function target(draft) {
    const ref = draft.model || (await store.getSettings()).model
    if (!isProviderRef(ref)) throw httpError(400, msg`先选一个模型：在「模型供应商」里添加供应商，再在这里或设置里选一个模型`)
    return { ...resolveRef(ref, await store.getProviders()), ref }
  }

  /**
   * Run a job in the background. `work(ctx)` gets:
   *   ctx.call(request): one model call (streamed into the job's progress, counted in usage);
   *   ctx.update(fn): change the draft on disk;
   *   ctx.step(id): which step it is at, for the page;
   *   ctx.signal, ctx.label (the model's name);
   *   ctx.languages: the guide's (the page's) and the card's (写作语言), see prompts.mjs.
   * A failure lands on the draft as its error, for the page to show.
   */
  async function run(draft, kind, work, { model = true } = {}) {
    if (jobs.has(draft.id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
    const chosen = model ? await target(draft) : null
    const label = chosen ? (refLabel(chosen.ref, await store.getProviders()) ?? chosen.ref) : ''
    const languages = forgeLanguages(currentLanguage(), (await store.getSettings()).language)
    const job = { kind, step: null, controller: new AbortController(), partial: '', startedAt: new Date().toISOString() }
    jobs.set(draft.id, job)
    draft.job = { kind, startedAt: job.startedAt }
    draft.error = null
    await serial(draft.id, () => save(draft))
    const ctx = {
      label,
      languages,
      signal: job.controller.signal,
      step: id => {
        job.step = id
      },
      async call(request) {
        job.partial = ''
        let result
        try {
          result = await complete(chosen.provider, chosen.modelId, { ...request, signal: job.controller.signal, onDelta: delta => (job.partial += delta) }, { proxy: proxyNow() })
        } catch (error) {
          if (job.controller.signal.aborted || error.status) throw error
          throw httpError(502, providerError(chosen.provider, error))
        }
        unrecorded.push(result)
        return result
      },
      async update(fn) {
        const fresh = await mutate(draft.id, fn)
        await flush()
        return fresh
      },
    }
    // Usage is recorded after the answer is in the draft, so it carries the draft's name.
    const unrecorded = []
    const flush = async () => {
      for (const result of unrecorded.splice(0)) await record(draft.id, result, chosen.ref).catch(() => {})
    }
    ;(async () => {
      let failure = null
      try {
        await work(ctx)
      } catch (error) {
        failure = job.controller.signal.aborted ? msg`已经停下了。` : error.message
      }
      // The job counts as running until its end is on disk: a draft read in
      // between would otherwise look like one cut off by a restart.
      try {
        await mutate(draft.id, fresh => {
          fresh.job = null
          if (failure) fresh.error = { kind, message: failure }
        }).catch(() => {})
        await flush()
      } finally {
        jobs.delete(draft.id)
      }
    })()
    return draft
  }

  /** A call's tokens in the usage panel, under the draft's name. */
  async function record(id, result, ref) {
    if (!ledger || !result?.usage) return
    const draft = await load(id)
    // An edit session's calls count under its card, or under the book or preset it changes.
    const chat = draft.kind && draft.kind !== 'card'
      ? { id: `forge-${id}`, title: SUBJECTS[draft.kind].title(draft.subjectName), cardId: null }
      : draft.cardId
        ? { id: `forge-${id}`, title: msg`修改：${draft.cardName}`, cardId: draft.cardId }
        : { id: `forge-${id}`, title: msg`创作：${draft.plan?.name || draft.brief.title || msg`未命名`}`, cardId: null }
    await ledger.recordTurn(chat, { model: ref, usage: result.usage, createdAt: new Date().toISOString() })
  }

  const cutNote = result => (result.truncated ? msg`（写到输出上限被截断了）` : result.stopReason && !/stop|end/i.test(result.stopReason) ? msg`（${result.stopReason}）` : '')

  // ─── Talk and plan ──────────────────────────────────────────────────────

  async function discussWork(ctx, draft) {
    const persona = await store.getPersona()
    const result = await ctx.call(discussRequest(draft.rounds, draft.brief, ctx.languages, { userName: persona.name }))
    await ctx.update(fresh => {
      const read = readDiscussion(result.text, fresh.brief)
      if (!read.reply && !read.questions.length) throw new Error(msg`${ctx.label} 这次没有回出能读的内容${cutNote(result)}，再试一次，或者换个模型`)
      fresh.rounds.at(-1).assistant = { raw: result.text, reply: read.reply, questions: read.questions, model: ctx.label, at: new Date().toISOString(), unreadable: !read.readable }
      fresh.brief = read.brief
    })
  }

  /**
   * @param language - the card's: 写作语言 for a new plan, the plan's own when revising.
   * @param names - { userName, said } for readPlan: the player's name as settled, and
   *   the words a revision answers (a new name counts only when they say it).
   */
  async function planWork(ctx, request, language, names = {}) {
    const result = await ctx.call(request)
    await ctx.update(fresh => {
      const plan = readPlan(result.text, { language, ...names })
      if (!plan) throw new Error(msg`${ctx.label} 写的方案读不出来${cutNote(result)}，再试一次，或者换个模型`)
      fresh.plan = plan
      fresh.planModel = ctx.label
      fresh.planPending = null
      fresh.stage = 'plan'
    })
  }

  /** What the user picked in a round, checked against that round's questions. */
  function cleanPicks(picks, questions) {
    if (!Array.isArray(picks)) return []
    const out = []
    for (const pick of picks) {
      const question = questions.find(q => q.id === pick?.id)
      if (!question || out.some(p => p.id === question.id)) continue
      const labels = (Array.isArray(pick.labels) ? pick.labels : []).filter(label => question.options.some(o => o.label === label))
      const custom = clip(pick.custom, 400)
      const delegate = pick.delegate === true
      if (!labels.length && !custom && !delegate) continue
      out.push({ id: question.id, title: question.title, labels: question.kind === 'multi' ? labels : labels.slice(0, 1), custom, delegate })
    }
    return out
  }

  // ─── Writing ────────────────────────────────────────────────────────────

  /** Write every step not done yet, in order; each result is saved as it comes. */
  async function writeWork(ctx, id) {
    const tries = new Map()
    for (;;) {
      const { plan, card } = await load(id)
      const step = writeSteps(plan, card).find(s => !stepDone(s, card))
      if (!step) {
        await ctx.update(fresh => {
          fresh.stage = 'polish'
          fresh.card.writtenAt = new Date().toISOString()
        })
        return
      }
      ctx.step(step.id)
      const attempt = (tries.get(step.id) ?? 0) + 1
      tries.set(step.id, attempt)
      if (attempt > STEP_TRIES) throw new Error(msg`「${step.label}」写了 ${STEP_TRIES} 次都没按格式写全，再试一次，或者换个模型`)
      if (step.names) await writeEntries(ctx, plan, card, step)
      else if (step.greetings) await writeGreetings(ctx, plan, card)
      else if (step.id === 'review') await review(ctx, plan, card)
      else if (step.id === 'fix') await fix(ctx, plan, card)
    }
  }

  async function writeEntries(ctx, plan, card, step) {
    const targets = card.entries.filter(e => step.names.includes(e.name) && !e.content)
    const written = card.entries.filter(e => e.content && e.type !== '状态')
    const result = await ctx.call(entriesRequest(plan, targets, written))
    const found = matchWritten(readTagged(result.text, 'entry'), targets.map(t => t.name))
    if (!found.size) throw new Error(msg`${ctx.label} 没有按格式写出「${step.label}」${cutNote(result)}，再试一次，或者换个模型`)
    await ctx.update(fresh => {
      for (const [name, text] of found) fresh.card.entries.find(e => e.name === name).content = userTagged(text, plan).slice(0, MAX_PIECE)
    })
  }

  async function writeGreetings(ctx, plan, card) {
    const targets = plan.greetings.map((g, index) => ({ ...g, index })).filter(g => !card.greetings[g.index]?.text)
    const written = card.entries.filter(e => e.content && (e.type === '世界观' || (e.type === '角色' && !e.rephrase && e.part !== 'catalog')))
    const initial = plan.tracking.enabled ? YAML.stringify(initialState(plan)).trim() : ''
    const result = await ctx.call(greetingsRequest(plan, targets, written, initial))
    const blocks = readTagged(result.text, 'greeting', 'index')
    const lone = targets.length === 1 && blocks.size === 1 ? [...blocks.values()][0] : null
    const found = targets.map(g => [g.index, blocks.get(String(g.index + 1)) ?? lone]).filter(([, text]) => text)
    if (!found.length) throw new Error(msg`${ctx.label} 没有按格式写出开场白${cutNote(result)}，再试一次，或者换个模型`)
    await ctx.update(fresh => {
      for (const [index, text] of found) fresh.card.greetings[index].text = userTagged(text, plan).slice(0, MAX_PIECE)
    })
  }

  async function review(ctx, plan, card) {
    const result = await ctx.call(reviewRequest(card, lintCard(card, plan.verbatim), planLanguage(plan)))
    const issues = readIssues(result.text)
    await ctx.update(fresh => {
      const left = applyIssues(fresh.card, issues)
      fresh.card.pending = Object.fromEntries(left)
      fresh.card.issuesFound = issues.length
      fresh.card.reviewed = true
    })
  }

  /** The pieces the review left for a rewrite, as rewriteRequest takes them. */
  function piecesOf(card, pending) {
    return Object.entries(pending ?? {})
      .map(([name, issues]) => {
        const greeting = /^开场白(\d+)$/.exec(name)
        if (greeting) {
          const index = Number(greeting[1]) - 1
          return card.greetings[index]?.text ? { greeting: true, index, name, text: card.greetings[index].text, issues } : null
        }
        const entry = card.entries.find(e => e.name === name)
        return entry?.content ? { name, text: entry.content, issues } : null
      })
      .filter(Boolean)
  }

  /** Apply rewritten pieces (entries and openings) from an answer; the plan names the player. */
  function applyPieces(card, pieces, text, plan) {
    const entries = readTagged(text, 'entry')
    const greetings = readTagged(text, 'greeting', 'index')
    let applied = 0
    const lone = pieces.length === 1 && entries.size + greetings.size === 1 ? [...entries.values(), ...greetings.values()][0] : null
    for (const piece of pieces) {
      const fresh = piece.greeting ? greetings.get(String(piece.index + 1)) : matchWritten(entries, [piece.name]).get(piece.name)
      const value = fresh ?? lone ? userTagged(fresh ?? lone, plan).slice(0, MAX_PIECE) : ''
      if (!value) continue
      if (piece.greeting) card.greetings[piece.index].text = value
      else card.entries.find(e => e.name === piece.name).content = value
      applied++
    }
    return applied
  }

  async function fix(ctx, plan, card) {
    const pieces = piecesOf(card, card.pending).slice(0, FIX_PIECES)
    const result = pieces.length ? await ctx.call(rewriteRequest(plan, card, pieces)) : null
    await ctx.update(fresh => {
      if (result) applyPieces(fresh.card, pieces, result.text, plan)
      fresh.card.pending = {}
      fresh.card.fixed = true
      fresh.card.checks = lintCard(fresh.card, plan.verbatim)
    })
  }

  // ─── Avatar and saving ──────────────────────────────────────────────────

  /** Who the avatar shows, and how they look, from the plan. */
  function avatarSubject(plan, description) {
    const c = plan.characters.find(x => x.name === plan.avatar.character) ?? plan.characters.find(x => x.kind === 'core') ?? plan.characters[0]
    const kind = /女/.test(c.gender) ? 'girl' : /男/.test(c.gender) ? 'boy' : 'other'
    return { name: c.name, kind, looks: c.looks_tags || c.appearance.join(', '), outfit: c.outfit_tags || c.outfit, scene: clip(description, 400) || plan.avatar.tags }
  }

  /** The plan's characters as the card's cast (角色名册), so 配图 knows their looks from the start. */
  function rosterOf(plan) {
    return plan.characters
      .filter(c => c.looks_tags)
      .map(c => ({ name: c.name, aliases: c.aliases.join('，'), kind: /女/.test(c.gender) ? 'girl' : /男/.test(c.gender) ? 'boy' : 'other', looks: c.looks_tags, outfit: c.outfit_tags }))
  }

  async function requireCard(id) {
    const draft = await load(id)
    if (!draft.card) throw httpError(409, msg`还没有写出这张卡`)
    return draft
  }

  async function startWrite(draft) {
    draft.stage = 'write'
    await run(draft, 'write', ctx => writeWork(ctx, draft.id))
    return view(draft)
  }

  async function startRewrite(draft, target, note) {
    const pieces = piecesOf(draft.card, { [target]: [{ type: '', original: '', suggestion: note }] }).map(p => ({ ...p, issues: null, note }))
    if (!pieces.length) throw httpError(400, msg`找不到要改的那一段，或者它还是空的`)
    draft.lastRewrite = { target, note }
    await run(draft, 'rewrite', async ctx => {
      ctx.step(target)
      const result = await ctx.call(rewriteRequest(draft.plan, draft.card, pieces))
      await ctx.update(fresh => {
        if (!applyPieces(fresh.card, pieces, result.text, fresh.plan)) throw new Error(msg`${ctx.label} 没有按格式写出改好的内容${cutNote(result)}，再试一次`)
        fresh.card.checks = lintCard(fresh.card, fresh.plan.verbatim)
        fresh.lastRewrite = null
      })
    })
    return view(draft)
  }

  async function startAvatar(draft, description, choice = {}) {
    if (!draw) throw httpError(400, msg`这里画不了图，上传一张吧`)
    const subject = avatarSubject(draft.plan, description)
    draft.lastAvatar = { description: clip(description, 400), choice }
    await run(
      draft,
      'avatar',
      async ctx => {
        ctx.step('avatar')
        const { buffer, backend } = await draw(subject, ctx.signal, choice)
        await writeFile(avatarFile(draft.id), buffer)
        await ctx.update(fresh => {
          fresh.card.avatar = { at: new Date().toISOString(), type: imageType(buffer), backend, source: 'drawn', description: subject.scene }
          fresh.lastAvatar = null
        })
      },
      { model: false },
    )
    return view(draft)
  }

  // ─── 对话修改 (edit.mjs, book-edit.mjs, preset-edit.mjs) ─────────────────

  /**
   * What a session changes. `load(id)` → { subject, name, own?, holder? } (a
   * card's own book is held by its card, which is what gets saved); `pick`: a
   * first look at a subject too long to send whole; `undo`: the last applied
   * proposal can be taken back; `context(value)`: what the page sends along
   * with a request, cleaned (the latest reply to try regex on, the colours on
   * screen); `finish(changes, context, signal)`: the changes once more after
   * they are read (a regex tried on the latest reply). `apply` may be async.
   */
  const SUBJECTS = {
    card: {
      prefix: EDIT,
      target: /^(field:[a-zA-Z]+|greeting:\d+|entry:[\w-]+)$/,
      title: name => msg`修改：${name}`,
      async load(id) {
        const card = await store.getCard(id)
        return { subject: card, name: card.name }
      },
      save: loaded => store.saveCard(loaded.subject),
      request: editRequest,
      read: readEdit,
      apply: applyChanges,
    },
    book: {
      prefix: `${EDIT}book-`,
      target: /^(entry:[\w-]+|book)$/,
      title: name => msg`修改世界书：${name}`,
      async load(id) {
        if (id.startsWith('card-')) {
          const card = await store.getCard(id.slice(5))
          return { subject: ensureBook(card), name: card.name, own: true, holder: card }
        }
        const book = await store.getBook(id)
        return { subject: book, name: book.name }
      },
      save: loaded => (loaded.holder ? store.saveCard(loaded.holder) : store.saveBook(loaded.subject)),
      restore(loaded, snapshot) {
        if (!loaded.holder) return { ...snapshot, id: loaded.subject.id }
        loaded.holder.book = snapshot
        return snapshot
      },
      tooLong: bookTooLong,
      pick: pickRequest,
      readPick: readPicked,
      request: bookEditRequest,
      read: readBookEdit,
      apply: applyBookChanges,
      undo: true,
    },
    preset: {
      prefix: `${EDIT}preset-`,
      target: /^prompt:[\s\S]{1,200}$/,
      title: name => msg`修改预设：${name}`,
      async load(id) {
        if (id === 'basic') throw httpError(400, msg`基础预设用选项调整，不能对话修改`)
        const preset = await store.getPreset(id)
        return { subject: preset, name: preset.name }
      },
      save: loaded => store.savePreset(loaded.subject),
      restore: (loaded, snapshot) => ({ ...snapshot, id: loaded.subject.id }),
      tooLong: presetTooLong,
      pick: presetPickRequest,
      readPick: readPickedPrompts,
      request: presetEditRequest,
      read: readPresetEdit,
      apply: applyPresetChanges,
      undo: true,
    },
    // The global scripts (global), a 正则集's (set-<id>), a card's (card-<id>) or a preset's (preset-<id>).
    regex: {
      prefix: `${EDIT}regex-`,
      target: /^regex:[\w-]{1,64}$/,
      title: name => msg`修改正则：${name}`,
      async load(id) {
        if (id === 'global') return { subject: { scripts: await store.getRegex() }, name: msg`全局` }
        if (id.startsWith('set-')) {
          const set = (await store.getRegexSets()).find(s => s.id === id.slice(4))
          if (!set) throw httpError(404, msg`正则集不存在`)
          return { subject: { scripts: set.scripts }, name: set.name, set: set.id }
        }
        if (id.startsWith('card-')) {
          const card = await store.getCard(id.slice(5))
          return { subject: { scripts: card.regexScripts ?? [] }, name: card.name, holder: card }
        }
        if (id.startsWith('preset-') && id.slice(7) !== BASIC_ID) {
          const preset = await store.getPreset(id.slice(7))
          return { subject: { scripts: preset.regexScripts ?? [] }, name: preset.name, holder: preset, preset: true }
        }
        throw httpError(404, msg`不认识的修改对象`)
      },
      async save(loaded) {
        loaded.subject.scripts = cleanScripts(loaded.subject.scripts)
        if (loaded.set) {
          const { scripts } = loaded.subject
          return store.updateRegexSets(sets => {
            if (!sets.some(s => s.id === loaded.set)) throw httpError(404, msg`正则集不存在`)
            return sets.map(s => (s.id === loaded.set ? { ...s, scripts } : s))
          })
        }
        if (!loaded.holder) return store.saveRegex(loaded.subject.scripts)
        loaded.holder.regexScripts = loaded.subject.scripts
        return loaded.preset ? store.savePreset(loaded.holder) : store.saveCard(loaded.holder)
      },
      restore: (loaded, snapshot) => snapshot,
      context: value => {
        if (typeof value?.sample !== 'string' || !value.sample.trim()) return null
        const names = value.names && typeof value.names === 'object' ? { char: clip(value.names.char, 100), user: clip(value.names.user, 100) } : null
        return { sample: value.sample.slice(-20000), ...(names ? { names } : {}) }
      },
      request: regexEditRequest,
      read: readRegexEdit,
      finish: tryChanges,
      apply: applyRegexChanges,
      undo: true,
    },
    // The page's look (settings.appearance): one, under the id appearance.
    theme: {
      prefix: `${EDIT}theme-`,
      target: /^$/,
      title: () => msg`修改主题`,
      async load(id) {
        if (id !== 'appearance') throw httpError(404, msg`不认识的修改对象`)
        return { subject: (await store.getSettings()).appearance, name: msg`主题` }
      },
      async save(loaded) {
        const { style, custom, backdrop } = loaded.subject
        const saved = await store.saveSettings({ appearance: { style, custom } }, { backdrop })
        loaded.subject = saved.appearance
        return saved
      },
      restore: (loaded, snapshot) => snapshot,
      context: cleanThemeContext,
      request: themeEditRequest,
      read: readThemeEdit,
      apply: themeApplier({
        drawBackdrop: (prompt, signal) => {
          if (!drawBackdrop) throw httpError(400, msg`这里不能画背景图`)
          return drawBackdrop(prompt, signal)
        },
        storeBackdrop: buffer => storeBackdrop(buffer),
      }),
      undo: true,
    },
  }

  function subjectOf(kind) {
    const spec = Object.hasOwn(SUBJECTS, kind) ? SUBJECTS[kind] : null
    if (!spec) throw httpError(404, msg`不认识的修改对象`)
    return spec
  }
  const talkId = (kind, id) => `${subjectOf(kind).prefix}${id}`
  // What a subject is as saved, to tell whether it changed after a proposal went in.
  const stamp = subject => createHash('sha1').update(JSON.stringify(subject)).digest('hex')

  /** The subject and its session; a new session (saved by its first job) when it has none. */
  async function loadTalk(kind, id) {
    const loaded = await subjectOf(kind).load(id)
    const session = await load(talkId(kind, id)).catch(error => {
      if (error.status !== 404) throw error
      const now = new Date().toISOString()
      return { id: talkId(kind, id), kind, subjectId: id, ...(kind === 'card' ? { cardId: id } : {}), createdAt: now, updatedAt: now, model: '', turns: [], job: null, error: null }
    })
    if (kind === 'card') session.cardName = loaded.name
    else session.subjectName = loaded.name
    return { session, loaded }
  }

  /** Change a session without another change slipping in between. */
  const mutateTalk = (kind, id, fn) =>
    serial(talkId(kind, id), async () => {
      const { session, loaded } = await loadTalk(kind, id)
      const out = await fn(session, loaded)
      await save(session)
      return out ?? session
    })

  /** The session as the page sees it: requests, replies with their changes, what became of them. */
  function talkView(session) {
    const job = jobs.get(session.id)
    const last = session.turns.at(-1)
    return {
      ...(session.cardId ? { cardId: session.cardId } : { kind: session.kind, subjectId: session.subjectId }),
      model: session.model,
      turns: session.turns.map(turn => ({
        user: { text: turn.user.text, target: turn.user.target, at: turn.user.at },
        assistant: turn.assistant ? { reply: turn.assistant.reply, changes: turn.assistant.changes, model: turn.assistant.model, at: turn.assistant.at } : null,
        outcome: turn.outcome ?? null,
      })),
      job: job ? { kind: job.kind, step: job.step, startedAt: job.startedAt, partial: partialReply(job.partial), chars: job.partial.length } : null,
      error: session.error ?? null,
      // The last proposal taken in can be taken back while it is the latest turn.
      undo: Boolean(session.undo && last?.outcome?.applied && session.undo.at === last.outcome.at),
      updatedAt: session.updatedAt,
    }
  }

  async function talkWork(ctx, kind, id) {
    const spec = subjectOf(kind)
    const { session, loaded } = await loadTalk(kind, id)
    const turn = session.turns.at(-1)
    const asked = { text: turn.user.text, target: turn.user.target, turns: session.turns.slice(0, -1), reply: ctx.languages.reply, own: loaded.own === true, name: loaded.name, context: turn.user.context ?? null }
    // A subject too long to send whole: a look at its contents first, for what to read.
    if (spec.pick && !turn.user.target && spec.tooLong(loaded.subject)) {
      ctx.step('pick')
      const looked = await ctx.call(spec.pick(loaded.subject, asked))
      asked.picked = spec.readPick(looked.text, loaded.subject)
    }
    ctx.step('edit')
    const { request, shown } = spec.request(loaded.subject, asked)
    const result = await ctx.call(request)
    const read = spec.read(result.text, loaded.subject, { shown, target: turn.user.target, own: loaded.own === true, context: asked.context })
    if (!read.reply && !read.changes.length) throw new Error(msg`${ctx.label} 这次没有回出能读的内容${cutNote(result)}，再试一次，或者换个模型`)
    if (spec.finish) {
      ctx.step('check')
      read.changes = await spec.finish(read.changes, asked.context, ctx.signal, loaded.subject)
      // Stopped while checking: no proposal, as a stop anywhere else.
      ctx.signal?.throwIfAborted()
    }
    await ctx.update(fresh => {
      fresh.turns.at(-1).assistant = { raw: result.text, reply: read.reply, changes: read.changes, model: ctx.label, at: new Date().toISOString() }
    })
  }

  return {
    busy: () => jobs.size > 0,

    async talkGet(kind, id) {
      return talkView((await loadTalk(kind, id)).session)
    },

    /**
     * What the user wants changed; `target` keeps it to one piece (a card's
     * field:description, greeting:0 or entry:3, a book's entry:3, a preset's
     * prompt:main). A proposal still waiting for an answer is set aside.
     */
    async talkAsk(kind, id, { text, target, context } = {}) {
      const spec = subjectOf(kind)
      const asked = clip(text, MAX_TEXT)
      if (!asked) throw httpError(400, msg`先写下想怎么改`)
      const key = talkId(kind, id)
      // Read after anything queued on the session (a proposal going in) is saved, and nothing else starts until the job does.
      const session = await serial(key, async () => {
        if (jobs.has(key)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
        if (talkBusy.has(key)) throw httpError(409, msg`正在采用上一次的修改，等它好了再发`)
        const { session } = await loadTalk(kind, id)
        talkBusy.add(key)
        return session
      })
      try {
        const now = new Date().toISOString()
        const last = session.turns.at(-1)
        if (last && !last.assistant) session.turns.pop()
        else if (last?.assistant?.changes.length && !last.outcome) last.outcome = { discarded: true, at: now }
        const sent = spec.context ? spec.context(context) : null
        session.turns.push({ user: { text: asked, target: spec.target.test(String(target ?? '')) ? target : '', at: now, ...(sent ? { context: sent } : {}) }, assistant: null, outcome: null })
        session.turns = session.turns.slice(-MAX_EDIT_TURNS)
        await run(session, 'edit', ctx => talkWork(ctx, kind, id))
      } finally {
        talkBusy.delete(key)
      }
      return talkView(session)
    },

    /** Ask the last request again (after a failure or a stop). */
    async talkRetry(kind, id) {
      const { session } = await loadTalk(kind, id)
      if (!session.turns.length || session.turns.at(-1).assistant) throw httpError(409, msg`没有要重试的`)
      await run(session, 'edit', ctx => talkWork(ctx, kind, id))
      return talkView(session)
    },

    /** The model the session talks to ('' = the default). */
    async talkUpdate(kind, id, { model } = {}) {
      return talkView(await mutateTalk(kind, id, session => {
        if (typeof model === 'string') session.model = clip(model, 200)
      }))
    },

    /**
     * Put the chosen changes (by id) of the waiting proposal into the subject.
     * Returns it as saved; a book or a preset keeps what it was before, to undo.
     */
    async talkApply(kind, id, { ids } = {}) {
      const spec = subjectOf(kind)
      const key = talkId(kind, id)
      if (jobs.has(key) || talkBusy.has(key)) throw httpError(409, msg`正在写，等它写完再改`)
      talkBusy.add(key)
      return mutateTalk(kind, id, async (session, loaded) => {
        const turn = session.turns.at(-1)
        const changes = turn?.assistant?.changes ?? []
        if (!changes.length || turn.outcome) throw httpError(409, msg`没有等着采用的修改`)
        const chosen = (Array.isArray(ids) ? ids : []).filter(change => changes.some(c => c.id === change))
        if (!chosen.length) throw httpError(400, msg`先勾选要采用的修改`)
        const before = spec.undo ? structuredClone(loaded.subject) : null
        const { applied, prefix } = await spec.apply(loaded.subject, changes, chosen)
        await spec.save(loaded)
        const at = new Date().toISOString()
        turn.outcome = { applied: chosen, at }
        session.undo = before ? { at, before, after: stamp(loaded.subject), prefix } : null
        return { session: talkView(session), subject: loaded.subject, holder: loaded.holder ?? null, applied, prefix }
      }).finally(() => talkBusy.delete(key))
    },

    /** Take the last applied proposal back, as long as nothing else changed the subject since. */
    async talkUndo(kind, id) {
      const spec = subjectOf(kind)
      if (!spec.undo) throw httpError(400, msg`这里不能撤销`)
      return mutateTalk(kind, id, async (session, loaded) => {
        const turn = session.turns.at(-1)
        const undo = session.undo
        if (!undo || !turn?.outcome?.applied || undo.at !== turn.outcome.at) throw httpError(409, msg`没有可以撤销的修改`)
        if (stamp(loaded.subject) !== undo.after) throw httpError(409, msg`采用之后又在别处改过，不能撤销了`)
        loaded.subject = spec.restore(loaded, undo.before)
        await spec.save(loaded)
        turn.outcome = { ...turn.outcome, undone: true }
        session.undo = null
        return { session: talkView(session), subject: loaded.subject, holder: loaded.holder ?? null, prefix: undo.prefix }
      })
    },

    /** Set the waiting proposal aside without changing anything. */
    async talkDiscard(kind, id) {
      return talkView(await mutateTalk(kind, id, session => {
        const turn = session.turns.at(-1)
        if (turn?.assistant && !turn.outcome) turn.outcome = { discarded: true, at: new Date().toISOString() }
      }))
    },

    /** Start over: the session's talk is forgotten (the subject keeps what was applied). */
    async talkClear(kind, id) {
      jobs.get(talkId(kind, id))?.controller.abort()
      await rm(fileOf(talkId(kind, id)), { force: true })
      return talkView((await loadTalk(kind, id)).session)
    },

    talkStop(kind, id) {
      const job = jobs.get(talkId(kind, id))
      job?.controller.abort()
      return { stopped: Boolean(job) }
    },

    /** A deleted card's, book's or preset's session goes with it. */
    async dropTalk(kind, id) {
      jobs.get(talkId(kind, id))?.controller.abort()
      await rm(fileOf(talkId(kind, id)), { force: true })
    },

    async list() {
      let names
      try {
        names = await readdir(dir)
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const drafts = []
      for (const name of names.filter(n => n.endsWith('.json'))) {
        const draft = await load(name.slice(0, -5)).catch(() => null)
        if (draft) drafts.push(summary(draft))
      }
      return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async get(id) {
      return view(await load(id))
    },

    /** A new draft from the first idea; the first round starts right away. */
    async create({ text, model } = {}) {
      const idea = clip(text, MAX_TEXT)
      if (!idea) throw httpError(400, msg`先说说你想要一张什么样的卡，一句话也行`)
      const now = new Date().toISOString()
      const draft = { id: newId(), createdAt: now, updatedAt: now, stage: 'discuss', model: clip(model, 200), rounds: [{ user: { text: idea, picks: [], at: now }, assistant: null }], brief: emptyBrief(), plan: null, card: null, job: null, error: null }
      await save(draft)
      await run(draft, 'discuss', ctx => discussWork(ctx, draft))
      return view(draft)
    },

    /** The user's answer to the last round: picks and/or words; the next round starts. */
    async say(id, { text, picks } = {}) {
      const draft = await load(id)
      const last = draft.rounds.at(-1)
      if (!last?.assistant) throw httpError(409, msg`上一轮还没有回复，等它写完，或者点「重试」`)
      if (draft.rounds.length >= MAX_ROUNDS) throw httpError(400, msg`已经聊了很多轮了，先出方案吧`)
      const user = { text: clip(text, MAX_TEXT), picks: cleanPicks(picks, last.assistant.questions), at: new Date().toISOString() }
      if (!user.text && !user.picks.length) throw httpError(400, msg`先选一个，或者说说你的想法`)
      draft.rounds.push({ user, assistant: null })
      draft.stage = 'discuss'
      await run(draft, 'discuss', ctx => discussWork(ctx, draft))
      return view(draft)
    },

    /** Do the failed (or interrupted) job again; in talk, a round can also be asked again for other questions. */
    async retry(id) {
      const draft = await load(id)
      const kind = draft.error?.kind ?? (draft.stage === 'plan' ? 'plan' : 'discuss')
      if (kind === 'plan') return draft.planPending ? this.revise(id, draft.planPending) : this.plan(id)
      if (kind === 'write') return startWrite(draft)
      if (kind === 'rewrite' && draft.lastRewrite) return startRewrite(draft, draft.lastRewrite.target, draft.lastRewrite.note)
      if (kind === 'avatar') return startAvatar(draft, draft.lastAvatar?.description, draft.lastAvatar?.choice)
      const last = draft.rounds.at(-1)
      if (last.assistant) last.assistant = null
      await run(draft, 'discuss', ctx => discussWork(ctx, draft))
      return view(draft)
    },

    /** Take back the last exchange: the user's answer and the reply to it. */
    async undo(id) {
      if (jobs.has(id)) throw httpError(409, msg`正在写，先停下再撤回`)
      const draft = await mutate(id, draft => {
        if (draft.rounds.length < 2) throw httpError(400, msg`这是第一轮，没有可以撤回的了`)
        draft.rounds.pop()
        draft.stage = 'discuss'
        draft.error = null
      })
      return view(draft)
    },

    /** The user's edits: the model to use, the sketch (values, locks, title), the stage to look at. */
    async update(id, { model, brief, stage, tracking, userName } = {}) {
      if (((tracking && typeof tracking === 'object') || typeof userName === 'string') && jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      const draft = await mutate(id, draft => {
        if (typeof model === 'string') draft.model = clip(model, 200)
        if (brief && typeof brief === 'object') draft.brief = editBrief(draft.brief, brief)
        // The plan's status bar editor: variables edited by hand, no model call. A card
        // already written gets its state entries again from them.
        if (tracking && typeof tracking === 'object') {
          if (!draft.plan) throw httpError(409, msg`还没有方案`)
          draft.plan = editTracking(draft.plan, tracking)
          if (draft.card) draft.card = retrack(draft.card, draft.plan)
        }
        // The player's name, set by hand in the plan ('' = the one in settings). The card
        // says <user> throughout, so a written card needs nothing more.
        if (typeof userName === 'string') {
          if (!draft.plan) throw httpError(409, msg`还没有方案`)
          draft.plan = editUserName(draft.plan, userName)
        }
        // Going back keeps what is ahead: the plan stays while talking, the card while planning.
        const reachable = { discuss: true, plan: Boolean(draft.plan), write: Boolean(draft.card), polish: Boolean(draft.card?.writtenAt) }
        if (STAGES.includes(stage) && reachable[stage]) draft.stage = stage
      })
      return view(draft)
    },

    /** Write the talk up as a plan. */
    async plan(id) {
      const draft = await load(id)
      if (!draft.rounds.some(r => r.assistant)) throw httpError(409, msg`先聊一轮再出方案`)
      // The last answer may still be waiting for a reply: plan from what was said.
      const rounds = draft.rounds.filter(r => r.assistant || r === draft.rounds.at(-1))
      draft.planPending = null
      await run(draft, 'plan', ctx => planWork(ctx, planRequest(rounds, draft.brief, ctx.languages), ctx.languages.card, { userName: chosenUserName(draft.brief) }))
      return view(draft)
    },

    /** Revise the plan by the user's comments (per section and overall). */
    async revise(id, { text, notes } = {}) {
      const draft = await load(id)
      if (!draft.plan) throw httpError(409, msg`还没有方案`)
      const cleanNotes = (Array.isArray(notes) ? notes : []).map(n => ({ section: clip(n?.section, 40), text: clip(n?.text, 1000) })).filter(n => n.section && n.text)
      const general = clip(text, MAX_TEXT)
      if (!general && !cleanNotes.length) throw httpError(400, msg`先写下想怎么改`)
      draft.planNotes = [...(draft.planNotes ?? []), { at: new Date().toISOString(), text: general, notes: cleanNotes }].slice(-20)
      draft.planPending = { text: general, notes: cleanNotes }
      const names = { userName: draft.plan.user_role.name ?? '', said: [general, ...cleanNotes.map(n => n.text)].join('\n') }
      await run(draft, 'plan', ctx => planWork(ctx, reviseRequest(draft.rounds.filter(r => r.assistant), draft.plan, { text: general, notes: cleanNotes }), planLanguage(draft.plan), names))
      return view(draft)
    },

    /**
     * Write the card from the plan. Carries on from where a stopped or failed run
     * was; `restart` writes it all again from the current plan (edits are lost).
     */
    async write(id, { restart = false } = {}) {
      const draft = await load(id)
      if (!draft.plan) throw httpError(409, msg`先出方案`)
      if (!draft.card || restart) {
        const avatar = draft.card?.avatar ?? null
        const savedCardId = draft.card?.savedCardId ?? null
        draft.card = { ...newCard(draft.plan), avatar, savedCardId }
      } else {
        // The plan may have been revised since the card was started: what is written stays, the rest follows the plan.
        draft.card = alignCard(draft.card, draft.plan)
      }
      return startWrite(draft)
    },

    /** Rewrite one entry (by name) or opening ("开场白2") by the user's note. */
    async rewrite(id, { target, note } = {}) {
      const draft = await requireCard(id)
      const asked = clip(note, 1000)
      if (!asked) throw httpError(400, msg`先写下想怎么改`)
      return startRewrite(draft, clip(target, 60), asked)
    },

    /** The user's own edits to the written card. */
    async editCard(id, { entries, greetings, description, creatorNotes } = {}) {
      await requireCard(id)
      if (jobs.has(id)) throw httpError(409, msg`正在写，等它写完再改`)
      const draft = await mutate(id, draft => {
      const card = draft.card
      for (const edit of Array.isArray(entries) ? entries : []) {
        const entry = card.entries.find(e => e.name === edit?.name)
        if (entry && typeof edit.content === 'string') entry.content = edit.content.slice(0, MAX_PIECE)
      }
      if (Array.isArray(greetings)) greetings.forEach((text, i) => typeof text === 'string' && card.greetings[i] && (card.greetings[i].text = text.slice(0, MAX_PIECE)))
      if (typeof description === 'string') card.description = description.slice(0, 2000)
      if (typeof creatorNotes === 'string') card.creatorNotes = creatorNotes.slice(0, 4000)
      card.checks = lintCard(card, draft.plan.verbatim)
      })
      return view(draft)
    },

    /**
     * Draw the avatar with the image backend set up in 配图, or `backend` and `model`
     * picked for this one; `description` overrides the scene.
     */
    async drawAvatar(id, { description, backend, model } = {}) {
      return startAvatar(await requireCard(id), description, drawChoiceOf({ backend, model }))
    },

    /** Use the user's own picture as the avatar. */
    async uploadAvatar(id, { image } = {}) {
      const draft = await requireCard(id)
      const match = IMAGE.exec(String(image ?? ''))
      if (!match) throw httpError(400, msg`只能用 PNG、JPEG 或 WebP 图片`)
      const buffer = Buffer.from(match[2], 'base64')
      if (buffer.length > MAX_IMAGE) throw httpError(400, msg`图片太大了（15 MB 以内）`)
      await writeFile(avatarFile(id), buffer)
      const saved = await mutate(id, fresh => {
        fresh.card.avatar = { at: new Date().toISOString(), type: imageType(buffer), backend: '', source: 'upload', description: '' }
        if (fresh.error?.kind === 'avatar') fresh.error = null
      })
      return view(saved)
    },

    async readAvatar(id) {
      const draft = await requireCard(id)
      if (!draft.card.avatar) throw httpError(404, msg`还没有头像`)
      return { buffer: await readFile(avatarFile(id)), type: `image/${draft.card.avatar.type}` }
    },

    /**
     * Save as a card: the page sends the avatar as PNG (drawn, uploaded or a name
     * card it made), the card goes into it as SillyTavern does. Saving again
     * updates the same card in place; its chats and settings stay.
     */
    async saveCard(id, { avatar } = {}) {
      const draft = await requireCard(id)
      if (jobs.has(id)) throw httpError(409, msg`正在写，等它写完再保存`)
      if (!draft.card.greetings.some(g => g.text)) throw httpError(409, msg`开场白还没写`)
      const match = IMAGE.exec(String(avatar ?? ''))
      if (!match || match[1] !== 'png') throw httpError(400, msg`头像要转成 PNG 再保存`)
      const raw = cardJson(draft.plan, draft.card)
      const png = writeCardPng(Buffer.from(match[2], 'base64'), raw)
      const card = normalizeCard(raw)
      const old = draft.card.savedCardId ? await store.getCard(draft.card.savedCardId).catch(() => null) : null
      if (old) Object.assign(card, { id: old.id, media: old.media, worldbookIds: old.worldbookIds ?? [], importedAt: old.importedAt, group: old.group ?? '', archived: old.archived === true })
      else card.media = cleanCardMedia({ roster: rosterOf(draft.plan) })
      card.hasAvatar = true
      await store.saveCard(card, png)
      const saved = await mutate(id, fresh => {
        fresh.card.savedCardId = card.id
        fresh.card.savedAt = new Date().toISOString()
      })
      return { card: cardSummary(card), updated: Boolean(old), draft: view(saved) }
    },

    stop(id) {
      const job = jobs.get(id)
      job?.controller.abort()
      return { stopped: Boolean(job) }
    },

    async remove(id) {
      jobs.get(id)?.controller.abort()
      await rm(fileOf(id), { force: true })
      await rm(avatarFile(id), { force: true })
      return { ok: true }
    },
  }
}
