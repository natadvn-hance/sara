import { newEventId, parseCallback } from '@sara/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { jobRun, lesson, mindProposal, question, task } from '../../../src/db/schema'
import { handleBorisMessage } from '../../../src/learning/inbox'
import type { Notifier } from '../../../src/notify/notifier'
import { batchesStep, onSchoolPress } from '../../../src/school/lessons/batches'
import { exampleChange } from '../../../src/school/lessons/records'
import { createLesson } from '../../../src/school/lessons/store'
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
function fakes() {
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
      const id = next++
      sent.push({ id, text, rows })
      return { messageId: id }
    },
    editText: async (id, text, rows) => {
      edits.push({ id, text, rows: rows ?? [] })
    },
  }
  const writer: MindWriter = {
    apply: async (ids) => {
      applied.push([...ids].sort())
      const commitId = newEventId()
      return { ok: true, commitId, sha: 'abc', mindVersion: 'v2', written: ids, refused: [] }
    },
    revert: async (id) => {
      reverted.push(id)
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
    expect(f.applied).toHaveLength(1)
    expect(f.applied[0]).toHaveLength(1)
    expect(f.edits.at(-1)?.text).toContain('Остальное перенесла в новую пачку')
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
    const undo = f.edits.at(-1)?.rows[0]?.[0]
    const p = parseCallback(undo?.callbackData ?? '') as { taskId: string; action: 'drop' }
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:02'))).toBe(SCHOOL_TEXTS.reverted)
    const [t] = await db.select().from(task).where(eq(task.id, p.taskId))
    expect(f.reverted).toEqual([t?.entityId])
    expect(await onSchoolPress(f.d, p, msk(DAY1, '11:03'))).toBe('Уже сделано')
  })

  it('FR-NOTIF-3: the fourth school message of a day waits for the evening summary', async () => {
    const at = msk(DAY1, '12:00')
    expect(await takeNotice(db, at, 'batch')).toBe(true)
    expect(await takeNotice(db, at, 'autonomy')).toBe(true)
    expect(await takeNotice(db, at, 'interview')).toBe(true)
    expect(await takeNotice(db, at, 'batch')).toBe(false)
    expect(await takeNotice(db, at, 'golden_worse')).toBe(true)
    expect(await takeNotice(db, msk(DAY1, '09:30'), 'autonomy')).toBe(false)
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
        insight: 'г',
        state: 'yes',
      }),
      SCHOOL_TEXTS.written(3),
      SCHOOL_TEXTS.whyLesson(2),
      SCHOOL_TEXTS.rolledOver,
      SCHOOL_TEXTS.writeWaits,
    ].join('\n')
    expect(all).not.toMatch(/[—–]/)
  })
})
