import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const storyApiTarget = loadEnv(mode, '.', '').VITE_STORY_API_TARGET ?? 'http://127.0.0.1:8787'

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: storyApiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
