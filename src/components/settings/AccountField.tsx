import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  currencySymbol,
  formatBalance,
  positiveWallets,
  type AccountBalance,
} from '../../services/auth/balance.js'
import { PLATFORM_LINKS, PlatformError } from '../../services/auth/platform.js'
import { signOut, signIn, useAccount } from '../../services/auth/store.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

const failureText = (error: PlatformError['code']): TranslationKey => {
  switch (error) {
    case 'network':
      return 'accountSignInFailedNetwork'
    case 'expired':
      return 'accountSignInFailedExpired'
    case 'unavailable':
      return 'accountSignInFailedUnavailable'
    case 'storage':
      return 'accountSignInFailedStorage'
    default:
      return 'accountSignInFailedProtocol'
  }
}

/** 多币种余额并排显示；空数组交给调用方决定占位文案 */
const BalanceAmount = ({ wallets }: { wallets: AccountBalance['normal'] }) => (
  <>
    {wallets.map((wallet) => (
      <span key={wallet.currency}>{formatBalance(wallet.balance, currencySymbol(wallet.currency))}</span>
    ))}
  </>
)

/** 余额查询失败或不返回钱包时，指到开放平台让用户自己看 */
const PlatformHint = () => {
  const t = useTranslate()
  return (
    <a className={styles.balanceHint} href={PLATFORM_LINKS.usage} target="_blank" rel="noreferrer">
      {t('accountBalanceUnavailable')}
    </a>
  )
}

/**
 * 官方账号：用手机号在 DeepSeek 官方页面登录，登录后无需填写 API Key。
 * 已登录时展示脱敏手机号、充值余额与赠金余额，并提供用量与充值入口。
 */
export const AccountField = () => {
  const t = useTranslate()
  const phase = useAccount((state) => state.phase)
  const profile = useAccount((state) => state.profile)
  const balance = useAccount((state) => state.balance)
  const balanceError = useAccount((state) => state.balanceError)
  const error = useAccount((state) => state.error)
  const warning = useAccount((state) => state.warning)
  const signingIn = phase === 'signing-in'
  const signedIn = phase === 'signed-in'
  // 赠金只在加载中或确实有金额时占一行，避免长期挂一个 ¥0.00
  const bonus = balance ? positiveWallets(balance.bonus) : []
  const showBonus = !balance || bonus.length > 0

  const status = signedIn
    ? profile?.contact
      ? t('accountSignedIn', { contact: profile.contact })
      : t('accountContactPending')
    : t('accountDescription')

  return (
    <div className={styles.cell}>
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountLabel')}</div>
          <div className={styles.description}>{status}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={signingIn}
          onClick={() => (signedIn ? void signOut() : void signIn())}
        >
          {signingIn ? t('accountSigningIn') : t(signedIn ? 'accountSignOut' : 'accountSignIn')}
        </Button>
      </div>
      {error ? (
        <div className={styles.error}>
          {t(
            error === 'protocol' && !window.isSecureContext
              ? 'accountInsecureContext'
              : failureText(error)
          )}
        </div>
      ) : null}
      {/* 已退出，但本地凭证没删掉：内存里已经停用，重启后可能又读回来 */}
      {!signedIn && warning === 'storage' ? (
        <div className={styles.error}>{t('accountSignOutStorageFailed')}</div>
      ) : null}
      {signedIn ? (
        <div className={styles.balance}>
          <div className={styles.balanceRow}>
            <span className={styles.balanceLabel}>{t('accountBalance')}</span>
            <span className={styles.balanceValue}>
              {balanceError ? (
                <PlatformHint />
              ) : balance ? (
                balance.normal.length > 0 ? (
                  <BalanceAmount wallets={balance.normal} />
                ) : (
                  <PlatformHint />
                )
              ) : (
                <span className={styles.balanceMuted}>{t('accountBalanceLoading')}</span>
              )}
            </span>
          </div>
          {showBonus ? (
            <div className={styles.balanceRow}>
              <span className={styles.balanceLabel}>{t('accountBonusBalance')}</span>
              <span className={styles.balanceValue}>
                {bonus.length > 0 ? (
                  <BalanceAmount wallets={bonus} />
                ) : balanceError ? (
                  <PlatformHint />
                ) : (
                  <span className={styles.balanceMuted}>{t('accountBalanceLoading')}</span>
                )}
              </span>
            </div>
          ) : null}
          <div className={styles.balanceRow}>
            <span className={styles.balanceLabel}>{t('accountMore')}</span>
            <span className={styles.balanceLinks}>
              <a className={styles.balanceLink} href={PLATFORM_LINKS.usage} target="_blank" rel="noreferrer">
                {t('accountUsage')}
              </a>
              <a className={styles.balanceLink} href={PLATFORM_LINKS.topUp} target="_blank" rel="noreferrer">
                {t('accountTopUp')}
              </a>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
