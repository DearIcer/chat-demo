/**
 * PKCE（RFC 7636）与 state 参数。全部走 Web Crypto：`crypto.subtle` 只在安全上下文
 * （HTTPS 或 localhost）可用，file:// 打开时登录不可用，调用方需要给出提示。
 */

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type Pkce = {
  /** 只存在于本地，交换 token 时回传 */
  readonly verifier: string
  /** 发给 Platform 的 S256 摘要 */
  readonly challenge: string
  /** 回调时校验的随机值 */
  readonly state: string
}

/** 浏览器是否具备登录所需的密码学能力 */
export const canSignIn = (): boolean =>
  typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function'

/** 生成一次授权尝试的 verifier / challenge / state */
export const createPkce = async (): Promise<Pkce> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return {
    verifier,
    challenge: base64Url(new Uint8Array(digest)),
    state: base64Url(crypto.getRandomValues(new Uint8Array(32))),
  }
}

/** 长度一致的常量时间比较，避免用 === 比较回传的 state */
export const equalState = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
