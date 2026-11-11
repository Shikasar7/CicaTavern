// 角色采访 (检查这张卡 → 角色采访): a model puts the card's character into a few kinds of moment and writes each as
// a short example exchange, for the card's 对话示例. A card that says who someone is still leaves a model guessing how
// they talk; a few lines of them talking settle it. What comes of it is a suggestion in 检查这张卡's list (the
// field as it would read after), looked at, changed and taken in or back like any other.
import { msg } from '../i18n.mjs'
import { cardBrief } from './brick-add.mjs'
import { englishCard } from './check.mjs'

/** The moments an example can show, in the order they are offered; the first four are picked to start with. */
export const SCENES = ['daily', 'tease', 'refuse', 'soft', 'upset', 'secret', 'craft', 'quiet']
export const DEFAULT_SCENES = SCENES.slice(0, 4)
// What the model is told of each: where the character is put, not what to say there.
const SCENE_WORDS = {
  daily: '平常搭话：没什么事，<user> 随口说了一句',
  tease: '被打趣：<user> 拿这个角色开了个玩笑',
  refuse: '不肯做：<user> 提了一个这个角色不愿意答应的要求',
  soft: '难得示弱或关心人：这个角色放下了平时的样子',
  upset: '被惹恼：<user> 说了或做了让这个角色不高兴的事',
  secret: '被问到不想说的事：<user> 问到了这个角色不愿多谈的地方',
  craft: '做拿手的事：这个角色在做本行或最擅长的事，<user> 在旁边',
  quiet: '话很少的时候：这个角色几乎不开口，靠动作和神情',
}
// The answer with its thinking; and what it comes to, for the estimate.
export const INTERVIEW_TOKENS = 12000
export const INTERVIEW_OUTPUT = 2500
const MAX_WISH = 400
const MAX_EXAMPLE = 1200
const MAX_KEPT = 3000

const clip = (text, max) => {
  const words = String(text ?? '').trim()
  return words.length > max ? `${words.slice(0, max)}…` : words
}

/** The moments asked for, as the server keeps them: known ones, in the offered order, the first four when none is. */
export function cleanScenes(scenes) {
  const picked = SCENES.filter(scene => (Array.isArray(scenes) ? scenes : []).includes(scene))
  return picked.length ? picked : DEFAULT_SCENES
}

export const cleanInterviewWish = wish => clip(typeof wish === 'string' ? wish.replace(/\s+/g, ' ') : '', MAX_WISH)

const interviewSystem = english => `你替一张已经写好的角色卡写「对话示例」。读 <card>，把这张卡的角色放进用户给的几个场合，先在心里问他：这时候他会怎么说、怎么做；再把每个场合写成一小段示例对话。模型扮演这个角色时会照这些示例学他的声口。

要求：
- 每个场合一段，2 到 4 个来回。重点在角色这边：句子长短、口头的习惯、会不会绕弯、动作和神情。写出这个角色才会这么说的话，不写谁都能说的客套。
- <user> 那边的话写短、写平，只负责把场合带出来：不替 <user> 定性格，不写 <user> 的心理。
- 叙述、动作和对白的写法照开场白：开场白用第几人称、对白用什么引号、动作怎么写，示例里就怎么写。
- 只用卡里已有的人、地方和规矩，不新造设定，不写剧情里的秘密和结局，不和卡里写的相矛盾。
- 几段之间不要重复同一句话、同一个动作。
- <user> 的话以「{{user}}:」开头，角色的话以「{{char}}:」开头，各占一行起头。这张卡要是不止一个角色（群像、世界卡），角色的话就以说话人的名字加冒号开头。
- 用${english ? '英文' : '中文'}写，和这张卡一样。

只输出 <examples>，每段一个 <example>，scene 照用户给的写：
<examples>
<example scene="daily">
{{user}}: ……
{{char}}: ……
</example>
</examples>`

/** The request for a card's examples. `scenes`: which moments; `wish`: what the user wants of them. */
export function interviewRequest(card, { scenes, wish = '', state = {} } = {}) {
  const asked = cleanScenes(scenes)
  const kept = String(card.mesExample ?? '').trim()
  const content = [
    cardBrief(card, state, { opening: 2500, variables: false }),
    kept ? `<kept_examples>\n${clip(kept, MAX_KEPT)}\n</kept_examples>\n这张卡已经有上面这些示例：新写的不要和它们重复，声口要和它们一致。` : '',
    `要写的场合：\n${asked.map(scene => `- ${scene}：${SCENE_WORDS[scene]}`).join('\n')}`,
    wish ? `用户对示例的想法：${wish}` : '',
  ].filter(Boolean).join('\n\n')
  return { system: interviewSystem(englishCard(card)), messages: [{ role: 'user', content }], maxTokens: INTERVIEW_TOKENS, softCap: true }
}

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One example as a card keeps it: who speaks written the way SillyTavern reads it, no tag left of the answer's. */
function cleanExample(text, card) {
  const name = String(card.name ?? '').trim()
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd())
  // The card's own name before a line is the character speaking, as {{char}} is.
  const named = name ? line => line.replace(new RegExp(`^\\s*${escapeRegex(name)}\\s*[:：]\\s*`), '{{char}}: ') : line => line
  const out = lines.map(line => named(line
    .replace(/^\s*(?:<user>|\{\{user\}\}|用户|User)\s*[:：]\s*/i, '{{user}}: ')
    .replace(/^\s*(?:<char>|\{\{char\}\})\s*[:：]\s*/i, '{{char}}: ')))
  const body = out.join('\n').replace(/<\/?START>/gi, '').replace(/\n{3,}/g, '\n\n').trim()
  return clip(body, MAX_EXAMPLE)
}

/** The examples in an answer: [{ scene, text }], those with someone speaking in them. */
export function readInterview(text, card) {
  const found = [...String(text ?? '').matchAll(/<example\b([^>]*)>([\s\S]*?)(?:<\/example>|(?=<example\b)|$)/gi)]
  const seen = new Set()
  return found
    .map(([, attrs, body]) => ({ scene: /scene\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1] ?? '', text: cleanExample(body.replace(/<\/examples>[\s\S]*$/i, ''), card) }))
    .filter(example => /^[^\n:：]{1,40}[:：]/m.test(example.text) && !seen.has(example.text) && seen.add(example.text))
    .slice(0, SCENES.length)
}

/** The examples as 对话示例 keeps them: a <START> before each, after what the card already has. */
export function withExamples(kept, examples) {
  const added = examples.map(example => `<START>\n${example.text}`).join('\n')
  const before = String(kept ?? '').trim()
  return before ? `${before}\n${added}` : added
}

/** The examples as a suggestion for 检查这张卡: 对话示例 as it would read with them. null when there are none. */
export function interviewFinding(card, examples) {
  if (!examples.length) return null
  const before = String(card.mesExample ?? '')
  const after = withExamples(before, examples)
  const added = after.length - before.trim().length
  return {
    id: 'interview',
    rule: 'interview',
    level: 'tip',
    from: 'model',
    interview: true,
    title: before.trim() ? msg`对话示例再加 ${examples.length} 段` : msg`写 ${examples.length} 段对话示例`,
    why: msg`模型照着示例学这个角色怎么说话，比只读设定更像他。示例和设定一样每轮都发，这几段约 ${added} 字。可以先点「改一下」删掉不像的几段再采用。`,
    changes: [{ id: 'field:mesExample', kind: 'field', key: 'mesExample', before, after }],
  }
}
