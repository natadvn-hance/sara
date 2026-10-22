import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/core', 'apps/profi-node', 'scripts', 'tests'],
  },
})
