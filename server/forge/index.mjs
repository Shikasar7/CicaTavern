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
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { cardSummary, normalizeCard, pictureMark, rulebookOf, writeCardPng } from '../cards.mjs'
import { madeAt } from '../draw-history.mjs'
import { helperSummary } from '../helper-scripts.mjs'
import { cleanCardMedia, drawChoiceOf } from '../media.mjs'
import { complete, isProviderRef, providerError, refLabel, resolveRef } from '../providers.mjs'
import { estimateTokens } from '../context.mjs'
import { estimateCost } from '../models.mjs'
import { httpError, newId } from '../store.mjs'
import { renderTemplate } from '../template.mjs'
import { PLAN_ANGLES, chosenUserGender, chosenUserName, cleanCardOptions, cleanGreetingCount, discussRequest, editBrief, editTracking, editUserGender, editUserName, emptyBrief, englishCard, forgeLanguages, ideaSeeds, ideasRequest, partialReply, planLanguage, planRequest, readDiscussion, readIdeas, readPlan, reviseRequest, withCardOptions } from './prompts.mjs'
import { brickCost } from './bricks.mjs'
import { alignCard, applyIssues, cardJson, entriesRequest, greetingsRequest, initialState, lintCard, matchWritten, newCard, previewDynamics, readIssues, readTagged, redescribe, retrack, reviewRequest, rewriteRequest, stepDone, userTagged, writeSteps } from './write.mjs'
import { STATUS_TARGET, applyChanges, editRequest, ensureBook, readEdit } from './edit.mjs'
import { claimsChanges, missingNote } from './blocks.mjs'
import { applyBookChanges, bookEditRequest, bookTooLong, pickRequest, readBookEdit, readPicked } from './book-edit.mjs'
import { applyPresetChanges, presetEditRequest, presetPickRequest, presetTooLong, readPickedPrompts, readPresetEdit } from './preset-edit.mjs'
import { applyRegexChanges, readRegexEdit, regexEditRequest, tryChanges } from './regex-edit.mjs'
import { cleanThemeContext, readThemeEdit, themeApplier, themeEditRequest } from './theme-edit.mjs'
import { createCheck, helpersOf } from './check-session.mjs'
import { applyStatusChange } from './check-apply.mjs'
import { drawsOwnBar, startingState } from './check.mjs'
import { createTrial, trialSessionId } from './trial.mjs'
import { cleanScripts } from '../regex.mjs'
import { isBuiltinPreset } from '../../web/shared/basic.js'
import { currentLanguage, msg } from '../i18n.mjs'
import { chatReference, creditsOf, keptMaterial, readMaterial, readReference, referenceView, studying, withMode, withReference } from './references.mjs'
import { structureText } from './structure.mjs'

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
const sum = (list, key) => list.reduce((total, item) => total + (item[key] ?? 0), 0)
/** A draft's picks about the card (a draft from before them: its card type, mapped). */
const optionsOf = draft => cleanCardOptions(draft.options, draft.cardType)
/** What a save writes from a draft, to tell the page the draft changed after it (试玩体检 plays the saved card). */
const savedStamp = draft => createHash('sha1').update(JSON.stringify([draft.plan, draft.card.entries, draft.card.greetings, draft.card.description, draft.card.creatorNotes, draft.card.avatar?.at ?? null])).digest('hex').slice(0, 16)
// What of the saved card a save writes over from the draft (配图, worldbooks, group stay): changed here since the
// last save means it was edited elsewhere (修改角色卡, 检查这张卡), and saving again would undo that. The picture
// is too, and is marked apart (savedPicture, pictureMark).
const WRITTEN = ['name', 'description', 'personality', 'scenario', 'firstMes', 'alternateGreetings', 'mesExample', 'systemPrompt', 'postHistoryInstructions', 'creatorNotes', 'creator', 'tags', 'book', 'regexScripts', 'depthPrompt', 'mvuSchema', 'statusBar', 'userName']
const writtenMark = card => createHash('sha1').update(JSON.stringify(WRITTEN.map(key => card[key] ?? null))).digest('hex').slice(0, 16)

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
 * @param writeChatState - (chatId, [{ path, value }]) → { chat, lost }: variables a proposal puts into a chat it read;
 *   `lost`, the ones the card's variable rules will not keep.
 * @param history - createDrawHistory() (抽图历史): where a saved card's picture goes when 更新这张卡 replaces one set elsewhere;
 *   its keep() is also how many old avatars a draft keeps.
 */
export function createForge(store, { proxyNow = () => null, ledger = null, engine = null, draw = null, drawBackdrop = null, storeBackdrop = null, rulebooks = null, writeChatState = null, history = null } = {}) {
  const dir = path.join(store.dirs.root, 'forge')
  const fileOf = id => {
    if (!ID.test(String(id))) throw httpError(400, msg`无效的 ID`)
    return id.startsWith(EDIT) ? path.join(dir, 'edits', `${id}.json`) : path.join(dir, `${id}.json`)
  }
  const avatarFile = id => fileOf(id).replace(/\.json$/, '.avatar')
  // 抽图历史: a draft's avatars before the one it has, the pictures in <id>.history/,
  // the list newest first in draft.card.avatarHistory ({ file, at, backend, source, description }).
  const keptDir = id => fileOf(id).replace(/\.json$/, '.history')
  const KEPT_FILE = /^avatar-[\w-]{1,40}\.(png|jpeg|webp)$/
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
      // Written by a model picked for a retry, not the draft's own.
      by: stepDone(step, draft.card) ? draft.card.stepModels?.[step.id] ?? null : null,
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
      references: (draft.references ?? []).map(referenceView),
      cardType: draft.cardType ?? '',
      // The picks made before talking (cast, world, gender, play, format, status bar look).
      options: optionsOf(draft),
      greetingCount: draft.greetingCount ?? 0,
      plan: draft.plan,
      // 玩法积木: what they add, for the plan page to say.
      brickCost: draft.plan?.bricks?.length ? brickCost(draft.plan, englishCard(planLanguage(draft.plan))) : null,
      planModel: draft.planModel ?? null,
      // 出三版来挑: what tells the versions apart, for the page to pick one (draft.plan is the one picked).
      planOptions: (draft.planOptions ?? []).map((option, i) => ({
        angle: option.angle,
        picked: i === draft.planPick,
        name: option.plan.name,
        summary: option.plan.summary,
        cast: option.plan.characters.filter(c => c.kind === 'core').map(c => c.name),
        greetings: option.plan.greetings.map(g => g.title),
      })),
      planMissing: draft.planMissing ?? [],
      card: card
        ? {
            entries: card.entries,
            greetings: card.greetings,
            description: card.description,
            creatorNotes: card.creatorNotes,
            checks: card.checks,
            issuesFound: card.issuesFound ?? null,
            avatar: card.avatar,
            avatarHistory: card.avatarHistory ?? [],
            savedCardId: card.savedCardId,
            savedAt: card.savedAt ?? null,
            // A draft saved before the stamp was kept: not known, so not said.
            changedSinceSave: Boolean(card.savedCardId && card.savedStamp) && card.savedStamp !== savedStamp(draft),
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
    return { id: draft.id, title: shown.title, stage: draft.stage, rounds: draft.rounds.length, updatedAt: draft.updatedAt, busy: jobs.has(draft.id), job: shown.job ? { kind: shown.job.kind, step: shown.job.step, startedAt: shown.job.startedAt, chars: shown.job.chars } : null, progress: progressOf(shown), error: Boolean(draft.error), savedCardId: draft.card?.savedCardId ?? null, avatar: Boolean(draft.card?.avatar) }
  }

  /**
   * How far a running job is, for the page's bars and the chip outside the dialog: writing by its
   * steps (the one running counted half), a plan by what is written of a usual one (about 8000
   * characters), talk unknown (null). { done, total, label }.
   */
  function progressOf(shown) {
    if (!shown.job) return null
    if (shown.job.kind === 'write' && shown.writing?.length) {
      const done = shown.writing.filter(step => step.state === 'done').length
      const running = shown.writing.find(step => step.state === 'running')
      return { done: done + (running ? 0.5 : 0), total: shown.writing.length, label: running?.label ?? '' }
    }
    if (shown.job.kind === 'plan') return { done: Math.min(0.95, (shown.job.chars ?? 0) / 8000), total: 1, label: '' }
    return null
  }

  /** The provider model the draft talks to: its own pick, else the default model; `other`, one picked for a retry instead. */
  async function target(draft, other = '') {
    const ref = other || draft.model || (await store.getSettings()).model
    if (!isProviderRef(ref)) throw httpError(400, msg`先选一个模型：在「模型供应商」里添加供应商，再在这里或设置里选一个模型`)
    const providers = await store.getProviders()
    return { ...resolveRef(ref, providers), ref, label: refLabel(ref, providers) ?? ref }
  }

  /** Tokens a request comes to, roughly, before it is sent. */
  const requestTokens = request => estimateTokens(`${request.system ?? ''}${(request.messages ?? []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('')}`)

  /**
   * Run a job in the background. `work(ctx)` gets:
   *   ctx.call(request): one model call (streamed into the job's progress, counted in usage);
   *   ctx.update(fn): change the draft on disk;
   *   ctx.step(id): which step it is at, for the page;
   *   ctx.signal, ctx.label (the model's name);
   *   ctx.languages: the guide's (the page's) and the card's (写作语言), see prompts.mjs.
   * A failure lands on the draft as its error, for the page to show, with the model that failed and what the
   * step's calls came to (to price a retry with another model).
   * `other`: a model picked for this retry only. It writes the step the job starts at; when the job moves on
   * to the next step the draft's own model takes over, so the retry costs what the page said it would.
   */
  async function run(draft, kind, work, { model = true, other = '' } = {}) {
    if (jobs.has(draft.id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
    const swapped = model && other ? await target(draft, other) : null
    let chosen = model && !swapped ? await target(draft) : swapped
    let first = null
    const languages = forgeLanguages(currentLanguage(), (await store.getSettings()).language)
    const job = { kind, step: null, controller: new AbortController(), partial: '', startedAt: new Date().toISOString(), sizes: [] }
    jobs.set(draft.id, job)
    draft.job = { kind, startedAt: job.startedAt }
    draft.error = null
    await serial(draft.id, () => save(draft))
    const ctx = {
      get label() {
        return chosen?.label ?? ''
      },
      languages,
      signal: job.controller.signal,
      step: id => {
        if (swapped && first === null) first = id
        else if (swapped && id !== first && chosen === swapped) chosen = null
        if (id !== job.step) job.sizes = []
        job.step = id
      },
      async call(request) {
        chosen ??= await target(draft)
        const used = chosen
        job.partial = ''
        // What this call comes to: the provider's count once it answers, the request and its output cap till then.
        const size = { input: requestTokens(request), output: request.maxTokens ?? 0, measured: false }
        job.sizes.push(size)
        let result
        try {
          result = await complete(used.provider, used.modelId, { ...request, signal: job.controller.signal, onDelta: delta => (job.partial += delta), onRestart: () => (job.partial = '') }, { proxy: proxyNow() })
        } catch (error) {
          if (job.controller.signal.aborted || error.status) throw error
          throw httpError(502, providerError(used.provider, error))
        }
        if (result.usage) Object.assign(size, { input: (result.usage.input ?? 0) + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0) || size.input, output: result.usage.output ?? size.output, measured: true })
        unrecorded.push({ result, ref: used.ref })
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
      for (const { result, ref } of unrecorded.splice(0)) await record(draft.id, result, ref).catch(() => {})
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
          if (failure) {
            fresh.error = { kind, message: failure }
            if (model) {
              fresh.error.model = chosen?.ref ?? ''
              if (job.sizes.length) fresh.error.size = { input: sum(job.sizes, 'input'), output: sum(job.sizes, 'output'), measured: job.sizes.every(s => s.measured) }
            }
          }
          // A writing step done by the other model: the page says which model wrote it.
          if (swapped && kind === 'write' && first && fresh.plan && fresh.card) {
            const step = writeSteps(fresh.plan, fresh.card).find(s => s.id === first)
            if (step && stepDone(step, fresh.card)) fresh.card.stepModels = { ...fresh.card.stepModels, [first]: swapped.label }
          }
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

  /** Every card whose content has been in use on this draft, whether or not it is still attached. */
  const mergedCredits = draft => {
    const seen = new Set()
    return [...(draft.credits ?? []), ...creditsOf(draft.references)].filter(item => !seen.has(item.title) && seen.add(item.title))
  }
  const creditsFor = draft => mergedCredits(draft)

  async function discussWork(ctx, draft) {
    const persona = await store.getPersona()
    const result = await ctx.call(discussRequest(draft.rounds, draft.brief, ctx.languages, { userName: persona.name, options: optionsOf(draft), references: draft.references }))
    await ctx.update(fresh => {
      const read = readDiscussion(result.text, fresh.brief)
      if (!read.reply && !read.questions.length) throw new Error(msg`${ctx.label} 这次没有回出能读的内容${cutNote(result)}，再试一次，或者换个模型`)
      fresh.rounds.at(-1).assistant = { raw: result.text, reply: read.reply, questions: read.questions, model: ctx.label, at: new Date().toISOString(), unreadable: !read.readable }
      const briefBefore = fresh.brief
      fresh.brief = read.brief
      followGender(fresh, briefBefore)
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
      const plan = withCardOptions(readPlan(result.text, { language, ...names, scale: optionsOf(fresh).scale }), optionsOf(fresh))
      if (!plan) throw new Error(msg`${ctx.label} 写的方案读不出来${cutNote(result)}，再试一次，或者换个模型`)
      fresh.plan = plan
      fresh.planModel = ctx.label
      fresh.planPending = null
      fresh.planOptions = null
      fresh.planMissing = null
      fresh.planPick = 0
      fresh.stage = 'plan'
    })
  }

  /**
   * 出三版来挑: the plan written three times at once, each from its own angle
   * (PLAN_ANGLES). The versions that could be read are kept; the first is picked.
   */
  /** @param only - the angles to write again (the versions that did not come), added to those there. */
  async function planOptionsWork(ctx, rounds, brief, options, names, only = null) {
    const all = Object.keys(PLAN_ANGLES)
    const angles = only ? all.filter(angle => only.includes(angle)) : all
    const attempt = angle => ctx.call(planRequest(rounds, brief, ctx.languages, { ...options, angle })).then(
      result => withCardOptions(readPlan(result.text, { language: ctx.languages.card, ...names, scale: options.options.scale }), options.options) ?? new Error(msg`${ctx.label} 写的方案读不出来，再试一次，或者换个模型`),
      error => (error instanceof Error ? error : new Error(String(error))),
    )
    const results = await Promise.all(angles.map(attempt))
    // A version that failed is asked once more on its own: a provider busy with three calls at once often turns one away.
    for (const [i, result] of results.entries()) {
      if (result instanceof Error && !ctx.signal.aborted) results[i] = await attempt(angles[i])
    }
    if (ctx.signal.aborted) throw new Error(msg`已经停下了。`)
    const read = results.map((plan, i) => ({ angle: angles[i], plan })).filter(option => !(option.plan instanceof Error))
    const failed = results.map((result, i) => ({ angle: angles[i], error: result instanceof Error ? clip(result.message, 300) : '' })).filter(f => f.error)
    if (!read.length) throw results[0]
    await ctx.update(fresh => {
      // The versions that did not come: the page says which and why.
      fresh.planMissing = failed
      if (only && fresh.planOptions?.length) {
        const picked = fresh.planOptions[fresh.planPick]
        fresh.planOptions = [...fresh.planOptions, ...read].sort((a, b) => all.indexOf(a.angle) - all.indexOf(b.angle))
        fresh.planPick = Math.max(0, fresh.planOptions.indexOf(picked))
        return
      }
      fresh.planOptions = read
      fresh.planPick = 0
      fresh.plan = read[0].plan
      fresh.planModel = ctx.label
      fresh.planPending = null
      fresh.stage = 'plan'
    })
  }

  /** The draft's plan changed by hand: the version it was picked from follows, so going back to it keeps the change. */
  function keepPick(draft) {
    if (draft.planOptions?.[draft.planPick]) draft.planOptions[draft.planPick].plan = draft.plan
  }

  /**
   * 你的性别 is one value for the talk, the plan and the card. Said in the talk (the sketch's user_gender, when
   * that changed), the picks take it; the plan follows the picks (unless `plan` is false: a step is writing from
   * it), and a written card's description, built in code and rewritten nowhere else, follows the plan.
   */
  function followGender(draft, briefBefore, plan = true) {
    const said = chosenUserGender(draft.brief)
    if (said !== null && said !== chosenUserGender(briefBefore)) draft.options = cleanCardOptions({ ...optionsOf(draft), userGender: said })
    const gender = optionsOf(draft).userGender ?? ''
    if (!plan || !draft.plan || (draft.plan.user_role.gender ?? '') === gender) return
    const before = draft.plan
    draft.plan = editUserGender(draft.plan, gender)
    keepPick(draft)
    if (draft.card) draft.card = redescribe(draft.card, before, draft.plan)
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
      const { plan, card, references } = await load(id)
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
      if (step.names) await writeEntries(ctx, plan, card, step, references)
      else if (step.greetings) await writeGreetings(ctx, plan, card, references)
      else if (step.id === 'review') await review(ctx, plan, card)
      else if (step.id === 'fix') await fix(ctx, plan, card, references)
    }
  }

  async function writeEntries(ctx, plan, card, step, references) {
    const targets = card.entries.filter(e => step.names.includes(e.name) && !e.content)
    const written = card.entries.filter(e => e.content && e.type !== '状态')
    const result = await ctx.call(entriesRequest(plan, targets, written, references))
    const found = matchWritten(readTagged(result.text, 'entry'), targets.map(t => t.name))
    if (!found.size) throw new Error(msg`${ctx.label} 没有按格式写出「${step.label}」${cutNote(result)}，再试一次，或者换个模型`)
    await ctx.update(fresh => {
      for (const [name, text] of found) fresh.card.entries.find(e => e.name === name).content = userTagged(text, plan).slice(0, MAX_PIECE)
    })
  }

  async function writeGreetings(ctx, plan, card, references) {
    const targets = plan.greetings.map((g, index) => ({ ...g, index })).filter(g => !card.greetings[g.index]?.text)
    const written = card.entries.filter(e => e.content && (e.type === '世界观' || (e.type === '角色' && !e.rephrase && e.part !== 'catalog')))
    const initial = plan.tracking.enabled ? YAML.stringify(initialState(plan)).trim() : ''
    const result = await ctx.call(greetingsRequest(plan, targets, written, initial, references))
    const blocks = readTagged(result.text, 'greeting', 'index')
    const lone = targets.length === 1 && blocks.size === 1 ? [...blocks.values()][0] : null
    const found = targets.map(g => [g.index, blocks.get(String(g.index + 1)) ?? lone]).filter(([, text]) => text)
    if (!found.length) throw new Error(msg`${ctx.label} 没有按格式写出开场白${cutNote(result)}，再试一次，或者换个模型`)
    await ctx.update(fresh => {
      for (const [index, text] of found) fresh.card.greetings[index].text = userTagged(text, plan).slice(0, MAX_PIECE)
    })
  }

  async function review(ctx, plan, card) {
    const result = await ctx.call(reviewRequest(card, lintCard(card, plan.verbatim), planLanguage(plan), plan))
    const issues = readIssues(result.text)
    await ctx.update(fresh => {
      const left = applyIssues(fresh.card, issues, planLanguage(plan))
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

  async function fix(ctx, plan, card, references) {
    const pieces = piecesOf(card, card.pending).slice(0, FIX_PIECES)
    const result = pieces.length ? await ctx.call(rewriteRequest(plan, card, pieces, references)) : null
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

  /** The plan's characters as the card's cast (角色名册), so 配图 and the visual novel know their looks from the start. */
  function rosterOf(plan) {
    return plan.characters
      .filter(c => c.looks_tags)
      .map(c => ({ name: c.name, aliases: c.aliases.join('，'), kind: /女|female|woman|girl/i.test(c.gender) ? 'girl' : /男|male|man|boy/i.test(c.gender) ? 'boy' : 'other', looks: c.looks_tags, outfit: c.outfit_tags }))
  }

  /**
   * The cast of a card saved before, with the plan's: someone new is added; someone
   * already there (by name or alias) keeps everything set in 配图 (looks, LoRA, voice,
   * 人设图) and only gets what is still empty there.
   */
  function mergeRoster(roster = [], plan) {
    const out = roster.map(entry => ({ ...entry }))
    const names = entry => [entry.name, ...String(entry.aliases ?? '').split(/[,，、]/)].map(n => n.trim()).filter(Boolean)
    for (const fresh of rosterOf(plan)) {
      const known = out.find(entry => !entry.player && names(entry).some(n => names(fresh).includes(n)))
      if (!known) out.push(fresh)
      else for (const key of ['aliases', 'looks', 'outfit']) if (!String(known[key] ?? '').trim()) known[key] = fresh[key]
    }
    return out
  }

  async function requireCard(id) {
    const draft = await load(id)
    if (!draft.card) throw httpError(409, msg`还没有写出这张卡`)
    return draft
  }

  async function startWrite(draft, other = '') {
    draft.stage = 'write'
    await run(draft, 'write', ctx => writeWork(ctx, draft.id), { other })
    return view(draft)
  }

  async function startRewrite(draft, target, note, other = '') {
    const pieces = piecesOf(draft.card, { [target]: [{ type: '', original: '', suggestion: note }] }).map(p => ({ ...p, issues: null, note }))
    if (!pieces.length) throw httpError(400, msg`找不到要改的那一段，或者它还是空的`)
    draft.lastRewrite = { target, note }
    await run(draft, 'rewrite', async ctx => {
      ctx.step(target)
      const result = await ctx.call(rewriteRequest(draft.plan, draft.card, pieces, draft.references))
      await ctx.update(fresh => {
        if (!applyPieces(fresh.card, pieces, result.text, fresh.plan)) throw new Error(msg`${ctx.label} 没有按格式写出改好的内容${cutNote(result)}，再试一次`)
        fresh.card.checks = lintCard(fresh.card, fresh.plan.verbatim)
        fresh.lastRewrite = null
      })
    }, { other })
    return view(draft)
  }

  /**
   * The avatar a draft has, moved into its 抽图历史 before another is written over it
   * (with none kept, it is simply written over). → record(fresh): puts it on the list
   * in ctx.update / mutate and returns the old ones past what is kept, to delete.
   */
  async function retireAvatar(id) {
    const keep = (await history?.keep?.()) ?? 0
    const avatar = (await load(id)).card?.avatar
    if (!avatar || keep <= 0) return () => []
    const file = `avatar-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${avatar.type}`
    try {
      await mkdir(keptDir(id), { recursive: true })
      await rename(avatarFile(id), path.join(keptDir(id), file))
    } catch {
      return () => []
    }
    const entry = { file, at: avatar.at, backend: avatar.backend ?? '', source: avatar.source ?? '', description: avatar.description ?? '' }
    return fresh => {
      const list = [entry, ...(fresh.card.avatarHistory ?? [])]
      fresh.card.avatarHistory = list.slice(0, keep)
      return list.slice(keep)
    }
  }

  const dropKept = (id, entries) => Promise.all(entries.filter(entry => KEPT_FILE.test(entry?.file ?? '')).map(entry => rm(path.join(keptDir(id), entry.file), { force: true })))

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
        const record = await retireAvatar(draft.id)
        let dropped = []
        await writeFile(avatarFile(draft.id), buffer)
        await ctx.update(fresh => {
          dropped = record(fresh)
          fresh.card.avatar = { at: new Date().toISOString(), type: imageType(buffer), backend, source: 'drawn', description: subject.scene }
          fresh.lastAvatar = null
        })
        await dropKept(draft.id, dropped)
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
      target: new RegExp(`^(field:[a-zA-Z]+|greeting:\\d+|entry:[\\w-]+|${STATUS_TARGET})$`),
      title: name => msg`修改：${name}`,
      async load(id) {
        const card = await store.getCard(id)
        const scripts = await helpersOf(store, card)
        const list = scripts ? helperSummary(scripts) : card.helperList ?? []
        return { subject: card, name: card.name, helpers: { list, scripts } }
      },
      save: loaded => store.saveCard(loaded.subject),
      restore: (loaded, snapshot) => snapshot,
      // The variables as they start go along, for a status bar layout to pick its paths from: not for a request kept to
      // another piece, or a card that draws its own bar (working them out runs the card's variable rules).
      request: (card, asked) => {
        const layout = asked.target ? asked.target === STATUS_TARGET : !(drawsOwnBar(card) && !card.statusBar)
        return editRequest(card, { ...asked, state: layout ? startingState(card, { helpers: asked.helpers?.scripts ?? null }) : {} })
      },
      read: readEdit,
      // A variable for the chat that was read goes there; the layout and the rest into the card.
      async apply(card, changes, chosen) {
        const done = applyChanges(card, changes, chosen)
        const layout = changes.find(change => change.kind === 'statusBar' && chosen.includes(change.id))
        if (layout) done.applied += applyStatusChange(card, layout)
        const variables = changes.filter(change => change.kind === 'chatState' && chosen.includes(change.id))
        if (!variables.length || !writeChatState) return done
        const { chat, lost } = await writeChatState(variables[0].chatId, variables)
        return { ...done, applied: done.applied + variables.length, chat, lost }
      },
      undo: true,
      references: true,
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
        if (id.startsWith('preset-') && !isBuiltinPreset(id.slice(7))) {
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
        assistant: turn.assistant ? { reply: turn.assistant.reply, changes: turn.assistant.changes, model: turn.assistant.model, at: turn.assistant.at, missed: turn.assistant.missed } : null,
        outcome: turn.outcome ?? null,
      })),
      job: job ? { kind: job.kind, step: job.step, startedAt: job.startedAt, partial: partialReply(job.partial), chars: job.partial.length } : null,
      error: session.error ?? null,
      references: (session.references ?? []).map(referenceView),
      // The last proposal taken in can be taken back while it is the latest turn.
      undo: Boolean(session.undo && last?.outcome?.applied && session.undo.at === last.outcome.at),
      updatedAt: session.updatedAt,
    }
  }

  async function talkWork(ctx, kind, id) {
    const spec = subjectOf(kind)
    const { session, loaded } = await loadTalk(kind, id)
    const turn = session.turns.at(-1)
    const references = session.references ?? []
    const asked = { text: turn.user.text, target: turn.user.target, turns: session.turns.slice(0, -1), reply: ctx.languages.reply, own: loaded.own === true, name: loaded.name, context: turn.user.context ?? null, references }
    // A subject too long to send whole: a look at its contents first, for what to read.
    if (spec.pick && !turn.user.target && spec.tooLong(loaded.subject)) {
      ctx.step('pick')
      const looked = await ctx.call(spec.pick(loaded.subject, asked))
      asked.picked = spec.readPick(looked.text, loaded.subject)
    }
    ctx.step('edit')
    const { request, shown } = spec.request(loaded.subject, { ...asked, helpers: loaded.helpers })
    const readAnswer = answer => spec.read(answer.text, loaded.subject, { shown, target: turn.user.target, own: loaded.own === true, context: asked.context, references })
    let result = await ctx.call(request)
    let read = readAnswer(result)
    if (!read.reply && !read.changes.length) throw new Error(msg`${ctx.label} 这次没有回出能读的内容${cutNote(result)}，再试一次，或者换个模型`)
    // It said it changed things and wrote out nothing that can be taken (or pieces it may not change): asked once more.
    if (claimsChanges(read)) {
      ctx.step('again')
      const again = await ctx.call({ ...request, messages: [...request.messages, { role: 'assistant', content: result.text }, { role: 'user', content: missingNote(read) }] })
      const reread = readAnswer(again)
      if (reread.changes.length) [result, read] = [again, reread]
    }
    const missed = claimsChanges(read)
    if (spec.finish) {
      ctx.step('check')
      read.changes = await spec.finish(read.changes, asked.context, ctx.signal, loaded.subject)
      // Stopped while checking: no proposal, as a stop anywhere else.
      ctx.signal?.throwIfAborted()
    }
    await ctx.update(fresh => {
      fresh.turns.at(-1).assistant = { raw: result.text, reply: read.reply, changes: read.changes, model: ctx.label, at: new Date().toISOString(), ...(missed ? { missed: { dropped: read.dropped ?? [] } } : {}) }
    })
  }

  return {
    // 角色卡自检: a session of its own beside the card's 对话修改 one.
    ...createCheck({ store, load, save, serial, run, jobs, removeFile: id => rm(fileOf(id), { force: true }), cutNote, trialReport: async cardId => (await load(trialSessionId(cardId)).catch(() => null))?.report ?? null }),
    ...createTrial({ store, engine, load, save, serial, run, jobs, removeFile: id => rm(fileOf(id), { force: true }), cutNote, rulebooks }),

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
        const { applied, prefix, chat, lost } = await spec.apply(loaded.subject, changes, chosen)
        // Only a chat's variables went in: the card is as it was, and those are not this undo's to take back.
        const touched = before && stamp(before) !== stamp(loaded.subject)
        await spec.save(loaded)
        const at = new Date().toISOString()
        turn.outcome = { applied: chosen, at }
        session.undo = touched ? { at, before, after: stamp(loaded.subject), prefix, ...(chat ? { chatKept: true } : {}) } : null
        return { session: talkView(session), subject: loaded.subject, holder: loaded.holder ?? null, applied, prefix, chat, lost }
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
        return { session: talkView(session), subject: loaded.subject, holder: loaded.holder ?? null, prefix: undo.prefix, chatKept: undo.chatKept === true }
      })
    },

    /** A file's text ({ name, text }) or a stretch of a chat ({ chatId, turns, names }) to read beside the card. */
    async talkReference(kind, id, body = {}) {
      if (!subjectOf(kind).references) throw httpError(400, msg`这里不能附资料`)
      const key = talkId(kind, id)
      if (jobs.has(key)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      let reference
      if (body.chatId) {
        const chat = await store.getChat(String(body.chatId))
        if (chat.cardId !== id) throw httpError(400, msg`这个对话不是这张卡的`)
        reference = chatReference(chat, body)
      } else reference = readReference(body)
      return talkView(await mutateTalk(kind, id, session => {
        session.references = withReference(session.references ?? [], reference)
      }))
    },

    /** What the model reads of one reference. */
    async talkReferenceText(kind, id, referenceId) {
      const { session } = await loadTalk(kind, id)
      const reference = (session.references ?? []).find(item => item.id === referenceId)
      if (!reference) throw httpError(404, msg`这份资料已经去掉了`)
      return { ...referenceView(reference), text: reference.text }
    },

    async talkDropReference(kind, id, referenceId) {
      return talkView(await mutateTalk(kind, id, session => {
        session.references = (session.references ?? []).filter(item => item.id !== referenceId)
      }))
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

    /**
     * A new draft from the first idea (with material to go by, the idea can wait); the first round starts right away.
     * @param references - what readReference gave the page before there was a draft.
     */
    async create({ text, model, cardType, options, references } = {}) {
      const kept = keptMaterial(references)
      const idea = clip(text, MAX_TEXT) || (kept.length ? msg`我附了一些资料，想用它们做一张卡` : '')
      if (!idea) throw httpError(400, msg`先说说你想要一张什么样的卡，一句话也行`)
      const now = new Date().toISOString()
      const draft = { id: newId(), createdAt: now, updatedAt: now, stage: 'discuss', model: clip(model, 200), cardType: '', options: cleanCardOptions(options, cardType), greetingCount: 0, rounds: [{ user: { text: idea, picks: [], at: now }, assistant: null }], brief: emptyBrief(), references: kept, plan: null, card: null, job: null, error: null }
      await save(draft)
      await run(draft, 'discuss', ctx => discussWork(ctx, draft))
      return view(draft)
    },

    /**
     * A file read before there is a draft to put it on: the page keeps it. `have`, how long the ones it keeps are.
     * `direct`, for 直连对话 and not a card to make: what is attached there is read as it is.
     */
    readReference(body = {}) {
      const reference = body.direct === true ? readReference(body) : readMaterial(body)
      withReference((Array.isArray(body.have) ? body.have : []).map(chars => ({ chars: Number(chars) || 0 })), reference)
      // A card the wizard only studies: what the model gets of it, for the page to show (its text stays for 使用原文).
      return reference.structure && body.direct !== true ? { ...reference, brief: structureText(reference.structure) } : reference
    },

    /**
     * 只学结构 or 使用原文 for a card among the material. What was read once stays in what the model wrote, so a card that
     * went over to its content stays credited, whatever happens to it afterwards.
     */
    async setReferenceMode(id, referenceId, body = {}) {
      if (jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      return view(await mutate(id, draft => {
        const at = (draft.references ?? []).findIndex(item => item.id === referenceId)
        if (at < 0) throw httpError(404, msg`这份资料已经不在了`)
        draft.references[at] = withMode(draft.references[at], body)
        draft.credits = mergedCredits(draft)
      }))
    },

    /** More material for a draft: the next round, plan and writing read it too. */
    async addReference(id, body = {}) {
      if (jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      const reference = readMaterial(body)
      return view(await mutate(id, draft => {
        draft.references = withReference(draft.references ?? [], reference)
      }))
    },

    /** What the model reads of one reference. */
    async referenceText(id, referenceId) {
      const reference = ((await load(id)).references ?? []).find(item => item.id === referenceId)
      if (!reference) throw httpError(404, msg`这份资料已经去掉了`)
      // Only its structure goes to the model: that is what there is to read.
      return { ...referenceView(reference), text: studying(reference) ? structureText(reference.structure) : reference.text }
    },

    async dropReference(id, referenceId) {
      if (jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      return view(await mutate(id, draft => {
        draft.references = (draft.references ?? []).filter(item => item.id !== referenceId)
      }))
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

    /**
     * Do the failed (or interrupted) job again; in talk, a round can also be asked again for other questions.
     * `model`: another model for this retry only (the draft keeps its own; nothing is sent until the user asks).
     */
    async retry(id, { model } = {}) {
      const draft = await load(id)
      const other = clip(model, 200)
      const kind = draft.error?.kind ?? (draft.stage === 'plan' ? 'plan' : 'discuss')
      if (kind === 'plan') return draft.planPending ? this.revise(id, draft.planPending, { other }) : this.plan(id, { variants: draft.planVariants === true }, { other })
      if (kind === 'write') {
        // Same as 接着写: another version may have been picked since, so the card follows the plan first.
        if (draft.card && draft.plan) draft.card = alignCard(draft.card, draft.plan)
        return startWrite(draft, other)
      }
      if (kind === 'rewrite' && draft.lastRewrite) return startRewrite(draft, draft.lastRewrite.target, draft.lastRewrite.note, other)
      if (kind === 'avatar') return startAvatar(draft, draft.lastAvatar?.description, draft.lastAvatar?.choice)
      const last = draft.rounds.at(-1)
      if (last.assistant) last.assistant = null
      await run(draft, 'discuss', ctx => discussWork(ctx, draft), { other })
      return view(draft)
    },

    /**
     * What 换这个模型重写 would come to: the failed step's calls as they went last time, priced for `model`
     * (cost null for a model with no known price; tokens null for an error saved before they were kept).
     */
    async retryEstimate(id, { model } = {}) {
      const draft = await load(id)
      const other = clip(model, 200)
      if (!other) throw httpError(400, msg`先选一个模型`)
      const chosen = await target(draft, other)
      const size = draft.error?.size ?? null
      return { model: chosen.label, input: size?.input ?? null, output: size?.output ?? null, measured: size?.measured === true, cost: size ? estimateCost(chosen.modelId, size) : null }
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
    async update(id, { model, brief, stage, tracking, userName, userGender, cardType, options, greetingCount, planPick } = {}) {
      if (((tracking && typeof tracking === 'object') || typeof userName === 'string' || typeof userGender === 'string' || planPick !== undefined) && jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
      const draft = await mutate(id, draft => {
        const briefBefore = draft.brief
        if (typeof model === 'string') draft.model = clip(model, 200)
        if (brief && typeof brief === 'object') draft.brief = editBrief(draft.brief, brief)
        // What kind of card, and how many openings: the next round and the next plan go by them.
        if (typeof cardType === 'string') draft.options = cleanCardOptions(null, cardType)
        if (options && typeof options === 'object') draft.options = cleanCardOptions(options)
        if (greetingCount !== undefined) draft.greetingCount = cleanGreetingCount(greetingCount)
        // Another of the three versions: it becomes the plan (a card already started follows it when writing goes on).
        if (planPick !== undefined) {
          const option = draft.planOptions?.[Number(planPick)]
          if (!option) throw httpError(400, msg`没有这一版方案`)
          draft.planPick = Number(planPick)
          draft.plan = option.plan
        }
        // The player's gender set in the plan: the picks take it too, so a revision keeps it.
        if (typeof userGender === 'string') {
          if (!draft.plan) throw httpError(409, msg`还没有方案`)
          draft.options = cleanCardOptions({ ...optionsOf(draft), userGender })
        }
        // 你的性别 is one pick for the talk, the plan and the card: they follow it wherever it was changed (the
        // sketch's picks or its item, the plan, another version), unless a step is still writing from the plan.
        followGender(draft, briefBefore, !jobs.has(id))
        // The plan's status bar editor: variables edited by hand, no model call. A card
        // already written gets its state entries again from them.
        if (tracking && typeof tracking === 'object') {
          if (!draft.plan) throw httpError(409, msg`还没有方案`)
          draft.plan = editTracking(draft.plan, tracking)
          keepPick(draft)
          if (draft.card) draft.card = retrack(draft.card, draft.plan)
        }
        // The player's name, set by hand in the plan ('' = the one in settings). The card
        // says <user> throughout, so a written card needs nothing more.
        if (typeof userName === 'string') {
          if (!draft.plan) throw httpError(409, msg`还没有方案`)
          draft.plan = editUserName(draft.plan, userName)
          keepPick(draft)
        }
        // Going back keeps what is ahead: the plan stays while talking, the card while planning.
        const reachable = { discuss: true, plan: Boolean(draft.plan), write: Boolean(draft.card), polish: Boolean(draft.card?.writtenAt) }
        if (STAGES.includes(stage) && reachable[stage]) draft.stage = stage
      })
      return view(draft)
    },

    /**
     * Write the talk up as a plan; `variants` (出三版来挑): three versions at once, to pick one;
     * `missing`: only the versions that did not come last time, added to the others.
     */
    async plan(id, { variants = false, missing = false } = {}, { other = '' } = {}) {
      const draft = await load(id)
      if (!draft.rounds.some(r => r.assistant)) throw httpError(409, msg`先聊一轮再出方案`)
      // The last answer may still be waiting for a reply: plan from what was said.
      const rounds = draft.rounds.filter(r => r.assistant || r === draft.rounds.at(-1))
      const options = { options: optionsOf(draft), greetings: draft.greetingCount, references: draft.references }
      const names = { userName: chosenUserName(draft.brief) }
      const only = missing === true && draft.planOptions?.length && draft.planMissing?.length ? draft.planMissing.map(m => m.angle) : null
      draft.planPending = null
      draft.planVariants = variants === true
      await run(draft, 'plan', ctx => (variants === true
        ? planOptionsWork(ctx, rounds, draft.brief, options, names, only)
        : planWork(ctx, planRequest(rounds, draft.brief, ctx.languages, options), ctx.languages.card, names)), { other })
      return view(draft)
    },

    /**
     * A few ideas to start from (给我灵感), outside any draft: `exclude` names the
     * ones shown before, so another batch brings new ones; `count` 1 for 交给 Cica (one, put in the box).
     */
    async ideas({ model, cardType, options, exclude, count = 5 } = {}) {
      const chosen = await target({ model: clip(model, 200) })
      const languages = forgeLanguages(currentLanguage(), (await store.getSettings()).language)
      const shown = (Array.isArray(exclude) ? exclude : []).map(title => clip(title, 30)).filter(Boolean).slice(-40)
      // An answer that cannot be read (a model now and then leaves the format) is asked for once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        let result
        try {
          result = await complete(chosen.provider, chosen.modelId, ideasRequest(ideaSeeds(Math.min(5, Math.max(1, Math.floor(Number(count)) || 5))), languages, { options: cleanCardOptions(options, cardType), exclude: shown }), { proxy: proxyNow() })
        } catch (error) {
          throw error.status ? error : httpError(502, providerError(chosen.provider, error))
        }
        if (ledger && result.usage) await ledger.recordTurn({ id: 'forge-ideas', title: msg`创作：找灵感`, cardId: null }, { model: chosen.ref, usage: result.usage, createdAt: new Date().toISOString() }).catch(() => {})
        const ideas = readIdeas(result.text)
        if (ideas.length) return { ideas }
      }
      throw httpError(502, msg`${refLabel(chosen.ref, await store.getProviders()) ?? chosen.ref} 这次没给出能读的灵感，再试一次，或者换个模型`)
    },

    /** Revise the plan by the user's comments (per section and overall). */
    async revise(id, { text, notes } = {}, { other = '' } = {}) {
      const draft = await load(id)
      if (!draft.plan) throw httpError(409, msg`还没有方案`)
      const cleanNotes = (Array.isArray(notes) ? notes : []).map(n => ({ section: clip(n?.section, 40), text: clip(n?.text, 1000) })).filter(n => n.section && n.text)
      const general = clip(text, MAX_TEXT)
      if (!general && !cleanNotes.length) throw httpError(400, msg`先写下想怎么改`)
      draft.planNotes = [...(draft.planNotes ?? []), { at: new Date().toISOString(), text: general, notes: cleanNotes }].slice(-20)
      draft.planPending = { text: general, notes: cleanNotes }
      const names = { userName: draft.plan.user_role.name ?? '', said: [general, ...cleanNotes.map(n => n.text)].join('\n') }
      await run(draft, 'plan', ctx => planWork(ctx, reviseRequest(draft.rounds.filter(r => r.assistant), draft.plan, { text: general, notes: cleanNotes }, { options: optionsOf(draft), references: draft.references }), planLanguage(draft.plan), names), { other })
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
        // When it was saved stays: the card in the list is still that one, and the rewrite shows as not saved.
        const saved = savedCardId ? { savedAt: draft.card.savedAt ?? null, savedStamp: draft.card.savedStamp ?? null, savedMark: draft.card.savedMark ?? null, savedPicture: draft.card.savedPicture ?? null } : {}
        draft.card = { ...newCard(draft.plan), avatar, savedCardId, ...saved }
      } else {
        // The plan may have been revised since the card was started: what is written stays, the rest follows the plan.
        draft.card = alignCard(draft.card, draft.plan)
      }
      return startWrite(draft)
    },

    /** Rewrite one entry (by name) or opening ("开场白2") by the user's note. */
    /** 数值预览: the card's stages and events at the values the sliders are at (no model call). */
    async preview(id, { values } = {}) {
      const draft = await load(id)
      if (!draft.plan || !draft.card) throw httpError(409, msg`卡还没有写出来`)
      return previewDynamics(draft.plan, draft.card, values, renderTemplate)
    },

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
      if (jobs.get(id)?.kind === 'avatar') throw httpError(409, msg`正在画头像，等它画完`)
      const record = await retireAvatar(id)
      let dropped = []
      await writeFile(avatarFile(id), buffer)
      const saved = await mutate(id, fresh => {
        dropped = record(fresh)
        fresh.card.avatar = { at: new Date().toISOString(), type: imageType(buffer), backend: '', source: 'upload', description: '' }
        if (fresh.error?.kind === 'avatar') fresh.error = null
      })
      await dropKept(id, dropped)
      return view(saved)
    },

    /** 抽图历史: one of the draft's old avatars back as its avatar; the one it has now joins the old ones. */
    async useKeptAvatar(id, file) {
      const draft = await requireCard(id)
      if (jobs.get(id)?.kind === 'avatar') throw httpError(409, msg`正在画头像，等它画完`)
      const chosen = (draft.card.avatarHistory ?? []).find(entry => entry.file === file)
      if (!chosen || !KEPT_FILE.test(chosen.file)) throw httpError(404, msg`这张旧图已经不在了`)
      const now = draft.card.avatar
      const back = `avatar-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${now?.type ?? 'png'}`
      if (now) await rename(avatarFile(id), path.join(keptDir(id), back))
      await rename(path.join(keptDir(id), chosen.file), avatarFile(id))
      const saved = await mutate(id, fresh => {
        const rest = (fresh.card.avatarHistory ?? []).filter(entry => entry.file !== chosen.file)
        fresh.card.avatarHistory = now ? [{ file: back, at: now.at, backend: now.backend ?? '', source: now.source ?? '', description: now.description ?? '' }, ...rest] : rest
        fresh.card.avatar = { at: chosen.at || new Date().toISOString(), type: chosen.file.split('.').pop(), backend: chosen.backend ?? '', source: chosen.source || 'drawn', description: chosen.description ?? '' }
        if (fresh.error?.kind === 'avatar') fresh.error = null
      })
      return view(saved)
    },

    /** 抽图历史: one of the draft's old avatars deleted. */
    async dropKeptAvatar(id, file) {
      await requireCard(id)
      if (!KEPT_FILE.test(String(file))) throw httpError(400, msg`文件名不对`)
      const saved = await mutate(id, fresh => {
        fresh.card.avatarHistory = (fresh.card.avatarHistory ?? []).filter(entry => entry.file !== file)
      })
      await rm(path.join(keptDir(id), file), { force: true })
      return view(saved)
    },

    /** An old avatar's picture → { buffer, type }. */
    async readKeptAvatar(id, file) {
      if (!KEPT_FILE.test(String(file))) throw httpError(404, msg`这张旧图已经不在了`)
      const buffer = await readFile(path.join(keptDir(id), file)).catch(() => null)
      if (!buffer) throw httpError(404, msg`这张旧图已经不在了`)
      return { buffer, type: `image/${file.split('.').pop()}` }
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
     * `ask`: when the saved card was edited elsewhere since, nothing is saved and the answer says so, for the
     * page to confirm and send again without it (a page from before this sends none and saves as it always did).
     */
    async saveCard(id, { avatar, ask = false } = {}) {
      const draft = await requireCard(id)
      if (jobs.has(id)) throw httpError(409, msg`正在写，等它写完再保存`)
      if (!draft.card.greetings.some(g => g.text)) throw httpError(409, msg`开场白还没写`)
      const match = IMAGE.exec(String(avatar ?? ''))
      if (!match || match[1] !== 'png') throw httpError(400, msg`头像要转成 PNG 再保存`)
      const old = draft.card.savedCardId ? await store.getCard(draft.card.savedCardId).catch(() => null) : null
      // The saved card's picture: the save writes the draft's over it, so one set elsewhere counts as an edit too.
      const before = old?.hasAvatar ? await readFile(store.avatarPath(old.id)).catch(() => null) : null
      const beforeMark = pictureMark(before)
      // A draft saved before the marks were kept cannot tell, and is not asked about.
      const textChanged = Boolean(old && draft.card.savedMark && draft.card.savedMark !== writtenMark(old))
      const pictureChanged = Boolean(old && draft.card.savedPicture && draft.card.savedPicture !== beforeMark)
      if (ask && (textChanged || pictureChanged)) return { changedElsewhere: true, pictureChanged, card: cardSummary(old) }
      const raw = cardJson(draft.plan, draft.card, { author: (await store.getPersona()).name, credits: creditsFor(draft) })
      const png = writeCardPng(Buffer.from(match[2], 'base64'), raw)
      // The picture it replaces, when not the one the last save wrote, goes into 抽图历史 as 修改角色卡's 换头像 does.
      if (beforeMark && beforeMark !== (draft.card.savedPicture ?? pictureMark(png))) await history?.push(old.id, 'avatar', { buffer: before, at: await madeAt(store.avatarPath(old.id)), source: 'avatar' })
      const card = normalizeCard(raw)
      // The plan's art style becomes the card's 画风 (配图), so its sprites and backgrounds agree; one set in 配图 stays.
      const style = draft.plan.avatar?.style ?? ''
      if (old) Object.assign(card, { id: old.id, media: { ...old.media, style: old.media?.style || style, roster: cleanCardMedia({ roster: mergeRoster(old.media?.roster, draft.plan) }).roster }, worldbookIds: old.worldbookIds ?? [], importedAt: old.importedAt, group: old.group ?? '', archived: old.archived === true })
      else card.media = cleanCardMedia({ style, roster: rosterOf(draft.plan) })
      card.hasAvatar = true
      await store.saveCard(card, png)
      // 战斗与成长: the plan's rules; what the bestiary has learned from play stays.
      const game = rulebookOf(raw)
      if (game) await rulebooks?.change(card.id, book => ({ ...game, foes: { ...game.foes, ...book.foes } }))
      const saved = await mutate(id, fresh => {
        fresh.card.savedCardId = card.id
        fresh.card.savedAt = new Date().toISOString()
        // Of the draft as written into the card (an edit that came in during the save shows as changed).
        fresh.card.savedStamp = savedStamp(draft)
        fresh.card.savedMark = writtenMark(card)
        fresh.card.savedPicture = pictureMark(png)
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
      await rm(keptDir(id), { recursive: true, force: true })
      return { ok: true }
    },
  }
}
