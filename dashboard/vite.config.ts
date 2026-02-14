import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.OWOKX_API_URL || process.env.OWOKX_API_URL || 'http://localhost:8787'

  return {
    define: {
      __OWOKX_API_URL__: JSON.stringify(apiTarget),
    },
    plugins: [react({
      babel: {
        plugins: [[
          'babel-plugin-react-compiler'
        ]],
      },
    })],
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: apiTarget.startsWith('https'),
          rewrite: (path) => path.replace(/^\/api/, '/agent'),
        },
        '/auth': {
          target: apiTarget,
          changeOrigin: true,
          secure: apiTarget.startsWith('https'),
        },
      },
    },
  }
})
