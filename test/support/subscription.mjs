// The Claude subscription backend (server/subscription/) is in this machine's
// own install only; the suite also runs in public trees without it.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const index = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'subscription', 'index.mjs')
const backend = existsSync(index) ? await import('../../server/subscription/index.mjs') : null

/** A backend for an engine under test, with a fake SDK query; null in a tree without it. */
export function testSubscription(store, root, query) {
  return backend ? backend.createSubscription({ store, isolation: { configDir: path.join(root, 'claude-config'), proxy: null }, query }) : null
}
