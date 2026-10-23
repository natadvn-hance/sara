import { loadNodeConfig } from './config'
import { startProfiService } from './service'

const config = loadNodeConfig()
const svc = await startProfiService(config)
console.log(`Служба Профи-MCP: ${svc.url}, аккаунтов ${config.accounts.length}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A clean close flushes the browser profiles (lesson of v1, 17.09.2026).
    void svc.close().then(() => process.exit(0))
  })
}
