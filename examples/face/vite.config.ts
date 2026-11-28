import { defineConfig } from 'vite'
import { cache } from '@drawcall/cache/vite'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [cache()],
  server: { headers },
  preview: { headers },
  build: { assetsInlineLimit: 0 },
})
