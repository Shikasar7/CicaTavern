// Claude model catalog: current model versions with per-model request rules
// (thinking, effort) and the API list prices used for an "API-equivalent"
// cost estimate.
// Prices: Anthropic first-party API, USD per million tokens (cached 2026-09-25).
// The estimate only helps compare; providers bill by their own prices.

const M = 1_000_000

// thinking: 'optional' → can be turned off; 'always' → thinking cannot be
// disabled (send adaptive, steer with effort); 'budget' → no adaptive / effort.
const CATALOG = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', input: 2, output: 10, cacheRead: 0.2, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', input: 4, output: 20, cacheRead: 0.2, thinking: 'always', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // Haiku 5.5: thinking off only at effort high or below (requestOptions / reasoningFields cap it); prompts over 100K tokens cost 5x.
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', family: 'haiku', input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 }, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', input: 1, output: 5, thinking: 'budget', effort: [] },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', input: 10, output: 50, cacheRead: 0.25, thinking: 'always', effort: ['low', 'medium', 'high', 'xhigh', 'max'], extraCredits: true },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus', input: 5, output: 25, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', input: 5, output: 25, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', input: 5, output: 25, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus', input: 5, output: 25, thinking: 'optional', effort: ['low', 'medium', 'high', 'max'] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet', input: 2, output: 10, thinking: 'optional', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', input: 3, output: 15, thinking: 'optional', effort: ['low', 'medium', 'high', 'max'] },
]

const ALIASES = { default: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5' }

/** Normalise dated / suffixed ids (claude-haiku-4-5-20251001, …[1m]) to a catalog id. */
export function canonicalModel(id) {
  const text = String(id ?? '').replace(/\[.*\]$/, '').trim()
  if (ALIASES[text]) return ALIASES[text]
  const exact = CATALOG.find(m => m.id === text)
  if (exact) return exact.id
  const dated = CATALOG.find(m => text.startsWith(`${m.id}-`))
  return dated ? dated.id : text
}

export function modelInfo(id) {
  return CATALOG.find(m => m.id === canonicalModel(id)) ?? null
}

/**
 * API-equivalent cost of one turn. Cache writes are priced by TTL (5 min 1.25×,
 * 1 h 2× input); cache reads at the model's listed rate or 0.1× input.
 */
export function estimateCost(model, usage) {
  const found = modelInfo(model)
  if (!found || !usage) return null
  // Long-prompt rates (Haiku 5.5) apply to the whole request once the prompt passes the threshold.
  const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const info = found.long && prompt > found.long.above ? { ...found, input: found.long.input, output: found.long.output, cacheRead: undefined } : found
  const read = info.cacheRead ?? info.input * 0.1
  const write1h = usage.cacheWrite1h ?? 0
  const write5m = usage.cacheWrite5m ?? Math.max(0, (usage.cacheWrite ?? 0) - write1h)
  return (
    ((usage.input ?? 0) * info.input +
      (usage.cacheRead ?? 0) * read +
      write5m * info.input * 1.25 +
      write1h * info.input * 2 +
      (usage.output ?? 0) * info.output) /
    M
  )
}

/** Every catalog entry (the subscription's model list is built from it). */
export function catalog() {
  return CATALOG
}
