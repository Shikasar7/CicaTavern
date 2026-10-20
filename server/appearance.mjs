// 外观: the picture behind the page. settings.appearance.backdrop names its file
// in the data folder's ui/; a new picture gets a new name, so the page can keep
// it cached for good. The page shrinks it before sending (web/theme.js).
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BACKDROP_FILE } from '../web/shared/appearance.js'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const MAX_BYTES = 12 * 1024 * 1024
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/** The file's type from its first bytes, or '' when it is none of the three. */
function sniff(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer.subarray(0, 4).toString('latin1') === '\x89PNG') return 'png'
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return ''
}

export function createAppearance(store) {
  const dir = path.join(store.dirs.root, 'ui')
  const drop = async file => {
    if (file) await rm(path.join(dir, file), { force: true })
  }

  /** A data URL from the page → the new picture; the old one goes. → the settings. */
  async function saveBackdrop(dataUrl) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
    const buffer = match ? Buffer.from(match[1], 'base64') : null
    const kind = buffer ? sniff(buffer) : ''
    if (!kind) throw httpError(400, msg`背景图要是 PNG、JPG 或 WebP`)
    if (buffer.length > MAX_BYTES) throw httpError(400, msg`背景图太大（最多 12MB）`)
    const before = (await store.getSettings()).appearance.backdrop
    const file = `backdrop-${randomBytes(5).toString('hex')}.${kind}`
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, file), buffer)
    const saved = await store.saveSettings({}, { backdrop: file })
    await drop(before)
    return saved
  }

  async function removeBackdrop() {
    const before = (await store.getSettings()).appearance.backdrop
    const saved = await store.saveSettings({}, { backdrop: '' })
    await drop(before)
    return saved
  }

  /** → { data, type }, or null when there is no such picture. */
  async function readBackdrop(file) {
    if (!BACKDROP_FILE.test(file)) return null
    const data = await readFile(path.join(dir, file)).catch(() => null)
    return data && { data, type: TYPES[file.split('.').pop()] }
  }

  return { saveBackdrop, removeBackdrop, readBackdrop }
}
