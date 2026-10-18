// Custom model providers: external APIs configured like DSH's providers
// (protocol + base URL + key + model list). A chat whose model is
// `<providerId>/<modelId>` is generated over HTTP instead of through the
// Claude Agent SDK; the history is rebuilt from the chat tree each turn (see
// engine.mjs apiMessages), so prefix caching on the provider's side still
// applies: the system prompt and earlier turns are sent byte-identical.
//
// Keys live in <data>/providers.json and never leave the server: the UI only
// sees whether a key is set and its last four characters.
import http from 'node:http'
import https from 'node:https'
import { modelInfo } from './models.mjs'
import { httpError } from './store.mjs'

export const APIS = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const NO_PROXY = 'localhost,127.0.0.1,::1'
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_MAX = 8192
const TIMEOUT_MS = 10 * 60 * 1000

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A model reference is `<providerId>/<modelId>`; Claude subscription ids never contain `/`. */
export function isProviderRef(ref) {
  return typeof ref === 'string' && ref.includes('/')
}

export function providerRef(providerId, modelId) {
  return `${providerId}/${modelId}`
}

function slug(text) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return PROVIDER_ID.test(base) ? base : ''
}

/** An id for a provider named in Chinese: the site's name (api.deepseek.com → deepseek), or "local". */
function hostSlug(baseURL) {
  try {
    const host = new URL(baseURL).hostname
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return 'local'
    const parts = host.split('.')
    return slug(parts.length > 1 ? parts.at(-2) : parts[0])
  } catch {
    return ''
  }
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

function cleanBaseUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(text)
  } catch {
    throw httpError(400, 'Base URL 不是有效的地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'Base URL 只能是 http 或 https')
  if (url.username || url.password) throw httpError(400, 'Base URL 里不要带账号密码，密钥填在 API Key 里')
  return text
}

function intIn(value, min, max) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= min && n <= max ? n : 0
}

function cleanModels(list) {
  const seen = new Set()
  const models = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(isObject(item) ? item.id : item ?? '').trim()
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    const label = isObject(item) ? String(item.label ?? '').trim().slice(0, 60) : ''
    models.push({ id, ...(label && label !== id ? { label } : {}) })
  }
  return models
}

function cleanHeaders(value) {
  if (!isObject(value)) return {}
  const headers = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!HEADER_NAME.test(key)) throw httpError(400, `请求头名称不合法：${key}`)
    headers[key] = String(raw)
  }
  return headers
}

/**
 * Validate a provider from the settings form. A blank `apiKey` keeps the saved
 * key (the form never receives it); `clearKey` removes it.
 */
export function normalizeProvider(input, previous = null, taken = new Set()) {
  if (!isObject(input)) throw httpError(400, '供应商配置必须是对象')
  const name = String(input.name ?? '').trim().slice(0, 40)
  if (!name) throw httpError(400, '请填写供应商名称')
  const api = String(input.api ?? '')
  if (!APIS[api]) throw httpError(400, '不支持的接口类型')
  const typedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (/\s/.test(typedKey)) throw httpError(400, 'API Key 里不能有空格或换行')
  const apiKeyEnv = String(input.apiKeyEnv ?? '').trim()
  if (apiKeyEnv && !ENV_NAME.test(apiKeyEnv)) throw httpError(400, '环境变量名只能用字母、数字和下划线')
  const temperature = input.temperature === '' || input.temperature == null ? null : Number(input.temperature)
  if (temperature !== null && !(temperature >= 0 && temperature <= 2)) throw httpError(400, '温度要在 0 到 2 之间')
  const extraBody = input.extraBody == null || input.extraBody === '' ? null : input.extraBody
  if (extraBody !== null && !isObject(extraBody)) throw httpError(400, '额外请求参数必须是 JSON 对象')
  const models = cleanModels(input.models)
  if (!models.length) throw httpError(400, '至少填一个模型 ID')
  const baseURL = cleanBaseUrl(input.baseURL)
  return {
    id: previous?.id ?? uniqueId(slug(input.id) || slug(name) || hostSlug(baseURL) || 'provider', taken),
    name,
    api,
    baseURL,
    apiKey: typedKey || (input.clearKey ? '' : previous?.apiKey ?? ''),
    apiKeyEnv,
    proxy: input.proxy === 'direct' ? 'direct' : 'global',
    headers: cleanHeaders(input.headers),
    models,
    maxTokens: intIn(input.maxTokens, 1, 1_000_000),
    temperature,
    extraBody,
    // Anthropic prompt cache lifetime: '5m' (default) or '1h' (writes cost 2x instead of 1.25x,
    // but a turn read more than five minutes after the last one still hits).
    cacheTtl: input.cacheTtl === '1h' ? '1h' : '5m',
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  }
}

// ─── Import from DSH ────────────────────────────────────────────────────
// DSH keeps providers in a profile's cordis.patch.yml under the LLM plugin's
// `config.providers` ({ id: { api, baseURL, apiKeyEnv, displayName, models } }).
// Keys are not in that file (only env-variable names DSH resolves itself), so
// none are imported; the user pastes them here.

// Image and video generators are listed beside chat models; they cannot narrate.
const NOT_CHAT = /imagine|seedance|video|image|embedding|tts|whisper/i
// Mainland services: route around the proxy.
const DIRECT_HOSTS = /(^|\.)(volces\.com|stepfun\.com|deepseek\.com|moonshot\.cn|bigmodel\.cn|aliyuncs\.com|minimaxi\.com|baidubce\.com)$/i

function findProviderMap(node) {
  if (!node || typeof node !== 'object') return null
  if (isObject(node.providers) && Object.values(node.providers).some(p => isObject(p) && p.baseURL)) return node.providers
  for (const value of Object.values(node)) {
    const found = findProviderMap(value)
    if (found) return found
  }
  return null
}

/** Provider drafts (no keys) from a parsed DSH config; unsupported protocols are reported, not dropped silently. */
export function providersFromDsh(doc) {
  const map = findProviderMap(doc)
  if (!map) throw httpError(400, '没在 DSH 配置里找到模型供应商（providers）')
  const drafts = []
  const skipped = []
  for (const [id, config] of Object.entries(map)) {
    if (!isObject(config) || !APIS[config.api]) {
      skipped.push(`${id}（接口类型 ${config?.api ?? '未知'} 不支持）`)
      continue
    }
    const models = (Array.isArray(config.models) ? config.models : [])
      .map(m => (typeof m === 'string' ? { id: m } : { id: m?.id, label: m?.name && m.name !== m.id ? m.name : undefined }))
      .filter(m => m.id && !NOT_CHAT.test(m.id))
    if (!models.length) {
      skipped.push(`${id}（没有对话模型）`)
      continue
    }
    let host = ''
    try {
      host = new URL(config.baseURL).hostname
    } catch {
      // normalizeProvider reports the bad URL
    }
    drafts.push({
      id,
      name: String(config.displayName || id),
      api: config.api,
      baseURL: config.baseURL,
      proxy: DIRECT_HOSTS.test(host) ? 'direct' : 'global',
      headers: isObject(config.headers) ? config.headers : {},
      models,
    })
  }
  return { drafts, skipped }
}

/**
 * Merge DSH drafts into the saved list: a provider with the same id keeps its
 * key and gets the new address and models; others are added without a key.
 */
export function mergeDshProviders(saved, drafts) {
  const list = [...saved]
  const added = []
  const updated = []
  for (const draft of drafts) {
    const index = list.findIndex(p => p.id === draft.id)
    if (index >= 0) {
      const previous = list[index]
      list[index] = normalizeProvider({ ...previous, ...draft, apiKey: '' }, previous)
      updated.push(list[index].name)
    } else {
      const provider = normalizeProvider(draft, null, new Set(list.map(p => p.id)))
      list.push(provider)
      added.push(provider.name)
    }
  }
  return { list, added, updated }
}

/** Enough of a half-filled form to list the provider's models; the saved key fills a blank one. */
export const PROVIDERS_FORMAT = 'agent-tavern-providers'

/**
 * Every provider with its key, to move them to another device (the Android
 * app). Providers on this machine's loopback stay behind: on the other
 * device 127.0.0.1 is the device itself. The default model goes along when
 * its provider does.
 */
export function exportProviders(providers, defaultModel) {
  const kept = []
  const skipped = []
  for (const provider of providers) {
    let local = false
    try {
      local = isLoopbackHost(new URL(provider.baseURL).hostname)
    } catch {
      // A malformed address is not this machine's; keep it.
    }
    ;(local ? skipped : kept).push(provider)
  }
  const model = isProviderRef(defaultModel) && kept.some(p => defaultModel.startsWith(`${p.id}/`)) ? defaultModel : ''
  return {
    archive: { format: PROVIDERS_FORMAT, version: 1, exportedAt: new Date().toISOString(), defaultModel: model, providers: kept },
    skipped: skipped.map(p => p.name),
  }
}

/**
 * Merge an exportProviders archive into the saved list. The same id replaces
 * the saved provider (a key in the file wins, none keeps the saved one); new
 * ids are added under that id, so the archive's default model still points
 * at them. A provider that fails validation is reported, not fatal.
 */
export function importProviders(saved, archive) {
  if (!isObject(archive) || archive.format !== PROVIDERS_FORMAT || !Array.isArray(archive.providers)) {
    throw httpError(400, '这不是酒馆导出的供应商文件')
  }
  const list = [...saved]
  const added = []
  const updated = []
  const failed = []
  for (const input of archive.providers) {
    try {
      const index = list.findIndex(p => p.id === input?.id)
      if (index >= 0) {
        list[index] = normalizeProvider(input, list[index])
        updated.push(list[index].name)
      } else {
        const provider = normalizeProvider(input, null, new Set(list.map(p => p.id)))
        list.push(provider)
        added.push(provider.name)
      }
    } catch (error) {
      failed.push(`${String(input?.name ?? '未命名')}：${error.message}`)
    }
  }
  const defaultModel = isProviderRef(archive.defaultModel) && list.some(p => archive.defaultModel.startsWith(`${p.id}/`)) ? archive.defaultModel : ''
  return { list, added, updated, failed, defaultModel }
}

export function draftProvider(input, previous = null) {
  if (!isObject(input)) throw httpError(400, '供应商配置必须是对象')
  const api = String(input.api ?? previous?.api ?? '')
  if (!APIS[api]) throw httpError(400, '不支持的接口类型')
  const apiKeyEnv = String(input.apiKeyEnv ?? '').trim()
  return {
    id: previous?.id ?? 'draft',
    name: String(input.name ?? '').trim() || previous?.name || '供应商',
    api,
    baseURL: cleanBaseUrl(input.baseURL ?? previous?.baseURL),
    apiKey: (typeof input.apiKey === 'string' && input.apiKey.trim()) || previous?.apiKey || '',
    apiKeyEnv: ENV_NAME.test(apiKeyEnv) ? apiKeyEnv : '',
    proxy: input.proxy === 'direct' ? 'direct' : 'global',
    headers: cleanHeaders(input.headers),
    models: [],
  }
}

/** What the browser may see: no key, only whether one is set. */
export function publicProvider(provider, env = process.env) {
  const { apiKey, ...rest } = provider
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    keyHint: apiKey ? `…${apiKey.slice(-4)}` : '',
    envKeySet: Boolean(provider.apiKeyEnv && env[provider.apiKeyEnv]),
  }
}

/** The provider and model a reference points at; throws when the provider is gone. */
export function resolveRef(ref, providers) {
  const cut = ref.indexOf('/')
  const providerId = ref.slice(0, cut)
  const modelId = ref.slice(cut + 1)
  const provider = providers.find(p => p.id === providerId)
  if (!provider) throw httpError(400, `供应商「${providerId}」已经删除，换一个模型再试`)
  return { provider, modelId, ref }
}

/** Selector entries for every configured model. */
export function providerChoices(providers) {
  return providers.flatMap(provider =>
    provider.models.map(model => ({
      id: providerRef(provider.id, model.id),
      label: model.label || model.id,
      group: provider.name,
      provider: provider.id,
      listed: true,
    })),
  )
}

/** Readable name for a reference, e.g. "DeepSeek · deepseek-chat". */
export function refLabel(ref, providers) {
  if (!isProviderRef(ref)) return null
  const cut = ref.indexOf('/')
  const provider = providers.find(p => p.id === ref.slice(0, cut))
  const modelId = ref.slice(cut + 1)
  const model = provider?.models.find(m => m.id === modelId)
  return provider ? `${provider.name} · ${model?.label || modelId}` : ref
}

// ─── HTTP ───────────────────────────────────────────────────────────────

function apiKeyOf(provider, env = process.env) {
  return provider.apiKey || (provider.apiKeyEnv ? String(env[provider.apiKeyEnv] ?? '').trim() : '')
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

const agents = new Map()

/** Node's own proxy support (http.Agent `proxyEnv`), scoped to these requests only. */
function agentFor(url, proxy) {
  if (!proxy || isLoopbackHost(url.hostname)) return undefined
  const key = `${url.protocol}${proxy}`
  if (!agents.has(key)) {
    const Agent = url.protocol === 'https:' ? https.Agent : http.Agent
    agents.set(key, new Agent({ keepAlive: true, proxyEnv: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY } }))
  }
  return agents.get(key)
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}${suffix}`
}

/** Anthropic's base URL is usually given without `/v1`; accept both. */
function anthropicUrl(base, suffix) {
  return /\/v1$/.test(base) ? joinUrl(base, suffix) : joinUrl(base, `/v1${suffix}`)
}

function headersFor(provider, extra = {}) {
  const key = apiKeyOf(provider)
  const headers = { 'user-agent': 'agent-tavern/0.2.0', ...extra }
  if (provider.api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key) headers['x-api-key'] = key
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }
  return { ...headers, ...provider.headers }
}

/** One request; resolves with the response once headers arrive. */
function send(target, { method = 'GET', headers, body, rawBody, signal, proxy }) {
  const url = new URL(target)
  const lib = url.protocol === 'https:' ? https : http
  if (rawBody) return sendPayload(lib, url, { method, headers, payload: rawBody, signal, proxy })
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return sendPayload(lib, url, {
    method,
    headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    payload,
    signal,
    proxy,
  })
}

function sendPayload(lib, url, { method, headers, payload, signal, proxy }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const req = lib.request(url, {
      method,
      agent: agentFor(url, proxy),
      headers,
      timeout: TIMEOUT_MS,
    })
    const onAbort = () => req.destroy(abortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('response', res => {
      res.on('close', () => signal?.removeEventListener('abort', onAbort))
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', error => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.end(payload)
  })
}

function abortError() {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

async function readText(res, limit = 64 * 1024) {
  let text = ''
  res.setEncoding('utf8')
  for await (const chunk of res) {
    if (text.length < limit) text += chunk
  }
  return text.slice(0, limit)
}

function errorMessage(text) {
  try {
    const json = JSON.parse(text)
    const message = json.error?.message ?? json.error ?? json.message ?? json.detail
    if (message) return typeof message === 'string' ? message : JSON.stringify(message)
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').trim()
}

async function failIfBad(res) {
  if (res.statusCode >= 200 && res.statusCode < 300) return
  const message = errorMessage(await readText(res, 4096)).slice(0, 300)
  const error = new Error(`${res.statusCode} ${message || res.statusMessage || ''}`.trim())
  error.providerStatus = res.statusCode
  throw error
}

/** Server-sent events → { event, data } (data joined, not parsed). */
async function* sse(res) {
  res.setEncoding('utf8')
  let buffer = ''
  for await (const chunk of res) {
    buffer += chunk
    let cut
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
      let event = ''
      const data = []
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) yield { event, data: data.join('\n') }
    }
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ─── Protocols ──────────────────────────────────────────────────────────
// Each returns { text, usage: { input, cacheRead, cacheWrite, output }, model, stopReason, reasoned }.
// `input` counts uncached prompt tokens only, as in the SDK usage.

function openaiUsage(usage) {
  if (!usage) return null
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  return { input: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: usage.completion_tokens ?? usage.output_tokens ?? 0 }
}

// `reasoned`: the model thought before answering (its thinking is not part of `text`).
const thoughtTokens = usage => (usage?.completion_tokens_details ?? usage?.output_tokens_details)?.reasoning_tokens > 0

async function openaiCompletions(provider, request, res) {
  let text = ''
  let usage = null
  let model = null
  let stopReason = null
  let reasoned = false
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    const message = json.choices?.[0]?.message
    text = message?.content ?? ''
    if (text) request.onDelta?.(text)
    reasoned = Boolean(message?.reasoning_content || message?.reasoning) || thoughtTokens(json.usage)
    return { text, usage: openaiUsage(json.usage), model: json.model ?? null, stopReason: json.choices?.[0]?.finish_reason ?? null, reasoned }
  }
  for await (const { data } of sse(res)) {
    if (data === '[DONE]') break
    const json = parseJson(data)
    if (!json) continue
    if (json.error) throw new Error(errorMessage(JSON.stringify(json)))
    model ??= json.model ?? null
    if (json.usage) usage = openaiUsage(json.usage)
    if (thoughtTokens(json.usage)) reasoned = true
    const choice = json.choices?.[0]
    if (choice?.delta?.reasoning_content || choice?.delta?.reasoning) reasoned = true
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta) {
      text += delta
      request.onDelta?.(delta)
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason
  }
  return { text, usage, model, stopReason, reasoned }
}

async function openaiResponses(provider, request, res) {
  let text = ''
  let usage = null
  let model = null
  let stopReason = null
  let reasoned = false
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    text = (json.output ?? []).flatMap(item => item.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('')
    if (text) request.onDelta?.(text)
    reasoned = (json.output ?? []).some(item => item.type === 'reasoning') || thoughtTokens(json.usage)
    return { text, usage: openaiUsage(json.usage), model: json.model ?? null, stopReason: json.status ?? null, reasoned }
  }
  for await (const { data } of sse(res)) {
    const json = parseJson(data)
    if (!json) continue
    if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
      text += json.delta
      request.onDelta?.(json.delta)
    } else if (json.type === 'response.completed' || json.type === 'response.incomplete') {
      usage = openaiUsage(json.response?.usage)
      model = json.response?.model ?? model
      stopReason = json.response?.incomplete_details?.reason ?? json.response?.status ?? null
      if (thoughtTokens(json.response?.usage)) reasoned = true
    } else if (json.type === 'response.failed' || json.type === 'error') {
      throw new Error(json.response?.error?.message ?? json.message ?? json.error?.message ?? '生成失败')
    } else if (json.type === 'response.created') {
      model = json.response?.model ?? model
    } else if (/^response\.reasoning/.test(json.type ?? '') || json.item?.type === 'reasoning') {
      reasoned = true
    }
  }
  return { text, usage, model, stopReason, reasoned }
}

async function anthropicMessages(provider, request, res) {
  let text = ''
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let seenUsage = false
  let model = null
  let stopReason = null
  let reasoned = false
  const takeUsage = u => {
    if (!u) return
    seenUsage = true
    if (u.input_tokens != null) usage.input = u.input_tokens
    if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens
    if (u.output_tokens != null) usage.output = u.output_tokens
  }
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    text = (json.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    if (text) request.onDelta?.(text)
    takeUsage(json.usage)
    reasoned = (json.content ?? []).some(b => /thinking/.test(b.type ?? ''))
    return { text, usage: seenUsage ? usage : null, model: json.model ?? null, stopReason: json.stop_reason ?? null, reasoned }
  }
  for await (const { data } of sse(res)) {
    const json = parseJson(data)
    if (!json) continue
    if (json.type === 'message_start') {
      model = json.message?.model ?? null
      takeUsage(json.message?.usage)
    } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      text += json.delta.text
      request.onDelta?.(json.delta.text)
    } else if (json.type === 'content_block_start' && /thinking/.test(json.content_block?.type ?? '')) {
      reasoned = true
    } else if (json.type === 'message_delta') {
      takeUsage(json.usage)
      stopReason = json.delta?.stop_reason ?? stopReason
    } else if (json.type === 'error') {
      throw new Error(json.error?.message ?? '生成失败')
    }
  }
  return { text, usage: seenUsage ? usage : null, model, stopReason, reasoned }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The catalog entry behind a relay's id: "anthropic/claude-opus-5.5", "claude-opus-4-6-20260201". */
function claudeInfo(modelId) {
  const id = String(modelId).split('/').pop().replace(/[:[].*$/, '').replace(/(\d)\.(\d)/g, '$1-$2')
  return modelInfo(id)
}

/**
 * The 思考 / 努力程度 settings in a protocol's own fields. Anthropic: only for
 * Claude models the catalog knows, within each one's rules (Opus 5.5 / Fable
 * 5.1 always think; Sonnet 5.5 turns thinking off with `between_tools`;
 * thinking off allows at most `high`). OpenAI: the effort only, `max` as
 * `xhigh`. {} when there is nothing to send.
 */
export function reasoningFields(api, modelId, { thinking, effort } = {}) {
  if (api === 'anthropic-messages') {
    const info = claudeInfo(modelId)
    if (!info || info.thinking === 'budget') return {}
    let level = info.effort.includes(effort) ? effort : null
    const fields = {}
    if (thinking === 'adaptive' || info.thinking === 'always') {
      fields.thinking = { type: 'adaptive' }
    } else {
      if (level === 'xhigh' || level === 'max') level = 'high'
      fields.thinking = { type: info.id === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled' }
    }
    if (level) fields.output_config = { effort: level }
    return fields
  }
  const level = effort === 'max' ? 'xhigh' : EFFORTS.includes(effort) ? effort : null
  if (!level) return {}
  return api === 'openai-responses' ? { reasoning: { effort: level } } : { reasoning_effort: level }
}

// Provider + model pairs that refused the reasoning fields once: sent without them from then on.
const NO_REASONING = new Set()
const REASONING_REFUSED = /thinking|effort|reasoning|output_config|extra inputs|unknown (field|param)|unrecognized|not (supported|permitted|allowed)|unsupported/i

function requestBody(provider, modelId, { system, messages, maxTokens: cap, reasoning }, { ttl = provider.cacheTtl, withReasoning = true } = {}) {
  // A request may cap its own output (short helper calls); otherwise the provider's setting.
  const maxTokens = cap || provider.maxTokens
  const common = {
    ...(provider.temperature !== null && provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
    // The app's thinking settings; the provider's own extra parameters below win over them.
    ...(withReasoning && reasoning ? reasoningFields(provider.api, modelId, reasoning) : {}),
  }
  if (provider.api === 'anthropic-messages') {
    // One breakpoint on the system prompt and one on the newest message: each
    // request reads the previous request's cached prefix and extends it. A message
    // marked `cache` (the newest one later turns will not rewrite) gets a third.
    const last = messages.length - 1
    const cache = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    return {
      model: modelId,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX,
      system: [{ type: 'text', text: system, cache_control: cache }],
      messages: messages.map((m, i) =>
        i === last || m.cache ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: cache }] } : { role: m.role, content: m.content },
      ),
      stream: true,
      ...common,
      ...(provider.extraBody ?? {}),
    }
  }
  if (provider.api === 'openai-responses') {
    return {
      model: modelId,
      instructions: system,
      input: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...common,
      ...(provider.extraBody ?? {}),
    }
  }
  return {
    model: modelId,
    messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
    stream: true,
    stream_options: { include_usage: true },
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...common,
    ...(provider.extraBody ?? {}),
  }
}

const PROTOCOL = {
  'openai-completions': { path: base => joinUrl(base, '/chat/completions'), read: openaiCompletions },
  'openai-responses': { path: base => joinUrl(base, '/responses'), read: openaiResponses },
  'anthropic-messages': { path: base => anthropicUrl(base, '/messages'), read: anthropicMessages },
}

/**
 * Stream one completion.
 * @param request - { system, messages: [{ role: 'user'|'assistant', content }], maxTokens?, signal, onDelta }
 * @param proxy - the app's proxy URL, or null; ignored when the provider is set to direct.
 */
export async function complete(provider, modelId, request, { proxy = null } = {}) {
  const protocol = PROTOCOL[provider.api]
  if (!protocol) throw new Error(`不支持的接口类型：${provider.api}`)
  if (!apiKeyOf(provider) && !Object.keys(provider.headers ?? {}).length) {
    const local = isLoopbackHost(new URL(provider.baseURL).hostname)
    if (!local) throw httpError(400, `供应商「${provider.name}」还没有填 API Key`)
  }
  const pair = `${provider.id}/${modelId}`
  const reasoning = !NO_REASONING.has(pair) && request.reasoning && Object.keys(reasoningFields(provider.api, modelId, request.reasoning)).length > 0
  const short = request.maxTokens > 0 && request.maxTokens < THINKING_ROOM
  const attempt = async () => {
    // Room to think on top of a short cap, given up like a preset's length if the model refuses it.
    const req = short && THINKERS.has(pair) ? { ...request, maxTokens: request.maxTokens + THINKING_ROOM, softCap: true } : request
    const post = (options, body = req) =>
      send(protocol.path(provider.baseURL), {
        method: 'POST',
        headers: headersFor(provider, { accept: 'text/event-stream' }),
        body: requestBody(provider, modelId, body, { withReasoning: reasoning, ...options }),
        signal: request.signal,
        proxy: provider.proxy === 'direct' ? null : proxy,
      })
    let res = await post()
    try {
      await failIfBad(res)
    } catch (error) {
      if (request.signal?.aborted || error.providerStatus !== 400) throw error
      // A relay that does not know the 1-hour cache field: send the default lifetime instead.
      const ttlRejected = provider.api === 'anthropic-messages' && provider.cacheTtl === '1h' && /ttl|cache_control|extra inputs/i.test(error.message)
      // A preset's output length above what the model allows: fall back to the provider's own.
      // The output limit counts against the context window too: a long history plus a big cap
      // can overflow where the provider's own smaller default fits.
      const full = CONTEXT_FULL.test(error.message)
      const capRejected = req.softCap && (full || /max_?(output_|completion_)?tokens|maximum.*tokens|output.*limit/i.test(error.message))
      // A model or relay that takes no thinking / effort fields: leave them out, now and later.
      const reasoningRejected = reasoning && REASONING_REFUSED.test(error.message)
      if (!ttlRejected && !capRejected && !reasoningRejected) throw contextHint(error)
      if (reasoningRejected) NO_REASONING.add(pair)
      res = await post({ ...(ttlRejected ? { ttl: '5m' } : {}), ...(reasoningRejected ? { withReasoning: false } : {}) }, capRejected ? { ...req, maxTokens: undefined } : req)
      await failIfBad(res).catch(retryError => { throw contextHint(retryError) })
    }
    const result = await protocol.read(provider, request, res)
    return { ...result, truncated: TRUNCATED.test(String(result.stopReason ?? '')) }
  }
  const first = await attempt()
  if (!short || THINKERS.has(pair) || !first.truncated || !first.reasoned) return first
  // Its thinking used up a short cap: room for it from now on, and once more
  // now when nothing of the answer came (a started one is already on screen).
  THINKERS.add(pair)
  if (first.text.trim() || request.signal?.aborted) return first
  const second = await attempt()
  return { ...second, usage: addUsage(first.usage, second.usage) }
}

// Models that think before answering count the thinking against the output cap
// (DeepSeek's flash thinks by default), so a short cap can run out before the
// answer starts. A pair seen doing that gets this much more on short caps.
const THINKERS = new Set()
const THINKING_ROOM = 16000

/** Two calls' tokens as one. */
const addUsage = (a, b) => (a && b ? Object.fromEntries(Object.keys(b).map(key => [key, (a[key] ?? 0) + (b[key] ?? 0)])) : b ?? a)

// A request longer than the model's context window, as providers word it.
export const CONTEXT_FULL = /context (window|length)|prompt is too long|too many tokens|maximum context|exceeds? the (model's )?(context|maximum)/i

/** Say what to do when the conversation no longer fits. */
function contextHint(error) {
  if (CONTEXT_FULL.test(error.message)) error.message += '（这段对话太长，超出了模型一次能读的上下文。点顶栏「压缩上下文」把前面的剧情压成存档，再接着写。）'
  return error
}

// Stop reasons meaning the output hit its length limit (Anthropic, Chat Completions, Responses).
const TRUNCATED = /^(max_tokens|length|max_output_tokens)$/

async function readBuffer(res, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error('响应太大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Any other endpoint of a provider (images, audio): `suffix` is appended to
 * the base URL; `body` is JSON or a { contentType, buffer } multipart payload.
 * Resolves with { contentType, buffer }; non-2xx throws like complete().
 */
export async function providerRequest(provider, suffix, { method = 'POST', body, signal, proxy = null } = {}) {
  const url = joinUrl(provider.baseURL, suffix)
  const raw = body && Buffer.isBuffer(body.buffer)
  const res = await send(url, {
    method,
    headers: headersFor(provider, raw ? { 'content-type': body.contentType, 'content-length': body.buffer.length } : {}),
    rawBody: raw ? body.buffer : undefined,
    body: raw ? undefined : body,
    signal,
    proxy: provider.proxy === 'direct' ? null : proxy,
  })
  await failIfBad(res)
  return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
}

/** GET a URL (an image a provider links to, a local service) as bytes. */
export async function fetchBytes(url, { headers = {}, signal, proxy = null } = {}) {
  const res = await send(url, { headers, signal, proxy })
  await failIfBad(res)
  return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
}

/** POST JSON to a URL (local services such as ComfyUI or the voice bridge). */
export async function postJson(url, body, { signal, proxy = null, headers = {} } = {}) {
  const res = await send(url, { method: 'POST', headers, body, signal, proxy })
  await failIfBad(res)
  return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
}

/** Model ids the provider lists (GET /models). No model is called. */
export async function listRemoteModels(provider, { proxy = null, signal } = {}) {
  const target = provider.api === 'anthropic-messages' ? anthropicUrl(provider.baseURL, '/models?limit=1000') : joinUrl(provider.baseURL, '/models')
  const res = await send(target, { headers: headersFor(provider, { accept: 'application/json' }), signal, proxy: provider.proxy === 'direct' ? null : proxy })
  await failIfBad(res)
  const json = parseJson(await readText(res, 4 * 1024 * 1024))
  const list = Array.isArray(json) ? json : json?.data ?? json?.models ?? []
  return [...new Set(list.map(item => (typeof item === 'string' ? item : item?.id ?? item?.name)).filter(id => typeof id === 'string' && id))]
    .map(id => id.replace(/^models\//, ''))
    .sort((a, b) => a.localeCompare(b))
}

/** Plain-language provider errors. */
export function providerError(provider, error) {
  const text = String(error?.message ?? error ?? '')
  const status = error?.providerStatus
  const name = provider?.name ?? '供应商'
  if (status === 401 || status === 403) return `${name} 拒绝了请求：API Key 无效或没有权限。（${text.slice(0, 160)}）`
  if (status === 404) return `${name} 返回 404：检查 Base URL 和接口类型，或者模型 ID 是否写对。（${text.slice(0, 160)}）`
  if (status === 429) return `${name} 限流或额度用完了，稍后再试。（${text.slice(0, 160)}）`
  if (status >= 500) return `${name} 服务出错，稍后重试。（${text.slice(0, 160)}）`
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|请求超时/i.test(text)) {
    return `连不上 ${name}：检查 Base URL、网络和代理设置。（${text.slice(0, 160)}）`
  }
  return `${name}：${text.slice(0, 240)}`
}
