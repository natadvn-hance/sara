import type { SessionHealthOutput } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { AccountConfig } from '../api/deps'
import type { DbOrTx } from '../db/client'
import { account } from '../db/schema'

export type AccountView = {
  id: string
  title: string
  login_state: string
  balance_rub: number | null
  presence: boolean
  egress_ip: string | null
  ip_ok: boolean
}

export async function seedAccounts(db: DbOrTx, accounts: AccountConfig[]): Promise<void> {
  for (const a of accounts) {
    await db
      .insert(account)
      .values({ id: a.id, title: a.title, egressIp: a.egressIp })
      .onConflictDoUpdate({ target: account.id, set: { title: a.title, egressIp: a.egressIp } })
  }
}

/** Writes what Profi-MCP reports about an account; the IP must be the account's own. */
export async function syncAccount(
  db: DbOrTx,
  a: AccountConfig,
  h: SessionHealthOutput | null,
): Promise<AccountView> {
  const now = new Date().toISOString()
  const loginState = h === null ? 'unknown' : h.alive ? 'alive' : 'dead'
  await seedAccounts(db, [a])
  await db
    .update(account)
    .set({
      loginState,
      presence: h?.presence ?? false,
      ...(h?.balance_rub != null ? { balanceRub: h.balance_rub, balanceAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(account.id, a.id))
  const [row] = await db.select().from(account).where(eq(account.id, a.id))
  return {
    id: a.id,
    title: a.title,
    login_state: loginState,
    balance_rub: row?.balanceRub ?? null,
    presence: h?.presence ?? false,
    egress_ip: h?.egress_ip ?? null,
    ip_ok: h?.egress_ip === a.egressIp,
  }
}
