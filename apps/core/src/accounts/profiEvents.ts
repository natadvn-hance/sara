import { DBOS } from '@dbos-inc/dbos-sdk'
import type { EventEnvelope } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { account } from '../db/schema'
import { TEXTS } from '../notify/cards'
import type { Notifier } from '../notify/notifier'

export type ProfiEventDeps = { db: Db; notifier: Pick<Notifier, 'sendText'>; publicUrl: string }

async function setState(db: Db, id: string, loginState: string): Promise<string> {
  const rows = await db
    .update(account)
    .set({ loginState, updatedAt: new Date().toISOString() })
    .where(eq(account.id, id))
    .returning({ title: account.title })
  return rows[0]?.title ?? id
}

/**
 * Account-level Profi events. Each arrives once (C8 dedupe by id) and the service sends them only on a
 * change of state, so one message per change reaches Boris (FR-OPS-2, F8).
 */
export async function handleProfiEvent(d: ProfiEventDeps, e: EventEnvelope): Promise<void> {
  const id = e.account_id ?? e.entity.id
  switch (e.type) {
    case 'profi.session_dead': {
      const title = await setState(d.db, id, 'dead')
      await d.notifier.sendText(TEXTS.sessionDead(title, `${d.publicUrl}/accounts/${id}/login`))
      return
    }
    case 'profi.profile_banned': {
      const title = await setState(d.db, id, 'banned')
      await d.notifier.sendText(TEXTS.banned(title))
      return
    }
    case 'profi.session_alive': {
      const title = await setState(d.db, id, 'alive')
      await d.notifier.sendText(TEXTS.sessionAlive(title))
      return
    }
    default:
      return
  }
}

let deps: ProfiEventDeps | null = null

const handleWorkflow = DBOS.registerWorkflow(
  async (e: EventEnvelope) => {
    const d = deps
    if (!d) throw new Error('Profi events are not configured')
    await DBOS.runStep(() => handleProfiEvent(d, e), {
      name: 'handle',
      retriesAllowed: true,
      maxAttempts: 5,
      intervalSeconds: 2,
    })
  },
  { name: 'profiAccountEvent' },
)

/** Account events run once per event id, even when the node delivers the same event again. */
export function createProfiEventDispatcher(d: ProfiEventDeps): (e: EventEnvelope) => Promise<void> {
  deps = d
  return async (e) => {
    await DBOS.startWorkflow(handleWorkflow, { workflowID: `profi-event:${e.id}` })(e)
  }
}
