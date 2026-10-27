// How much of a model's context a chat fills, and when to compact it (自动压缩).
// The window comes from, in order: the player's own number for that model
// (settings.compaction.windows), what the provider's model list or an error
// said about it (model-context.json, learned), the table below, else a guess.
// The threshold leaves room for one more turn and for the archive itself:
// compacting means sending the whole history once more.

/** A model whose window nobody knows is taken to have this much. */
export const GUESSED_WINDOW = 128_000
// Room kept free below the window: the next turn's own message and reply, or the archive being written.
const RESERVE = 8_000
const RESERVE_SHARE = 0.15

export const COMPACTION_DEFAULTS = Object.freeze({ auto: true, percent: 70, cap: 150_000, windows: {} })

const tokens = value => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** settings.compaction as kept: auto on unless switched off, 30–95 %, a cap (0 = none), the player's windows. */
export function cleanCompaction(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const percent = Math.floor(Number(source.percent))
  const windows = {}
  if (source.windows && typeof source.windows === 'object') {
    for (const [ref, size] of Object.entries(source.windows)) {
      const n = tokens(size)
      if (typeof ref === 'string' && ref.length <= 260 && n >= 1_000 && n <= 100_000_000) windows[ref] = n
    }
  }
  return {
    auto: source.auto !== false,
    percent: Number.isFinite(percent) ? Math.min(95, Math.max(30, percent)) : COMPACTION_DEFAULTS.percent,
    cap: source.cap === 0 || source.cap === '0' ? 0 : tokens(source.cap) || COMPACTION_DEFAULTS.cap,
    windows,
  }
}

// Context windows as the vendors' own model pages gave them on 2026-10-27 (the maximum input where
// that is lower), matched against the model id in lower case with any "vendor/" prefix left off.
// The first match wins, so narrower patterns come first. A model not here is guessed (GUESSED_WINDOW).
const K = 1_024
const KNOWN = [
  // DeepSeek (api-docs.deepseek.com): V4 / V4.1, and the old names routed to them; older ones on relays.
  [/^deepseek-(flash|v4|chat|reasoner)/, 1_000_000],
  [/^deepseek/, 128_000],
  // Anthropic (platform.claude.com, context windows): the 5 family and 4.6 on have 1M by default.
  [/^claude-(fable|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-[6-9])/, 1_000_000],
  [/^claude/, 200_000],
  // OpenAI (developers.openai.com, models): the maximum input where it is less than the context.
  [/^gpt-(6|5\.6)/, 922_000],
  [/^gpt-5\.[45]-mini/, 272_000],
  [/^gpt-5\.[45]/, 1_050_000],
  [/^gpt-5/, 272_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o/, 128_000],
  [/^o3/, 200_000],
  // Google (ai.google.dev, models).
  [/^gemini-(3|2\.5)/, 1_048_576],
  // Moonshot (platform.kimi.ai): K3 1M, K2 256K.
  [/^kimi-k3/, 1_048_576],
  [/^kimi-k2/, 262_144],
  // Zhipu (docs.bigmodel.cn): GLM 5.2 on and 4-long 1M, 5 / 4.6–4.7 200K, other 4.x 128K.
  [/^glm-(5\.[2-9]|4-long)/, 1_000_000],
  [/^glm-(5|4\.[67])/, 200_000],
  [/^glm-4/, 128_000],
  // Alibaba (help.aliyun.com, Model Studio): the maximum input of the 1M models.
  [/^qwen-long/, 10_000_000],
  [/^qwen-max(-|$)/, 32 * K],
  [/^(qwen3\.[5-9]|qwen-(plus|flash))/, 991_808],
  // ByteDance Volcengine Ark (ark.volcengine.com, model list); endpoint ids (ep-…) name no model.
  [/^doubao-seed-(evolving|2-1-(pro|lite)-260915)/, 1_024 * K],
  [/^doubao-seed-2-1/, 256 * K],
  [/^doubao-seed-2-0/, 224 * K],
  [/^doubao-seed-character/, 96 * K],
  // MiniMax (platform.minimax.io).
  [/^minimax-m3/, 1_000_000],
  // xAI (docs.x.ai).
  [/^grok-4\.(5|6|7)/, 500_000],
  [/^grok-4\.(3|20)/, 1_000_000],
  [/^grok-build/, 256_000],
]

/** The table's window for a model id, or 0. */
export function knownWindow(modelId) {
  const id = String(modelId ?? '').toLowerCase().replace(/^.*\//, '')
  for (const [pattern, size] of KNOWN) if (pattern.test(id)) return size
  return 0
}

/**
 * The window of model `ref` ("provider/model", or a subscription model id): { tokens, source }.
 * source: 'set' (the player's), 'learned' (the provider's list or an error), 'table', 'guess'.
 */
export function windowOf(ref, { settings = {}, learned = {} } = {}) {
  const id = String(ref ?? '')
  const modelId = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const own = cleanCompaction(settings.compaction).windows[id]
  if (own) return { tokens: own, source: 'set' }
  const heard = tokens(learned[id]) || tokens(learned[modelId])
  if (heard) return { tokens: heard, source: 'learned' }
  const table = knownWindow(modelId)
  if (table) return { tokens: table, source: 'table' }
  return { tokens: GUESSED_WINDOW, source: 'guess' }
}

/** When to compact a chat on a model with `window` tokens: the share, under the cap, with room kept free. */
export function thresholdFor(window, compaction) {
  const { percent, cap } = cleanCompaction(compaction)
  const room = Math.max(RESERVE, Math.round(window * RESERVE_SHARE))
  let at = Math.round((window * percent) / 100)
  if (cap) at = Math.min(at, cap)
  return Math.max(1_000, Math.min(at, window - room))
}

/** What a model's context holds after `node`, a reply: its turn's whole input and the reply itself. */
export function contextUsed(node) {
  const usage = node?.usage
  if (!usage) return 0
  const write = Number(usage.cacheWrite) || (Number(usage.cacheWrite5m) || 0) + (Number(usage.cacheWrite1h) || 0)
  return (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + write + (Number(usage.output) || 0)
}

/** For the model menu and the page's meter: the window, where it came from, and the threshold. */
export function contextInfo(ref, options = {}) {
  const window = windowOf(ref, options)
  return { window: window.tokens, source: window.source, threshold: thresholdFor(window.tokens, options.settings?.compaction) }
}

// A provider's "too long" error with its limit in it, as the vendors word it.
const LIMIT_SAYS = [
  /maximum context length is (\d[\d,]*)/i,
  /context (?:window|length) (?:is|of) (\d[\d,]*)/i,
  /model token limit[^\d]{0,12}(\d[\d,]*)/i,
  /maximum number of tokens allowed \((\d[\d,]*)\)/i,
  /tokens? > (\d[\d,]*) maximum/i,
  /range of input length should be \[\d+,\s*(\d[\d,]*)\]/i,
  /exceed model limit \((\d[\d,]*) tokens\)/i,
  /max(?:imum)? (?:input |context |prompt )?(?:length|tokens?)[^\d]{0,16}(\d[\d,]*)/i,
]

/** The window a context-full error names, or 0. */
export function limitFromError(message) {
  const text = String(message ?? '')
  for (const pattern of LIMIT_SAYS) {
    const found = pattern.exec(text)
    const n = found ? tokens(found[1].replace(/,/g, '')) : 0
    if (n >= 1_000 && n <= 100_000_000) return n
  }
  return 0
}
