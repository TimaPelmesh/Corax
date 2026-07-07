import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // For local dev (no Docker): backend usually on 127.0.0.1:3001.
  // For Docker: set VITE_DEV_PROXY_TARGET=http://backend:3001 (now matches internal port)
  const proxyTarget =
    ((process.env.VITE_DEV_PROXY_TARGET || env.VITE_DEV_PROXY_TARGET || '').trim() || 'http://127.0.0.1:3001')

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // In Docker we need 0.0.0.0; locally host=true is fine too.
      host: true,
      port: 3000,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
          timeout: 360_000,
          proxyTimeout: 360_000,
        },
      },
    },
  }
})
