// Manual check of the Sorter on the real `claude -p` (never in CI): pnpm role:eval sorter
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProfiOrder } from '@sara/shared'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { sortOrder } from '../leads/sorter'
import { createSecretStore } from '../secrets/store'
import { createGateway } from './gateway'

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
const gw = createGateway({
  db,
  secrets: createSecretStore(config.dataDir),
  claudeBin: config.claudeBin,
  rolesDir: config.rolesDir,
  dataDir: config.dataDir,
})
const ordersDir = join(config.rolesDir, '../tests/fixtures/orders')
const samples: { order: string; expected: string }[] = JSON.parse(
  await readFile(join(config.rolesDir, 'sorter/evals/samples.json'), 'utf8'),
)
let hits = 0
for (const s of samples) {
  const order = ProfiOrder.parse(JSON.parse(await readFile(join(ordersDir, s.order), 'utf8')))
  const r = await sortOrder(gw, order)
  const got = r.ok ? r.output.verdict : `ошибка ${r.errorClass}`
  if (got === s.expected) hits++
  console.log(`${s.order}: ждали ${s.expected}, получили ${got}`)
}
console.log(`Совпадение: ${hits} из ${samples.length}`)
await close()
