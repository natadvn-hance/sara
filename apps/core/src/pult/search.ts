import type { SearchHit, SearchView } from '@sara/shared'
import { desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { conversation, lead, mindIndex } from '../db/schema'

/**
 * The search (pult v2 design 9): an order by its number first, then leads by title and text, clients by name,
 * records of the mind by title. Up to five of a kind; the pult adds its own sections on its side.
 */
export async function searchView(db: DbOrTx, q: string): Promise<SearchView> {
  const needle = q.trim()
  const hits: SearchHit[] = []
  if (needle.length < 2) return { q: needle, hits }
  const like = `%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`
  const leads = await db
    .select()
    .from(lead)
    .where(
      or(
        eq(lead.id, needle),
        ilike(lead.title, like),
        ilike(lead.text, like),
        ilike(lead.clientName, like),
      ),
    )
    .orderBy(sql`case when ${lead.id} = ${needle} then 0 else 1 end`, desc(lead.seenAt))
    .limit(5)
  for (const l of leads)
    hits.push({
      kind: 'lead',
      id: l.id,
      title: l.title,
      sub: [l.city, l.clientName || null, `№ ${l.id}`].filter(Boolean).join(' · '),
      link: `/leads/${encodeURIComponent(l.id)}`,
    })
  // A client is known by the name on the order of the chat.
  const named = await db
    .select({ id: lead.id, name: lead.clientName, title: lead.title })
    .from(lead)
    .where(ilike(lead.clientName, like))
    .limit(20)
  if (named.length) {
    const convs = await db
      .select()
      .from(conversation)
      .where(
        inArray(
          conversation.orderId,
          named.map((n) => n.id),
        ),
      )
      .orderBy(desc(conversation.updatedAt))
      .limit(5)
    for (const c of convs) {
      const n = named.find((x) => x.id === c.orderId)
      hits.push({
        kind: 'client',
        id: c.id,
        title: n?.name ?? 'Клиент',
        sub: n?.title ?? null,
        link: `/clients/${c.id}`,
      })
    }
  }
  const records = await db
    .select({
      id: mindIndex.recordId,
      title: mindIndex.title,
      type: mindIndex.type,
      topic: mindIndex.topic,
    })
    .from(mindIndex)
    .where(ilike(mindIndex.title, like))
    .limit(5)
  for (const r of records)
    hits.push({
      kind: 'mind',
      id: r.id,
      title: r.title,
      sub: [r.type, r.topic].filter(Boolean).join(' · ') || null,
      link: `/mind/${encodeURIComponent(r.id)}`,
    })
  return { q: needle, hits: hits.slice(0, 20) }
}
