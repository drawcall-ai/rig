import { glts } from '@drawcall/glts/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [glts()],
  build: { assetsInlineLimit: 0 },
})
