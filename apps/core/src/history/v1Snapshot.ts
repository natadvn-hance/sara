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

const DATE_KEYS = new Set([
  'respondedAt',
  'borisWroteAt',
  'takenByBorisAt',
  'replyApprovedAt',
  'createdAt',
  'updatedAt',
])
/** A v1 date as ISO; an empty or broken one is missing, so no rule ever goes by it. */
const date = (v: string | null): string | null => {
  if (!v?.trim()) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
/** The day v1 began, the last resort for a lead whose two own dates are both broken. */
const EPOCH = '1970-01-01T00:00:00.000Z'

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
      for (const [key, column] of Object.entries(COLUMNS)) {
        const v = present.has(column) ? str(r[column]) : null
        lead[key] = DATE_KEYS.has(key) ? date(v) : v
      }
      // The made-up times of v1-only messages are built from these two: each falls back to the other.
      const created = lead.createdAt
      lead.createdAt = created ?? lead.updatedAt ?? EPOCH
      lead.updatedAt = lead.updatedAt ?? created ?? EPOCH
      return { lead: lead as unknown as V1Lead, dated: created !== null }
    })
    if (leads.length === 0) throw new Error(`В снимке v1 нет ни одного заказа: ${path}`)
    // v1 began with its earliest lead that has a real date of its own.
    const starts = leads
      .filter((l) => l.dated)
      .map((l) => l.lead.createdAt)
      .sort()
    return { leads: leads.map((l) => l.lead), startedAt: starts[0] ?? EPOCH }
  } finally {
    db.close()
  }
}
