import { type FileRead, LeadSite, type OrderAttachment } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { lead } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { studyFiles } from './files'
import { linkTargets, studyLinks } from './links'
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
    links: site.links?.length ?? 0,
    links_opened: site.links?.filter((l) => l.opened).length ?? 0,
    files: site.files?.length ?? 0,
    files_opened: site.files?.filter((f) => f.opened).length ?? 0,
    digest: site.digest != null,
  }
}

/**
 * The other links of the text (documents, social pages, examples the client likes) are read once, those not read before;
 * what they hold is summed up for the Analyst (Boris, 30.10.2026 evening). A link already read is not read again.
 */
async function withLinks(
  d: StudyDeps,
  i: {
    text: string
    order: SiteOrder
    names?: string[]
    correlationId: string
    causationId?: string
    attachments?: OrderAttachment[]
  },
  before: LeadSite | null,
  site: LeadSite | null,
): Promise<LeadSite | null> {
  const base: LeadSite = site ?? { own: null, examples: [] }
  const have = new Set((before?.links ?? []).map((l) => l.domain))
  const fresh = linkTargets(i.text, base.examples).filter((t) => !have.has(t.domain))
  const seenFiles = new Set((before?.files ?? []).map((f) => f.name))
  const newFiles = (i.attachments ?? []).filter((a) => !seenFiles.has(a.name || 'файл'))
  if (fresh.length === 0 && newFiles.length === 0)
    return site
      ? { ...base, links: before?.links, files: before?.files, digest: before?.digest }
      : before
  const read =
    newFiles.length > 0
      ? await studyFiles(newFiles, { fetchPage: d.fileFetch })
      : { files: [] as FileRead[], texts: [] }
  const got = await studyLinks(d, {
    targets: fresh,
    files: read.texts,
    order: i.order,
    ownSummary: base.own?.brief?.summary ?? null,
    before: before?.digest?.summary ?? null,
    names: i.names,
    correlationId: i.correlationId,
    causationId: i.causationId,
  })
  return {
    ...base,
    links: [...(before?.links ?? []), ...got.links].slice(0, 6),
    files: [...(before?.files ?? []), ...read.files].slice(0, 12),
    digest: got.digest ?? before?.digest ?? null,
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
    /** The files the order page carries (Boris, 30.10.2026 evening). */
    attachments?: OrderAttachment[]
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
    const full = await withLinks(d, i, before, site)
    if (!full || JSON.stringify(full) === JSON.stringify(before)) return full ?? before
    await d.db.transaction(async (tx) => {
      await tx.update(lead).set({ clientSite: full }).where(eq(lead.id, i.leadId))
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
        payload: siteEventPayload(full, i.source, limited),
      })
    })
    return full
  } catch (e) {
    console.error('lead site not kept', e instanceof Error ? e.message.slice(0, 200) : e)
    return null
  }
}

/** The site a lead holds, as stored; null when it names none or the stored value is unreadable. */
export const leadSiteOf = (stored: unknown): LeadSite | null =>
  LeadSite.safeParse(stored).data ?? null
