import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5740,
    proxy: {
      '/api': 'http://localhost:4200',
      '/ws': {
        target: 'ws://localhost:4200',
        ws: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5740,
    proxy: {
      '/api': 'http://localhost:4200',
      '/ws': {
        target: 'ws://localhost:4200',
        ws: true,
      },
    },
  },
})
