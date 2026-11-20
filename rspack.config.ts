import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

/** 官方账号鉴权（Platform）在浏览器里的默认前缀，由开发服务器或部署侧反向代理转发 */
const DEFAULT_AUTH_ORIGIN = '/__auth'
/** 官方账号鉴权的上游地址 */
const DEFAULT_AUTH_UPSTREAM = 'https://platform.deepseek.com'

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /**
   * 官方账号鉴权的浏览器可见地址，注入为 __AUTH_ORIGIN__。
   * 以 `/` 开头时按同源路径处理，开发服务器会把它代理到 `authUpstream`。
   * Platform 不返回 CORS 响应头，浏览器不能直接跨域调用，因此必须经由同源代理。
   */
  authOrigin?: string
  /** `authOrigin` 为同源路径时的上游地址 */
  authUpstream?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  authOrigin = DEFAULT_AUTH_ORIGIN,
  authUpstream = DEFAULT_AUTH_UPSTREAM,
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载；
    // 开发服务器用根绝对路径，登录回跳的 /oauth/callback 也能取到脚本
    publicPath: dev ? '/' : 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({
      __API_ORIGIN__: JSON.stringify(apiOrigin),
      __AUTH_ORIGIN__: JSON.stringify(authOrigin),
      // 授权页只允许跳到这个官方主机，避免被错误的代理指向任意地址
      __AUTH_HOST__: JSON.stringify(new URL(authUpstream).hostname),
      __APP_VERSION__: JSON.stringify(version),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: {
    port: 8090,
    ...(dev
      ? {
          // 登录回跳固定在 /oauth/callback，开发服务器同样回落到 index.html
          historyApiFallback: true,
          // 浏览器不能跨域调用 Platform，这里按同源路径转发
          ...(authOrigin.startsWith('/')
            ? {
                proxy: [
                  {
                    context: (pathname: string) => pathname.startsWith(`${authOrigin}/`),
                    target: authUpstream,
                    changeOrigin: true,
                    pathRewrite: { [`^${authOrigin}`]: '' },
                  },
                ],
              }
            : {}),
        }
      : {}),
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
