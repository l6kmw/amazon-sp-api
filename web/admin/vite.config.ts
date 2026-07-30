import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react({
      jsxImportSource: '@emotion/react',
      babel: {
        plugins: ['@emotion/babel-plugin']
      }
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8789',
      '/connected-account': 'http://localhost:8789',
      '/oauth': 'http://localhost:8789',
      '/admin-config.js': 'http://localhost:8789'
    }
  }
})
