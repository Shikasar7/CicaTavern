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
// Model calls run in the background: a request starts a job and returns the
// draft at once; the page polls the draft until the job is done. Closing the
// window loses nothing.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { cardSummary, normalizeCard, writeCardPng } from '../cards.mjs'
import { cleanCardMedia } from '../media.mjs'
import { complete, isProviderRef, providerError, refLabel, resolveRef } from '../providers.mjs'
import { httpError, newId } from '../store.mjs'
import { discussRequest, editBrief, editTracking, emptyBrief, forgeLanguages, partialReply, planLanguage, planRequest, readDiscussion, readPlan, reviseRequest } from './prompts.mjs'
import { applyIssues, cardJson, entriesRequest, greetingsRequest, initialState, lintCard, matchWritten, newCard, readIssues, readTagged, retrack, reviewRequest, rewriteRequest, stepDone, writeSteps } from './write.mjs'
import { currentLanguage, msg } from '../i18n.mjs'

const ID = /^[a-zA-Z0-9_-]{1,64}$/
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
 * @param draw - (input, signal) → { buffer, backend }: one picture from the image
 *   backend set up in 配图 (media.drawCardArt); without it, avatars are upload-only.
 */
export function createForge(store, { proxyNow = () => null, ledger = null, draw = null } = {}) {
  const dir = path.join(store.dirs.root, 'forge')
  const fileOf = id => {
    if (!ID.test(String(id))) throw httpError(400, msg`无效的 ID`)
    return path.join(dir, `${id}.json`)
  }
  const avatarFile = id => fileOf(id).replace(/\.json$/, '.avatar')
  // id → { kind, step, controller, partial, startedAt } of the job in progress.
  const jobs = new Map()

  async function load(id) {
    let draft
    try {
      draft = JSON.parse(await readFile(fileOf(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw httpError(404, msg`这张草稿不存在了`)
      throw error
    }
    // A job recorded on disk but not running here: the server stopped in the middle of it.
    if (draft.job && !jobs.has(id)) {
      draft.error = { kind: draft.job.kind, message: msg`上次还没写完服务就停了，再试一次。` }
      draft.job = null
    }
    return draft
  }

  async function save(draft) {
    draft.updatedAt = new Date().toISOString()
    await mkdir(dir, { recursive: true })
    const file = fileOf(draft.id)
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
    const chat = { id: `forge-${id}`, title: msg`创作：${draft.plan?.name || draft.brief.title || msg`未命名`}`, cardId: null }
    await ledger.recordTurn(chat, { model: ref, usage: result.usage, createdAt: new Date().toISOString() })
  }

  const cutNote = result => (result.truncated ? msg`（写到输出上限被截断了）` : result.stopReason && !/stop|end/i.test(result.stopReason) ? msg`（${result.stopReason}）` : '')

  // ─── Talk and plan ──────────────────────────────────────────────────────

  async function discussWork(ctx, draft) {
    const result = await ctx.call(discussRequest(draft.rounds, draft.brief, ctx.languages))
    await ctx.update(fresh => {
      const read = readDiscussion(result.text, fresh.brief)
      if (!read.reply && !read.questions.length) throw new Error(msg`${ctx.label} 这次没有回出能读的内容${cutNote(result)}，再试一次，或者换个模型`)
      fresh.rounds.at(-1).assistant = { raw: result.text, reply: read.reply, questions: read.questions, model: ctx.label, at: new Date().toISOString(), unreadable: !read.readable }
      fresh.brief = read.brief
    })
  }

  /** @param language - the card's: 写作语言 for a new plan, the plan's own when revising. */
  async function planWork(ctx, request, language) {
    const result = await ctx.call(request)
    await ctx.update(fresh => {
      const plan = readPlan(result.text, { language })
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
      for (const [name, text] of found) fresh.card.entries.find(e => e.name === name).content = text.slice(0, MAX_PIECE)
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
      for (const [index, text] of found) fresh.card.greetings[index].text = text.slice(0, MAX_PIECE)
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

  /** Apply rewritten pieces (entries and openings) from an answer. */
  function applyPieces(card, pieces, text) {
    const entries = readTagged(text, 'entry')
    const greetings = readTagged(text, 'greeting', 'index')
    let applied = 0
    const lone = pieces.length === 1 && entries.size + greetings.size === 1 ? [...entries.values(), ...greetings.values()][0] : null
    for (const piece of pieces) {
      const fresh = piece.greeting ? greetings.get(String(piece.index + 1)) : matchWritten(entries, [piece.name]).get(piece.name)
      const value = (fresh ?? lone)?.slice(0, MAX_PIECE)
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
      if (result) applyPieces(fresh.card, pieces, result.text)
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
        if (!applyPieces(fresh.card, pieces, result.text)) throw new Error(msg`${ctx.label} 没有按格式写出改好的内容${cutNote(result)}，再试一次`)
        fresh.card.checks = lintCard(fresh.card, fresh.plan.verbatim)
        fresh.lastRewrite = null
      })
    })
    return view(draft)
  }

  async function startAvatar(draft, description) {
    if (!draw) throw httpError(400, msg`这里画不了图，上传一张吧`)
    const subject = avatarSubject(draft.plan, description)
    draft.lastAvatar = { description: clip(description, 400) }
    await run(
      draft,
      'avatar',
      async ctx => {
        ctx.step('avatar')
        const { buffer, backend } = await draw(subject, ctx.signal)
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

  return {
    busy: () => jobs.size > 0,

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
      if (kind === 'avatar') return startAvatar(draft, draft.lastAvatar?.description)
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
    async update(id, { model, brief, stage, tracking } = {}) {
      if (tracking && typeof tracking === 'object' && jobs.has(id)) throw httpError(409, msg`上一步还在进行，等它写完或先停下`)
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
      await run(draft, 'plan', ctx => planWork(ctx, planRequest(rounds, draft.brief, ctx.languages), ctx.languages.card))
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
      await run(draft, 'plan', ctx => planWork(ctx, reviseRequest(draft.rounds.filter(r => r.assistant), draft.plan, { text: general, notes: cleanNotes }), planLanguage(draft.plan)))
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

    /** Draw the avatar with the image backend set up in 配图; `description` overrides the scene. */
    async drawAvatar(id, { description } = {}) {
      return startAvatar(await requireCard(id), description)
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
