import { glts } from '@drawcall/glts/vite'
import { defineConfig } from 'vite'
import { vitecache } from 'vitecache/vite'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [glts(), vitecache()],
  server: { headers },
  preview: { headers },
  build: { assetsInlineLimit: 0 },
})
