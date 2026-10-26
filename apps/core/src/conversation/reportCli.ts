// pnpm report:conv [--days 7]: what Sara's conversation turns did in shadow (M4 design 5.12, FR-OPS-4).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { convReport } from './report'

const daysArg = process.argv.indexOf('--days')
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 7
const { db, close } = createDb(loadConfig().databaseUrl)
console.log(await convReport(db, days))
await close()
