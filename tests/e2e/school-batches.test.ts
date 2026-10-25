import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createFakeProfi, type FakeProfi } from '@sara/profi-node/fake'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type RunningApp, startApp } from '../../apps/core/src/app'
import { loadConfig } from '../../apps/core/src/config'
import { lesson } from '../../apps/core/src/db/schema'
import { createMindWriter } from '../../apps/core/src/mind/writer'
import { batchesStep } from '../../apps/core/src/school/lessons/batches'
import { exampleChange } from '../../apps/core/src/school/lessons/records'
import { createLesson } from '../../apps/core/src/school/lessons/store'
import { setSetting } from '../../apps/core/src/settings/store'
import { openTestDb, resetDb, testDatabaseUrl } from '../../apps/core/test/helpers/db'
import { createFakeTelegram, type FakeTelegram } from '../fakes/telegramApi'

const ROOT = resolve(import.meta.dirname, '../..')

async function until(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition not met in time')
}
const { db, close } = openTestDb()
let tg: FakeTelegram
let fake: FakeProfi
let app: RunningApp

beforeAll(async () => {
  tg = await createFakeTelegram()
  fake = await createFakeProfi({
    port: 0,
    coreEventsUrl: 'http://127.0.0.1:1',
    nodeToken: 'node-tok',
    permitSecret: 'permit',
  })
  app = await startApp(
    {
      ...loadConfig({}),
      databaseUrl: testDatabaseUrl(),
      dataDir: await mkdtemp(join(tmpdir(), 'e2e-school-')),
      port: 0,
      profiMcpUrl: fake.url,
      nodeToken: 'node-tok',
      permitSecret: 'permit',
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      telegramApiRoot: tg.apiRoot,
    },
    { learningTickMs: 3_600_000, schoolTickMs: 3_600_000 },
  )
  await app.secrets.set('telegram_bot_token', tg.token)
  await app.bot.start(tg.token)
}, 60000)

afterAll(async () => {
  await app.close()
  await fake.close()
  await tg.close()
  await close()
})

beforeEach(async () => {
  await resetDb(db)
  tg.sent.length = 0
  tg.pushStart(111)
  await until(() => tg.sent.length === 1)
  await setSetting(db, 'school.on', true, 'boris')
})

describe('lesson batches through the bot', () => {
  it('FR-TRAIN-6: a press on a lesson in Telegram goes to the school, not the lead pipeline', async () => {
    for (let i = 0; i < 5; i++)
      await createLesson(db, {
        source: 'edit',
        sourceRef: `conv-turn:${i}`,
        scope: 'shared',
        topic: 'price',
        tone: 'doubt',
        questionType: null,
        clientText: 'Сколько стоит?',
        before: 'От 50 000',
        after: 'Цену скажу после созвона',
        insight: 'Цену не называть до созвона',
        kind: 'procedure',
        state: 'ready',
        inPlace: false,
        sim: false,
        modelCallId: null,
        changes: [
          exampleChange({
            scope: 'shared',
            topic: 'price',
            tone: 'doubt',
            stage: null,
            clientText: 'Сколько стоит?',
            borisText: 'Цену скажу после созвона',
            insight: 'Цену не называть до созвона',
            source: `edit:conv-turn:${i}`,
            names: [],
          }),
        ],
      })
    const writer = createMindWriter({ db, mindDir: '/nowhere', reindex: async () => {} })
    await batchesStep(
      { db, notifier: app.bot.notifier, writer },
      new Date('2026-10-26T11:00:00+03:00'),
    )
    const batch = tg.sent.find((m) => m.text.startsWith('📚 Уроки из работы: 5'))
    const first = batch?.reply_markup?.inline_keyboard[0]?.[0]
    expect(first?.text).toBe('1: да')
    tg.pushPress(111, first?.callback_data ?? '')
    await until(
      async () => (await db.select().from(lesson).where(eq(lesson.state, 'yes'))).length === 1,
    )
    await until(() => tg.answers.some((a) => a.text === 'Отметила'))
  })
})
