// pnpm history:export [--v1 <copy of profi-leads.db>] [--telegram <result.json>] [--account <id>]: copies the
// chat history into core.chat_message with authors told apart and proposes Boris's messages as speech examples
// (FR-TRAIN-1, M4 design 5.1). Runs on the server in the core container: node --import tsx src/history/exportCli.ts.
import { plural } from '@sara/shared'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { getSetting } from '../settings/store'
import { exportHistory, formatExportReport } from './exportHistory'
import { proposeSpeechExamples } from './speechProposals'
import { readTelegramV1Texts } from './telegramExport'
import { readV1Snapshot } from './v1Snapshot'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

const config = loadConfig()
const accountId = arg('--account') ?? config.accounts[0]?.id
if (!accountId) throw new Error('Не знаю аккаунт: укажи --account или SARA_ACCOUNTS.')
const v1Path = arg('--v1')
const telegramPath = arg('--telegram')
const v1 = v1Path ? readV1Snapshot(v1Path) : null
const telegramV1Texts = telegramPath ? readTelegramV1Texts(telegramPath) : new Set<string>()
if (!v1) console.log('Без снимка v1: беру только чаты, которые прочитала служба.')

const { db, close } = createDb(config.databaseUrl)
try {
  const report = await exportHistory(db, {
    accountId,
    v1,
    telegramV1Texts,
    v1Writes: await getSetting(db, 'conv.v1_writes'),
  })
  console.log(formatExportReport(report))
  const clientNames = new Map<string, string>()
  for (const l of v1?.leads ?? []) if (l.clientName) clientNames.set(l.orderId, l.clientName)
  const s = await proposeSpeechExamples(db, { accountId, clientNames })
  const forms = ['новое предложение', 'новых предложения', 'новых предложений'] as const
  console.log(
    `Образцы речи: ${s.proposed} ${plural(s.proposed, forms)} в разум, пропущено ${s.skipped} (короткие или уже предложены).`,
  )
} finally {
  await close()
}
