import type { ConvStage, MindType, Tone, Topic } from '@sara/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { MindHit, MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { mindIndex } from '../db/schema'
import { CASE_LEXEME, toCaseHit } from './cases'
import { lastIndexedVersion } from './indexer'
import { markdownSections } from './loader'

/**
 * A long text gives at most this many words to the query. The fact search keeps the last ones (the newest words of a
 * conversation); the case search keeps the first ones, so a caller puts the client's own words first and a long order
 * text after them can never push them out.
 */
const MAX_WORDS = 32

/**
 * The words a client asks for a case with, in every form: «есть ли примеры работ», «кейсы», «портфолио». They say that
 * the client wants a case, not which one, and they stand in every case record («Как показывать клиенту», «Роль и
 * масштаб: комплексная работа»), so the case search leaves them out of the query.
 */
const ASKING_WORD =
  /^(?:пример(?:а|ы|у|е|ом|ов|ам|ами|ах)?|кейс(?:а|ы|у|е|ом|ов|ам|ами|ах)?|портфолио|работ(?:а|ы|у|е|ой|ою|ам|ами|ах)?|есть|ли)$/u

/**
 * The lowest `ts_rank_cd` a case needs to be offered (before it, three cases came back for any question, however far).
 * The weights of the case vector are 1.0 for the title and tags, 0.4 for the gist, 0.2 for the sections of the work,
 * and a repeated word adds up. Probes over the 28 real records: a word of the title or tags ranks 1.0 or more
 * («потолками» finds SkyRoom at 1.0, «школы» Музыкальную школу МИО at 1.6, «бухгалтерия на аутсорсинге» 3.4), a word
 * of the gist 0.4 («продвижение» gives Грибатория and SkillCode 0.4); the far cases are a word met once in a section
 * of the work, 0.2 («лендинг» gives LevTrain 0.2, a dental ad question gives Боулинг-клуб 0.2). So 0.35 keeps a case
 * with a word in its title, tags or gist, or with two words of its work, and drops a case that only touches a word
 * once in what it did.
 */
export const CASE_MIN_RANK = 0.35

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

function queryWords(text: string, keep: 'first' | 'last' = 'last'): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3)
  const distinct = [...new Set(words)]
  return keep === 'first' ? distinct.slice(0, MAX_WORDS) : distinct.slice(-MAX_WORDS)
}

/** The words of a case query: the client's words first (the first ones kept), without the words that only ask for a case. */
const caseQueryWords = (text: string): string[] =>
  queryWords(text, 'first').filter((w) => !ASKING_WORD.test(w))

type RankedQuery = {
  words: string[]
  scope: string
  types: MindType[]
  field?: 'body' | 'example_client'
  limit: number
  /** Cases are never facts: the fact search leaves them out, the case search takes only them. */
  cases: 'only' | 'none'
  /** Record ids that must not come back. */
  exclude?: string[]
  /** Hits ranked below this are left out (none when absent). */
  minRank?: number
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
  const marked = sql`${mindIndex.tsv} @@ ${CASE_LEXEME}::tsquery`
  const cases = q.cases === 'only' ? marked : sql`not (${marked})`
  const exclude =
    q.exclude && q.exclude.length > 0
      ? sql`${mindIndex.recordId} not in (${sql.join(
          q.exclude.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`true`
  const floor = q.minRank === undefined ? sql`true` : sql`hit.rank >= ${q.minRank}`
  const rows = await db.execute<Row & { rank: number }>(sql`
    with q as materialized (select ${query} as query)
    select * from (select ${mindIndex.recordId} as id, ${mindIndex.type} as type, ${mindIndex.scope} as scope,
      ${mindIndex.title} as title, ${mindIndex.body} as body, ${mindIndex.topic} as topic,
      ${mindIndex.tones} as tones, ${mindIndex.stages} as stages,
      ${mindIndex.exampleClient} as "exampleClient", ${mindIndex.exampleBoris} as "exampleBoris",
      ts_rank_cd(${vector}, q.query) as rank
    from ${source}
    where (${mindIndex.scope} = 'shared' or ${mindIndex.scope} = ${q.scope})
      and ${types}
      and ${cases}
      and ${exclude}
      and ${vector} @@ q.query) hit
    where ${floor}
    order by hit.rank desc, hit.id
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
        cases: 'none',
      })
    },

    async cases(q) {
      const hits = await ranked(db, {
        words: caseQueryWords(q.text),
        scope: q.scope,
        types: ['knowledge'],
        limit: q.limit,
        cases: 'only',
        exclude: q.exclude,
        minRank: CASE_MIN_RANK,
      })
      return hits.map(toCaseHit)
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
