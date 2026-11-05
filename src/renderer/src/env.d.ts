/// <reference types="vite/client" />
import type { StudioApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: StudioApi
  }
}
export {}
