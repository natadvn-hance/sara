// pnpm report:school [--days N]: what the school spent and did (M5 design 5.12).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { schoolReport } from './report'

const i = process.argv.indexOf('--days')
const days = i > 0 ? Math.max(1, Math.trunc(Number(process.argv[i + 1])) || 7) : 7
const { db, close } = createDb(loadConfig().databaseUrl)
console.log(await schoolReport(db, days))
await close()
