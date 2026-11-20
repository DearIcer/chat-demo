import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { isCallback, PlatformError } from '../../services/auth/platform.js'
import { completeSignIn } from '../../services/auth/signIn.js'
import styles from './LoginCallback.module.css'

/** 当前地址是否带着官方登录的回跳参数 */
export const isLoginCallback = (): boolean => isCallback(location.search)

/** 凭证可能已经发行，但本地存不下；本地保存失败需要单独说明 */
const failureText = (error: unknown): TranslationKey =>
  error instanceof PlatformError && error.code === 'storage'
    ? 'accountSignInFailedStorage'
    : 'loginFailed'

/**
 * 官方登录回跳页：校验 state、用 code 换取账号 token 并保存。
 * 成功后整页回到应用首页，让启动流程按已登录状态重新初始化；
 * 失败（含凭证写不进本地存储）时留在本页提示，不跳转。
 */
export const LoginCallback = () => {
  const t = useTranslate()
  const [failure, setFailure] = useState<TranslationKey | null>(null)

  useEffect(() => {
    let active = true
    void completeSignIn(location.search)
      .then(() => {
        if (active) {
          location.replace('/')
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFailure(failureText(error))
        }
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className={styles.page}>
      <div className={styles.card} role="status" aria-live="polite">
        {failure ? (
          <>
            <div className={styles.error}>{t(failure)}</div>
            <a className={styles.back} href="/">
              {t('loginBack')}
            </a>
          </>
        ) : (
          <div className={styles.status}>
            <span className={styles.spinner} />
            <span>{t('loginCompleting')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
