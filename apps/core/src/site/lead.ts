import { LeadSite } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { lead } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { type SiteOrder, type StudyDeps, studyClientSite } from './study'

/** What is kept of a site in the journal: how it went and the code's facts, never the address or any words (ADR-016). */
function siteEventPayload(site: LeadSite, source: 'order' | 'chat', limited: boolean) {
  const own = site.own
  return {
    source,
    found: own !== null,
    status: own?.status ?? null,
    error: own?.error ?? null,
    cms: own?.cms ?? null,
    pages: own?.pages ?? 0,
    brief: own?.brief != null,
    limited,
    examples: site.examples.length,
    signals: own?.signals ?? null,
  }
}

/**
 * Reads the site a text names for one lead, keeps it on the lead and journals how it went. The lead's earlier read
 * (the order's) is not repeated for the same site, so a chat message with the same address costs nothing. Returns the
 * site now on the lead (null: none named), or the lead's earlier one if anything fails; never throws.
 */
export async function studyLeadSite(
  d: StudyDeps,
  i: {
    leadId: string
    correlationId: string
    text: string
    source: 'order' | 'chat'
    order: SiteOrder
    names?: string[]
    causationId?: string
  },
): Promise<LeadSite | null> {
  try {
    const [row] = await d.db
      .select({ site: lead.clientSite })
      .from(lead)
      .where(eq(lead.id, i.leadId))
    const before = LeadSite.safeParse(row?.site).data ?? null
    const { site, limited } = await studyClientSite(d, {
      text: i.text,
      source: i.source,
      order: i.order,
      names: i.names,
      known: before,
      correlationId: i.correlationId,
      causationId: i.causationId,
    })
    if (!site || JSON.stringify(site) === JSON.stringify(before)) return site ?? before
    await d.db.transaction(async (tx) => {
      await tx.update(lead).set({ clientSite: site }).where(eq(lead.id, i.leadId))
      await appendEvent(tx, {
        type: 'lead.site_read',
        v: 1,
        entity: { kind: 'lead', id: i.leadId },
        account_id: 'hance-marketing',
        actor: 'sara',
        occurred_at: (d.now?.() ?? new Date()).toISOString(),
        causation_id: i.causationId ?? null,
        correlation_id: i.correlationId,
        reason: null,
        payload: siteEventPayload(site, i.source, limited),
      })
    })
    return site
  } catch (e) {
    console.error('lead site not kept', e instanceof Error ? e.message.slice(0, 200) : e)
    return null
  }
}

/** The site a lead holds, as stored; null when it names none or the stored value is unreadable. */
export const leadSiteOf = (stored: unknown): LeadSite | null =>
  LeadSite.safeParse(stored).data ?? null
