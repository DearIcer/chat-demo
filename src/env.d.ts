declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 官方账号鉴权（Platform）的浏览器可见地址，见 rspack.config.ts 的 createConfig */
declare const __AUTH_ORIGIN__: string

/** 唯一允许跳转的官方授权页主机名，见 rspack.config.ts 的 createConfig */
declare const __AUTH_HOST__: string

/** 构建时的应用版本，取自 package.json */
declare const __APP_VERSION__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
