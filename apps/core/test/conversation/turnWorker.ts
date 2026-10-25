// Test helper process: launches DBOS with a turn's dependencies; with START it also hears the client, which starts
// a turn. The card writes a line to CARD_LOG; with HANG_CARD it writes «hung» and never finishes.

import { appendFile, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { createConversationEvents } from '../../src/conversation/events'
import { pokeTurn, setTurnDeps, startTurnFor } from '../../src/conversation/turn'
import { createGateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'
import { launchDbos } from '../../src/workflows/dbos'
import { chatMsg, fakeMind, interlocutorAnswer, stubProfi } from '../helpers/conversation'
import { openTestDb, testDatabaseUrl } from '../helpers/db'

const ROOT = resolve(import.meta.dirname, '../../../..')
const [chatId = '', clientAt = ''] = process.argv.slice(2)
const ACC = 'hance-marketing'
const cardLog = process.env.CARD_LOG ?? ''
const { db } = openTestDb()
const old = new Date(Date.parse(clientAt) - 3600_000).toISOString()
const profi = stubProfi([
  chatMsg('m-1', 'specialist', 'Анна, добрый день! Понимаю задачу.', old, chatId),
  chatMsg('m-2', 'client', 'Как начнём?', clientAt, chatId),
])

const dir = await mkdtemp(join(tmpdir(), 'turn-worker-'))
await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
for (const [name, model] of [
  ['interlocutor', 'sonnet'],
  ['checker', 'haiku'],
] as const) {
  await mkdir(join(dir, 'roles', name), { recursive: true })
  await writeFile(
    join(dir, 'roles', name, 'meta.json'),
    JSON.stringify({ name, version: 1, model, priority: 'P0', timeoutMs: 30000 }),
  )
  await writeFile(join(dir, 'roles', name, 'role.md'), 'Роль для теста.')
}
const secrets = createSecretStore(join(dir, 'data'))
await secrets.set('claude_oauth_token', 'tok')

setTurnDeps({
  db,
  profi,
  gateway: createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: {
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ interlocutor: interlocutorAnswer() }),
    },
  }),
  mind: fakeMind(),
  card: async (turnId) => {
    if (process.env.HANG_CARD === '1') {
      await appendFile(cardLog, `hung ${turnId}\n`)
      await new Promise(() => {})
    }
    await appendFile(cardLog, `card ${turnId}\n`)
  },
  forward: async () => {},
  send: async () => 'failed',
  pauseMs: () => 200,
})
await launchDbos(testDatabaseUrl())

if (process.env.START === '1') {
  const events = createConversationEvents({
    db,
    profi,
    notifier: { sendText: async () => ({ messageId: 1 }) },
    onTurnNeeded: (c) => startTurnFor(c),
    onTyping: (c) => pokeTurn(c),
    onSpecialist: async () => {},
  })
  await events({
    id: newEventId(),
    type: 'profi.client_message',
    v: 1,
    entity: { kind: 'chat', id: chatId },
    account_id: ACC,
    actor: 'profi',
    occurred_at: clientAt,
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: {
      chat_id: chatId,
      order_id: chatId,
      platform_message_id: 'm-2',
      sent_at: clientAt,
      author: 'client',
    },
  })
}
console.log('started')
