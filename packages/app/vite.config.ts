import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5730,
    proxy: {
      '/api': 'http://localhost:4200',
      '/ws': {
        target: 'ws://localhost:4200',
        ws: true,
      },
    },
  },
})
