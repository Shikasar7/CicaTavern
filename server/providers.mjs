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
import { msg } from './i18n.mjs'
import { estimateTokens } from './context.mjs'
import { accessToken, compactCredential, googleCredential } from './google-auth.mjs'

// A getter: the label is in the language of the page that asks.
export const APIS = {
  get 'openai-completions'() {
    return msg`OpenAI 兼容（Chat Completions）`
  },
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
    throw httpError(400, msg`Base URL 不是有效的地址`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, msg`Base URL 只能是 http 或 https`)
  if (url.username || url.password) throw httpError(400, msg`Base URL 里不要带账号密码，密钥填在 API Key 里`)
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
    if (!HEADER_NAME.test(key)) throw httpError(400, msg`请求头名称不合法：${key}`)
    headers[key] = String(raw)
  }
  return headers
}

/** A typed key: a Google JSON credential (Agent Platform) is kept whole, on one line. */
function cleanKey(value) {
  const typed = typeof value === 'string' ? value.trim() : ''
  if (typed.startsWith('{')) return compactCredential(typed)
  if (/\s/.test(typed)) throw httpError(400, msg`API Key 里不能有空格或换行`)
  return typed
}

/** Vertex AI's address names the Google Cloud project: the template's PROJECT_ID is filled in from the JSON credential. */
function withProject(baseURL, key) {
  const projectId = googleCredential(key)?.projectId
  return projectId ? baseURL.replace('/projects/PROJECT_ID/', `/projects/${encodeURIComponent(projectId)}/`) : baseURL
}

/**
 * Validate a provider from the settings form. A blank `apiKey` keeps the saved
 * key (the form never receives it); `clearKey` removes it.
 */
export function normalizeProvider(input, previous = null, taken = new Set()) {
  if (!isObject(input)) throw httpError(400, msg`供应商配置必须是对象`)
  const name = String(input.name ?? '').trim().slice(0, 40)
  if (!name) throw httpError(400, msg`请填写供应商名称`)
  const api = String(input.api ?? '')
  if (!APIS[api]) throw httpError(400, msg`不支持的接口类型`)
  const typedKey = cleanKey(input.apiKey)
  const apiKeyEnv = String(input.apiKeyEnv ?? '').trim()
  if (apiKeyEnv && !ENV_NAME.test(apiKeyEnv)) throw httpError(400, msg`环境变量名只能用字母、数字和下划线`)
  const temperature = input.temperature === '' || input.temperature == null ? null : Number(input.temperature)
  if (temperature !== null && !(temperature >= 0 && temperature <= 2)) throw httpError(400, msg`温度要在 0 到 2 之间`)
  const extraBody = input.extraBody == null || input.extraBody === '' ? null : input.extraBody
  if (extraBody !== null && !isObject(extraBody)) throw httpError(400, msg`额外请求参数必须是 JSON 对象`)
  const models = cleanModels(input.models)
  if (!models.length) throw httpError(400, msg`至少填一个模型 ID`)
  const apiKey = typedKey || (input.clearKey ? '' : previous?.apiKey ?? '')
  const baseURL = withProject(cleanBaseUrl(input.baseURL), apiKey)
  // gcloud's own login file names no project.
  if (baseURL.includes('/projects/PROJECT_ID/')) throw httpError(400, msg`把 Base URL 里的 PROJECT_ID 换成你的 Google Cloud 项目 ID（控制台顶部项目选择器里的「ID」）`)
  return {
    id: previous?.id ?? uniqueId(slug(input.id) || slug(name) || hostSlug(baseURL) || 'provider', taken),
    name,
    api,
    baseURL,
    apiKey,
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
  if (!map) throw httpError(400, msg`没在 DSH 配置里找到模型供应商（providers）`)
  const drafts = []
  const skipped = []
  for (const [id, config] of Object.entries(map)) {
    if (!isObject(config) || !APIS[config.api]) {
      skipped.push(msg`${id}（接口类型 ${config?.api ?? msg`未知`} 不支持）`)
      continue
    }
    const models = (Array.isArray(config.models) ? config.models : [])
      .map(m => (typeof m === 'string' ? { id: m } : { id: m?.id, label: m?.name && m.name !== m.id ? m.name : undefined }))
      .filter(m => m.id && !NOT_CHAT.test(m.id))
    if (!models.length) {
      skipped.push(msg`${id}（没有对话模型）`)
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
    // Saved under the id normalizeProvider made of it (DSH's DeepSeek → deepseek).
    const saved = slug(draft.id) || slug(draft.name) || hostSlug(draft.baseURL)
    const index = list.findIndex(p => p.id === draft.id || p.id === saved)
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

const originOf = url => {
  try {
    return new URL(String(url ?? '').trim()).origin
  } catch {
    return ''
  }
}

/**
 * Merge an exportProviders archive into the saved list. The same id replaces
 * the saved provider (a key in the file wins, none keeps the saved one, unless
 * the file moves it to another address: `keyless`, so the key is never sent
 * where a shared file points); new ids are added under that id, so the
 * archive's default model still points at them. A provider that fails
 * validation is reported, not fatal.
 */
export function importProviders(saved, archive) {
  if (!isObject(archive) || archive.format !== PROVIDERS_FORMAT || !Array.isArray(archive.providers)) {
    throw httpError(400, msg`这不是酒馆导出的供应商文件`)
  }
  const list = [...saved]
  const added = []
  const updated = []
  const failed = []
  const keyless = []
  for (const input of archive.providers) {
    try {
      const index = list.findIndex(p => p.id === input?.id)
      if (index >= 0) {
        const previous = list[index]
        const moved = !(typeof input.apiKey === 'string' && input.apiKey.trim()) && Boolean(previous.apiKey) && originOf(input.baseURL) !== originOf(previous.baseURL)
        list[index] = normalizeProvider(moved ? { ...input, clearKey: true } : input, previous)
        updated.push(list[index].name)
        if (moved) keyless.push(list[index].name)
      } else {
        const provider = normalizeProvider(input, null, new Set(list.map(p => p.id)))
        list.push(provider)
        added.push(provider.name)
      }
    } catch (error) {
      failed.push(msg`${String(input?.name ?? msg`未命名`)}：${error.message}`)
    }
  }
  const defaultModel = isProviderRef(archive.defaultModel) && list.some(p => archive.defaultModel.startsWith(`${p.id}/`)) ? archive.defaultModel : ''
  return { list, added, updated, failed, keyless, defaultModel }
}

export function draftProvider(input, previous = null) {
  if (!isObject(input)) throw httpError(400, '供应商配置必须是对象')
  const api = String(input.api ?? previous?.api ?? '')
  if (!APIS[api]) throw httpError(400, '不支持的接口类型')
  const apiKeyEnv = String(input.apiKeyEnv ?? '').trim()
  const apiKey = cleanKey(input.apiKey) || previous?.apiKey || ''
  return {
    id: previous?.id ?? 'draft',
    name: String(input.name ?? '').trim() || previous?.name || '供应商',
    api,
    baseURL: withProject(cleanBaseUrl(input.baseURL ?? previous?.baseURL), apiKey),
    apiKey,
    apiKeyEnv: ENV_NAME.test(apiKeyEnv) ? apiKeyEnv : '',
    proxy: input.proxy === 'direct' ? 'direct' : 'global',
    headers: cleanHeaders(input.headers),
    // Agent Platform with an API key checks the connection with the first one.
    models: cleanModels(input.models ?? previous?.models),
  }
}

/** A service account's address (…@<project>.iam.gserviceaccount.com) is no secret; gcloud's login names nobody. */
function keyHint(apiKey) {
  const cred = googleCredential(apiKey)
  if (cred?.kind === 'service_account') return cred.email
  if (cred) return msg`gcloud 登录凭据`
  return `…${apiKey.slice(-4)}`
}

/** What the browser may see: no key, only whether one is set. */
export function publicProvider(provider, env = process.env) {
  const { apiKey, ...rest } = provider
  return {
    ...rest,
    hasKey: Boolean(apiKey),
    keyHint: apiKey ? keyHint(apiKey) : '',
    envKeySet: Boolean(provider.apiKeyEnv && env[provider.apiKeyEnv]),
  }
}

/** The provider and model a reference points at; throws when the provider is gone. */
export function resolveRef(ref, providers) {
  const cut = ref.indexOf('/')
  const providerId = ref.slice(0, cut)
  const modelId = ref.slice(cut + 1)
  const provider = providers.find(p => p.id === providerId)
  if (!provider) throw httpError(400, msg`供应商「${providerId}」已经删除，换一个模型再试`)
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
      search: webSearchKind(provider, model.id),
    })),
  )
}

/**
 * 联网: the web search a provider runs itself, as SillyTavern's 「Enable web search」 turns it on.
 * 'openrouter': OpenRouter's web plugin (the `:online` variant of the model, on any interface);
 * 'anthropic': Anthropic's web_search tool, for Claude models; 'openai': the Responses API's
 * web_search tool. null: none we know of (plain Chat Completions has no common field for it).
 */
export function webSearchKind(provider, modelId = '') {
  let host = ''
  try {
    host = new URL(provider.baseURL).hostname
  } catch {
    return null
  }
  if (/(^|\.)openrouter\.ai$/i.test(host)) return 'openrouter'
  if (provider.api === 'anthropic-messages') return /claude/i.test(String(modelId)) ? 'anthropic' : null
  if (provider.api === 'openai-responses') return 'openai'
  return null
}

// At most this many searches in one reply (Anthropic's max_uses).
const SEARCHES_PER_REPLY = 5

/** What a reply's searches leave: how many, what was asked, the pages it drew on (cited first). */
function searchLog() {
  const log = { count: 0, queries: [], sources: [], cited: new Set() }
  const add = (url, title, cited = false) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    const known = log.sources.find(source => source.url === url)
    if (known) {
      if (!known.title && title) known.title = String(title).slice(0, 200)
    } else if (log.sources.length < 40) {
      log.sources.push({ url: url.slice(0, 2000), title: title ? String(title).slice(0, 200) : '' })
    }
    if (cited) log.cited.add(url)
  }
  return {
    log,
    searched: () => log.count++,
    asked: query => {
      if (typeof query === 'string' && query.trim() && log.queries.length < 20) log.queries.push(query.trim().slice(0, 300))
    },
    found: (url, title) => add(url, title),
    cited: (url, title) => add(url, title, true),
    result: () => {
      if (!log.count && !log.sources.length) return null
      const sources = [...log.sources.filter(source => log.cited.has(source.url)), ...log.sources.filter(source => !log.cited.has(source.url))].slice(0, 12)
      return { count: Math.max(log.count, log.queries.length), queries: log.queries, sources }
    },
  }
}

/**
 * Text written before the last search is the model saying what it will look up ("让我查一下"),
 * not story: dropped when it is that short. `cut` is where the text stood when the last results came.
 */
function afterSearch(text, cut) {
  if (cut <= 0 || text.slice(0, cut).trim().length >= 400) return text
  return text.slice(cut).replace(/^\s+/, '')
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

/** This machine or the local network: private and link-local addresses, *.local, a name with no dot. */
function isLocalNetworkHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopbackHost(host) || host.endsWith('.local') || (!host.includes('.') && !host.includes(':'))) return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  // IPv6: unique local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
}

const agents = new Map()

/** Node's own proxy support (http.Agent `proxyEnv`), scoped to these requests (and the updater's) only. */
export function agentFor(url, proxy) {
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

/** Trade a signed JWT for a token at Google's address (google-auth.mjs), through the provider's proxy. */
async function postForm(url, form, { proxy = null, signal } = {}) {
  const payload = Buffer.from(form, 'utf8')
  const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': payload.length }, rawBody: payload, signal, proxy })
  return { status: res.statusCode, text: await readText(res) }
}

/** What goes after `Bearer`: the key, or for a Google JSON credential (Agent Platform) an access token made from it. */
async function bearerOf(provider, { proxy = null, signal } = {}) {
  const key = apiKeyOf(provider)
  return googleCredential(key) ? accessToken(key, postForm, { proxy: provider.proxy === 'direct' ? null : proxy, signal }) : key
}

async function headersFor(provider, extra = {}, options = {}) {
  const key = await bearerOf(provider, options)
  const headers = { 'user-agent': 'agent-tavern/0.2.0', ...extra }
  if (provider.api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key) headers['x-api-key'] = key
  } else if (key && agentPlatformKey(provider)) {
    headers['x-goog-api-key'] = key
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }
  return { ...headers, ...provider.headers }
}

/**
 * Agent Platform (Vertex AI) with an API key rather than a JSON credential: its OpenAI-compatible
 * address takes the key in Google's own header and turns it away after `Bearer`.
 */
const agentPlatformKey = provider => isVertex(provider) && Boolean(apiKeyOf(provider)) && !googleCredential(apiKeyOf(provider))

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
    if (signal?.aborted) return reject(abortError(signal))
    const req = lib.request(url, {
      method,
      agent: agentFor(url, proxy),
      headers,
      timeout: TIMEOUT_MS,
    })
    const onAbort = () => req.destroy(abortError(signal))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('response', res => {
      res.on('close', () => signal?.removeEventListener('abort', onAbort))
      resolve(res)
    })
    req.on('timeout', () => req.destroy(Object.assign(new Error(msg`请求超时`), { code: 'ETIMEDOUT' })))
    req.on('error', error => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.end(payload)
  })
}

/** A stopped request; one stopped by its time running out (AbortSignal.timeout) says so, like a socket timeout. */
function abortError(signal) {
  const timedOut = signal?.reason?.name === 'TimeoutError'
  const error = new Error(timedOut ? msg`请求超时` : 'aborted')
  error.name = 'AbortError'
  if (timedOut) error.code = 'ETIMEDOUT'
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
  // Read already when it was looked at for a retry (a busy Vertex AI).
  const text = res.bodyText ?? (await readText(res))
  const message = errorMessage(text).slice(0, 300)
  const error = new Error(`${res.statusCode} ${message || res.statusMessage || ''}`.trim())
  error.providerStatus = res.statusCode
  if (res.busyRetried) error.hint = msg`（已经自动重试了 ${res.busyRetried} 次：这个模型这会儿比较挤，过一会再试，或者先换个模型。）`
  // All of it, for a caller that reads more than the message (ComfyUI's node_errors).
  error.body = text
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
// Each returns { text, usage: { input, cacheRead, cacheWrite, output, thinking? }, model, stopReason, reasoned }.
// `input` counts uncached prompt tokens only, as in the SDK usage. `thinking`: the part of `output` the model
// spent thinking (not sent back next turn, so not context): given by OpenAI-style APIs, worked out for Anthropic.

function openaiUsage(usage) {
  if (!usage) return null
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0
  const thinking = (usage.completion_tokens_details ?? usage.output_tokens_details)?.reasoning_tokens ?? 0
  return { input: Math.max(0, prompt - cached), cacheRead: cached, cacheWrite: 0, output: usage.completion_tokens ?? usage.output_tokens ?? 0, ...(thinking > 0 ? { thinking } : {}) }
}

/**
 * Anthropic counts thinking in output_tokens: its share, by the thinking text's length against the
 * answer's (a summarized or hidden thinking reads short, so this errs on keeping tokens as context).
 */
function withThinking(usage, thought, said) {
  if (!usage || !thought) return usage
  return { ...usage, thinking: Math.round((usage.output ?? 0) * (thought / (thought + Math.max(1, said)))) }
}

// `reasoned`: the model thought before answering (its thinking is not part of `text`).
const thoughtTokens = usage => (usage?.completion_tokens_details ?? usage?.output_tokens_details)?.reasoning_tokens > 0

// OpenRouter's web plugin answers with url_citation annotations (on the message, or on a delta).
function urlCitations(search, annotations) {
  for (const note of Array.isArray(annotations) ? annotations : []) {
    const cite = note?.url_citation ?? note
    if (note?.type === 'url_citation' || cite?.url) search.cited(cite.url, cite.title)
  }
}

async function openaiCompletions(provider, request, res) {
  let text = ''
  let usage = null
  let model = null
  let stopReason = null
  let reasoned = false
  const search = searchLog()
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    const message = json.choices?.[0]?.message
    text = message?.content ?? ''
    if (text) request.onDelta?.(text)
    reasoned = Boolean(message?.reasoning_content || message?.reasoning) || thoughtTokens(json.usage)
    urlCitations(search, message?.annotations)
    return { text, usage: openaiUsage(json.usage), model: json.model ?? null, stopReason: json.choices?.[0]?.finish_reason ?? null, reasoned, search: search.result() }
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
    urlCitations(search, choice?.delta?.annotations)
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta) {
      text += delta
      request.onDelta?.(delta)
    }
    if (choice?.finish_reason) stopReason = choice.finish_reason
  }
  return { text, usage, model, stopReason, reasoned, search: search.result() }
}

/** The searches in a Responses output: web_search_call items (what was asked) and the pages the text cites. */
function responsesSearch(search, output) {
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type === 'web_search_call') {
      search.asked(item.action?.query)
      for (const source of item.action?.sources ?? []) search.found(source?.url, source?.title)
    }
    for (const part of item?.content ?? []) for (const note of part?.annotations ?? []) if (note?.type === 'url_citation') search.cited(note.url, note.title)
  }
}

async function openaiResponses(provider, request, res) {
  let text = ''
  let usage = null
  let model = null
  let stopReason = null
  let reasoned = false
  const search = searchLog()
  let cut = 0
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    for (const item of json.output ?? []) {
      if (item.type === 'web_search_call') {
        search.searched()
        cut = text.length
      }
      for (const part of item.content ?? []) if (part.type === 'output_text') text += part.text
    }
    responsesSearch(search, json.output)
    text = afterSearch(text, cut)
    if (text) request.onDelta?.(text)
    reasoned = (json.output ?? []).some(item => item.type === 'reasoning') || thoughtTokens(json.usage)
    return { text, usage: openaiUsage(json.usage), model: json.model ?? null, stopReason: json.status ?? null, reasoned, search: search.result() }
  }
  for await (const { data } of sse(res)) {
    const json = parseJson(data)
    if (!json) continue
    if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
      text += json.delta
      request.onDelta?.(json.delta)
    } else if (json.type === 'response.output_item.added' && json.item?.type === 'web_search_call') {
      search.searched()
      cut = text.length
    } else if (json.type === 'response.output_text.annotation.added' && json.annotation?.type === 'url_citation') {
      search.cited(json.annotation.url, json.annotation.title)
    } else if (json.type === 'response.completed' || json.type === 'response.incomplete') {
      usage = openaiUsage(json.response?.usage)
      model = json.response?.model ?? model
      stopReason = json.response?.incomplete_details?.reason ?? json.response?.status ?? null
      if (thoughtTokens(json.response?.usage)) reasoned = true
      responsesSearch(search, json.response?.output)
    } else if (json.type === 'response.failed' || json.type === 'error') {
      throw new Error(json.response?.error?.message ?? json.message ?? json.error?.message ?? msg`生成失败`)
    } else if (json.type === 'response.created') {
      model = json.response?.model ?? model
    } else if (/^response\.reasoning/.test(json.type ?? '') || json.item?.type === 'reasoning') {
      reasoned = true
    }
  }
  return { text: afterSearch(text, cut), usage, model, stopReason, reasoned, search: search.result() }
}

/** A web_search_tool_result block's pages (an error result has none). */
function searchResults(search, block) {
  for (const result of Array.isArray(block?.content) ? block.content : []) if (result?.type === 'web_search_result') search.found(result.url, result.title)
}

async function anthropicMessages(provider, request, res) {
  let text = ''
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  let seenUsage = false
  let model = null
  let stopReason = null
  let reasoned = false
  const search = searchLog()
  let cut = 0
  let searches = 0
  const takeUsage = u => {
    if (!u) return
    seenUsage = true
    if (u.input_tokens != null) usage.input = u.input_tokens
    if (u.cache_read_input_tokens != null) usage.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) usage.cacheWrite = u.cache_creation_input_tokens
    if (u.output_tokens != null) usage.output = u.output_tokens
    if (u.server_tool_use?.web_search_requests != null) searches = u.server_tool_use.web_search_requests
  }
  const counted = () => {
    for (let n = search.log.count; n < searches; n++) search.searched()
    return search.result()
  }
  if (!/event-stream/.test(res.headers['content-type'] ?? '')) {
    const json = parseJson(await readText(res, 8 * 1024 * 1024)) ?? {}
    for (const block of json.content ?? []) {
      if (block.type === 'text') {
        text += block.text
        for (const cite of block.citations ?? []) search.cited(cite?.url, cite?.title)
      } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
        search.searched()
        search.asked(block.input?.query)
      } else if (block.type === 'web_search_tool_result') {
        searchResults(search, block)
        cut = text.length
      }
    }
    const raw = text
    text = afterSearch(text, cut)
    takeUsage(json.usage)
    checkSystemArrived(request, usage)
    if (text) request.onDelta?.(text)
    reasoned = (json.content ?? []).some(b => /thinking/.test(b.type ?? ''))
    const thought = (json.content ?? []).reduce((n, b) => n + String(b.thinking ?? '').length, 0)
    return { text, raw, cut, content: Array.isArray(json.content) ? json.content : [], usage: seenUsage ? withThinking(usage, thought, raw.length) : null, model: json.model ?? null, stopReason: json.stop_reason ?? null, reasoned, search: counted() }
  }
  const toolInput = new Map() // block index → the search's input JSON as it streams
  // The reply's content blocks rebuilt from the stream (a paused one is sent back as it came: pause_turn).
  const blocks = []
  const inputs = new Map() // block index → a tool block's input JSON as it streams
  const into = (index, change) => {
    if (blocks[index]) change(blocks[index])
  }
  for await (const { data } of sse(res)) {
    const json = parseJson(data)
    if (!json) continue
    if (json.type === 'content_block_start' && json.content_block) {
      blocks[json.index] = structuredClone(json.content_block)
      if (/tool_use$/.test(json.content_block.type ?? '')) inputs.set(json.index, '')
    } else if (json.type === 'content_block_delta') {
      const d = json.delta ?? {}
      if (d.type === 'text_delta') into(json.index, b => { b.text = (b.text ?? '') + d.text })
      else if (d.type === 'thinking_delta') into(json.index, b => { b.thinking = (b.thinking ?? '') + d.thinking })
      else if (d.type === 'signature_delta') into(json.index, b => { b.signature = d.signature })
      else if (d.type === 'citations_delta' && d.citation) into(json.index, b => { b.citations = [...(b.citations ?? []), d.citation] })
      else if (d.type === 'input_json_delta' && inputs.has(json.index)) inputs.set(json.index, inputs.get(json.index) + (d.partial_json ?? ''))
    } else if (json.type === 'content_block_stop' && inputs.has(json.index)) {
      const typed = inputs.get(json.index)
      if (typed) into(json.index, b => { b.input = parseJson(typed) ?? b.input ?? {} })
      inputs.delete(json.index)
    }
    if (json.type === 'message_start') {
      model = json.message?.model ?? null
      takeUsage(json.message?.usage)
      checkSystemArrived(request, usage)
    } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      text += json.delta.text
      request.onDelta?.(json.delta.text)
    } else if (json.type === 'content_block_delta' && json.delta?.type === 'citations_delta') {
      search.cited(json.delta.citation?.url, json.delta.citation?.title)
    } else if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta' && toolInput.has(json.index)) {
      toolInput.set(json.index, toolInput.get(json.index) + (json.delta.partial_json ?? ''))
    } else if (json.type === 'content_block_start' && json.content_block?.type === 'server_tool_use') {
      if (json.content_block.name === 'web_search') {
        search.searched()
        toolInput.set(json.index, '')
      }
    } else if (json.type === 'content_block_start' && json.content_block?.type === 'web_search_tool_result') {
      searchResults(search, json.content_block)
      cut = text.length
    } else if (json.type === 'content_block_stop' && toolInput.has(json.index)) {
      search.asked(parseJson(toolInput.get(json.index))?.query)
      toolInput.delete(json.index)
    } else if (json.type === 'content_block_start' && /thinking/.test(json.content_block?.type ?? '')) {
      reasoned = true
    } else if (json.type === 'message_delta') {
      takeUsage(json.usage)
      stopReason = json.delta?.stop_reason ?? stopReason
    } else if (json.type === 'error') {
      throw new Error(json.error?.message ?? msg`生成失败`)
    }
  }
  const thought = blocks.reduce((n, b) => n + String(b?.thinking ?? '').length, 0)
  // A relay that counts nothing until the end (message_start all zeros) shows the lost system prompt only now, the text out.
  const systemDropped = Boolean(request.expectPrompt) && checkSystemArrived(request, usage, { late: true })
  return { text: afterSearch(text, cut), raw: text, cut, content: blocks.filter(Boolean), usage: seenUsage ? withThinking(usage, thought, text.length) : null, model, stopReason, reasoned, search: counted(), ...(systemDropped ? { systemDropped } : {}) }
}

/** A reply that paused (pause_turn) and the rest the model wrote when given it back: one reply. */
function joinPaused(first, rest) {
  const raw = first.raw + rest.raw
  const cut = rest.cut > 0 ? first.raw.length + rest.cut : first.cut
  const sources = [...(first.search?.sources ?? []), ...(rest.search?.sources ?? [])].filter((s, i, all) => all.findIndex(o => o.url === s.url) === i)
  const search = first.search || rest.search
    ? { count: (first.search?.count ?? 0) + (rest.search?.count ?? 0), queries: [...(first.search?.queries ?? []), ...(rest.search?.queries ?? [])].slice(0, 20), sources: sources.slice(0, 12) }
    : null
  return {
    ...rest,
    text: afterSearch(raw, cut),
    raw,
    cut,
    content: [...first.content, ...rest.content],
    usage: addUsage(first.usage, rest.usage),
    model: rest.model ?? first.model,
    reasoned: first.reasoned || rest.reasoned,
    search,
  }
}

// How many times a reply paused mid-search is given back to carry on before it is kept as it is.
const PAUSED_ROUNDS = 3

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

// Models that are not Claude, as relays name them behind the Anthropic API.
const OTHER_MODELS = /deepseek|kimi|moonshot|qwen|qwq|glm|zhipu|gemini|gemma|gpt|o[134]-|grok|minimax|doubao|seed|step|mimo|hunyuan|ernie|baichuan|yi-|llama|mistral|mixtral|command/i

function requestBody(provider, modelId, { system, messages, maxTokens: cap, reasoning, webSearch }, { ttl = provider.cacheTtl, withReasoning = true } = {}) {
  // A request may cap its own output (short helper calls); otherwise the provider's setting.
  const maxTokens = cap || provider.maxTokens
  // 联网: OpenRouter searches for the `:online` variant; Anthropic and Responses get the search tool.
  const search = webSearch ? webSearchKind(provider, modelId) : null
  if (search === 'openrouter' && !/:online$/.test(modelId)) modelId = `${modelId}:online`
  const common = {
    ...(provider.temperature !== null && provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
    // The app's thinking settings; the provider's own extra parameters below win over them.
    ...(withReasoning && reasoning ? reasoningFields(provider.api, modelId, reasoning) : {}),
  }
  if (provider.api === 'anthropic-messages') {
    // One breakpoint on the system prompt and one on the newest message: each
    // request reads the previous request's cached prefix and extends it. A message
    // marked `cache` (the newest one later turns will not rewrite) gets a third.
    // The newest message of the conversation itself: a paused reply sent back after it (its blocks) has none.
    const last = messages.findLastIndex(m => !Array.isArray(m.content))
    const cache = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    // Only Claude takes the breakpoints. Relays that put other models (DeepSeek, Kimi…) behind this
    // API cache by themselves, and some drop the system prompt when a message comes as marked blocks.
    const marked = !OTHER_MODELS.test(modelId)
    return {
      model: modelId,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX,
      // An empty text block is refused, so a request without a system prompt has no system field.
      ...(String(system ?? '').trim() ? { system: marked ? [{ type: 'text', text: system, cache_control: cache }] : system } : {}),
      messages: messages.map((m, i) =>
        marked && !Array.isArray(m.content) && (i === last || m.cache) ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: cache }] } : { role: m.role, content: m.content },
      ),
      stream: true,
      ...(search === 'anthropic' ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCHES_PER_REPLY }] } : {}),
      ...common,
      ...(provider.extraBody ?? {}),
    }
  }
  if (provider.api === 'openai-responses') {
    return {
      model: modelId,
      ...(String(system ?? '').trim() ? { instructions: system } : {}),
      input: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      store: false,
      ...(search === 'openai' ? { tools: [{ type: 'web_search' }] } : {}),
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...common,
      ...(provider.extraBody ?? {}),
    }
  }
  return {
    model: modelId,
    messages: [...(String(system ?? '').trim() ? [{ role: 'system', content: system }] : []), ...messages.map(m => ({ role: m.role, content: m.content }))],
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
export async function complete(provider, modelId, original, { proxy = null } = {}) {
  const protocol = PROTOCOL[provider.api]
  if (!protocol) throw new Error(msg`不支持的接口类型：${provider.api}`)
  const dropped = SYSTEM_DROPPED.has(`${provider.id}/${modelId}`)
  // A relay seen dropping this model's system prompt: it goes in the first message from then on. Otherwise how
  // much input a long system prompt must come to, at the least (Anthropic says it before any text: readers check).
  const request = dropped ? systemInMessages(original) : provider.api === 'anthropic-messages' && String(original.system ?? '').length >= 1500 ? { ...original, expectPrompt: Math.round(estimateTokens(original.system) * 0.6) } : original
  if (!apiKeyOf(provider) && !Object.keys(provider.headers ?? {}).length) {
    // A model server on this machine or the local network (LM Studio, Ollama on another PC) needs none.
    const local = isLocalNetworkHost(new URL(provider.baseURL).hostname)
    if (!local) throw httpError(400, msg`供应商「${provider.name}」还没有填 API Key`)
  }
  const pair = `${provider.id}/${modelId}`
  // Kept apart with 联网 on: a relay may refuse thinking only alongside the search tool.
  const refusedKey = request.webSearch ? `${pair} 联网` : pair
  const reasoning = !NO_REASONING.has(refusedKey) && request.reasoning && Object.keys(reasoningFields(provider.api, modelId, request.reasoning)).length > 0
  const short = request.maxTokens > 0 && request.maxTokens < THINKING_ROOM
  const attempt = async () => {
    // Room to think on top of a short cap, given up like a preset's length if the model refuses it.
    const req = short && THINKERS.has(pair) ? { ...request, maxTokens: request.maxTokens + THINKING_ROOM, softCap: true } : request
    const post = async (options, body = req) => {
      for (let retry = 0; ; retry++) {
        const res = await send(protocol.path(provider.baseURL), {
          method: 'POST',
          headers: await headersFor(provider, { accept: 'text/event-stream' }, { proxy, signal: request.signal }),
          body: requestBody(provider, modelId, body, { withReasoning: reasoning, ...options }),
          signal: request.signal,
          proxy: provider.proxy === 'direct' ? null : proxy,
        })
        // Vertex AI's shared capacity full at that moment (429 Resource exhausted): Google's advice is to wait and
        // ask again, a little longer each time. Nothing of the answer has come yet, so asking again repeats nothing.
        if (res.statusCode !== 429 || !isVertex(provider)) return res
        res.bodyText = await readText(res)
        const wait = retry < BUSY_RETRIES ? busyWait(res, retry) : null
        if (wait === null) {
          res.busyRetried = retry
          return res
        }
        request.onRetry?.({ attempt: retry + 1, of: BUSY_RETRIES, wait })
        await pause(wait, request.signal)
      }
    }
    let res = await post()
    // What went out in the end (a refused field left out on the retry below): a paused reply is carried on the same way.
    let used = { options: {}, body: req }
    try {
      await failIfBad(res)
    } catch (error) {
      if (request.signal?.aborted) throw error
      if (error.providerStatus !== 400) throw searchHint(error, request)
      // A relay that does not know the 1-hour cache field: send the default lifetime instead.
      const ttlRejected = provider.api === 'anthropic-messages' && provider.cacheTtl === '1h' && /ttl|cache_control|extra inputs/i.test(error.message)
      // A preset's output length above what the model allows: fall back to the provider's own.
      // The output limit counts against the context window too: a long history plus a big cap
      // can overflow where the provider's own smaller default fits.
      const full = CONTEXT_FULL.test(error.message)
      const capRejected = req.softCap && (full || /max_?(output_|completion_)?tokens|maximum.*tokens|output.*limit/i.test(error.message))
      // A model or relay that takes no thinking / effort fields: leave them out, now and later.
      const reasoningRejected = reasoning && REASONING_REFUSED.test(error.message)
      if (!ttlRejected && !capRejected && !reasoningRejected) throw searchHint(contextHint(error), request)
      const fixed = { ...(ttlRejected ? { ttl: '5m' } : {}) }
      const body = capRejected ? { ...req, maxTokens: undefined } : req
      // The 1-hour cache or the output cap explains it on its own ("ttl: Extra inputs are not permitted" reads like a
      // refused thinking field too): tried first with thinking kept, and thinking left out only if still refused for it.
      let dropReasoning = reasoningRejected && !ttlRejected && !capRejected
      res = await post({ ...fixed, ...(dropReasoning ? { withReasoning: false } : {}) }, body)
      if (reasoningRejected && !dropReasoning) {
        const stillRefused = await failIfBad(res).then(() => null, refusal => refusal)
        if (stillRefused && !(stillRefused.providerStatus === 400 && REASONING_REFUSED.test(stillRefused.message))) throw searchHint(contextHint(stillRefused), request)
        if (stillRefused) {
          dropReasoning = true
          res = await post({ ...fixed, withReasoning: false }, body)
        }
      }
      // Refused the same way without them: it was something else (the search tool, say), and thinking stays as it
      // was. Refused for another reason, or not at all: they were the trouble, and are left out from now on.
      await failIfBad(res).catch(retryError => {
        if (dropReasoning && !REASONING_REFUSED.test(retryError.message)) NO_REASONING.add(refusedKey)
        throw searchHint(contextHint(retryError), request)
      })
      if (dropReasoning) NO_REASONING.add(refusedKey)
      used = { options: { ...fixed, ...(dropReasoning ? { withReasoning: false } : {}) }, body }
    }
    let result = withPrompt(await protocol.read(provider, request, res))
    // 联网 on Anthropic: a reply paused mid-search (pause_turn, after many searches) goes back as it came, and the
    // model carries on from there; the page has been showing it all along.
    for (let round = 0; result.stopReason === 'pause_turn' && result.content?.length && round < PAUSED_ROUNDS && !request.signal?.aborted; round++) {
      const next = await post(used.options, { ...used.body, messages: [...used.body.messages, { role: 'assistant', content: result.content }] })
      await failIfBad(next).catch(error => {
        throw searchHint(contextHint(error), request)
      })
      result = joinPaused(result, withPrompt(await protocol.read(provider, request, next)))
    }
    return { ...result, truncated: TRUNCATED.test(String(result.stopReason ?? '')) }
  }
  let first
  try {
    first = await attempt()
  } catch (error) {
    // The system prompt never arrived (a relay passing some requests to an upstream that drops it, modelflare's
    // Claude for one): asked again at once with it in the first message, and so for this model from now on.
    if (!error.systemDropped || dropped || original.signal?.aborted) throw error
    SYSTEM_DROPPED.add(pair)
    return complete(provider, modelId, original, { proxy })
  }
  // Found out at the end, the answer already shown: asked again when the caller can take back what it showed
  // (`onRestart`) or showed nothing; otherwise this answer stands and the next one goes the other way.
  if (first.systemDropped && !dropped) {
    SYSTEM_DROPPED.add(pair)
    if ((!original.onDelta || original.onRestart) && !original.signal?.aborted) {
      original.onRestart?.()
      const again = await complete(provider, modelId, original, { proxy })
      return { ...again, usage: addUsage(first.usage, again.usage) }
    }
  }
  if (!short || THINKERS.has(pair) || !first.truncated || !first.reasoned) return first
  // Its thinking used up a short cap: room for it from now on, and once more
  // now when nothing of the answer came (a started one is already on screen).
  THINKERS.add(pair)
  if (first.text.trim() || request.signal?.aborted) return first
  const second = await attempt()
  return { ...second, usage: addUsage(first.usage, second.usage) }
}

// A busy Vertex AI (429): asked again this many times, after about this long each (a second of chance on top, so
// replies sent together do not come back together), or as long as Google says when that is no more than BUSY_MAX_MS.
const BUSY_RETRIES = 2
const BUSY_WAITS_MS = [2000, 5000]
const BUSY_MAX_MS = 20_000

const isVertex = provider => /\/endpoints\/openapi\/?$/i.test(provider.baseURL)

/** How long to wait before asking a busy Vertex AI again, or null to give up (Google asks for longer than we wait). */
function busyWait(res, retry) {
  const header = Number(res.headers?.['retry-after'])
  const said = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(res.bodyText ?? '')?.[1]
  const asked = header > 0 ? header * 1000 : said ? Number(said) * 1000 : null
  if (asked !== null) return asked <= BUSY_MAX_MS ? asked : null
  return BUSY_WAITS_MS[retry] + Math.round(Math.random() * 1000)
}

/** Wait, cut short by a stop. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const stop = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}

// Provider + model pairs whose system prompt a relay has dropped: sent in the first message instead (systemInMessages).
const SYSTEM_DROPPED = new Set()

/** The request with its system prompt at the head of the first user message (a relay that drops the system field). */
function systemInMessages(request) {
  const system = String(request.system ?? '').trim()
  if (!system) return request
  const head = `<system>\n${system}\n</system>\n\n`
  const at = request.messages.findIndex(m => m.role === 'user')
  if (at < 0) return request
  const messages = request.messages.map((m, i) => (i !== at ? m : { ...m, content: Array.isArray(m.content) ? [{ type: 'text', text: head }, ...m.content] : head + m.content }))
  return { ...request, system: '', messages }
}

/**
 * An answer whose input is far less than its system prompt alone: the prompt never got there. Thrown before any
 * text shows; `late` (the stream over) says so instead.
 */
function checkSystemArrived(request, usage, { late = false } = {}) {
  if (!request.expectPrompt || !usage) return false
  const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  const lost = prompt > 0 && prompt < request.expectPrompt
  if (lost && !late) throw Object.assign(new Error('system prompt dropped'), { systemDropped: true })
  return lost
}

// Models that think before answering count the thinking against the output cap
// (DeepSeek's flash thinks by default), so a short cap can run out before the
// answer starts. A pair seen doing that gets this much more on short caps.
const THINKERS = new Set()
const THINKING_ROOM = 16000

/**
 * Two calls' tokens as one, for billing. `prompt` stays the last call's: what the context held is what
 * that one was sent (a paused reply sent back again, or asked once more, is no context twice over).
 */
const addUsage = (a, b) => (a && b ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, key === 'prompt' ? b[key] ?? a[key] : (a[key] ?? 0) + (b[key] ?? 0)])) : b ?? a)

/** One call's result with its own prompt size kept (`prompt`: uncached, cached and newly cached input together). */
function withPrompt(result) {
  const u = result?.usage
  return u ? { ...result, usage: { ...u, prompt: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) } } : result
}

// A request longer than the model's context window, as providers word it (OpenAI, DeepSeek and relays; Anthropic;
// Gemini; Kimi's token limit; GLM's max length; Qwen's input range; Chinese relays).
export const CONTEXT_FULL = new RegExp(
  [
    'context[ _](window|length)',
    'prompt is too long',
    'too many tokens',
    'maximum context',
    "exceeds? the (model's )?(context|maximum)",
    'exceeded model token limit',
    'exceeds? (the )?max(imum)? (input |context |prompt |message )?length',
    'range of input length',
    'input (is )?too long',
    'input token length too long',
    'token length exceed model limit',
    'context_length_exceeded',
    'prompt ?超长',
    '上下文.{0,8}(超|过长|太长)',
    '超(出|过).{0,10}(上下文|最大长度|长度限制)',
  ].join('|'),
  'i',
)

/**
 * A refusal while 联网 was on: the provider or model may not search (not said for a key, a rate limit or a
 * full context). Kept on `hint`, which providerError puts after the provider's words however long they are.
 */
function searchHint(error, request) {
  const status = error.providerStatus
  const refusal = status === 400 || status === 404 || status === 422 || status >= 500
  if (request.webSearch && refusal && !CONTEXT_FULL.test(error.message)) error.hint = msg`（这个对话打开了「联网」：这个供应商或模型可能不支持联网搜索，点输入框左边的地球图标关掉再试。）`
  return error
}

/** Say what to do when the conversation no longer fits: after the provider's words, which are cut short, never cut with them. */
function contextHint(error) {
  if (CONTEXT_FULL.test(error.message)) error.hint = msg`（这段对话太长，超出了模型一次能读的上下文。点顶栏「压缩上下文」把前面的剧情压成存档，再接着写。）`
  return error
}

// Stop reasons meaning the output hit its length limit (Anthropic, Chat Completions, Responses).
const TRUNCATED = /^(max_tokens|length|max_output_tokens)$/

async function readBuffer(res, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error(msg`响应太大`)
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
    headers: await headersFor(provider, raw ? { 'content-type': body.contentType, 'content-length': body.buffer.length } : {}, { proxy, signal }),
    rawBody: raw ? body.buffer : undefined,
    body: raw ? undefined : body,
    signal,
    proxy: provider.proxy === 'direct' ? null : proxy,
  })
  await failIfBad(res)
  return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
}

/**
 * Google's own Gemini API beside a provider set up with its OpenAI-compatible
 * address (…/v1beta/openai): images and speech come only from there
 * (generateContent). Same key and proxy; a relay that copies Google's layout works too.
 */
export function googleBase(provider) {
  const base = String(provider?.baseURL ?? '').replace(/\/+$/, '')
  // Vertex AI: …/projects/<project>/locations/<place>/endpoints/openapi → …/publishers/google (its models).
  if (/\/endpoints\/openapi$/i.test(base)) return base.replace(/\/endpoints\/openapi$/i, '/publishers/google')
  if (/\/openai$/i.test(base)) return base.replace(/\/openai$/i, '')
  if (/generativelanguage\.googleapis\.com/i.test(base)) return 'https://generativelanguage.googleapis.com/v1beta'
  return base
}

/** A provider whose key is Google's (the Gemini or Vertex AI template, or a relay of Gemini's). */
export const isGoogle = provider => Boolean(provider) && provider.api !== 'anthropic-messages' && (/generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com/i.test(provider.baseURL) || /\/v1beta\/openai\/?$/i.test(provider.baseURL))

/** POST to Google's own API (`/models/<model>:generateContent`) with the provider's key → the parsed JSON. */
export async function googleRequest(provider, suffix, { body, signal, proxy = null } = {}) {
  const key = apiKeyOf(provider)
  // Vertex AI takes a token made from its credential; Gemini's API its key.
  const auth = googleCredential(key) ? { authorization: `Bearer ${await bearerOf(provider, { proxy, signal })}` } : key ? { 'x-goog-api-key': key } : {}
  const res = await send(joinUrl(googleBase(provider), suffix), {
    method: 'POST',
    headers: { 'user-agent': 'agent-tavern/0.2.0', ...auth, ...provider.headers },
    body,
    signal,
    proxy: provider.proxy === 'direct' ? null : proxy,
  })
  await failIfBad(res)
  return parseJson(await readText(res, 64 * 1024 * 1024))
}

/**
 * GET a URL (an image a provider links to, a local service) as bytes. A few
 * redirects are followed (an image link that points on to a CDN); the headers
 * don't go along to another host.
 */
export async function fetchBytes(url, { headers = {}, signal, proxy = null } = {}) {
  let target = new URL(url)
  let sent = headers
  for (let hop = 0; ; hop += 1) {
    const res = await send(target.href, { headers: sent, signal, proxy })
    const location = res.headers.location
    if (res.statusCode >= 300 && res.statusCode < 400 && location && hop < 5) {
      res.resume()
      const next = new URL(location, target)
      if (!/^https?:$/.test(next.protocol)) throw new Error(msg`跳转到了不支持的地址：${next.href.slice(0, 80)}`)
      if (next.origin !== target.origin) sent = {}
      target = next
      continue
    }
    await failIfBad(res)
    return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
  }
}

/** POST JSON to a URL (local services such as ComfyUI or the voice bridge). */
export async function postJson(url, body, { signal, proxy = null, headers = {} } = {}) {
  const res = await send(url, { method: 'POST', headers, body, signal, proxy })
  await failIfBad(res)
  return { contentType: String(res.headers['content-type'] ?? ''), buffer: await readBuffer(res) }
}

/** Model ids the provider lists (GET /models). No model is called. */
export async function listRemoteModels(provider, options = {}) {
  return (await listRemoteModelDetails(provider, options)).models
}

// Where model lists say how long a model's context is (OpenRouter, Together; Groq; Gemini; Anthropic; LM Studio).
const CONTEXT_FIELDS = ['context_length', 'context_window', 'inputTokenLimit', 'max_input_tokens', 'max_context_length']

/** The provider's model list: { models: ids, contexts: { id: tokens } } for the models whose entry says. */
export async function listRemoteModelDetails(provider, { proxy = null, signal } = {}) {
  if (/\/endpoints\/openapi\/?$/i.test(provider.baseURL)) return vertexModels(provider, { proxy, signal })
  const target = provider.api === 'anthropic-messages' ? anthropicUrl(provider.baseURL, '/models?limit=1000') : joinUrl(provider.baseURL, '/models')
  const res = await send(target, { headers: await headersFor(provider, { accept: 'application/json' }, { proxy, signal }), signal, proxy: provider.proxy === 'direct' ? null : proxy })
  await failIfBad(res)
  const json = parseJson(await readText(res, 4 * 1024 * 1024))
  const list = Array.isArray(json) ? json : json?.data ?? json?.models ?? []
  const idOf = item => {
    const id = typeof item === 'string' ? item : item?.id ?? item?.name
    return typeof id === 'string' && id ? id.replace(/^models\//, '') : ''
  }
  const contexts = {}
  for (const item of list) {
    const id = idOf(item)
    const size = id && typeof item === 'object' ? Number([...CONTEXT_FIELDS.map(key => item[key]), item.top_provider?.context_length].find(value => Number(value) > 0)) : 0
    if (size >= 1_000 && size <= 100_000_000) contexts[id] = Math.floor(size)
  }
  return { models: [...new Set(list.map(idOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)), contexts }
}

/**
 * Vertex AI's OpenAI-compatible address lists no models: Google's own models come from its Model Garden
 * (publishers/google), Gemini only, written the way that address takes them (google/<model>).
 */
async function vertexModels(provider, { proxy = null, signal } = {}) {
  // The Model Garden takes no API key: the models written in and the ones Google offered when this was written are
  // each tried by counting a word's tokens (free); those the project can use are the list.
  if (agentPlatformKey(provider)) return triedModels(provider, { proxy, signal })
  // The Model Garden's address names no project: gcloud's login has to say which one the call counts against.
  const project = /\/projects\/([^/]+)\//.exec(provider.baseURL)?.[1]
  const headers = await headersFor(provider, { accept: 'application/json', ...(project && project !== 'PROJECT_ID' ? { 'x-goog-user-project': decodeURIComponent(project) } : {}) }, { proxy, signal })
  const ids = new Set()
  let page = ''
  for (let n = 0; n < 10; n++) {
    const target = `${new URL(provider.baseURL).origin}/v1beta1/publishers/google/models?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`
    const res = await send(target, { headers, signal, proxy: provider.proxy === 'direct' ? null : proxy })
    await failIfBad(res)
    const json = parseJson(await readText(res, 8 * 1024 * 1024))
    for (const item of json?.publisherModels ?? []) {
      const id = String(item?.name ?? '').replace(/^publishers\/google\/models\//, '')
      if (/^gemini-/i.test(id) && !NOT_CHAT.test(id) && !/transcribe|translate|-live/i.test(id)) ids.add(`google/${id}`)
    }
    page = typeof json?.nextPageToken === 'string' ? json.nextPageToken : ''
    if (!page) break
  }
  return { models: [...ids].sort((a, b) => a.localeCompare(b)), contexts: {} }
}

// Agent Platform's Gemini models as its Model Garden listed them (2026-11), tried when only an API key is there to ask with.
const AGENT_PLATFORM_MODELS = [
  'gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-omni-1.1-flash-preview', 'gemini-nano-banana-2.1',
]

/**
 * Agent Platform with an API key: the models written in, then the known ones, each asked to count a word's tokens;
 * the ones that answer are listed. One the project has no access to says 404; when none answers, the first model's
 * error says why (the key, the project, the network).
 */
async function triedModels(provider, { proxy = null, signal } = {}) {
  const written = (provider.models ?? []).map(model => String(model.id ?? '').replace(/^google\//, '')).filter(Boolean)
  if (!written.length) throw httpError(400, msg`先在「模型」里填一个模型 ID（比如 google/gemini-3.1-pro-preview），用它检查连接`)
  const candidates = [...new Set([...written, ...AGENT_PLATFORM_MODELS])]
  const results = new Array(candidates.length)
  let next = 0
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++
      try {
        await googleRequest(provider, `/models/${encodeURIComponent(candidates[i])}:countTokens`, { body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, proxy, signal })
        results[i] = { ok: true }
      } catch (error) {
        results[i] = { error }
        // The key or the project turned away, or no connection: the same for every model, so no more are asked.
        if (error.providerStatus !== 404) next = candidates.length
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const models = candidates.filter((_, i) => results[i]?.ok).map(id => `google/${id}`)
  if (!models.length) throw results.find(result => result?.error && result.error.providerStatus !== 404)?.error ?? results[0].error
  return { models: models.sort((a, b) => a.localeCompare(b)), contexts: {} }
}

/** A system error's code (ECONNRESET, ENOTFOUND…), or '': what to search for when a connection failed. */
export function errorCode(error) {
  const code = error?.code ?? error?.cause?.code
  return typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code) ? code : ''
}

/** `text` with the error's code after it, unless it says it already. */
export function withCode(text, error) {
  const code = errorCode(error)
  return code && !text.includes(code) ? `${text}${msg`（${code}）`}` : text
}

/** Plain-language provider errors, with what to do about one (`hint`, see searchHint) after the provider's words. */
export function providerError(provider, error) {
  return `${plainError(provider, error)}${error?.hint ?? ''}`
}

function plainError(provider, error) {
  const text = String(error?.message ?? error ?? '')
  const status = error?.providerStatus
  const name = provider?.name ?? msg`供应商`
  // Agent Platform's address names the project by its ID; a project's name (or someone else's project) is turned away.
  if (status === 403 && /Permission denied on resource project/i.test(text)) return msg`${name} 不认地址里的项目：Base URL 里要填 Google Cloud 项目 ID（控制台顶部项目选择器里的「ID」，不是项目名称），并且 API Key 属于这个项目。（${text.slice(0, 160)}）`
  if (status === 401 || status === 403) return msg`${name} 拒绝了请求：API Key 无效或没有权限。（${text.slice(0, 160)}）`
  if (status === 404) return msg`${name} 返回 404：检查 Base URL 和接口类型，或者模型 ID 是否写对。（${text.slice(0, 160)}）`
  if (status === 429) return msg`${name} 限流或额度用完了，稍后再试。（${text.slice(0, 160)}）`
  if (status >= 500) return msg`${name} 服务出错，稍后重试。（${text.slice(0, 160)}）`
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|secure TLS connection|请求超时|Request timed out/i.test(`${errorCode(error)} ${text}`)) {
    return withCode(msg`连不上 ${name}：检查 Base URL、网络和代理设置。（${text.slice(0, 160)}）`, error)
  }
  return withCode(msg`${name}：${text.slice(0, 240)}`, error)
}
