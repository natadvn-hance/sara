// Test helper process: launches DBOS with the reminder dependencies over a chat of one message of ours (m-1). With
// START it starts the reminder process of it; with CANCEL it cancels what waits and leaves. The service stub writes
// «send <key>» to SEND_LOG when it is asked to send; with HANG_SEND it writes «hung <key>» and never answers.

import { appendFile, cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cancelReminders, setRemindDeps, startReminder } from '../../src/conversation/reminders'
import { createGateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'
import { launchDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, stubProfi } from '../helpers/conversation'
import { openTestDb, testDatabaseUrl } from '../helpers/db'

const ROOT = resolve(import.meta.dirname, '../../../..')
const [conversationId = '', chatId = '', ourAt = ''] = process.argv.slice(2)
const sendLog = process.env.SEND_LOG ?? ''
const { db } = openTestDb()
const profi = stubProfi([
  {
    ...chatMsg('m-1', 'specialist', 'Анна, добрый день! Понимаю задачу.', ourAt, chatId),
    read: false,
  },
])
profi.sendMessage = async (i) => {
  if (process.env.HANG_SEND === '1') {
    await appendFile(sendLog, `hung ${i.idempotency_key}\n`)
    await new Promise(() => {})
  }
  await appendFile(sendLog, `send ${i.idempotency_key}\n`)
  return { found_on_page: true, platform_message_id: 's-1' }
}

const dir = await mkdtemp(join(tmpdir(), 'remind-worker-'))
await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
const secrets = createSecretStore(join(dir, 'data'))
await secrets.set('claude_oauth_token', 'tok')

setRemindDeps({
  db,
  profi,
  gateway: createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: {
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({
        pinger: {
          text: '[имя 1], здравствуйте! Как у вас дела с сайтом для клиники?',
          fact_ids: ['s-portrait', 'k-process-start'],
        },
      }),
    },
  }),
  mind: fakeMind(),
  notifier: { sendButtons: async () => ({ messageId: 1 }) },
  fallbackAfterMs: 5000,
  retryEveryMs: 500,
})
await launchDbos(testDatabaseUrl())

if (process.env.CANCEL === '1') {
  await cancelReminders(conversationId)
  console.log('cancelled')
  process.exit(0)
}
if (process.env.START === '1') await startReminder(conversationId, 'm-1')
console.log('started')
