import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'profi-node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false,
  },
})
