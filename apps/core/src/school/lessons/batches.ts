import { formatCallback, newEventId, type TaskAction } from '@sara/shared'
import { and, asc, eq, inArray, isNull, sql, TransactionRollbackError } from 'drizzle-orm'
import type { Db, DbOrTx } from '../../db/client'
import { lesson, lessonBatch, mindProposal, task } from '../../db/schema'
import { appendEvent } from '../../journal/journal'
import { askOwnQuestion } from '../../learning/questions'
import { TEXTS } from '../../notify/cards'
import { getSetting } from '../../settings/store'
import { onInterviewPress } from '../interview'
import { releaseNotice, takeNotice } from '../notices'
import { SCHOOL_TEXTS } from '../texts'
import type { LessonRow, RevertResult, SchoolDeps } from '../types'
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
/**
 * The lessons' part of a batch message: Telegram takes 4096 characters, and the marks and the longest footer (five
 * refused lines) must still fit when the message is edited.
 */
const BODY_MAX = 3200

/** Task kinds the school answers when Boris presses a button (the rest go to the lead pipeline). */
export const SCHOOL_TASK_KINDS = [
  'lesson',
  'lesson_batch',
  'mind_commit',
  'history_bulk',
  'interview_check',
] as const
/** «Отменить» pressed: the revert waits for the tick, never inside the press. */
const REVERT = 'revert'

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)
const asRow = (r: typeof lesson.$inferSelect) => r as LessonRow
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function resolveTask(db: DbOrTx, id: string, resolution: string): Promise<boolean> {
  const rows = await db
    .update(task)
    .set({ state: 'resolved', resolution, resolvedAt: new Date().toISOString() })
    .where(and(eq(task.id, id), eq(task.state, 'open')))
    .returning({ id: task.id })
  return rows.length > 0
}

/** Every lesson the batch was sent with, in its order; one moved to a later batch has another batch id. */
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

/** The lessons still decided in this batch (not moved on by a rollover). */
async function ownLessons(db: Db, batchId: string): Promise<LessonRow[]> {
  return (await batchLessons(db, batchId)).filter((l) => l.batchId === batchId)
}

/**
 * The batch as Boris sees it now: every lesson with its mark (a moved one says so and keeps its number), buttons
 * only for the open ones. The texts are cut by the lessons alone, so every redraw of one batch cuts them alike.
 */
function render(
  batchId: string,
  lessons: LessonRow[],
  o: { open: boolean; batchTaskId: string | null; footer?: string; undoTaskId?: string | null },
): { text: string; rows: Button[][] } {
  const body = (scale: number) =>
    lessons.map((l, i) =>
      SCHOOL_TEXTS.batchLine(
        {
          i: i + 1,
          topic: l.topic,
          clientText: l.clientText,
          before: l.before,
          after: l.after,
          afterLabel: SCHOOL_TEXTS.afterLabel(l.source, l.kind),
          insight: l.insight,
        },
        scale,
      ),
    )
  const head = SCHOOL_TEXTS.batchHead(lessons.length)
  let scale = 1
  while (scale > 0.2 && [head, ...body(scale)].join('\n\n').length > BODY_MAX) scale -= 0.1
  const lines = body(scale).map((line, i) => {
    const l = lessons[i] as LessonRow
    const mark = SCHOOL_TEXTS.mark(l.batchId === batchId ? l.state : 'moved')
    return mark ? `${line}\n${mark}` : line
  })
  const text = [head, ...lines, o.footer].filter((x): x is string => !!x).join('\n\n')
  const rows: Button[][] = []
  if (o.open) {
    lessons.forEach((l, i) => {
      if (l.batchId !== batchId || l.state !== 'asked' || !l.taskId) return
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
 * given back if Telegram refuses, so a lesson is never «asked» without a message. Null, and nothing sent, when one of
 * the lessons is no longer ready.
 */
export async function sendBatch(d: Deps, lessons: LessonRow[], now: Date): Promise<string | null> {
  const batchId = newEventId()
  const batchTaskId = newEventId()
  const taskIds = new Map(lessons.map((l) => [l.id, newEventId()]))
  const taken = await d.db
    .transaction(async (tx) => {
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
      for (const l of lessons) {
        const rows = await tx
          .update(lesson)
          .set({ state: 'asked', batchId, taskId: taskIds.get(l.id) as string })
          .where(and(eq(lesson.id, l.id), eq(lesson.state, 'ready')))
          .returning({ id: lesson.id })
        if (rows.length === 0) tx.rollback()
      }
      return true
    })
    .catch((e) => {
      if (e instanceof TransactionRollbackError) return false
      throw e
    })
  if (!taken) return null
  const asked = lessons.map((l) => ({
    ...l,
    state: 'asked' as const,
    batchId,
    taskId: taskIds.get(l.id) ?? null,
  }))
  const view = render(batchId, asked, { open: true, batchTaskId })
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
 * Writes the «да» of a closed batch into the mind with one commit (ADR-025). `final` is false when the writer cannot
 * write yet (no clone, a lock): the proposals stay new and a later tick tries again.
 */
async function writeYes(
  d: Deps,
  batchId: string,
): Promise<{ footer: string; undoTaskId: string | null; final: boolean }> {
  const lessons = await batchLessons(d.db, batchId)
  const yes = lessons.filter((l) => l.batchId === batchId && l.state === 'yes')
  const nothing = { footer: SCHOOL_TEXTS.nothingToWrite, undoTaskId: null, final: true }
  if (yes.length === 0) return nothing
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
  if (proposals.length === 0) return nothing
  const r = await d.writer.apply(
    proposals.map((p) => p.id),
    { lessonIds: yes.map((l) => l.id), batchId },
  )
  const refusedLines = r.refused.map((x) => {
    const lessonId = proposals.find((p) => p.id === x.proposalId)?.lessonId
    const i = lessons.findIndex((l) => l.id === lessonId) + 1
    return SCHOOL_TEXTS.refused(i, x.reason)
  })
  if (!r.ok) {
    const final = r.reason === 'nothing'
    return {
      footer: [final ? SCHOOL_TEXTS.nothingToWrite : SCHOOL_TEXTS.writeWaits, ...refusedLines].join(
        '\n',
      ),
      undoTaskId: null,
      final,
    }
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
  return {
    footer: [SCHOOL_TEXTS.written(written), ...refusedLines].join('\n'),
    undoTaskId,
    final: true,
  }
}

async function editBatch(
  d: Deps,
  batchId: string,
  o: { footer?: string; undoTaskId?: string | null } = {},
): Promise<void> {
  const [b] = await d.db.select().from(lessonBatch).where(eq(lessonBatch.id, batchId))
  if (!b?.telegramMessageId) return
  const view = render(batchId, await batchLessons(d.db, batchId), {
    open: b.closedAt === null,
    batchTaskId: b.taskId,
    ...o,
  })
  await d.notifier
    .editText(b.telegramMessageId, view.text, view.rows)
    .catch((e) => console.error('lesson batch not edited', errText(e)))
}

/**
 * Closes a batch once. Its «да» go into the mind on the school's tick (`writePending`), never inside Boris's press:
 * the bot answers one update at a time, and a write may wait for the mind's lock.
 */
export async function closeBatch(d: Deps, batchId: string) {
  const [b] = await d.db
    .update(lessonBatch)
    .set({ closedAt: new Date().toISOString() })
    .where(and(eq(lessonBatch.id, batchId), isNull(lessonBatch.closedAt)))
    .returning()
  if (!b) return
  if (b.taskId) await resolveTask(d.db, b.taskId, 'closed')
  const yes = (await ownLessons(d.db, batchId)).some((l) => l.state === 'yes')
  await editBatch(d, batchId, {
    footer: yes ? SCHOOL_TEXTS.willWrite : SCHOOL_TEXTS.nothingToWrite,
  })
}

/** Whether a pressed task is the school's (a lesson, a batch, a mind commit, a history card). */
export async function isSchoolTask(db: Db, taskId: string): Promise<boolean> {
  const [t] = await db.select({ kind: task.kind }).from(task).where(eq(task.id, taskId))
  return !!t && (SCHOOL_TASK_KINDS as readonly string[]).includes(t.kind)
}

/**
 * A batch unanswered for 24 hours is closed; its open lessons are ready again and go first next time. A lesson moves
 * only if its task is still open, inside one transaction with that check: a press that got there first keeps its
 * decision, and a press after the move finds its task resolved.
 */
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
    const open = (await ownLessons(d.db, b.id)).filter((l) => l.state === 'asked')
    await d.db.transaction(async (tx) => {
      const moved: string[] = []
      for (const l of open)
        if (l.taskId && (await resolveTask(tx, l.taskId, 'rolled'))) moved.push(l.id)
      if (moved.length > 0)
        await tx
          .update(lesson)
          .set({ state: 'ready', batchId: null, taskId: null })
          .where(and(inArray(lesson.id, moved), eq(lesson.state, 'asked')))
    })
    await closeBatch(d, b.id)
  }
}

/**
 * «Да» on their way into the mind (FR-MIND-3): the closed batches without a commit, and lessons decided outside a
 * batch (a history card, the trainer). One failure never stops the others; the message changes only on a final
 * result, so a writer that cannot write yet leaves «Записываю» and is tried again on the next tick.
 */
export async function writePending(d: Deps): Promise<void> {
  const rows = await d.db.execute<{ id: string }>(sql`
    select distinct b.id from core.lesson_batch b
    join core.lesson l on l.batch_id = b.id and l.state = 'yes'
    join core.mind_proposal p on p.lesson_id = l.id and p.state = 'new'
    where b.closed_at is not null and b.commit_id is null`)
  for (const { id } of rows.rows) {
    try {
      const w = await writeYes(d, id)
      if (w.final) await editBatch(d, id, w)
    } catch (e) {
      console.error('lesson batch not written', errText(e))
    }
  }
  const single = await d.db.execute<{ lesson_id: string; source_ref: string; ids: string[] }>(sql`
    select l.id as lesson_id, l.source_ref, array_agg(p.id) as ids from core.lesson l
    join core.mind_proposal p on p.lesson_id = l.id and p.state = 'new'
    where l.state = 'yes' and l.batch_id is null
    group by l.id, l.source_ref`)
  for (const r of single.rows) {
    try {
      const w = await d.writer.apply(r.ids, { lessonIds: [r.lesson_id], batchId: null })
      if (w.ok || w.reason === 'nothing')
        await reportBulk(d, r.source_ref, w.ok ? r.ids.length - w.refused.length : 0)
    } catch (e) {
      console.error('lesson not written', errText(e))
    }
  }
}

/** A history card's «Да, все» (source `bulk:<kind>:<task>`) gets its result on the card itself. */
async function reportBulk(d: Deps, sourceRef: string, written: number): Promise<void> {
  const taskId = /^bulk:[a-z]+:(.+)$/.exec(sourceRef)?.[1]
  if (!taskId) return
  const [t] = await d.db
    .select({ messageId: task.telegramMessageId })
    .from(task)
    .where(eq(task.id, taskId))
  if (!t?.messageId) return
  await d.notifier
    .editText(t.messageId, SCHOOL_TEXTS.historyWritten(written), [])
    .catch((e) => console.error('history card not edited', errText(e)))
}

/**
 * «Отменить» pressed under a written batch (FR-MIND-3): the revert runs here, on the tick. A lock or a missing clone
 * waits for the next tick; a conflict or a failure gives the button back with the reason under the batch.
 */
export async function revertPending(d: Deps): Promise<void> {
  const rows = await d.db
    .select()
    .from(task)
    .where(and(eq(task.kind, 'mind_commit'), eq(task.resolution, REVERT)))
  for (const t of rows) {
    let r: RevertResult
    try {
      r = await d.writer.revert(t.entityId)
    } catch (e) {
      r = { ok: false, reason: 'unknown', detail: errText(e) }
    }
    if (!r.ok && (r.reason === 'locked' || r.reason === 'no_git')) continue
    if (r.ok) await d.db.update(task).set({ resolution: 'reverted' }).where(eq(task.id, t.id))
    // Not reverted: the button works again.
    else
      await d.db
        .update(task)
        .set({ state: 'open', resolution: null, resolvedAt: null })
        .where(eq(task.id, t.id))
    const [b] = await d.db
      .select({ id: lessonBatch.id })
      .from(lessonBatch)
      .where(eq(lessonBatch.commitId, t.entityId))
    const footer = r.ok
      ? SCHOOL_TEXTS.reverted
      : r.reason === 'conflict'
        ? SCHOOL_TEXTS.revertConflict(r.detail)
        : SCHOOL_TEXTS.revertFailed
    if (b) await editBatch(d, b.id, { footer, undoTaskId: r.ok ? null : t.id })
    else await d.notifier.sendText(footer).catch(() => {})
  }
}

/** The tick's batch step: closed what hangs, sent the next batch if the day allows. */
export async function batchesStep(d: Deps, now: Date): Promise<void> {
  if (!(await getSetting(d.db, 'school.on'))) return
  await rolloverStale(d, now)
  const lessons = await nextBatch(d.db, now)
  if (!lessons) return
  const notice = await takeNotice(d.db, now, 'batch')
  if (!notice) return
  // A batch that did not go gives the day's place back.
  const sent = await sendBatch(d, lessons, now).catch(async (e) => {
    await releaseNotice(d.db, notice)
    throw e
  })
  if (!sent) await releaseNotice(d.db, notice)
}

const DECISION: Partial<Record<TaskAction, 'yes' | 'no' | 'skip'>> = {
  apply: 'yes',
  drop: 'no',
  skip: 'skip',
}

/** The task and the lesson are decided together, so a rollover never takes one without the other. */
async function decideTask(
  db: Db,
  taskId: string,
  lessonId: string,
  action: TaskAction,
  decision: 'yes' | 'no' | 'skip',
): Promise<LessonRow | null> {
  return db.transaction(async (tx) => {
    if (!(await resolveTask(tx, taskId, action))) return null
    return decideLesson(tx, lessonId, { decision })
  })
}

/** After a press: the message shows the marks; a batch with every lesson decided is closed. */
async function afterDecision(d: Deps, batchId: string | null): Promise<void> {
  if (!batchId) return
  const lessons = await ownLessons(d.db, batchId)
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
  if (t?.state !== 'open') return TEXTS.alreadyDone
  if (t.kind === 'lesson') {
    const decision = DECISION[p.action]
    if (!decision) return TEXTS.alreadyDone
    const row = await decideTask(d.db, t.id, t.entityId, p.action, decision)
    if (!row) return TEXTS.alreadyDone
    if (decision === 'no') {
      const i = row.batchId
        ? (await batchLessons(d.db, row.batchId)).findIndex((l) => l.id === row.id) + 1
        : 0
      await askOwnQuestion(
        d,
        { kind: 'why_lesson', entityId: row.id, text: SCHOOL_TEXTS.whyLesson(i || row.n) },
        now,
      ).catch((e) => console.error('why_lesson not asked', errText(e)))
    }
    await afterDecision(d, row.batchId)
    return SCHOOL_TEXTS.decided
  }
  if (t.kind === 'lesson_batch' && p.action === 'all') {
    const open = (await ownLessons(d.db, t.entityId)).filter((l) => l.state === 'asked')
    for (const l of open) if (l.taskId) await decideTask(d.db, l.taskId, l.id, 'apply', 'yes')
    await closeBatch(d, t.entityId)
    return SCHOOL_TEXTS.decided
  }
  if (t.kind === 'history_bulk') return onHistoryPress(d, t, p.action, now)
  if (t.kind === 'interview_check') return onInterviewPress(d, t, p.action, now)
  if (t.kind === 'mind_commit' && p.action === 'drop') {
    if (!(await resolveTask(d.db, t.id, REVERT))) return TEXTS.alreadyDone
    return SCHOOL_TEXTS.reverting
  }
  return TEXTS.alreadyDone
}
