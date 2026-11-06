// 试玩体检: a few rounds of a saved card on the real chat engine, in a chat of its own that nobody sees and that goes when
// the round is over. One model plays the card as a chat always does, another call stands in for the player, and every
// round is looked over by the program: what a reply should carry, what reached the variables, what showed that should
// not. One last call reads the story for what only a reader sees. The window says about how much before anything is sent.
import { estimateTokens } from '../context.mjs'
import { msg } from '../i18n.mjs'
import { estimateCost } from '../models.mjs'
import { hasUpdateBlock, usesMvu } from '../mvu.mjs'
import { replyBlocks } from '../prompt.mjs'
import { isProviderRef, refLabel } from '../providers.mjs'
import { applyScripts } from '../regex-guard.mjs'
import { displayText } from '../state.mjs'
import { httpError } from '../store.mjs'
import { greetingList } from '../../web/shared/card-edit.js'
import { PLACEMENT } from '../../web/shared/regex.js'
import { cleanPath } from '../../web/shared/status.js'
import { getPath } from '../../web/shared/vars.js'
import { booksForCard, chatScripts, createChat } from '../chats.mjs'
import { asksChoices } from '../basic.mjs'
import { constantEntries, lateEntries } from '../worldbook.mjs'
import { CREATION_TAG, creationOf, randomSheet } from './creation.mjs'
import { LONG_TOKENS, TALK_TOKENS, looseJson, section } from './prompts.mjs'

const PREFIX = 'edit-trial-'
export const TRIAL_ROUNDS = [3, 6, 10]
const DEFAULT_ROUNDS = 6
const MAX_QUOTE = 60
const MAX_ISSUES = 12
const MAX_TEXT = 2400
const RECENT_ROUNDS = 3
// What a round comes to beyond the card's own text, from the real runs of 2026-11: a reply and its thinking, the story so
// far growing by about this much a round, and the stand-in player.
const REPLY_TOKENS = 2500
const GROWTH_TOKENS = 1500
const PRESET_TOKENS = 3000
const PLAYER_INPUT = 2500
const PLAYER_OUTPUT = 600
const REVIEW_OUTPUT = 4000

// What the stand-in player tries, in order. Each is a thing real cards fell over in testing: going along with a false
// claim, letting a player do what the rules forbid, answering for the player, losing count of what was spent.
const INTENTS = {
  go: '顺着眼前的情况自然地往下走，可以选一个选项。',
  use: '用掉一样东西，或者花一笔钱，或者拿到一样东西。说清是什么、多少。',
  ask: '追问一个人物不愿说的事。',
  push: '坚决地做一件明显超出你本事或规矩的事。',
  claim: '当真地说一件和前文不符的小事，比如记错了数目、时间或谁说过的话。',
  hand: '不做决定，让对方替你决定接下来怎么办。',
}
const INTENT_ORDER = {
  3: ['go', 'push', 'claim'],
  6: ['go', 'use', 'ask', 'push', 'claim', 'hand'],
  10: ['go', 'use', 'ask', 'go', 'push', 'use', 'claim', 'go', 'hand', 'ask'],
}

export const cleanRounds = value => (TRIAL_ROUNDS.includes(Number(value)) ? Number(value) : DEFAULT_ROUNDS)
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)
const valueOf = (state, field) => getPath(state ?? {}, cleanPath(field.path))

/** The stand-in player's line for a round. @param story - [{ you, reply }], the rounds so far, the opening first. */
export function playerRequest(card, story, intent) {
  const recent = story.slice(-RECENT_ROUNDS).map(({ you, reply }) => [you ? `玩家：${you}` : '', `故事：${clip(reply, MAX_TEXT)}`].filter(Boolean).join('\n')).join('\n\n')
  const system = `你在替一位玩家试玩角色卡《${card.name}》。写这位玩家这一轮说的话或做的事：
- 一到三句，第一人称，用故事的语言写。
- 只写玩家自己的话和动作，不写别人的反应，不写结果。
- 不解释，不写括号里的说明。这一轮要做的事不要点破，当作玩家本来就想这么做。`
  return { system, messages: [{ role: 'user', content: `<故事>\n${recent}\n</故事>\n\n这一轮：${INTENTS[intent] ?? INTENTS.go}\n\n只输出玩家这一轮的话。` }], maxTokens: TALK_TOKENS, softCap: true }
}

/** What the model answered, as a player's line: quotes and labels it put around it go. */
export function playerLine(text) {
  return String(text ?? '').trim().replace(/^(玩家|我|Player)[:：]\s*/, '').replace(/^["“「]([\s\S]*)["”」]$/, '$1').trim()
}

/** One round as the program sees it. @param reply - { text, shown, node }; @param needs - what roundNeeds worked out. */
export function roundChecks({ text, shown, node }, needs) {
  const problems = []
  const add = (kind, what) => problems.push({ kind, what })
  if (!text.trim()) add('empty', msg`回复是空的`)
  if (node.api?.truncated) add('cut', msg`回复写到输出上限被截断了`)
  if (needs.update && !hasUpdateBlock(text)) add('update', msg`没写变量更新`)
  else if (needs.update && node.updateUnread) add('update', msg`变量更新块读不出来`)
  if (needs.choices && !/<choices>[\s\S]*<\/choices>/.test(text)) add('choices', msg`没写行动选项`)
  for (const tag of needs.always) if (!text.includes(`<${tag}>`)) add('block', msg`没写 <${tag}> 块`)
  if (node.schemaProblem) add('schema', msg`变量没通过卡的规则：${String(node.schemaProblem).slice(0, 120)}`)
  for (const error of node.templateErrors ?? []) add('template', msg`模板出错：${String(error).slice(0, 120)}`)
  const leaked = [...new Set([...shown.matchAll(/<\/?([a-zA-Z_][\w-]*)>/g)].map(match => match[1]))].filter(tag => !HTML_TAGS.has(tag.toLowerCase()))
  if (leaked.length) add('leak', msg`玩家看到了本该隐藏的标签：${leaked.map(tag => `<${tag}>`).join(' ')}`)
  for (const field of needs.ranged) {
    const value = Number(valueOf(node.state, field))
    if (Number.isFinite(value) && (value < field.min || value > field.max)) add('range', msg`「${field.label || field.path}」到了 ${value}，超出 ${field.min} 到 ${field.max}`)
  }
  return problems
}

const HTML_TAGS = new Set(['b', 'i', 'u', 's', 'p', 'br', 'hr', 'em', 'strong', 'span', 'div', 'small', 'big', 'sub', 'sup', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'center', 'font', 'details', 'summary', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'style', 'script', 'body', 'html', 'head', 'meta', 'title', 'iframe'])

/** What every reply of this card should carry; a block the rules ask for only now and then is not held against it. */
export function roundNeeds({ mvu, choices, blocks, fields }) {
  return {
    update: mvu,
    choices,
    always: blocks.filter(tag => tag === 'self_check'),
    ranged: (fields ?? []).filter(field => Number.isFinite(field.min) && Number.isFinite(field.max) && field.max > field.min),
  }
}

/** Numbers that stayed where they started, all the way through. */
function stillFields(fields, first, last) {
  return (fields ?? []).filter(field => field.show !== 'hidden').filter(field => {
    const before = valueOf(first, field)
    return before !== undefined && JSON.stringify(before) === JSON.stringify(valueOf(last, field))
  })
}

/**
 * The rounds added up, as the report opens with them.
 * @param rounds - { problems, triggered, state }, in order.
 * @returns [{ level: 'ok' | 'warn' | 'error', text }]
 */
export function summaryLines(rounds, { needs, fields, start, keyed = [] }) {
  const total = rounds.length
  const lines = []
  const count = kind => rounds.filter(round => round.problems.some(problem => problem.kind === kind)).length
  const rate = (label, missed) => lines.push({ level: missed === 0 ? 'ok' : missed > total / 3 ? 'error' : 'warn', text: msg`${label}：${total} 回合写了 ${total - missed} 回合` })
  if (needs.update) rate(msg`变量更新`, count('update'))
  if (needs.choices) rate(msg`行动选项`, count('choices'))
  for (const tag of needs.always) rate(`<${tag}>`, rounds.filter(round => round.problems.some(problem => problem.kind === 'block' && problem.what.includes(`<${tag}>`))).length)
  for (const [kind, text] of [['empty', msg`回复是空的：${count('empty')} 回合`], ['cut', msg`回复被截断：${count('cut')} 回合`], ['leak', msg`露出了隐藏内容：${count('leak')} 回合`], ['schema', msg`变量没通过卡的规则：${count('schema')} 回合`], ['template', msg`模板出错：${count('template')} 回合`], ['range', msg`数值超出范围：${count('range')} 回合`]]) {
    if (count(kind)) lines.push({ level: 'error', text })
  }
  if (!count('leak')) lines.push({ level: 'ok', text: msg`没有后台内容露给玩家` })
  const last = rounds.at(-1)?.state
  const still = total >= 5 && needs.update ? stillFields(fields, start, last) : []
  if (still.length) lines.push({ level: 'warn', text: msg`这些变量一直没变过：${still.map(field => field.label || field.path).slice(0, 8).join(msg`、`)}。也许只是没玩到，也许更新规则没写清` })
  const fired = new Set(rounds.flatMap(round => round.triggered))
  const asleep = keyed.filter(title => !fired.has(title))
  if (keyed.length) lines.push({ level: 'ok', text: msg`按关键词的世界书触发了 ${keyed.length - asleep.length} 条，共 ${keyed.length} 条` })
  return lines
}

/** The story as the reader gets it, and what the card asks of it. */
export function reviewRequest(card, rounds, { reply = '简体中文', rules = '' } = {}) {
  const story = rounds.map((round, i) => `【第 ${i + 1} 回合】\n玩家：${round.input}\n回复：${clip(round.shown, MAX_TEXT)}`).join('\n\n')
  const system = `你是互动小说的审读员。一张角色卡刚被试玩了 ${rounds.length} 回合，玩家是程序扮的，有些回合在故意试探。挑出读者才看得出的毛病，格式和变量程序已经查过了，不用管。

看这些：
- 抢话：替玩家说话、做决定、写玩家的内心。
- 出戏：人物不像自己，或者叙述跳出故事。
- 矛盾：和前文的时间、地点、数目、谁知道什么对不上；顺着玩家说的假话走。
- 放水：玩家做明显做不到或规矩不许的事，却轻易成功。
- 重复：句式、桥段、结尾的写法一再出现。

只记真的有的，拿不准就不记，最多 ${MAX_ISSUES} 条。没有毛病就让 issues 为空。fix 写这张卡该怎么改，不写这一局该怎么写。

只输出：
<review>{"summary": "用${reply}写一两句：这张卡玩起来怎么样", "issues": [{"round": 3, "kind": "抢话", "what": "用${reply}写一句话", "quote": "回复原文，不超过 30 字", "fix": "用${reply}写一句话"}]}</review>`
  const content = [`<角色卡>\n名字：${card.name}\n${clip(String(card.description ?? ''), MAX_TEXT)}\n</角色卡>`, rules ? `<这张卡的规则>\n${clip(rules, MAX_TEXT)}\n</这张卡的规则>` : '', `<试玩记录>\n${story}\n</试玩记录>`].filter(Boolean).join('\n\n')
  return { system, messages: [{ role: 'user', content }], maxTokens: LONG_TOKENS, softCap: true }
}

const KINDS = ['抢话', '出戏', '矛盾', '放水', '重复']

/** The reader's answer; null when it can't be read. */
export function readReview(text, rounds) {
  const json = looseJson(section(text, 'review') || text)
  if (!json || typeof json !== 'object') return null
  const issues = (Array.isArray(json.issues) ? json.issues : [])
    .filter(item => item && typeof item === 'object' && String(item.what ?? '').trim())
    .slice(0, MAX_ISSUES)
    .map(item => ({
      round: Math.min(Math.max(1, Math.floor(Number(item.round) || 1)), Math.max(1, rounds)),
      kind: KINDS.includes(item.kind) ? item.kind : '其他',
      what: clip(String(item.what).trim(), 200),
      quote: clip(String(item.quote ?? '').trim(), MAX_QUOTE),
      fix: clip(String(item.fix ?? '').trim(), 200),
    }))
  return { summary: clip(String(json.summary ?? '').trim(), 300), issues }
}

/** About what a run comes to, for the window to say before it starts. */
export function estimateRun(card, books, rounds) {
  const text = [card.description, card.personality, card.scenario, card.systemPrompt, greetingList(card)[0], ...constantEntries(books).map(entry => entry.content)].filter(Boolean).join('\n')
  const base = estimateTokens(text) + PRESET_TOKENS
  // The prompt grows as the story does.
  const replies = Array.from({ length: rounds }, (_, round) => base + round * GROWTH_TOKENS).reduce((sum, tokens) => sum + tokens, 0)
  const review = estimateTokens(String(card.description ?? '').slice(0, MAX_TEXT)) + rounds * GROWTH_TOKENS
  return { input: replies + rounds * PLAYER_INPUT + review, output: rounds * (REPLY_TOKENS + PLAYER_OUTPUT) + REVIEW_OUTPUT }
}

// What is there every turn: the entries in the prefix and the ones sent late.
const standing = books => [...constantEntries(books), ...lateEntries(books)]

/**
 * @param deps - from createForge: { store, engine, load, save, serial, run, jobs, removeFile, cutNote }
 */
export function createTrial({ store, engine, load, save, serial, run, jobs, removeFile, cutNote }) {
  const idOf = cardId => `${PREFIX}${cardId}`
  // The chat each running trial plays in: stopping has to reach the turn under way as well.
  const playing = new Map()

  async function loadTrial(cardId) {
    const card = await store.getCard(cardId)
    const session = await load(idOf(cardId)).catch(error => {
      if (error.status !== 404) throw error
      const now = new Date().toISOString()
      return { id: idOf(cardId), kind: 'card', cardId, createdAt: now, updatedAt: now, model: '', rounds: DEFAULT_ROUNDS, job: null, error: null, report: null }
    })
    session.cardName = card.name
    return { card, session }
  }

  async function view(card, session) {
    const job = jobs.get(session.id)
    const rounds = cleanRounds(session.rounds)
    const books = await booksForCard(store, card, await store.getSettings())
    const { input, output } = estimateRun(card, books, rounds)
    const ref = session.model || (await store.getSettings()).model || ''
    const ready = isProviderRef(ref)
    return {
      cardId: card.id,
      name: card.name,
      model: session.model ?? '',
      rounds,
      choices: TRIAL_ROUNDS,
      estimate: { ready, model: ready ? (refLabel(ref, await store.getProviders()) ?? ref) : '', input, output, cost: ready ? estimateCost(ref.slice(ref.indexOf('/') + 1), { input, output }) : null },
      job: job ? { step: job.step, startedAt: job.startedAt } : null,
      error: session.error ?? null,
      report: session.report ?? null,
    }
  }

  /** What every round will be held to, from the card and the chat it is played in. */
  async function needsOf(card, chat) {
    const books = await booksForCard(store, card, await store.getSettings(), chat)
    const scripts = await chatScripts(store, chat)
    const fields = card.statusBar?.fields ?? []
    return {
      books,
      scripts,
      fields,
      needs: roundNeeds({ mvu: usesMvu(card, books), choices: asksChoices(chat), blocks: replyBlocks(standing(books), scripts), fields }),
      keyed: books.flatMap(book => book.entries).filter(entry => entry.enabled !== false && !entry.constant && entry.keys?.length).map(entry => entry.comment).filter(Boolean),
    }
  }

  async function round(ctx, chat, parent, input, { needs, scripts }) {
    const turn = await engine.runTurn(chat.id, { parentId: parent, input }, () => {})
    const node = turn.chat.nodes[turn.nodeId]
    const shown = applyScripts(displayText(node.text), scripts, { placement: PLACEMENT.AI_OUTPUT, target: 'display', depth: 0 }).replace(/```html[\s\S]*?```/g, '').replace(/<StatusPlaceHolderImpl\/>/g, '').trim()
    const problems = roundChecks({ text: node.text, shown, node }, needs)
    const usage = node.usage ?? {}
    return {
      nodeId: turn.nodeId,
      entry: {
        input,
        shown,
        problems,
        changes: (node.stateChanges ?? []).slice(0, 12),
        triggered: turn.chat.nodes[node.parent]?.injected ?? [],
        state: node.state ?? {},
        tokens: { input: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), output: usage.output ?? 0 },
      },
    }
  }

  async function trialWork(ctx, cardId, rounds) {
    const card = await store.getCard(cardId)
    const { session } = await loadTrial(cardId)
    // One left behind by a run the app did not live through.
    for (const old of await store.listChats(cardId)) if (old.trial) await store.deleteChat(old.id).catch(() => {})
    const chat = await createChat(store, cardId, 0)
    playing.set(cardId, chat.id)
    try {
      await store.withChat(chat.id, async () => {
        const fresh = await store.getChat(chat.id)
        fresh.trial = true
        fresh.title = msg`试玩体检：${card.name}`
        if (session.model) fresh.model = session.model
        await store.saveChat(fresh)
      })
      const played = await store.getChat(chat.id)
      const held = await needsOf(card, played)
      const opening = Object.values(played.nodes).find(node => node.role === 'assistant')
      const start = opening?.state ?? {}
      const form = String(opening?.text ?? '').includes(CREATION_TAG) ? creationOf(card.regexScripts) : null
      const story = [{ you: '', reply: displayText(opening?.text ?? '') }]
      const done = []
      const intents = INTENT_ORDER[rounds] ?? INTENT_ORDER[DEFAULT_ROUNDS]
      let tip = opening.id
      let stopped = false
      for (let i = 0; i < rounds; i++) {
        if (ctx.signal.aborted) {
          stopped = true
          break
        }
        ctx.step(`round:${i + 1}:${rounds}:player`)
        // A card that opens on a form starts by filling it in, as a player would.
        const said = i === 0 && form ? { text: randomSheet(form) } : await ctx.call(playerRequest(card, story, intents[i]))
        const input = playerLine(said.text)
        if (!input) throw new Error(msg`${ctx.label} 没有写出玩家的话${cutNote(said)}，再试一次，或者换个模型`)
        ctx.step(`round:${i + 1}:${rounds}:reply`)
        const { nodeId, entry } = await round(ctx, played, tip, input, held).catch(error => {
          if (ctx.signal.aborted) stopped = true
          if (ctx.signal.aborted && done.length) return {}
          throw error
        })
        if (!entry) break
        tip = nodeId
        done.push({ ...entry, intent: intents[i] })
        story.push({ you: input, reply: entry.shown })
      }
      if (!done.length) throw httpError(499, msg`已停止`)
      let read = null
      if (!stopped && !ctx.signal.aborted) {
        ctx.step('review')
        const rules = standing(held.books).filter(entry => /每轮|规则|rule/i.test(entry.comment ?? '')).map(entry => entry.content).join('\n')
        const answer = await ctx.call(reviewRequest(card, done, { reply: ctx.languages.reply, rules }))
        read = readReview(answer.text, done.length)
      }
      const lines = summaryLines(done, { needs: held.needs, fields: held.fields, start, keyed: held.keyed })
      await ctx.update(fresh => {
        fresh.report = {
          at: new Date().toISOString(),
          model: ctx.label,
          asked: rounds,
          stopped,
          lines,
          summary: read?.summary ?? '',
          issues: read?.issues ?? [],
          unread: !stopped && !read,
          rounds: done.map(({ state, ...entry }) => entry),
          tokens: done.reduce((sum, entry) => ({ input: sum.input + entry.tokens.input, output: sum.output + entry.tokens.output }), { input: 0, output: 0 }),
        }
      })
    } finally {
      playing.delete(cardId)
      engine.stop(chat.id)
      await store.deleteChat(chat.id).catch(() => {})
    }
  }

  const change = (cardId, fn) =>
    serial(idOf(cardId), async () => {
      const { card, session } = await loadTrial(cardId)
      const out = await fn(card, session)
      await save(session)
      return out ?? view(card, session)
    })

  return {
    async trialGet(cardId) {
      const { card, session } = await loadTrial(cardId)
      return view(card, session)
    },

    /** The model to play on, and how many rounds. */
    trialUpdate(cardId, { model, rounds } = {}) {
      return change(cardId, (_, session) => {
        if (typeof model === 'string') session.model = model.trim().slice(0, 200)
        if (rounds !== undefined) session.rounds = cleanRounds(rounds)
      })
    },

    /** Play it: sent only by this, after the window has said about how much. */
    async trialRun(cardId) {
      const key = idOf(cardId)
      const session = await serial(key, async () => {
        if (jobs.has(key)) throw httpError(409, msg`这张卡正在试玩，等它玩完或先停下`)
        return (await loadTrial(cardId)).session
      })
      const rounds = cleanRounds(session.rounds)
      await run(session, 'trial', ctx => trialWork(ctx, cardId, rounds))
      const { card, session: fresh } = await loadTrial(cardId)
      return view(card, fresh)
    },

    trialStop(cardId) {
      const job = jobs.get(idOf(cardId))
      job?.controller.abort()
      if (playing.has(cardId)) engine.stop(playing.get(cardId))
      return { stopped: Boolean(job) }
    },

    trialRunning: cardId => jobs.has(idOf(cardId)),

    /** A deleted card's goes with it. */
    async dropTrial(cardId) {
      jobs.get(idOf(cardId))?.controller.abort()
      await removeFile(idOf(cardId))
    },
  }
}
