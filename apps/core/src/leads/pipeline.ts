import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  AnalystOutput,
  ClientInfo,
  type EventEnvelope,
  type GetOrderOutput,
  isTestOrder,
  LeadScreen,
  type LeadSite,
  newEventId,
  type OrderAttachment,
  ProfiOrder,
  priceRange,
  SCREEN_RU,
  type ScreenMark,
  type SorterOutput,
  type TaskAction,
} from '@sara/shared'
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import { event, lead, leadScore, task } from '../db/schema'
import { getProfile } from '../direction/profile'
import { lostRoute, routeOrder } from '../direction/router'
import { activeRules } from '../direction/store'
import type { Gateway } from '../gateway/gateway'
import { appendEvent } from '../journal/journal'
import { recordLabel } from '../learning/labels'
import { onProposalPress } from '../learning/proposals'
import {
  askForDraft,
  askWhy,
  closeDraftRequests,
  type DraftAnswer,
  markAnswered,
} from '../learning/questions'
import { analysisMessages, type ClosedWhen, type LeadCard, TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'
import { type ProfiClient, ProfiError } from '../profi/client'
import { getSetting } from '../settings/store'
import { onSheetPress } from '../sheet/backfill'
import { SHEET_TASK_ID } from '../sheet/sync'
import { leadSiteOf, studyLeadSite } from '../site'
import type { Fetched } from '../site/fetch'
import { seriesWithoutBlocked } from '../text/blockedLinks'
import { deliverDecision, startDecisionWait } from '../workflows/decisionWait'
import { casesForBid } from './bidCases'
import { callOfferTemplate } from './callSlots'
import { CARD_FLOW_TEXTS, cardsToday, isStale, lockCards, quietNow } from './cardFlow'
import { namesToHide } from './clientName'
import {
  BID_TEXT_MAX,
  bidLengthMax,
  bidTextAt,
  bidTextDetail,
  bodyOf,
  type Draft,
  type DraftMiss,
  type DraftSource,
  editOf,
  FOLLOW_UP_EDIT_MAX,
  followUpsEdit,
  priceOf,
  writeDraft,
} from './draft'
import { readWallet, refuseSpend } from './money'
import { recordBid, startOutboxDelivery } from './outbox'
import { type Scored, scoreOrder } from './scorer'
import {
  type Check,
  checkedOf,
  clarifyLines,
  loadFormParts,
  mergeScreens,
  negativeReviews,
  newAccount,
  ownWords,
  screenEvent,
  screenOf,
  senseMarks,
  shortText,
  vacancy,
  vacancySoft,
} from './screen'
import { sitesForBid } from './siteOrder'
import { sortOrder } from './sorter'
import { telegramLineOf } from './telegramLine'

export type LeadPipelineDeps = {
  db: Db
  gateway: Gateway
  notifier: Notifier
  /** The wallet for the money check before a bid (FR-LEAD-9). */
  profi: Pick<ProfiClient, 'sessionHealth' | 'getOrder'>
  remindAfterMs: () => Promise<number>
  /** Card sending is retried, for example while the bot is starting (default 5 attempts from 2 s). */
  notifyRetry?: { maxAttempts: number; intervalSeconds: number }
  /** The clock of the greeting a bid text carries (Moscow time of day); tests fix it. */
  now?: () => Date
  /**
   * The mind: its case search (a bid may tell a case that fits the order, Boris 28.10.2026) and its records by id (the
   * sites of Hance for an order of a site, Boris 30.10.2026).
   */
  mind?: Pick<MindSearch, 'cases' | 'byIds'>
  /** How a page of the client's site is fetched; tests give a made-up site, the default is the safe fetch from the server. */
  siteFetch?: (url: string) => Promise<Fetched>
  /** How a file attached to the order is downloaded; tests give bytes, the default is the safe fetch from Profi.ru's hosts. */
  fileFetch?: (url: string) => Promise<Fetched>
}

export type LeadPipeline = {
  onOrderSeen(e: EventEnvelope): Promise<void>
  /**
   * A press on the card: from Telegram, or from the pult with `source` and, for a skip, Boris's `reason` (then no
   * «почему?» is asked in Telegram, pult v2 design 4).
   */
  onPress(p: {
    taskId: string
    action: TaskAction
    source?: string
    reason?: string | null
  }): Promise<string>
  /**
   * The wait for Boris's decision ran out. A card comes once and never again on Sara's own (Boris, 26.10.2026): a
   * delivered card gets nothing here. A first card that never went out is delivered now, once, plain.
   */
  onReminder(taskId: string): Promise<void>
  resendCard(taskId: string): Promise<void>
  /**
   * The order of this card closed on Profi.ru. `recheck`: the waiting task is ended as skipped (closed) and every
   * message of its card is edited (the closed line, no buttons); a task Boris decided meanwhile is left alone.
   * `press`: Boris's bid ended ORDER_CLOSED; his task stays as he decided it, only the card is closed.
   */
  closeOnSite(taskId: string, via: 'recheck' | 'press'): Promise<void>
  /**
   * FR-LEAD-10: a waiting card whose order and card are both older than a day at `at` is no longer offered: its task
   * ends as skipped (stale), the lead is stale, every message of its card becomes the short stale card. True when it
   * ended here; a task decided meanwhile, or not that old, is left alone.
   */
  closeStale(taskId: string, at?: Date): Promise<boolean>
  /** Boris's answer to the request after «Изменить»: the new bid text; the reply goes back to him. */
  onDraftText(a: DraftAnswer): Promise<string>
  /**
   * The pult's edit of the bid text and or the «Стоимость услуги» (M7 design 6.2): the rules and events of
   * `onDraftText`, without a question and without a new card (a press reads the lead as it is now). `followUps` is
   * the whole series after the bid as Boris left it (an empty list: no series); absent, the series stays.
   */
  saveBidText(p: {
    taskId: string
    text: string | null
    priceRub: number | null
    /** The «до» of the range; absent: half again over «от». */
    priceToRub?: number | null
    followUps?: string[] | null
  }): Promise<{
    saved: boolean
    message: string
  }>
}

/** Database steps may hit a passing database error; they are safe to repeat. */
const DB_STEP = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1 }

let deps: LeadPipelineDeps | null = null
function d(): LeadPipelineDeps {
  if (!deps) throw new Error('lead pipeline is not configured')
  return deps
}
/** The moment the greeting of a bid text is built for. */
const greetingMoment = (): Date => deps?.now?.() ?? new Date()

const ev = (
  type:
    | 'lead.found'
    | 'lead.sorted'
    | 'lead.scored'
    | 'lead.skipped'
    | 'lead.stale'
    | 'lead.page_read'
    | 'lead.screened'
    | 'lead.closed_on_site'
    | 'lead.held'
    | 'lead.drafted'
    | 'draft.edited'
    | 'draft.priced'
    | 'task.created'
    | 'task.resolved'
    | 'card.sent',
  entity: { kind: string; id: string },
  correlationId: string,
  actor: 'sara' | 'boris',
  payload: Record<string, unknown> = {},
  causationId: string | null = null,
) => ({
  type,
  v: 1,
  entity,
  account_id: 'hance-marketing',
  actor,
  occurred_at: new Date().toISOString(),
  causation_id: causationId,
  correlation_id: correlationId,
  reason: null,
  payload,
})

type Sorted = {
  verdict: 'fit' | 'maybe' | 'reject' | null
  reason: string | null
  /** The screen's criteria 4-6 as the Sorter saw them; absent in a run recorded before the screen. */
  screen?: SorterOutput['screen']
}
type LeadRow = typeof lead.$inferSelect

/** The Sorter's verdict for the journal: the screen's quotes are the client's words and stay on the lead (ADR-016). */
const sortedEvent = (s: Sorted) => ({ verdict: s.verdict, reason: s.reason })

const sourceOf = (l: LeadRow): DraftSource => ({
  title: l.title,
  category: l.category,
  city: l.city,
  budget_text: l.budgetText,
  text: l.text,
  client_name: l.clientName,
  client_info: ClientInfo.safeParse(l.clientInfo).data ?? null,
})

/** What the order page said (the plain data of a durable step), or why it could not be read. */
type PageRead = { ok: true; page: GetOrderOutput } | { ok: false; error: string }

/**
 * The order page through the node; any failure is «not read»: the card goes on with what the board showed. An answer
 * the node gives from its store (the tab may not move, the page gave no order answer), or an older node's answer that
 * does not say, is no read either: it would pass a closed order and an order already bid on.
 */
async function readPage(accountId: string, orderId: string): Promise<PageRead> {
  try {
    const page = await d().profi.getOrder(accountId, orderId)
    return page.from_page === true ? { ok: true, page } : { ok: false, error: 'NOT_READ' }
  } catch (err) {
    const error = err instanceof ProfiError ? err.errorClass : 'INTERNAL'
    console.error('order page not read', orderId, error)
    return { ok: false, error }
  }
}

/** The order with what its page added: the fee, and the client name and text only where the board gave none. */
function fuller<T extends Pick<ProfiOrder, 'bid_price_rub' | 'client_name' | 'text'>>(
  o: T,
  r: PageRead,
): T & { client_info: ClientInfo | null; attachments: OrderAttachment[] } {
  if (!r.ok) return { ...o, client_info: null, attachments: [] }
  const p = r.page
  return {
    ...o,
    bid_price_rub: p.bid_price_rub > 0 ? p.bid_price_rub : o.bid_price_rub,
    client_name: o.client_name || p.client_name,
    text: o.text || p.text,
    client_info: p.client_info ?? null,
    attachments: p.attachments ?? [],
  }
}

/**
 * What the page says about offering the order: already bid on (checked first: such an order may show no form),
 * closed, or fine (also when it was not read).
 */
const pageVerdict = (r: PageRead): 'go' | 'closed' | 'bid_already' =>
  !r.ok ? 'go' : r.page.has_bid === true ? 'bid_already' : !r.page.open ? 'closed' : 'go'

/**
 * The page's findings go on the lead, and into the journal as numbers and flags, never as the client's words
 * (ADR-016). A closed order or one this account already bid on gets its status and is not offered.
 */
async function storePage(
  l: { id: string; correlationId: string },
  full: Pick<ProfiOrder, 'bid_price_rub' | 'client_name' | 'text'> & {
    client_info: ClientInfo | null
  },
  r: PageRead,
  sorted: Sorted,
): Promise<'go' | 'closed' | 'bid_already'> {
  const verdict = pageVerdict(r)
  await d().db.transaction(async (tx) => {
    if (r.ok) {
      await tx
        .update(lead)
        .set({
          bidPriceRub: full.bid_price_rub,
          clientName: full.client_name,
          text: full.text,
          // A page that shows no client leaves what an earlier read stored.
          ...(full.client_info && { clientInfo: full.client_info }),
          ...(verdict !== 'go' && { status: verdict }),
        })
        .where(eq(lead.id, l.id))
    }
    await appendEvent(
      tx,
      ev(
        'lead.page_read',
        { kind: 'lead', id: l.id },
        l.correlationId,
        'sara',
        r.ok
          ? {
              ok: true,
              open: r.page.open,
              has_bid: r.page.has_bid,
              fee_rub: r.page.bid_price_rub > 0 ? r.page.bid_price_rub : null,
              client_info: full.client_info !== null,
              error: null,
            }
          : {
              ok: false,
              open: null,
              has_bid: null,
              fee_rub: null,
              client_info: false,
              error: r.error,
            },
      ),
    )
    // An order that stops here never reaches the task step, which journals the Sorter's verdict.
    if (verdict !== 'go' && sorted.verdict) {
      await appendEvent(
        tx,
        ev('lead.sorted', { kind: 'lead', id: l.id }, l.correlationId, 'sara', sortedEvent(sorted)),
      )
    }
  })
  return verdict
}

/** The Analyst's draft, or why there is none; any failure is «no answer», the card comes anyway. */
async function draftFor(
  o: DraftSource,
  opts: {
    correlationId: string
    causationId?: string
    accountId: string
    /** The client's own site as read for this order (Boris, 30.10.2026). */
    site?: LeadSite | null
  },
): Promise<Draft | DraftMiss> {
  try {
    // The direction's format and cases for the Analyst; a profile that cannot be read leaves the draft as it was.
    const profile = await getProfile(d().db, opts.accountId).catch(() => null)
    // A direction with its own case library keeps it; otherwise the cases of the mind that fit the order.
    const mindCases =
      profile && profile.cases.length > 0 ? [] : await casesForBid(d().mind, o, opts.accountId)
    const { accountId: _account, site: _site, ...rest } = opts
    const blocked = await getSetting(d().db, 'links.blocked')
    const dr = await writeDraft(d().gateway, o, {
      ...rest,
      ...(profile ? { profile } : {}),
      mindCases,
      recentBids: await recentBids(opts.accountId),
      sites: await sitesForBid(d().mind, o, blocked),
      blockedLinks: blocked,
      site: opts.site ?? null,
      now: greetingMoment(),
    })
    // The series ends with an offer to talk for half an hour (Boris, 30.10.2026); its times go in when it is sent.
    const withCall =
      dr.text !== null && (await getSetting(d().db, 'calls.offer'))
        ? { ...dr, callOffer: callOfferTemplate(`${o.title}\n${o.text}`) }
        : dr
    // And last, his Telegram in his words (31.10.2026), when the setting names one.
    const tg = dr.text !== null ? telegramLineOf(await getSetting(d().db, 'series.telegram')) : null
    return tg ? ({ ...withCall, telegram: tg } as Draft) : withCall
  } catch (err) {
    console.error('draft failed', err instanceof Error ? err.message.slice(0, 200) : err)
    return { text: null, reason: 'no_answer', attempts: 1, analysis: null }
  }
}

/** The whole series a draft brings: the Analyst's messages, then the call offer; null when there are none. */
function seriesOf(dr: Draft): string[] | null {
  const all = [
    ...(dr.followUps ?? []),
    ...(dr.callOffer ? [dr.callOffer] : []),
    ...(dr.telegram ? [dr.telegram] : []),
  ]
  return all.length > 0 ? all : null
}

/** The texts of the account's latest drafts, newest first: the Analyst opens the next bid differently. */
async function recentBids(accountId: string): Promise<string[]> {
  const rows = await d()
    .db.select({ text: lead.draftText })
    .from(lead)
    .where(and(eq(lead.accountId, accountId), isNotNull(lead.draftText)))
    .orderBy(desc(lead.createdAt))
    .limit(5)
  return rows.map((r) => r.text).filter((t): t is string => t !== null)
}

/**
 * The client's own site, when the order names one (Boris, 30.10.2026): read from the server's own exit, summed up against
 * the order and kept on the lead. An order the day's cap holds for the summary is not read now («Показать» reads it with
 * its draft). Never throws: a site that did not open is a note on the card, and the bid is written as it always was.
 */
async function readClientSite(
  l: { id: string; correlationId: string },
  o: Pick<DraftSource, 'title' | 'category' | 'text' | 'client_name' | 'client_info'> & {
    attachments?: OrderAttachment[]
  },
  causationId?: string,
): Promise<LeadSite | null> {
  return studyLeadSite(
    { db: d().db, gateway: d().gateway, fetchPage: d().siteFetch, fileFetch: d().fileFetch },
    {
      leadId: l.id,
      correlationId: l.correlationId,
      causationId,
      text: o.text,
      source: 'order',
      order: { title: o.title, category: o.category, text: o.text },
      names: namesToHide(o.client_name, o.client_info?.name),
      attachments: o.attachments,
    },
  )
}

/** The day's card cap is spent: a shown order is held for the summary (the decision itself is taken under a lock). */
async function capSpent(): Promise<boolean> {
  return (await cardsToday(d().db, new Date())) >= (await getSetting(d().db, 'cards.max_per_day'))
}

/** The draft goes on the lead (one there already, Boris's edit, is kept) and its outcome into the journal. */
function storeDraft(
  l: { id: string; correlationId: string },
  dr: Draft | DraftMiss,
): Promise<void> {
  return d().db.transaction(async (tx) => {
    if (dr.text !== null) {
      await tx
        .update(lead)
        .set({
          draftText: dr.text,
          draftPriceRub: dr.priceRub,
          draftPriceToRub: 'priceToRub' in dr ? (dr.priceToRub ?? null) : null,
          draftFollowUps: seriesOf(dr),
        })
        .where(and(eq(lead.id, l.id), isNull(lead.draftText)))
    }
    // The reading stays even when its text did not fit: it is about the client, not the wording.
    if (dr.analysis) {
      await tx
        .update(lead)
        .set({ draftAnalysis: dr.analysis })
        .where(and(eq(lead.id, l.id), isNull(lead.draftAnalysis)))
    }
    await appendEvent(
      tx,
      ev('lead.drafted', { kind: 'lead', id: l.id }, l.correlationId, 'sara', draftedPayload(dr)),
    )
  })
}

/** The journal keeps how the draft went, never its text (ADR-016). */
const draftedPayload = (dr: Draft | DraftMiss) =>
  dr.text !== null
    ? {
        drafted: true,
        analysis: true,
        chars: dr.text.length,
        price_rub: dr.priceRub,
        attempts: dr.attempts,
        reason: null,
        cases: dr.cases ?? [],
        // The series is counted, never its text (ADR-016); a bid the Analyst wrote none for journals as before.
        ...((dr.followUps?.length ?? 0) + (dr.followUpsDropped?.length ?? 0) > 0 && {
          follow_ups: dr.followUps?.length ?? 0,
          follow_up_cases: dr.followUpCases ?? [],
          follow_ups_dropped: dr.followUpsDropped ?? [],
          ...(dr.followUpSites && { follow_up_sites: dr.followUpSites }),
        }),
      }
    : {
        drafted: false,
        analysis: dr.analysis !== null,
        chars: null,
        price_rub: null,
        attempts: dr.attempts,
        reason: dr.reason,
        cases: [],
      }

const CardAnalysis = AnalystOutput.pick({ hidden_need: true, risk: true, condition: true })

/**
 * The card's two lines of the разбор and the full reading for «Разбор», from the draft or the lead's stored
 * analysis (null: none, or unreadable; a reading that is unreadable on its own leaves the two lines).
 */
function cardAnalysis(a: unknown): LeadCard['analysis'] {
  const r = CardAnalysis.safeParse(a)
  if (!r.success) return null
  const reading = AnalystOutput.shape.reading.safeParse((a as { reading?: unknown }).reading)
  return {
    hiddenNeed: r.data.hidden_need,
    risk: r.data.risk,
    condition: r.data.condition,
    reading: reading.success ? reading.data : null,
  }
}

/** What the order page said about the client, as stored on the lead; null: nothing, or not readable. */
function clientInfoOf(stored: unknown): ClientInfo | null {
  const r = ClientInfo.safeParse(stored)
  return r.success ? r.data : null
}

/** Criterion 3 on the board's text, before any model call; the profile (1-2) is not read yet. */
async function screenByText(o: Pick<ProfiOrder, 'title' | 'text'>): Promise<LeadScreen> {
  const db = d().db
  const [form, stops, min] = await Promise.all([
    loadFormParts(db),
    getSetting(db, 'screen.stops'),
    getSetting(db, 'screen.min_own_words'),
  ])
  return screenOf(
    [
      { noData: 'new_account' },
      { noData: 'negative_reviews' },
      shortText(o, form, min),
      vacancy(o),
    ],
    { soft: [vacancySoft(o)].filter((x): x is NonNullable<typeof x> => x !== null) },
    {
      stops,
      ownWords: o.text.trim() ? ownWords(o, form).length : null,
      at: new Date(),
    },
  )
}

/**
 * The profile's criteria (1-2) once the order page was read, and criterion 3 again when only the page gave the text.
 * What the earlier checks found stays.
 */
async function screenByPage(
  before: LeadScreen,
  o: Pick<ProfiOrder, 'title' | 'text' | 'seen_at'> & {
    published_at?: string | null
    client_info: ClientInfo | null
  },
): Promise<LeadScreen> {
  const db = d().db
  const at = new Date(o.published_at ?? o.seen_at)
  const checks: Check[] = [newAccount(o.client_info, at), negativeReviews(o.client_info)]
  let words = before.own_words
  const soft: ScreenMark[] = []
  if (before.no_data.includes('short_text') && o.text.trim()) {
    const form = await loadFormParts(db)
    checks.push(shortText(o, form, await getSetting(db, 'screen.min_own_words')))
    checks.push(vacancy(o))
    const v = vacancySoft(o)
    if (v) soft.push(v)
    words = ownWords(o, form).length
  }
  return mergeScreens(
    before,
    screenOf(checks, { soft }, { stops: before.stops, ownWords: words, at: new Date() }),
    checkedOf(checks),
  )
}

/**
 * The screen goes on the lead; with the screen on, a criterion that fired stops the order (screened_out). The journal
 * gets the criteria without the quotes (ADR-016) when `journal` says something new was found.
 */
async function storeScreen(
  l: { id: string; correlationId: string },
  s: LeadScreen,
  journal: boolean,
  sorted?: Sorted,
): Promise<boolean> {
  const stop = s.stops && s.hits.length > 0
  await d().db.transaction(async (tx) => {
    await tx
      .update(lead)
      .set({ screen: s, ...(stop && { status: 'screened_out' }) })
      .where(eq(lead.id, l.id))
    if (journal)
      await appendEvent(
        tx,
        ev('lead.screened', { kind: 'lead', id: l.id }, l.correlationId, 'sara', screenEvent(s)),
      )
    // A stopped order never reaches the task step, which journals the Sorter's verdict.
    if (stop && sorted?.verdict)
      await appendEvent(
        tx,
        ev('lead.sorted', { kind: 'lead', id: l.id }, l.correlationId, 'sara', sortedEvent(sorted)),
      )
  })
  return stop
}

/** One order, one durable run (workflow id lead:<order>): record, sort, card, wait for Boris. */
async function processOrder(e: EventEnvelope): Promise<void> {
  const order = ProfiOrder.parse(e.payload)
  const correlationId = e.correlation_id
  // A test order (docs/ops/test-leads.md) goes the whole way and always reaches Boris: where the live Sara would stop,
  // the card says so instead. Every check of `test` below is the order's number, so a live run never changes its steps.
  const test = isTestOrder(order.order_id)
  const liveSkip: string[] = []
  // Runs recorded before M2 return a boolean; 'stale' is a new order too old to offer (FR-LEAD-10).
  const isNew = await DBOS.runStep(
    (): Promise<boolean | 'stale'> =>
      d().db.transaction(async (tx) => {
        // Decided before any model call: a stale order costs no sorting or scoring.
        const stale = isStale(order.published_at, new Date())
        const rows = await tx
          .insert(lead)
          .values({
            id: order.order_id,
            accountId: e.account_id ?? 'hance-marketing',
            title: order.title,
            category: order.category,
            city: order.city,
            text: order.text,
            clientName: order.client_name,
            budgetText: order.budget_text,
            bidPriceRub: order.bid_price_rub,
            seenAt: order.seen_at,
            correlationId,
            ...(stale && { status: 'stale' }),
          })
          .onConflictDoNothing({ target: lead.id })
          .returning({ id: lead.id })
        if (rows.length === 0) return false
        await appendEvent(
          tx,
          ev('lead.found', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {}, e.id),
        )
        if (!stale) return true
        await appendEvent(
          tx,
          ev('lead.stale', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {
            published_at: order.published_at,
          }),
        )
        return 'stale'
      }),
    { name: 'record', ...DB_STEP },
  )
  if (isNew !== true) return

  // Stage 1 «Отсев» (docs/product/lead-analysis.md): facts only, before any reading of the order. A run recorded before
  // the screen resumes along its old steps.
  let screen: LeadScreen | null = null
  if (await DBOS.patch('lead-screen')) {
    const byText = await DBOS.runStep(() => screenByText(order), { name: 'screenText', ...DB_STEP })
    screen = byText
    // A criterion that fired stops the order before the Sorter: no model call for it.
    if (byText.stops && byText.hits.length > 0) {
      await DBOS.runStep(() => storeScreen({ id: order.order_id, correlationId }, byText, true), {
        name: 'screenedText',
        ...DB_STEP,
      })
      return
    }
  }

  const sorted = await DBOS.runStep(
    async (): Promise<Sorted> => {
      const r = await sortOrder(d().gateway, order, { correlationId, causationId: e.id })
      return r.ok
        ? { verdict: r.output.verdict, reason: r.output.reason, screen: r.output.screen }
        : { verdict: null, reason: null }
    },
    { name: 'sort' },
  )

  if (screen) {
    const byText = screen
    const bySense = await DBOS.runStep(
      async () => {
        const sense = senseMarks(order, sorted.screen)
        const s = mergeScreens(
          byText,
          screenOf([], sense, { stops: byText.stops, ownWords: byText.own_words, at: new Date() }),
        )
        const news = s.hits.length > 0 || s.clarify.length > 0 || s.soft.length > 0
        return {
          screen: s,
          stop: await storeScreen({ id: order.order_id, correlationId }, s, news, sorted),
        }
      },
      { name: 'screenSense', ...DB_STEP },
    )
    screen = bySense.screen
    if (bySense.stop) return
  }

  if (sorted.verdict === 'reject' && test)
    liveSkip.push(`Сортировщик отсеял бы: ${sorted.reason ?? 'чужая заявка'}`)
  if (sorted.verdict === 'reject' && !test) {
    await DBOS.runStep(
      () =>
        d().db.transaction(async (tx) => {
          await tx.update(lead).set({ status: 'sorted_out' }).where(eq(lead.id, order.order_id))
          await appendEvent(
            tx,
            ev(
              'lead.sorted',
              { kind: 'lead', id: order.order_id },
              correlationId,
              'sara',
              sortedEvent(sorted),
            ),
          )
        }),
      { name: 'sortedOut', ...DB_STEP },
    )
    return
  }

  const accountId = e.account_id ?? 'hance-marketing'
  const scored = await DBOS.runStep(
    async (): Promise<(Scored & { version: number }) | null> => {
      // Any failure here (no rules, the model down) brings the card unscored: the order is never lost.
      try {
        const { version, rules } = await activeRules(d().db, accountId)
        const s = await scoreOrder(d().gateway, order, rules, { correlationId, causationId: e.id })
        if (!s) return null
        // A text that looks like a vacancy loses points; the stop `vacancy` of the rules stays the Scorer's own
        // insurance, the screen stops the clear ones earlier and with a quote.
        const cut = screen?.penalty ?? 0
        if (cut > 0 && screen) {
          const score = Math.max(0, s.score - cut)
          return {
            ...s,
            score,
            decision: !s.stopFactor && score >= rules.threshold ? 'show' : 'drop',
            reason:
              `${s.reason} (минус ${cut}: ${screen.soft.map((m) => (m.criterion === 'vacancy' ? 'похоже на вакансию' : 'мало слов клиента')).join(', ')})`.slice(
                0,
                300,
              ),
            version,
          }
        }
        return { ...s, version }
      } catch (err) {
        console.error('scoring failed', err instanceof Error ? err.message.slice(0, 200) : err)
        return null
      }
    },
    { name: 'score' },
  )
  if (scored) {
    await DBOS.runStep(
      () =>
        d().db.transaction(async (tx) => {
          await tx.insert(leadScore).values({
            id: newEventId(),
            leadId: order.order_id,
            version: scored.version,
            score: scored.score,
            decision: scored.decision,
            stopFactor: scored.stopFactor,
            redFlags: scored.redFlags,
            axes: scored.axes,
            reason: scored.reason,
            confidence: scored.confidence,
            model: scored.model,
          })
          // A test order goes on to its card, so it never stands among the day's dropped orders.
          if (scored.decision === 'drop' && !test) {
            await tx.update(lead).set({ status: 'scored_out' }).where(eq(lead.id, order.order_id))
            // A dropped order never reaches the task step, so its sorter verdict is journaled here.
            if (sorted.verdict) {
              await appendEvent(
                tx,
                ev(
                  'lead.sorted',
                  { kind: 'lead', id: order.order_id },
                  correlationId,
                  'sara',
                  sortedEvent(sorted),
                ),
              )
            }
          }
          await appendEvent(
            tx,
            ev('lead.scored', { kind: 'lead', id: order.order_id }, correlationId, 'sara', {
              score: scored.score,
              decision: scored.decision,
              version: scored.version,
              stop_factor: scored.stopFactor,
            }),
          )
        }),
      { name: 'scored', ...DB_STEP },
    )
  }

  // The direction's vote is written for every order it judged, the dropped ones and the unscored too, and one
  // direction gets the order (FR-LEAD-4). A run recorded before the router resumes along its old steps.
  if (await DBOS.patch('router')) {
    const route = await DBOS.runStep(
      () => routeOrder(d().db, { orderId: order.order_id, accountId, correlationId, scored }),
      { name: 'route', ...DB_STEP },
    )
    // An order another direction got, or none (a direction in the shadow or still a draft never wins): no card.
    if (!route.mine && !test) return
    if (!route.mine) liveSkip.push('заявка ушла бы другому направлению')
  }
  // Below the threshold or a stop factor: kept for the daily summary, nothing goes to Boris.
  if (scored?.decision === 'drop' && !test) return
  if (scored?.decision === 'drop')
    liveSkip.push(
      scored.stopFactor
        ? `стоп-фактор: ${scored.stopFactor}`
        : `оценка ${scored.score} ниже порога`,
    )

  // Only an order that passed the Sorter and the Scorer on what the board showed costs a visit of the one tab. A run
  // recorded before this step existed resumes along its old steps and keeps the board's data.
  let withPage: Pick<ProfiOrder, 'bid_price_rub' | 'client_name' | 'text'> & {
    client_info: ClientInfo | null
    attachments: OrderAttachment[]
  } = { ...order, client_info: null, attachments: [] }
  if (await DBOS.patch('order-page')) {
    // An order the day's cap will hold waits for the summary: no visit of the tab for it now, «Показать» reads its page
    // (with its draft, draftThenCard).
    const held = await DBOS.runStep(async () => !test && (await capSpent().catch(() => false)), {
      name: 'capBeforePage',
    })
    if (!held) {
      const read = await DBOS.runStep(() => readPage(accountId, order.order_id), {
        name: 'orderPage',
      })
      withPage = fuller(order, read)
      const verdict = await DBOS.runStep(
        () => storePage({ id: order.order_id, correlationId }, withPage, read, sorted),
        { name: 'orderPageStored', ...DB_STEP },
      )
      // Closed, or already bid on: nothing to offer, no card and no model call.
      if (verdict !== 'go') return
      if (screen) {
        const before = screen
        const byPage = await DBOS.runStep(
          async () => {
            const s = await screenByPage(before, { ...order, ...withPage })
            const news = s.hits.length > before.hits.length
            // A test order's card comes anyway and says where the live Sara would have stopped.
            const kept = test ? { ...s, stops: false } : s
            return {
              screen: kept,
              wouldStop: test && s.stops ? s.hits.map((h) => SCREEN_RU[h.criterion]) : [],
              stop: await storeScreen({ id: order.order_id, correlationId }, kept, news, sorted),
            }
          },
          { name: 'screenPage', ...DB_STEP },
        )
        screen = byPage.screen
        if (byPage.wouldStop?.length)
          liveSkip.push(`отсев остановил бы: ${byPage.wouldStop.join(', ')}`)
        if (byPage.stop) return
      }
    }
  }

  // The client's own site, when the order names one (Boris, 30.10.2026): read before the Analyst, who builds the bid on
  // it. A run recorded before this step resumes along its old steps and has no site.
  const site = (await DBOS.patch('client-site'))
    ? await DBOS.runStep(
        async (): Promise<LeadSite | null> =>
          (await capSpent().catch(() => false))
            ? null
            : readClientSite(
                { id: order.order_id, correlationId },
                { ...order, ...withPage },
                e.id,
              ),
        { name: 'clientSite' },
      )
    : null

  // A run recorded before the Analyst existed resumes along its old steps and brings its card without a draft.
  // An order the day's cap will hold goes to the summary undrafted: «Показать» writes its draft if Boris asks.
  const draft = (await DBOS.patch('analyst-draft'))
    ? await DBOS.runStep(
        async () =>
          !test && (await capSpent().catch(() => false))
            ? null
            : draftFor(
                { ...order, ...withPage },
                { correlationId, causationId: e.id, accountId, site },
              ),
        { name: 'draft' },
      )
    : null
  if (draft) {
    await DBOS.runStep(() => storeDraft({ id: order.order_id, correlationId }, draft), {
      name: 'drafted',
      ...DB_STEP,
    })
  }

  // Runs recorded before M2 return the id; null is an order held over the day's card cap (FR-NOTIF-3).
  const taskId = await DBOS.runStep(
    (): Promise<string | null> =>
      d().db.transaction(async (tx) => {
        const id = newEventId()
        await lockCards(tx)
        // A test order takes no place in the day's cards and is never held for the summary.
        const full =
          !test && (await cardsToday(tx, new Date())) >= (await getSetting(tx, 'cards.max_per_day'))
        if (sorted.verdict) {
          await appendEvent(
            tx,
            ev(
              'lead.sorted',
              { kind: 'lead', id: order.order_id },
              correlationId,
              'sara',
              sortedEvent(sorted),
            ),
          )
        }
        if (full) {
          // No decision task, so no reminder: the order waits for the 19:00 summary.
          await tx.update(lead).set({ status: 'held' }).where(eq(lead.id, order.order_id))
          await appendEvent(
            tx,
            ev('lead.held', { kind: 'lead', id: order.order_id }, correlationId, 'sara'),
          )
          return null
        }
        await tx
          .insert(task)
          .values({ id, kind: 'lead_decision', entityKind: 'lead', entityId: order.order_id })
        await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, order.order_id))
        await appendEvent(
          tx,
          ev('task.created', { kind: 'task', id }, correlationId, 'sara', {
            lead_id: order.order_id,
          }),
        )
        return id
      }),
    { name: 'task', ...DB_STEP },
  )
  if (taskId === null) return

  // The wait starts before the card goes out, so an instant press always finds it.
  const remindAfter = await DBOS.runStep(() => d().remindAfterMs(), { name: 'remindAfter' })
  await startDecisionWait(taskId, remindAfter)

  const card: LeadCard = {
    taskId,
    orderId: order.order_id,
    title: order.title,
    city: order.city,
    budgetText: order.budget_text,
    // What the order page added (a name or a text the board lacked) is on the card too.
    clientName: withPage.client_name,
    text: withPage.text,
    // Only a test order comes this far rejected; its card says the Sorter would have stopped it (liveSkip).
    verdict: sorted.verdict === 'reject' ? 'maybe' : sorted.verdict,
    reason: sorted.reason,
    bidPriceRub: withPage.bid_price_rub,
    score: scored ? { value: scored.score, version: scored.version, reason: scored.reason } : null,
    unscored: !scored,
    // The same text as every later card and as the bid: the greeting of this hour, the voice rules applied (the case
    // lines the program put in are tidied too), so Boris never approves a text that is not the one to be sent.
    draft: draft?.text
      ? {
          text: bidTextAt(draft.text, withPage.client_name, greetingMoment()),
          priceRub: draft.priceRub,
          priceToRub:
            draft.priceRub === null ? null : priceRange(draft.priceRub, draft.priceToRub).to,
          followUps: seriesOf(draft) ?? [],
          note: draft.styleNote ?? null,
        }
      : null,
    analysis: cardAnalysis(draft?.analysis),
    ...(liveSkip.length > 0 && { liveSkip: liveSkip.join('; ') }),
    site,
  }
  const retry = d().notifyRetry ?? { maxAttempts: 5, intervalSeconds: 2 }
  try {
    await DBOS.runStep(
      async () => {
        // The core may have died after the card went out and was written to the task, before this step was recorded:
        // the run then comes back here, and Boris must not get the card twice.
        const [out] = await d()
          .db.select({ messageId: task.telegramMessageId })
          .from(task)
          .where(eq(task.id, taskId))
        if (out?.messageId != null) return
        const silent = await quietNow(d().db, new Date())
        // What the order page said about the client is read here, inside the step, so a run recorded before this
        // card kept its steps; an order whose page was not opened has none.
        const [stored] = await d()
          .db.select({ clientInfo: lead.clientInfo, screen: lead.screen })
          .from(lead)
          .where(eq(lead.id, order.order_id))
        const screened = LeadScreen.safeParse(stored?.screen)
        const m = await d().notifier.sendLeadCard(
          {
            ...card,
            clientInfo: clientInfoOf(stored?.clientInfo),
            clarify: screened.success ? clarifyLines(screened.data) : [],
          },
          { silent },
        )
        await cardSent(taskId, correlationId, m.messageId, 'order')
      },
      { name: 'card', retriesAllowed: true, backoffRate: 1, ...retry },
    )
  } catch (err) {
    // The lead and its task stay; the reminder later delivers the card once, with its buttons.
    const reason = err instanceof Error ? err.message.slice(0, 200) : 'card was not sent'
    await DBOS.runStep(
      () =>
        appendEvent(d().db, {
          ...ev('task.created', { kind: 'task', id: taskId }, correlationId, 'sara'),
          type: 'notify.failed',
          reason,
          payload: { channel: 'telegram', what: 'lead_card' },
        }).then(() => undefined),
      { name: 'cardFailed', ...DB_STEP },
    )
  }
}

const processOrderWorkflow = DBOS.registerWorkflow(processOrder, { name: 'processOrder' })

async function leadOfTask(taskId: string) {
  const [t] = await d().db.select().from(task).where(eq(task.id, taskId))
  if (!t) return null
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  return l ? { task: t, lead: l } : null
}

/** The lead card of a task in any state, rebuilt from the lead and its last sorter verdict and score. */
async function cardOfFound(
  found: NonNullable<Awaited<ReturnType<typeof leadOfTask>>>,
  reminder: boolean,
): Promise<LeadCard> {
  const { lead: l, task: t } = found
  const [sorted] = await d()
    .db.select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.correlationId, l.correlationId), eq(event.type, 'lead.sorted')))
    .orderBy(desc(event.id))
    .limit(1)
  const s = (sorted?.payload ?? {}) as {
    verdict?: 'fit' | 'maybe' | 'reject' | null
    reason?: string | null
  }
  const [sc] = await d()
    .db.select()
    .from(leadScore)
    .where(and(eq(leadScore.leadId, l.id), eq(leadScore.backtest, false)))
    .orderBy(desc(leadScore.createdAt))
    .limit(1)
  return {
    taskId: t.id,
    orderId: l.id,
    title: l.title,
    city: l.city,
    budgetText: l.budgetText,
    clientName: l.clientName,
    text: l.text,
    clientInfo: clientInfoOf(l.clientInfo),
    verdict: s.verdict === 'fit' || s.verdict === 'maybe' ? s.verdict : null,
    reason: s.reason ?? null,
    bidPriceRub: l.bidPriceRub,
    score: sc ? { value: sc.score, version: sc.version, reason: sc.reason } : null,
    reminder,
    // The card shows the bid as it would go out now: the greeting of this hour, the voice rules applied. Nothing says
    // that the greeting may change; it is built again when the bid is sent.
    draft: l.draftText
      ? {
          ...draftOnCard(l.draftText, l.clientName, l.draftPriceRub, l.draftPriceToRub),
          followUps: seriesWithoutBlocked(
            l.draftFollowUps ?? [],
            await getSetting(d().db, 'links.blocked'),
          ),
        }
      : null,
    analysis: cardAnalysis(l.draftAnalysis),
    site: leadSiteOf(l.clientSite),
  }
}

/**
 * The draft as a card shows it: the bid as it would go out now, with a note when it had to give up the name or the
 * hour in its greeting to fit the 500 characters (an old draft that fills the whole form).
 */
function draftOnCard(
  stored: string,
  clientName: string,
  priceRub: number | null,
  priceToRub: number | null,
): { text: string; priceRub: number | null; priceToRub: number | null; note: string | null } {
  const { text, fallback } = bidTextDetail(stored, clientName, greetingMoment())
  const note =
    fallback === 'name_dropped'
      ? TEXTS.greetingNameDropped
      : fallback === 'greeting_kept'
        ? TEXTS.greetingKept
        : null
  return {
    text,
    priceRub,
    priceToRub: priceRub === null ? null : priceRange(priceRub, priceToRub).to,
    note,
  }
}

/** The lead card for an open task. */
async function cardOfTask(taskId: string): Promise<LeadCard | null> {
  const found = await leadOfTask(taskId)
  if (!found || found.task.state !== 'open') return null
  return cardOfFound(found, false)
}

/**
 * A card went out: the task keeps the new message (the one Boris sees last) and the journal the moment and the
 * message number. The speed report reads only the order's own card (via 'order'); the daily cap counts tasks.
 */
function cardSent(
  taskId: string,
  correlationId: string,
  messageId: number,
  via: 'order' | 'summary' | 'edit' | 'resend',
): Promise<void> {
  return d().db.transaction(async (tx) => {
    await tx.update(task).set({ telegramMessageId: messageId }).where(eq(task.id, taskId))
    // The message number is kept so every message of the card can be found again (a closed order, FR-LEAD-5).
    await appendEvent(
      tx,
      ev('card.sent', { kind: 'task', id: taskId }, correlationId, 'sara', {
        via,
        message_id: messageId,
      }),
    )
  })
}

/** A look this close before the order was found closed dates its closing (to the middle of the two). */
const CLOSED_EXACT_MS = 30 * 60_000

/**
 * When the order of this lead closed, from the journal (FR-LEAD-5): its publication on the board (or when Sara saw it),
 * the last sign it was open (the board, a read of its page), and its leaving the feed after that sign. The closing is
 * exact when the order left the feed, or a look within half an hour before `at` found it open; otherwise only «by» `at`.
 */
async function closedWhenOf(l: LeadRow, at: Date): Promise<ClosedWhen> {
  const rows = await d().db.execute<{
    published: string | null
    open_at: string | Date | null
    gone_at: string | Date | null
  }>(sql`
    select
      (select e.payload->>'published_at' from core.event e
        where e.type = 'profi.order_seen' and e.entity_kind = 'order' and e.entity_id = ${l.id}
        order by e.id limit 1) as published,
      (select max(e.occurred_at) from core.event e
        where e.entity_id = ${l.id}
          and ((e.type = 'profi.order_seen' and e.entity_kind = 'order')
            or (e.type = 'lead.page_read' and e.entity_kind = 'lead'
              and e.payload->>'ok' = 'true' and e.payload->>'open' = 'true'))) as open_at,
      (select max(e.occurred_at) from core.event e
        where e.type = 'profi.order_gone' and e.entity_kind = 'order' and e.entity_id = ${l.id}) as gone_at`)
  const r = rows.rows[0]
  const time = (v: string | Date | null | undefined) => (v == null ? null : new Date(v).getTime())
  const published = time(r?.published)
  const since = published !== null && Number.isFinite(published) ? published : Date.parse(l.seenAt)
  const open = time(r?.open_at)
  const gone = time(r?.gone_at)
  const iso = (t: number) => new Date(t).toISOString()
  const base = {
    since: iso(since),
    published: published !== null && Number.isFinite(published),
    openUntil: open === null ? null : iso(open),
  }
  if (gone !== null && (open === null || gone > open))
    return { ...base, at: iso(gone), exact: true }
  if (open !== null && at.getTime() - open <= CLOSED_EXACT_MS)
    return { ...base, at: iso((open + at.getTime()) / 2), exact: true }
  return { ...base, at: at.toISOString(), exact: false }
}

/**
 * Every message the card of this task went out as (its first card and the cards sent again), edited into the short
 * closed card, or the short stale card (`stale`). The numbers come from the journal (card.sent) and from the task,
 * which also holds those sent before the journal kept them. One message Telegram will not edit never stops the others.
 */
async function closeCardMessages(
  found: NonNullable<Awaited<ReturnType<typeof leadOfTask>>>,
  o: { stale?: Date; byBoris?: boolean } = {},
) {
  const sent = await d()
    .db.select({ payload: event.payload, at: event.occurredAt })
    .from(event)
    .where(
      and(
        eq(event.type, 'card.sent'),
        eq(event.entityKind, 'task'),
        eq(event.entityId, found.task.id),
      ),
    )
  const [now] = await d()
    .db.select({ messageId: task.telegramMessageId })
    .from(task)
    .where(eq(task.id, found.task.id))
  const ids = new Set<number>()
  for (const e of sent) {
    const id = (e.payload as { message_id?: unknown }).message_id
    if (typeof id === 'number') ids.add(id)
  }
  if (now?.messageId != null) ids.add(now.messageId)
  if (ids.size === 0) return
  // The wait counts from the first message of the card (the task's birth when the journal has none).
  const first = Math.min(
    ...[found.task.createdAt, ...sent.map((e) => e.at)].map((t) => new Date(t).getTime()),
  )
  const card = {
    ...(await cardOfFound(found, false)),
    ...(o.byBoris
      ? { closedByBoris: true }
      : o.stale
        ? { stale: { since: new Date(first).toISOString(), at: o.stale.toISOString() } }
        : { closed: await closedWhenOf(found.lead, new Date()) }),
  }
  for (const id of [...ids].sort((a, b) => a - b)) {
    try {
      await d().notifier.closeLeadCard(id, card)
    } catch (err) {
      console.error(
        'card not closed',
        found.task.id,
        id,
        err instanceof Error ? err.message.slice(0, 200) : err,
      )
    }
  }
}

/**
 * Boris has the card of this task: its message number is on the task, or the journal wrote a card down for it. The
 * journal alone is enough (a number lost from the task), and so is the number alone (a card from before the journal
 * kept them).
 */
async function cardDelivered(taskId: string): Promise<boolean> {
  const [t] = await d()
    .db.select({ messageId: task.telegramMessageId })
    .from(task)
    .where(eq(task.id, taskId))
  if (t?.messageId != null) return true
  const [sent] = await d()
    .db.select({ id: event.id })
    .from(event)
    .where(
      and(eq(event.type, 'card.sent'), eq(event.entityKind, 'task'), eq(event.entityId, taskId)),
    )
    .limit(1)
  return sent != null
}

/** The plain card of an open task, sent again now (silent in the quiet hours); a task not open gets nothing. */
async function resendCardOf(taskId: string): Promise<void> {
  const card = await cardOfTask(taskId)
  if (!card) return
  const m = await d().notifier.sendLeadCard(card, {
    silent: await quietNow(d().db, new Date()),
  })
  const found = await leadOfTask(taskId)
  if (found) await cardSent(taskId, found.lead.correlationId, m.messageId, 'resend')
}

/** The card of an open task, sent now. */
async function sendCard(taskId: string, via: 'summary' | 'edit'): Promise<void> {
  const card = await cardOfTask(taskId)
  const found = card ? await leadOfTask(taskId) : null
  if (card && found) {
    const m = await d().notifier.sendLeadCard(card)
    await cardSent(taskId, found.lead.correlationId, m.messageId, via)
  }
}

/**
 * «Откликнуться» on a card whose fee is not known (its page was not read): the page is read now and the card comes
 * again with the fee, or the order ends as closed or already bid on. Still unknown: Boris bids by hand.
 */
async function feeThenCard(l: LeadRow, taskId: string): Promise<void> {
  const read = await readPage(l.accountId, l.id)
  if (read.ok && (read.page.bid_price_rub > 0 || pageVerdict(read) !== 'go'))
    return draftThenCard(l, taskId, read)
  await d().notifier.sendText(TEXTS.feeUnknown(l.title), { place: 'leads' })
}

/**
 * A dropped order Boris wants after all: its page first (the Scorer's drop never opened it, and hours have passed),
 * then its draft, then its card. An order closed meanwhile, or already bid on, ends its decision task with a word
 * to Boris instead of a card.
 */
async function draftThenCard(
  l: LeadRow,
  taskId: string,
  read: PageRead | null = null,
): Promise<void> {
  read ??= await readPage(l.accountId, l.id)
  const full = fuller(
    { bid_price_rub: l.bidPriceRub, client_name: l.clientName, text: l.text },
    read,
  )
  const verdict = await storePage(l, full, read, { verdict: null, reason: null })
  if (verdict !== 'go') {
    const ended = await d().db.transaction(async (tx) => {
      const rows = await tx
        .update(task)
        .set({ state: 'resolved', resolution: 'skip', resolvedAt: new Date().toISOString() })
        .where(and(eq(task.id, taskId), eq(task.state, 'open')))
        .returning({ id: task.id })
      // Decided meanwhile (Boris pressed something): nothing to end, nothing to say.
      if (rows.length === 0) return false
      await appendEvent(
        tx,
        ev('task.resolved', { kind: 'task', id: taskId }, l.correlationId, 'sara', {
          action: 'skip',
          reason: verdict,
        }),
      )
      return true
    })
    if (ended) {
      await deliverDecision(taskId, 'skip')
      await d().notifier.sendText(
        verdict === 'closed' ? CARD_FLOW_TEXTS.pageClosed : CARD_FLOW_TEXTS.pageBidAlready,
        { place: 'leads' },
      )
      // A card Boris already has (he pressed on it) becomes the short closed card at once.
      const found = verdict === 'closed' ? await leadOfTask(taskId) : null
      if (found) await closeCardMessages(found)
    }
    return
  }
  if (!l.draftText) {
    const source = {
      ...sourceOf(l),
      ...full,
      client_info: full.client_info ?? sourceOf(l).client_info,
    }
    await storeDraft(
      l,
      await draftFor(source, {
        correlationId: l.correlationId,
        accountId: l.accountId,
        site: await readClientSite(l, source),
      }),
    )
  }
  await sendCard(taskId, 'summary')
}

/**
 * «Разбор»: the Analyst's full reading as its own message(s). It reads only, in any state of the task, so an old
 * card works as well as the new one, and it can be pressed again.
 */
async function onAnalysis(taskId: string): Promise<string> {
  const found = await leadOfTask(taskId)
  if (!found) return TEXTS.noTask
  // The reminder layout of an unscored card is the longest: if any version cut the order text, this one does.
  const card = await cardOfFound(found, true)
  try {
    for (const message of analysisMessages({ ...card, unscored: !card.score })) {
      await d().notifier.sendText(message, { html: true, place: 'leads' })
    }
  } catch (err) {
    // Reading is harmless to repeat: Boris presses again.
    console.error('analysis not sent', err instanceof Error ? err.message.slice(0, 200) : err)
    return TEXTS.analysisFailed
  }
  return TEXTS.analysisSent
}

/** «Изменить»: Sara asks for the new text; the card stays as it is until the text comes. */
async function onEdit(taskId: string): Promise<string> {
  const found = await leadOfTask(taskId)
  if (found?.task.kind !== 'lead_decision' || found.task.state !== 'open') return TEXTS.alreadyDone
  await askForDraft(d(), { taskId, title: found.lead.title }, new Date())
  return TEXTS.waitingDraft
}

/**
 * The new bid text and or the «Стоимость услуги» (a line of its own, K2): the same greeting and length rules as the
 * Analyst's, then an updated card. The edit is journaled (draft.edited, before and after) without the greeting, so
 * no client name reaches the journal; the price as draft.priced. An answer to the price question without a price
 * changes nothing and the question stays open.
 */
async function onDraftText(a: DraftAnswer): Promise<string> {
  const found = await leadOfTask(a.question.entityId)
  if (found?.task.state !== 'open') {
    // Decided meanwhile: the requests are closed so a later message does not land on them.
    await d().db.transaction(async (tx) => {
      await markAnswered(tx, a.question, a)
      await closeDraftRequests(tx, a.question.entityId, a.at)
    })
    return TEXTS.draftLate
  }
  const { lead: l, task: t } = found
  const forPrice = a.question.kind === 'edit_price'
  const said = priceOf(a.text, { bare: forPrice })
  // The price was asked for: words without one are not taken for a new text.
  if (forPrice && said.priceRub === null) return TEXTS.priceNotFound
  const next = said.text === null ? null : editOf(said.text, l.clientName, greetingMoment())
  // Too long: the request stays open, the next text answers it. The length is the one at the worst hour of the day
  // (the evening greeting is the longest), so what fits now fits whenever the bid is sent.
  if (next !== null) {
    const longest = bidLengthMax(next, l.clientName)
    // The count is with the evening greeting; when the greeting Boris sees now is shorter, the answer says so.
    const shown = bidTextAt(next, l.clientName, greetingMoment()).length
    if (longest > BID_TEXT_MAX) return TEXTS.draftTooLong(longest, longest !== shown)
  }
  const saved = await d().db.transaction(async (tx) => {
    if (!(await markAnswered(tx, a.question, a))) return false
    await closeDraftRequests(tx, t.id, a.at)
    if (next !== null) {
      await tx.update(lead).set({ draftText: next }).where(eq(lead.id, l.id))
      await appendEvent(
        tx,
        ev('draft.edited', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
          before: l.draftText === null ? null : bodyOf(l.draftText),
          after: bodyOf(next),
          voice: a.voice,
        }),
      )
    }
    if (said.priceRub !== null) {
      await tx
        .update(lead)
        .set({ draftPriceRub: said.priceRub, draftPriceToRub: said.priceToRub })
        .where(eq(lead.id, l.id))
      await appendEvent(
        tx,
        ev('draft.priced', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
          before: l.draftPriceRub,
          after: said.priceRub,
          voice: a.voice,
        }),
      )
    }
    return true
  })
  if (!saved) return TEXTS.alreadyDone
  await sendCard(t.id, 'edit')
  if (next === null) return TEXTS.priceSaved(l.title)
  return said.priceRub === null ? TEXTS.draftSaved(l.title) : TEXTS.draftAndPriceSaved(l.title)
}

async function saveBidText(p: {
  taskId: string
  text: string | null
  priceRub: number | null
  priceToRub?: number | null
  followUps?: string[] | null
}): Promise<{ saved: boolean; message: string }> {
  const found = await leadOfTask(p.taskId)
  if (found?.task.kind !== 'lead_decision' || found.task.state !== 'open')
    return { saved: false, message: TEXTS.alreadyDone }
  const { lead: l, task: t } = found
  const next = p.text === null ? null : editOf(p.text, l.clientName, greetingMoment())
  if (next !== null) {
    const longest = bidLengthMax(next, l.clientName)
    const shown = bidTextAt(next, l.clientName, greetingMoment()).length
    if (longest > BID_TEXT_MAX)
      return { saved: false, message: TEXTS.draftTooLong(longest, longest !== shown) }
  }
  const series = p.followUps == null ? null : followUpsEdit(p.followUps)
  if (p.followUps != null && series === null)
    return { saved: false, message: TEXTS.followUpsTooLong(FOLLOW_UP_EDIT_MAX) }
  const before = l.draftFollowUps ?? []
  const seriesChanged = series !== null && series.join('\n\n') !== before.join('\n\n')
  const at = new Date()
  await d().db.transaction(async (tx) => {
    // A question still open after «Изменить» in Telegram is answered by this edit.
    await closeDraftRequests(tx, t.id, at)
    if (next !== null && next !== l.draftText) {
      await tx.update(lead).set({ draftText: next }).where(eq(lead.id, l.id))
      await appendEvent(
        tx,
        ev('draft.edited', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
          before: l.draftText === null ? null : bodyOf(l.draftText),
          after: bodyOf(next),
          voice: false,
        }),
      )
    }
    if (series !== null && seriesChanged) {
      await tx
        .update(lead)
        .set({ draftFollowUps: series.length > 0 ? series : null })
        .where(eq(lead.id, l.id))
      // Like the bid text: what Sara wrote and what Boris made of it, for the lessons (never the client's words).
      await appendEvent(
        tx,
        ev('draft.edited', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
          before: before.join('\n\n'),
          after: series.join('\n\n'),
          voice: false,
          part: 'follow_ups',
        }),
      )
    }
    const toRub = p.priceToRub ?? null
    if (p.priceRub !== null && (p.priceRub !== l.draftPriceRub || toRub !== l.draftPriceToRub)) {
      await tx
        .update(lead)
        .set({ draftPriceRub: p.priceRub, draftPriceToRub: toRub })
        .where(eq(lead.id, l.id))
      await appendEvent(
        tx,
        ev('draft.priced', { kind: 'lead', id: l.id }, l.correlationId, 'boris', {
          before: l.draftPriceRub,
          after: p.priceRub,
          voice: false,
        }),
      )
    }
  })
  const message =
    next !== null && p.priceRub !== null
      ? TEXTS.draftAndPriceSaved(l.title)
      : next !== null
        ? TEXTS.draftSaved(l.title)
        : p.priceRub !== null
          ? TEXTS.priceSaved(l.title)
          : TEXTS.followUpsSaved(l.title)
  return { saved: true, message }
}

/**
 * A button of the daily summary brings its order back as a normal card with a decision task, once: «Взял бы»
 * on a dropped order (lead_review, want) or «Показать» on one held over the card cap (lead_held, open).
 */
async function bringCard(
  fromId: string,
  kind: 'lead_review' | 'lead_held',
  action: 'want' | 'open',
): Promise<typeof lead.$inferSelect | null> {
  const [t] = await d().db.select().from(task).where(eq(task.id, fromId))
  if (t?.kind !== kind) return null
  const [l] = await d().db.select().from(lead).where(eq(lead.id, t.entityId))
  if (!l) return null
  const decisionId = newEventId()
  const resolved = await d().db.transaction(async (tx) => {
    const rows = await tx
      .update(task)
      .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
      .where(and(eq(task.id, fromId), eq(task.state, 'open')))
      .returning({ id: task.id })
    if (rows.length === 0) return false
    await appendEvent(
      tx,
      ev('task.resolved', { kind: 'task', id: fromId }, l.correlationId, 'boris', { action }),
    )
    await tx
      .insert(task)
      .values({ id: decisionId, kind: 'lead_decision', entityKind: 'lead', entityId: l.id })
    await tx.update(lead).set({ status: 'queued' }).where(eq(lead.id, l.id))
    await appendEvent(
      tx,
      // Brought from the summary hours after the order: not a lead-to-card time (FR-ANL-3).
      ev('task.created', { kind: 'task', id: decisionId }, l.correlationId, 'sara', {
        lead_id: l.id,
        via: 'summary',
      }),
    )
    return true
  })
  if (!resolved) return null
  await startDecisionWait(decisionId, await d().remindAfterMs())
  if (action === 'open' && l.draftText) {
    // A held order that has its draft (a race with the cap, an order held before drafts waited): the card goes at once.
    await sendCard(decisionId, 'summary')
  } else {
    // A dropped or held order has no draft yet: the press is answered now, the card follows its draft (if this
    // fails, the reminder delivers it once).
    void draftThenCard(l, decisionId).catch((err) =>
      console.error('want card failed', err instanceof Error ? err.message.slice(0, 200) : err),
    )
  }
  return l
}

/**
 * «Взял бы» from the daily summary: Boris's yes on an order Sara dropped. It is a label and a surprise («почему?»),
 * and the order comes back as a normal card so he can bid on it.
 */
async function onWant(reviewId: string): Promise<string> {
  const l = await bringCard(reviewId, 'lead_review', 'want')
  if (!l) return TEXTS.alreadyDone
  learnFrom({ leadId: l.id, label: 'yes', source: 'summary' }, 'why_want', l.title)
  return TEXTS.wantCard
}

/** «Показать» from the daily summary: an order held over the card cap comes as a card; Boris has not decided yet. */
async function onOpen(heldId: string): Promise<string> {
  const found = await leadOfTask(heldId)
  const now = new Date()
  // FR-LEAD-10 at a press that comes days after the summary. The summary offered the order while it was fresh, so a
  // press the same day works for it, however old it has become by then. The lead keeps no publication time; seen_at
  // is never earlier, so this errs toward showing.
  if (
    found?.task.kind === 'lead_held' &&
    found.task.state === 'open' &&
    isStale(found.lead.seenAt, now) &&
    isStale(found.task.createdAt, now)
  )
    return CARD_FLOW_TEXTS.staleHeld
  const l = await bringCard(heldId, 'lead_held', 'open')
  if (!l) return TEXTS.alreadyDone
  return l.draftText ? TEXTS.cardSent : TEXTS.wantCard
}

/**
 * The label and the «почему?» after a decision. Not awaited and never thrown: learning must not hold up or
 * break a bid or a card that already happened.
 */
function learnFrom(
  label: Parameters<typeof recordLabel>[1],
  why: 'why_skip' | 'why_want',
  title: string,
  /** The reason came with the press (the pult): nothing to ask. */
  ask = true,
): void {
  // A test order teaches nothing: no label, no «почему?» (docs/ops/test-leads.md).
  if (isTestOrder(label.leadId)) return
  void (async () => {
    const labeled = await recordLabel(d().db, label)
    if (labeled.surprise && ask)
      await askWhy(d(), { kind: why, entityId: label.leadId, title }, new Date())
  })().catch((e) => console.error('learning skipped', e instanceof Error ? e.message : e))
}

export function createLeadPipeline(dp: LeadPipelineDeps): LeadPipeline {
  deps = dp
  return {
    async onOrderSeen(e) {
      if (e.type !== 'profi.order_seen') return
      const order = ProfiOrder.safeParse(e.payload)
      if (!order.success) return
      await DBOS.startWorkflow(processOrderWorkflow, { workflowID: `lead:${order.data.order_id}` })(
        e,
      )
    },

    async onPress({ taskId, action, source, reason }) {
      // The preview of the past bids for Boris's sheet has no task row: its id only carries the press.
      if (taskId === SHEET_TASK_ID) return onSheetPress(d(), action)
      if (action === 'want') return onWant(taskId)
      if (action === 'open') return onOpen(taskId)
      if (action === 'edit') return onEdit(taskId)
      if (action === 'razbor') return onAnalysis(taskId)
      if (action === 'apply' || action === 'drop') return onProposalPress(d(), taskId, action)
      if (action !== 'bid' && action !== 'skip') return TEXTS.alreadyDone
      const found = await leadOfTask(taskId)
      if (!found) return TEXTS.alreadyDone
      const { lead: l } = found
      // Paused or refused for money: nothing is decided, the card stays usable for a press later.
      let wallet: number | null = null
      if (action === 'bid' && found.task.state === 'open') {
        // Before anything is closed or spent: the task stays open for whoever the order really belongs to.
        if (await lostRoute(d().db, l.id, l.accountId)) return TEXTS.lostRoute
        // A test order spends nothing and reaches no client: neither the pause nor the wallet holds it.
        if (!isTestOrder(l.id) && !(await getSetting(d().db, 'outbound.bids')))
          return TEXTS.bidsPausedPress
        // No text to send yet: the card waits for «Изменить», and the wallet need not be read.
        if (l.draftText === null) return TEXTS.noDraft
        // The fee is the most the node may pay, so an unknown one never goes: the page is read now (#89 could not).
        if (l.bidPriceRub <= 0) {
          void feeThenCard(l, taskId).catch((err) =>
            console.error(
              'fee read failed',
              err instanceof Error ? err.message.slice(0, 200) : err,
            ),
          )
          return TEXTS.feeChecking
        }
        // Profi.ru takes no bid without «Стоимость услуги» (#79: required on every live answer): Sara asks for it.
        if (l.draftPriceRub === null) {
          await askForDraft(d(), { taskId, title: l.title }, new Date(), 'price')
          return TEXTS.waitingPrice
        }
        if (!isTestOrder(l.id)) wallet = await readWallet(d().profi, l.accountId)
      }
      let outboxId: string | null = null
      let refusal: string | null = null
      const resolved = await d()
        .db.transaction(async (tx) => {
          const rows = await tx
            .update(task)
            .set({ state: 'resolved', resolution: action, resolvedAt: new Date().toISOString() })
            .where(and(eq(task.id, taskId), eq(task.state, 'open')))
            .returning({ id: task.id })
          if (rows.length === 0) return false
          // The bid goes as the lead is now, read under its lock: an edit during the wallet wait is not lost.
          const [now] =
            action === 'bid'
              ? await tx.select().from(lead).where(eq(lead.id, l.id)).for('update')
              : [l]
          if (!now) return false
          if (action === 'bid') {
            refusal =
              now.draftText === null
                ? TEXTS.noDraft
                : now.draftPriceRub === null
                  ? TEXTS.noPrice
                  : isTestOrder(l.id)
                    ? null
                    : await refuseSpend(tx, {
                        feeRub: now.bidPriceRub,
                        balanceRub: wallet,
                        now: new Date(),
                      })
            // Rolled back: the task stays open and nothing about the bid is written.
            if (refusal) tx.rollback()
          }
          await appendEvent(
            tx,
            ev('task.resolved', { kind: 'task', id: taskId }, l.correlationId, 'boris', { action }),
          )
          if (action === 'skip') {
            await tx.update(lead).set({ status: 'skipped' }).where(eq(lead.id, l.id))
            await appendEvent(
              tx,
              ev('lead.skipped', { kind: 'lead', id: l.id }, l.correlationId, 'boris'),
            )
          } else {
            // Checked above; should the draft be gone, the whole decision rolls back rather than bid without it.
            if (now.draftText === null) throw new Error('a bid without its text')
            // Boris's decision and the intent to bid commit together: a crash cannot lose one of them.
            const bid = await recordBid(tx, {
              leadId: l.id,
              accountId: l.accountId,
              text: now.draftText,
              clientName: now.clientName,
              correlationId: l.correlationId,
              title: l.title,
              priceRub: now.bidPriceRub,
              servicePriceRub: now.draftPriceRub,
              servicePriceToRub:
                now.draftPriceRub === null
                  ? null
                  : priceRange(now.draftPriceRub, now.draftPriceToRub).to,
              // The same press approves the series as it stands now (Boris, 29.10.2026), without the links a client
              // is never given (30.10.2026: a draft made before a site was put on the list may still hold one).
              followUps: seriesWithoutBlocked(
                now.draftFollowUps ?? [],
                await getSetting(tx, 'links.blocked'),
              ),
              taskId,
            })
            // The order went to another direction after all: rolled back like a refused spend, the task stays open.
            if (bid.outboxId === null) {
              refusal = TEXTS.lostRoute
              tx.rollback()
            }
            outboxId = bid.outboxId
          }
          return true
        })
        .catch((e) => {
          // The rollback of a refused bid; anything else is a real failure.
          if (refusal) return false
          throw e
        })
      if (refusal) return refusal
      if (!resolved) return TEXTS.alreadyDone
      await deliverDecision(taskId, action)
      if (outboxId) await startOutboxDelivery(outboxId)
      const fromPult = source === 'pult' || source === 'hold'
      learnFrom(
        {
          leadId: l.id,
          label: action === 'bid' ? 'yes' : 'no',
          source: fromPult ? 'pult' : 'card',
          reason: action === 'skip' ? (reason ?? null) : null,
        },
        'why_skip',
        l.title,
        // No «почему?» after a close (Boris, 31.10.2026): the label keeps what the rules need to guess the reason.
        action === 'bid' && !fromPult,
      )
      // «Закрыть заявку»: the card he pressed is edited into «📁 Заявка закрыта», whoever pressed (the bot, the pult,
      // the secretary); a card that never went out has nothing to edit.
      if (action === 'skip' && found.task.kind === 'lead_decision')
        await closeCardMessages(found, { byBoris: true }).catch((err) =>
          console.error(
            'closed card not edited',
            taskId,
            err instanceof Error ? err.message.slice(0, 200) : err,
          ),
        )
      return action === 'skip' ? TEXTS.skipped : TEXTS.bidQueued
    },

    async onReminder(taskId) {
      // Boris has the card: he is not sent it again, and nothing is journaled.
      if (await cardDelivered(taskId)) return
      // The first card never went out (Telegram was down): it is delivered now, once, as the plain card.
      await resendCardOf(taskId)
    },

    resendCard: resendCardOf,

    async closeOnSite(taskId, via) {
      const found = await leadOfTask(taskId)
      if (!found) return
      const { lead: l } = found
      const ended = await d().db.transaction(async (tx) => {
        const rows = await tx
          .update(task)
          .set({ state: 'resolved', resolution: 'skip', resolvedAt: new Date().toISOString() })
          .where(and(eq(task.id, taskId), eq(task.state, 'open')))
          .returning({ id: task.id })
        // Decided meanwhile: a recheck leaves it all alone. After a failed press the task is Boris's own decision
        // (the bid he pressed) and stays, but its card is closed all the same.
        if (rows.length === 0 && via === 'recheck') return null
        if (rows.length > 0) {
          await appendEvent(
            tx,
            ev('task.resolved', { kind: 'task', id: taskId }, l.correlationId, 'sara', {
              action: 'skip',
              reason: 'closed',
            }),
          )
        }
        await tx
          .update(lead)
          .set({ status: 'closed' })
          .where(and(eq(lead.id, l.id), ne(lead.status, 'bid_sent')))
        await appendEvent(
          tx,
          ev('lead.closed_on_site', { kind: 'lead', id: l.id }, l.correlationId, 'sara', { via }),
        )
        return { here: rows.length > 0 }
      })
      if (!ended) return
      if (ended.here) {
        await deliverDecision(taskId, 'skip').catch((err) =>
          console.error(
            'decision wait not released',
            taskId,
            err instanceof Error ? err.message.slice(0, 200) : err,
          ),
        )
      }
      await closeCardMessages(found)
    },

    async closeStale(taskId, at = new Date()) {
      const found = await leadOfTask(taskId)
      if (!found || found.task.kind !== 'lead_decision') return false
      const { lead: l } = found
      if (!isStale(l.seenAt, at) || !isStale(found.task.createdAt, at)) return false
      const ended = await d().db.transaction(async (tx) => {
        const rows = await tx
          .update(task)
          .set({ state: 'resolved', resolution: 'skip', resolvedAt: at.toISOString() })
          .where(and(eq(task.id, taskId), eq(task.state, 'open')))
          .returning({ id: task.id })
        if (rows.length === 0) return false
        await appendEvent(
          tx,
          ev('task.resolved', { kind: 'task', id: taskId }, l.correlationId, 'sara', {
            action: 'skip',
            reason: 'stale',
          }),
        )
        await tx
          .update(lead)
          .set({ status: 'stale' })
          .where(and(eq(lead.id, l.id), ne(lead.status, 'bid_sent'), ne(lead.status, 'closed')))
        await appendEvent(
          tx,
          ev('lead.stale', { kind: 'lead', id: l.id }, l.correlationId, 'sara', {
            seen_at: new Date(l.seenAt).toISOString(),
            via: 'card',
          }),
        )
        return true
      })
      if (!ended) return false
      await deliverDecision(taskId, 'skip').catch((err) =>
        console.error(
          'decision wait not released',
          taskId,
          err instanceof Error ? err.message.slice(0, 200) : err,
        ),
      )
      await closeCardMessages(found, { stale: at })
      return true
    },

    onDraftText,
    saveBidText,
  }
}
