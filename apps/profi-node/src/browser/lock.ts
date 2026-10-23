import pg from 'pg'
import { ProfiToolError } from '../mcp/server'

/**
 * One browser per account (ADR-003): a second browser on the same session killed the login on 29.09.2026.
 * The lock is a Postgres advisory lock held on its own connection for the browser's lifetime. It works across
 * processes and containers, and it is released by itself when the holder dies, so a crash never bricks a restart.
 */
export async function acquireAccountLock(
  databaseUrl: string,
  accountId: string,
): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  // A dropped connection releases the lock; the error must not crash the service.
  client.on('error', () => {})
  const r = await client.query<{ ok: boolean }>(
    "select pg_try_advisory_lock(hashtext('profi-account:' || $1)) as ok",
    [accountId],
  )
  if (!r.rows[0]?.ok) {
    await client.end()
    throw new ProfiToolError(
      'INTERNAL',
      `SECOND_BROWSER: account ${accountId} already has a browser open`,
    )
  }
  return async () => {
    await client.end().catch(() => {})
  }
}
