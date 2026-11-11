// The pictures a card's status bar and 开场页 show (web/status.js artBlock, web/cover.js). They are the app's own, the
// ones 配图与朗读 and 视觉小说 already keep for the card: each character's 立绘 and 表情 (or 人设图), the 场景 by
// place, the card's picture, and the one picked for the cover in 修改角色卡. Nothing is drawn here; a card with none
// of them shows none.
import { faceOf } from '/shared/stage.js'
import { latestPlace, matchScene } from '/shared/vn.js'
import { moodPath } from '/shared/cover.js'
import { getPath, unwrap } from '/shared/vars.js'

const namesOf = entry => [entry.name, ...String(entry.aliases ?? '').split(/[,，、/|]/)].map(name => name.trim().toLowerCase()).filter(Boolean)

/** @param deps - { api, onLoaded(cardId): what is known of a card's pictures has changed } */
export function initCardArt({ api, onLoaded }) {
  // cardId → { data: { roster, sprites, expressions, scenes } or null, asking, stale }
  const kept = new Map()

  async function load(cardId) {
    const [media, drawn, places] = await Promise.all([
      api(`/api/cards/${cardId}/media`).catch(() => null),
      api(`/api/cards/${cardId}/sprites`).catch(() => null),
      api(`/api/cards/${cardId}/scenes`).catch(() => null),
    ])
    return { roster: media?.roster ?? [], sprites: drawn?.sprites ?? {}, expressions: drawn?.expressions ?? {}, scenes: places?.scenes ?? [] }
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

  /** The pictures on top of a bar under `node`, as the bar's layout asks (立绘, 场景图); null when there are none. */
  function barArt(card, spec, chat, node) {
    if (!card?.id || (!spec?.portrait && !spec?.scene)) return null
    const data = of(card.id)
    if (!data) return null
    const lead = spec.portrait ? leadOf(data, spec) : null
    const mood = lead ? unwrap(getPath(node?.state ?? {}, moodPath(spec, lead.name))) : ''
    const portrait = spec.portrait ? pictureOf(card, data, lead, typeof mood === 'string' ? faceOf(mood) : null) : null
    const scene = spec.scene ? sceneAt(card, data, chat, node) : null
    if (!portrait && !scene) return null
    return { portrait: portrait?.src ?? '', zoom: portrait?.zoom === true, scene: scene?.src ?? '', name: portrait ? lead?.name ?? card.name ?? '' : '', place: scene?.place ?? '' }
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
    if (!scene && !portrait) return null
    // With no scene the card's picture is the backdrop, softened, and stands in front of it too.
    return { backdrop: scene?.src ?? avatar, soft: !scene, portrait: portrait?.src ?? '', zoom: portrait?.zoom === true }
  }

  return { barArt, coverArt, forget }
}
