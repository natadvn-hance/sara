import { newEventId, parseCallback } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { jobRun, lesson, lessonBatch, mindProposal, question, task } from '../../../src/db/schema'
import { handleBorisMessage } from '../../../src/learning/inbox'
import type { Notifier } from '../../../src/notify/notifier'
import {
  batchesStep,
  nextBatch,
  onSchoolPress,
  revertPending,
  sendBatch,
  writePending,
} from '../../../src/school/lessons/batches'
import { exampleChange } from '../../../src/school/lessons/records'
import { createLesson, decideLesson } from '../../../src/school/lessons/store'
import { deferredNotices, takeNotice } from '../../../src/school/notices'
import { SCHOOL_TEXTS } from '../../../src/school/texts'
import type { MindWriter } from '../../../src/school/types'
import { setSetting } from '../../../src/settings/store'
import { openTestDb, resetDb } from '../../helpers/db'

const { db, close } = openTestDb()
afterAll(close)

const msk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`)
const DAY1 = '2026-10-26'

type Sent = { id: number; text: string; rows: { text: string; callbackData: string }[][] }
function fakes(
  o: { apply?: MindWriter['apply']; revert?: MindWriter['revert']; refuse?: boolean } = {},
) {
  const sent: Sent[] = []
  const texts: { id: number; text: string }[] = []
  const edits: Sent[] = []
  const applied: string[][] = []
  const reverted: string[] = []
  let next = 100
  const notifier: Notifier = {
    sendLeadCard: async () => ({ messageId: next++ }),
    sendText: async (text) => {
      const id = next++
      texts.push({ id, text })
      return { messageId: id }
    },
    sendButtons: async (text, rows) => {
      if (o.refuse) throw new Error('telegram is down')
      const id = next++
      sent.push({ id, text, rows })
      return { messageId: id }
    },
    editText: async (id, text, rows) => {
      edits.push({ id, text, rows: rows ?? [] })
    },
  }
  const writer: MindWriter = {
    apply: async (ids, why) => {
      applied.push([...ids].sort())
      if (o.apply) return o.apply(ids, why)
      const commitId = newEventId()
      return { ok: true, commitId, sha: 'abc', mindVersion: 'v2', written: ids, refused: [] }
    },
    revert: async (id) => {
      reverted.push(id)
      if (o.revert) return o.revert(id)
      return { ok: true, commitId: newEventId() }
    },
    sync: async () => ({ pushed: false, pulled: 0, error: null }),
  }
  return { d: { db, notifier, writer }, sent, texts, edits, applied, reverted }
}

async function lessons(n: number, from = 0): Promise<string[]> {
  const ids: string[] = []
  for (let i = from; i < from + n; i++) {
    const l = await createLesson(db, {
      source: 'edit',
      sourceRef: `conv-turn:${i}`,
      scope: 'shared',
      topic: 'timeline',
      tone: 'hurry',
      questionType: null,
      clientText: `Когда начнёте? (${i})`,
      before: 'Начнём в понедельник',
      after: 'Сроки скажу после созвона',
      insight: 'Срок не обещать в переписке',
      kind: 'procedure',
      state: 'ready',
      inPlace: false,
      sim: false,
      modelCallId: null,
      changes: [
        exampleChange({
          scope: 'shared',
          topic: 'timeline',
          tone: 'hurry',
          stage: null,
          clientText: 'Когда начнёте?',
          borisText: 'Сроки скажу после созвона',
          insight: 'Срок не обещать в переписке',
          source: `edit:conv-turn:${i}`,
          names: [],
        }),
      ],
    })
    ids.push(l.id)
  }
  return ids
}

/** The buttons of a batch message: lesson row i (1-based) → its task id and actions. */
const press = (s: Sent, row: number, col: number) =>
  parseCallback(s.rows[row]?.[col]?.callbackData ?? '') as { taskId: string; action: 'apply' }

beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

describe('lesson batches', () => {
  it('FR-TRAIN-6: lessons come in batches of 5', async () => {
    const f = fakes()
    await lessons(7)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]?.text).toContain('Уроки из работы: 5')
    expect(f.sent[0]?.text).toContain('Вывод: Срок не обещать в переписке')
    expect(f.sent[0]?.rows).toHaveLength(6)
    expect(f.sent[0]?.rows[5]?.[0]?.text).toBe('Все да')
    const states = (await db.select().from(lesson)).map((l) => l.state).sort()
    expect(states).toEqual(['asked', 'asked', 'asked', 'asked', 'asked', 'ready', 'ready'])
  })

  it('FR-TRAIN-6: no batch at night and no third batch a day', async () => {
    const f = fakes()
    await lessons(15)
    await batchesStep(f.d, msk(DAY1, '23:30'))
    expect(f.sent).toHaveLength(0)
    for (const at of ['11:00', '12:00', '13:00']) {
      await batchesStep(f.d, msk(DAY1, at))
      const last = f.sent.at(-1)
      if (last) await onSchoolPress(f.d, press(last, 5, 0), msk(DAY1, at))
    }
    expect(f.sent).toHaveLength(2)
  })

  it('FR-TRAIN-6: a batch open for 24 hours is closed, its yes are written and the rest go first in the next', async () => {
    const f = fakes()
    const first = await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    const batch = f.sent[0] as Sent
    await onSchoolPress(f.d, press(batch, 0, 0), msk(DAY1, '11:05'))
    await lessons(3, 100)
    await batchesStep(f.d, msk('2026-10-27', '11:30'))
    const closed = f.edits.filter((e) => e.id === batch.id).at(-1)
    expect(closed?.text.match(/в следующей пачке/g)).toHaveLength(4)
    expect(closed?.text).toContain('1. Сроки.')
    expect(closed?.text).toContain('5. Сроки.')
    expect(closed?.text).toContain(SCHOOL_TEXTS.willWrite)
    expect(f.applied).toHaveLength(0)
    await writePending(f.d)
    expect(f.applied).toHaveLength(1)
    expect(f.applied[0]).toHaveLength(1)
    expect(f.edits.at(-1)?.text).toContain('Записала в разум 1 урок.')
    expect(f.sent).toHaveLength(2)
    const second = await db.select().from(lesson).where(eq(lesson.state, 'asked'))
    const firstIds = new Set(first.slice(1))
    expect(second.filter((l) => firstIds.has(l.id))).toHaveLength(4)
  })

  it('FR-NOTIF-1: a press on a decided lesson answers «Уже сделано»', async () => {
    const f = fakes()
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    const p = press(f.sent[0] as Sent, 0, 0)
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:01'))).toBe(SCHOOL_TEXTS.decided)
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:02'))).toBe('Уже сделано')
  })

  it('FR-TRAIN-6: «Все да» decides only open lessons and writes one commit', async () => {
    const f = fakes()
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    const s = f.sent[0] as Sent
    await onSchoolPress(f.d, press(s, 1, 1), msk(DAY1, '11:01'))
    await onSchoolPress(f.d, press(s, 5, 0), msk(DAY1, '11:02'))
    const states = (await db.select().from(lesson)).map((l) => l.state).sort()
    expect(states).toEqual(['no', 'yes', 'yes', 'yes', 'yes'])
    // The press only closes the batch: the mind is written on the school's tick.
    expect(f.applied).toEqual([])
    await writePending(f.d)
    await writePending(f.d)
    expect(f.applied).toEqual([expect.any(Array)])
    expect(f.applied[0]).toHaveLength(4)
    expect(f.edits.at(-1)?.text).toContain('Записала в разум 4 урока.')
    expect(
      f.edits
        .at(-1)
        ?.rows.flat()
        .map((b) => b.text),
    ).toEqual(['Отменить'])
    const declined = await db.select().from(mindProposal).where(eq(mindProposal.state, 'declined'))
    expect(declined).toHaveLength(1)
  })

  it('FR-TRAIN-6: «нет» asks why, and a voice answer becomes the reason', async () => {
    const f = fakes()
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 0, 1), new Date())
    const ask = f.texts.find((t) => t.text.includes('почему нет'))
    expect(ask?.text).toContain('Урок 1')
    const [q] = await db.select().from(question).where(eq(question.kind, 'why_lesson'))
    expect(q).toBeTruthy()
    const reply = await handleBorisMessage(
      { db, transcriber: { transcribe: async () => 'клиент сам просил срок' } },
      { text: null, voicePath: '/tmp/v.oga', replyToMessageId: ask?.id ?? null, at: new Date() },
    )
    expect(reply).toContain('клиент сам просил срок')
    const [l] = await db.select().from(lesson).where(eq(lesson.state, 'no'))
    expect(l?.reason).toBe('клиент сам просил срок')
  })

  it('FR-MIND-3: «Отменить» under the batch reverts its commit', async () => {
    const f = fakes()
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 5, 0), msk(DAY1, '11:01'))
    await writePending(f.d)
    const undo = f.edits.at(-1)?.rows[0]?.[0]
    const p = parseCallback(undo?.callbackData ?? '') as { taskId: string; action: 'drop' }
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:02'))).toBe(SCHOOL_TEXTS.reverting)
    expect(f.reverted).toEqual([])
    await revertPending(f.d)
    await revertPending(f.d)
    const [t] = await db.select().from(task).where(eq(task.id, p.taskId))
    expect(f.reverted).toEqual([t?.entityId])
    expect(f.edits.at(-1)?.text).toContain(SCHOOL_TEXTS.reverted)
    expect(f.edits.at(-1)?.rows).toEqual([])
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:03'))).toBe('Уже сделано')
  })

  it('FR-NOTIF-3: the fourth school message of a day waits for the evening summary', async () => {
    const at = msk(DAY1, '12:00')
    expect(await takeNotice(db, at, 'batch')).toBeTruthy()
    expect(await takeNotice(db, at, 'autonomy')).toBeTruthy()
    expect(await takeNotice(db, at, 'interview')).toBeTruthy()
    expect(await takeNotice(db, at, 'batch')).toBeNull()
    expect(await takeNotice(db, at, 'golden_worse')).toBeTruthy()
    expect(await takeNotice(db, msk(DAY1, '09:30'), 'autonomy')).toBeNull()
    expect(await deferredNotices(db, DAY1)).toEqual(['batch'])
    const rows = await db
      .select()
      .from(jobRun)
      .where(and(eq(jobRun.day, DAY1)))
    expect(rows.filter((r) => r.name.startsWith('notice:'))).toHaveLength(4)
  })

  it('NFR-UX-1: school texts have no long dash', () => {
    const all = [
      SCHOOL_TEXTS.batchHead(5),
      SCHOOL_TEXTS.batchLine({
        i: 1,
        topic: 'price',
        clientText: 'а',
        before: 'б',
        after: 'в',
        afterLabel: SCHOOL_TEXTS.afterLabel('import', 'fact'),
        insight: 'г',
      }),
      SCHOOL_TEXTS.mark('moved'),
      SCHOOL_TEXTS.written(3),
      SCHOOL_TEXTS.whyLesson(2),
      SCHOOL_TEXTS.willWrite,
      SCHOOL_TEXTS.writeWaits,
      SCHOOL_TEXTS.reverting,
      SCHOOL_TEXTS.historyWriting(3),
    ].join('\n')
    expect(all).not.toMatch(/[\u2013\u2014]/)
  })

  it('FR-MIND-3: a write the mind cannot take yet is tried again on the next tick', async () => {
    let calls = 0
    const f = fakes({
      apply: async (ids) => {
        calls++
        if (calls === 1) return { ok: false, reason: 'no_git', detail: 'no clone', refused: [] }
        return {
          ok: true,
          commitId: newEventId(),
          sha: 'a',
          mindVersion: 'v',
          written: ids,
          refused: [],
        }
      },
    })
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 5, 0), msk(DAY1, '11:01'))
    const before = f.edits.length
    await writePending(f.d)
    expect(f.applied).toHaveLength(1)
    expect(f.edits).toHaveLength(before)
    await writePending(f.d)
    expect(f.applied).toHaveLength(2)
    expect(f.edits.at(-1)?.text).toContain('Записала в разум 5 уроков.')
  })

  it("FR-TRAIN-6: a batch Telegram refused leaves the lessons ready and gives the day's place back", async () => {
    const f = fakes({ refuse: true })
    await lessons(5)
    await expect(batchesStep(f.d, msk(DAY1, '11:00'))).rejects.toThrow('telegram is down')
    const states = (await db.select().from(lesson)).map((l) => [l.state, l.batchId, l.taskId])
    expect(states).toEqual(Array(5).fill(['ready', null, null]))
    expect(await db.select().from(task)).toEqual([])
    expect(await db.select().from(lessonBatch)).toEqual([])
    const notices = (await db.select().from(jobRun)).filter((r) => r.name.startsWith('notice:'))
    expect(notices).toEqual([])
  })

  it('FR-TRAIN-6: a batch is not sent when one of its lessons was decided meanwhile', async () => {
    const f = fakes()
    await lessons(5)
    const ready = (await nextBatch(db, msk(DAY1, '11:00'))) ?? []
    await decideLesson(db, ready[0]?.id ?? '', { decision: 'skip' })
    expect(await sendBatch(f.d, ready, msk(DAY1, '11:00'))).toBeNull()
    expect(f.sent).toEqual([])
    expect(await db.select().from(task)).toEqual([])
    const states = (await db.select().from(lesson)).map((l) => l.state).sort()
    expect(states).toEqual(['ready', 'ready', 'ready', 'ready', 'skip'])
  })

  it('FR-MIND-3: a revert conflict gives «Отменить» back with the reason', async () => {
    const f = fakes({
      revert: async () => ({
        ok: false,
        reason: 'conflict',
        detail: 'сначала откати более поздний',
      }),
    })
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 5, 0), msk(DAY1, '11:01'))
    await writePending(f.d)
    const undo = parseCallback(f.edits.at(-1)?.rows[0]?.[0]?.callbackData ?? '') as {
      taskId: string
      action: 'drop'
    }
    await onSchoolPress(f.d, undo, msk(DAY1, '11:02'))
    await revertPending(f.d)
    expect(f.edits.at(-1)?.text).toContain('сначала откати более поздний')
    expect(
      f.edits
        .at(-1)
        ?.rows.flat()
        .map((b) => b.text),
    ).toEqual(['Отменить'])
    const [t] = await db.select().from(task).where(eq(task.id, undo.taskId))
    expect(t?.state).toBe('open')
  })

  it('FR-MIND-3: a revert that throws gives «Отменить» back', async () => {
    const f = fakes({
      revert: async () => {
        throw new Error('git broke')
      },
    })
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 5, 0), msk(DAY1, '11:01'))
    await writePending(f.d)
    const undo = parseCallback(f.edits.at(-1)?.rows[0]?.[0]?.callbackData ?? '') as {
      taskId: string
      action: 'drop'
    }
    await onSchoolPress(f.d, undo, msk(DAY1, '11:02'))
    await revertPending(f.d)
    expect(f.edits.at(-1)?.text).toContain(SCHOOL_TEXTS.revertFailed)
    expect(f.edits.at(-1)?.text).not.toContain('git broke')
    const [t] = await db.select().from(task).where(eq(task.id, undo.taskId))
    expect(t?.state).toBe('open')
  })

  it('FR-TRAIN-6: a rollover keeps a decision made before it, and a press after it changes nothing', async () => {
    const f = fakes()
    const ids = await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    const old = f.sent[0] as Sent
    await onSchoolPress(f.d, press(old, 0, 0), msk(DAY1, '11:05'))
    await batchesStep(f.d, msk('2026-10-27', '11:30'))
    expect(await onSchoolPress(f.d, press(old, 1, 0), msk('2026-10-27', '11:31'))).toBe(
      'Уже сделано',
    )
    const rows = await db.select().from(lesson)
    const byId = new Map(rows.map((l) => [l.id, l]))
    expect(byId.get(ids[0] as string)?.state).toBe('yes')
    // Moved back to the waiting lessons, undecided: the old button did nothing.
    const second = byId.get(ids[1] as string)
    expect(second?.state).toBe('ready')
    const [firstBatch] = await db
      .select()
      .from(lessonBatch)
      .where(eq(lessonBatch.telegramMessageId, old.id))
    expect(second?.batchId).toBeNull()
    expect(firstBatch).toBeTruthy()
  })

  it('FR-TRAIN-6: five long lessons fit one message, and so does its last edit', async () => {
    const long = 'очень длинный текст клиента '.repeat(60)
    const f = fakes({
      apply: async (ids) => ({
        ok: false,
        reason: 'nothing',
        detail: 'all refused',
        refused: ids.map((id) => ({ proposalId: id, reason: 'причина отказа '.repeat(20) })),
      }),
    })
    for (let i = 0; i < 5; i++)
      await createLesson(db, {
        source: 'edit',
        sourceRef: `long:${i}`,
        scope: 'shared',
        topic: 'process',
        tone: 'neutral',
        questionType: null,
        clientText: long,
        before: long,
        after: long,
        insight: 'вывод '.repeat(40).slice(0, 240),
        kind: 'procedure',
        state: 'ready',
        inPlace: false,
        sim: false,
        modelCallId: null,
        changes: [
          exampleChange({
            scope: 'shared',
            topic: 'process',
            tone: 'neutral',
            stage: null,
            clientText: 'а',
            borisText: 'б',
            insight: `в ${i}`,
            source: `edit:long:${i}`,
            names: [],
          }),
        ],
      })
    await batchesStep(f.d, msk(DAY1, '11:00'))
    expect(f.sent[0]?.text.length).toBeLessThanOrEqual(3200)
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 5, 0), msk(DAY1, '11:01'))
    await writePending(f.d)
    const last = f.edits.at(-1)?.text ?? ''
    expect(last).toContain('не записала')
    expect(last.length).toBeLessThanOrEqual(4096)
  })

  it('FR-TRAIN-6: a plain answer with two «почему нет?» open asks which lesson it is for', async () => {
    const f = fakes()
    await lessons(5)
    await batchesStep(f.d, msk(DAY1, '11:00'))
    const now = new Date()
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 0, 1), now)
    await onSchoolPress(f.d, press(f.sent[0] as Sent, 2, 1), now)
    const reply = await handleBorisMessage(
      { db, transcriber: { transcribe: async () => null } },
      { text: 'клиент сам просил', voicePath: null, replyToMessageId: null, at: new Date() },
    )
    expect(reply).toContain('почему нет: урок 1')
    expect(reply).toContain('почему нет: урок 3')
    const reasons = (await db.select().from(lesson)).map((l) => l.reason)
    expect(reasons.every((r) => r === null)).toBe(true)
  })
})
