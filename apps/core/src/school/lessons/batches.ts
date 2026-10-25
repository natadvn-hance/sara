import { formatCallback, newEventId, type TaskAction } from '@sara/shared'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../db/client'
import { lesson, lessonBatch, mindProposal, task } from '../../db/schema'
import { appendEvent } from '../../journal/journal'
import { askOwnQuestion } from '../../learning/questions'
import { TEXTS } from '../../notify/cards'
import { getSetting } from '../../settings/store'
import { takeNotice } from '../notices'
import { SCHOOL_TEXTS } from '../texts'
import type { LessonRow, SchoolDeps } from '../types'
import { onHistoryPress } from './history'
import { decideLesson } from './store'

type Deps = Pick<SchoolDeps, 'db' | 'notifier' | 'writer'>
type Button = { text: string; callbackData: string }

const MSK_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** A batch unanswered this long is closed and its open lessons go first in the next one (M5 design 5.2). */
const BATCH_OPEN_MS = DAY_MS
/** Fewer than a full batch go anyway when the oldest lesson waits this long. */
const OLDEST_MS = 3 * DAY_MS

/** Task kinds the school answers when Boris presses a button (the rest go to the lead pipeline). */
export const SCHOOL_TASK_KINDS = ['lesson', 'lesson_batch', 'mind_commit', 'history_bulk'] as const

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)
const asRow = (r: typeof lesson.$inferSelect) => r as LessonRow

async function resolveTask(db: DbOrTx, id: string, resolution: string): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
    .where(and(eq(task.id, id), eq(task.state, 'open')))
    .returning({ id: task.id })
  return rows.length > 0
}

async function batchLessons(db: Db, batchId: string): Promise<LessonRow[]> {
  const [b] = await db.select().from(lessonBatch).where(eq(lessonBatch.id, batchId))
  const ids = (b?.lessonIds as string[] | undefined) ?? []
  if (ids.length === 0) return []
  const rows = await db.select().from(lesson).where(inArray(lesson.id, ids))
  return ids
    .map((id) => rows.find((r) => r.id === id))
    .filter((r) => !!r)
    .map(asRow)
}

/** The batch as Boris sees it now: every lesson with its mark, buttons only for the open ones. */
function render(
  lessons: LessonRow[],
  o: { open: boolean; batchTaskId: string | null; footer?: string; undoTaskId?: string | null },
): { text: string; rows: Button[][] } {
  const lines = lessons.map((l, i) =>
    SCHOOL_TEXTS.batchLine({
      i: i + 1,
      topic: l.topic,
      clientText: l.clientText,
      before: l.before,
      after: l.after,
      insight: l.insight,
      state: l.state,
    }),
  )
  const text = [SCHOOL_TEXTS.batchHead(lessons.length), ...lines, o.footer]
    .filter((x): x is string => !!x)
    .join('\n\n')
  const rows: Button[][] = []
  if (o.open) {
    lessons.forEach((l, i) => {
      if (l.state !== 'asked' || !l.taskId) return
      const t = l.taskId
      rows.push([
        { text: SCHOOL_TEXTS.yesButton(i + 1), callbackData: formatCallback(t, 'apply') },
        { text: SCHOOL_TEXTS.noButton, callbackData: formatCallback(t, 'drop') },
        { text: SCHOOL_TEXTS.skipButton, callbackData: formatCallback(t, 'skip') },
      ])
    })
    if (rows.length > 0 && o.batchTaskId)
      rows.push([
        { text: SCHOOL_TEXTS.allButton, callbackData: formatCallback(o.batchTaskId, 'all') },
      ])
  }
  if (o.undoTaskId)
    rows.push([
      { text: SCHOOL_TEXTS.undoButton, callbackData: formatCallback(o.undoTaskId, 'drop') },
    ])
  return { text, rows }
}

/**
 * The next batch, or null (M5 design 5.2): no batch is open, fewer than `school.batches_per_day` went today, and either
 * a full batch of ready lessons waits or the oldest of them waits more than three days. Oldest lessons go first.
 */
export async function nextBatch(db: Db, now: Date): Promise<LessonRow[] | null> {
  const size = await getSetting(db, 'school.lesson_batch')
  const perDay = await getSetting(db, 'school.batches_per_day')
  const [open] = await db
    .select({ id: lessonBatch.id })
    .from(lessonBatch)
    .where(isNull(lessonBatch.closedAt))
  if (open) return null
  const today = mskDay(now.getTime())
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lessonBatch)
    .where(
      sql`to_char(${lessonBatch.sentAt} at time zone 'Europe/Moscow', 'YYYY-MM-DD') = ${today}`,
    )
  if (n >= perDay) return null
  const ready = await db
    .select()
    .from(lesson)
    .where(eq(lesson.state, 'ready'))
    .orderBy(asc(lesson.createdAt), asc(lesson.n))
    .limit(size)
  if (ready.length >= size) return ready.map(asRow)
  const oldest = ready[0]
  if (oldest && now.getTime() - Date.parse(oldest.createdAt) > OLDEST_MS) return ready.map(asRow)
  return null
}

/**
 * Sends one batch (FR-TRAIN-6): a task per lesson and one for «Все да», one message. The rows are taken first and
 * given back if Telegram refuses, so a lesson is never «asked» without a message.
 */
export async function sendBatch(d: Deps, lessons: LessonRow[], now: Date): Promise<string> {
  const batchId = newEventId()
  const batchTaskId = newEventId()
  const taskIds = new Map(lessons.map((l) => [l.id, newEventId()]))
  await d.db.transaction(async (tx) => {
    await tx.insert(lessonBatch).values({
      id: batchId,
      lessonIds: lessons.map((l) => l.id),
      taskId: batchTaskId,
      sentAt: now.toISOString(),
    })
    await tx.insert(task).values([
      ...lessons.map((l) => ({
        id: taskIds.get(l.id) as string,
        kind: 'lesson',
        entityKind: 'lesson',
        entityId: l.id,
      })),
      { id: batchTaskId, kind: 'lesson_batch', entityKind: 'lesson_batch', entityId: batchId },
    ])
    for (const l of lessons)
      await tx
        .update(lesson)
        .set({ state: 'asked', batchId, taskId: taskIds.get(l.id) as string })
        .where(eq(lesson.id, l.id))
  })
  const asked = lessons.map((l) => ({
    ...l,
    state: 'asked' as const,
    taskId: taskIds.get(l.id) ?? null,
  }))
  const view = render(asked, { open: true, batchTaskId })
  let messageId: number
  try {
    messageId = (await d.notifier.sendButtons(view.text, view.rows)).messageId
  } catch (e) {
    await d.db.transaction(async (tx) => {
      await tx
        .update(lesson)
        .set({ state: 'ready', batchId: null, taskId: null })
        .where(eq(lesson.batchId, batchId))
      await tx.delete(task).where(inArray(task.id, [batchTaskId, ...taskIds.values()]))
      await tx.delete(lessonBatch).where(eq(lessonBatch.id, batchId))
    })
    throw e
  }
  await d.db
    .update(lessonBatch)
    .set({ telegramMessageId: messageId })
    .where(eq(lessonBatch.id, batchId))
  await d.db
    .update(task)
    .set({ telegramMessageId: messageId })
    .where(inArray(task.id, [batchTaskId, ...taskIds.values()]))
  await appendEvent(d.db, {
    type: 'lesson.batch_sent',
    v: 1,
    entity: { kind: 'lesson_batch', id: batchId },
    account_id: null,
    actor: 'sara',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { lessons: lessons.map((l) => l.n) },
  })
  return batchId
}

/**
 * Writes the «да» of a batch into the mind with one commit (ADR-025) and says how it went. A writer that cannot write
 * yet (no clone, a lock) leaves the proposals new: `writePending` tries again on a later tick.
 */
async function writeYes(
  d: Deps,
  batchId: string,
): Promise<{ footer: string; undoTaskId: string | null }> {
  const lessons = await batchLessons(d.db, batchId)
  const yes = lessons.filter((l) => l.state === 'yes')
  if (yes.length === 0) return { footer: SCHOOL_TEXTS.nothingToWrite, undoTaskId: null }
  const proposals = await d.db
    .select({ id: mindProposal.id, lessonId: mindProposal.lessonId })
    .from(mindProposal)
    .where(
      and(
        inArray(
          mindProposal.lessonId,
          yes.map((l) => l.id),
        ),
        eq(mindProposal.state, 'new'),
      ),
    )
  if (proposals.length === 0) return { footer: SCHOOL_TEXTS.nothingToWrite, undoTaskId: null }
  const r = await d.writer.apply(
    proposals.map((p) => p.id),
    { lessonIds: yes.map((l) => l.id), batchId },
  )
  const refusedLines = r.refused.map((x) => {
    const lessonId = proposals.find((p) => p.id === x.proposalId)?.lessonId
    const i = lessons.findIndex((l) => l.id === lessonId) + 1
    return SCHOOL_TEXTS.refused(i, x.reason)
  })
  if (!r.ok)
    return {
      footer: [
        r.reason === 'nothing' ? SCHOOL_TEXTS.nothingToWrite : SCHOOL_TEXTS.writeWaits,
        ...refusedLines,
      ].join('\n'),
      undoTaskId: null,
    }
  const refusedLessons = new Set(
    r.refused.map((x) => proposals.find((p) => p.id === x.proposalId)?.lessonId),
  )
  const written = yes.filter((l) => !refusedLessons.has(l.id)).length
  const undoTaskId = newEventId()
  await d.db.transaction(async (tx) => {
    await tx.update(lessonBatch).set({ commitId: r.commitId }).where(eq(lessonBatch.id, batchId))
    await tx.insert(task).values({
      id: undoTaskId,
      kind: 'mind_commit',
      entityKind: 'mind_commit',
      entityId: r.commitId,
    })
  })
  return { footer: [SCHOOL_TEXTS.written(written), ...refusedLines].join('\n'), undoTaskId }
}

async function editBatch(
  d: Deps,
  batchId: string,
  o: { footer?: string; undoTaskId?: string | null } = {},
): Promise<void> {
  const [b] = await d.db.select().from(lessonBatch).where(eq(lessonBatch.id, batchId))
  if (!b?.telegramMessageId) return
  const view = render(await batchLessons(d.db, batchId), {
    open: b.closedAt === null,
    batchTaskId: b.taskId,
    ...o,
  })
  await d.notifier
    .editText(b.telegramMessageId, view.text, view.rows)
    .catch((e) => console.error('lesson batch not edited', e instanceof Error ? e.message : e))
}

/** Closes a batch once: its «да» go into the mind, the message gets the result line. */
export async function closeBatch(d: Deps, batchId: string, o: { rolled?: boolean } = {}) {
  const [b] = await d.db
    .update(lessonBatch)
    .set({ closedAt: new Date().toISOString() })
    .where(and(eq(lessonBatch.id, batchId), isNull(lessonBatch.closedAt)))
    .returning()
  if (!b) return
  if (b.taskId) await resolveTask(d.db, b.taskId, 'closed')
  const w = await writeYes(d, batchId)
  const footer = o.rolled ? `${w.footer}\n${SCHOOL_TEXTS.rolledOver}` : w.footer
  await editBatch(d, batchId, { footer, undoTaskId: w.undoTaskId })
}

/** Whether a pressed task is the school's (a lesson, a batch, a mind commit, a history card). */
export async function isSchoolTask(db: Db, taskId: string): Promise<boolean> {
  const [t] = await db.select({ kind: task.kind }).from(task).where(eq(task.id, taskId))
  return !!t && (SCHOOL_TASK_KINDS as readonly string[]).includes(t.kind)
}

/** A batch unanswered for 24 hours is closed; its open lessons are ready again and go first next time. */
export async function rolloverStale(d: Deps, now: Date): Promise<void> {
  const stale = await d.db
    .select()
    .from(lessonBatch)
    .where(
      and(
        isNull(lessonBatch.closedAt),
        sql`${lessonBatch.sentAt} < ${new Date(now.getTime() - BATCH_OPEN_MS).toISOString()}`,
      ),
    )
  for (const b of stale) {
    const open = (await batchLessons(d.db, b.id)).filter((l) => l.state === 'asked')
    await d.db.transaction(async (tx) => {
      for (const l of open) if (l.taskId) await resolveTask(tx, l.taskId, 'rolled')
      if (open.length > 0)
        await tx
          .update(lesson)
          .set({ state: 'ready', batchId: null, taskId: null })
          .where(
            inArray(
              lesson.id,
              open.map((l) => l.id),
            ),
          )
    })
    // The batch keeps only the lessons that were decided in it.
    await d.db
      .update(lessonBatch)
      .set({
        lessonIds: ((b.lessonIds as string[]) ?? []).filter((id) => !open.some((l) => l.id === id)),
      })
      .where(eq(lessonBatch.id, b.id))
    await closeBatch(d, b.id, { rolled: open.length > 0 })
  }
}

/**
 * «Да» the mind could not take when Boris said it (no clone yet, a lock): the batches closed without a commit get it
 * now, and so do lessons decided outside a batch (a history card, the trainer).
 */
export async function writePending(d: Deps): Promise<void> {
  const rows = await d.db.execute<{ id: string }>(sql`
    select distinct b.id from core.lesson_batch b
    join core.lesson l on l.batch_id = b.id and l.state = 'yes'
    join core.mind_proposal p on p.lesson_id = l.id and p.state = 'new'
    where b.closed_at is not null and b.commit_id is null`)
  for (const { id } of rows.rows) {
    const w = await writeYes(d, id)
    if (w.undoTaskId) await editBatch(d, id, w)
  }
  const single = await d.db.execute<{ lesson_id: string; ids: string[] }>(sql`
    select l.id as lesson_id, array_agg(p.id) as ids from core.lesson l
    join core.mind_proposal p on p.lesson_id = l.id and p.state = 'new'
    where l.state = 'yes' and l.batch_id is null
    group by l.id`)
  for (const r of single.rows)
    await d.writer.apply(r.ids, { lessonIds: [r.lesson_id], batchId: null })
}

/** The tick's batch step: written what waits, closed what hangs, sent the next batch if the day allows. */
export async function batchesStep(d: Deps, now: Date): Promise<void> {
  if (!(await getSetting(d.db, 'school.on'))) return
  await writePending(d)
  await rolloverStale(d, now)
  const lessons = await nextBatch(d.db, now)
  if (!lessons) return
  if (!(await takeNotice(d.db, now, 'batch'))) return
  await sendBatch(d, lessons, now)
}

const DECISION: Partial<Record<TaskAction, 'yes' | 'no' | 'skip'>> = {
  apply: 'yes',
  drop: 'no',
  skip: 'skip',
}

/** After a press: the message shows the marks; a batch with every lesson decided is closed. */
async function afterDecision(d: Deps, batchId: string | null): Promise<void> {
  if (!batchId) return
  const lessons = await batchLessons(d.db, batchId)
  if (lessons.every((l) => l.state !== 'asked')) await closeBatch(d, batchId)
  else await editBatch(d, batchId)
}

/**
 * Boris pressed a button of the school (FR-NOTIF-1): yes, no or «не важно» on a lesson, «Все да» on a batch, «Отменить»
 * under a written batch. A press on a decided task answers «Уже сделано» and changes nothing.
 */
export async function onSchoolPress(
  d: Deps,
  p: { taskId: string; action: TaskAction },
  now: Date,
): Promise<string> {
  const [t] = await d.db.select().from(task).where(eq(task.id, p.taskId))
  if (!t || t.state !== 'open') return TEXTS.alreadyDone
  if (t.kind === 'lesson') {
    const decision = DECISION[p.action]
    if (!decision) return TEXTS.alreadyDone
    if (!(await resolveTask(d.db, t.id, p.action))) return TEXTS.alreadyDone
    const row = await decideLesson(d.db, t.entityId, { decision })
    if (!row) return TEXTS.alreadyDone
    if (decision === 'no') {
      const i = (await batchLessons(d.db, row.batchId ?? '')).findIndex((l) => l.id === row.id) + 1
      await askOwnQuestion(
        d,
        { kind: 'why_lesson', entityId: row.id, text: SCHOOL_TEXTS.whyLesson(i || row.n) },
        now,
      ).catch((e) => console.error('why_lesson not asked', e instanceof Error ? e.message : e))
    }
    await afterDecision(d, row.batchId)
    return SCHOOL_TEXTS.decided
  }
  if (t.kind === 'lesson_batch' && p.action === 'all') {
    const open = (await batchLessons(d.db, t.entityId)).filter((l) => l.state === 'asked')
    for (const l of open) {
      if (l.taskId && !(await resolveTask(d.db, l.taskId, 'apply'))) continue
      await decideLesson(d.db, l.id, { decision: 'yes' })
    }
    await closeBatch(d, t.entityId)
    return SCHOOL_TEXTS.decided
  }
  if (t.kind === 'history_bulk') return onHistoryPress(d, t, p.action, now)
  if (t.kind === 'mind_commit' && p.action === 'drop') {
    if (!(await resolveTask(d.db, t.id, 'drop'))) return TEXTS.alreadyDone
    const r = await d.writer.revert(t.entityId)
    if (r.ok) return SCHOOL_TEXTS.reverted
    if (r.reason === 'conflict') return SCHOOL_TEXTS.revertConflict(r.detail)
    // Not reverted: the button works again.
    await d.db.update(task).set({ state: 'open', resolution: null }).where(eq(task.id, t.id))
    return SCHOOL_TEXTS.revertFailed
  }
  return TEXTS.alreadyDone
}
