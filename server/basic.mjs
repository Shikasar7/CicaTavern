// The built-in preset (基础预设), used when no imported preset is chosen. It
// keeps the built-in narrator rules (prompt.mjs buildSystemPrompt) and adds
// one short paragraph per option in the prefix's every-turn section, so a
// chat's prompt stays the same from turn to turn and is cached. Changing an
// option takes effect in new chats, or in a chat after 用于当前对话 rebuilds
// its prefix, as with any preset.
import { BASIC_ID, cleanBasic } from '../web/shared/basic.js'

export { BASIC_ID }

// Earlier replies' choices are dropped from what the model reads again: they
// cost tokens every turn and invite copying. The same for every reply, so the
// history stays byte-identical and cached.
const CHOICES_HIDDEN = {
  id: 'basic-hide-choices',
  scriptName: '旧回复的行动选项不再发给模型',
  findRegex: '/<choices>[\\s\\S]*?<\\/choices>\\s*/gi',
  replaceString: '',
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: false,
  promptOnly: true,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
}

/** The built-in preset as a preset object: no prompts of its own, its options instead. */
export function basicPreset(settings) {
  return {
    id: BASIC_ID,
    builtin: true,
    name: '基础预设',
    options: cleanBasic(settings?.basic),
    prompts: [],
    formats: { wi: '{0}', scenario: '{{scenario}}', personality: '{{personality}}', exampleChat: '[Example Chat]' },
    regexScripts: [CHOICES_HIDDEN],
    helperScripts: 0,
    params: {},
    postMode: 'prefix',
    importedAt: '',
  }
}

/** What the preset window shows: the options and the paragraphs they add (macros as written). */
export function basicDetail(settings) {
  const preset = basicPreset(settings)
  return { id: BASIC_ID, builtin: true, name: preset.name, options: preset.options, rules: basicRules(preset.options), regexScriptList: preset.regexScripts }
}

/** Whether the options ask for blocks around the story (the turn's reminder then names the output format). */
export function hasBasicFormat(options) {
  return options.choices !== 'off' || options.timeBox !== 'off'
}

const PERSON = {
  greeting: '人称与视角沿用开场白，全程保持一致。',
  second: '用第二人称叙述：用「你」称呼玩家角色「{{user}}」，镜头跟着他的所见所闻走；其他角色用名字或「他/她」。',
  third: '用第三人称叙述，玩家角色「{{user}}」也用名字或「他/她」称呼。镜头贴近场上的人物，不随意跳进无关角色的内心。',
  first: '以{{char}}的第一人称「我」叙述，只写{{char}}看到、听到、想到的；称呼玩家角色「{{user}}」用「你」或名字。',
}

const STYLE = {
  natural: '',
  plain: '白描：句子短而准，多写动作、对白和看得见的细节，少用形容词和比喻，不替读者总结情绪。',
  cinematic: '电影感：按镜头组织段落，远景交代环境，近景落在神情和手上的动作；节奏紧凑，场景切换干脆，用画面和声音推进情节。',
  delicate: '细腻：放慢节奏，写感官细节和人物细微的心理变化，让环境和情绪互相映照；对白留白，不把话说尽。',
  light: '轻小说：语言轻快、口语化，对白多，人物反应生动，可以有吐槽和夸张的小动作；情节严肃时收住玩笑。',
  classical: '古风：用词典雅凝练，可化用诗词意象；对白合乎人物身份与时代，不用现代词汇和网络用语。',
  webnovel: '网文：节奏快，冲突鲜明，段落短，每段都推动情节；一段情节收尾时留一个钩子。',
}

const IMPERSONATION = {
  off: '',
  standard: '不替玩家角色「{{user}}」说话、做决定或描写其内心。「{{user}}」做了什么以玩家输入为准，你只写它带来的结果和其他角色的反应；「{{user}}」可以有被动的外在反应（被推了一下、听见声音），但不要替他添新的主动行动。',
  strict: '不替玩家角色「{{user}}」说话、做决定或描写其内心。「{{user}}」做了什么以玩家输入为准，你只写它带来的结果和其他角色的反应。写到需要「{{user}}」回应或抉择的地方（被提问、被邀请、局面等他表态）就停笔，不替他接话，也不要用「你决定……」「轮到你了」之类的话收尾。',
}

const KNOWLEDGE = {
  off: '',
  on: '信息隔离：每个角色只知道自己亲历、亲耳听到或能合理得知的事。玩家角色「{{user}}」没说出口的想法和打算、别处发生的事、只有旁白知道的信息，角色一概不知，只能凭言行去猜，而且可能猜错。要让角色知道一件事，先写出他得知的途径。',
}

const INTIMACY = {
  restrained: '亲密与性内容点到为止：写情感和氛围，具体过程用转场或留白带过。',
  natural: '亲密与性内容随剧情自然发生，不回避也不刻意加戏；写到时可以直接描写，重在情感和互动，角色保持各自的性格和意愿。',
  explicit: '这是面向成年玩家的虚构故事。亲密与性内容不回避、不淡化：用直白具体的词描写身体、动作和感官，放慢节奏细写过程和反应，不跳过、不总结、不做道德评判；角色保持各自的性格，反应各不相同。',
}

function formatRules(options) {
  const order = []
  if (options.timeBox !== 'off') {
    order.push('开头一行时间框：<time_box>时间｜地点｜天气</time_box>，按故事世界的历法写，例如 <time_box>10月19日 周一 傍晚6:20｜旧城茶馆二楼｜小雨</time_box>。时间随情节合理流动，和上一条衔接；没有天气可写时省掉那一段。')
  }
  order.push('故事正文。')
  order.push('角色卡要求的其他内容块（如变量更新），照卡里的格式写。')
  if (options.choices !== 'off') {
    order.push([
      '结尾给出四个「{{user}}」接下来可以做的事：',
      '<choices>',
      'A. ……',
      'B. ……',
      'C. ……',
      'D. ……',
      '</choices>',
      '每项一句话，只写「{{user}}」的行动或台词，不写结果；四项方向各不相同，至少一项出人意料。',
    ].join('\n'))
  }
  return ['回复依次包含：', ...order.map((item, i) => `${i + 1}. ${item}`)].join('\n')
}

/**
 * The options' paragraphs for the prefix's every-turn section, macros not yet
 * expanded ({{user}}, {{char}}).
 */
export function basicRules(options) {
  const style = STYLE[options.style]
  return [
    PERSON[options.person],
    style ? `文风——${style}` : '',
    IMPERSONATION[options.impersonation],
    KNOWLEDGE[options.knowledge],
    INTIMACY[options.intimacy],
    hasBasicFormat(options) ? formatRules(options) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
