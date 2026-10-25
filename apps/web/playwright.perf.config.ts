import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// NFR-PERF-2 is measured on the production build, not on the dev server: the same core and stand-ins as the e2e
// tests, and `vite preview` (it proxies /api like the dev server) in place of `vite`.
const servers = Array.isArray(base.webServer) ? base.webServer : []

export default defineConfig({
  ...base,
  testDir: 'e2e-perf',
  testMatch: '**/*.perf.ts',
  webServer: servers.map((s) =>
    s.url === 'http://127.0.0.1:5174'
      ? {
          ...s,
          command:
            'pnpm exec vite build && pnpm exec vite preview --port 5174 --strictPort --host 127.0.0.1',
        }
      : s,
  ),
})
