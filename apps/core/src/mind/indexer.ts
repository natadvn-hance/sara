import { newEventId } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { mindIndex } from '../db/schema'
import { appendEvent } from '../journal/journal'
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
    tsv: sql`setweight(to_tsvector('russian', ${head}), 'A') || setweight(to_tsvector('russian', ${r.body}), 'B')`,
  }
}

/**
 * Rebuilds core.mind_index from the mind folder when its version changed (FR-MIND-2), in one transaction. An empty
 * index counts as changed; so does a record that came into or went out of force since the last build.
 */
export async function ensureMindIndex(
  db: Db,
  mindDir: string,
): Promise<{ mindVersion: string; records: number; changed: boolean }> {
  const mind = await loadMind(mindDir)
  const today = moscowToday()
  const records = mind.records.filter((r) => inForce(r, today))
  const wanted = records.map((r) => r.front.id).sort()
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('core.mind_index'))`)
    const indexed = await tx
      .select({ id: mindIndex.recordId, mindVersion: mindIndex.mindVersion })
      .from(mindIndex)
    const ids = indexed.map((r) => r.id).sort()
    const same =
      indexed.length > 0 &&
      indexed.every((r) => r.mindVersion === mind.mindVersion) &&
      ids.join('\n') === wanted.join('\n')
    if (same) return { mindVersion: mind.mindVersion, records: indexed.length, changed: false }

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
