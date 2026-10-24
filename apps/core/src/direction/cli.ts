// pnpm direction:show and pnpm direction:rollback <version>: see the rules versions, go back to one (FR-MIND-3).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { activeRules, listVersions, rollbackTo } from './store'

const msk = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    dateStyle: 'short',
    timeStyle: 'short',
  })

const [what, arg] = process.argv.slice(2)
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
    const active = await activeRules(db, a.id)
    console.log(`${a.id}: действуют правила v${active.version}, порог ${active.rules.threshold}`)
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
