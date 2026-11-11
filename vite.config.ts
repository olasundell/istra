import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Vitest keeps an inherited NODE_ENV=production, which makes Vite resolve Node built-ins to browser stubs and
// loads React's production build without act(). Tests must always run in test mode.
if (process.env.VITEST) process.env.NODE_ENV = 'test'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
  build: { outDir: 'dist-web' },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/web/test-setup.ts'],
  },
})
