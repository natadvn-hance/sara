import { DirectionRules, newEventId } from '@sara/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db, Tx } from '../db/client'
import { directionVersion } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { RULES_V1 } from './v1'

export type ActiveRules = { version: number; rules: DirectionRules }

/** A new active version inside the caller's transaction (one writer per account at a time). */
export async function insertVersion(
  tx: Tx,
  v: { accountId: string; rules: DirectionRules; createdBy: 'seed' | 'boris'; reason: string },
): Promise<number> {
  // One writer at a time per account, so two new versions never get the same number.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`direction:${v.accountId}`}))`)
  const [last] = await tx
    .select({ version: directionVersion.version })
    .from(directionVersion)
    .where(eq(directionVersion.accountId, v.accountId))
    .orderBy(desc(directionVersion.version))
    .limit(1)
  const version = (last?.version ?? 0) + 1
  await tx
    .update(directionVersion)
    .set({ active: false })
    .where(and(eq(directionVersion.accountId, v.accountId), eq(directionVersion.active, true)))
  await tx.insert(directionVersion).values({
    accountId: v.accountId,
    version,
    rules: DirectionRules.parse(v.rules),
    createdBy: v.createdBy,
    reason: v.reason,
    active: true,
  })
  await appendEvent(tx, {
    type: 'direction.version_created',
    v: 1,
    entity: { kind: 'direction', id: v.accountId },
    account_id: v.accountId,
    actor: v.createdBy === 'boris' ? 'boris' : 'system',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: newEventId(),
    reason: v.reason,
    payload: { version },
  })
  return version
}

/** Writes version 1 (old Sara's rules) for an account that has no rules yet. */
export async function seedDirection(db: Db, accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`direction:${accountId}`}))`)
    const [any] = await tx
      .select({ v: directionVersion.version })
      .from(directionVersion)
      .where(eq(directionVersion.accountId, accountId))
      .limit(1)
    if (any) return
    await insertVersion(tx, {
      accountId,
      rules: RULES_V1,
      createdBy: 'seed',
      reason: 'правила старой Сары',
    })
  })
}

export async function activeRules(db: Db | Tx, accountId: string): Promise<ActiveRules> {
  const [row] = await db
    .select()
    .from(directionVersion)
    .where(and(eq(directionVersion.accountId, accountId), eq(directionVersion.active, true)))
  if (!row) throw new Error(`account ${accountId} has no active direction rules`)
  return { version: row.version, rules: DirectionRules.parse(row.rules) }
}

/** A new version becomes the active one; the previous ones stay as history. */
export function addVersion(
  db: Db,
  v: { accountId: string; rules: DirectionRules; createdBy: 'seed' | 'boris'; reason: string },
): Promise<number> {
  return db.transaction((tx) => insertVersion(tx, v))
}

/** A rollback never rewrites history: it is a new version carrying the old rules (FR-MIND-3). */
export async function rollbackTo(db: Db, accountId: string, version: number): Promise<number> {
  const [old] = await db
    .select()
    .from(directionVersion)
    .where(and(eq(directionVersion.accountId, accountId), eq(directionVersion.version, version)))
  if (!old) throw new Error(`account ${accountId} has no rules v${version}`)
  return addVersion(db, {
    accountId,
    rules: DirectionRules.parse(old.rules),
    createdBy: 'boris',
    reason: `откат к v${version}`,
  })
}

export async function listVersions(db: Db, accountId: string) {
  return db
    .select({
      version: directionVersion.version,
      createdAt: directionVersion.createdAt,
      createdBy: directionVersion.createdBy,
      reason: directionVersion.reason,
      active: directionVersion.active,
    })
    .from(directionVersion)
    .where(eq(directionVersion.accountId, accountId))
    .orderBy(directionVersion.version)
}
