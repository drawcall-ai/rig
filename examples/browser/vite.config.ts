import { glts } from '@drawcall/glts/vite'
import { defineConfig } from 'vite'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [glts()],
  server: { headers },
  preview: { headers },
  build: { assetsInlineLimit: 0 },
})
