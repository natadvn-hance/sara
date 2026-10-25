import { createHash } from 'node:crypto'
import { formatCallback, newEventId, normalizeText, type TaskAction } from '@sara/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { jobRun, lesson, mindGap, mindProposal, task } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { askOwnQuestion, type DraftAnswer } from '../learning/questions'
import { TEXTS } from '../notify/cards'
import { getSetting } from '../settings/store'
import { makeInsight } from './lessons/maker'
import { knowledgeChange } from './lessons/records'
import { createLesson, decideLesson } from './lessons/store'
import { releaseNotice, takeNotice } from './notices'
import { SCHOOL_TEXTS } from './texts'
import type { LessonRow, MindChange, SchoolDeps } from './types'

const MSK_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** A gap from work counts this long; one that kept coming back is asked first (M5 design 5.9). */
const WORK_DAYS = 14
/** «Не знаю, пропустить» keeps a question away this long. */
const SKIP_DAYS = 7
/** Boris's answers older than this are not taken up by the tick any more. */
const ANSWER_DAYS = 2
const SOURCE_RANK = { work: 0, teacher: 1, sim: 2 } as const

export type InterviewQuestion = {
  gapKey: string
  question: string
  source: keyof typeof SOURCE_RANK
  topic: string | null
  count: number
}

const mskDay = (t: number) => new Date(t + MSK_MS).toISOString().slice(0, 10)
const keyOf = (text: string) =>
  createHash('sha1').update(normalizeText(text)).digest('hex').slice(0, 16)
const sourceOf = (turnId: string): InterviewQuestion['source'] =>
  turnId.startsWith('teacher:') ? 'teacher' : turnId.startsWith('sim:') ? 'sim' : 'work'
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * What Sara would ask Boris (FR-MIND-4, M5 design 5.9): the open gaps grouped by their words, gaps from work first
 * (the most frequent of the last 14 days), then the teacher's questions, then the generator's holes. A question he
 * skipped stays away for a week.
 */
export async function interviewQueue(db: Db, now: Date, limit = 10): Promise<InterviewQuestion[]> {
  const rows = await db.select().from(mindGap).where(isNull(mindGap.lessonId))
  const skipped = new Set(
    (
      await db.execute<{ name: string }>(
        sql`select name from core.job_run where name like 'interview_skip:%'
          and day > ${mskDay(now.getTime() - SKIP_DAYS * DAY_MS)}`,
      )
    ).rows.map((r) => r.name.slice('interview_skip:'.length)),
  )
  const groups = new Map<string, InterviewQuestion & { first: string }>()
  for (const g of rows) {
    const source = sourceOf(g.turnId)
    if (source === 'work' && now.getTime() - Date.parse(g.createdAt) > WORK_DAYS * DAY_MS) continue
    const key = keyOf(g.text)
    if (skipped.has(key)) continue
    const old = groups.get(key)
    if (old) {
      old.count++
      if (SOURCE_RANK[source] < SOURCE_RANK[old.source]) old.source = source
      continue
    }
    groups.set(key, {
      gapKey: key,
      question:
        source === 'teacher' ? g.text.trim() : SCHOOL_TEXTS.interviewQuestion(g.text.trim()),
      source,
      topic: g.topic,
      count: 1,
      first: g.createdAt,
    })
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        b.count - a.count ||
        Date.parse(a.first) - Date.parse(b.first),
    )
    .slice(0, limit)
    .map(({ first: _first, ...q }) => q)
}

/** The record Sara understood from Boris's answer, as his screens and the Telegram card show it. */
export type Understood = {
  lessonId: string
  title: string
  fact: string
  when: string
  notSay: string
}

/**
 * Boris's answer to an interview question becomes a knowledge record waiting for his «Правильно понимаю?» (FR-MIND-4):
 * one call of the lesson maker on sonnet, a lesson decided in place. A number in the record must be one he said
 * (the writer's guard checks it again). `ref` names the answer (his message's question), so one answer makes one
 * lesson.
 */
export async function answerInterview(
  d: Pick<SchoolDeps, 'db' | 'gateway'>,
  gapKey: string,
  answer: string,
  now: Date,
  ref: string = newEventId(),
): Promise<{ ok: true; understood: Understood } | { ok: false; reason: string }> {
  const q = (await interviewQueue(d.db, now, 1000)).find((x) => x.gapKey === gapKey)
  if (!q) return { ok: false, reason: SCHOOL_TEXTS.interviewClosed }
  const r = await makeInsight(d.gateway, {
    mode: 'interview',
    clientText: null,
    before: null,
    after: answer,
    question: q.question,
    why: null,
    names: [],
    priority: 'P1',
  })
  if (!r?.fact) return { ok: false, reason: SCHOOL_TEXTS.interviewNotUnderstood }
  const l = await createLesson(d.db, {
    source: 'interview',
    sourceRef: `${gapKey}:${ref}`,
    scope: 'shared',
    topic: r.topic,
    tone: r.tone,
    questionType: null,
    clientText: null,
    before: q.question,
    after: answer,
    insight: (r.insight || r.fact.title).slice(0, 240),
    kind: 'fact',
    state: 'asked',
    inPlace: true,
    sim: false,
    modelCallId: null,
    changes: [
      knowledgeChange({
        scope: 'shared',
        topic: r.topic,
        fact: r.fact,
        source: `interview:${gapKey}`,
        names: [],
      }),
    ],
  })
  await appendEvent(d.db, {
    type: 'interview.answered',
    v: 1,
    entity: { kind: 'lesson', id: l.id },
    account_id: null,
    actor: 'boris',
    occurred_at: now.toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: null,
    payload: { gap: gapKey, n: l.n },
  })
  return { ok: true, understood: await understoodOf(d.db, l.id) }
}

/** What the lesson's knowledge record says, as it will be written (its tags kept). */
async function understoodOf(db: Db, lessonId: string): Promise<Understood> {
  const [p] = await db
    .select({ change: mindProposal.change })
    .from(mindProposal)
    .where(eq(mindProposal.lessonId, lessonId))
  const c = p?.change as MindChange | undefined
  return {
    lessonId,
    title: c?.fields.title ?? '',
    fact: c?.sections['Факт'] ?? '',
    when: c?.sections['Когда говорить'] ?? '',
    notSay: c?.sections['Чего не говорить'] ?? '',
  }
}

const gapKeyOf = (l: Pick<LessonRow, 'sourceRef'>) => l.sourceRef.split(':')[0] ?? ''

/**
 * «Да, записать»: the record is decided and every gap of its words is closed (FR-MIND-4). The school's tick writes it
 * into the mind (`writePending`) and puts the result on the card: a write never runs inside Boris's press.
 */
export async function confirmInterview(
  d: Pick<SchoolDeps, 'db'>,
  lessonId: string,
): Promise<string> {
  const row = await decideLesson(d.db, lessonId, { decision: 'yes' })
  if (!row) return TEXTS.alreadyDone
  const key = gapKeyOf(row)
  const open = await d.db.select().from(mindGap).where(isNull(mindGap.lessonId))
  const ids = open.filter((g) => keyOf(g.text) === key).map((g) => g.id)
  if (ids.length > 0) await d.db.update(mindGap).set({ lessonId }).where(inArray(mindGap.id, ids))
  return SCHOOL_TEXTS.interviewWriting
}

/** The tick wrote an interview record (or the guard refused it): the card says so under what Sara understood. */
export async function reportInterview(
  d: Pick<SchoolDeps, 'db' | 'notifier'>,
  lessonId: string,
  refused: string | null,
): Promise<void> {
  const [t] = await d.db
    .select({ messageId: task.telegramMessageId })
    .from(task)
    .where(and(eq(task.kind, 'interview_check'), eq(task.entityId, lessonId)))
  if (!t?.messageId) return
  const result = refused ? SCHOOL_TEXTS.interviewRefused(refused) : SCHOOL_TEXTS.interviewWritten
  await d.notifier
    .editText(
      t.messageId,
      `${SCHOOL_TEXTS.interviewUnderstood(await understoodOf(d.db, lessonId))}\n\n${result}`,
      [],
    )
    .catch((e) => console.error('interview card not edited', errText(e)))
}

/** «Не знаю, пропустить»: the question waits a week; the record Sara understood is dropped. */
export async function skipInterview(db: Db, lessonId: string, now: Date): Promise<string> {
  const row = await decideLesson(db, lessonId, { decision: 'skip' })
  if (!row) return TEXTS.alreadyDone
  await db
    .insert(jobRun)
    .values({ name: `interview_skip:${gapKeyOf(row)}`, day: mskDay(now.getTime()) })
    .onConflictDoNothing()
  return SCHOOL_TEXTS.interviewSkipped
}

/**
 * The card «Я поняла так … Правильно понимаю?» with its task (kind interview_check). A card Telegram refused leaves
 * no lesson behind, so the next tick makes it again.
 */
async function sendUnderstood(d: Pick<SchoolDeps, 'db' | 'notifier'>, u: Understood) {
  const taskId = newEventId()
  await d.db
    .insert(task)
    .values({ id: taskId, kind: 'interview_check', entityKind: 'lesson', entityId: u.lessonId })
  const b = (text: string, action: TaskAction) => ({
    text,
    callbackData: formatCallback(taskId, action),
  })
  let messageId: number
  try {
    messageId = (
      await d.notifier.sendButtons(SCHOOL_TEXTS.interviewUnderstood(u), [
        [b(SCHOOL_TEXTS.writeButton, 'apply'), b(SCHOOL_TEXTS.fixButton, 'edit')],
        [b(SCHOOL_TEXTS.dontKnowButton, 'skip')],
      ])
    ).messageId
  } catch (e) {
    await d.db.transaction(async (tx) => {
      await tx.delete(task).where(eq(task.id, taskId))
      await tx.delete(mindProposal).where(eq(mindProposal.lessonId, u.lessonId))
      await tx.delete(lesson).where(eq(lesson.id, u.lessonId))
    })
    throw e
  }
  await d.db.update(task).set({ telegramMessageId: messageId }).where(eq(task.id, taskId))
}

/**
 * Boris's words to the day's question or to «Что поправить?» (inbox hook). The message handler only thanks him: the
 * model call and the card come on the school's tick (`interviewAnswersStep`), so his next press is never kept waiting.
 */
export async function onSchoolAnswer(_d: unknown, _a: DraftAnswer): Promise<string> {
  return SCHOOL_TEXTS.interviewThinking
}

/**
 * The answers Boris gave since the last tick become cards «Я поняла так»: one lesson per answer (its source names the
 * question), a correction replaces the record Sara understood before. An answer Sara could not understand is told
 * once and not tried again.
 */
export async function interviewAnswersStep(
  d: Pick<SchoolDeps, 'db' | 'gateway' | 'notifier'>,
  now: Date,
): Promise<void> {
  const rows = await d.db.execute<{
    id: string
    kind: string
    entity_id: string
    answer: string
    answered_at: string
  }>(sql`
    select q.id, q.kind, q.entity_id, q.answer, q.answered_at from core.question q
    where q.kind in ('interview', 'interview_fix') and q.answered_at is not null and q.answer is not null
      and q.answered_at > ${new Date(now.getTime() - ANSWER_DAYS * DAY_MS).toISOString()}
      and not exists (select 1 from core.lesson l
        where l.source = 'interview' and split_part(l.source_ref, ':', 2) = q.id::text)
      and not exists (select 1 from core.job_run j where j.name = 'interview_failed:' || q.id::text)
    order by q.answered_at`)
  for (const q of rows.rows) {
    try {
      let gapKey = q.entity_id
      let text = q.answer
      if (q.kind === 'interview_fix') {
        const [old] = await d.db.select().from(lesson).where(eq(lesson.id, q.entity_id))
        gapKey = old ? gapKeyOf(old) : ''
        text = `${old?.after ?? ''}\nПоправка: ${q.answer}`
        if (old) await decideLesson(d.db, old.id, { decision: 'skip', reason: 'поправил' })
      }
      const r = await answerInterview(d, gapKey, text, new Date(q.answered_at), q.id)
      if (!r.ok) {
        await d.db
          .insert(jobRun)
          .values({ name: `interview_failed:${q.id}`, day: mskDay(now.getTime()) })
          .onConflictDoNothing()
        await d.notifier.sendText(r.reason)
        continue
      }
      await sendUnderstood(d, r.understood)
    } catch (e) {
      console.error('interview answer not taken', errText(e))
    }
  }
}

/** A press on the «Правильно понимаю?» card. */
export async function onInterviewPress(
  d: Pick<SchoolDeps, 'db' | 'notifier'>,
  t: { id: string; entityId: string },
  action: TaskAction,
  now: Date,
): Promise<string> {
  const rows = await d.db
    .update(task)
    .set({ state: 'resolved', resolution: action, resolvedAt: now.toISOString() })
    .where(and(eq(task.id, t.id), eq(task.state, 'open')))
    .returning({ id: task.id })
  if (rows.length === 0) return TEXTS.alreadyDone
  if (action === 'apply') return confirmInterview(d, t.entityId)
  if (action === 'skip') return skipInterview(d.db, t.entityId, now)
  if (action === 'edit') {
    await askOwnQuestion(
      d,
      { kind: 'interview_fix', entityId: t.entityId, text: SCHOOL_TEXTS.interviewFixAsk },
      now,
    )
    return SCHOOL_TEXTS.interviewFixAsked
  }
  return TEXTS.alreadyDone
}

/**
 * The day's interview question in Telegram (M5 design 5.9): one a day, the first of the queue, in the school's
 * hours and its daily count. The invitation into the app for three and more comes with the app's screens.
 */
export async function interviewStep(d: Pick<SchoolDeps, 'db' | 'notifier'>, now: Date) {
  if (!(await getSetting(d.db, 'school.on'))) return
  const day = mskDay(now.getTime())
  const [asked] = await d.db
    .execute(sql`select 1 from core.job_run where name = 'interview_asked' and day = ${day}`)
    .then((r) => r.rows)
  if (asked) return
  const [q] = await interviewQueue(d.db, now, 1)
  if (!q) return
  const notice = await takeNotice(d.db, now, 'interview')
  if (!notice) return
  // A question Telegram refused gives the day's place back and goes on the next tick.
  await askOwnQuestion(
    d,
    { kind: 'interview', entityId: q.gapKey, text: SCHOOL_TEXTS.interviewAsk(q.question) },
    now,
  ).catch(async (e) => {
    await releaseNotice(d.db, notice)
    throw e
  })
  await d.db.insert(jobRun).values({ name: 'interview_asked', day }).onConflictDoNothing()
}
