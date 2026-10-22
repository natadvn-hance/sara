// pnpm probe:claude: one probe call through the gateway; prints "ok за N мс" or the error class.
import { ProbeOutput } from '@sara/shared'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { createSecretStore } from '../secrets/store'
import { createGateway } from './gateway'

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
const secrets = createSecretStore(config.dataDir)
if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
  await secrets.set('claude_oauth_token', process.env.CLAUDE_CODE_OAUTH_TOKEN)
const gw = createGateway({
  db,
  secrets,
  claudeBin: config.claudeBin,
  rolesDir: config.rolesDir,
  dataDir: config.dataDir,
})
const r = await gw.call('probe', 'Проверка связи.', ProbeOutput)
await close()
if (r.ok) {
  console.log(`ok за ${r.durationMs} мс`)
} else {
  console.log(`ошибка: ${r.errorClass} (${r.message})`)
  process.exit(1)
}
