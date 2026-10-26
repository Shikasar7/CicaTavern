// The app window: Edge or Chrome with --app (no tabs, no address bar), as the
// desktop launcher (bin/launch.mjs) and `start.mjs --open` open it. Only when
// neither is installed does the page open in the default browser.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const CHROMIUM = [
  'Microsoft/Edge/Application/msedge.exe',
  'Google/Chrome/Application/chrome.exe',
  'Chromium/Application/chrome.exe',
  'BraveSoftware/Brave-Browser/Application/brave.exe',
]

/** A browser that can show an app window, or null. */
export function appBrowser(env = process.env) {
  if (process.platform !== 'win32') return null
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)
  for (const rel of CHROMIUM) {
    for (const root of roots) {
      const file = path.join(root, rel)
      if (existsSync(file)) return file
    }
  }
  return null
}

/** Start a program and let it go; `failed` when it cannot start (gone, not allowed), instead of crashing the server. */
function launch(command, args, failed) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.once('error', failed)
  child.unref()
}

/** Open the page in its own app window; 'app' or 'browser' says which it got. */
export function openAppWindow(url) {
  // The default browser: Explorer hands the address to it.
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const byHand = error => console.warn(`[CicaTavern] couldn't open a browser (${error.message}): open ${url} by hand`)
  const browser = appBrowser()
  if (browser) {
    launch(browser, [`--app=${url}`, '--window-size=1280,860'], () => launch(opener, [url], byHand))
    return 'app'
  }
  launch(opener, [url], byHand)
  return 'browser'
}
