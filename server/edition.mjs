// What each edition of the app can do. Code asks for a capability, never for
// an edition by name.
//   personal: this machine's own install: the Claude subscription through the
//             Agent SDK, the xiaoya voice bridge and DSH import assumed.
//   release:  the build handed to other people: API providers only (a third
//             party may not offer claude.ai login, see docs/release-design.md)
//             and no local helpers assumed.
//   android:  the CicaTavern phone app's embedded Node (android/): providers only,
//             loopback only.
// A packaged build names its edition in edition.json at the package root.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The proxy this machine's own install has always used. */
export const PERSONAL_PROXY = 'http://127.0.0.1:7897'

// The release is its own app (CicaTavern) with its own data folder and port,
// so it can sit next to this machine's own install. proxy: the 网络代理 setting
// needs Node 24 (http.Agent proxyEnv); the phone's Node is 18.
const EDITIONS = {
  personal: { subscription: true, lan: true, dshImport: true, xiaoya: true, proxy: true, defaultProxy: PERSONAL_PROXY, appName: 'Agent 酒馆', dataDir: '.agent-tavern', port: 8791, icon: 'icon-agent' },
  release: { subscription: false, lan: true, dshImport: false, xiaoya: false, proxy: true, defaultProxy: 'none', appName: 'CicaTavern', dataDir: '.cicatavern', port: 8790, icon: 'icon' },
  android: { subscription: false, lan: false, dshImport: false, xiaoya: false, proxy: false, defaultProxy: 'none', appName: 'CicaTavern', dataDir: '.cicatavern', port: 0, icon: 'icon' },
}
// The name this edition had before there were several.
const ALIASES = { desktop: 'personal' }

/** A known edition name, or 'personal'. */
export function editionName(value) {
  const name = ALIASES[value] ?? value
  return Object.hasOwn(EDITIONS, name) ? name : 'personal'
}

/** { edition, subscription, lan, dshImport, xiaoya, proxy, defaultProxy, appName, dataDir, port, icon } */
export function featuresOf(edition) {
  const name = editionName(edition)
  return { edition: name, ...EDITIONS[name] }
}

/** The edition a packaged build was made for (edition.json), or undefined. */
export function packagedEdition(root = APP_ROOT) {
  try {
    const value = JSON.parse(readFileSync(path.join(root, 'edition.json'), 'utf8')).edition
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/** The app version from package.json. */
export function appVersion(root = APP_ROOT) {
  try {
    return String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}
