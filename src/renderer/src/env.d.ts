/// <reference types="vite/client" />
import type { StubApi } from '@shared/contract'

declare global {
  interface Window {
    api: StubApi
  }
}

export {}
