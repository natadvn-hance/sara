import { DatabaseSync } from 'node:sqlite'

/** One order of old Sara (the `leads` table of profi-leads.db), the fields the history export reads. */
export type V1Lead = {
  orderId: string
  clientName: string | null
  description: string | null
  category: string | null
  city: string | null
  status: string
  draftResponse: string | null
  /** The Analyst's text when Boris edited the bid; null: not edited, or a snapshot from before the column. */
  draftResponseOriginal: string | null
  respondedAt: string | null
  /** Boris's own words from the chat, glued by v1 with a blank line and cut to the last 1000 characters. */
  borisWroteText: string | null
  borisWroteAt: string | null
  takenByBorisAt: string | null
  dictatedReply: string | null
  proposedReply: string | null
  replyApprovedAt: string | null
  customerReply: string | null
  createdAt: string
  updatedAt: string
}

const COLUMNS: Record<Exclude<keyof V1Lead, 'orderId'>, string> = {
  clientName: 'client_name',
  description: 'description',
  category: 'category',
  city: 'city',
  status: 'status',
  draftResponse: 'draft_response',
  draftResponseOriginal: 'draft_response_original',
  respondedAt: 'responded_at',
  borisWroteText: 'boris_wrote_text',
  borisWroteAt: 'boris_wrote_at',
  takenByBorisAt: 'taken_by_boris_at',
  dictatedReply: 'dictated_reply',
  proposedReply: 'proposed_reply',
  replyApprovedAt: 'reply_approved_at',
  customerReply: 'customer_reply',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
}

/** A copy of old Sara's database, opened so that nothing can write to it (M4 design 5.1). */
export function openV1Snapshot(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** Every lead of the snapshot; a column the old file does not have yet reads as null. */
export function readV1Snapshot(path: string): { leads: V1Lead[]; startedAt: string } {
  const db = openV1Snapshot(path)
  try {
    const present = new Set(
      db
        .prepare('PRAGMA table_info(leads)')
        .all()
        .map((r) => String(r.name)),
    )
    if (!present.has('id')) throw new Error(`В снимке v1 нет таблицы leads: ${path}`)
    const rows = db.prepare('SELECT * FROM leads ORDER BY created_at, id').all()
    const leads = rows.map((r) => {
      const lead = { orderId: String(r.id) } as Record<string, string | null>
      for (const [key, column] of Object.entries(COLUMNS))
        lead[key] = present.has(column) ? str(r[column]) : null
      return lead as unknown as V1Lead
    })
    const first = leads[0]
    if (!first) throw new Error(`В снимке v1 нет ни одного заказа: ${path}`)
    return { leads, startedAt: first.createdAt }
  } finally {
    db.close()
  }
}
