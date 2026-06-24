/// <reference types="vite/client" />

import type { HubApi } from '../../preload'

declare global {
  interface Window {
    api: HubApi
  }
}
