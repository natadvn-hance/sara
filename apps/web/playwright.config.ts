import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import { ABOUT, IDEAL, STOPS } from '../core/test/helpers/onboarding'
import { scorerAnswer } from '../core/test/helpers/scorer'
import { dbUrl } from './e2e/dbUrl'
import { BASE, HOST, PORTS, URLS } from './e2e/ports'

const ROOT = resolve(import.meta.dirname, '../..')
const DB = dbUrl('sara_web')
// Every server gets its port from e2e/ports.ts. The base goes to each one too, so the fakes and the specs count the same.
const PORT_ENV = { E2E_PORT_BASE: String(BASE) }

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: URLS.web },
  webServer: [
    {
      command: `pnpm exec tsx ${ROOT}/tests/fakes/telegramApi.main.ts`,
      url: `${URLS.telegramControl}/health`,
      reuseExistingServer: false,
      env: {
        ...PORT_ENV,
        FAKE_TELEGRAM_PORT: String(PORTS.telegramApi),
        FAKE_TELEGRAM_CONTROL_PORT: String(PORTS.telegramControl),
      },
    },
    {
      command: 'pnpm exec tsx e2e/standInProfi.ts',
      url: `${URLS.standControl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: PORT_ENV,
    },
    {
      command: `pnpm exec tsx e2e/prepareDb.ts && pnpm --filter @sara/core exec tsx src/main.ts`,
      url: `${URLS.core}/api/setup`,
      reuseExistingServer: false,
      env: {
        ...PORT_ENV,
        DATABASE_URL: DB,
        SARA_PORT: String(PORTS.core),
        SARA_DATA_DIR: `${ROOT}/.sara/web-e2e`,
        SARA_TELEGRAM_API_ROOT: URLS.telegramApi,
        SARA_PROFI_MCP_URL: URLS.profiMcp,
        SARA_CLAUDE_BIN: `${ROOT}/tests/fakes/fake-claude.mjs`,
        SARA_TEST_CLAUDE_ENV: JSON.stringify({
          FAKE_CLAUDE_MODE: 'ok',
          FAKE_CLAUDE_OUTPUT: '{"ok":true}',
          // Each onboarding role answers the same way every time; the panel tests read those answers.
          FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
            'onboarding-about': ABOUT,
            'onboarding-stops': STOPS,
            'onboarding-ideal': IDEAL,
            // The scorer answers the same for every lead, so a real run finds no change: changes are stubbed.
            scorer: scorerAnswer(70),
          }),
        }),
      },
    },
    {
      command: `pnpm exec vite --port ${PORTS.web} --strictPort --host ${HOST}`,
      url: URLS.web,
      reuseExistingServer: false,
      env: { ...PORT_ENV, SARA_CORE_URL: URLS.core },
    },
  ],
})
