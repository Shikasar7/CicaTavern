// The interface language on the server (设置 → 界面语言; web/shared/i18n.js).
// Each request runs with the language its page shows: settings.uiLanguage, or
// for 跟随系统 the browser's Accept-Language. Messages the page shows are written
// msg`…` in Chinese and come out in that language; index.html is sent translated.
// Text for the model stays Chinese and is not tagged.
import { AsyncLocalStorage } from 'node:async_hooks'
import { acceptedLanguages, createTag, fill, pickLanguage, translateHtml } from '../web/shared/i18n.js'
import serverEnglish, { whole as wholeEnglish } from './i18n/en.mjs'
import webEnglish from '../web/i18n/en.js'

const context = new AsyncLocalStorage()
// Work outside a request (a timer, a job that outlived its request) speaks the
// language of the page that asked last.
let recent = 'zh'

/** The language a request's page shows. */
export const requestLanguage = (setting, req) => pickLanguage(setting, acceptedLanguages(req?.headers?.['accept-language']))

/** Runs fn (and everything it starts) in a language. */
export function withLanguage(lang, fn) {
  recent = lang
  return context.run(lang, fn)
}

export const currentLanguage = () => context.getStore() ?? recent

const tags = { zh: createTag(null), en: createTag(serverEnglish) }

/** A message the page shows, in the current request's language: msg`角色卡不存在`. */
export const msg = (strings, ...args) => tags[currentLanguage()](strings, ...args)

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Whole messages with {n} parts, as patterns that take a finished message apart.
const patterns = Object.keys(wholeEnglish)
  .filter(key => /\{\d+\}/.test(key))
  .map(key => {
    const order = [...key.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]))
    const source = key.split(/\{\d+\}/).map(escapeRegExp).join('([\\s\\S]*?)')
    return { key, order, re: new RegExp(`^${source}$`), fixed: key.replace(/\{\d+\}/g, '').length }
  })
  // The most specific first: 新版本的 {0} 不完整 before {0} 不完整.
  .sort((a, b) => b.fixed - a.fixed)

/**
 * A finished message in the current language. For the modules bin/launch.mjs
 * loads on its own (store.mjs, proxy.mjs, update/install.mjs, update/zip.mjs),
 * which cannot import this file: their messages are matched whole on the way
 * out (sendJson, stream errors). Anything else passes through.
 */
export function localize(text) {
  if (currentLanguage() !== 'en' || typeof text !== 'string') return text
  if (Object.hasOwn(wholeEnglish, text)) return fill(wholeEnglish[text], [])
  for (const { key, order, re } of patterns) {
    const match = re.exec(text)
    if (!match) continue
    const parts = []
    order.forEach((n, i) => { parts[n] = localize(match[i + 1]) })
    return fill(wholeEnglish[key], parts)
  }
  return text
}

/** index.html in a language. */
export const pageIn = (html, lang) => translateHtml(html, lang === 'en' ? webEnglish : null, lang)
