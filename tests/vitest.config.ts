import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'e2e',
    include: ['e2e/**/*.test.ts', 'fakes/**/*.test.ts'],
    globalSetup: ['globalSetup.ts'],
    env: { SARA_TEST_DB: 'sara_e2e' },
    fileParallelism: false,
    passWithNoTests: true,
  },
})
