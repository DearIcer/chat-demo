/**
 * 官方账号登录的本地状态：PKCE 尝试与设备标识。
 *
 * 授权尝试存在 sessionStorage：整页跳转到官方登录页再回跳时，同一个标签页仍然读得到 verifier。
 * 它是一次性的，读写之后立即清除。
 */
import { saveAccountToken, useSettings } from '../settings.js'
import { canSignIn, createPkce, equalState } from './pkce.js'
import {
  cancelAuthorization,
  exchangeAuthorization,
  PlatformError,
  startAuthorization,
  type AccountProfile,
} from './platform.js'

const PENDING_KEY = 'chat-demo:auth-pending'
const DEVICE_KEY = 'chat-demo:device-id'

/** 一次未完成的授权尝试 */
type Pending = {
  readonly verifier: string
  readonly state: string
  readonly authorizeId: string
}

const readPending = (): Pending | null => {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    if (!raw) {
      return null
    }
    const value = JSON.parse(raw) as Partial<Pending> | null
    if (
      typeof value?.verifier !== 'string' ||
      typeof value.state !== 'string' ||
      typeof value.authorizeId !== 'string'
    ) {
      return null
    }
    return { verifier: value.verifier, state: value.state, authorizeId: value.authorizeId }
  } catch {
    return null
  }
}

/** 保存一次待完成的授权尝试；失败时抛错，调用方必须放弃跳转 */
const savePending = (pending: Pending) => {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // 存不下 verifier 时回跳页无法完成交换，宁可不跳转
    throw new PlatformError('storage')
  }
}

/** 清除待完成的授权尝试；清理失败不影响已经完成的登录 */
const clearPending = () => {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // 陈旧记录会在下一次登录时被覆盖，且回跳时会重新校验 state
  }
}

/** 设备标识：首次登录时生成后复用，与 harness 的设备记录含义一致 */
const deviceId = (): string => {
  try {
    const saved = localStorage.getItem(DEVICE_KEY)
    if (saved) {
      return saved
    }
    const created = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

/** 本地是否还留着一次未完成的授权尝试 */
export const hasPendingSignIn = (): boolean => readPending() !== null

/**
 * 跳到官方登录页。成功时不返回：浏览器离开当前页面，登录在回跳页继续。
 * 本地存不下授权尝试时抛错并且不跳转，避免用户登录完却无法完成交换。
 */
export const startSignIn = async (): Promise<void> => {
  if (!canSignIn()) {
    throw new PlatformError('protocol', 'insecure-context')
  }
  const pkce = await createPkce()
  const { locale } = useSettings.getState()
  const handshake = await startAuthorization({
    challenge: pkce.challenge,
    state: pkce.state,
    locale,
  })
  savePending({
    verifier: pkce.verifier,
    state: pkce.state,
    authorizeId: handshake.authorizeId,
  })
  location.assign(handshake.authorizeUrl)
}

/**
 * 回跳页：校验 state，用 code 换取账号 token 并保存。
 * 无论成功与否，本地的授权尝试都只用一次。
 * @param search - 回跳地址的查询串
 * @returns 登录得到的账号资料；交换响应可能不带 user，此时为 null
 */
export const completeSignIn = async (search: string): Promise<AccountProfile | null> => {
  const params = new URLSearchParams(search)
  const pending = readPending()
  const code = params.get('code')
  const state = params.get('state')
  const refused = params.get('error')
  clearPending()

  if (!pending) {
    throw new PlatformError('protocol', 'missing-attempt')
  }
  const { locale } = useSettings.getState()
  if (refused || !code || !state || !equalState(state, pending.state)) {
    // 用户在官方页面取消或回跳参数不合法：尽力通知 Platform，失败不影响本地结果
    void cancelAuthorization({
      authorizeId: pending.authorizeId,
      verifier: pending.verifier,
      locale,
    }).catch(() => undefined)
    throw new PlatformError('protocol', refused ?? (code ? 'state-mismatch' : 'cancelled'))
  }

  const grant = await exchangeAuthorization({
    code,
    verifier: pending.verifier,
    deviceId: deviceId(),
    locale,
  })
  // 凭证必须落盘：存不下就报错，回跳页会留在原地提示，不做整页跳转
  if (!saveAccountToken(grant.token)) {
    throw new PlatformError('storage')
  }
  return grant.profile
}
