import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ProfiSite, startProfiSite } from '../../../tests/fakes/profiSite/server'
import { type AccountBrowser, openAccountBrowser } from '../src/browser/accountBrowser'
import { outboxNode } from '../src/db/schema'
import { createSessionWatch, requireAlive } from '../src/watch/sessionWatch'
import { openNodeTestDb, resetNodeDb } from './helpers/db'

const { db, close } = openNodeTestDb()
let site: ProfiSite
let ab: AccountBrowser
beforeAll(async () => {
  ab = await openAccountBrowser({
    accountId: 'hance-marketing',
    profileDir: await mkdtemp(join(tmpdir(), 'watch-')),
    proxy: null,
    headless: true,
  })
}, 60000)
afterAll(async () => {
  await ab.close()
  await close()
})
beforeEach(async () => {
  await resetNodeDb(db)
  site = await startProfiSite()
})
afterEach(() => site.close())

async function login() {
  await ab.page.goto(`${site.url}/login`)
  await ab.page.fill('#phone', '+79000000001')
  await ab.page.click('#send-phone')
  await ab.page.fill('#code', site.code)
  await ab.page.click('#send-code')
  await ab.page.waitForURL(/backoffice/)
}

async function queued(type: string): Promise<number> {
  const rows = await db.select().from(outboxNode)
  return rows.filter((r) => (r.payload as { type: string }).type === type).length
}

const BAN = ['Ваш профиль заблокирован']

describe('session watch', () => {
  it('FR-OPS-2: logout gives one alarm and stops the account', async () => {
    await login()
    const w = createSessionWatch({
      accountId: 'hance-marketing',
      page: ab.page,
      db,
      banMarkers: BAN,
      onAlive: () => {},
    })
    await w.tick()
    site.logout()
    await ab.page.reload()
    for (let i = 0; i < 3; i++) await w.tick()
    expect(await queued('profi.session_dead')).toBe(1)
    expect(w.state()).toBe('dead')
    expect(() => requireAlive(w)).toThrow(expect.objectContaining({ errorClass: 'SESSION_DEAD' }))
  }, 60000)

  it('FR-OPS-2: a ban gives one alarm', async () => {
    await login()
    const w = createSessionWatch({
      accountId: 'hance-marketing',
      page: ab.page,
      db,
      banMarkers: BAN,
      onAlive: () => {},
    })
    await w.tick()
    site.ban()
    await ab.page.reload()
    await w.tick()
    await w.tick()
    expect(await queued('profi.profile_banned')).toBe(1)
    expect(() => requireAlive(w)).toThrow(expect.objectContaining({ errorClass: 'BANNED' }))
  }, 60000)

  it('F8: after login again one green message and a reconcile since the logout', async () => {
    await login()
    const since: string[] = []
    const w = createSessionWatch({
      accountId: 'hance-marketing',
      page: ab.page,
      db,
      banMarkers: BAN,
      onAlive: (s) => since.push(s),
    })
    await w.tick()
    site.logout()
    await ab.page.reload()
    await w.tick()
    await login()
    await w.tick()
    await w.tick()
    expect(await queued('profi.session_alive')).toBe(1)
    expect(since).toHaveLength(1)
    const [row] = await db.select().from(outboxNode).where(eq(outboxNode.attempts, 0))
    expect(row).toBeDefined()
  }, 60000)
})
