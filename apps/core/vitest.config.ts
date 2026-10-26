import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
    // The Mac runners share the machine with each other and with development: on CI a slow hook or test gets
    // more time and one retry, so a busy machine does not turn a run red (26.10.2026).
    ...(process.env.CI ? { testTimeout: 30_000, hookTimeout: 30_000, retry: 1 } : {}),
  },
})
