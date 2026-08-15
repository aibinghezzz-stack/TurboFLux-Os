import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDirectory = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(desktopDirectory, 'renderer'),
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: resolve(desktopDirectory, '../../dist-desktop/renderer'),
    emptyOutDir: true,
  },
})
