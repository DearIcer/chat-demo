/**
 * DeepSeek 官方账号（Platform）的鉴权协议。
 *
 * 流程与 deepseek-harness 的 `deepseek-account-platform` 一致：
 * 1. `auth_init` 带上 PKCE challenge 与回跳地址，拿到 `authorize_url`；
 * 2. 浏览器跳到该地址，用户用手机号与短信验证码在官方页面完成登录；
 * 3. 官方页面回跳到 `<origin>/oauth/callback?code=…&state=…`；
 * 4. `auth_exchange` 用 code 与 verifier 换取账号 token，之后作为 `x-dsh-auth-token` 使用。
 *
 * Platform 不返回 CORS 响应头，浏览器无法直接跨域调用，因此请求统一发往同源的
 * `__AUTH_ORIGIN__`（默认 `/__auth`），由开发服务器或部署侧反向代理转发。
 */
import { isDecimal, type AccountBalance, type AccountWallet } from './balance.js'
import type { Locale } from '../settings.js'

/** 鉴权接口的浏览器可见前缀，见 rspack.config.ts 的 createConfig */
const PLATFORM_BASE = __AUTH_ORIGIN__
/** 唯一允许跳转的官方授权页主机名，见 rspack.config.ts 的 createConfig */
const AUTH_HOST = __AUTH_HOST__
/** 余额查询超时；与 harness 的 balanceTimeoutMs 默认值一致 */
const BALANCE_TIMEOUT_MS = 30_000

/** 开放平台的用量与充值页面，链接目标与 harness 一致 */
export const PLATFORM_LINKS = {
  usage: `https://${AUTH_HOST}/usage`,
  topUp: `https://${AUTH_HOST}/top_up`,
} as const

/** 回跳路径；与发给 Platform 的 redirect_uri 必须完全一致 */
export const CALLBACK_PATH = '/oauth/callback'

/**
 * 回跳地址。必须与 harness 一致：loopback origin + 固定的 `/oauth/callback`。
 * Platform 在登录成功后按这个地址回跳，路径不符会停在官方「授权失败」页。
 */
export const redirectUri = (): string => `${location.origin}${CALLBACK_PATH}`

/** 回跳地址里是否带着官方登录的授权结果 */
export const isCallback = (search: string): boolean => {
  const params = new URLSearchParams(search)
  return params.has('code') || (params.has('state') && params.has('error'))
}

/**
 * 失败分类，文案由调用方本地化。
 * `unavailable`：同源前缀没有转发到 Platform（部署时缺少反向代理）。
 * `storage`：本地存不下授权尝试，无法跨跳转完成登录。
 */
export type PlatformErrorCode = 'network' | 'protocol' | 'expired' | 'unavailable' | 'storage'

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    /** 服务端返回的 biz_msg，仅用于诊断，不直接展示 */
    readonly detail?: string
  ) {
    super(`platform: ${code}${detail ? ` (${detail})` : ''}`)
    this.name = 'PlatformError'
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** Platform 的界面语言只取主语言标签 */
const platformLocale = (locale: Locale): string => (locale === 'zh-CN' ? 'zh_CN' : 'en_US')

/**
 * 五个客户端身份请求头：Platform 用它识别发起请求的界面。
 * 部署配置不能覆盖它们。
 */
const clientHeaders = (locale: Locale): Record<string, string> => ({
  'x-client-platform': 'web',
  'x-client-bundle-id': '',
  'x-client-version': __APP_VERSION__,
  'x-client-locale': platformLocale(locale),
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
})

/** 统一信封：`{ code, data: { biz_code, biz_msg, biz_data } }`，两层都为 0 才算成功 */
const unwrap = (payload: unknown): unknown => {
  const envelope = asRecord(payload)
  const data = asRecord(envelope?.data)
  if (envelope?.code === 40003) {
    throw new PlatformError('expired')
  }
  if (envelope?.code !== 0 || !data) {
    throw new PlatformError('protocol')
  }
  if (data.biz_code !== 0) {
    throw new PlatformError('protocol', asString(data.biz_msg) ?? undefined)
  }
  return data.biz_data
}

const request = async (
  path: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(`${PLATFORM_BASE}${path}`, {
      ...init,
      redirect: 'error',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    // 用户主动中止交由调用方识别，其余都按网络失败处理
    if (signal?.aborted) {
      throw error
    }
    throw new PlatformError('network')
  }
  if (response.status === 401) {
    throw new PlatformError('expired')
  }
  // 同源前缀没有转发到 Platform 时，静态服务器通常直接返回 404/405
  if (response.status === 404 || response.status === 405) {
    throw new PlatformError('unavailable')
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new PlatformError('network')
  }
  if (text === '') {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new PlatformError('protocol')
  }
  return unwrap(payload)
}

const postJson = (path: string, body: unknown, headers: Record<string, string>) =>
  request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** 只接受官方 HTTPS 授权页：主机名必须是配置的官方域名，路径必须是 /dsh/ */
const authorizeUrl = (value: unknown): string => {
  const raw = asString(value)
  if (!raw) {
    throw new PlatformError('protocol')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PlatformError('protocol')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== AUTH_HOST ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/dsh/')
  ) {
    throw new PlatformError('protocol')
  }
  return url.href
}

export type AuthorizationHandshake = {
  readonly authorizeUrl: string
  readonly authorizeId: string
  /** Platform 给出的授权有效期（秒） */
  readonly expiresIn: number
}

/** 第一步：登记一次授权尝试，拿到用户需要打开的官方页面 */
export const startAuthorization = async (input: {
  challenge: string
  state: string
  locale: Locale
}): Promise<AuthorizationHandshake> => {
  const headers = clientHeaders(input.locale)
  const data = asRecord(
    await postJson(
      '/auth-api/v0/dsh/auth_init',
      {
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        state: input.state,
        redirect_uri: redirectUri(),
        locale: platformLocale(input.locale),
        login_source: 'web',
      },
      headers
    )
  )
  const authorizeUrlValue = authorizeUrl(data?.authorize_url)
  const authorizeId = asString(data?.authorize_id)
  const expiresIn = typeof data?.expires_in === 'number' ? data.expires_in : 0
  if (!authorizeId || expiresIn <= 0) {
    throw new PlatformError('protocol')
  }
  return { authorizeUrl: authorizeUrlValue, authorizeId, expiresIn }
}

/** 浏览器 `navigator.userAgentData` 只在部分浏览器可用 */
type UserAgentData = {
  readonly platform?: string
  readonly brand?: string
  readonly version?: string
}

const userAgentData = (): UserAgentData | undefined =>
  (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData

/** 设备型号与系统版本仅作标识，Platform 不校验具体取值 */
const describeDevice = (): { model: string; osVersion: string } => {
  const data = userAgentData()
  const platform = data?.platform || navigator.platform || 'web'
  const version = data?.version || navigator.userAgent
  return { model: `web-${platform.toLowerCase()}`, osVersion: `${platform} ${version}`.slice(0, 120) }
}

export type AuthorizationGrant = {
  readonly token: string
  readonly profile: AccountProfile | null
}

export type AccountProfile = {
  readonly name: string | null
  /** Platform 脱敏后的手机号或邮箱 */
  readonly contact: string | null
  readonly avatarUrl: string | null
}

/** 平台只投影昵称、脱敏联系方式与头像，其他字段一律丢弃 */
const toProfile = (value: unknown): AccountProfile | null => {
  const user = asRecord(value)
  if (!user) {
    return null
  }
  const identity = asRecord(user.id_profile)
  return {
    name: asString(identity?.name) ?? null,
    contact: asString(user.mobile) ?? asString(user.mobile_number) ?? asString(user.email) ?? null,
    avatarUrl: asString(identity?.picture) ?? null,
  }
}

/** 第二步：用回跳的 code 换取账号 token */
export const exchangeAuthorization = async (input: {
  code: string
  verifier: string
  deviceId: string
  locale: Locale
}): Promise<AuthorizationGrant> => {
  const device = describeDevice()
  const data = asRecord(
    await postJson(
      '/auth-api/v0/dsh/auth_exchange',
      {
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: redirectUri(),
        device_id: input.deviceId,
        device_model: device.model,
        os_version: device.osVersion,
      },
      clientHeaders(input.locale)
    )
  )
  const token = asString(data?.token)
  if (!token) {
    throw new PlatformError('protocol')
  }
  return { token, profile: toProfile(data?.user) }
}

/** 授权尝试已在本地取消：尽力通知 Platform，失败不影响本地结果 */
export const cancelAuthorization = async (input: {
  authorizeId: string
  verifier: string
  locale: Locale
}): Promise<void> => {
  await postJson(
    '/auth-api/v0/dsh/auth_cancel',
    { authorize_id: input.authorizeId, code_verifier: input.verifier },
    clientHeaders(input.locale)
  )
}

/** 读取当前账号资料；token 被拒绝时抛 `expired` */
export const fetchProfile = async (
  token: string,
  locale: Locale,
  signal?: AbortSignal
): Promise<AccountProfile> => {
  const data = await request(
    '/auth-api/v0/users/current',
    { method: 'GET', headers: { ...clientHeaders(locale), 'x-dsh-auth-token': token } },
    signal
  )
  const profile = toProfile(data)
  if (!profile) {
    throw new PlatformError('protocol')
  }
  return profile
}

/**
 * 读取账号余额。充值余额与赠金余额是两组独立钱包；查询失败不影响资料展示。
 * token 被拒绝时抛 `expired`，超时按网络失败处理。
 * @param token - 账号 token
 * @param locale - 界面语言，决定客户端身份头
 * @param signal - 调用方的取消信号
 */
export const fetchBalance = async (
  token: string,
  locale: Locale,
  signal?: AbortSignal
): Promise<AccountBalance> => {
  // 与 harness 的 balanceTimeoutMs 一致：余额查询 30 秒超时，避免面板一直停在加载中
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const data = await request(
      '/api/v0/users/get_user_summary',
      { method: 'GET', headers: { ...clientHeaders(locale), 'x-dsh-auth-token': token } },
      controller.signal
    )
    return toBalance(data)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    // 超时会把内部 controller 置为 aborted，这里统一归为网络失败
    throw error instanceof PlatformError ? error : new PlatformError('network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** Platform 只返回这两组钱包，字段形状不合规一律按协议失败处理 */
const toBalance = (value: unknown): AccountBalance => {
  const summary = asRecord(value)
  if (!summary) {
    throw new PlatformError('protocol')
  }
  return {
    normal: toWallets(summary.normal_wallets),
    bonus: toWallets(summary.bonus_wallets),
  }
}

const toWallets = (value: unknown): AccountWallet[] => {
  if (!Array.isArray(value)) {
    throw new PlatformError('protocol')
  }
  return value.map((entry) => {
    const wallet = asRecord(entry)
    const currency = wallet?.currency
    const balance = wallet?.balance
    if ((currency !== 'CNY' && currency !== 'USD') || typeof balance !== 'string' || !isDecimal(balance)) {
      throw new PlatformError('protocol')
    }
    // 保留原始字符串，展示时再格式化
    return { currency, balance }
  })
}

/** 退出登录：只在本地凭证已经删除后调用，失败不回滚本地状态 */
export const logout = async (token: string, locale: Locale): Promise<void> => {
  await request('/auth-api/v0/users/logout', {
    method: 'POST',
    headers: { ...clientHeaders(locale), 'x-dsh-auth-token': token },
  })
}
