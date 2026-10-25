// pnpm report:shadow [--hours 48 | --from ISO [--to ISO]] [--send]: the shadow report (ST-M1-11); --send also sends it to
// Boris in Telegram.
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { boundChat } from '../notify/binding'
import { createSecretStore } from '../secrets/store'
import { formatShadowReport, shadowReport, shadowWindow } from './shadow'

const { from, to } = shadowWindow(process.argv.slice(2), new Date())

const config = loadConfig()
const { db, close } = createDb(config.databaseUrl)
const text = formatShadowReport(await shadowReport(db, from, to), from, to)
console.log(text)

if (process.argv.includes('--send')) {
  const token = await createSecretStore(config.dataDir).get('telegram_bot_token')
  const chat = await boundChat(db)
  if (!token || chat === null) {
    console.log('Не отправлено: бот не подключён или чат не привязан.')
  } else {
    const root = config.telegramApiRoot ?? 'https://api.telegram.org'
    const res = await fetch(`${root}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    })
    console.log(res.ok ? 'Отправлено Борису.' : `Telegram ответил ${res.status}.`)
  }
}
await close()
