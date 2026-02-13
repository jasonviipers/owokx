import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.OWOKX_API_URL || process.env.OWOKX_API_URL || 'http://localhost:8787'

  return {
    define: {
      __OWOKX_API_URL__: JSON.stringify(apiTarget),
    },
    plugins: [react(), tailwindcss()],
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: apiTarget.startsWith('https'),
          rewrite: (path) => path.replace(/^\/api/, '/agent'),
        },
      },
    },
  }
})
