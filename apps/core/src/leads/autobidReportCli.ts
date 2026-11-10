// pnpm --filter @sara/core report:autobid [days] [history days]: how the shadow of the auto-bid agreed with Boris over
// the last days (7 by default), and the rule over his decisions of the last history days (30 by default; 0: none).
// Read only; prints numbers, never the client's words. Runs where the database is, inside the core container.
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { historyReport, loadShadows, reportText, weekReport } from './autobidReport'
import { autobidRule } from './autobidShadow'

const days = Number(process.argv[2] ?? 7)
const back = Number(process.argv[3] ?? 30)
if (!Number.isInteger(days) || days <= 0 || !Number.isInteger(back) || back < 0)
  throw new Error('Нужно: report:autobid [дней] [дней истории]')
const { db, close } = createDb(loadConfig().databaseUrl)
try {
  const rule = await autobidRule(db)
  const week = weekReport(await loadShadows(db, days), days)
  const history = back > 0 ? await historyReport(db, 'hance-marketing', rule, back) : null
  console.log(reportText(week, history, rule))
} finally {
  await close()
}
