// 导出角色卡 → 带上图片和设置: a card with what the app keeps beside it, as one zip to move it to another device
// or hand to someone else, and that zip read back onto a card.
//   card.png | card.json   the card as SillyTavern reads it (the same file 导出角色卡 gives): unzipped, it imports there
//   cicatavern-pack.json   what else is in the zip (the manifest below)
//   roster/<entry id>.png  人设图           sprites/<file>   立绘 and 表情
//   scenes/<file>          场景图           cover.jpg        开场页的图
//   cgs/<file>             卡的 CG (card-cgs.mjs), in their groups
//   foes/<file>            the rule book's 敌人图   look/<file>      定制外观的图 (look-pictures.mjs)
//   skills/<file>          the rule book's 技能图 (技能特写)
// 游戏规则设置 (the rule book) is a part too: ticked, it is in the card file as always and in the manifest, so an
// import over a card that has rules of its own takes the pack's; not ticked, the card file goes without it.
// Which of these go is the player's pick (PARTS). 正则集 attached to the card go as sets and are attached again;
// 画风, LoRA names and 朗读 voices go as settings. Music, chats, 抽图历史 and saves never go.
// Nothing in a zip is trusted: file names are matched against the shapes the app writes itself, pictures are
// checked by their first bytes and their size, and only what the manifest names is read.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { imageKind } from './appearance.mjs'
import { cleanCardMedia } from './media.mjs'
import { cleanScripts } from './regex.mjs'
import { isRosterId } from './roster.mjs'
import { MAX_SKILL_PICTURES } from '../web/shared/game/sheet.js'
import { readCgs } from './card-cgs.mjs'
import { httpError, readJsonFile, writeJson } from './store.mjs'
import { msg } from './i18n.mjs'
import { crcOf, zipParts } from './update/zip.mjs'
import { EXPRESSIONS } from '../web/shared/stage.js'
import { zipData, zipEntries } from '../web/shared/zip.js'

export const PACK_FORMAT = 'cicatavern-card-pack'
export const PACK_MANIFEST = 'cicatavern-pack.json'
/**
 * What can be ticked, in the order shown. 立绘和表情 belong to roster entries, so they take the roster along; 敌人图
 * and 技能图 belong to the rule book's foes and skills, so they take the rules.
 */
export const PARTS = ['roster', 'sprites', 'scenes', 'cgs', 'cover', 'look', 'rules', 'foes', 'skills', 'regex', 'settings']
export const MAX_PACK = 500 * 1024 * 1024
const MAX_ENTRIES = 4000
const MAX_MANIFEST = 8 * 1024 * 1024
const MAX_CARD_FILE = 150 * 1024 * 1024
const MAX_PICTURE = 12 * 1024 * 1024
const MAX_REF = 15 * 1024 * 1024
const MAX_SCENES = 200
const MAX_SETS = 20
const FILE = /^[\w-]{1,64}\.(png|jpg|webp)$/
const ENTRY = /^[\w-]{1,40}$/
const SETTINGS = ['style', 'styleNegative', 'promptRules', 'loras', 'voice', 'narratorVoice']
const ENTRY_SETTINGS = ['lora', 'loraTrigger', 'loraStrength', 'voice']
const inflateRaw = promisify(zlib.inflateRaw)
const clip = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
const record = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const sizeOf = file => stat(file).then(info => (info.isFile() ? info.size : 0), () => 0)
/** A set's scripts whatever their ids: two sets with the same scripts are the same set. */
const scriptsKey = scripts => JSON.stringify(cleanScripts(scripts).map(({ id: _id, ...script }) => script))

/** The parts asked for that exist as parts, sprites with their roster. */
export function cleanParts(include) {
  const wanted = new Set((Array.isArray(include) ? include : []).filter(part => PARTS.includes(part)))
  if (wanted.has('sprites')) wanted.add('roster')
  if (wanted.has('foes') || wanted.has('skills')) wanted.add('rules')
  return PARTS.filter(part => wanted.has(part))
}

/**
 * @param rulebooks - createRulebooks(): the bestiary's pictures.
 * @param regex - createRegex(): 正则集 made and attached.
 * @param look - createLookPictures(): the pictures a 定制外观 names.
 */
export function createCardPacks(store, { rulebooks, regex, look = null, cgs = null }) {
  const cardDir = cardId => path.dirname(store.avatarPath(cardId))
  const at = (cardId, ...parts) => path.join(cardDir(cardId), ...parts)

  /**
   * Everything of a card a pack can take: per part, what the manifest says of it and the files it brings
   * ([{ name (in the zip), file (on disk), size }]). A part the card has nothing for is left out.
   */
  async function collect(cardId) {
    const card = await store.getCard(cardId)
    const media = cleanCardMedia(card.media)
    const found = {}
    const picture = async (name, file) => {
      const size = await sizeOf(file)
      return size ? { name, file, size } : null
    }

    if (media.roster.length) {
      const refs = (await Promise.all(media.roster.map(entry => picture(`roster/${entry.id}.png`, at(cardId, 'roster', `${entry.id}.png`))))).filter(Boolean)
      found.roster = { count: media.roster.length, files: refs, roster: media.roster, refs: refs.map(ref => path.basename(ref.name, '.png')) }
    }

    const ids = new Set(media.roster.map(entry => entry.id))
    const kept = await readJsonFile(at(cardId, 'sprites.json'), null)
    const sprites = {}
    const expressions = {}
    const outfits = {}
    const spriteFiles = []
    const take = async value => {
      if (!FILE.test(value?.file ?? '')) return null
      const file = await picture(`sprites/${value.file}`, at(cardId, 'sprites', value.file))
      if (file) spriteFiles.push(file)
      return file ? value : null
    }
    for (const [id, sprite] of Object.entries(record(kept?.sprites))) {
      if (ids.has(id) && (await take(sprite))) sprites[id] = sprite
    }
    for (const [id, faces] of Object.entries(record(kept?.expressions))) {
      if (!ids.has(id)) continue
      const own = {}
      for (const [name, face] of Object.entries(record(faces))) {
        if (EXPRESSIONS.includes(name) && name !== 'neutral' && (await take(face))) own[name] = face
      }
      if (Object.keys(own).length) expressions[id] = own
    }
    // 衣柜: a 立绘 per outfit still in it.
    for (const entry of media.roster) {
      const own = {}
      for (const item of entry.wardrobe ?? []) {
        const drawn = record(record(kept?.outfits)[entry.id])[item.id]
        if (await take(drawn)) own[item.id] = drawn
      }
      if (Object.keys(own).length) outfits[entry.id] = own
    }
    if (spriteFiles.length) found.sprites = { count: spriteFiles.length, files: spriteFiles, sprites, expressions, outfits }

    const listed = (await readJsonFile(at(cardId, 'scenes.json'), null))?.scenes
    const scenes = []
    const sceneFiles = []
    for (const scene of Array.isArray(listed) ? listed : []) {
      if (!ENTRY.test(scene?.id ?? '')) continue
      const file = FILE.test(scene.file ?? '') ? await picture(`scenes/${scene.file}`, at(cardId, 'scenes', scene.file)) : null
      if (file) sceneFiles.push(file)
      scenes.push({ ...scene, file: file ? scene.file : '' })
    }
    if (sceneFiles.length) found.scenes = { count: sceneFiles.length, files: sceneFiles, scenes }

    const groups = []
    const cgFiles = []
    for (const group of await readCgs(store.dirs, cardId)) {
      const pictures = []
      for (const item of Array.isArray(group?.pictures) ? group.pictures : []) {
        const file = FILE.test(item?.file ?? '') ? await picture(`cgs/${item.file}`, at(cardId, 'cgs', item.file)) : null
        if (!file) continue
        cgFiles.push(file)
        pictures.push(item.file)
      }
      if (pictures.length) groups.push({ name: group.name, aliases: group.aliases ?? [], note: group.note ?? '', pictures })
    }
    if (cgFiles.length) found.cgs = { count: cgFiles.length, files: cgFiles, groups }

    const cover = card.coverArt ? await picture('cover.jpg', store.coverArtPath(cardId)) : null
    if (cover) found.cover = { count: 1, files: [cover] }

    const lookFiles = []
    const pictures = {}
    for (const item of look ? await look.files(cardId).catch(() => []) : []) {
      const file = await picture(item.name, item.file)
      if (!file) continue
      lookFiles.push(file)
      pictures[item.token] = item.item
    }
    if (lookFiles.length) found.look = { count: lookFiles.length, files: lookFiles, pictures }

    // The book as it travels (no pictures); null for a card that never had one.
    const rules = await rulebooks.portable(cardId).catch(() => null)
    if (rules) found.rules = { count: 1, files: [], rules }

    const book = rules ? await rulebooks.read(cardId).catch(() => null) : null
    const foes = {}
    const foeFiles = []
    for (const [name, foe] of Object.entries(record(book?.foes))) {
      if (!FILE.test(foe?.file ?? '')) continue
      const file = await picture(`foes/${foe.file}`, at(cardId, 'foes', foe.file))
      if (!file) continue
      foeFiles.push(file)
      foes[name] = foe.file
    }
    if (foeFiles.length) found.foes = { count: foeFiles.length, files: foeFiles, foes }

    const skills = {}
    const skillFiles = []
    for (const [name, kept] of Object.entries(record(book?.skillPictures))) {
      const file = FILE.test(kept ?? '') ? await picture(`skills/${kept}`, at(cardId, 'skills', kept)) : null
      if (!file) continue
      skillFiles.push(file)
      skills[name] = kept
    }
    if (skillFiles.length) found.skills = { count: skillFiles.length, files: skillFiles, skills }

    const sets = (await store.getRegexSets()).filter(set => set.cardIds.includes(cardId))
    if (sets.length) found.regex = { count: sets.length, files: [], sets: sets.map(set => ({ name: set.name, description: set.description, scripts: set.scripts })) }

    const settings = Object.fromEntries(SETTINGS.map(key => [key, media[key]]))
    const said = Boolean(settings.style || settings.styleNegative || settings.promptRules || settings.loras.length || settings.voice || settings.narratorVoice)
    const cast = media.roster.filter(entry => entry.lora || entry.voice).length
    if (said || cast) found.settings = { count: (said ? 1 : 0) + cast, files: [], settings }

    return { card, found }
  }

  /** What 导出 can offer for this card: [{ key, count, bytes }] in PARTS' order, and the most a pack may weigh. */
  async function survey(cardId) {
    const { found } = await collect(cardId)
    return {
      parts: PARTS.filter(key => found[key]).map(key => ({ key, count: found[key].count, bytes: found[key].files.reduce((sum, file) => sum + file.size, 0) })),
      max: MAX_PACK,
    }
  }

  /**
   * The zip of a card with the parts picked.
   * @param cardFile - (withRules) → { name: 'card.png' | 'card.json', data }: the card as 导出角色卡 writes it,
   *   with its rule book in it or without.
   * → { parts, size (the zip, pieces to write one after another), included: the parts that went }
   */
  async function build(cardId, include, cardFileOf) {
    const { card, found } = await collect(cardId)
    const picked = cleanParts(include).filter(key => found[key])
    const has = key => picked.includes(key)
    const cardFile = await cardFileOf(has('rules'))
    const files = picked.flatMap(key => found[key].files)
    const total = cardFile.data.length + files.reduce((sum, file) => sum + file.size, 0)
    if (total > MAX_PACK) throw httpError(413, msg`选的内容太大了（超过 500MB），去掉几项再导出`)
    // Without 画风和朗读设置, the cast goes without its LoRAs and voices.
    const cast = has('roster') ? found.roster.roster.map(entry => (has('settings') ? entry : { ...entry, lora: '', loraTrigger: '', loraStrength: 0.8, voice: '' })) : null
    const manifest = {
      format: PACK_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      name: card.name,
      card: cardFile.name,
      parts: picked,
      ...(cast ? { roster: cast, refs: found.roster.refs } : {}),
      ...(has('sprites') ? { sprites: found.sprites.sprites, expressions: found.sprites.expressions, ...(Object.keys(found.sprites.outfits).length ? { outfits: found.sprites.outfits } : {}) } : {}),
      ...(has('scenes') ? { scenes: found.scenes.scenes } : {}),
      ...(has('cgs') ? { cgs: found.cgs.groups } : {}),
      ...(has('cover') ? { cover: true } : {}),
      ...(has('look') ? { look: found.look.pictures } : {}),
      ...(has('rules') ? { rules: found.rules.rules } : {}),
      ...(has('foes') ? { foes: found.foes.foes } : {}),
      ...(has('skills') ? { skills: found.skills.skills } : {}),
      ...(has('regex') ? { regexSets: found.regex.sets } : {}),
      ...(has('settings') ? { settings: found.settings.settings } : {}),
    }
    const when = new Date()
    const entries = [
      { name: cardFile.name, data: cardFile.data },
      { name: PACK_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ]
    for (const file of files) {
      // One that went missing since it was counted is left out; the importer skips what is not there.
      const data = await readFile(file.file).catch(() => null)
      if (data) entries.push({ name: file.name, data })
    }
    for (const entry of entries) {
      entry.when = when
      entry.crc = crcOf(entry.data)
      // The checksum of a big picture takes a while where zlib has none (the phone): other requests go on.
      await new Promise(resolve => setImmediate(resolve))
    }
    return { ...zipParts(entries), included: picked }
  }

  /**
   * A zip someone picked to import → { manifest, card: { filename, buffer }, file(name, max) → Buffer | null }.
   * Throws when it is no pack of this app's.
   */
  async function read(buffer) {
    let entries
    try {
      entries = zipEntries(buffer)
    } catch {
      throw httpError(400, msg`这个 zip 读不出来`)
    }
    if (entries.length > MAX_ENTRIES) throw httpError(400, msg`这个 zip 里的文件太多`)
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    const file = async (name, max) => {
      const entry = byName.get(name)
      if (!entry || entry.encrypted || entry.size > max || entry.compressed > max) return null
      try {
        const data = Buffer.from(await zipData(buffer, entry, bytes => inflateRaw(bytes, { maxOutputLength: max })))
        return data.length <= max ? data : null
      } catch {
        return null
      }
    }
    const text = await file(PACK_MANIFEST, MAX_MANIFEST)
    let manifest = null
    try {
      manifest = text ? JSON.parse(text.toString('utf8')) : null
    } catch {
      manifest = null
    }
    if (manifest?.format !== PACK_FORMAT) throw httpError(400, msg`这个 zip 不是 CicaTavern 导出的角色卡`)
    const filename = manifest.card === 'card.json' ? 'card.json' : 'card.png'
    const card = await file(filename, MAX_CARD_FILE)
    if (!card) throw httpError(400, msg`这个 zip 里没有角色卡`)
    return { manifest, card: { filename, buffer: card }, file }
  }

  /**
   * What a pack brought, put on a card just imported from its card file. What the card already has under the same
   * id or name (a version updated in place) gives way to the pack's; the rest of what it has stays.
   * → what arrived: { roster, sprites, scenes, cover, look, rules, foes, skills, regexSets, settings }
   */
  async function restore(cardId, pack) {
    const { manifest, file } = pack
    const parts = new Set(cleanParts(manifest.parts))
    const arrived = { roster: 0, sprites: 0, scenes: 0, cgs: 0, cover: false, look: 0, rules: false, foes: 0, skills: 0, regexSets: 0, settings: false }
    const image = async (name, max, kinds = ['png', 'jpg', 'webp']) => {
      const data = await file(name, max)
      return data && kinds.includes(imageKind(data)) ? data : null
    }
    const put = async (folder, name, data) => {
      await mkdir(at(cardId, folder), { recursive: true })
      await writeFile(at(cardId, folder, name), data)
    }

    let card = await store.getCard(cardId)
    const before = cleanCardMedia(card.media)
    const settings = parts.has('settings') ? Object.fromEntries(SETTINGS.filter(key => record(manifest.settings)[key] !== undefined).map(key => [key, manifest.settings[key]])) : {}
    let roster = before.roster
    if (parts.has('roster') && Array.isArray(manifest.roster)) {
      // Without the settings part, a pack's cast says nothing of LoRAs and voices, whatever its file holds.
      const packed = cleanCardMedia({ roster: manifest.roster }).roster.map(entry => (parts.has('settings') ? entry : { ...entry, ...Object.fromEntries(ENTRY_SETTINGS.map(key => [key, before.roster.find(old => old.id === entry.id)?.[key] ?? (key === 'loraStrength' ? 0.8 : '')])) }))
      const taken = new Set(packed.flatMap(entry => [entry.id, entry.name]))
      roster = [...packed, ...before.roster.filter(entry => !taken.has(entry.id) && !taken.has(entry.name))]
      arrived.roster = packed.length
    }
    if (arrived.roster || Object.keys(settings).length) {
      card.media = cleanCardMedia({ ...settings, roster }, before)
      arrived.settings = Object.keys(settings).length > 0
      await store.saveCard(card)
    }
    const ids = new Set(cleanCardMedia(card.media).roster.map(entry => entry.id))

    if (arrived.roster) {
      for (const id of Array.isArray(manifest.refs) ? manifest.refs : []) {
        if (!isRosterId(id) || !ids.has(id)) continue
        const data = await image(`roster/${id}.png`, MAX_REF)
        if (data) await put('roster', `${id}.png`, data)
      }
    }

    if (parts.has('sprites')) {
      const kept = record(await readJsonFile(at(cardId, 'sprites.json'), null))
      const sprites = { ...record(kept.sprites) }
      const expressions = { ...record(kept.expressions) }
      const outfits = { ...record(kept.outfits) }
      const take = async value => {
        if (!FILE.test(value?.file ?? '')) return null
        const data = await image(`sprites/${value.file}`, MAX_PICTURE)
        if (!data) return null
        await put('sprites', value.file, data)
        arrived.sprites++
        return { file: value.file, updatedAt: clip(value.updatedAt, 40), backend: clip(value.backend, 40), source: clip(value.source, 20), ...(value.looks ? { looks: clip(value.looks, 2000) } : {}), ...(value.outfit ? { outfit: clip(value.outfit, 2000) } : {}) }
      }
      for (const [id, sprite] of Object.entries(record(manifest.sprites))) {
        if (!ids.has(id)) continue
        const saved = await take(sprite)
        if (saved) sprites[id] = saved
      }
      for (const [id, faces] of Object.entries(record(manifest.expressions))) {
        if (!ids.has(id)) continue
        const own = { ...record(expressions[id]) }
        for (const [name, face] of Object.entries(record(faces))) {
          if (!EXPRESSIONS.includes(name) || name === 'neutral') continue
          const saved = await take(face)
          if (saved) own[name] = saved
        }
        if (Object.keys(own).length) expressions[id] = own
      }
      for (const entry of cleanCardMedia(card.media).roster) {
        const own = { ...record(outfits[entry.id]) }
        for (const item of entry.wardrobe ?? []) {
          const saved = await take(record(record(manifest.outfits)[entry.id])[item.id])
          if (saved) own[item.id] = saved
        }
        if (Object.keys(own).length) outfits[entry.id] = own
      }
      if (arrived.sprites) await writeJson(at(cardId, 'sprites.json'), { sprites, expressions, ...(Object.keys(outfits).length ? { outfits } : {}) })
    }

    if (parts.has('scenes') && Array.isArray(manifest.scenes)) {
      const kept = (await readJsonFile(at(cardId, 'scenes.json'), null))?.scenes
      const scenes = Array.isArray(kept) ? [...kept] : []
      for (const scene of manifest.scenes) {
        if (!ENTRY.test(scene?.id ?? '') || !clip(scene.name, 80)) continue
        const data = FILE.test(scene.file ?? '') ? await image(`scenes/${scene.file}`, MAX_PICTURE) : null
        if (!data) continue
        const index = scenes.findIndex(old => old.id === scene.id)
        if (index < 0 && scenes.length >= MAX_SCENES) break
        await put('scenes', scene.file, data)
        const saved = { id: scene.id, name: clip(scene.name, 80), aliases: (Array.isArray(scene.aliases) ? scene.aliases : []).map(alias => clip(alias, 80)).filter(Boolean).slice(0, 12), file: scene.file, prompt: clip(scene.prompt, 4000), backend: clip(scene.backend, 40), source: clip(scene.source, 20), at: clip(scene.at, 40), updatedAt: clip(scene.updatedAt, 40) }
        if (index < 0) scenes.push(saved)
        else scenes[index] = saved
        arrived.scenes++
      }
      if (arrived.scenes) await writeJson(at(cardId, 'scenes.json'), { scenes })
    }

    // 卡的 CG: a group of a name the card has takes its place (card-cgs.mjs bring), one group at a time.
    if (parts.has('cgs') && cgs && Array.isArray(manifest.cgs)) {
      for (const group of manifest.cgs) {
        const pictures = []
        for (const file of Array.isArray(group?.pictures) ? group.pictures : []) {
          const data = FILE.test(file ?? '') ? await image(`cgs/${file}`, MAX_PICTURE) : null
          if (data) pictures.push(data)
        }
        arrived.cgs += (await cgs.bring(cardId, [{ name: clip(group?.name, 40), aliases: Array.isArray(group?.aliases) ? group.aliases : [], note: clip(group?.note, 80), pictures }])).pictures
      }
    }

    if (parts.has('cover')) {
      const data = await image('cover.jpg', MAX_REF, ['jpg'])
      if (data) {
        await writeFile(store.coverArtPath(cardId), data)
        card = await store.getCard(cardId)
        card.coverArt = Date.now()
        await store.saveCard(card)
        arrived.cover = true
      }
    }

    if (parts.has('look') && look) {
      const entries = []
      for (const [token, item] of Object.entries(record(manifest.look))) {
        if (!FILE.test(item?.file ?? '')) continue
        const data = await image(`look/${item.file}`, MAX_PICTURE)
        if (data) entries.push({ token, data, item })
      }
      arrived.look = await look.unpack(cardId, entries)
    }

    if (parts.has('rules') && manifest.rules && typeof manifest.rules === 'object' && !Array.isArray(manifest.rules)) {
      // Over the rules the card has (a new card got them from its file already; one updated in place kept its own).
      // A foe the card has a picture of keeps it.
      await rulebooks.change(cardId, current => {
        const { foes: packed, ...rest } = manifest.rules
        const foes = Object.fromEntries(Object.entries(record(packed)).map(([name, foe]) => [name, { ...record(foe), ...(current.foes[name]?.file ? { file: current.foes[name].file } : {}) }]))
        return { ...rest, foes: { ...current.foes, ...foes } }
      })
      arrived.rules = true
    }

    if (parts.has('foes')) {
      // Only the foes the card's rule book knows: the book came with the card file.
      const known = record((await rulebooks.read(cardId).catch(() => null))?.foes)
      for (const [name, picture] of Object.entries(record(manifest.foes))) {
        if (!Object.hasOwn(known, name) || !FILE.test(picture ?? '')) continue
        const data = await image(`foes/${picture}`, MAX_PICTURE)
        if (!data) continue
        await rulebooks.setFoePicture(cardId, name, data)
        arrived.foes++
      }
    }

    if (parts.has('skills')) {
      for (const [name, picture] of Object.entries(record(manifest.skills)).slice(0, MAX_SKILL_PICTURES)) {
        if (!clip(name, 40) || !FILE.test(picture ?? '')) continue
        const data = await image(`skills/${picture}`, MAX_PICTURE)
        if (!data) continue
        await rulebooks.setSkillPicture(cardId, name, data)
        arrived.skills++
      }
    }

    if (parts.has('regex') && Array.isArray(manifest.regexSets)) {
      for (const packed of manifest.regexSets.slice(0, MAX_SETS)) {
        const scripts = cleanScripts(packed?.scripts)
        if (!scripts.length) continue
        // The same set already here (imported with another card of the same author) is attached, not doubled.
        const same = (await store.getRegexSets()).find(set => set.name === clip(packed.name, 200) && scriptsKey(set.scripts) === scriptsKey(scripts))
        const set = same ?? (await regex.createSet({ name: clip(packed.name, 200), description: clip(packed.description, 2000), scripts }))
        if (!set.cardIds.includes(cardId)) await regex.setCards(set.id, [...set.cardIds, cardId])
        arrived.regexSets++
      }
    }
    return arrived
  }

  return { survey, build, read, restore }
}
