import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The pult and the voice app (ADR-028): two pages, each with its own manifest for the Home Screen.
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        talk: resolve(import.meta.dirname, 'talk.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.SARA_CORE_URL ?? 'http://127.0.0.1:3300', ws: true } },
  },
})
