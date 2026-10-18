// A card's cast for pictures: who can appear, their fixed looks and an
// optional reference picture each (one entry may be the player character).
// The helper model only says who is in the frame and what they do, as
//   场景: <setting, camera, light>
//   [顾念念] <outfit now, pose, action, expression> | left
// and the looks are filled in from here, so a face stays the same picture
// after picture and several people in one frame do not swap features.
import { randomBytes } from 'node:crypto'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

export const ROSTER_MAX = 24
const KINDS = ['girl', 'boy', 'other']
const ID = /^[a-z0-9]{6,16}$/
// At most this many [Name] lines are used; more people go unnamed into the scene.
const FRAME_MAX = 6

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A LoRA file name from ComfyUI's loras folder, or ''. */
export function cleanLora(value) {
  const lora = text(value, 200)
  if (lora && (!/\.(safetensors|pt|ckpt)$/i.test(lora) || /(^|[\\/])\.\.([\\/]|$)/.test(lora))) throw httpError(400, msg`LoRA 要填 ComfyUI loras 文件夹里的文件名（.safetensors）`)
  return lora
}

export function cleanStrength(value, fallback = 0.8) {
  const strength = Number(value)
  return Number.isFinite(strength) ? Math.min(2, Math.max(0, Math.round(strength * 100) / 100)) : fallback
}

/** Entries from the form or a draft. Whether one has a reference picture is the file's business, not stored here. */
export function cleanRoster(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const ids = new Set()
  let player = false
  for (const raw of input) {
    if (out.length >= ROSTER_MAX) break
    if (!raw || typeof raw !== 'object') continue
    const isPlayer = raw.player === true && !player
    const name = text(raw.name, 40)
    if (!name && !isPlayer) continue
    let id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : ''
    if (!id || ids.has(id)) id = randomBytes(5).toString('hex')
    ids.add(id)
    player ||= isPlayer
    out.push({
      id,
      name: name || '主角',
      aliases: text(raw.aliases, 120),
      kind: KINDS.includes(raw.kind) ? raw.kind : 'girl',
      player: isPlayer,
      looks: text(raw.looks, 600),
      outfit: text(raw.outfit, 400),
      lora: cleanLora(raw.lora),
      loraTrigger: text(raw.loraTrigger, 80),
      loraStrength: cleanStrength(raw.loraStrength),
    })
  }
  return out
}

export function isRosterId(id) {
  return typeof id === 'string' && ID.test(id)
}

/** Every name an entry answers to; the player entry also to the chat's player name. */
function namesOf(entry, userName) {
  const names = [entry.name, ...entry.aliases.split(/[,，、/|]+/)]
  if (entry.player && userName) names.push(userName)
  return names.map(n => n.trim().toLowerCase()).filter(Boolean)
}

export function findEntry(roster, name, userName) {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (!wanted) return null
  return roster.find(entry => namesOf(entry, userName).includes(wanted)) ?? null
}

/** How the helper refers to an entry: the player by the chat's player name. */
export function nameFor(entry, userName) {
  return entry.player && userName ? userName : entry.name
}

const CHARACTER_LINE = /^\s*[[【]([^\]】]{1,40})[\]】]\s*(.*)$/
const SCENE_LABEL = /^\s*(?:场景|画面|scene|setting)\s*[:：]\s*/i

/** Does the text use the cast format (a [Name] line)? */
export function isFramePrompt(textValue) {
  return String(textValue ?? '').split(/\r?\n/).some(line => CHARACTER_LINE.test(line))
}

function positionOf(value) {
  const v = String(value ?? '').trim().toLowerCase()
  if (/^(left|左)/.test(v)) return 'left'
  if (/^(right|右)/.test(v)) return 'right'
  if (/^(center|centre|middle|中)/.test(v)) return 'center'
  return ''
}

/**
 * The cast-format prompt → { scene, characters: [{ entry, action, position }] }.
 * A [Name] that is not on the roster stays in the scene, without the name.
 */
export function parseFrame(textValue, roster, userName) {
  const scene = []
  const characters = []
  for (const raw of String(textValue ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = CHARACTER_LINE.exec(line)
    if (match) {
      const entry = findEntry(roster, match[1], userName)
      const [action = '', position = ''] = match[2].split(/\s*[|｜]\s*/)
      if (entry && !characters.some(c => c.entry.id === entry.id) && characters.length < FRAME_MAX) {
        characters.push({ entry, action: action.trim(), position: positionOf(position) })
      } else if (action.trim()) {
        scene.push(action.trim())
      }
      continue
    }
    scene.push(line.replace(SCENE_LABEL, ''))
  }
  return { scene: scene.join(', ').replace(/\s*,\s*,+/g, ',').trim(), characters }
}

/**
 * Whose reference picture goes with a frame: the one person in it, or else the one
 * person besides the player (the player is mostly half in frame, or a thing).
 */
export function leadOf(characters) {
  if (characters.length === 1) return characters[0].entry
  const others = characters.filter(c => !c.entry.player)
  return others.length === 1 ? others[0].entry : null
}

/** "2girls, 1boy" for the people in a frame (NovelAI and booru-trained models count heads first). */
export function countTags(characters) {
  const count = { girl: 0, boy: 0, other: 0 }
  for (const c of characters) count[c.entry.kind] += 1
  return [
    count.girl ? (count.girl === 1 ? '1girl' : `${count.girl}girls`) : '',
    count.boy ? (count.boy === 1 ? '1boy' : `${count.boy}boys`) : '',
    count.other ? `${count.other}other` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

const join = parts => parts.map(p => String(p ?? '').trim().replace(/^[,，\s]+|[,，\s]+$/g, '')).filter(Boolean).join(', ')

/** One prompt for backends without per-character prompts (ComfyUI, image APIs). */
export function flattenFrame(frame, promptStyle = 'tags') {
  const { scene, characters } = frame
  if (promptStyle === 'tags') return join([countTags(characters), scene, ...characters.map(c => join([c.entry.looks, c.action]))])
  const who = { girl: 'A girl', boy: 'A young man', other: 'A figure' }
  const people = characters.map(c => {
    const where = c.position ? ` (${c.position === 'center' ? 'in the middle' : `on the ${c.position}`})` : ''
    return `${who[c.entry.kind]}${where}${c.entry.looks ? ` with ${c.entry.looks}` : ''}: ${c.action || 'in the scene'}.`
  })
  return [scene ? `${scene.replace(/[.。]?$/, '.')}` : '', ...people].filter(Boolean).join(' ')
}

const CENTER_X = { left: 0.3, center: 0.5, right: 0.7 }

/** NovelAI per-character prompts with their positions. */
export function naiCharacters(frame) {
  return frame.characters.map(c => ({
    prompt: join([c.entry.kind, c.entry.looks, c.action]),
    x: CENTER_X[c.position] ?? 0.5,
    y: 0.5,
    positioned: Boolean(c.position),
  }))
}

// ─── What the helper is told ────────────────────────────────────────────

/** The cast as the helper sees it: names to use and what each usually wears. */
export function rosterBrief(roster, userName) {
  return roster
    .map(entry => {
      const name = nameFor(entry, userName)
      const who = entry.player ? `the player character, ${entry.kind}` : entry.kind
      return `- [${name}] ${who}${entry.outfit ? `; usual outfit: ${entry.outfit}` : ''}`
    })
    .join('\n')
}

/** Format rules for a cast-format prompt (English for the image model, labels as given). */
export function frameFormat(promptStyle) {
  const tags = promptStyle === 'tags'
  return [
    'Format, one item per line:',
    `场景: ${tags ? '15-30 comma-separated English tags' : 'one English sentence'} for the setting, composition, camera angle, lighting and mood. No people here.`,
    `[Name] ${tags ? '10-25 comma-separated English tags' : 'one English sentence'}: what they are wearing right now (the usual outfit unless the story changed it), pose, action, expression | left, center or right`,
    'One [Name] line for each cast member visible in the frame, at most 4, names exactly as in the cast list; leave out the rest.',
    'Never describe their hair, eyes, face or body: that is filled in automatically. Refer to other people as him, her or the girl, never by name.',
    'Anyone visible who is not in the cast goes into the 场景 line, briefly.',
  ].join('\n')
}

/** Strip wrapping and keep the cast-format lines; null when the answer is not in that format. */
export function cleanFrame(answer) {
  const lines = String(answer ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```\w*/g, '')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^[-*•]\s*/, ''))
    .filter(line => SCENE_LABEL.test(line) || CHARACTER_LINE.test(line))
  if (!lines.some(line => CHARACTER_LINE.test(line))) return null
  const scene = lines.filter(line => SCENE_LABEL.test(line)).slice(0, 1)
  const people = lines.filter(line => CHARACTER_LINE.test(line)).slice(0, FRAME_MAX)
  const clip = (line, words) => line.split(/\s+/).slice(0, words).join(' ')
  return [...scene.map(line => clip(line, 70)), ...people.map(line => clip(line, 50))].join('\n')
}

// ─── Drafting a roster from the card ────────────────────────────────────

const LOOKS = /外貌|长相|相貌|容貌|样貌|外形|身材|身高|发|眸|眼|瞳|肤|穿|衣|裙|袍|衫|鞋|饰|appearance|hair|eyes/g

/** The card and its lore, character entries first, within a budget. */
export function draftMaterial(card, books = [], budget = 30000) {
  const entries = [...(card.book?.entries ?? []), ...books.flatMap(book => book?.entries ?? [])]
    .filter(e => e && e.enabled !== false && typeof e.content === 'string' && e.content.trim())
    .map(e => ({ title: String(e.comment || (e.keys ?? []).join('/') || '').slice(0, 60), content: e.content, score: (e.content.match(LOOKS) ?? []).length / Math.sqrt(e.content.length + 1) }))
    .sort((a, b) => b.score - a.score)
  const parts = [
    card.description ? `<description>\n${card.description.slice(0, 6000)}\n</description>` : '',
    card.personality ? `<personality>\n${card.personality.slice(0, 2000)}\n</personality>` : '',
    card.scenario ? `<scenario>\n${card.scenario.slice(0, 2000)}\n</scenario>` : '',
  ].filter(Boolean)
  let used = parts.join('\n').length
  for (const entry of entries) {
    const piece = `<entry title="${entry.title.replace(/"/g, "'")}">\n${entry.content.slice(0, 3000)}\n</entry>`
    if (used + piece.length > budget) continue
    parts.push(piece)
    used += piece.length
  }
  return parts.join('\n\n')
}

export function rosterDraftRequest(material) {
  const task = [
    'TASK: list the recurring characters of this story who could appear in pictures, for an anime image generator.',
    'Include the player character ({{user}}, the role the player plays) as one entry with "player": true; name it as the story does, or 主角 if it never says.',
    'Leave out characters with no defined look who only pass by. At most 12 entries.',
    'Reply with a JSON array only, no other text:',
    '[{"name": "Chinese name as in the story", "aliases": "other names, comma-separated", "kind": "girl" | "boy" | "other", "player": false,',
    '  "looks": "8-20 English booru tags for what never changes: apparent age, hair colour and style, eye colour, build, skin, distinctive marks",',
    '  "outfit": "5-15 English booru tags for what they usually wear"}]',
  ].join('\n')
  return {
    system: 'You extract character appearance sheets for an image generator. You reply with JSON only.',
    messages: [{ role: 'user', content: `${material}\n\n${task}` }],
    maxTokens: 4000,
  }
}

/** The helper's JSON (possibly fenced or with chatter around it) → roster entries. */
export function parseRosterDraft(answer) {
  const value = String(answer ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')
  const start = value.indexOf('[')
  const end = value.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const list = JSON.parse(value.slice(start, end + 1))
    return cleanRoster(Array.isArray(list) ? list.map(item => ({ ...item, id: undefined, lora: '' })) : [])
  } catch {
    return []
  }
}
