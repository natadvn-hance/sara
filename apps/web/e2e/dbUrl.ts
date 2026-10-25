/** The e2e databases live on the server DATABASE_URL names (the CI service, or your own Postgres), under another name. */
export function dbUrl(name: string): string {
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara')
  u.pathname = `/${name}`
  return u.toString()
}
