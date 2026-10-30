import { type SiteCms, SiteCms as SiteCmsSchema, type SiteSignals } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { modelCall, siteCache } from '../db/schema'
import {
  cmsOf,
  importantLinks,
  mergeSigns,
  type PageSigns,
  type PageText,
  pageSigns,
  pageText,
} from './extract'
import { type FetchError, type Fetched, fetchPage } from './fetch'
import { hostOf } from './find'

/** The pages of a site as the code took them out: what the model reads and what the signals say. */
export type Digest = {
  domain: string
  /** The address the home page finally answered from. */
  url: string
  status: 'ok' | 'failed'
  error: string | null
  deep: boolean
  cms: SiteCms | null
  signals: SiteSignals | null
  pages: PageText[]
}

/** A site is read once a day per domain; one that did not open is tried again after half an hour. */
export const CACHE_OK_MS = 24 * 60 * 60 * 1000
export const CACHE_FAILED_MS = 30 * 60 * 1000

/** The home page and up to this many of the important ones (services, prices, about, cases). */
export const EXTRA_PAGES = 3
/** The whole reading of one site is over by then, whatever the pages do. */
const SITE_DEADLINE_MS = 25_000

/** What of a page the model is given: enough to see the offer, not the whole site. */
const HOME_CHARS = 3_000
const PAGE_CHARS = 1_500

export type ReadDeps = {
  db: Db
  fetchPage?: (url: string) => Promise<Fetched>
  now?: () => Date
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s)

/** A page trimmed for storage and for the model. */
function trimmed(p: PageText, max: number): PageText {
  return {
    url: p.url,
    title: clip(p.title, 200),
    description: clip(p.description, 400),
    headings: p.headings.slice(0, 12).map((h) => clip(h, 140)),
    text: clip(p.text, max),
  }
}

const cmsOrNull = (v: string | null): SiteCms | null => {
  const r = SiteCmsSchema.safeParse(v)
  return r.success ? r.data : null
}

/** The first answer: the https address, and only when the secure address is unreachable the plain one. */
async function firstPage(url: string, get: (u: string) => Promise<Fetched>): Promise<Fetched> {
  const first = await get(url)
  if (first.ok || !url.startsWith('https://')) return first
  // A site that lives on plain http answers the secure address with a network error, not with a status.
  if (first.error !== 'network') return first
  const plain = await get(`http://${url.slice('https://'.length)}`)
  return plain.ok ? plain : first
}

/** Reads the site now: the home page, then up to `EXTRA_PAGES` of its important pages at once. Never throws. */
export async function readSite(
  url: string,
  o: { deep: boolean; fetchPage?: (u: string) => Promise<Fetched>; now?: Date },
): Promise<Digest> {
  const domain = hostOf(url) ?? url
  const get = o.fetchPage ?? ((u: string) => fetchPage(u))
  const now = o.now ?? new Date()
  const fail = (error: FetchError | 'timeout'): Digest => ({
    domain,
    url,
    status: 'failed',
    error,
    deep: o.deep,
    cms: null,
    signals: null,
    pages: [],
  })
  const work = async (): Promise<Digest> => {
    const home = await firstPage(url, get)
    if (!home.ok) return fail(home.error)
    const signs: PageSigns[] = []
    const pages: PageText[] = []
    const take = (page: Fetched & { ok: true }, max: number) => {
      const text = pageText(page.html, page.url)
      pages.push(trimmed(text, max))
      signs.push(pageSigns(page.html, text.text, now))
    }
    take(home, HOME_CHARS)
    if (o.deep) {
      const extra = await Promise.all(
        importantLinks(home.html, home.url, EXTRA_PAGES).map((l) => get(l).catch(() => null)),
      )
      for (const page of extra) if (page?.ok) take(page, PAGE_CHARS)
    }
    return {
      domain,
      url: home.url,
      status: 'ok',
      error: null,
      deep: o.deep,
      cms: cmsOf(home.html),
      signals: { https: home.url.startsWith('https://'), ...mergeSigns(signs) },
      pages,
    }
  }
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<Digest>((resolve) => {
    timer = setTimeout(() => resolve(fail('timeout')), SITE_DEADLINE_MS)
  })
  try {
    return await Promise.race([work(), late])
  } catch {
    return fail('network')
  } finally {
    clearTimeout(timer)
  }
}

type CacheRow = typeof siteCache.$inferSelect

function digestOf(r: CacheRow): Digest {
  return {
    domain: r.domain,
    url: r.url,
    status: r.status === 'ok' ? 'ok' : 'failed',
    error: r.error,
    deep: r.deep,
    cms: cmsOrNull(r.cms),
    signals: (r.signals as SiteSignals | null) ?? null,
    pages: (r.pages as PageText[]) ?? [],
  }
}

/**
 * The site's pages for a day: from the cache when the domain was read in the last day (half an hour when it did not
 * open), else read now and kept. `deep: false` (only the home page, for the screen's WordPress sign) is satisfied by
 * any cached read; `deep: true` needs one that read the other pages too.
 */
export async function siteDigest(
  d: ReadDeps,
  url: string,
  o: { deep: boolean },
): Promise<{ digest: Digest; cached: boolean }> {
  const domain = hostOf(url)
  if (!domain) {
    return {
      digest: {
        domain: url,
        url,
        status: 'failed',
        error: 'bad_url',
        deep: o.deep,
        cms: null,
        signals: null,
        pages: [],
      },
      cached: false,
    }
  }
  const now = d.now?.() ?? new Date()
  const [row] = await d.db.select().from(siteCache).where(eq(siteCache.domain, domain))
  if (row) {
    const age = now.getTime() - new Date(row.fetchedAt).getTime()
    const ttl = row.status === 'ok' ? CACHE_OK_MS : CACHE_FAILED_MS
    if (age >= 0 && age < ttl && (row.deep || !o.deep || row.status !== 'ok'))
      return { digest: digestOf(row), cached: true }
  }
  const digest = await readSite(url, { deep: o.deep, fetchPage: d.fetchPage, now })
  const values = {
    domain,
    url: digest.url,
    status: digest.status,
    error: digest.error,
    deep: digest.deep,
    cms: digest.cms,
    signals: digest.signals,
    pages: digest.pages,
    fetchedAt: now.toISOString(),
  }
  await d.db
    .insert(siteCache)
    .values(values)
    .onConflictDoUpdate({ target: siteCache.domain, set: values })
    .catch((e) => console.error('site cache not kept', e instanceof Error ? e.message : e))
  return { digest, cached: false }
}

/** How many summaries the model wrote since the Moscow midnight: the day's limit counts them. */
export async function briefsToday(db: Db, now: Date): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${modelCall}
    where ${modelCall.role} = 'site-reader'
      and (${modelCall.startedAt} at time zone 'Europe/Moscow')::date
        = (${now.toISOString()}::timestamptz at time zone 'Europe/Moscow')::date`)
  return r.rows[0]?.n ?? 0
}
