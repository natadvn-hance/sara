// pnpm bids:on | pnpm bids:off: switch sending bids (outbound.bids) until the settings screen exists (M7).
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { setSetting } from './store'

const value = process.argv[2] === 'on'
const { db, close } = createDb(loadConfig().databaseUrl)
await setSetting(db, 'outbound.bids', value, 'boris')
await close()
console.log(value ? 'Отправка откликов включена' : 'Отправка откликов выключена')
