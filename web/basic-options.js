// The built-in preset's options as the page shows them (预设窗口 and the quick
// switches beside the input). Values and defaults: shared/basic.js.
import { t } from '/i18n.js'

/** `prompt: false`: only changes what the page shows, nothing the model reads. */
export const BASIC_FIELDS = [
  { key: 'person', label: t`人称`, hint: t`第一人称用角色的口吻「我」来写，适合单人角色卡。`, values: [['greeting', t`跟随开场白`], ['second', t`第二人称`], ['third', t`第三人称`], ['first', t`第一人称`]] },
  { key: 'style', label: t`文风`, hint: t`更细的要求写在 设置 → 文风与字数，会和这里一起生效。`, values: [['natural', t`自然`], ['plain', t`白描`], ['cinematic', t`电影感`], ['delicate', t`细腻`], ['light', t`轻小说`], ['classical', t`古风`], ['webnovel', t`网文`]] },
  { key: 'impersonation', label: t`防抢话`, hint: t`标准：不替你说话、做决定；严格：写到该你回应的地方就停。`, values: [['off', t`关`], ['standard', t`标准`], ['strict', t`严格`]] },
  { key: 'knowledge', label: t`防全知`, hint: t`角色只知道自己能知道的事，猜不到你没说出口的想法。`, values: [['off', t`关`], ['on', t`开`]] },
  { key: 'themes', label: t`题材尺度`, hint: t`放开：暴力、犯罪、背叛这类黑暗题材按剧情正面去写，反派可以真的坏，不跳出故事说教。模型自己的底线仍然有效。`, values: [['standard', t`常规`], ['open', t`放开`]] },
  { key: 'jailbreak', label: t`破限`, hint: t`软：不拒绝、不回避敏感题材，照剧情直接写；强：先声明创作权限，结尾再确认一次，仍然按上面的格式输出。模型自己的底线仍然有效。`, values: [['off', t`关`], ['soft', t`软破限`], ['strong', t`强破限`]] },
  { key: 'intimacy', label: t`亲密描写`, hint: t`克制：点到为止；自然：剧情到了就写；强化：直白细致。`, values: [['restrained', t`克制`], ['natural', t`自然`], ['explicit', t`强化`]] },
  { key: 'choices', label: t`行动选项`, hint: t`回复末尾给四个行动：点一下填进输入框，点箭头直接发送。`, values: [['off', t`关`], ['four', t`四个`]] },
  { key: 'timeBox', label: t`时间框`, hint: t`回复开头一行写时间、地点和天气。`, values: [['off', t`关`], ['on', t`开`]] },
  { key: 'statusBar', label: t`状态栏`, hint: t`卡里有变量、但没有自带状态栏时，按变量自动排一个。只影响显示，马上生效。`, values: [['off', t`关`], ['auto', t`自动`]], prompt: false },
]

// The visual novel preset (视觉小说预设): its own options first, then the built-in preset's.
export const VN_FIELDS = [
  { key: 'dialogue', label: t`对白`, hint: t`对白多一些，角色靠说话表现性格和关系；台本式几乎全是对白。`, values: [['more', t`为主`], ['most', t`台本式`], ['balanced', t`各半`]] },
  { key: 'narration', label: t`旁白`, hint: t`简明：每段一两句，只写看得见的动作和表情；极简：一句话提示，像游戏文字框。`, values: [['brief', t`简明`], ['minimal', t`极简`], ['normal', t`不限`]] },
  { key: 'scenery', label: t`场景描写`, hint: t`点到为止：换地点时一两句带过，画面交给背景图，不反复描写环境。`, values: [['brief', t`点到为止`], ['normal', t`不限`]] },
  { key: 'paging', label: t`段落`, hint: t`短段：一段一个动作或一句台词，在文字框里一句一句点着读更顺。`, values: [['short', t`短段`], ['normal', t`不限`]] },
  { key: 'flavor', label: t`展开方式`, hint: t`恋爱冒险（galgame）：日常小事件推动关系；文字冒险：线索、悬念和抉择推动剧情。`, values: [['auto', t`跟随卡`], ['galgame', t`恋爱冒险`], ['adventure', t`文字冒险`]] },
  ...BASIC_FIELDS,
]

/** A built-in preset's fields: the visual novel one's, else the basic one's. */
export const fieldsOf = id => (id === 'vn' ? VN_FIELDS : BASIC_FIELDS)

/**
 * One option as a row of buttons. `onPick(key, value)` saves it; the row
 * marks the new value at once.
 */
export function basicField(el, field, value, { onPick, disabled = false, compact = false }) {
  const buttons = field.values.map(([v, label]) =>
    el('button', { type: 'button', 'aria-pressed': String(v === value), disabled, text: label, onclick: () => {
      if (buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.value === v) return
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === v))
      onPick(field.key, v)
    } }),
  )
  field.values.forEach(([v], i) => { buttons[i].dataset.value = v })
  return el('div', { class: `basic-field${compact ? ' compact' : ''}` }, [
    el('span', { class: 'basic-label', text: field.label }),
    el('div', { class: 'seg', role: 'group', 'aria-label': field.label }, buttons),
    compact ? null : el('p', { class: 'basic-hint', text: field.hint }),
  ])
}
