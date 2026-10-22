import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '../..')
const DB = 'postgres://sara:sara@localhost:54329/sara_web'

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174' },
  webServer: [
    {
      command: `pnpm exec tsx ${ROOT}/tests/fakes/telegramApi.main.ts`,
      url: 'http://127.0.0.1:18082/_control/health',
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec tsx e2e/prepareDb.ts && pnpm --filter @sara/core exec tsx src/main.ts`,
      url: 'http://127.0.0.1:3100/api/setup',
      reuseExistingServer: false,
      env: {
        DATABASE_URL: DB,
        SARA_PORT: '3100',
        SARA_DATA_DIR: `${ROOT}/.sara/web-e2e`,
        SARA_TELEGRAM_API_ROOT: 'http://127.0.0.1:18081',
        SARA_CLAUDE_BIN: `${ROOT}/tests/fakes/fake-claude.mjs`,
        SARA_TEST_CLAUDE_ENV: JSON.stringify({
          FAKE_CLAUDE_MODE: 'ok',
          FAKE_CLAUDE_OUTPUT: '{"ok":true}',
        }),
      },
    },
    {
      command: 'pnpm exec vite --port 5174 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      env: { SARA_CORE_URL: 'http://127.0.0.1:3100' },
    },
  ],
})
