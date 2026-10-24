import { DirectionProfileData, DirectionState, newEventId, type ReplyFormat } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client'
import { directionProfile } from '../db/schema'
import { appendEvent } from '../journal/journal'

/** What Hance marketing's bids are built from today (the Analyst's own prompt), as a format Boris can edit. */
export const DEFAULT_REPLY_FORMAT: ReplyFormat = {
  parts: [
    {
      id: 'understanding',
      title: 'Понимание ситуации',
      hint: 'Что-то конкретное про ситуацию клиента, своими словами',
    },
    { id: 'question', title: 'Один вопрос', hint: 'Один короткий вопрос про скрытую потребность' },
  ],
  max_chars: 500,
  tone: [],
  examples: [],
  max_cases: 0,
}

export type Profile = DirectionProfileData & { state: DirectionState; version: number }

/** The account that works today. Another account starts as a draft and wins no orders until its onboarding ends. */
export const LIVE_ACCOUNT = 'hance-marketing'

const startState = (accountId: string): DirectionState =>
  accountId === LIVE_ACCOUNT ? 'on' : 'draft'

/** A direction with no profile row: normal speed, no format, no cases, working only if it is the live account. */
export async function getProfile(db: DbOrTx, accountId: string): Promise<Profile> {
  const [row] = await db
    .select()
    .from(directionProfile)
    .where(eq(directionProfile.accountId, accountId))
  if (!row)
    return {
      state: startState(accountId),
      version: 0,
      speed: 'normal',
      reply_format: null,
      cases: [],
    }
  return {
    state: DirectionState.parse(row.state),
    version: row.version,
    ...DirectionProfileData.parse({
      speed: row.speed,
      reply_format: row.replyFormat,
      cases: row.cases,
    }),
  }
}

/** The row for an account that has none; an existing one is never touched (a restart must not undo Boris). */
export async function seedProfile(db: Db, accountId: string): Promise<void> {
  await db
    .insert(directionProfile)
    .values({ accountId, state: startState(accountId) })
    .onConflictDoNothing()
}

export type ProfilePatch = Partial<DirectionProfileData & { state: DirectionState }>

/**
 * Saves the changed parts of a profile (checked against the contract), growing its version by one. One writer at
 * a time per account. The journal keeps which parts changed, never their texts.
 */
export async function saveProfile(
  db: Db,
  accountId: string,
  patch: ProfilePatch,
  actor: 'boris' | 'system',
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`direction_profile:${accountId}`}))`,
    )
    const now = await getProfile(tx, accountId)
    const next = {
      state: DirectionState.parse(patch.state ?? now.state),
      ...DirectionProfileData.parse({
        speed: patch.speed ?? now.speed,
        reply_format: patch.reply_format === undefined ? now.reply_format : patch.reply_format,
        cases: patch.cases ?? now.cases,
      }),
    }
    const version = now.version + 1
    await tx
      .insert(directionProfile)
      .values({
        accountId,
        state: next.state,
        speed: next.speed,
        replyFormat: next.reply_format,
        cases: next.cases,
        version,
      })
      .onConflictDoUpdate({
        target: directionProfile.accountId,
        set: {
          state: next.state,
          speed: next.speed,
          replyFormat: next.reply_format,
          cases: next.cases,
          version,
          updatedAt: new Date().toISOString(),
        },
      })
    await appendEvent(tx, {
      type: 'direction.profile_changed',
      v: 1,
      entity: { kind: 'direction', id: accountId },
      account_id: accountId,
      actor,
      occurred_at: new Date().toISOString(),
      causation_id: null,
      correlation_id: newEventId(),
      reason: null,
      payload: { version, changed: Object.keys(patch).sort() },
    })
    return version
  })
}
