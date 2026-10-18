// What may leave this repository: the release package, the phone app and the
// public source tree all go through publicFile(). The Claude subscription
// backend (server/subscription/) and its login stay here. Nothing public ships
// a script-host file (.vbs and the like): CicaTavern.exe (launcher/) starts the app.
import path from 'node:path'

const PRIVATE = [
  /(^|\/)server\/subscription(\/|$)/,
  /(^|\/)bin\/login\.mjs$/,
  /\.(vbs|vbe|wsf|ps1)$/i,
  /(^|\/)Login-AgentTavern\.cmd$/,
  /(^|\/)test\/subscription-[^/]*\.test\.mjs$/,
  /(^|\/)test\/local-paths\.mjs$/,
  /(^|\/)docs\/release-design\.md$/,
  /(^|\/)docs\/signpath-application\.md$/,
  /(^|\/)docs\/brand\/concepts(\/|$)/,
]

/** cp() filter: false for a private path (absolute or relative, either slash). */
export function publicFile(file) {
  const normal = path.resolve(file).split(path.sep).join('/')
  return !PRIVATE.some(pattern => pattern.test(normal))
}
