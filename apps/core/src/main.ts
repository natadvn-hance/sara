import { startApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
// Only for browser tests with the fake Claude CLI: extra environment for it, never in production.
const testClaudeEnv =
  !config.production && process.env.SARA_TEST_CLAUDE_ENV
    ? JSON.parse(process.env.SARA_TEST_CLAUDE_ENV)
    : undefined
const running = await startApp(config, {
  claudeEnv: testClaudeEnv ? () => testClaudeEnv : undefined,
})
console.log(`Ядро Сары: ${running.url}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0))
  })
}
