// pnpm report:speed: G1 and G2 from the journal.
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { type Stat, speedReport } from './speed'

const { db, close } = createDb(loadConfig().databaseUrl)
const r = await speedReport(db)
await close()
const sec = (ms: number | null) => (ms === null ? 'нет данных' : `${(ms / 1000).toFixed(1)} с`)
const line = (name: string, s: Stat) =>
  `${name}: ${s.count} шт., половина быстрее ${sec(s.p50Ms)}, 90% быстрее ${sec(s.p90Ms)}, 95% быстрее ${sec(s.p95Ms)}`
console.log(line('Заявка → карточка', r.leadToCard))
console.log(line('«Да» → отклик (от нажатия до отправки)', r.yesToBid))
