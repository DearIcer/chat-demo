/**
 * 官方账号的界面状态：是否已登录、账号资料、余额与失败原因。
 * 凭证本身保存在 settings 的 accountToken 里，这里只维护可展示的状态。
 */
import { create } from 'zustand'
import { clearAccountToken, useSettings } from '../settings.js'
import type { AccountBalance } from './balance.js'
import {
  fetchBalance,
  fetchProfile,
  logout,
  PlatformError,
  type AccountProfile,
} from './platform.js'
import { startSignIn } from './signIn.js'

/** signing-in 只在跳转到官方登录页之前短暂存在 */
export type AccountPhase = 'signed-out' | 'signing-in' | 'signed-in'

type AccountState = {
  /** signed-in 表示本地存有凭证，资料与余额可能还在读取 */
  phase: AccountPhase
  profile: AccountProfile | null
  /** 资料与余额各自独立失败，一边失败不影响另一边展示 */
  profileError: boolean
  balance: AccountBalance | null
  balanceError: boolean
  /** 最近一次登录操作的失败分类 */
  error: PlatformError['code'] | null
  /** 退出登录时本地凭证没能删掉：内存已停用，但重启后可能恢复 */
  warning: 'storage' | null
}

const initialPhase = (): AccountPhase => (useSettings.getState().accountToken ? 'signed-in' : 'signed-out')

export const useAccount = create<AccountState>(() => ({
  phase: initialPhase(),
  profile: null,
  profileError: false,
  balance: null,
  balanceError: false,
  error: null,
  warning: null,
}))

const codeOf = (error: unknown): PlatformError['code'] =>
  error instanceof PlatformError ? error.code : 'protocol'

/** 是否有可用的凭证（账号 token 或 API Key） */
export const isAuthenticated = (): boolean =>
  Boolean(useSettings.getState().accountToken || useSettings.getState().apiKey)

/**
 * 跳到官方登录页用手机号登录。
 * 成功时页面已经离开，只有失败才返回并记录原因。
 */
export const signIn = async () => {
  useAccount.setState({ phase: 'signing-in', error: null, warning: null })
  try {
    await startSignIn()
  } catch (error) {
    useAccount.setState({
      phase: useSettings.getState().accountToken ? 'signed-in' : 'signed-out',
      error: codeOf(error),
    })
  }
}

/** 退出登录：先删本地凭证，再尽力撤销远端会话；远端失败不回滚本地状态 */
export const signOut = async () => {
  const token = useSettings.getState().accountToken
  // 删除失败也要清掉内存凭证，否则界面显示已退出、请求却仍在用旧 token
  const removed = clearAccountToken()
  useAccount.setState({
    phase: 'signed-out',
    profile: null,
    profileError: false,
    balance: null,
    balanceError: false,
    error: null,
    // 存储里没删掉时告知用户重启后可能恢复登录态
    warning: removed ? null : 'storage',
  })
  if (token) {
    try {
      await logout(token, useSettings.getState().locale)
    } catch {
      // 远端撤销失败不影响本地登出
    }
  }
}

/** 清掉凭证并回到未登录态（凭证被服务端拒绝时使用） */
export const dropAccount = () => {
  // 凭证已被服务端拒绝，同样先停用内存里的 token；本地删不掉时下次启动会再走一遍这个流程
  clearAccountToken()
  useAccount.setState({
    phase: 'signed-out',
    profile: null,
    profileError: false,
    balance: null,
    balanceError: false,
    error: null,
    warning: null,
  })
}

/**
 * 读取账号资料与余额。两者并行、各自独立成败：
 * 凭证被任一方拒绝时清掉本地凭证；网络等原因失败只标记对应区块。
 * 读取期间证件被换掉（登出或重新登录）就丢弃这次结果。
 */
export const refreshAccount = async () => {
  const token = useSettings.getState().accountToken
  if (!token) {
    useAccount.setState({
      phase: 'signed-out',
      profile: null,
      profileError: false,
      balance: null,
      balanceError: false,
    })
    return
  }
  const unchanged = () => useSettings.getState().accountToken === token
  const locale = useSettings.getState().locale
  const [profile, balance] = await Promise.allSettled([
    fetchProfile(token, locale),
    fetchBalance(token, locale),
  ])
  if (!unchanged()) {
    return
  }
  if (isExpired(profile) || isExpired(balance)) {
    dropAccount()
    return
  }
  useAccount.setState({
    phase: 'signed-in',
    profile: profile.status === 'fulfilled' ? profile.value : null,
    profileError: profile.status === 'rejected',
    balance: balance.status === 'fulfilled' ? balance.value : null,
    balanceError: balance.status === 'rejected',
  })
}

const isExpired = (result: PromiseSettledResult<unknown>): boolean =>
  result.status === 'rejected' &&
  result.reason instanceof PlatformError &&
  result.reason.code === 'expired'
