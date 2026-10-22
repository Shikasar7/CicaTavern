// Local HTTP API + static web UI. Loopback is open. LAN mode (settings or
// --listen lan) also accepts this machine's own addresses, still rejecting any
// other Host so a DNS-rebinding page cannot drive the API. A phone must present
// the access token. Mutating requests must carry X-Agent-Tavern (a custom
// header forces a CORS preflight we never approve).
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { fileURLToPath } from 'node:url'
import { backfillEntryPositions, cardSummary, cleanGroup, exportCard, greetingsOf, importOwnCard, normalizeCard, organizeCard, parseCardFile, previousVersion, rawOfPicture, sillyTavernCard, unwrapWorkspace, writeCardPng } from './cards.mjs'
import { chatSummary, chatView, childrenOf, createChat, selectNode, activePath, rebuildPrompt, restoreFolded, rollbackTo, editCompaction, dropCompaction, exportStory, importStory, importSillyTavern, forkChat } from './chats.mjs'
import { editPreset, exportPreset, importOwnPreset, normalizePreset, presetDetail, presetSummary } from './presets.mjs'
import { basicDetail } from './basic.mjs'
import { appVersion, featuresOf } from './edition.mjs'
import { createProxy, proxyOverride } from './proxy.mjs'
import { createEngine } from './engine.mjs'
import { APIS, draftProvider, exportProviders, importProviders, isProviderRef, listRemoteModels, mergeDshProviders, normalizeProvider, providersFromDsh, providerChoices, providerError, publicProvider, refLabel } from './providers.mjs'
import { initTemplates } from './template.mjs'
import { canonicalModel } from './models.mjs'
import { createLedger } from './usage.mjs'
import { createMedia, drawChoiceOf } from './media.mjs'
import { createAppearance } from './appearance.mjs'
import { createRegex } from './regex.mjs'
import { createScenes } from './scenes.mjs'
import { createSaves } from './saves.mjs'
import { KEYED as VOICE_KEYED } from './voice/index.mjs'
import { createPromptLibrary } from './prompts.mjs'
import { createForge } from './forge/index.mjs'
import { ensureBook } from './forge/edit.mjs'
import { editCard, greetingList } from '../web/shared/card-edit.js'
import { chatPackage, importChatPackage, savePackagePicture } from './transfer.mjs'
import { createStore, defaultDataRoot, httpError, newId, PRIVACY_NOTICE } from './store.mjs'
import { currentLanguage, localize, msg, pageIn, requestLanguage, withLanguage } from './i18n.mjs'
import { createUpdater } from './update/index.mjs'
import { createShortcut } from './update/install.mjs'
import { addEntries, bookCounts, editBook, editBookInfo, emptyBook, isDynamic, normalizeBook, worldFile } from './worldbook.mjs'
import { replaceMacros } from './prompt.mjs'
import { accessCookie, hostAllowed, isLoopback, lanAddresses, loginPage, readCookie, tokensEqual } from './access.mjs'

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
// The Windows launcher (launcher/): in a package, or built at a checkout's root.
const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CicaTavern.exe')
const hasLauncher = () => process.platform === 'win32' && existsSync(LAUNCHER)
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
  '/menu.js': ['menu.js', 'text/javascript; charset=utf-8'],
  '/forge.js': ['forge.js', 'text/javascript; charset=utf-8'],
  '/update.js': ['update.js', 'text/javascript; charset=utf-8'],
  '/privacy.js': ['privacy.js', 'text/javascript; charset=utf-8'],
  '/status.js': ['status.js', 'text/javascript; charset=utf-8'],
  '/basic-options.js': ['basic-options.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/i18n/en.js': ['i18n/en.js', 'text/javascript; charset=utf-8'],
  '/shared/i18n.js': ['shared/i18n.js', 'text/javascript; charset=utf-8'],
  '/shared/speech.js': ['shared/speech.js', 'text/javascript; charset=utf-8'],
  '/shared/vars.js': ['shared/vars.js', 'text/javascript; charset=utf-8'],
  '/shared/regex.js': ['shared/regex.js', 'text/javascript; charset=utf-8'],
  '/shared/basic.js': ['shared/basic.js', 'text/javascript; charset=utf-8'],
  '/shared/status.js': ['shared/status.js', 'text/javascript; charset=utf-8'],
  '/shared/appearance.js': ['shared/appearance.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/regex.js': ['regex.js', 'text/javascript; charset=utf-8'],
  '/books.js': ['books.js', 'text/javascript; charset=utf-8'],
  '/card-edit.js': ['card-edit.js', 'text/javascript; charset=utf-8'],
  '/shared/card-edit.js': ['shared/card-edit.js', 'text/javascript; charset=utf-8'],
  '/draw-choice.js': ['draw-choice.js', 'text/javascript; charset=utf-8'],
  '/shared/draw.js': ['shared/draw.js', 'text/javascript; charset=utf-8'],
  '/vn.js': ['vn.js', 'text/javascript; charset=utf-8'],
  '/shared/vn.js': ['shared/vn.js', 'text/javascript; charset=utf-8'],
  '/shared/stage.js': ['shared/stage.js', 'text/javascript; charset=utf-8'],
  '/vn-saves.js': ['vn-saves.js', 'text/javascript; charset=utf-8'],
  '/shared/cutout.js': ['shared/cutout.js', 'text/javascript; charset=utf-8'],
  '/whatsnew.js': ['whatsnew.js', 'text/javascript; charset=utf-8'],
  '/shared/whatsnew.js': ['shared/whatsnew.js', 'text/javascript; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  '/favicon.ico': ['icon.ico', 'image/x-icon'],
  // A phone's home screen (Safari「添加到主屏幕」, Android「安装应用」): see /manifest.webmanifest.
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
}
// Fetched by a phone without the access cookie (the icon is read before anyone logs in).
const OPEN_FILES = new Set(['/icon.png', '/favicon.ico', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'])
const MAX_BODY = 40 * 1024 * 1024

/** `<provider>/<model>` stays as it is; subscription aliases become catalog ids. */
const modelRef = ref => (isProviderRef(ref) ? ref : canonicalModel(ref))
const VERSION = appVersion()

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw httpError(413, msg`文件太大`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, msg`请求体不是 JSON`)
  }
}

function sendJson(res, status, value) {
  if (typeof value?.error === 'string') value = { ...value, error: localize(value.error) }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function decodeUpload(body) {
  if (typeof body.data !== 'string' || typeof body.filename !== 'string') throw httpError(400, msg`缺少文件`)
  return { filename: body.filename, buffer: Buffer.from(body.data, 'base64') }
}

/**
 * A worldbook with its entries for the page; `dynamic` marks the ones rendered
 * every turn (templates). `prefix` in a PUT's answer says the edit reached
 * chats' frozen prefix.
 */
function bookView(book, id = book.id) {
  return {
    id,
    name: book.name,
    description: book.description ?? '',
    scanDepth: book.scanDepth ?? null,
    // Whether an export carries the SillyTavern fields this app does not read (not for books imported before they were kept).
    complete: book.extras === true,
    // `extra` stays on the server: the page does not edit it.
    entries: book.entries.map(({ extra, ...entry }) => ({ ...entry, dynamic: isDynamic(entry) })),
  }
}

/** An imported book in the list (世界书 window, 设置 → 挂载的世界书). */
const bookSummary = b => ({ id: b.id, name: b.name, description: b.description ?? '', scanDepth: b.scanDepth ?? null, ...bookCounts(b), importedAt: b.importedAt })

/** A card's fields as 修改角色卡 edits them (web/card-edit.js), with its counts from cardSummary. */
function cardEditView(card) {
  return {
    ...cardSummary(card),
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    mesExample: card.mesExample,
    systemPrompt: card.systemPrompt,
    postHistoryInstructions: card.postHistoryInstructions,
    depthPrompt: card.depthPrompt ?? '',
    creatorNotes: card.creatorNotes,
    greetings: greetingList(card),
  }
}

const PNG_IMAGE = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/
const MAX_AVATAR = 15 * 1024 * 1024

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
 * @param update - tests replace parts of the updater (server/update/index.mjs:
 *   root, feed, check, spawnSwitch...).
 */
export function createApp({ dataRoot, proxy, onShutdown, idleExitMs = 0, edition = 'personal', accessToken = null, update = {} } = {}) {
  const features = { ...featuresOf(edition) }
  // Which server process answers: a page waiting out a restart (设置 → 更多 → 更新) reloads when it changes.
  const instance = randomBytes(6).toString('hex')
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
  // This install's own image backends (server/subscription/), offered beside the usual ones.
  const ownBackends = features.subscription ? subscriptionBackend.imageBackends?.({ store, proxy: () => isolation.proxy }) ?? [] : []
  const media = createMedia(store, { proxy: () => isolation.proxy, askInContext: engine.askInContext, features, ownBackends })
  const appearance = createAppearance(store)
  const regex = createRegex(store)
  const scenes = createScenes(store, { media })
  const saves = createSaves(store)
  const prompts = createPromptLibrary(store)
  const forge = createForge(store, { proxyNow: () => isolation.proxy, ledger, draw: (input, signal, choice) => media.drawCardArt(input, signal, choice) })
  // 设置 → 更多 → 更新. A restart after an update starts the server the way this one was started.
  let listenArg
  const updater = createUpdater({
    features,
    proxy: () => isolation.proxy,
    busy: () => engine.busy() || forge.busy(),
    onShutdown,
    dataRoot: store.dirs.root,
    // A server started from a console (no idle exit) comes back hidden, so it should still quit on its own.
    relaunch: () => ({ port: access.port, data: store.dirs.root, edition: features.edition, idleExit: Math.round(idleExitMs / 1000) || 60, proxy, listen: listenArg }),
    ...update,
  })

  /** The media settings for the page: secrets only as "set, ends in …". */
  async function mediaSettingsView(settings) {
    return {
      media: settings,
      workflow: media.describeWorkflow(await media.loadWorkflow()),
      novelai: await media.naiStatus(),
      ownBackends: await media.ownBackends(),
      voiceKey: await media.ttsKeyStatus(),
      voiceKeys: await media.voiceKeys(),
    }
  }

  // Every open page holds one /api/presence stream. With none open, the idle
  // countdown runs; any request restarts it, and a turn still generating
  // postpones it.
  const presence = new Set()
  let idleTimer = null
  function armIdle() {
    clearTimeout(idleTimer)
    // Open to phones (手机访问): a phone in the background drops its stream, and the server must stay up for it.
    if (!idleExitMs || !onShutdown || presence.size || access.mode === 'lan') return
    idleTimer = setTimeout(() => {
      if (presence.size) return
      if (engine.busy() || forge.busy()) return armIdle()
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
      send({ type: 'error', status: error.status ?? 500, message: localize(error.message) })
    }
    res.end()
  }

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, app: 'agent-tavern', version: VERSION, edition: features.edition, instance })],
    ['GET', /^\/api\/status$/, () => ({
      rateLimit: engine.rateLimit(),
      lastInit: engine.lastInit(),
      dataRoot: store.dirs.root,
      claudeConfigDir: subscription?.configDir ?? null,
      proxy: isolation.proxy,
      network: network.describe(),
      claudeExecutable: subscription ? subscription.executable() : null,
      launcher: hasLauncher(),
      privacyNoticeVersion: PRIVACY_NOTICE,
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
        ...(useSubscription ? subscription.choices().map(m => ({ ...m, group: msg`Claude 订阅`, subscription: true })) : []),
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
      if (index < 0) throw httpError(404, msg`供应商不存在`)
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
      if (!features.dshImport) throw httpError(404, msg`没有这个接口`)
      const profile = typeof body.profile === 'string' && /^[\w-]{1,40}$/.test(body.profile) ? body.profile : 'desktop'
      const file = path.join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
      let doc
      try {
        doc = YAML.parse(await readFile(file, 'utf8'))
      } catch (error) {
        throw httpError(404, error.code === 'ENOENT' ? msg`没找到 DSH 配置：${file}` : msg`DSH 配置读不了：${String(error.message).slice(0, 120)}`)
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
      uiLanguage = saved.uiLanguage
      if (saved.proxy !== before) await network.apply(saved.proxy)
      return saved
    }],
    // 场景图库 (scenes.mjs): a card's backgrounds for the visual novel mode; drawing is a slow call below.
    ['GET', /^\/api\/cards\/([\w-]+)\/scenes$/, ([id]) => scenes.list(id)],
    ['POST', /^\/api\/cards\/([\w-]+)\/scenes$/, ([id], body) => scenes.add(id, body ?? {})],
    ['PUT', /^\/api\/cards\/([\w-]+)\/scenes\/([\w-]+)$/, ([id, sceneId], body) => scenes.update(id, sceneId, body ?? {})],
    ['PUT', /^\/api\/cards\/([\w-]+)\/scenes\/([\w-]+)\/image$/, ([id, sceneId], body) => scenes.setImage(id, sceneId, body?.image)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/scenes\/([\w-]+)$/, ([id, sceneId]) => scenes.remove(id, sceneId)],
    // 立绘 (scenes.mjs): one picture per cast member; drawing is a slow call below.
    ['GET', /^\/api\/cards\/([\w-]+)\/sprites$/, ([id]) => scenes.sprites(id)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)$/, ([id, entryId], body) => scenes.setSprite(id, entryId, body?.image)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)$/, ([id, entryId]) => scenes.removeSprite(id, entryId)],
    // 表情差分: the 立绘 with another face, uploaded or (a slow call below) drawn.
    ['PUT', /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)\/expressions\/(\w+)$/, ([id, entryId, expression], body) => scenes.setExpression(id, entryId, expression, body?.image)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)\/expressions\/(\w+)$/, ([id, entryId, expression]) => scenes.removeExpression(id, entryId, expression)],
    // 存档 (saves.mjs): a card's save slots for the visual novel mode.
    ['GET', /^\/api\/cards\/([\w-]+)\/saves$/, ([id]) => saves.list(id)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/saves\/slot\/(\w+)$/, ([id, slot], body) => saves.put(id, slot, body)],
    ['POST', /^\/api\/cards\/([\w-]+)\/saves\/auto$/, ([id], body) => saves.auto(id, body)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/saves\/([\w-]+)\/note$/, ([id, saveId], body) => saves.setNote(id, saveId, body?.note)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/saves\/([\w-]+)$/, ([id, saveId]) => saves.remove(id, saveId)],
    // Loading shows the saved reply: later turns are rolled back (kept as a branch), as 回滚 does.
    ['POST', /^\/api\/cards\/([\w-]+)\/saves\/([\w-]+)\/load$/, async ([id, saveId]) => {
      const save = await saves.get(id, saveId)
      if (engine.isRunning(save.chatId)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(save.chatId).catch(() => null)
      if (!chat?.nodes[save.nodeId]) throw httpError(404, msg`这个存档的那一轮已经删掉了`)
      if (childrenOf(chat, save.nodeId).length) rollbackTo(chat, save.nodeId)
      else selectNode(chat, save.nodeId)
      return { save, chat: chatView(await store.saveChat(chat)) }
    }],
    // 正则管理 (regex.mjs): the global scripts, and the ones a card or a preset carries.
    ['GET', /^\/api\/regex$/, () => regex.list()],
    ['PUT', /^\/api\/regex$/, (_, body) => regex.save(body?.scripts)],
    ['POST', /^\/api\/regex\/import$/, (_, body) => regex.importScripts(body?.scripts)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/regex$/, ([id], body) => regex.saveCardScripts(id, body?.scripts)],
    ['PUT', /^\/api\/presets\/([\w-]+)\/regex$/, ([id], body) => regex.savePresetScripts(id, body?.scripts)],
    // 外观: the picture behind the page (appearance.mjs); style and opacity go through PUT /api/settings { appearance }.
    ['PUT', /^\/api\/appearance\/backdrop$/, (_, body) => appearance.saveBackdrop(body?.image)],
    ['DELETE', /^\/api\/appearance\/backdrop$/, () => appearance.removeBackdrop()],
    // 设置 → 网络代理: the mode in force, the proxy it resolved to, and whether --proxy fixed it.
    ['GET', /^\/api\/network$/, () => network.describe()],
    ['POST', /^\/api\/network\/refresh$/, async () => network.apply((await store.getSettings()).proxy)],

    // Pictures and voice (media.mjs).
    ['GET', /^\/api\/media\/settings$/, async () => mediaSettingsView(await media.settings())],
    ['PUT', /^\/api\/media\/settings$/, async (_, body) => {
      const previous = await media.settings()
      // Another tavern's LAN link carries its access key after #k=: the key goes to its own file.
      let voiceKey = null
      if (typeof body.ttsUrl === 'string' && body.ttsUrl.includes('#')) {
        const [url, fragment] = body.ttsUrl.split('#')
        voiceKey = /(?:^|&)k=([^&]+)/.exec(fragment)?.[1] ?? null
        body = { ...body, ttsUrl: url }
      }
      const next = media.cleanSettings(body, previous)
      if (voiceKey) await media.setTtsKey(decodeURIComponent(voiceKey))
      // A key belongs to the address it came with: a new address without one drops it.
      else if (body.ttsClearKey === true || next.ttsUrl !== previous.ttsUrl) await media.setTtsKey('')
      // The NovelAI token goes to its own file; a blank field keeps the saved one.
      if (typeof body.naiToken === 'string' && body.naiToken.trim()) await media.setNaiToken(body.naiToken)
      else if (body.naiClearToken === true) await media.setNaiToken('')
      // Cloud speech keys (fishKey, minimaxKey) the same way, each in voice-keys.json.
      for (const id of VOICE_KEYED) {
        if (typeof body[`${id}Key`] === 'string' && body[`${id}Key`].trim()) await media.setVoiceKey(id, body[`${id}Key`])
        else if (body[`${id}ClearKey`] === true) await media.setVoiceKey(id, '')
      }
      await store.saveSettings({ media: next })
      return mediaSettingsView(next)
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
    ['POST', /^\/api\/cards\/([\w-]+)\/roster\/portrait$/, ([id], body) => media.drawPortrait(id, body?.entry, AbortSignal.timeout(600000), drawChoiceOf(body))],
    ['PUT', /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/, ([id, entryId], body) => media.saveRosterRef(id, entryId, body?.image)],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/, ([id, entryId]) => media.removeRosterRef(id, entryId)],
    ['DELETE', /^\/api\/chats\/([\w-]+)\/nodes\/([\w-]+)\/image$/, async ([id, nodeId], _, url) => {
      const file = String(url.searchParams.get('file') ?? '')
      const chat = await store.getChat(id)
      const node = chat.nodes[nodeId]
      if (!node?.media?.images) throw httpError(404, msg`没有这张图`)
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
    // Creating a card by talking it through (forge/): the model calls run in the
    // background; the page polls GET /api/forge/:id while one is going.
    ['GET', /^\/api\/forge$/, () => forge.list()],
    ['POST', /^\/api\/forge$/, (_, body) => forge.create(body ?? {})],
    ['GET', /^\/api\/forge\/([\w-]+)$/, ([id]) => forge.get(id)],
    ['PUT', /^\/api\/forge\/([\w-]+)$/, ([id], body) => forge.update(id, body ?? {})],
    ['DELETE', /^\/api\/forge\/([\w-]+)$/, ([id]) => forge.remove(id)],
    ['POST', /^\/api\/forge\/([\w-]+)\/say$/, ([id], body) => forge.say(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/retry$/, ([id]) => forge.retry(id)],
    ['POST', /^\/api\/forge\/([\w-]+)\/undo$/, ([id]) => forge.undo(id)],
    ['POST', /^\/api\/forge\/([\w-]+)\/plan$/, ([id]) => forge.plan(id)],
    ['POST', /^\/api\/forge\/([\w-]+)\/revise$/, ([id], body) => forge.revise(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/write$/, ([id], body) => forge.write(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/rewrite$/, ([id], body) => forge.rewrite(id, body ?? {})],
    ['PUT', /^\/api\/forge\/([\w-]+)\/card$/, ([id], body) => forge.editCard(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/avatar$/, ([id], body) => forge.drawAvatar(id, body ?? {})],
    ['PUT', /^\/api\/forge\/([\w-]+)\/avatar$/, ([id], body) => forge.uploadAvatar(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/save$/, ([id], body) => forge.saveCard(id, body ?? {})],
    ['POST', /^\/api\/forge\/([\w-]+)\/stop$/, ([id]) => forge.stop(id)],
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
        Object.assign(card, { id: old.id, media: old.media, worldbookIds: old.worldbookIds ?? [], hasAvatar: Boolean(avatar) || old.hasAvatar, group: old.group ?? '', archived: old.archived === true })
        await store.saveCard(card, avatar)
        return { ...cardSummary(card), updated: old.name }
      }
      card.hasAvatar = Boolean(avatar)
      // A new version of a card goes into the same group as the old one.
      const previous = previousVersion(await store.listCards(), card)
      if (previous?.group) card.group = previous.group
      await store.saveCard(card, avatar)
      if (previous) {
        await media.inheritCardMedia(previous.id, card.id)
        await scenes.inherit(previous.id, card.id)
        return { ...cardSummary(card), inherited: previous.name }
      }
      return cardSummary(card)
    }],
    ['GET', /^\/api\/cards\/([\w-]+)$/, async ([id]) => {
      const [card, persona] = await Promise.all([store.getCard(id), store.getPersona()])
      const names = { char: card.name, user: card.userName || persona.name || '你' }
      return {
        ...cardSummary(card),
        greetingTexts: greetingsOf(card).map(text => replaceMacros(text.replace(/\{\{random[^}]*\}\}/gi, '…'), names)),
        description: card.description,
        scenario: card.scenario,
        regexScriptList: Array.isArray(card.regexScripts) ? card.regexScripts : [],
        statusBar: card.statusBar ?? null,
      }
    }],
    ['GET', /^\/api\/cards\/([\w-]+)\/export$/, async ([id]) => {
      const card = await store.getCard(id)
      return exportCard(card, card.hasAvatar ? await readFile(store.avatarPath(id)).catch(() => null) : null)
    }],
    ['DELETE', /^\/api\/cards\/([\w-]+)$/, async ([id]) => {
      await store.deleteCard(id)
      await forge.dropEdit(id)
      return { ok: true }
    }],
    // 修改角色卡 (web/card-edit.js): the card's fields, edited in place. It keeps its id, so
    // its chats, cast, sprites, scenes, picture and voice settings stay. `prefix`: the
    // edit reached what a chat freezes when it starts; open chats keep theirs until applied.
    ['GET', /^\/api\/cards\/([\w-]+)\/edit$/, async ([id]) => {
      const card = await store.getCard(id)
      // A card made in 创作角色卡 goes back to its draft's text when saved from there again.
      const drafts = await forge.list().catch(() => [])
      return { ...cardEditView(card), fromForge: drafts.some(draft => draft.savedCardId === id) }
    }],
    ['PUT', /^\/api\/cards\/([\w-]+)\/edit$/, async ([id], body) => {
      const card = await store.getCard(id)
      let result
      try {
        result = editCard(card, body ?? {})
      } catch (error) {
        throw error.blankName ? httpError(400, msg`名字不能空着`) : error
      }
      if (result.changed.length) await store.saveCard(card)
      return { ...cardEditView(card), changed: result.changed, prefix: result.prefix }
    }],
    // A new picture (PNG; the page converts others): the card goes into it as SillyTavern
    // keeps it, over what the old picture carried, so an export still has all of it.
    ['PUT', /^\/api\/cards\/([\w-]+)\/avatar$/, async ([id], body) => {
      const match = PNG_IMAGE.exec(String(body?.image ?? ''))
      if (!match) throw httpError(400, msg`头像要转成 PNG 再保存`)
      const png = Buffer.from(match[1], 'base64')
      if (png.length > MAX_AVATAR) throw httpError(400, msg`图片太大了（15 MB 以内）`)
      const card = await store.getCard(id)
      const old = card.hasAvatar ? await readFile(store.avatarPath(id)).catch(() => null) : null
      const file = writeCardPng(png, sillyTavernCard(card, rawOfPicture(old)))
      card.hasAvatar = true
      await store.saveCard(card, file)
      return cardEditView(card)
    }],
    // 修改角色卡 → 生成头像: drawn with the 画图方式 and model picked for it, not saved; the page
    // shows it, and taking it is PUT /api/cards/:id/avatar like an upload.
    ['POST', /^\/api\/cards\/([\w-]+)\/avatar\/draw$/, ([id], body) => media.drawAvatar(id, AbortSignal.timeout(600000), drawChoiceOf(body))],
    // The card as SillyTavern's JSON, edits included (the PNG is GET /api/cards/:id/png).
    ['GET', /^\/api\/cards\/([\w-]+)\/sillytavern$/, async ([id]) => {
      const card = await store.getCard(id)
      const picture = card.hasAvatar ? await readFile(store.avatarPath(id)).catch(() => null) : null
      return sillyTavernCard(card, rawOfPicture(picture))
    }],
    // 修改角色卡 → 对话修改: the card's edit session (forge/edit.mjs), run like a draft's jobs.
    ['GET', /^\/api\/cards\/([\w-]+)\/assistant$/, ([id]) => forge.editGet(id)],
    ['PUT', /^\/api\/cards\/([\w-]+)\/assistant$/, ([id], body) => forge.editUpdate(id, body ?? {})],
    ['POST', /^\/api\/cards\/([\w-]+)\/assistant$/, ([id], body) => forge.editAsk(id, body ?? {})],
    ['DELETE', /^\/api\/cards\/([\w-]+)\/assistant$/, ([id]) => forge.editClear(id)],
    ['POST', /^\/api\/cards\/([\w-]+)\/assistant\/retry$/, ([id]) => forge.editRetry(id)],
    ['POST', /^\/api\/cards\/([\w-]+)\/assistant\/stop$/, ([id]) => forge.editStop(id)],
    ['POST', /^\/api\/cards\/([\w-]+)\/assistant\/discard$/, ([id]) => forge.editDiscard(id)],
    ['POST', /^\/api\/cards\/([\w-]+)\/assistant\/apply$/, async ([id], body) => {
      const { session, card, applied, prefix } = await forge.editApply(id, body ?? {})
      return { session, applied, prefix, card: cardEditView(card) }
    }],
    // Groups and the archive: where a card sits in the list. Nothing else about it changes.
    ['PUT', /^\/api\/cards\/([\w-]+)\/organize$/, async ([id], body) => {
      const card = organizeCard(await store.getCard(id), { group: body?.group, archived: body?.archived })
      await store.saveCard(card)
      return cardSummary(card)
    }],
    // Rename a group, or dissolve it (`to` empty): its cards move with it.
    ['POST', /^\/api\/cards\/groups$/, async (_, body) => {
      const from = cleanGroup(body?.from)
      const to = cleanGroup(body?.to)
      if (!from) throw httpError(400, msg`要改哪个分组？`)
      let moved = 0
      for (const card of await store.listCards()) {
        if ((card.group ?? '') !== from) continue
        card.group = to
        await store.saveCard(card)
        moved++
      }
      return { moved }
    }],
    ['PUT', /^\/api\/cards\/([\w-]+)\/worldbooks$/, async ([id], body) => {
      const card = await store.getCard(id)
      card.worldbookIds = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : []
      await store.saveCard(card)
      return cardSummary(card)
    }],

    // A card's own worldbook entry by entry (worldbook.mjs editBook); chats know it as card-<id>.
    ['GET', /^\/api\/cards\/([\w-]+)\/book$/, async ([id]) => {
      const card = await store.getCard(id)
      if (!card.book) throw httpError(404, msg`这张卡没有自带世界书`)
      return bookView(card.book, `card-${card.id}`)
    }],
    ['PUT', /^\/api\/cards\/([\w-]+)\/book$/, async ([id], body) => {
      const card = await store.getCard(id)
      // A card without a book of its own gets one with its first entry (修改角色卡).
      if (!card.book && body?.add) ensureBook(card)
      if (!card.book) throw httpError(404, msg`这张卡没有自带世界书`)
      const { prefix, added } = editBook(card.book, body ?? {})
      await store.saveCard(card)
      return { ...bookView(card.book, `card-${card.id}`), prefix, added, card: cardSummary(card) }
    }],

    // Imported books as whole books (web/books.js, 世界书): which cards use one is
    // each card's worldbookIds, which the page has in its card list.
    ['GET', /^\/api\/worldbooks$/, async () => (await store.listBooks()).map(bookSummary)],
    ['POST', /^\/api\/worldbooks$/, async (_, body) => bookSummary(await store.saveBook(emptyBook(body?.name)))],
    ['GET', /^\/api\/worldbooks\/([\w-]+)$/, async ([id]) => bookView(await store.getBook(id))],
    // Entries as for a card's own book, and the book's name, description and scan depth.
    ['PUT', /^\/api\/worldbooks\/([\w-]+)$/, async ([id], body) => {
      const book = editBookInfo(await store.getBook(id), body ?? {})
      const { prefix, added } = editBook(book, body ?? {})
      await store.saveBook(book)
      return { ...bookView(book), prefix, added }
    }],
    ['GET', /^\/api\/worldbooks\/([\w-]+)\/export$/, async ([id]) => worldFile(await store.getBook(id))],
    // A copy to change apart from the original; no card uses it yet.
    ['POST', /^\/api\/worldbooks\/([\w-]+)\/copy$/, async ([id]) => {
      const book = await store.getBook(id)
      const copy = { ...structuredClone(book), id: newId(), name: msg`${book.name}（副本）`, importedAt: new Date().toISOString() }
      return bookSummary(await store.saveBook(copy))
    }],
    // The cards that use a book, ticked at once: `{ ids }` is all of them.
    // Their open chats keep the constant entries they started with until applied.
    ['PUT', /^\/api\/worldbooks\/([\w-]+)\/cards$/, async ([id], body) => {
      await store.getBook(id)
      const wanted = new Set(Array.isArray(body?.ids) ? body.ids.map(String) : [])
      const changed = []
      for (const card of await store.listCards()) {
        const ids = card.worldbookIds ?? []
        if (ids.includes(id) === wanted.has(card.id)) continue
        card.worldbookIds = wanted.has(card.id) ? [...ids, id] : ids.filter(x => x !== id)
        await store.saveCard(card)
        changed.push(card.id)
      }
      return { changed }
    }],
    /**
     * Entries copied or moved (`move`) out of a book, a card's own one
     * (card-<id>) included, into an imported one or a new one (`to` empty,
     * named `name`). The copy is saved before anything leaves the source.
     */
    ['POST', /^\/api\/worldbooks\/transfer$/, async (_, body) => {
      const from = String(body?.from ?? '')
      const ownCard = from.startsWith('card-') ? await store.getCard(from.slice(5)) : null
      if (ownCard && !ownCard.book) throw httpError(404, msg`这张卡没有自带世界书`)
      const source = ownCard ? ownCard.book : await store.getBook(from)
      const uids = new Set(Array.isArray(body?.uids) ? body.uids.map(String) : [])
      const picked = source.entries.filter(e => uids.has(e.uid))
      if (!picked.length) throw httpError(400, msg`没选条目`)
      const to = String(body?.to ?? '')
      if (to === from) throw httpError(400, msg`已经在这本里了`)
      const target = to ? await store.getBook(to) : emptyBook(body?.name)
      const { added, prefix: targetPrefix } = addEntries(target, picked)
      await store.saveBook(target)
      let sourcePrefix = false
      if (body?.move === true) {
        sourcePrefix = editBook(source, { remove: picked.map(e => e.uid) }).prefix
        if (ownCard) await store.saveCard(ownCard)
        else await store.saveBook(source)
      }
      return {
        from: { ...bookView(source, from), prefix: sourcePrefix, ...(ownCard ? { card: cardSummary(ownCard) } : {}) },
        to: { ...bookSummary(target), prefix: targetPrefix, added },
      }
    }],
    ['POST', /^\/api\/worldbooks\/import$/, async (_, body) => {
      const { filename, buffer } = decodeUpload(body)
      let json
      try {
        json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
      } catch {
        throw httpError(400, msg`无法解析世界书 JSON`)
      }
      const book = normalizeBook(unwrapWorkspace(json), filename.replace(/\.json$/i, ''), { standalone: true })
      await store.saveBook(book)
      return { id: book.id, name: book.name, entries: book.entries.length }
    }],
    // The cards it was attached to let go of it too (chats already skip a missing book).
    ['DELETE', /^\/api\/worldbooks\/([\w-]+)$/, async ([id]) => {
      await store.deleteBook(id)
      const detached = []
      for (const card of await store.listCards()) {
        if (!(card.worldbookIds ?? []).includes(id)) continue
        card.worldbookIds = card.worldbookIds.filter(x => x !== id)
        await store.saveCard(card)
        detached.push(card.name)
      }
      return { ok: true, detached }
    }],

    ['GET', /^\/api\/presets$/, async () => (await store.listPresets()).map(presetSummary)],
    ['POST', /^\/api\/presets\/import$/, async (_, body) => {
      const { filename, buffer } = decodeUpload(body)
      let json
      try {
        json = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
      } catch {
        throw httpError(400, msg`无法解析预设 JSON`)
      }
      const preset = importOwnPreset(json) ?? normalizePreset(json, filename.replace(/\.json$/i, ''))
      await store.savePreset(preset)
      return presetSummary(preset)
    }],
    ['GET', /^\/api\/presets\/([\w-]+)\/export$/, async ([id]) => exportPreset(await store.getPreset(id))],
    // The built-in preset: its options live in the settings (PUT /api/settings { basic }).
    ['GET', /^\/api\/presets\/basic$/, async () => basicDetail(await store.getSettings())],
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
        if (engine.isRunning(id)) throw httpError(409, msg`正在生成，等这轮写完再改名`)
        chat.title = body.title.trim().slice(0, 80)
      }
      // A chat's own model; empty follows the global default. Caches are per model,
      // so switching costs one full cache write on the next turn.
      if (body.model !== undefined) chat.model = body.model ? modelRef(body.model) : null
      return { ...chatView(await store.saveChat(chat)), running: engine.isRunning(id) }
    }],
    ['DELETE', /^\/api\/chats\/([\w-]+)$/, async ([id]) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      await store.deleteChat(id)
      await prompts.adoptChat(id).catch(() => {})
      await media.removeChatMedia(id)
      return { ok: true }
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/select$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(id)
      selectNode(chat, String(body.nodeId))
      return chatView(await store.saveChat(chat))
    }],
    // Rollback hides the later turns (kept as a branch); the next message forks
    // the SDK session at that point, so the cache up to there still hits.
    ['POST', /^\/api\/chats\/([\w-]+)\/rollback$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
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
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(id)
      restoreFolded(chat)
      return chatView(await store.saveChat(chat))
    }],
    // Manual compaction: one summary call, then the next turn starts a new session (see recap.mjs).
    ['POST', /^\/api\/chats\/([\w-]+)\/compact$/, async ([id]) => ({ ...chatView(await engine.compactChat(id)), running: false })],
    ['PUT', /^\/api\/chats\/([\w-]+)\/compaction$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
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
    // A SillyTavern chat file (.jsonl, sent as text): every turn, under the chosen card (st-chat.mjs).
    ['POST', /^\/api\/chats\/import-sillytavern$/, async (_, body) => {
      const { chat, turns, chars, pendingInput } = await importSillyTavern(store, String(body.cardId ?? ''), { text: body.text, filename: typeof body.filename === 'string' ? body.filename : '' })
      return { ...chatView(chat), imported: { turns, chars, pendingInput } }
    }],
    ['DELETE', /^\/api\/chats\/([\w-]+)\/compaction$/, async ([id], _, url) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(id)
      dropCompaction(chat, String(url.searchParams.get('nodeId')))
      return chatView(await store.saveChat(chat))
    }],
    // Switch a chat's preset (or re-render its prefix after editing the one it
    // uses). Costs one cache write on the next turn.
    ['POST', /^\/api\/chats\/([\w-]+)\/preset$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      const chat = await store.getChat(id)
      await rebuildPrompt(store, chat, typeof body.presetId === 'string' ? body.presetId : chat.presetId ?? '')
      return { ...chatView(await store.saveChat(chat)), running: false }
    }],
    ['POST', /^\/api\/chats\/([\w-]+)\/stop$/, ([id]) => ({ stopped: engine.stop(id) })],
    ['PUT', /^\/api\/chats\/([\w-]+)\/state$/, async ([id], body) => {
      if (engine.isRunning(id)) throw httpError(409, msg`正在生成，先停止`)
      if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) throw httpError(400, msg`状态必须是 JSON 对象`)
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
      sendJson(res, 403, { error: msg`不允许从这个地址访问` })
      return false
    }
    if (!accessToken && (access.mode !== 'lan' || isLoopback(req.socket.remoteAddress))) return true
    if (req.method === 'GET' && OPEN_FILES.has(url.pathname)) return true
    const token = accessToken ?? (await store.ensureAccessToken())
    const presented = readCookie(req.headers.cookie, 'tavern_key') || String(req.headers['x-agent-tavern-key'] ?? '')
    if (tokensEqual(presented, token)) return true
    if (req.method === 'POST' && url.pathname === '/api/access/unlock') {
      const body = await readBody(req)
      if (!tokensEqual(body.token, token)) {
        sendJson(res, 403, { error: msg`口令不对` })
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
    sendJson(res, 401, { error: msg`需要本机给出的链接` })
    return false
  }

  /**
   * A connection nobody configured may be made: its setting is on (when one is
   * named) and, in the public builds, the 隐私与网络 notice has been seen.
   */
  async function allowed(setting) {
    const settings = await store.getSettings()
    if (setting && settings[setting] === false) return false
    return !features.privacyNotice || settings.privacyNotice >= PRIVACY_NOTICE
  }

  // 设置 → 界面语言, kept here so a request does not read the settings file for it.
  let uiLanguage = null

  /** Each request runs in the language of the page that sent it (server/i18n.mjs). */
  async function handle(req, res) {
    uiLanguage ??= (await store.getSettings()).uiLanguage
    return withLanguage(requestLanguage(uiLanguage, req), () => serve(req, res))
  }

  async function serve(req, res) {
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
      const [file, type] = STATIC[url.pathname]
      let body = await readFile(path.join(WEB_ROOT, file))
      // 隐私与网络 → 网络字体 off, or not agreed to yet: the page asks nothing of Google Fonts.
      if (file === 'index.html' && !(await allowed('webFonts'))) {
        body = body.toString('utf8').split('\n').filter(line => !/fonts\.(googleapis|gstatic)\.com/.test(line)).join('\n')
      }
      if (file === 'index.html') body = pageIn(body.toString('utf8'), currentLanguage())
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      return res.end(body)
    }
    // The card as a SillyTavern PNG, in-app edits included (修改角色卡 → 导出 PNG).
    const cardPng = /^\/api\/cards\/([\w-]+)\/png$/.exec(url.pathname)
    if (req.method === 'GET' && cardPng) {
      try {
        const card = await store.getCard(cardPng[1])
        const picture = await readFile(store.avatarPath(card.id))
        const data = writeCardPng(picture, sillyTavernCard(card, rawOfPicture(picture)))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${card.name}.png`)}` })
        return res.end(data)
      } catch (error) {
        return sendJson(res, error.status ?? 404, { error: error.status ? error.message : msg`没有头像` })
      }
    }
    const avatar = /^\/api\/cards\/([\w-]+)\/avatar$/.exec(url.pathname)
    if (req.method === 'GET' && avatar) {
      try {
        const data = await readFile(store.avatarPath(avatar[1]))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' })
        return res.end(data)
      } catch {
        return sendJson(res, 404, { error: msg`没有头像` })
      }
    }

    // The home-screen app. Asked for by a phone that has logged in, it starts with the access
    // token, so the icon opens straight into the app even where it keeps cookies of its own (iOS).
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const token = access.mode === 'lan' ? accessToken ?? (await store.ensureAccessToken()) : ''
      const signedIn = Boolean(token) && tokensEqual(readCookie(req.headers.cookie, 'tavern_key'), token)
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({
        name: features.appName,
        short_name: features.appName,
        start_url: signedIn ? `/#k=${encodeURIComponent(token)}` : '/',
        scope: '/',
        display: 'standalone',
        background_color: '#eceeea',
        theme_color: '#eceeea',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      }))
    }

    const scenePicture = /^\/api\/scenes\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && scenePicture) {
      const found = await scenes.readPicture(scenePicture[1], scenePicture[2])
      if (!found) return sendJson(res, 404, { error: msg`没有这张场景图` })
      // A picture's name changes with the picture: it can stay cached.
      res.writeHead(200, { 'content-type': found.type, 'cache-control': 'max-age=31536000, immutable' })
      return res.end(found.data)
    }
    // 更新了什么 (web/whatsnew.js): the notes and their pictures, shipped in web/whatsnew/.
    const whatsNew = /^\/whatsnew\/([\w.-]+\.(json|webp|png|jpg))$/.exec(url.pathname)
    if (req.method === 'GET' && whatsNew) {
      const type = { json: 'application/json; charset=utf-8', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' }[whatsNew[2]]
      try {
        const data = await readFile(path.join(WEB_ROOT, 'whatsnew', whatsNew[1]))
        // Notes change with each version; a picture's name carries its version.
        res.writeHead(200, { 'content-type': type, 'cache-control': whatsNew[2] === 'json' ? 'no-cache' : 'max-age=31536000, immutable' })
        return res.end(data)
      } catch {
        return sendJson(res, 404, { error: msg`没有这个文件` })
      }
    }
    const savePicture = /^\/api\/saves\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && savePicture) {
      const found = await saves.readPicture(savePicture[1], savePicture[2])
      if (!found) return sendJson(res, 404, { error: msg`没有这张图` })
      // Each save's picture has a name of its own.
      res.writeHead(200, { 'content-type': found.type, 'cache-control': 'max-age=31536000, immutable' })
      return res.end(found.data)
    }
    const spritePicture = /^\/api\/sprites\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && spritePicture) {
      const found = await scenes.readSprite(spritePicture[1], spritePicture[2])
      if (!found) return sendJson(res, 404, { error: msg`没有这张立绘` })
      res.writeHead(200, { 'content-type': found.type, 'cache-control': 'max-age=31536000, immutable' })
      return res.end(found.data)
    }

    const backdrop = /^\/api\/appearance\/(backdrop-[\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && backdrop) {
      const found = await appearance.readBackdrop(backdrop[1])
      if (!found) return sendJson(res, 404, { error: msg`没有这张背景图` })
      // Each picture has a name of its own that never changes: it can stay cached.
      res.writeHead(200, { 'content-type': found.type, 'cache-control': 'max-age=31536000, immutable' })
      return res.end(found.data)
    }

    // The avatar of a card being created (创作角色卡).
    const forgeAvatar = /^\/api\/forge\/([\w-]+)\/avatar$/.exec(url.pathname)
    if (req.method === 'GET' && forgeAvatar) {
      try {
        const { buffer, type } = await forge.readAvatar(forgeAvatar[1])
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        return res.end(buffer)
      } catch (error) {
        return sendJson(res, error.status ?? 404, { error: error.message })
      }
    }

    const rosterRef = /^\/api\/cards\/([\w-]+)\/roster\/([\w-]+)\/ref$/.exec(url.pathname)
    if (req.method === 'GET' && rosterRef) {
      const data = await media.readRosterRef(rosterRef[1], rosterRef[2]).catch(() => null)
      if (!data) return sendJson(res, 404, { error: msg`这个角色还没有人设图` })
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
      if (!data) return sendJson(res, 404, { error: msg`图片不存在` })
      const type = data[0] === 0xff ? 'image/jpeg' : data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' })
      return res.end(data)
    }

    const picture = /^\/api\/media\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && picture) {
      const data = await media.readImage(picture[1], picture[2]).catch(() => null)
      if (!data) return sendJson(res, 404, { error: msg`图片不存在` })
      const type = /\.jpe?g$/.test(picture[2]) ? 'image/jpeg' : picture[2].endsWith('.webp') ? 'image/webp' : 'image/png'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' })
      return res.end(data)
    }

    if (req.method !== 'GET' && req.headers['x-agent-tavern'] !== '1') return sendJson(res, 403, { error: msg`缺少请求头` })

    const packagePicture = /^\/api\/chats\/([\w-]+)\/media\/([\w.-]+)$/.exec(url.pathname)
    if (req.method === 'PUT' && packagePicture) {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) throw httpError(413, msg`图片太大`)
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
      const audio = await media.speak({ text: body.text, voice: typeof body.voice === 'string' ? body.voice : '', stable: body.stable === true, fresh: body.fresh === true }, cancelOnClose())
      res.writeHead(200, { 'content-type': audio.mime, 'cache-control': 'no-store' })
      return res.end(audio.buffer)
    }
    // 试听 in 配图与朗读: the form's unsaved voice settings and typed keys, nothing cached.
    if (req.method === 'POST' && url.pathname === '/api/media/voices/preview') {
      const body = await readBody(req)
      const text = name => (typeof body[name] === 'string' ? body[name] : '')
      const audio = await media.previewVoice({ voice: text('voice'), source: text('source'), text: text('text'), media: body.media, keys: body.keys }, cancelOnClose())
      res.writeHead(200, { 'content-type': audio.mime, 'cache-control': 'no-store' })
      return res.end(audio.buffer)
    }
    // 从账户读取音色: the account's voices merged into the form's list, read with the saved or typed key (never sent back).
    if (req.method === 'POST' && url.pathname === '/api/media/voices/account') {
      const body = await readBody(req)
      const source = typeof body.source === 'string' ? body.source : ''
      return sendJson(res, 200, await media.accountVoices({ source, media: body.media, keys: body.keys }, cancelOnClose()))
    }
    const sceneDraw = /^\/api\/cards\/([\w-]+)\/scenes\/draw$/.exec(url.pathname)
    if (req.method === 'POST' && sceneDraw) {
      const body = await readBody(req)
      const text = name => (typeof body[name] === 'string' ? body[name] : '')
      return sendJson(res, 200, await scenes.draw(sceneDraw[1], { place: text('place'), sceneId: text('sceneId'), prompt: text('prompt'), rewrite: body.rewrite === true, passage: text('passage') }, cancelOnClose()))
    }
    const spriteDraw = /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)\/draw$/.exec(url.pathname)
    if (req.method === 'POST' && spriteDraw) {
      await readBody(req)
      return sendJson(res, 200, await scenes.drawSprite(spriteDraw[1], spriteDraw[2], cancelOnClose()))
    }
    // 用辅助模型判断表情 (视觉小说): the helper labels a reply's lines.
    if (req.method === 'POST' && url.pathname === '/api/vn/expressions') {
      const body = await readBody(req)
      return sendJson(res, 200, await media.labelExpressions(body.lines, cancelOnClose()))
    }
    const expressionDraw = /^\/api\/cards\/([\w-]+)\/sprites\/([\w-]+)\/expressions\/(\w+)\/draw$/.exec(url.pathname)
    if (req.method === 'POST' && expressionDraw) {
      await readBody(req)
      return sendJson(res, 200, await scenes.drawExpression(expressionDraw[1], expressionDraw[2], expressionDraw[3], cancelOnClose()))
    }
    const imageRoute = /^\/api\/chats\/([\w-]+)\/nodes\/([\w-]+)\/(image-prompt|image)$/.exec(url.pathname)
    if (req.method === 'POST' && imageRoute) {
      const [, chatId, nodeId, kind] = imageRoute
      const body = await readBody(req)
      const signal = cancelOnClose()
      const chat = await store.getChat(chatId)
      const node = chat.nodes[nodeId]
      if (!node || node.role !== 'assistant') throw httpError(404, msg`这条叙述不存在`)
      if (kind === 'image-prompt') {
        const reply = typeof body.reply === 'string' && body.reply.trim() ? body.reply : node.display ?? node.text
        const input = node.parent ? chat.nodes[node.parent]?.text ?? '' : ''
        return sendJson(res, 200, await media.writeImagePrompt(chat, node, { reply, input }, signal))
      }
      const image = await media.generateImage(chat, nodeId, body.prompt, signal, drawChoiceOf(body))
      // Re-read: the chat may have moved on while the picture was drawn.
      const fresh = await store.getChat(chatId)
      const target = fresh.nodes[nodeId]
      if (!target) throw httpError(404, msg`这条叙述已经不在了`)
      target.media = { ...(target.media ?? {}), images: [...(target.media?.images ?? []), image] }
      await prompts.recordDrawn(fresh, target, image).catch(() => {})
      return sendJson(res, 200, { image, chat: { ...chatView(await store.saveChat(fresh)), running: engine.isRunning(chatId) } })
    }

    // 设置 → 更多 → 更新: any page may check; downloading, switching versions and
    // deleting old folders only from this computer, like 停止后台服务.
    if (url.pathname === '/api/update' || url.pathname.startsWith('/api/update/')) {
      const local = isLoopback(req.socket.remoteAddress)
      const action = url.pathname.slice('/api/update'.length) || '/'
      const body = req.method === 'GET' ? {} : await readBody(req)
      const view = result => sendJson(res, 200, { ...result, local })
      // The daily check by itself waits for the 隐私与网络 notice; 检查更新 is the user asking.
      if (req.method === 'GET' && action === '/') return view(await (url.searchParams.get('auto') === '1' && (await allowed()) ? updater.check() : updater.status()))
      if (req.method === 'POST' && action === '/check') return view(await updater.check({ force: true }))
      if (req.method === 'PUT' && action === '/settings') return view(await updater.setAutoCheck(body.autoCheck !== false))
      if (req.method === 'POST' && action === '/ack') return view(await updater.acknowledge())
      if (req.method === 'POST' && action === '/skip') return view(await updater.skip(body.version))
      const own = { 'GET /installs': () => updater.installs(), 'POST /download': () => updater.download(), 'POST /cancel': () => updater.cancel(), 'POST /apply': () => updater.apply(), 'POST /rollback': () => updater.rollback(), 'POST /remove': () => updater.remove(body.path) }[`${req.method} ${action}`]
      if (!own) return sendJson(res, 404, { error: msg`没有这个接口` })
      if (!local) return sendJson(res, 403, { error: msg`只能在这台电脑上更新` })
      return view(await own())
    }

    // 设置 → 更多 →「桌面快捷方式」: CicaTavern.exe makes it itself (IShellLink), only for this computer.
    if (req.method === 'POST' && url.pathname === '/api/shortcut') {
      if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: msg`只能在这台电脑上创建快捷方式` })
      if (!hasLauncher()) return sendJson(res, 404, { error: msg`没有 CicaTavern.exe` })
      const body = await readBody(req)
      try {
        return sendJson(res, 200, { file: await createShortcut(LAUNCHER, { startMenu: body.startMenu === true }) })
      } catch (error) {
        return sendJson(res, 500, { error: msg`快捷方式没建成：${error.message}` })
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (!onShutdown) return sendJson(res, 404, { error: msg`这个服务不能从页面停止` })
      if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: msg`只能在这台电脑上停止服务` })
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
    sendJson(res, 404, { error: msg`没有这个接口` })
  }

  return {
    store,
    engine,
    isolation,
    subscription,
    features,
    network,
    updater,
    bound,
    /** @param host - the address to bind instead of the mode's own (tests keep a LAN-mode server on loopback). */
    async listen({ port = 8791, listen, host: bindHost } = {}) {
      await store.init()
      await backfillEntryPositions(store)
      if (subscription) await subscription.prepareStorage()
      await initTemplates()
      const settings = await store.getSettings()
      await network.apply(settings.proxy)
      if (listen === 'lan' || listen === 'local') listenArg = listen
      const wanted = listen === 'lan' || listen === 'local' ? listen : settings.listen === 'lan' ? 'lan' : 'local'
      const mode = features.lan ? wanted : 'local'
      const host = bindHost ?? (mode === 'lan' ? '0.0.0.0' : '127.0.0.1')
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
