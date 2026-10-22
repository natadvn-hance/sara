import { DBOS } from '@dbos-inc/dbos-sdk'

/** DBOS keeps its own system database next to ours: `<db>_dbos_sys`. */
export function systemDatabaseUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl)
  u.pathname = `${u.pathname}_dbos_sys`
  return u.toString()
}

export async function launchDbos(databaseUrl: string): Promise<void> {
  DBOS.setConfig({
    name: 'sara-core',
    systemDatabaseUrl: systemDatabaseUrl(databaseUrl),
    logLevel: 'warn',
  })
  await DBOS.launch()
}

export async function shutdownDbos(): Promise<void> {
  await DBOS.shutdown()
}
