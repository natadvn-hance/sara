import { MIND_TYPES, type MindRecordView, type MindView } from '@sara/shared'
import { asc, desc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { convTurn, mindIndex, mindProposal } from '../db/schema'

/** «Разум Сары» (M7 design 5.5), read only: what she knows, what she proposes and what she lacked. */

const TYPE_RU: Record<string, string> = {
  knowledge: 'Знание',
  understanding: 'Понимание',
  speech: 'Речь',
  judgment: 'Суждение',
  example: 'Образцы',
}

export async function mindView(db: DbOrTx): Promise<MindView> {
  const rows = await db
    .select({
      id: mindIndex.recordId,
      type: mindIndex.type,
      scope: mindIndex.scope,
      title: mindIndex.title,
      topic: mindIndex.topic,
      version: mindIndex.version,
      mindVersion: mindIndex.mindVersion,
    })
    .from(mindIndex)
    .orderBy(asc(mindIndex.type), asc(mindIndex.title))
  const types = [...new Set([...MIND_TYPES, ...rows.map((r) => r.type)])]
  const proposals = await db
    .select()
    .from(mindProposal)
    .orderBy(desc(mindProposal.createdAt))
    .limit(50)
  const gaps = await db.execute<{ text: string; topic: string | null; count: number }>(sql`
    select min(text) as text, topic, count(*)::int as count from core.mind_gap
    where lesson_id is null and created_at > now() - interval '30 days'
    group by lower(text), topic order by count(*) desc limit 10`)
  return {
    mindVersion: rows[0]?.mindVersion ?? null,
    groups: types.map((type) => ({
      type,
      title: TYPE_RU[type] ?? type,
      records: rows.filter((r) => r.type === type).map(({ mindVersion: _, ...r }) => r),
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      path: p.path,
      kind: p.kind,
      source: p.source,
      state: p.state,
      action: p.action,
      at: p.createdAt,
      preview: p.content.replace(/^---[\s\S]*?---\s*/, '').slice(0, 280),
    })),
    gaps: gaps.rows,
  }
}

export async function mindRecordView(db: DbOrTx, id: string): Promise<MindRecordView | null> {
  const [r] = await db.select().from(mindIndex).where(eq(mindIndex.recordId, id))
  if (!r) return null
  // Where the record was used: the last 20 turns that named it among their facts or examples.
  const used = await db
    .select({
      turnId: convTurn.id,
      conversationId: convTurn.conversationId,
      at: convTurn.createdAt,
    })
    .from(convTurn)
    .where(
      sql`${convTurn.factIds} @> ${JSON.stringify([id])}::jsonb or ${convTurn.exampleIds} @> ${JSON.stringify([id])}::jsonb`,
    )
    .orderBy(desc(convTurn.createdAt))
    .limit(20)
  const proposals = await db
    .select({
      id: mindProposal.id,
      state: mindProposal.state,
      action: mindProposal.action,
      at: mindProposal.createdAt,
    })
    .from(mindProposal)
    .where(eq(mindProposal.recordId, id))
    .orderBy(desc(mindProposal.createdAt))
  return {
    record: {
      id: r.recordId,
      type: r.type,
      scope: r.scope,
      title: r.title,
      topic: r.topic,
      version: r.version,
      body: r.body,
      exampleClient: r.exampleClient,
      exampleBoris: r.exampleBoris,
      path: r.path,
      tones: (r.tones as string[]) ?? [],
      stages: (r.stages as string[]) ?? [],
    },
    used,
    proposals,
  }
}
