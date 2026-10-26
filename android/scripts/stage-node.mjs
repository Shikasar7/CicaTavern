// Copy what the phone's Node needs into the APK's assets:
//   android/app/src/main/assets/nodejs-project/
// Server, web UI, the Android entry and the runtime dependencies (yaml,
// quickjs). Not the Agent SDK or Claude Code: the app uses provider APIs only.
// Run by the Gradle build (preBuild), or by hand: node android/scripts/stage-node.mjs [outDir]
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicFile } from '../../scripts/public-files.mjs'
import { RUNTIME_MODULES } from '../../scripts/runtime-modules.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = path.resolve(process.argv[2] ?? path.join(root, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project'))

const MODULES = RUNTIME_MODULES

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(path.join(root, 'server'), path.join(out, 'server'), { recursive: true, filter: publicFile })
await cp(path.join(root, 'web'), path.join(out, 'web'), { recursive: true, filter: publicFile })
await cp(path.join(root, 'bin', 'android.mjs'), path.join(out, 'bin', 'android.mjs'))
for (const name of MODULES) {
  await cp(path.join(root, 'node_modules', name), path.join(out, 'node_modules', name), { recursive: true })
}
// "type": "module" makes web/shared/*.js load as ES modules, as on the desktop.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await writeFile(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2))

// The app re-extracts the assets only when this changes (NodeRuntime.extractIfChanged): everything the phone's
// Node loads, so a release that only bumps the version (package.json) or a dependency reaches it too.
const hash = createHash('sha256')
for (const dir of ['server', 'web', 'bin', 'node_modules']) {
  for (const file of readdirSync(path.join(out, dir), { recursive: true }).sort()) {
    const full = path.join(out, dir, String(file))
    try { hash.update(String(file)).update(await readFile(full)) } catch { /* a directory */ }
  }
}
hash.update(MODULES.join(','))
hash.update(await readFile(path.join(out, 'package.json')))
await writeFile(path.join(out, 'stamp.txt'), hash.digest('hex').slice(0, 16))
console.log(`[stage-node] ${out}`)
