import { newEventId } from '@sara/shared'
import { desc, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { event, mindIndex } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { CASE_LEXEME, caseSearchText, isCaseRecord } from './cases'
import { loadMind, type MindRecord } from './loader'

const moscowToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

/** Only confirmed records valid today by Moscow get into the index (FR-MIND-3). */
function inForce(r: MindRecord, today: string): boolean {
  const f = r.front
  return (
    f.status === 'confirmed' &&
    f.valid_from <= today &&
    (f.valid_to === null || today <= f.valid_to)
  )
}

function toRow(r: MindRecord, mindVersion: string) {
  const f = r.front
  const example = f.type === 'example'
  const head = [r.title, ...(f.tags ?? [])].join(' ')
  return {
    recordId: f.id,
    path: r.path,
    type: f.type,
    scope: f.scope,
    topic: f.topic ?? null,
    tones: f.tones ?? [],
    stages: f.stages ?? [],
    title: r.title,
    body: r.body,
    exampleClient: example ? r.sections.Клиент || null : null,
    exampleBoris: example ? r.sections.Борис || null : null,
    version: f.version,
    mindVersion,
    tsv: isCaseRecord(f)
      ? caseVector(r)
      : sql`setweight(to_tsvector('russian', ${head}), 'A') || setweight(to_tsvector('russian', ${r.body}), 'B')`,
  }
}

/**
 * The vector of a case: only its title, tags, gist and the sections of the work (title and tags first, then the gist,
 * then the sections), not the rules of showing or the state of the description. It also carries the marker lexeme, so
 * the fact search can leave the case out and the case search can find it.
 */
function caseVector(r: MindRecord) {
  const { head, summary, details } = caseSearchText(r.title, r.front.tags ?? [], r.body)
  return sql`setweight(to_tsvector('russian', ${head}), 'A') || setweight(to_tsvector('russian', ${summary}), 'B') || setweight(to_tsvector('russian', ${details}), 'C') || ${CASE_LEXEME}::tsvector`
}

/** The mind version the index was last built for, from the journal; null before the first build. */
export async function lastIndexedVersion(db: DbOrTx): Promise<string | null> {
  const [r] = await db
    .select({ version: event.entityId })
    .from(event)
    .where(eq(event.type, 'mind.indexed'))
    .orderBy(desc(event.recordedAt), desc(event.occurredAt))
    .limit(1)
  return r?.version ?? null
}

/** What the core says about a record it could not load: where and why, never the text of the record. */
const logLoadError = (e: { path: string; message: string }) =>
  console.error('mind: record not loaded', e.path, e.message)

/**
 * Rebuilds core.mind_index from the mind folder when its version changed (FR-MIND-2), in one transaction. An empty
 * index counts as changed only when the mind version it was last built for differs; so does a record that came into
 * or went out of force since the last build.
 *
 * Call it at startup and then periodically (the app does it every hour): a record leaves the index at the end of its
 * `valid_to` day and enters it on its `valid_from` day by Moscow, and no new commit announces that. The no-change path
 * stays cheap for this: it reads the folder, compares the ids and the version and writes nothing.
 *
 * The folder is read after the build lock is taken, so two callers never replace a newer index with an older reading.
 * Each record that could not be loaded goes to `onLoadError` (by default the log, with its path and message) when the
 * index is rebuilt.
 */
export async function ensureMindIndex(
  db: Db,
  mindDir: string,
  onLoadError: (e: { path: string; message: string }) => void = logLoadError,
): Promise<{ mindVersion: string; records: number; changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('core.mind_index'))`)
    const mind = await loadMind(mindDir)
    const records = mind.records.filter((r) => inForce(r, moscowToday()))
    const wanted = records.map((r) => r.front.id).sort()
    const indexed = await tx
      .select({ id: mindIndex.recordId, mindVersion: mindIndex.mindVersion })
      .from(mindIndex)
    const ids = indexed.map((r) => r.id).sort()
    // An index without records keeps no version of its own: the journal remembers what it was last built for.
    const builtFor = indexed[0]?.mindVersion ?? (await lastIndexedVersion(tx))
    const same =
      builtFor === mind.mindVersion &&
      indexed.every((r) => r.mindVersion === mind.mindVersion) &&
      ids.join('\n') === wanted.join('\n')
    if (same) return { mindVersion: mind.mindVersion, records: indexed.length, changed: false }

    for (const e of mind.errors) onLoadError(e)
    await tx.delete(mindIndex)
    for (let i = 0; i < records.length; i += 500) {
      await tx
        .insert(mindIndex)
        .values(records.slice(i, i + 500).map((r) => toRow(r, mind.mindVersion)))
    }
    await appendEvent(tx, {
      type: 'mind.indexed',
      v: 1,
      entity: { kind: 'mind', id: mind.mindVersion },
      account_id: null,
      actor: 'system',
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: {
        mind_version: mind.mindVersion,
        records: records.length,
        errors: mind.errors.length,
      },
    })
    return { mindVersion: mind.mindVersion, records: records.length, changed: true }
  })
}
