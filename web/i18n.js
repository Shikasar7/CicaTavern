// The page's interface language (设置 → 界面语言). The server picks it when it
// sends index.html (already translated) and says which on <html data-ui-lang>;
// the scripts write their text in Chinese behind t`…`, looked up in
// web/i18n/en.js for English. Switching languages reloads the page.
import { createTag, joined, pickLanguage } from '/shared/i18n.js'

const said = document.documentElement.dataset.uiLang
export const lang = said === 'en' || said === 'zh' ? said : pickLanguage('', navigator.languages ?? [navigator.language])
/** For toLocaleString and the like. */
export const locale = lang === 'en' ? 'en-US' : 'zh-CN'

const dict = lang === 'en' ? (await import('/i18n/en.js')).default : null

/** The text in the interface language: t`删除「${name}」？`, or t(text) for text from a table. */
export const t = createTag(dict)

/** Text that stays Chinese on purpose: written for the model, or matched against what a card or the model wrote. */
export const zh = (strings, ...args) => joined(strings, args)
