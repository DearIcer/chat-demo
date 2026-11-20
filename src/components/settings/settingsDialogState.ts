import { create } from 'zustand'
import { hasCredential } from '../../services/auth/credential.js'
import { refreshAccount } from '../../services/auth/store.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、没有凭证时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) => {
  useSettingsDialog.setState({ open: true, section })
  // 每次进入设置都重新读取资料与余额，余额在别处可能已经变化
  void refreshAccount()
}

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 没有凭证（官方账号或 API Key）时打开设置并选中「数据管理」，返回是否已有凭证。
 * 账号登录与 API Key 都在这个分组里。
 */
export const ensureCredential = () => {
  if (hasCredential()) {
    return true
  }
  openSettings('data')
  return false
}
