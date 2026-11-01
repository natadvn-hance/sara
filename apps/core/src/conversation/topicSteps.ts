import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { forumTopic, jobRun, topicStep } from '../db/schema'
import { STAGE_DOT } from '../notify/forum'
import type { Notifier } from '../notify/notifier'
import { stageForKey } from '../pult/clients'

/**
 * What goes on with a client, in his topic (Boris, 01.11: «микро-шаги типа "прочитано"», and the stage in the name):
 * the circle of the stage in the topic's name follows the client's stage, and a few short quiet messages say what
 * really happened, once each. Both are read from the journal and the tables on a tick, so no other code has to know
 * about the topic.
 */

export type StepDeps = {
  db: Db
  notifier: Pick<Notifier, 'sendText' | 'setTopicStage' | 'forumOn'>
  /**
   * The order page read now. `profi.order_gone` alone says an order left the board of new orders, which an order
   * with a bid on it does too (Boris, 01.11: «Как понять закрыто если не закрыто?»), so «Заказ закрыт на сайте» is
   * shown only when the page itself says it is closed; without this the step is never shown.
   */
  getOrder?: (accountId: string, orderId: string) => Promise<{ open: boolean; from_page?: boolean }>
}

/** An order whose page said it is open is not asked again for this long. */
const RECHECK_MS = 30 * 60_000
const asked = new Map<string, number>()

/** Journal events this old are not news: a topic shows only what happened since it was made. */
const STEP_DAYS = 2

/** Topics renamed in one tick. */
const MAX_RENAMES = 5

const STEPS = {
  read: '👁 Клиент прочитал отклик',
  call_booked: '📞 Созвон назначен',
  order_closed: '📁 Заказ закрыт на сайте',
} as const
type Step = keyof typeof STEPS

const placeOf = (key: string) =>
  key.startsWith('conv:') ? { conversation: key.slice(5) } : { order: key }

/** The topics, from the journal: who read, whose call was booked, whose order closed, after the topic was made. */
async function news(db: Db, since: string): Promise<{ key: string; step: Step }[]> {
  const res = await db.execute(sql`
    select distinct t.key, 'read' as step
    from core.event e
    join core.conversation c on c.chat_id = e.payload->>'chat_id' and c.account_id = e.account_id
    join core.forum_topic t on t.key = coalesce(c.order_id, 'conv:' || c.id::text)
    where e.type = 'profi.client_read' and e.occurred_at >= ${since} and e.occurred_at >= t.created_at
    union
    select distinct t.key, 'call_booked' as step
    from core.event e
    join core.deal dl on dl.id::text = e.entity_id
    join core.forum_topic t on t.key = dl.lead_id
    where e.type = 'deal.stage_changed' and e.payload->>'to' = 'call_booked'
      and e.occurred_at >= ${since} and e.occurred_at >= t.created_at
    union
    select distinct t.key, 'order_closed' as step
    from core.event e
    join core.forum_topic t on t.key = e.entity_id
    where e.type = 'profi.order_gone' and e.entity_kind = 'order'
      and e.occurred_at >= ${since} and e.occurred_at >= t.created_at`)
  return (res.rows as { key: string; step: Step }[]).filter((r) => r.step in STEPS)
}

/** The page of the order says it is closed, read now; anything else (open, unknown, an old reading) is no. */
async function orderIsClosed(d: StepDeps, key: string, now: Date): Promise<boolean> {
  if (!d.getOrder || key.startsWith('conv:')) return false
  const last = asked.get(key)
  if (last !== undefined && now.getTime() - last < RECHECK_MS) return false
  asked.set(key, now.getTime())
  try {
    const res = await d.db.execute(sql`select account_id from core.lead where id = ${key}`)
    const account = (res.rows[0] as { account_id: string } | undefined)?.account_id
    if (!account) return false
    const o = await d.getOrder(account, key)
    return o.open === false && o.from_page === true
  } catch (e) {
    console.error(
      'order page not read for the closed step',
      key,
      e instanceof Error ? e.message.slice(0, 160) : e,
    )
    return false
  }
}

/** Each step goes once per topic, quietly, in the order the events happened. */
export async function topicSteps(d: StepDeps, now: Date): Promise<number> {
  if (!(await d.notifier.forumOn?.())) return 0
  const since = new Date(now.getTime() - STEP_DAYS * 24 * 3600_000).toISOString()
  let shown = 0
  for (const n of await news(d.db, since)) {
    const claimed = await d.db
      .insert(topicStep)
      .values({ key: n.key, step: n.step })
      .onConflictDoNothing()
      .returning({ key: topicStep.key })
    if (claimed.length === 0) continue
    if (n.step === 'order_closed' && !(await orderIsClosed(d, n.key, now))) {
      // Not closed (or not known): nothing to show, and the claim goes so that a real closing is still shown.
      await d.db.delete(topicStep).where(sql`key = ${n.key} and step = ${n.step}`)
      continue
    }
    try {
      await d.notifier.sendText(STEPS[n.step], { quiet: true, place: placeOf(n.key) })
      shown++
    } catch (e) {
      // Not shown: the claim goes, so the next tick tries again.
      await d.db.delete(topicStep).where(sql`key = ${n.key} and step = ${n.step}`)
      console.error(
        'topic step not shown',
        n.step,
        e instanceof Error ? e.message.slice(0, 200) : e,
      )
    }
  }
  return shown
}

/** The circle in the name of every open topic follows the stage of its client; only a changed one is touched. */
export async function topicStages(d: StepDeps): Promise<number> {
  if (!(await d.notifier.forumOn?.())) return 0
  const topics = await d.db
    .select({ key: forumTopic.key, name: forumTopic.name, closedAt: forumTopic.closedAt })
    .from(forumTopic)
  let changed = 0
  for (const t of topics) {
    // A few a tick: Telegram limits renaming, and the first tick after a deploy meets every topic without a circle.
    if (changed >= MAX_RENAMES) break
    const dot = STAGE_DOT[await stageForKey(d.db, t.key)]
    if (t.name.startsWith(`${dot} `)) continue
    await d.notifier.setTopicStage?.(placeOf(t.key), dot)
    changed++
  }
  return changed
}

/**
 * Once: «Заказ закрыт на сайте» was shown after every bid, from `profi.order_gone` alone (an order with a bid leaves the
 * board of new orders). The marks that said so are cleared, so the step can be shown again, but only when the page of the
 * order says it is closed.
 */
export async function resetFalseClosedSteps(db: Db): Promise<number> {
  const taken = await db
    .insert(jobRun)
    .values({ name: 'topic_step_closed_reset', day: '2000-01-01' })
    .onConflictDoNothing()
    .returning({ day: jobRun.day })
  if (taken.length === 0) return 0
  const gone = await db
    .delete(topicStep)
    .where(sql`step = 'order_closed'`)
    .returning({ key: topicStep.key })
  return gone.length
}
