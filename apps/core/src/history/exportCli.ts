// pnpm history:export [--v1 <copy of profi-leads.db>] [--telegram <result.json>] [--account <id>]: copies the
// chat history into core.chat_message with authors told apart and proposes Boris's messages as speech examples
// (FR-TRAIN-1, M4 design 5.1). Runs on the server in the core container: node --import tsx src/history/exportCli.ts.
import { plural } from '@sara/shared'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { getSetting } from '../settings/store'
import { parseExportArgs } from './exportArgs'
import { exportHistory, formatExportReport, v1StoppedAt } from './exportHistory'
import { proposeSpeechExamples } from './speechProposals'
import { readTelegramExport } from './telegramExport'
import { readV1Snapshot } from './v1Snapshot'

let args: ReturnType<typeof parseExportArgs>
try {
  args = parseExportArgs(process.argv.slice(2))
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
const config = loadConfig()
const accountId = args.account ?? config.accounts[0]?.id
if (!accountId) {
  console.error('Не знаю аккаунт: укажи --account или SARA_ACCOUNTS.')
  process.exit(1)
}
const v1 = args.v1 ? readV1Snapshot(args.v1) : null
const telegram = args.telegram
  ? readTelegramExport(args.telegram)
  : { v1Texts: new Set<string>(), borisTexts: new Set<string>() }
if (!v1) console.log('Без снимка v1: беру только чаты, которые прочитала служба.')

const { db, close } = createDb(config.databaseUrl)
try {
  const report = await exportHistory(db, {
    accountId,
    v1,
    telegramV1Texts: telegram.v1Texts,
    telegramBorisTexts: telegram.borisTexts,
    v1Writes: await getSetting(db, 'conv.v1_writes'),
    v1StoppedAt: await v1StoppedAt(db),
  })
  console.log(formatExportReport(report))
  const clientNames = new Map<string, string>()
  for (const l of v1?.leads ?? []) if (l.clientName) clientNames.set(l.orderId, l.clientName)
  const s = await proposeSpeechExamples(db, { accountId, clientNames })
  const forms = ['новое предложение', 'новых предложения', 'новых предложений'] as const
  console.log(
    `Образцы речи: ${s.proposed} ${plural(s.proposed, forms)} в разум, пропущено ${s.skipped} (короткие, уже предложены или без известного имени клиента).`,
  )
} finally {
  await close()
}
