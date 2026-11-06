import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'motion/react'

import '@fontsource/unbounded/700.css'
import '@fontsource/unbounded/800.css'
import '@fontsource/onest/400.css'
import '@fontsource/onest/500.css'
import '@fontsource/onest/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/titlebar.css'
import './styles/board.css'
import './styles/rail.css'
import './styles/capsule.css'
import './styles/overlays.css'

import { App } from './App'
import { ToastProvider } from './components/Toasts'

document.documentElement.dataset.platform = navigator.platform.startsWith('Mac') ? 'mac' : 'other'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <App />
      </ToastProvider>
    </MotionConfig>
  </StrictMode>
)
