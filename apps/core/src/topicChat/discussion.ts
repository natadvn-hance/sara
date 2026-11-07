import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { task, topicDiscussion } from '../db/schema'
import { appendEvent } from '../journal/journal'
import type { Notifier } from '../notify/notifier'

/**
 * The discussion of a message in a client's topic (docs/superpowers/specs/2026-11-07-topic-chat-design.md, section 2):
 * Boris's words to the chat there, the transcript of his voice, Sara's lines and her interim versions. Nothing else in
 * a topic is ever deleted: client posts, our sent posts, the intro, the cards.
 */
export type DiscussionKind = 'boris' | 'transcript' | 'sara' | 'version'
export type DiscussionRow = typeof topicDiscussion.$inferSelect

/** Telegram deletes only within 48 hours: an older post is folded at once rather than refused. */
const DELETE_WITHIN_MS = 47 * 3_600_000
/** A bot's post that could not be deleted becomes this one line, without buttons. */
export const FOLDED = '· обсуждение черновика'

/** A post of the discussion; a repeat of the same post is the same row. */
export async function noteDiscussion(
  db: Db,
  r: {
    conversationId: string
    ref: number
    kind: DiscussionKind
    text?: string | null
    taskId?: string | null
    at?: Date
  },
): Promise<void> {
  await db
    .insert(topicDiscussion)
    .values({
      conversationId: r.conversationId,
      ref: r.ref,
      kind: r.kind,
      text: r.text ?? null,
      taskId: r.taskId ?? null,
      ...(r.at && { createdAt: r.at.toISOString() }),
    })
    .onConflictDoNothing()
}

/** The discussion still in the topic, the oldest first. */
export async function openDiscussion(db: Db, conversationId: string): Promise<DiscussionRow[]> {
  return db
    .select()
    .from(topicDiscussion)
    .where(
      and(eq(topicDiscussion.conversationId, conversationId), isNull(topicDiscussion.clearedAt)),
    )
    .orderBy(asc(topicDiscussion.createdAt), asc(topicDiscussion.id))
}

/** The versions' cards still open in the discussion: a newer version or the clearing closes them. */
export async function closeVersions(
  d: { db: Db; notifier: Pick<Notifier, 'markDone'> },
  conversationId: string,
  note: string,
): Promise<void> {
  const rows = (await openDiscussion(d.db, conversationId)).filter(
    (r) => r.kind === 'version' && r.taskId,
  )
  if (rows.length === 0) return
  const closed = await d.db
    .update(task)
    .set({ state: 'resolved', resolution: 'superseded', resolvedAt: new Date().toISOString() })
    .where(
      and(
        inArray(
          task.id,
          rows.map((r) => r.taskId as string),
        ),
        eq(task.state, 'open'),
      ),
    )
    .returning({ id: task.id })
  const ids = new Set(closed.map((c) => c.id))
  for (const r of rows)
    if (r.taskId && ids.has(r.taskId)) await d.notifier.markDone?.(r.ref, note).catch(() => {})
}

/**
 * Our message is in the chat (the topic showed it): its discussion leaves the topic. Each post is deleted; a bot's post
 * Telegram will not delete (no right, older than 48 hours) is folded to one line; Boris's own stays. The rows are marked
 * and their words emptied; the journal keeps only the posts' numbers. Never throws.
 */
export async function clearDiscussion(
  d: { db: Db; notifier: Pick<Notifier, 'deletePost' | 'editText' | 'markDone'>; now?: () => Date },
  conversationId: string,
): Promise<{ deleted: number[]; folded: number[]; kept: number[] }> {
  const out = { deleted: [] as number[], folded: [] as number[], kept: [] as number[] }
  try {
    const rows = await openDiscussion(d.db, conversationId)
    if (rows.length === 0) return out
    const now = d.now?.() ?? new Date()
    const tasks = rows.flatMap((r) => (r.taskId ? [r.taskId] : []))
    if (tasks.length > 0)
      await d.db
        .update(task)
        .set({ state: 'resolved', resolution: 'superseded', resolvedAt: now.toISOString() })
        .where(and(inArray(task.id, tasks), eq(task.state, 'open')))
    for (const r of rows) {
      const fresh = now.getTime() - new Date(r.createdAt).getTime() < DELETE_WITHIN_MS
      let how: 'deleted' | 'folded' | 'kept'
      if (fresh && (await d.notifier.deletePost?.(r.ref))) how = 'deleted'
      else if (r.kind !== 'boris' && d.notifier.editText) {
        how = await d.notifier
          .editText(r.ref, FOLDED)
          .then(() => 'folded' as const)
          .catch(() => 'kept' as const)
      } else how = 'kept'
      out[how].push(r.ref)
      await d.db
        .update(topicDiscussion)
        .set({ clearedAt: now.toISOString(), clearedHow: how, text: null })
        .where(eq(topicDiscussion.id, r.id))
    }
    await appendEvent(d.db, {
      type: 'topic.discussion_cleared',
      v: 1,
      entity: { kind: 'conversation', id: conversationId },
      account_id: null,
      actor: 'system',
      occurred_at: now.toISOString(),
      causation_id: null,
      correlation_id: conversationId,
      reason: null,
      payload: out,
    })
  } catch (e) {
    console.error('discussion not cleared', e instanceof Error ? e.message.slice(0, 200) : e)
  }
  return out
}

/** How many turns of the topic chat ran today (Moscow), for the shared daily cap. */
export async function chatTurnsToday(db: Db, since: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from core.model_call
     where role = 'topic-chat' and duration_ms > 0 and started_at >= ${since}`)
  return r.rows[0]?.n ?? 0
}
