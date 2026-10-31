import { join } from 'node:path'
import {
  createStand,
  LIVE_TIMING,
  type RealCopy,
  type Stand,
  type Timing,
} from '@sara/profi-node/stand'
import { desc, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { lead } from '../db/schema'
import { createProfiClient, type ProfiClient } from '../profi/client'
import { createClientModel } from './clientModel'
import { LeadRow, pseudonymize } from './pseudonymize'
import { IS_TEST, notTest } from './sql'
import { wipeTestOrders } from './wipe'

/** The client model writes no more than this a Moscow day for all test chats, and this many lines in one chat. */
export const CLIENT_LIMITS = { daily: 40, perChat: 8 }
/** How many of the latest real orders the copies are made from, and how long the made-up copies are kept. */
const COPIES = 300
const COPIES_TTL_MS = 10 * 60_000

export type TestLeads = {
  stand: Stand
  /** The Profi client of test orders: the made-up Profi.ru inside the core, never the node. */
  profi: ProfiClient
  /** Where the made-up site sends its events: the core's own events route, once the core listens. */
  listen(coreUrl: string): void
  /** Erases every test order and starts the made-up site over; returns how many orders were erased. */
  wipe(): Promise<number>
  close(): Promise<void>
}

/** The highest test number in the journal, which is append-only and so outlives every erase. */
async function usedUpTo(db: Db): Promise<number> {
  const r = await db.execute<{ n: string | null }>(sql`
    select max(substring(entity_id from 3)::bigint)::text as n from core.event
    where entity_kind = 'lead' and ${IS_TEST('entity_id')}`)
  return Number(r.rows[0]?.n ?? 0)
}

/** The latest real orders with made-up names, contacts and links, for copies in the test feed. */
function realCopies(db: Db): () => Promise<RealCopy[]> {
  let kept: { at: number; copies: RealCopy[] } | null = null
  return async () => {
    if (kept && Date.now() - kept.at < COPIES_TTL_MS) return kept.copies
    const rows = await db
      .select()
      .from(lead)
      .where(notTest(lead.id))
      .orderBy(desc(lead.seenAt))
      .limit(COPIES)
    const copies = rows.flatMap((r) => {
      const row = LeadRow.safeParse({
        id: r.id,
        title: r.title,
        category: r.category,
        city: r.city,
        text: r.text,
        client_name: r.clientName,
        budget_text: r.budgetText,
        bid_price_rub: r.bidPriceRub,
        client_info: r.clientInfo ?? null,
      })
      return row.success ? [pseudonymize(row.data)] : []
    })
    kept = { at: Date.now(), copies }
    return copies
  }
}

/**
 * Test orders inside the live Sara (Boris, 30.10.2026; docs/ops/test-leads.md): the made-up Profi.ru of the e2e tests
 * runs in the core on 127.0.0.1, its orders come to the core's own events route with test numbers, and their clients
 * answer by persona or as Boris writes for them.
 */
export async function startTestLeads(o: {
  db: Db
  dataDir: string
  nodeToken: string
  permitSecret: string
  claudeBin: string
  rolesDir: string
  token: () => Promise<string | null>
  claudeEnv?: () => Record<string, string>
  timing?: Timing
  limits?: { daily: number; perChat: number }
}): Promise<TestLeads> {
  const stand = await createStand({
    port: 0,
    host: '127.0.0.1',
    // Set once the core listens (listen below); nothing is sent before Boris asks for a test order.
    coreEventsUrl: 'http://127.0.0.1:1/internal/profi/events',
    nodeToken: o.nodeToken,
    permitSecret: o.permitSecret,
    dataDir: join(o.dataDir, 'test-orders'),
    model: createClientModel({
      claudeBin: o.claudeBin,
      rolesDir: o.rolesDir,
      token: o.token,
      cwd: o.dataDir,
      extraEnv: o.claudeEnv,
    }),
    realOrders: realCopies(o.db),
    usedUpTo: () => usedUpTo(o.db),
    modelReady: async () => (await o.token()) !== null,
    timing: o.timing ?? LIVE_TIMING,
    limits: o.limits ?? CLIENT_LIMITS,
  })
  // The made-up site answers at once: no tab, no queue, so the waits are short.
  const profi = createProfiClient({
    url: stand.mcpUrl,
    permitSecret: o.permitSecret,
    getOrderTimeoutMs: 15_000,
    tabTimeoutMs: 60_000,
  })
  return {
    stand,
    profi,
    listen(coreUrl) {
      stand.fake.setCoreEventsUrl(`${coreUrl}/internal/profi/events`)
    },
    async wipe() {
      const n = await wipeTestOrders(o.db)
      await stand.reset()
      return n
    },
    close: () => stand.close(),
  }
}
