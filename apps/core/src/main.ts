import { startApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const running = await startApp(config)
console.log(`Ядро Сары: ${running.url}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0))
  })
}
