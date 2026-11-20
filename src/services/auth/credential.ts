import { useSettings } from '../settings.js'

/**
 * 调用官方接口的鉴权凭证。
 * 官方账号登录拿到的 token 只走 `x-dsh-auth-token`；API Key 按接口不同分两种头。
 */
export type Credential =
  | { readonly kind: 'api-key'; readonly value: string }
  | { readonly kind: 'account'; readonly value: string }

/** 当前生效的凭证：官方账号 token 优先于 API Key；都没有时返回 null */
export const currentCredential = (): Credential | null => {
  const { accountToken, apiKey } = useSettings.getState()
  if (accountToken) {
    return { kind: 'account', value: accountToken }
  }
  return apiKey ? { kind: 'api-key', value: apiKey } : null
}

/** 是否可以发起请求 */
export const hasCredential = (): boolean => currentCredential() !== null

/**
 * Anthropic 兼容接口（Messages、Files）的鉴权头。
 * 这些接口用 `x-api-key` 接收 API Key；账号 token 用 `x-dsh-auth-token`，
 * 不能写成 `Authorization: Bearer`——服务端会把 Bearer 一律按 API Key 解析。
 */
export const credentialHeaders = (credential: Credential): Record<string, string> =>
  credential.kind === 'account'
    ? { 'x-dsh-auth-token': credential.value }
    : { 'x-api-key': credential.value }

/**
 * 其余官方接口（模型列表、ASR / TTS）的鉴权头。
 * 这些接口按官方文档用 `Authorization: Bearer` 接收 API Key；账号 token 仍用 `x-dsh-auth-token`。
 */
export const bearerHeaders = (credential: Credential): Record<string, string> =>
  credential.kind === 'account'
    ? { 'x-dsh-auth-token': credential.value }
    : { Authorization: `Bearer ${credential.value}` }
