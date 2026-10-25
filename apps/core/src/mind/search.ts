import type { ConvStage, MindType, Tone, Topic } from '@sara/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { MindHit, MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { mindIndex } from '../db/schema'
import { lastIndexedVersion } from './indexer'
import { markdownSections } from './loader'

/** A long order text gives at most this many words to the query, the last ones. */
const MAX_WORDS = 32

const COLUMNS = {
  id: mindIndex.recordId,
  type: mindIndex.type,
  scope: mindIndex.scope,
  title: mindIndex.title,
  body: mindIndex.body,
  topic: mindIndex.topic,
  tones: mindIndex.tones,
  stages: mindIndex.stages,
  exampleClient: mindIndex.exampleClient,
  exampleBoris: mindIndex.exampleBoris,
}

type Row = {
  id: string
  type: string
  scope: string
  title: string
  body: string
  topic: string | null
  tones: unknown
  stages: unknown
  exampleClient: string | null
  exampleBoris: string | null
}

const toHit = (r: Row, rank: number): MindHit => ({
  id: r.id,
  type: r.type as MindType,
  scope: r.scope,
  title: r.title,
  body: r.body,
  topic: r.topic as Topic | null,
  tones: r.tones as Tone[],
  stages: r.stages as ConvStage[],
  exampleClient: r.exampleClient,
  exampleBoris: r.exampleBoris,
  rank,
})

function queryWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3)
  return [...new Set(words)].slice(-MAX_WORDS)
}

type RankedQuery = {
  words: string[]
  scope: string
  types: MindType[]
  field?: 'body' | 'example_client'
  limit: number
}

/**
 * The best hits for the words, highest rank first. The query is built once in a materialized CTE and the rank once in
 * the select list, so a long query costs one pass over the matching rows, not one per use of the expression.
 */
async function ranked(db: Db, q: RankedQuery): Promise<MindHit[]> {
  if (q.words.length === 0 || q.limit <= 0) return []
  const query = sql.join(
    q.words.map((w) => sql`plainto_tsquery('russian', ${w})`),
    sql` || `,
  )
  // The example text has no stored vector: it is made once per row in a lateral step, not once per use.
  const example = q.field === 'example_client'
  const vector = example ? sql`l.v` : sql`${mindIndex.tsv}`
  const source = example
    ? sql`${mindIndex} cross join q cross join lateral (select to_tsvector('russian', coalesce(${mindIndex.exampleClient}, '')) as v offset 0) l`
    : sql`${mindIndex} cross join q`
  const types =
    q.types.length > 0
      ? sql`${mindIndex.type} in (${sql.join(
          q.types.map((t) => sql`${t}`),
          sql`, `,
        )})`
      : sql`true`
  const rows = await db.execute<Row & { rank: number }>(sql`
    with q as materialized (select ${query} as query)
    select ${mindIndex.recordId} as id, ${mindIndex.type} as type, ${mindIndex.scope} as scope,
      ${mindIndex.title} as title, ${mindIndex.body} as body, ${mindIndex.topic} as topic,
      ${mindIndex.tones} as tones, ${mindIndex.stages} as stages,
      ${mindIndex.exampleClient} as "exampleClient", ${mindIndex.exampleBoris} as "exampleBoris",
      ts_rank_cd(${vector}, q.query) as rank
    from ${source}
    where (${mindIndex.scope} = 'shared' or ${mindIndex.scope} = ${q.scope})
      and ${types}
      and ${vector} @@ q.query
    order by rank desc, ${mindIndex.recordId}
    limit ${q.limit}`)
  return rows.rows.map((r) => toHit(r, Number(r.rank)))
}

const unquote = (s: string) => s.replace(/^[«"“](.*)[»"”]$/, '$1').trim()

/**
 * Search over the confirmed mind (FR-MIND-2): Russian full text, every word of three letters or more through
 * `plainto_tsquery`, joined by OR, ranked by `ts_rank_cd`. A direction sees the shared records and its own.
 */
export function createMindSearch(db: Db): MindSearch {
  const inScope = (scope: string) => or(eq(mindIndex.scope, 'shared'), eq(mindIndex.scope, scope))
  return {
    async version() {
      const [r] = await db.select({ v: mindIndex.mindVersion }).from(mindIndex).limit(1)
      // An index without records still knows the version it was built for.
      return r?.v ?? (await lastIndexedVersion(db)) ?? 'empty'
    },

    async search(q) {
      return ranked(db, {
        words: queryWords(q.text),
        scope: q.scope,
        types: q.types,
        field: q.field,
        limit: q.limit,
      })
    },

    async byIds(ids) {
      const wanted = [...new Set(ids)]
      if (wanted.length === 0) return []
      const rows = await db
        .select(COLUMNS)
        .from(mindIndex)
        .where(inArray(mindIndex.recordId, wanted))
      const byId = new Map(rows.map((r) => [r.id, r]))
      return wanted.flatMap((id) => {
        const r = byId.get(id)
        return r ? [toHit(r, 0)] : []
      })
    },

    async byStage(stage, scope) {
      const [r] = await db
        .select(COLUMNS)
        .from(mindIndex)
        .where(
          and(
            eq(mindIndex.type, 'judgment'),
            inScope(scope),
            sql`${mindIndex.stages} @> ${JSON.stringify([stage])}::jsonb`,
          ),
        )
        .orderBy(sql`(${mindIndex.scope} = ${scope}) desc`, mindIndex.recordId)
        .limit(1)
      return r ? toHit(r, 0) : null
    },

    async bannedPhrases() {
      const [r] = await db
        .select({ body: mindIndex.body })
        .from(mindIndex)
        .where(eq(mindIndex.recordId, 's-portrait'))
      const section = r ? markdownSections(r.body)['Никогда не говорит'] : undefined
      return (section ?? '')
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => unquote(l.slice(2).trim()))
        .filter((l) => l.length > 0)
    },
  }
}
