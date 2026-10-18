// Usage ledger: one JSON line per finished turn and per subscription rate-limit
// event, in <data>/usage.jsonl. Independent of chats, so deleting a chat keeps
// its history in the statistics.
import { access, appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { estimateCost, modelInfo } from './models.mjs'
import { msg } from './i18n.mjs'

const DAY = 24 * 60 * 60 * 1000

function localDate(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Share of the prompt served from cache. */
export function hitRate(t) {
  const prompt = (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
  return prompt ? (t.cacheRead ?? 0) / prompt : null
}

function windowsOf(info) {
  const w = info?.unifiedWindows ?? {}
  const five = w.five_hour?.utilization ?? (info?.rateLimitType === 'five_hour' ? info?.utilization : undefined)
  const seven = w.seven_day?.utilization ?? (info?.rateLimitType === 'seven_day' ? info?.utilization : undefined)
  return { five: typeof five === 'number' ? five : null, seven: typeof seven === 'number' ? seven : null }
}

function add(target, t) {
  target.turns += 1
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) target[k] += t[k] ?? 0
  target.cost += t.cost ?? 0
}

const empty = () => ({ turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 })
const finish = s => ({ ...s, hit: hitRate(s), cost: Math.round(s.cost * 10000) / 10000 })

export function createLedger(store) {
  const file = path.join(store.dirs.root, 'usage.jsonl')
  // The ledger file is created once, from existing chats; concurrent callers share that.
  let ready = null
  const ensure = () => (ready ??= access(file).catch(() => backfill()))

  async function readAll() {
    await ensure()
    const text = await readFile(file, 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }

  /** First run: rebuild turn records from the chats already on disk. */
  async function backfill() {
    const lines = []
    for (const chat of await store.listChats()) {
      for (const node of Object.values(chat.nodes)) {
        if (node.role !== 'assistant' || !node.usage) continue
        lines.push(turnRecord(chat, node))
      }
    }
    lines.sort((a, b) => a.at - b.at)
    await appendFile(file, lines.map(l => `${JSON.stringify(l)}\n`).join(''), 'utf8')
  }

  function turnRecord(chat, node) {
    const u = node.usage
    return {
      type: 'turn',
      at: Date.parse(node.createdAt),
      chatId: chat.id,
      chatTitle: chat.title,
      cardId: chat.cardId,
      model: node.model ?? null,
      input: u.input ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      output: u.output ?? 0,
      cost: u.costUsd ?? estimateCost(node.model, u) ?? 0,
      firstTokenMs: node.timing?.firstTokenMs ?? null,
      totalMs: node.timing?.totalMs ?? null,
      forked: node.timing?.forked === true,
    }
  }

  return {
    file,
    async recordTurn(chat, node) {
      await ensure()
      await appendFile(file, `${JSON.stringify(turnRecord(chat, node))}\n`, 'utf8')
    },
    async recordRate(info) {
      const { five, seven } = windowsOf(info)
      if (five === null && seven === null) return
      await ensure()
      await appendFile(file, `${JSON.stringify({ type: 'rate', at: Date.now(), five, seven, status: info.status ?? null })}\n`, 'utf8')
    },

    /** Everything the usage dashboard shows, for the last `days` days. */
    async summary({ days = 7, chats = [] } = {}) {
      const entries = await readAll()
      const since = Date.now() - days * DAY
      const turns = entries.filter(e => e.type === 'turn' && e.at >= since)
      const today = localDate(Date.now())
      const titles = new Map(chats.map(c => [c.id, c.title]))

      const todayTotals = empty()
      const periodTotals = empty()
      const daily = new Map()
      const byModel = new Map()
      const byChat = new Map()
      for (const t of turns) {
        add(periodTotals, t)
        const date = localDate(t.at)
        if (date === today) add(todayTotals, t)
        if (!daily.has(date)) daily.set(date, { date, ...empty() })
        add(daily.get(date), t)
        const model = t.model ?? msg`未知`
        if (!byModel.has(model)) byModel.set(model, { model, label: modelInfo(model)?.label ?? model, ...empty() })
        add(byModel.get(model), t)
        if (!byChat.has(t.chatId)) byChat.set(t.chatId, { chatId: t.chatId, title: titles.get(t.chatId) ?? t.chatTitle ?? t.chatId, deleted: !titles.has(t.chatId), ...empty() })
        add(byChat.get(t.chatId), t)
      }
      const firstTokens = turns.map(t => t.firstTokenMs).filter(Number.isFinite).sort((a, b) => a - b)
      const rates = entries.filter(e => e.type === 'rate' && e.at >= since)
      return {
        days,
        today: finish(todayTotals),
        period: { ...finish(periodTotals), medianFirstTokenMs: firstTokens.length ? firstTokens[Math.floor(firstTokens.length / 2)] : null },
        turns: turns.slice(-40).map(t => ({ ...t, chatTitle: titles.get(t.chatId) ?? t.chatTitle, hit: hitRate(t) })),
        daily: [...daily.values()].map(finish),
        byModel: [...byModel.values()].map(finish).sort((a, b) => b.turns - a.turns),
        byChat: [...byChat.values()].map(finish).sort((a, b) => b.cost - a.cost).slice(0, 12),
        rate: rates.map(r => ({ at: r.at, five: r.five, seven: r.seven })),
        latestRate: rates.at(-1) ?? null,
      }
    },
  }
}
