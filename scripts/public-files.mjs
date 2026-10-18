// What may leave this repository: the release package, the phone app and the
// public source tree all go through publicFile(). The Claude subscription
// backend (server/subscription/) and the personal install's icon stay here.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { featuresOf } from '../server/edition.mjs'

const PRIVATE = [
  /(^|\/)server\/subscription(\/|$)/,
  /(^|\/)web\/icon-agent\./,
  /(^|\/)bin\/login\.mjs$/,
  /(^|\/)Login-AgentTavern\.cmd$/,
  /(^|\/)test\/subscription-[^/]*\.test\.mjs$/,
  /(^|\/)test\/local-paths\.mjs$/,
  /(^|\/)docs\/release-design\.md$/,
  /(^|\/)docs\/brand\/concepts(\/|$)/,
]

/** cp() filter: false for a private path (absolute or relative, either slash). */
export function publicFile(file) {
  const normal = path.resolve(file).split(path.sep).join('/')
  return !PRIVATE.some(pattern => pattern.test(normal))
}

const crlf = text => text.replace(/\r?\n/g, '\r\n')

/** VBScript source as Windows reads it: UTF-16LE with a BOM (anything else garbles the Chinese text). */
export const vbs = text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf(text), 'utf16le')])

/** bin/launch.vbs for the release: its failure box names the release and its data folder. */
export async function releaseLaunchVbs(root) {
  const release = featuresOf('release')
  const source = (await readFile(path.join(root, 'bin', 'launch.vbs'))).subarray(2).toString('utf16le')
  return vbs(source.split('Agent 酒馆').join(release.appName).split('.agent-tavern').join(release.dataDir))
}
