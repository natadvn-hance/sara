import { asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, conversation, forumTopic, lead } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { firstName } from '../leads/clientName'
import { bidTextDetail } from '../leads/draft'
import { markShown, shownRefs, topicIntro } from '../notify/forum'
import type { Notifier } from '../notify/notifier'
import { bidPost, clientPost, ourPost, restoredNote, seriesPost } from '../notify/topicPosts'
import { NOT_TEST } from '../testLeads/sql'

/**
 * The topic as the chat with the client (Boris, 01.11: «имитация чата, с настоящими датами и всеми письмами»): the
 * bids, the messages after them and the chat of the client, every one with its real date, in order, once. A topic made
 * by the earlier code shows only some of that, so each topic gets one pass: its first post is laid out anew, an early
 * bid post of the old kind is rewritten in place, and what is missing is added at the end, quietly, with a line before
 * it that says the topic was opened later. Nothing is deleted. Where the order cannot be kept (the topic already shows
 * newer messages and older ones are missing) nothing is added and the key is listed for Boris to decide.
 */

export type RestoreDeps = {
  db: Db
  notifier: Pick<Notifier, 'sendText' | 'editText' | 'topicPosts' | 'forumOn'>
  /** The pause between two posts of a topic (Telegram lets about twenty a minute into a group). */
  pauseMs?: number
}

/** Bids this young get a topic made after the fact. */
const BACKFILL_DAYS = 30
const POST_PAUSE_MS = 3_500

type Item = {
  ref: string
  at: string
  kind: 'bid' | 'series' | 'client' | 'ours'
  html: string
}

const placeOf = (key: string) =>
  key.startsWith('conv:') ? { conversation: key.slice(5) } : { order: key }

const minutes = (n: number) => n * 60_000

/** The whole talk of a key, as posts, oldest first. */
export async function historyOf(db: Db, key: string): Promise<Item[]> {
  const orderId = key.startsWith('conv:') ? null : key
  const [l] = orderId ? await db.select().from(lead).where(eq(lead.id, orderId)) : []
  const [conv] = key.startsWith('conv:')
    ? await db
        .select()
        .from(conversation)
        .where(eq(conversation.id, key.slice(5)))
    : await db.select().from(conversation).where(eq(conversation.orderId, key))
  const events = orderId
    ? ((
        await db.execute(sql`
          select type, occurred_at, payload from core.event
          where entity_kind = 'lead' and entity_id = ${orderId} and type in ('bid.sent', 'bid.series_sent')
          order by occurred_at asc`)
      ).rows as { type: string; occurred_at: string; payload: Record<string, unknown> }[])
    : []
  const bidEv = events.find((e) => e.type === 'bid.sent')
  const seriesEv = events.filter((e) => e.type === 'bid.series_sent')
  const msgs = conv
    ? await db
        .select()
        .from(chatMessage)
        .where(eq(chatMessage.conversationId, conv.id))
        .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
    : []
  const name = l?.clientName ? firstName(l.clientName) : null
  const ours = msgs.filter((m) => m.side === 'specialist')
  const t = (iso: string) => new Date(iso).getTime()

  const items: Item[] = []
  const used = new Set<string>()
  if (bidEv) {
    const at = new Date(bidEv.occurred_at).toISOString()
    const bidMsg = ours.find((m) => Math.abs(t(m.sentAt) - t(at)) <= minutes(15))
    if (bidMsg) used.add(bidMsg.platformMessageId)
    let text = bidMsg?.text ?? null
    if (!text && l?.draftText) {
      try {
        text = bidTextDetail(l.draftText, l.clientName, new Date(at)).text
      } catch {
        text = l.draftText
      }
    }
    const spent = Number(bidEv.payload.spent_rub ?? 0)
    items.push({
      ref: 'bid',
      at,
      kind: 'bid',
      html: bidPost({
        at,
        text,
        feeRub: spent > 0 ? spent : null,
        priceFromRub: l?.draftPriceRub ?? null,
        priceToRub: l?.draftPriceToRub ?? null,
      }),
    })
    const followUps = (l?.draftFollowUps ?? []) as string[]
    const total = Math.max(followUps.length, seriesEv.length)
    for (let n = 0; n < seriesEv.length; n++) {
      const ev = seriesEv[n]
      // The message of our side that went when the series event says (an old bid's series may go days after it).
      const msg = ev
        ? ours.find(
            (m) =>
              !used.has(m.platformMessageId) &&
              Math.abs(t(m.sentAt) - t(ev.occurred_at)) <= minutes(10),
          )
        : undefined
      if (msg) used.add(msg.platformMessageId)
      const text2 = msg?.text ?? followUps[n]
      if (!text2 || !ev) continue
      const sentAt = msg?.sentAt ?? new Date(ev.occurred_at).toISOString()
      items.push({
        ref: `series:${n + 1}`,
        at: sentAt,
        kind: 'series',
        html: seriesPost({ at: sentAt, text: text2, n: n + 1, total }),
      })
    }
  }
  for (const m of msgs) {
    if (used.has(m.platformMessageId) || m.text.trim() === '') continue
    if (m.side === 'client')
      items.push({
        ref: `msg:${m.platformMessageId}`,
        at: m.sentAt,
        kind: 'client',
        html: clientPost({ name, at: m.sentAt, text: m.text }),
      })
    else if (m.side === 'specialist')
      items.push({
        ref: `msg:${m.platformMessageId}`,
        at: m.sentAt,
        kind: 'ours',
        html: ourPost({ at: m.sentAt, text: m.text }),
      })
  }
  return items.sort((a, b) => t(a.at) - t(b.at))
}

async function journal(
  db: Db,
  key: string,
  type: 'conv.topic_restored',
  payload: Record<string, unknown>,
) {
  await appendEvent(db, {
    type,
    v: 1,
    entity: { kind: 'topic', id: key },
    account_id: null,
    actor: 'system',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: crypto.randomUUID(),
    reason: null,
    payload,
  })
}

/** One topic: its pass. 'skipped' when the order could not be kept (Boris decides); never throws. */
export async function restoreTopic(
  d: RestoreDeps,
  key: string,
  o: { fresh: boolean },
): Promise<'done' | 'skipped'> {
  const place = placeOf(key)
  const shown = await shownRefs(d.db, key)
  const [topic] = await d.db.select().from(forumTopic).where(eq(forumTopic.key, key))
  const items = await historyOf(d.db, key)
  const posts = (await d.notifier.topicPosts?.(place)) ?? []
  const edit = async (ref: number | undefined, html: string) => {
    if (ref === undefined) return
    try {
      await d.notifier.editText?.(ref, html, undefined, { html: true })
    } catch (e) {
      console.error(
        'topic post not rewritten',
        key,
        e instanceof Error ? e.message.slice(0, 160) : e,
      )
    }
  }
  // 1. The first post, laid out anew.
  if (!o.fresh) await edit(posts[0], (await topicIntro(d.db, key)).intro)

  // 2. What the earlier code showed live: the messages heard after the topic was made.
  const madeAt = topic?.createdAt ? new Date(topic.createdAt).getTime() : Number.POSITIVE_INFINITY
  const live = o.fresh
    ? []
    : items.filter(
        (i) => (i.kind === 'client' || i.kind === 'ours') && new Date(i.at).getTime() >= madeAt,
      )
  for (const i of live) await markShown(d.db, key, i.ref)

  // 3. The bid post of the old kind, rewritten in place; an unsure case is taken as present.
  const bid = items.find((i) => i.kind === 'bid')
  let skipped = false
  if (bid && !shown.has('bid') && !o.fresh) {
    if (posts.length === 2 && live.length === 0) await edit(posts[1], bid.html)
    if (posts.length >= 2) await markShown(d.db, key, 'bid')
    if (posts.length > 2 && live.length > 0) skipped = skipped || false
  }
  const after = await shownRefs(d.db, key)
  const todo = items.filter((i) => !after.has(i.ref))
  // 4. Older messages the topic lacks, while it shows newer ones: the order cannot be kept.
  const newestLive = live
    .map((i) => i.at)
    .sort()
    .at(-1)
  const blocked = newestLive !== undefined && todo.some((i) => i.at < newestLive)
  if (blocked) {
    skipped = true
    await journal(d.db, key, 'conv.topic_restored', { added: 0, order_kept: false })
  } else if (todo.length > 0) {
    const pause = d.pauseMs ?? POST_PAUSE_MS
    const wait = () => (pause > 0 ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve())
    // A topic made just now has the note as its first post already.
    if (!o.fresh) await d.notifier.sendText(restoredNote(), { html: true, quiet: true, place })
    for (const i of todo) {
      await wait()
      await d.notifier.sendText(i.html, { html: true, quiet: true, place })
      await markShown(d.db, key, i.ref)
    }
    await journal(d.db, key, 'conv.topic_restored', { added: todo.length, order_kept: true })
  }
  await markShown(d.db, key, 'restored')
  return skipped ? 'skipped' : 'done'
}

/**
 * One topic a pass: an existing one not yet restored, else the bid with no topic at all (it gets one now, with the
 * note as its first line). Only with a forum. Returns the key done, or null when nothing is left.
 */
export async function restoreNext(d: RestoreDeps, now: Date = new Date()): Promise<string | null> {
  if (!(await d.notifier.forumOn?.())) return null
  const old = await d.db.execute(sql`
    select t.key from core.forum_topic t
    where not exists (select 1 from core.topic_shown s where s.key = t.key and s.ref = 'restored')
    order by t.created_at asc limit 1`)
  const oldKey = (old.rows[0] as { key: string } | undefined)?.key
  if (oldKey) {
    try {
      await restoreTopic(d, oldKey, { fresh: false })
    } catch (e) {
      console.error(
        'topic restore failed',
        oldKey,
        e instanceof Error ? e.message.slice(0, 200) : e,
      )
      // The next pass takes the next one; this one is marked so a broken topic does not stop the rest.
      await markShown(d.db, oldKey, 'restored')
    }
    return oldKey
  }
  const since = new Date(now.getTime() - BACKFILL_DAYS * 24 * 3600_000).toISOString()
  const fresh = await d.db.execute(sql`
    select l.id from core.lead l
    where l.status = 'bid_sent' and l.seen_at >= ${since} and ${NOT_TEST('l.id')}
      and not exists (select 1 from core.forum_topic t where t.key = l.id)
      and not exists (select 1 from core.conversation c where c.order_id = l.id and c.closed_at is not null)
    order by l.seen_at desc limit 1`)
  const id = (fresh.rows[0] as { id: string } | undefined)?.id
  if (!id) return null
  try {
    // The first post makes the topic (and its intro); the pass then adds what happened, in order.
    await d.notifier.sendText(restoredNote(), { html: true, quiet: true, place: { order: id } })
    await restoreTopic(d, id, { fresh: true })
  } catch (e) {
    console.error('topic not made for a bid', id, e instanceof Error ? e.message.slice(0, 200) : e)
    return null
  }
  return id
}

export function startTopicRestore(d: RestoreDeps, tickMs = 60_000): { stop(): void } {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void restoreNext(d)
      .catch((e) => console.error('topic restore failed', e instanceof Error ? e.message : e))
      .finally(() => {
        running = false
      })
  }, tickMs)
  return { stop: () => clearInterval(timer) }
}
