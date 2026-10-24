import { DBOS } from '@dbos-inc/dbos-sdk'

/** DBOS keeps its own system database next to ours: `<db>_dbos_sys`. */
export function systemDatabaseUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl)
  u.pathname = `${u.pathname}_dbos_sys`
  return u.toString()
}

/**
 * Version of the durable workflows. DBOS resumes only unfinished workflows of the same version and by
 * default derives it from the code, so every deploy would strand pending waits. Bump it only when a
 * change makes old unfinished workflows unsafe to resume (then they need a migration plan).
 */
export const WORKFLOW_VERSION = '1'

export async function launchDbos(databaseUrl: string): Promise<void> {
  DBOS.setConfig({
    name: 'sara-core',
    systemDatabaseUrl: systemDatabaseUrl(databaseUrl),
    applicationVersion: WORKFLOW_VERSION,
    // A new step goes behind DBOS.patch, so a run recorded before it resumes along its old steps.
    enablePatching: true,
    logLevel: 'warn',
  })
  await DBOS.launch()
}

export async function shutdownDbos(): Promise<void> {
  await DBOS.shutdown()
}
