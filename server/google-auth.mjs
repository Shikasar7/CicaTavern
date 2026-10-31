// Google Cloud credentials, for Agent Platform (once Vertex AI; the 「Gemini Agent
// Platform 应用默认凭据」 template). Without an API key its OpenAI-compatible address
// takes an OAuth access token that lasts an hour; the provider keeps a JSON
// credential instead and a token is made from it here, kept until a few minutes
// before it runs out. Two kinds:
// - a service account's JSON key: a signed JWT traded at Google's token address;
// - the file `gcloud auth application-default login` writes (authorized_user),
//   for organizations that allow neither API keys nor service account keys:
//   its refresh token traded the same way.
import { createHash, createSign } from 'node:crypto'
import { httpError } from './store.mjs'
import { msg } from './i18n.mjs'

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const LIFETIME_S = 3600
const MARGIN_MS = 5 * 60 * 1000

const text = value => (typeof value === 'string' ? value : '')

/**
 * The parts of a credential a token needs, or null when `value` is not one:
 * { kind: 'service_account', projectId, email, privateKey, tokenUri }
 * or { kind: 'authorized_user', projectId, clientId, clientSecret, refreshToken, tokenUri }.
 */
export function googleCredential(value) {
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return null
  let json
  try {
    json = JSON.parse(value)
  } catch {
    return null
  }
  const tokenUri = allowedTokenUri(json?.token_uri)
  if (json?.type === 'service_account') {
    const { client_email: email, private_key: privateKey } = json
    if (!text(email) || !text(privateKey).includes('PRIVATE KEY')) return null
    return { kind: 'service_account', projectId: text(json.project_id), email, privateKey, tokenUri }
  }
  if (json?.type === 'authorized_user') {
    const { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } = json
    if (!text(clientId) || !text(clientSecret) || !text(refreshToken)) return null
    // gcloud writes the quota project here once one is set (or `project_id` when this file is ours).
    return { kind: 'authorized_user', projectId: text(json.quota_project_id) || text(json.project_id), clientId, clientSecret, refreshToken, tokenUri }
  }
  return null
}

/** Google's token address; one on this machine is let through for tests. */
function allowedTokenUri(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.href
  } catch {
    // not a URL
  }
  return TOKEN_URI
}

/** What the provider stores: the credential cut down to what a token needs, on one line. */
export function compactCredential(value) {
  const cred = googleCredential(value)
  if (!cred) throw httpError(400, msg`这不是 Google 的 JSON 凭据：要服务账号的 JSON 密钥，或者 gcloud auth application-default login 生成的 application_default_credentials.json`)
  const tokenUri = cred.tokenUri === TOKEN_URI ? {} : { token_uri: cred.tokenUri }
  return cred.kind === 'service_account'
    ? JSON.stringify({ type: cred.kind, project_id: cred.projectId, client_email: cred.email, private_key: cred.privateKey, ...tokenUri })
    : JSON.stringify({ type: cred.kind, project_id: cred.projectId, client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.refreshToken, ...tokenUri })
}

const base64url = value => Buffer.from(value).toString('base64url')

function assertion(cred, now = Date.now()) {
  const iat = Math.floor(now / 1000)
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: cred.email, scope: SCOPE, aud: cred.tokenUri, iat, exp: iat + LIFETIME_S }))
  let signature
  try {
    signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(cred.privateKey, 'base64url')
  } catch {
    throw httpError(400, msg`服务账号 JSON 里的私钥读不出来，重新下载一份 JSON 密钥再粘贴`)
  }
  return `${head}.${claims}.${signature}`
}

function tokenForm(cred) {
  return cred.kind === 'service_account'
    ? { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(cred) }
    : { grant_type: 'refresh_token', client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.refreshToken }
}

// Tokens by credential (a hash of it, never the credential itself), with when each runs out.
const tokens = new Map()

/**
 * An access token for the credential in `value`.
 * @param post - (url, formBody, options) → { status, text }: the providers' own request, with its proxy.
 */
export async function accessToken(value, post, options = {}) {
  const cred = googleCredential(value)
  if (!cred) throw httpError(400, msg`这不是 Google 的 JSON 凭据`)
  const cacheKey = createHash('sha256').update(value).digest('hex')
  const known = tokens.get(cacheKey)
  if (known && known.until - MARGIN_MS > Date.now()) return known.token
  const { status, text: reply } = await post(cred.tokenUri, new URLSearchParams(tokenForm(cred)).toString(), options)
  let json = null
  try {
    json = JSON.parse(reply)
  } catch {
    // not JSON
  }
  if (status < 200 || status >= 300 || typeof json?.access_token !== 'string') {
    const reason = String(json?.error_description ?? json?.error ?? reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(cred.kind === 'service_account'
      ? msg`Google 没有给服务账号发令牌（${status} ${reason}）：密钥可能被删了或停用了，重新下载一份 JSON 密钥再试`
      : msg`Google 没有发令牌（${status} ${reason}）：gcloud 的登录可能过期了，重新运行 gcloud auth application-default login，再把新生成的文件选进来`)
  }
  const lifetime = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : LIFETIME_S * 1000
  tokens.set(cacheKey, { token: json.access_token, until: Date.now() + lifetime })
  return json.access_token
}
