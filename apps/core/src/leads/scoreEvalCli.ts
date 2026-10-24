// pnpm --filter @sara/core score:eval <leads.json> <out.jsonl>: the Scorer with the active rules (as in the
// pipeline, sonnet when borderline) over old Sara's leads, then how it compares with her decisions (Task 9).
// Resumable: leads already in out.jsonl are skipped. Runs where the Claude token is, inside the core container.
import { appendFile, readFile } from 'node:fs/promises'
import { ProfiOrder } from '@sara/shared'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { RULES_V1 } from '../direction/v1'
import { createGateway } from '../gateway/gateway'
import { createSecretStore } from '../secrets/store'
import { type EvalRow, summarizeEval } from './scoreEval'
import { scoreOrder } from './scorer'

type OldLead = {
  id: string
  category: string | null
  description: string | null
  budget: string | null
  city: string | null
  decision: 'respond' | 'skip' | null
  sets: string[]
}

const [inArg, outArg] = process.argv.slice(2)
if (!inArg || !outArg) throw new Error('Нужно: score:eval <leads.json> <out.jsonl>')
const inPath: string = inArg
const outPath: string = outArg
const { leads } = JSON.parse(await readFile(inPath, 'utf8')) as { leads: OldLead[] }
const done = new Map<string, EvalRow>()
try {
  for (const l of (await readFile(outPath, 'utf8')).trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(l) as EvalRow
    done.set(r.id, r)
  }
} catch {}

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
const gateway = createGateway({
  db,
  secrets: createSecretStore(config.dataDir),
  claudeBin: config.claudeBin,
  rolesDir: config.rolesDir,
  dataDir: config.dataDir,
  concurrency: 3,
})
const queue = leads.filter((l) => !done.has(l.id))
let n = 0
async function worker() {
  for (let l = queue.shift(); l; l = queue.shift()) {
    const order = ProfiOrder.parse({
      order_id: l.id,
      title: l.category ?? '',
      category: l.category ?? '',
      city: l.city ?? '',
      text: l.description ?? '',
      client_name: '',
      budget_text: l.budget,
      bid_price_rub: 0,
      seen_at: new Date().toISOString(),
    })
    const s = await scoreOrder(gateway, order, RULES_V1)
    const row: EvalRow & { score: number | null; stop: string | null; reason: string | null } = {
      id: l.id,
      sets: l.sets,
      oldDecision: l.decision,
      decision: s?.decision ?? null,
      score: s?.score ?? null,
      stop: s?.stopFactor ?? null,
      reason: s?.reason ?? null,
    }
    done.set(l.id, row)
    await appendFile(outPath, `${JSON.stringify(row)}\n`)
    if (++n % 20 === 0) console.log(`${n} готово`)
  }
}
await Promise.all([worker(), worker(), worker()])
await close()
console.log(JSON.stringify(summarizeEval([...done.values()]), null, 2))
console.log('END')
