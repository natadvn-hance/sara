// pnpm bids:on|off and pnpm leads:on|off: switch sending bids (outbound.bids) and lead cards
// (pipeline.leads) until the settings screen exists (M7).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { setSetting } from './store'

const TEXT = {
  'outbound.bids': ['Отправка откликов выключена', 'Отправка откликов включена'],
  'pipeline.leads': ['Карточки заявок выключены (тень)', 'Карточки заявок включены'],
} as const

const [what, state] = process.argv.slice(2)
const key = what === 'leads' ? 'pipeline.leads' : 'outbound.bids'
const value = state === 'on'
const { db, close } = createDb(loadConfig().databaseUrl)
await setSetting(db, key, value, 'boris')
await close()
console.log(TEXT[key][value ? 1 : 0])
