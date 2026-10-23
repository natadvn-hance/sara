import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EventEnvelope, newEventId } from '@sara/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const { db, close } = openTestDb()
let tg: FakeTelegram
let app: RunningApp

beforeAll(async () => {
  tg = await createFakeTelegram()
  app = await startApp({
    ...loadConfig({}),
    databaseUrl: testDatabaseUrl(),
    dataDir: await mkdtemp(join(tmpdir(), 'session-')),
    port: 0,
    nodeToken: 'node-tok',
    telegramApiRoot: tg.apiRoot,
    publicUrl: 'https://sara.example',
  })
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)
afterAll(async () => {
  await app.close()
  await tg.close()
  await close()
})
beforeEach(async () => {
  await resetDb(db)
  tg.sent.length = 0
  tg.pushStart(111)
  const end = Date.now() + 5000
  while (tg.sent.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  tg.sent.length = 0
})

const ev = (type: EventEnvelope['type']): EventEnvelope => ({
  id: newEventId(),
  type,
  v: 1,
  entity: { kind: 'account', id: 'hance-marketing' },
  account_id: 'hance-marketing',
  actor: 'profi',
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason: null,
  payload: {},
})
const deliver = (e: EventEnvelope) =>
  fetch(`${app.url}/internal/profi/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sara-node-token': 'node-tok' },
    body: JSON.stringify(e),
  })

describe('session alarms end to end', () => {
  it('FR-OPS-2: a logout delivered twice gives one alarm in Telegram', async () => {
    const e = ev('profi.session_dead')
    await deliver(e)
    await deliver(e)
    const end = Date.now() + 5000
    while (tg.sent.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 500))
    expect(tg.sent.filter((m) => m.text.startsWith('🔴'))).toHaveLength(1)
  }, 20000)
})
