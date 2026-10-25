import { newEventId } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { leadLabel, question, task } from '../../src/db/schema'
import { seedDirection } from '../../src/direction/store'
import { recordLabel } from '../../src/learning/labels'
import { answerQuestion, askForDraft, askWhy, openQuestion } from '../../src/learning/questions'
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

  it('FR-LEAD-7: a request for a new bid text never takes a place of the 3 daily «почему?»', async () => {
    await askForDraft({ db, notifier }, { taskId: newEventId(), title: 'Сайт' }, NOW)
    await askForDraft({ db, notifier }, { taskId: newEventId(), title: 'Сайт' }, NOW)
    expect(sent).toEqual([
      'Пришли новый текст отклика на «Сайт» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама.',
      'Пришли новый текст отклика на «Сайт» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама.',
    ])
    const asked = []
    for (const id of ['910051', '910052', '910053', '910054']) {
      await leadWithScore(db, id, 80)
      asked.push(
        await askWhy({ db, notifier }, { kind: 'why_skip', entityId: id, title: 'Т' }, NOW),
      )
    }
    expect(asked).toEqual([true, true, true, false])
    expect(await db.select().from(question).where(eq(question.kind, 'edit_draft'))).toHaveLength(2)
  })

  it('FR-LEAD-7: a request for a new bid text Telegram did not take leaves no question', async () => {
    const broken: Notifier = {
      ...notifier,
      sendText: async () => {
        throw new Error('telegram down')
      },
    }
    await expect(
      askForDraft({ db, notifier: broken }, { taskId: newEventId(), title: 'Сайт' }, NOW),
    ).rejects.toThrow('telegram down')
    expect(await db.select().from(question)).toHaveLength(0)
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

describe('which question a message without a reply answers', () => {
  const askEdit = async (leadId: string, min = 0) => {
    const taskId = await leadWithScore(db, leadId, 80)
    await askForDraft({ db, notifier }, { taskId, title: 'Сайт' }, at(min))
    return taskId
  }
  const askSkip = async (leadId: string, min = 0) => {
    await leadWithScore(db, leadId, 80)
    await recordLabel(db, { leadId, label: 'no', source: 'card' })
    await askWhy({ db, notifier }, { kind: 'why_skip', entityId: leadId, title: 'Т' }, at(min))
  }
  const plain = (min: number) => ({ replyToMessageId: null, at: at(min) })

  it('FR-LEAD-7: a text with an edit request and a «почему?» both open belongs to neither: Sara asks which', async () => {
    await askEdit('911001')
    await askSkip('911002', 1)
    const r = await openQuestion(db, plain(2))
    expect(r && 'ambiguous' in r ? r.ambiguous.map((q) => q.kind).sort() : r).toEqual([
      'edit_draft',
      'why_skip',
    ])
    // The same in the other order: the edit request came last.
    await db.delete(question)
    await askSkip('911003')
    await askEdit('911004', 1)
    expect(await openQuestion(db, plain(2))).toHaveProperty('ambiguous')
  })

  it('FR-LEAD-7: a reply goes to the message it answers, whatever else is open', async () => {
    await askEdit('911011')
    await askSkip('911012', 1)
    const [edit, why] = await db.select().from(question).orderBy(question.askedAt)
    expect(
      await openQuestion(db, { replyToMessageId: edit?.telegramMessageId ?? -1, at: at(2) }),
    ).toMatchObject({
      kind: 'edit_draft',
    })
    expect(
      await openQuestion(db, { replyToMessageId: why?.telegramMessageId ?? -1, at: at(2) }),
    ).toMatchObject({
      kind: 'why_skip',
    })
  })

  it('FR-LEAD-7: one edit request alone takes a plain text; so do two requests for the same lead', async () => {
    const taskId = await askEdit('911021')
    expect(await openQuestion(db, plain(2))).toMatchObject({ kind: 'edit_draft', entityId: taskId })
    await askForDraft({ db, notifier }, { taskId, title: 'Сайт' }, at(1))
    const latest = await openQuestion(db, plain(2))
    expect(latest).toMatchObject({ kind: 'edit_draft', entityId: taskId })
    // The newer of the two requests.
    expect(new Date((latest as { askedAt: string }).askedAt).getTime()).toBe(at(1).getTime())
  })

  it('FR-LEAD-7: edit requests of two leads and no reply: Sara asks which', async () => {
    await askEdit('911031')
    await askEdit('911032', 1)
    expect(await openQuestion(db, plain(2))).toHaveProperty('ambiguous')
  })

  it('FR-LEAD-7: an edit request of a lead already decided stands aside for a «почему?»', async () => {
    const taskId = await askEdit('911041')
    await db.update(task).set({ state: 'resolved', resolution: 'skip' }).where(eq(task.id, taskId))
    await askSkip('911042', 1)
    expect(await openQuestion(db, plain(2))).toMatchObject({ kind: 'why_skip', entityId: '911042' })
  })

  it('FR-LEAD-7: «почему?» alone keeps answering the latest, as before', async () => {
    await askSkip('911051')
    await askSkip('911052', 1)
    expect(await openQuestion(db, plain(2))).toMatchObject({ kind: 'why_skip', entityId: '911052' })
  })

  it('FR-LEAD-7: the «почему?» answer API never lands on an edit request', async () => {
    await askEdit('911061')
    expect(
      await answerQuestion(db, { text: 'бюджет', replyToMessageId: null, voice: false, at: at(2) }),
    ).toBeNull()
  })
})
