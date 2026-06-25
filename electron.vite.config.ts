import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// node-pty (the embedded terminal's native module) lives in the main process and
// is kept OUT of the Vite bundle by externalizeDepsPlugin. We use the prebuilt
// @homebridge/node-pty fork, so there's no native rebuild step — electron-builder.yml
// sets npmRebuild: false and asar-unpacks it.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
