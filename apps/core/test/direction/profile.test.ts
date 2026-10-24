import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event } from '../../src/db/schema'
import {
  DEFAULT_REPLY_FORMAT,
  getProfile,
  LIVE_ACCOUNT,
  saveProfile,
  seedProfile,
} from '../../src/direction/profile'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const ACC = 'hance-marketing'
const aCase = {
  id: 'clinic_site',
  title: 'Сайт клиники',
  url: 'https://hance.example/cases/clinic',
  summary: 'Запись онлайн',
  tags: ['сайт'],
  show_when: 'Нужен сайт услуг',
  never_when: null,
}

describe('direction profile', () => {
  it('FR-ACC-2: a direction without a profile row reads as working with no format and no cases', async () => {
    expect(await getProfile(db, ACC)).toEqual({
      state: 'on',
      version: 0,
      speed: 'normal',
      reply_format: null,
      cases: [],
    })
  })

  it('FR-ACC-2: the profile is created once and never overwritten by a restart', async () => {
    await seedProfile(db, ACC)
    expect(await getProfile(db, ACC)).toMatchObject({ state: 'on', version: 1, reply_format: null })
    await saveProfile(db, ACC, { cases: [aCase] }, 'boris')
    await seedProfile(db, ACC)
    expect((await getProfile(db, ACC)).cases).toHaveLength(1)
  })

  it('FR-ACC-2: only the live account is seeded as on, another account starts as a draft that wins nothing', async () => {
    await seedProfile(db, LIVE_ACCOUNT)
    await seedProfile(db, 'hance-it')
    expect(await getProfile(db, LIVE_ACCOUNT)).toMatchObject({ state: 'on', reply_format: null })
    expect(await getProfile(db, 'hance-it')).toMatchObject({ state: 'draft', reply_format: null })
  })

  it('FR-ACC-2: saving the profile grows its version and journals the change without the texts', async () => {
    await seedProfile(db, ACC)
    const v = await saveProfile(
      db,
      ACC,
      { cases: [aCase], reply_format: DEFAULT_REPLY_FORMAT, speed: 'fast' },
      'boris',
    )
    expect(v).toBe(2)
    expect(await getProfile(db, ACC)).toMatchObject({ version: 2, speed: 'fast' })
    expect(await countEvents(db, 'direction.profile_changed')).toBe(1)
    const [e] = await db.select().from(event).where(eq(event.type, 'direction.profile_changed'))
    expect(e?.payload).toEqual({ version: 2, changed: ['cases', 'reply_format', 'speed'] })
    expect(JSON.stringify(e)).not.toContain('Сайт клиники')
  })

  it('FR-ACC-2: two saves at once give two versions in order', async () => {
    await seedProfile(db, ACC)
    const [a, b] = await Promise.all([
      saveProfile(db, ACC, { speed: 'fast' }, 'boris'),
      saveProfile(db, ACC, { cases: [aCase] }, 'boris'),
    ])
    expect([a, b].sort()).toEqual([2, 3])
    expect(await getProfile(db, ACC)).toMatchObject({ version: 3, speed: 'fast' })
    expect((await getProfile(db, ACC)).cases).toHaveLength(1)
  })

  it('FR-ACC-2: a profile that breaks the contract is refused and nothing is saved', async () => {
    await seedProfile(db, ACC)
    await expect(
      saveProfile(db, ACC, { cases: [{ ...aCase, url: 'http://x.example' }] }, 'boris'),
    ).rejects.toThrow()
    expect((await getProfile(db, ACC)).version).toBe(1)
  })

  it('FR-ACC-2: saving a profile that did not exist yet creates it', async () => {
    expect(await saveProfile(db, ACC, { speed: 'fast' }, 'boris')).toBe(1)
    expect(await getProfile(db, ACC)).toMatchObject({ state: 'on', version: 1, speed: 'fast' })
  })
})
