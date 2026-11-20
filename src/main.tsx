import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { LoginCallback, isLoginCallback } from './components/auth/LoginCallback.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

// 官方登录回跳页只处理授权结果，不进入聊天界面
createRoot(document.getElementById('root') as HTMLElement).render(
  isLoginCallback() ? <LoginCallback /> : <App />
)
