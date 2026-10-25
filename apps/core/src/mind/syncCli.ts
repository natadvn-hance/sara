// pnpm mind:sync [--rebuild]: the mind clone exchanges with GitHub (ADR-025); run at a deploy instead of git pull.
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { createSecretStore } from '../secrets/store'
import { ensureMindIndex } from './indexer'
import { createMindWriter } from './writer'

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
const writer = createMindWriter({
  db,
  mindDir: config.mindDir,
  secrets: createSecretStore(config.dataDir),
  scopes: ['shared', ...config.accounts.map((a) => a.id)],
  reindex: async () => {
    await ensureMindIndex(db, config.mindDir)
  },
})
const r = await writer.sync({ rebuild: process.argv.includes('--rebuild') })
console.log(
  r.error === null
    ? `Разум обменялся с GitHub: подтянуто ${r.pulled}, отправлено ${r.pushed ? 'да' : 'нет'}`
    : `Разум не обменялся с GitHub: ${r.error}`,
)
await close()
if (r.error !== null && r.error !== 'no key') process.exitCode = 1
