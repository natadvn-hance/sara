// pnpm report:speed: G1 and G2 from the journal.
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { speedReport } from './speed'

const { db, close } = createDb(loadConfig().databaseUrl)
const r = await speedReport(db)
await close()
const sec = (ms: number | null) => (ms === null ? 'нет данных' : `${(ms / 1000).toFixed(1)} с`)
console.log(`Заявка → карточка: ${r.leadToCard.count} шт., 90% быстрее ${sec(r.leadToCard.p90Ms)}`)
console.log(`«Да» → отклик: ${r.yesToBid.count} шт., 95% быстрее ${sec(r.yesToBid.p95Ms)}`)
