// Local HTTP API + static web UI. Loopback is open. LAN mode (settings or
// --listen lan) also accepts this machine's own addresses, still rejecting any
// other Host so a DNS-rebinding page cannot drive the API. A phone must present
// the access token. Mutating requests must carry X-Agent-Tavern (a custom
// header forces a CORS preflight we never approve).
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { fileURLToPath } from 'node:url'
import { backfillEntryPositions, cardSummary, exportCard, greetingsOf, importOwnCard, normalizeCard, parseCardFile, previousVersion, unwrapWorkspace } from './cards.mjs'
import { chatSummary, chatView, createChat, selectNode, activePath, rebuildPrompt, restoreFolded, rollbackTo, editCompaction, dropCompaction, exportStory, importStory, forkChat } from './chats.mjs'
import { editPreset, exportPreset, importOwnPreset, normalizePreset, presetDetail, presetSummary } from './presets.mjs'
import { appVersion, featuresOf } from './edition.mjs'
import { createProxy, proxyOverride } from './proxy.mjs'
import { createEngine } from './engine.mjs'
import { APIS, draftProvider, exportProviders, importProviders, isProviderRef, listRemoteModels, mergeDshProviders, normalizeProvider, providersFromDsh, providerChoices, providerError, publicProvider, refLabel } from './providers.mjs'
import { initTemplates } from './template.mjs'
import { canonicalModel } from './models.mjs'
import { createLedger } from './usage.mjs'
import { cleanMedia, createMedia } from './media.mjs'
import { createPromptLibrary } from './prompts.mjs'
import { chatPackage, importChatPackage, savePackagePicture } from './transfer.mjs'
import { createStore, defaultDataRoot, httpError } from './store.mjs'
import { normalizeBook } from './worldbook.mjs'
import { replaceMacros } from './prompt.mjs'
import { accessCookie, hostAllowed, isLoopback, lanAddresses, loginPage, readCookie, tokensEqual } from './access.mjs'

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
// The Claude subscription backend is in this machine's own install only; public
// trees (CicaTavern, the phone app) do not have the folder.
const subscriptionBackend = existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'subscription', 'index.mjs'))
  ? await import('./subscription/index.mjs')
  : null
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/render.js': ['render.js', 'text/javascript; charset=utf-8'],
  '/compat.js': ['compat.js', 'text/javascript; charset=utf-8'],
  '/usage.js': ['usage.js', 'text/javascript; charset=utf-8'],
  '/presets.js': ['presets.js', 'text/javascript; charset=utf-8'],
  '/providers.js': ['providers.js', 'text/javascript; charset=utf-8'],
  '/media.js': ['media.js', 'text/javascript; charset=utf-8'],
  '/history.js': ['history.js', 'text/javascript; charset=utf-8'],
  '/shared/speech.js': ['shared/speech.js', 'text/javascript; charset=utf-8'],
  '/shared/vars.js': ['shared/vars.js', 'text/javascript; charset=utf-8'],
  '/shared/regex.js': ['shared/regex.js', 'text/javascript; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  '/favicon.ico': ['icon.ico', 'image/x-icon'],
}
const MAX_BODY = 40 * 1024 * 1024

/** `<provider>/<model>` stays as it is; subscription aliases become catalog ids. */
const modelRef = ref => (isProviderRef(ref) ? ref : canonicalModel(ref))
const VERSION = appVersion()

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw httpError(413, '文件太大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, '请求体不是 JSON')
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function decodeUpload(body) {
  if (typeof body.data !== 'string' || typeof body.filename !== 'string') throw httpError(400, '缺少文件')
  return { filename: body.filename, buffer: Buffer.from(body.data, 'base64') }
}

/** An uploaded card file (SillyTavern PNG/JSON, or this app's own export) → { card, avatar }. */
function readCardUpload(body) {
  const { filename, buffer } = decodeUpload(body)
  const { raw, avatar } = parseCardFile(filename, buffer)
  return importOwnCard(raw) ?? { card: normalizeCard(raw), avatar }
}

/**
 * @param onShutdown - called after POST /api/shutdown (the desktop launcher's
 *   hidden server has no console to close); without it the route is off.
 * @param idleExitMs - the desktop launcher's server also exits on its own once
 *   no page (computer or phone) has been connected, and no request has come
 *   in, for this long. 0 keeps it running (bin/start.mjs from a console).
 * @param edition - 'personal' (this machine's own install), 'release' (the
 *   build for other people) or 'android' (the phone app's embedded Node); what
 *   each may do is in edition.mjs.
 * @param proxy - --proxy / AGENT_TAVERN_PROXY: fixes the proxy over the
 *   setting ('off' for none); undefined follows 设置 → 网络代理.
 * @param accessToken - required from every client, loopback included: on a
 *   phone any other app can reach 127.0.0.1. The Android app sets it as the
 *   WebView's cookie before loading the page.
 */
export function createApp({ dataRoot, proxy, onShutdown, idleExitMs = 0, edition = 'personal', accessToken = null } = {}) {
  const features = { ...featuresOf(edition) }
  // A tree without the subscription backend (CicaTavern, the phone) has no subscription whatever the edition says.
  if (!subscriptionBackend) features.subscription = false
  const store = createStore(dataRoot ?? defaultDataRoot(features.dataDir), { subscription: features.subscription, lan: features.lan })
  const network = createProxy({ override: proxyOverride(proxy), defaultMode: features.defaultProxy })
  // Read on every request, so a changed proxy setting applies at once.
  const isolation = {
    get proxy() {
      return network.current()
    },
  }
  const ledger = createLedger(store)
  const subscription = features.subscription
    ? subscriptionBackend.createSubscription({
        store,
        ledger,
        isolation: {
          configDir: subscriptionBackend.claudeConfigDir(store.dirs.root),
          get proxy() {
            return network.current()
          },
        },
      })
    : null
  const engine = createEngine(store, isolation, ledger, { subscription })
  const media = createMedia(store, { proxy: () => isolation.proxy, askInContext: engine.askInContext, features })
  const prompts = createPromptLibrary(store)

  // Every open page holds one /api/presence stream. With none open, the idle
  // countdown runs; any request restarts it, and a turn still generating
  // postpones it.
  const presence = new Set()
  let idleTimer = null
  function armIdle() {
    clearTimeout(idleTimer)
    if (!idleExitMs || !onShutdown || presence.size) return
    idleTimer = setTimeout(() => {
      if (presence.size) return
      if (engine.busy()) return armIdle()
      onShutdown()
    }, idleExitMs)
    idleTimer.unref?.()
  }

  function holdPresence(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    res.write('retry: 3000\n\n')
    presence.add(res)
    clearTimeout(idleTimer)
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
    req.on('close', () => {
      clearInterval(ping)
      presence.delete(res)
      armIdle()
    })
  }

  /** Stream one generation as server-sent events. */
  async function streamTurn(res, chatId, args) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
    try {
      const { chat, nodeId } = await engine.runTurn(chatId, args, send)
      send({ type: 'done', nodeId, chat: chatView(chat) })
    } catch (error) {
      send({ type: 'error', status: error.status ?? 500, message: error.message })
    }
    res.end()
  }

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, app: 'agent-tavern', version: VERSION, edition: features.edition })],
    ['GET', /^\/api\/status$/, () => ({
      rateLimit: engine.rateLimit(),
      lastInit: engine.lastInit(),
      dataRoot: store.dirs.root,
      claudeConfigDir: subscription?.configDir ?? null,
      proxy: isolation.proxy,
      network: network.describe(),
      claudeExecutable: subscription ? subscription.executable() : null,
      version: VERSION,
      edition: features.edition,
      features,
    })],
    ['GET', /^\/api\/auth$/, async () => (!subscription || (await store.getSettings()).subscription === 'off' ? { disabled: true } : subscription.authStatus())],
    // Subscription models (where there is a subscription and it is on), then every provider's models.
    ['GET', /^\/api\/models$/, async () => {
      const settings = await store.getSettings()
      const useSubscription = Boolean(subscription) && settings.subscription !== 'off'
      let accountError = null
      if (useSubscription) {
        try {
          await subscription.listModels()
        } catch (error) {
          accountError = String(error?.message ?? error).slice(0, 160)
        }
      }
      const choices = [
        ...(useSubscription ? subscription.choices().map(m => ({ ...m, group: 'Claude 订阅' })) : []),
        ...providerChoices(await store.getProviders()),
      ]
      return { choices, defaultModel: modelRef(settings.model), accountError, subscription: useSubscription }
    }],
    ['GET', /^\/api\/usage$/, async (_, __, url) => {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90)
      const [summary, providers] = await Promise.all([ledger.summary({ days, chats: (await store.listChats()).map(chatSummary) }), store.getProviders()])
      for (const row of summary.byModel) row.label = refLabel(row.model, providers) ?? row.label
      return summary
    }],

    // Custom API providers. Keys go in, never out (publicProvider).
    ['GET', /^\/api\/providers$/, async () => {
      const [providers, settings] = await Promise.all([store.getProviders(), store.getSettings()])
      return { providers: providers.map(p => publicProvider(p)), apis: APIS, subscription: settings.subscription, subscriptionLocked: !features.subscription }
    }],
    ['POST', /^\/api\/providers$/, async (_, body) => {
      const providers = await store.getProviders()
      const provider = normalizeProvider(body, null, new Set(providers.map(p => p.id)))
      await store.saveProviders([...providers, provider])
      return publicProvider(provider)
    }],
    ['PUT', /^\/api\/providers\/([\w-]+)$/, async ([id], body) => {
      const providers = await store.getProviders()
      const index = providers.findIndex(p => p.id === id)
      if (index < 0) throw httpError(404, '供应商不存在')
      const provider = normalizeProvider(body, providers[index])
      providers[index] = provider
      await store.saveProviders(providers)
      return publicProvider(provider)
    }],
    ['DELETE', /^\/api\/providers\/([\w-]+)$/, async ([id]) => {
      const providers = await store.getProviders()
      await store.saveProviders(providers.filter(p => p.id !== id))
      const settings = await store.getSettings()
      if (isProviderRef(settings.model) && settings.model.startsWith(`${id}/`)) await store.saveSettings({ model: settings.subscription === 'off' ? '' : 'sonnet' })
      return { ok: true }
    }],
    // The one place keys leave the server: a file the user saves to move providers to the phone.
    // POST, so it needs the X-Agent-Tavern header like every other write.
    ['POST', /^\/api\/providers\/export$/, async () => {
      const [providers, settings] = await Promise.all([store.getProviders(), store.getSettings()])
      return exportProviders(providers, settings.model)
    }],
    ['POST', /^\/api\/providers\/import$/, async (_, body) => {
      const { list, added, updated, failed, defaultModel } = importProviders(await store.getProviders(), body.archive)
      await store.saveProviders(list)
      // Take the file's default model unless this side already uses one of its providers.
      const settings = await store.getSettings()
      const current = isProviderRef(settings.model) && list.some(p => settings.model.startsWith(`${p.id}/`))
      if (defaultModel && !current) await store.saveSettings({ model: defaultModel })
      return { added, updated, failed, defaultModel: current ? '' : defaultModel }
    }],
    // DSH's providers (address, protocol, models; keys stay in DSH) from a profile's cordis.patch.yml.
    ['POST', /^\/api\/providers\/import-dsh$/, async (_, body) => {
      if (!features.dshImport) throw httpError(404, '没有这个接口')
      const profile = typeof body.profile === 'string' && /^[\w-]{1,40}$/.test(body.profile) ? body.profile : 'desktop'
      const file = path.join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
      let doc
      try {
        doc = YAML.parse(await readFile(file, 'utf8'))
      } catch (error) {
        throw httpError(404, error.code === 'ENOENT' ? `没找到 DSH 配置：${file}` : `DSH 配置读不了：${String(error.message).slice(0, 120)}`)
      }
      const { drafts, skipped } = providersFromDsh(doc)
      const { list, added, updated } = mergeDshProviders(await store.getProviders(), drafts)
      await store.saveProviders(list)
      return { added, updated, skipped, file }
    }],
    // The provider's own model list (GET /models): a connection check that calls no model.
    ['POST', /^\/api\/providers\/models$/, async (_, body) => {
      const providers = await store.getProviders()
      const draft = draftProvider(body, providers.find(p => p.id === body.id) ?? null)
      try {
        return { models: await listRemoteModels(draft, { proxy: isolation.proxy, signal: AbortSignal.timeout(20000) }) }
      } catch (error) {
        throw httpError(502, providerError(draft, error))
      }
    }],
    ['GET', /^\/api\/settings$/, () => store.getSettings()],
    ['PUT', /^\/api\/settings$/, async (_, body) => {
      const before = (await store.getSettings()).proxy
      const saved = await store.saveSettings({ ...body, media: undefined })
      if (saved.proxy !== before) await network.apply(saved.proxy)
      return saved
    }],
    // 设置 → 网络代理: the mode in force, the proxy it resolved to, and whether --proxy fixed it.
    ['GET', /^\/api\/network$/, () => network.describe()],
    ['POST', /^\/api\/network\/refresh$/, async () => network.apply((await store.getSettings()).proxy)],

    // Pictures and voice (media.mjs).
    ['GET', /^\/api\/media\/settings$/, async () => ({ media: await media.settings(), workflow: media.describeWorkflow(await media.loadWorkflow()), novelai: await media.naiStatus(), voiceKey: await media.ttsKeyStatus() })],
    ['PUT', /^\/api\/media\/settings$/, async (_, body) => {
      const previous = await media.settings()
      // Another tavern's LAN link carries its access key after #k=: the key goes to its own file.
      let voiceKey = null
      if (typeof body.ttsUrl === 'string' && body.ttsUrl.includes('#')) {
        const [url, fragment] = body.ttsUrl.split('#')
        voiceKey = /(?:^|&)k=([^&]+)/.exec(fragment)?.[1] ?? null
        body = { ...body, ttsUrl: url }
      }
      const next = cleanMedia(body, previous, media.defaults)
      if (voiceKey) await media.setTtsKey(decodeURIComponent(voiceKey))
      // A key belongs to the address it came with: a new address without one drops it.
      else if (body.ttsClearKey === true || next.ttsUrl !== previous.ttsUrl) await media.setTtsKey('')
      // The NovelAI token goes to its own file; a blank field keeps the saved one.
      if (typeof body.naiToken === 'string' && body.naiToken.trim()) await media.setNaiToken(body.naiToken)
      else if (body.naiClearToken === true) await media.setNaiToken('')
      await store.saveSettings({ media: next })
      return { media: next, workflow: media.describeWorkflow(await media.loadWorkflow()), novelai: await media.naiStatus(), voiceKey: await media.ttsKeyStatus() }
    }],
    ['POST', /^\/api\/media\/novelai\/check$/, (_, body) => media.naiCheck(typeof body?.token === 'string' ? body.token.trim() : '')],
    ['PUT', /^\/api\/media\/workflow$/, async (_, body) => ({ workflow: await media.saveWorkflow(body.workflow) })],
    ['GET', /^\/api\/media\/voices$/, () => media.voices()],
    // The bridge's own path, so a tavern elsewhere (the phone) can use this one as its voice service.
    ['GET', /^\/api\/persona\/list$/, () => media.personaList()],
    ['GET', /^\/api\/media\/loras$/, () => media.loras()],
    ['GET', /^\/api\/cards\/([\w-]+)\/media$/, ([id]) => media.cardMediaView(id)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/media$/, ([id], body) => media.saveCardMedia(id, body)],
    ['POST', /^\/api\/cards\/([\w-]+)\/roster\/draft$/, ([id]) => media.draftRoster(id, AbortSignal.timeout(180000))],
    ['POST', /^\/api\/cards\/([\w-]+)\/roster\/portrait$/, ([id], body) => media.drawPortrait(id, body?.entry, AbortSignal.timeout(600000), { model: typeof body?.model === 'string' ? body.model : '' })],
    ['PUT', /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/, ([id, entryId], body) => media.saveRosterRef(id, entryId, body?.image)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/, ([id, entryId]) => media.removeRosterRef(id, entryId)],
    ['DELETE', /^\/api\/chats\/([\w-]+)\/nodes\/([\w-]+)\/image$/, async ([id, nodeId], _, url) => {
      const file = String(url.searchParams.get('file') ?? '')
      const chat = await store.getChat(id)
      const node = chat.nodes[nodeId]
      if (!node?.media?.images) throw httpError(404, '没有这张图')
      node.media.images = node.media.images.filter(image => image.file !== file)
      await media.removeImage(id, file)
      await prompts.forgetPicture(id, file).catch(() => {})
      return chatView(await store.saveChat(chat))
    }],
    // Picture prompt library (prompts.mjs).
    ['GET', /^\/api\/prompts$/, (_, __, url) => prompts.list(String(url.searchParams.get('cardId') ?? ''))],
    ['POST', /^\/api\/prompts$/, (_, body) => prompts.saveManual(body ?? {})],
    ['PUT', /^\/api\/prompts\/([\w-]+)$/, ([id], body) => prompts.update(id, body ?? {})],
    ['DELETE', /^\/api\/prompts\/([\w-]+)$/, ([id]) => prompts.remove(id)],
    ['GET', /^\/api\/access$/, async () => accessView()],
    ['GET', /^\/api\/persona$/, () => store.getPersona()],
    ['PUT', /^\/api\/persona$/, (_, body) => store.savePersona(body)],

    ['GET', /^\/api\/cards$/, async () => (await store.listCards()).map(cardSummary)],
    // Which card a file would update: the newest one with the same name apart from its version.
    ['POST', /^\/api\/cards\/inspect$/, async (_, body) => {
      const { card } = readCardUpload(body)
      const previous = previousVersion(await store.listCards(), card)
      return { name: card.name, previous: previous ? { id: previous.id, name: previous.name } : null }
    }],
    // `replace`: update that card in place (its chats, picture and voice settings, cast and
    // linked worldbooks stay). Otherwise a new card, which still takes over the settings and
    // reference pictures of an older version of itself, so deleting that one loses nothing.
    ['POST', /^\/api\/cards\/import$/, async (_, body) => {
      const { card, avatar } = readCardUpload(body)
      if (typeof body.replace === 'string' && body.replace) {
        const old = await store.getCard(body.replace)
        Object.assign(card, { id: old.id, media: old.media, worldbookIds: old.worldbookIds ?? [], hasAvatar: Boolean(avatar) || old.hasAvatar })
        await store.saveCard(card, avatar)
        return { ...cardSummary(card), updated: old.name }
      }
      card.hasAvatar = Boolean(avatar)
      await store.saveCard(card, avatar)
      const previous = previousVersion(await store.listCards(), card)
      if (previous) {
        await media.inheritCardMedia(previous.id, card.id)
        return { ...cardSummary(card), inherited: previous.name }
      }
      return cardSummary(card)
    }],
    ['GET', /^\/api\/cards\/([\w-]+)$/, async ([id]) => {
      const [card, persona] = await Promise.all([store.getCard(id), store.getPersona()])
      const names = { char: card.name, user: persona.name || '你' }
      return {
        ...cardSummary(card),
        greetingTexts: greetingsOf(card).map(text => replaceMacros(text.replace(/\{\{random[^}]*\}\}/gi, '…'), names)),
        description: card.description,
        scenario: card.scenario,
        regexScriptList: Array.isArray(card.regexScripts) ? card.regexScripts : [],
      }
    }],
    ['GET', /^\/api\/cards\/([\w-]+)\/export$/, async ([id]) => {
      const card = await store.getCard(id)
      return exportCard(card, card.hasAvatar ? await readFile(store.avatarPath(id)).catch(() => null) : null)
    }],
    ['DELETE', /^\/api\/cards\/([\w-]+)$/, async ([id]) => {
      await store.deleteCard(id)
      return { ok: true }
    }],
    ['PUT', /^\/api\/cards\/([\w-]+)\/worldbooks$/, async ([id], body) => {
      const card = await store.getCard(id)
      card.worldbookIds = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : []
      await store.saveCard(card)
      return cardSummary(card)
    }],

    ['GET', /^\/api\/worldbooks$/, async () =>
      (await store.listBooks()).map(b => ({ id: b.id, name: b.name, entries: b.entries.length, importedAt: b.importedAt }))],
    ['POST', /^\/api\/worldbooks\/import$/, async (_, body) => {
      const { filename, buffer } = decodeUpload(body)
      let json
      try {
        json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
      } catch {
        throw httpError(400, '无法解析世界书 JSON')
      }
      const book = normalizeBook(unwrapWorkspace(json), filename.replace(/\.json$/i, ''))
      await store.saveBook(book)
      return { id: book.id, name: book.name, entries: book.entries.length }
    }],
    ['DELETE', /^\/api\/worldbooks\/([\w-]+)$/, async ([id]) => {
      await store.deleteBook(id)
      return { ok: true }
    }],

    ['GET', /^\/api\/presets$/, async () => (await store.listPresets()).map(presetSummary)],
    ['POST', /^\/api\/presets\/import$/, async (_, body) => {
      const { filename, buffer } = decodeUpload(body)
      let json
      try {
        json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
      } catch {
        throw httpError(400, '无法解析预设 JSON')
      }
      const preset = importOwnPreset(json) ?? normalizePreset(json, filename.replace(/\.json$/i, ''))
      await store.savePreset(preset)
      return presetSummary(preset)
    }],
    ['GET', /^\/api\/presets\/([\w-]+)\/export$/, async ([id]) => exportPreset(await store.getPreset(id))],
    ['GET', /^\/api\/presets\/([\w-]+)$/, async ([id]) => presetDetail(await store.getPreset(id))],
    ['PUT', /^\/api\/presets\/([\w-]+)$/, async ([id], body) => presetDetail(await store.savePreset(editPreset(await store.getPreset(id), body)))],
    ['DELETE', /^\/api\/presets\/([\w-]+)$/, async ([id]) => {
      await store.deletePreset(id)
      const settings = await store.getSettings()
      if (settings.presetId === id) await store.saveSettings({ presetId: '' })
      return { ok: true }
    }],

    ['GET', /^\/api\/chats$/, async (_, __, url) => (await store.listChats(url.searchParams.get('cardId'))).map(chatSummary)],
    ['POST', /^\/api\/chats$/, async (_, body) => chatView(await createChat(store, String(body.cardId), Number(body.greetingIndex) || 0))],
    ['GET', /^\/api\/chats\/([\w-]+)$/, async ([id]) => ({ ...chatView(await store.getChat(id)), running: engine.isRunning(id) })],
    ['PUT', /^\/api\/chats\/([\w-]+)$/, async ([id], body) => {
      const chat = await store.getChat(id)
      if (typeof body.title === 'string' && body.title.trim()) {
        // A running turn saves its own copy of the chat at the end and would put the old title back.
        if (engine.isRunning(id)) throw httpError(409, '正在生成，等这轮写完再改名')
        chat.title = body.title.trim().slice(0, 80)
      }
      // A chat's own model; empty follows the global default. Caches are per model,
      // so switching costs one full cache write on the next turn.
      if (body.model !== undefined) chat.model = body.model ? modelRef(body.model) : null
      return { ...chatView(await store.saveChat(chat)), running: engine.isRunning(id) }
    }],
    ['DELETE', /^\/api\/chats\/([\w-]+)$/, async ([id]) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      await store.deleteChat(id)
      await prompts.adoptChat(id).catch(() => {})
      await media.removeChatMedia(id)
      return { ok: true }
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/select$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      selectNode(chat, String(body.nodeId))
      return chatView(await store.saveChat(chat))
    }],
    // Rollback hides the later turns (kept as a branch); the next message forks
    // the SDK session at that point, so the cache up to there still hits.
    ['POST', /^\/api\/chats\/([\w-]+)\/rollback$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      rollbackTo(chat, String(body.nodeId))
      return chatView(await store.saveChat(chat))
    }],
    // Rewrite one message (shown and sent from now on); see engine.editMessage.
    ['PUT', /^\/api\/chats\/([\w-]+)\/messages\/([\w-]+)$/, async ([id, nodeId], body) => {
      const { chat, ...outcome } = await engine.editMessage(id, nodeId, body.text)
      return { ...chatView(chat), edit: outcome }
    }],
    // A new chat with only the turns up to this reply; the original is untouched.
    ['POST', /^\/api\/chats\/([\w-]+)\/fork$/, async ([id], body) => {
      const source = await store.getChat(id)
      const chat = forkChat(source, String(body.nodeId))
      const files = Object.values(chat.nodes).flatMap(node => node.media?.images?.map(image => image.file) ?? [])
      await media.copyChatMedia(source.id, chat.id, files)
      return chatView(await store.saveChat(chat))
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/restore$/, async ([id]) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      restoreFolded(chat)
      return chatView(await store.saveChat(chat))
    }],
    // Manual compaction: one summary call, then the next turn starts a new session (see recap.mjs).
    ['POST', /^\/api\/chats\/([\w-]+)\/compact$/, async ([id]) => ({ ...chatView(await engine.compactChat(id)), running: false })],
    ['PUT', /^\/api\/chats\/([\w-]+)\/compaction$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      editCompaction(chat, String(body.nodeId), body.summary)
      return chatView(await store.saveChat(chat))
    }],
    // Story archive: the summary, the last turns verbatim and the variables, to
    // carry a story into a new chat (another card version, another machine).
    ['GET', /^\/api\/chats\/([\w-]+)\/archive$/, async ([id], _, url) => exportStory(await store.getChat(id), url.searchParams.get('nodeId'))],
    // A whole chat from another device (transfer.mjs); its pictures follow one PUT each.
    ['POST', /^\/api\/chats\/import-package$/, async (_, body) => {
      const { chat, card, missingPreset } = await importChatPackage(store, { header: body.header, cardId: String(body.cardId ?? '') })
      return { chat: chatView(chat), cardId: card.id, cardName: card.name, missingPreset }
    }],
    ['POST', /^\/api\/chats\/import$/, async (_, body) => chatView(await importStory(store, String(body.cardId ?? ''), body.archive))],
    ['DELETE', /^\/api\/chats\/([\w-]+)\/compaction$/, async ([id], _, url) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      dropCompaction(chat, String(url.searchParams.get('nodeId')))
      return chatView(await store.saveChat(chat))
    }],
    // Switch a chat's preset (or re-render its prefix after editing the one it
    // uses). Costs one cache write on the next turn.
    ['POST', /^\/api\/chats\/([\w-]+)\/preset$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      const chat = await store.getChat(id)
      await rebuildPrompt(store, chat, typeof body.presetId === 'string' ? body.presetId : chat.presetId ?? '')
      return { ...chatView(await store.saveChat(chat)), running: false }
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/stop$/, ([id]) => ({ stopped: engine.stop(id) })],
    ['PUT', /^\/api\/chats\/([\w-]+)\/state$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, '正在生成，先停止')
      if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) throw httpError(400, '状态必须是 JSON 对象')
      const chat = await store.getChat(id)
      const last = [...activePath(chat)].reverse().find(n => n.role === 'assistant')
      last.state = body.state
      // The model has not seen this edit; the next turn re-sends the full state.
      chat.stateDirty = true
      return chatView(await store.saveChat(chat))
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/preview$/, ([id], body) =>
      engine.previewTurn(id, { parentId: String(body.parentId), input: body.input })],
    ['GET', /^\/api\/chats\/([\w-]+)\/prompt$/, async ([id]) => {
      const chat = await store.getChat(id)
      const lastUser = [...activePath(chat)].reverse().find(n => n.role === 'user')
      return { systemPrompt: chat.systemPrompt, lastTurnPrompt: lastUser?.prompt ?? '' }
    }],
  ]

  let access = { mode: 'local', port: 8791, host: '127.0.0.1' }

  function bound() {
    return access
  }

  async function accessView() {
    const settings = await store.getSettings()
    const running = access.mode === 'lan'
    const { addresses } = lanAddresses()
    const token = running ? await store.ensureAccessToken() : ''
    return {
      running: access.mode,
      saved: settings.listen === 'lan' ? 'lan' : 'local',
      port: access.port,
      links: token ? addresses.map(({ host, adapter, kind, primary }) => ({ url: `http://${host}:${access.port}/#k=${token}`, adapter, kind, primary })) : [],
    }
  }

  async function allow(req, res, url) {
    // Only LAN mode accepts this machine's other names; loopback needs no interface lookup.
    const lan = access.mode === 'lan'
    if (!hostAllowed(req.headers.host, { lan, names: lan ? lanAddresses().names : new Set() })) {
      sendJson(res, 403, { error: '不允许从这个地址访问' })
      return false
    }
    if (!accessToken && (access.mode !== 'lan' || isLoopback(req.socket.remoteAddress))) return true
    if (req.method === 'GET' && (url.pathname === '/icon.png' || url.pathname === '/favicon.ico')) return true
    const token = accessToken ?? (await store.ensureAccessToken())
    const presented = readCookie(req.headers.cookie, 'tavern_key') || String(req.headers['x-agent-tavern-key'] ?? '')
    if (tokensEqual(presented, token)) return true
    if (req.method === 'POST' && url.pathname === '/api/access/unlock') {
      const body = await readBody(req)
      if (!tokensEqual(body.token, token)) {
        sendJson(res, 403, { error: '口令不对' })
        return false
      }
      res.setHeader('set-cookie', accessCookie(token))
      sendJson(res, 200, { ok: true })
      return false
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage(features.appName))
      return false
    }
    sendJson(res, 401, { error: '需要本机给出的链接' })
    return false
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (!(await allow(req, res, url))) return
    if (!presence.size) armIdle()
    if (req.method === 'GET' && url.pathname === '/api/presence') return holdPresence(req, res)

    // The page's subscription parts come with the subscription backend.
    if (req.method === 'GET' && url.pathname === '/subscription.js' && subscription) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(await readFile(subscription.pageFile))
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      let [file, type] = STATIC[url.pathname]
      // Each edition has its own icon (icon.* is CicaTavern's).
      if (file.startsWith('icon.')) file = file.replace(/^icon/, features.icon)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      return res.end(await readFile(path.join(WEB_ROOT, file)))
    }
    const avatar = /^\/api\/cards\/([\w-]+)\/avatar$/.exec(url.pathname)
    if (req.method === 'GET' && avatar) {
      try {
        const data = await readFile(store.avatarPath(avatar[1]))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
        return res.end(data)
      } catch {
        return sendJson(res, 404, { error: '没有头像' })
      }
    }

    const rosterRef = /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/.exec(url.pathname)
    if (req.method === 'GET' && rosterRef) {
      const data = await media.readRosterRef(rosterRef[1], rosterRef[2]).catch(() => null)
      if (!data) return sendJson(res, 404, { error: '这个角色还没有人设图' })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
      return res.end(data)
    }

    const packaged = /^\/api\/chats\/([\w-]+)\/package$/.exec(url.pathname)
    if (req.method === 'GET' && packaged) {
      const chat = await store.getChat(packaged[1])
      const data = await chatPackage(store, chat.id)
      const name = `${chat.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || chat.id}.tavernchat`
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'content-disposition': `attachment; filename="chat.tavernchat"; filename*=UTF-8''${encodeURIComponent(name)}` })
      return res.end(data)
    }

    const libraryPicture = /^\/api\/prompts\/([\w-]+)\/image$/.exec(url.pathname)
    if (req.method === 'GET' && libraryPicture) {
      const data = await prompts.image(libraryPicture[1]).catch(() => null)
      if (!data) return sendJson(res, 404, { error: '图片不存在' })
      const type = data[0] === 0xff ? 'image/jpeg' : data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' })
      return res.end(data)
    }

    const picture = /^\/api\/media\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && picture) {
      const data = await media.readImage(picture[1], picture[2]).catch(() => null)
      if (!data) return sendJson(res, 404, { error: '图片不存在' })
      const type = /\.jpe?g$/.test(picture[2]) ? 'image/jpeg' : picture[2].endsWith('.webp') ? 'image/webp' : 'image/png'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' })
      return res.end(data)
    }

    if (req.method !== 'GET' && req.headers['x-agent-tavern'] !== '1') return sendJson(res, 403, { error: '缺少请求头' })

    const packagePicture = /^\/api\/chats\/([\w-]+)\/media\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'PUT' && packagePicture) {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) throw httpError(413, '图片太大')
        chunks.push(chunk)
      }
      return sendJson(res, 200, await savePackagePicture(store, packagePicture[1], packagePicture[2], Buffer.concat(chunks)))
    }

    // Slow media calls: closing the request (stop, page left) cancels the upstream work.
    const cancelOnClose = () => {
      const controller = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) controller.abort()
      })
      return controller.signal
    }
    if (req.method === 'POST' && url.pathname === '/api/tts') {
      const body = await readBody(req)
      const wav = await media.speak({ text: body.text, voice: typeof body.voice === 'string' ? body.voice : '', stable: body.stable === true, fresh: body.fresh === true }, cancelOnClose())
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      return res.end(wav)
    }
    const imageRoute = /^\/api\/chats\/([\w-]+)\/nodes\/([\w-]+)\/(image-prompt|image)$/.exec(url.pathname)
    if (req.method === 'POST' && imageRoute) {
      const [, chatId, nodeId, kind] = imageRoute
      const body = await readBody(req)
      const signal = cancelOnClose()
      const chat = await store.getChat(chatId)
      const node = chat.nodes[nodeId]
      if (!node || node.role !== 'assistant') throw httpError(404, '这条叙述不存在')
      if (kind === 'image-prompt') {
        const reply = typeof body.reply === 'string' && body.reply.trim() ? body.reply : node.display ?? node.text
        const input = node.parent ? chat.nodes[node.parent]?.text ?? '' : ''
        return sendJson(res, 200, await media.writeImagePrompt(chat, node, { reply, input }, signal))
      }
      const image = await media.generateImage(chat, nodeId, body.prompt, signal, { model: typeof body.model === 'string' ? body.model : '' })
      // Re-read: the chat may have moved on while the picture was drawn.
      const fresh = await store.getChat(chatId)
      const target = fresh.nodes[nodeId]
      if (!target) throw httpError(404, '这条叙述已经不在了')
      target.media = { ...(target.media ?? {}), images: [...(target.media?.images ?? []), image] }
      await prompts.recordDrawn(fresh, target, image).catch(() => {})
      return sendJson(res, 200, { image, chat: { ...chatView(await store.saveChat(fresh)), running: engine.isRunning(chatId) } })
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (!onShutdown) return sendJson(res, 404, { error: '这个服务不能从页面停止' })
      if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: '只能在这台电脑上停止服务' })
      sendJson(res, 200, { ok: true })
      setTimeout(onShutdown, 150)
      return
    }

    const turn = /^\/api\/chats\/([\w-]+)\/(turn|regenerate)$/.exec(url.pathname)
    if (req.method === 'POST' && turn) {
      const body = await readBody(req)
      const args = turn[2] === 'turn'
        ? { parentId: String(body.parentId), input: body.input }
        : { userNodeId: String(body.userNodeId) }
      return streamTurn(res, turn[1], args)
    }

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue
      const match = pattern.exec(url.pathname)
      if (!match) continue
      const body = method === 'GET' ? {} : await readBody(req)
      return sendJson(res, 200, await handler(match.slice(1), body, url))
    }
    sendJson(res, 404, { error: '没有这个接口' })
  }

  return {
    store,
    engine,
    isolation,
    subscription,
    features,
    network,
    bound,
    async listen({ port = 8791, listen } = {}) {
      await store.init()
      await backfillEntryPositions(store)
      if (subscription) await subscription.prepareStorage()
      await initTemplates()
      const settings = await store.getSettings()
      await network.apply(settings.proxy)
      const wanted = listen === 'lan' || listen === 'local' ? listen : settings.listen === 'lan' ? 'lan' : 'local'
      const mode = features.lan ? wanted : 'local'
      const host = mode === 'lan' ? '0.0.0.0' : '127.0.0.1'
      access = { mode, port, host }
      const server = createServer((req, res) => {
        handle(req, res).catch(error => {
          if (res.headersSent) return res.end()
          sendJson(res, error.status ?? 500, { error: error.message })
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      access.port = server.address().port
      // Covers a launch whose window never connects.
      armIdle()
      return server
    },
  }
}
