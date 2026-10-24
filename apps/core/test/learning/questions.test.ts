import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { leadLabel, question } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { recordLabel } from '../../src/learning/labels'
import { answerQuestion, askWhy } from '../../src/learning/questions'
import type { Notifier } from '../../src/notify/notifier'
import { openTestDb, resetDb } from '../helpers/db'
import { leadWithScore } from '../helpers/learning'

const { db, close } = openTestDb()
afterAll(close)
let sent: string[] = []
let nextId = 500
const notifier: Notifier = {
  sendLeadCard: async () => ({ messageId: nextId++ }),
  sendText: async (t) => {
    sent.push(t)
    return { messageId: nextId++ }
  },
  sendButtons: async (t) => {
    sent.push(t)
    return { messageId: nextId++ }
  },
}
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, 'hance-marketing')
  sent = []
  nextId = 500
})
const NOW = new Date('2026-10-25T09:00:00Z')
const at = (min: number) => new Date(NOW.getTime() + min * 60_000)

describe('questions', () => {
  it('FR-LEAD-7: a surprising skip brings one question with the order title', async () => {
    await leadWithScore(db, '910001', 80)
    expect(
      await askWhy(
        { db, notifier },
        { kind: 'why_skip', entityId: '910001', title: 'Реклама на ТВ' },
        NOW,
      ),
    ).toBe(true)
    expect(sent).toEqual(['Почему пропустил «Реклама на ТВ»? Напиши или скажи голосом.'])
    const [q] = await db.select().from(question)
    expect(q).toMatchObject({ kind: 'why_skip', entityId: '910001', telegramMessageId: 500 })
  })

  it('FR-LEAD-7: no more than 3 questions a day, the 4th surprise is kept without asking', async () => {
    for (const id of ['910011', '910012', '910013', '910014']) {
      await leadWithScore(db, id, 80)
      await recordLabel(db, { leadId: id, label: 'no', source: 'card' })
    }
    const asked = []
    for (const id of ['910011', '910012', '910013', '910014'])
      asked.push(
        await askWhy({ db, notifier }, { kind: 'why_skip', entityId: id, title: 'Т' }, NOW),
      )
    expect(asked).toEqual([true, true, true, false])
    expect(sent).toHaveLength(3)
    expect(
      (await db.select().from(leadLabel).where(eq(leadLabel.leadId, '910014')))[0]?.surprise,
    ).toBe(true)
    // The next Moscow day has its own three.
    expect(
      await askWhy(
        { db, notifier },
        { kind: 'why_skip', entityId: '910014', title: 'Т' },
        at(24 * 60),
      ),
    ).toBe(true)
  })

  it('FR-LEAD-7: two surprises at once after two questions make one more question, not two', async () => {
    for (const id of ['910041', '910042', '910043', '910044']) {
      await leadWithScore(db, id, 80)
      await recordLabel(db, { leadId: id, label: 'no', source: 'card' })
    }
    for (const id of ['910041', '910042'])
      await askWhy({ db, notifier }, { kind: 'why_skip', entityId: id, title: 'Т' }, NOW)
    // Telegram and the database both take a while, so without a lock both surprises count 2 before either
    // question is written or sent.
    const slow: Notifier = {
      ...notifier,
      sendText: async (t) => {
        await new Promise((r) => setTimeout(r, 100))
        return notifier.sendText(t)
      },
    }
    await db.execute(
      sql`create or replace function core.slow_question() returns trigger language plpgsql as $$ begin perform pg_sleep(0.2); return new; end $$`,
    )
    await db.execute(sql`drop trigger if exists slow_question on core.question`)
    await db.execute(
      sql`create trigger slow_question before insert on core.question for each row execute function core.slow_question()`,
    )
    let asked: boolean[]
    try {
      asked = await Promise.all(
        ['910043', '910044'].map((id) =>
          askWhy({ db, notifier: slow }, { kind: 'why_skip', entityId: id, title: 'Т' }, NOW),
        ),
      )
    } finally {
      await db.execute(sql`drop trigger if exists slow_question on core.question`)
    }
    expect(asked.sort()).toEqual([false, true])
    expect(sent).toHaveLength(3)
    expect(await db.select().from(question)).toHaveLength(3)
  })

  it('FR-LEAD-7: a question Telegram did not take does not use up the day', async () => {
    await leadWithScore(db, '910051', 80)
    const failing: Notifier = {
      ...notifier,
      sendText: async () => {
        throw new Error('telegram down')
      },
    }
    for (let i = 0; i < 3; i++)
      await expect(
        askWhy(
          { db, notifier: failing },
          { kind: 'why_skip', entityId: '910051', title: 'Т' },
          NOW,
        ),
      ).rejects.toThrow()
    expect(await db.select().from(question)).toHaveLength(0)
    expect(
      await askWhy({ db, notifier }, { kind: 'why_skip', entityId: '910051', title: 'Т' }, NOW),
    ).toBe(true)
    expect((await db.select().from(question))[0]?.telegramMessageId).toBe(500)
  })

  it('FR-LEAD-7: a question that never reached Boris takes no answer', async () => {
    // What a crash between taking the day's place and sending leaves behind.
    await db.insert(question).values({
      id: newEventId(),
      kind: 'why_skip',
      entityId: '910061',
      telegramMessageId: null,
      askedAt: NOW.toISOString(),
    })
    expect(
      await answerQuestion(db, { text: 'привет', replyToMessageId: null, voice: false, at: at(1) }),
    ).toBeNull()
  })

  it('FR-LEAD-7: a reply to the question is its reason', async () => {
    await leadWithScore(db, '910021', 80)
    await recordLabel(db, { leadId: '910021', label: 'no', source: 'card' })
    await askWhy({ db, notifier }, { kind: 'why_skip', entityId: '910021', title: 'Т' }, NOW)
    const [q] = await db.select().from(question)
    const r = await answerQuestion(db, {
      text: 'бюджет копейки',
      replyToMessageId: q?.telegramMessageId ?? -1,
      voice: true,
      at: at(90),
    })
    expect(r?.question.entityId).toBe('910021')
    const [l] = await db.select().from(leadLabel).where(eq(leadLabel.leadId, '910021'))
    expect(l).toMatchObject({ reason: 'бюджет копейки', voice: true })
  })

  it('FR-LEAD-7: a plain message within 30 minutes answers the latest question; after 30 minutes it answers nothing', async () => {
    await leadWithScore(db, '910031', 80)
    await leadWithScore(db, '910032', 80)
    await recordLabel(db, { leadId: '910031', label: 'no', source: 'card' })
    await recordLabel(db, { leadId: '910032', label: 'no', source: 'card' })
    await askWhy({ db, notifier }, { kind: 'why_skip', entityId: '910031', title: 'Т' }, NOW)
    await askWhy({ db, notifier }, { kind: 'why_skip', entityId: '910032', title: 'Т' }, at(1))
    expect(
      await answerQuestion(db, {
        text: 'поздно',
        replyToMessageId: null,
        voice: false,
        at: at(32),
      }),
    ).toBeNull()
    const r = await answerQuestion(db, {
      text: 'не наш профиль',
      replyToMessageId: null,
      voice: false,
      at: at(30),
    })
    expect(r?.question.entityId).toBe('910032')
    expect(
      (await db.select().from(leadLabel).where(eq(leadLabel.leadId, '910032')))[0]?.reason,
    ).toBe('не наш профиль')
  })
})
