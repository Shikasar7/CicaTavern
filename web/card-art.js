// The pictures a card's status bar and 开场页 show (web/status.js artBlock, web/cover.js). They are the app's own, the
// ones 配图与朗读 and 视觉小说 already keep for the card: each character's 立绘 and 表情 (or 人设图), the 场景 by
// place, the card's picture, and the one picked for the cover in 修改角色卡. Nothing is drawn here; a card with none
// of them shows none. The rest of what a bar draws from is here too: a face for each person it names, the picture of the
// card's map (the 场景 called 地图), and from the card's 游戏规则 what beats what and each companion's 形态.
import { t } from '/i18n.js'
import { sameName } from '/shared/status.js'
import { formIndex } from '/status.js'
import { faceOf } from '/shared/stage.js'
import { latestPlace, matchScene } from '/shared/vn.js'
import { moodPath } from '/shared/cover.js'
import { getPath, unwrap } from '/shared/vars.js'

// A word for the player in a card's variables, and what the 场景 that is the card's map is called.
const PLAYER_WORD = /^(?:你|玩家|主角|我|you|player|protagonist|<user>|\{\{user\}\})$/i
const MAP_NAME = /^(?:地图|世界地图|全图|大地图|map|world ?map)$/i

const namesOf = entry => [entry.name, ...String(entry.aliases ?? '').split(/[,，、/|]/)].map(name => name.trim().toLowerCase()).filter(Boolean)

/** @param deps - { api, onLoaded(cardId): what is known of a card's pictures has changed } */
export function initCardArt({ api, onLoaded }) {
  // cardId → { data: { roster, sprites, expressions, scenes } or null, asking, stale }
  const kept = new Map()

  async function load(cardId) {
    const [media, drawn, places, look] = await Promise.all([
      api(`/api/cards/${cardId}/media`).catch(() => null),
      api(`/api/cards/${cardId}/sprites`).catch(() => null),
      api(`/api/cards/${cardId}/scenes`).catch(() => null),
      api(`/api/cards/${cardId}/look-pictures`).catch(() => null),
    ])
    // 定制外观的图: { '--pic-…': address }, what web/status.js wear() fills the look's variables with.
    const lookPictures = Object.fromEntries((look?.pictures ?? []).map(item => [item.token, item.url]))
    return { roster: media?.roster ?? [], sprites: drawn?.sprites ?? {}, expressions: drawn?.expressions ?? {}, scenes: places?.scenes ?? [], lookPictures }
  }

  /**
   * What is known of a card's pictures; null the first time, while it is asked. What was known stays in use while
   * it is asked again, and onLoaded is called only when the answer is another.
   */
  function of(cardId) {
    let slot = kept.get(cardId)
    if (!slot) kept.set(cardId, (slot = { data: null, asking: false, stale: true }))
    if (slot.stale && !slot.asking) {
      slot.stale = false
      slot.asking = true
      load(cardId).then(data => {
        slot.asking = false
        const changed = JSON.stringify(data) !== JSON.stringify(slot.data)
        slot.data = data
        if (changed) onLoaded(cardId)
      })
    }
    return slot.data
  }

  /** Pictures may have been drawn, changed or taken away (a window where that is done was closed): asked again when next wanted. */
  function forget() {
    for (const slot of kept.values()) slot.stale = true
  }

  /** One character's picture, the face asked for first: { src, zoom (a whole figure) } or null. */
  function pictureOf(card, data, entry, face) {
    if (entry) {
      const file = (face && face !== 'neutral' && data.expressions[entry.id]?.[face]?.file) || data.sprites[entry.id]?.file
      if (file) return { src: `/api/sprites/${card.id}/${file}`, zoom: true }
      if (entry.ref) return { src: `/api/cards/${card.id}/roster/${entry.id}/ref`, zoom: false }
    }
    return card.hasAvatar ? { src: `/api/cards/${card.id}/avatar`, zoom: false } : null
  }

  /** Who a bar is about: the first of its groups that is someone in 角色名册 (not the player), else the first one there. */
  function leadOf(data, spec) {
    const cast = data.roster.filter(entry => !entry.player)
    const owners = [...new Set((spec?.fields ?? []).map(field => String(field.path).split('.')[0].toLowerCase()))]
    for (const owner of owners) {
      const found = cast.find(entry => namesOf(entry).includes(owner))
      if (found) return found
    }
    return cast[0] ?? null
  }

  /** The scene picture of where a chat is at `node` (the newest reply up to it that says where): { src, place } or null. */
  function sceneAt(card, data, chat, node) {
    if (!chat?.path) return null
    const index = node ? chat.path.findIndex(one => one.id === node.id) : chat.path.length - 1
    const where = latestPlace(chat.path.slice(0, index + 1))
    const scene = where ? matchScene(where.place, data.scenes) : null
    return scene?.file ? { src: `/api/scenes/${card.id}/${scene.file}`, place: where.place } : null
  }

  /** Whose chain of 形态 a name means: the companion's own name, one of its other names, or the name of one of its forms. */
  function chainOf(book, name) {
    const forms = book?.forms ?? {}
    const owner = Object.keys(forms).find(key => key === name || (book.companions?.[key]?.keys ?? []).includes(name) || forms[key].some(form => form.name === name))
      ?? Object.keys(forms).find(key => !key.startsWith('@') && sameName(key, name))
    return owner ? { owner, chain: forms[owner] } : null
  }

  /** What a form asks for, in a few words. */
  const needOf = form => [form.at?.level ? t`${form.at.level} 级` : '', form.at?.item ? t`有「${form.at.item}」` : '', form.at?.bond ? t`羁绊 ${form.at.bond} 档` : ''].filter(Boolean).join(t` · `)

  /**
   * What a bar draws from besides the pictures on top of it (web/status.js): a face for a name, the map, the types
   * and the chains of 形态. `book`: the card's 游戏规则, when they are on.
   */
  function extras(card, data, chat, book) {
    const userName = String(chat?.userName ?? '').trim().toLowerCase()
    const entryOf = name => {
      const wanted = String(name).trim().toLowerCase()
      if (!wanted) return null
      return data.roster.find(entry => namesOf(entry).includes(wanted))
        ?? (PLAYER_WORD.test(wanted) || wanted === userName ? data.roster.find(entry => entry.player) : null)
        ?? data.roster.find(entry => namesOf(entry).some(known => known.length > 1 && wanted.length > 1 && (wanted.includes(known) || known.includes(wanted))))
        ?? null
    }
    const pictured = entry => {
      if (!entry) return null
      const file = data.sprites[entry.id]?.file
      if (file) return { src: `/api/sprites/${card.id}/${file}`, zoom: true }
      return entry.ref ? { src: `/api/cards/${card.id}/roster/${entry.id}/ref`, zoom: false } : null
    }
    // A creature (or a 形态) with no one in the roster for it: its picture in the 敌人图鉴, where it has one. A card with
    // many creatures keeps them there, the roster having room for a cast, not for every form of every pet.
    const bestiary = name => {
      const file = name && book?.foes?.[name]?.file
      return file ? { src: `/api/foes/${card.id}/${file}`, zoom: false } : null
    }
    // One who changes 形态 shows as the form its row says it is in, where that form has a picture of its own.
    const face = (name, words = []) => {
      const grown = chainOf(book, name)
      const form = grown ? grown.chain[formIndex(grown.chain, [name, ...words])] : null
      return (form && (pictured(data.roster.find(entry => namesOf(entry).includes(form.name.toLowerCase()))) || bestiary(form.name)))
        || pictured(entryOf(name)) || bestiary(name)
        || (grown ? pictured(entryOf(grown.owner)) || bestiary(grown.owner) : null)
    }
    const map = data.scenes.find(scene => scene.file && MAP_NAME.test(String(scene.name ?? '').trim()))
    const beats = book?.types && Object.keys(book.types).length > 1 ? book.types : null
    const typeOf = name => {
      const grown = chainOf(book, name)
      const owner = grown?.owner ?? Object.keys(book.companions ?? {}).find(key => key === name || (book.companions[key].keys ?? []).includes(name)) ?? ''
      return grown?.chain.find(form => form.name === name)?.type ?? book.companions?.[owner]?.type ?? book.foes?.[name]?.type ?? (PLAYER_WORD.test(name) ? book.selfType : '') ?? ''
    }
    return {
      face,
      ...(Object.keys(data.lookPictures ?? {}).length ? { lookPictures: data.lookPictures } : {}),
      ...(map ? { map: `/api/scenes/${card.id}/${map.file}` } : {}),
      ...(beats ? { types: { beats, of: typeOf } } : {}),
      ...(Object.keys(book?.forms ?? {}).length ? { chain: name => chainOf(book, name)?.chain.map(form => ({ name: form.name, stage: form.stage ?? '', need: needOf(form) })) ?? null } : {}),
    }
  }

  /**
   * What a bar under `node` draws from: the pictures on top of it as its layout asks (立绘, 场景图), and the faces, map,
   * types and 形态 of `extras`. Null while the card's pictures are being asked for.
   */
  function barArt(card, spec, chat, node, book = null) {
    if (!card?.id || !spec) return null
    const data = of(card.id)
    if (!data) return null
    const more = extras(card, data, chat, book)
    if (!spec.portrait && !spec.scene) return more
    const lead = spec.portrait ? leadOf(data, spec) : null
    const mood = lead ? unwrap(getPath(node?.state ?? {}, moodPath(spec, lead.name))) : ''
    const portrait = spec.portrait ? pictureOf(card, data, lead, typeof mood === 'string' ? faceOf(mood) : null) : null
    const scene = spec.scene ? sceneAt(card, data, chat, node) : null
    if (!portrait && !scene) return more
    return { ...more, portrait: portrait?.src ?? '', zoom: portrait?.zoom === true, scene: scene?.src ?? '', name: portrait ? lead?.name ?? card.name ?? '' : '', place: scene?.place ?? '' }
  }

  /**
   * The pictures of a 开场页: the one picked for it, else where the opening is (else the card's picture, behind a blur),
   * and who the card is about (unless the cover says no one stands there).
   */
  function coverArt(card, chat) {
    const own = card?.coverArt ? { src: `/api/cards/${card.id}/cover-art?v=${card.coverArt}` } : null
    const data = card?.id ? of(card.id) : null
    if (!data) return own ? { backdrop: own.src, soft: false, portrait: '', zoom: false } : card?.hasAvatar ? { backdrop: `/api/cards/${card.id}/avatar`, soft: true, portrait: '', zoom: false } : null
    const scene = own ?? sceneAt(card, data, chat, null) ?? (data.scenes.find(one => one.file) ? { src: `/api/scenes/${card.id}/${data.scenes.find(one => one.file).file}` } : null)
    const lead = data.roster.find(entry => !entry.player) ?? null
    const portrait = card.cover?.figure === false ? null : pictureOf(card, data, lead, null)
    const avatar = card.hasAvatar ? `/api/cards/${card.id}/avatar` : ''
    const look = Object.keys(data.lookPictures ?? {}).length ? { lookPictures: data.lookPictures } : {}
    if (!scene && !portrait) return look.lookPictures ? { backdrop: '', soft: false, portrait: '', zoom: false, ...look } : null
    // With no scene the card's picture is the backdrop, softened, and stands in front of it too.
    return { backdrop: scene?.src ?? avatar, soft: !scene, portrait: portrait?.src ?? '', zoom: portrait?.zoom === true, ...look }
  }

  /** A face for a name on this card (as a bar's: extras), for what is drawn outside a bar (游戏菜单); null while the pictures are asked for. */
  function faces(card, chat, book = null) {
    const data = card?.id ? of(card.id) : null
    return data ? extras(card, data, chat, book).face : null
  }

  return { barArt, coverArt, faces, forget }
}
