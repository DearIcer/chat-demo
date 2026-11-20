/**
 * 账号钱包与余额格式化。
 *
 * 规则与 deepseek-harness（`deepseek-account-platform`）一致：Platform 返回的是十进制字符串，
 * 允许省略整数或小数部分与十进制指数（`0E-16`、`5.0000000000000000` 都合法），
 * 因此这里用十进制数字串换算，避免浮点误差，并保留原始字符串。
 */

/** Platform 钱包：币种与余额字符串 */
export type AccountWallet = {
  readonly currency: 'CNY' | 'USD'
  /** 原始十进制字符串，保留服务端精度 */
  readonly balance: string
}

/** 充值余额与赠金余额是两组独立的钱包 */
export type AccountBalance = {
  readonly normal: readonly AccountWallet[]
  readonly bonus: readonly AccountWallet[]
}

/** 与 Platform Web 客户端交给 big.js 的文法一致：可省略整数或小数部分，允许十进制指数 */
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * 余额字符串的长度与指数上限。
 * 文法是 Platform 那边的，但格式化发生在 React 渲染期间，必须自己设边界：
 * 否则 `1e999999999` 这样的响应会在换算时构造出天文数字的 BigInt，把界面拖死。
 */
const MAX_AMOUNT_LENGTH = 40
const MAX_EXPONENT = 32

/** 是否为 Platform 认可且可以安全格式化的余额字符串 */
export const isDecimal = (value: string): boolean => {
  if (value.length > MAX_AMOUNT_LENGTH || !DECIMAL.test(value)) {
    return false
  }
  const exponentText = value.toLowerCase().split('e')[1]
  if (exponentText === undefined) {
    return true
  }
  const exponent = Number(exponentText)
  return Number.isFinite(exponent) && Math.abs(exponent) <= MAX_EXPONENT
}

type Decimal = {
  readonly negative: boolean
  readonly isZero: boolean
  /** 向零截断到分的整数部分（1 分 = 0.01） */
  readonly cents: bigint
}

/** 把十进制字符串换算成分；非法输入返回 null */
const toDecimal = (raw: string): Decimal | null => {
  if (!isDecimal(raw)) {
    return null
  }
  const negative = raw.startsWith('-')
  const body = (negative ? raw.slice(1) : raw).toLowerCase()
  const [mantissa = '0', exponentText] = body.split('e')
  const exponent = exponentText === undefined ? 0 : Number(exponentText)
  const [integer = '', fraction = ''] = mantissa.split('.')
  const digits = `${integer}${fraction}` || '0'
  // 数值 = digits × 10^-fraction.length × 10^exponent；换算成分再乘 100
  const shift = 2 - fraction.length + exponent
  let cents = BigInt(digits)
  if (shift >= 0) {
    cents *= 10n ** BigInt(shift)
  } else {
    // 向零截断：负数也按绝对值截断，与 big.js 的 roundDown 一致
    cents /= 10n ** BigInt(-shift)
  }
  return { negative, isZero: !/[1-9]/.test(digits), cents }
}

/** 分 → 带千分位的两位小数 */
const formatCents = (cents: bigint): string => {
  const text = cents.toString().padStart(3, '0')
  const integer = text.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${integer}.${text.slice(-2)}`
}

/**
 * 按 Platform Web 的规则格式化余额：
 * `0` → `¥0.00`；小于 0.01 的正数 → `<¥0.01`；
 * 负数的绝对值小于 0.01 时显示 `-¥0.01`；其余向下截断到两位并加千分位。
 * 越界的输入不会被接口层接受，这里仍做兜底，保证渲染期间不会抛异常。
 * @param amount - 已通过文法校验的余额字符串
 * @param symbol - 币种符号
 */
export const formatBalance = (amount: string, symbol: '¥' | '$'): string => {
  try {
    const value = toDecimal(amount)
    if (!value) {
      return `${symbol}0.00`
    }
    if (value.isZero) {
      return `${symbol}0.00`
    }
    if (value.negative) {
      return `-${symbol}${value.cents === 0n ? '0.01' : formatCents(value.cents)}`
    }
    return value.cents === 0n ? `<${symbol}0.01` : `${symbol}${formatCents(value.cents)}`
  } catch {
    // 兜底：格式化绝不能把整个界面带崩
    return `${symbol}0.00`
  }
}

/** 币种符号；只支持 Platform 现有的两种法币 */
export const currencySymbol = (currency: AccountWallet['currency']): '¥' | '$' =>
  currency === 'CNY' ? '¥' : '$'

/** 赠金余额只展示大于 0 的钱包 */
export const positiveWallets = (wallets: readonly AccountWallet[]): AccountWallet[] =>
  wallets.filter((wallet) => {
    const value = toDecimal(wallet.balance)
    return value !== null && !value.isZero && !value.negative
  })
