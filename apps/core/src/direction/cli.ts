// pnpm direction:show and pnpm direction:rollback <version>: see the rules versions, go back to one (FR-MIND-3).
// pnpm direction thresholds <marketing> <sites> <other> [account]: a new version with the thresholds by kind (the
// first values of 3.11 are 40 / 55 / 50; Boris changes them later from the settings).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { setThresholds, thresholdsOf } from '../pult/threshold'
import { activeRules, listVersions, rollbackTo } from './store'

const msk = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  })

const [what, arg, arg2, arg3, only] = process.argv.slice(2)
const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
try {
  for (const a of config.accounts) {
    if (what === 'rollback') {
      const v = Number(arg)
      if (!Number.isInteger(v) || v < 1)
        throw new Error('Укажи номер версии: pnpm direction:rollback 1')
      console.log(`${a.id}: правила v${v} снова действуют как v${await rollbackTo(db, a.id, v)}`)
      continue
    }
    if (what === 'thresholds') {
      if (only && only !== a.id) continue
      const marketing = Number(arg)
      const sites = Number(arg2)
      const other = Number(arg3)
      if (![marketing, sites, other].every((n) => Number.isInteger(n) && n >= 0 && n <= 100))
        throw new Error('Укажи три порога: pnpm direction thresholds 40 55 50')
      const cur = await activeRules(db, a.id)
      const r = await setThresholds(db, a.id, { marketing, sites, other }, cur.version)
      console.log(`${a.id}: ${r.message}`)
      continue
    }
    const active = await activeRules(db, a.id)
    const by = thresholdsOf(active.rules)
    console.log(
      `${a.id}: действуют правила v${active.version}, порог ${active.rules.threshold} (маркетинг ${by.marketing}, сайты ${by.sites}, остальное ${by.other})`,
    )
    for (const r of await listVersions(db, a.id)) {
      const who = r.createdBy === 'boris' ? 'Борис' : 'при запуске'
      console.log(
        `  v${r.version}${r.active ? ' (действует)' : ''}, ${msk(r.createdAt)}, ${who}: ${r.reason}`,
      )
    }
  }
} finally {
  await close()
}
