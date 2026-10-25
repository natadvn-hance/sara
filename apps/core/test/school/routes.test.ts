import cookie from '@fastify/cookie'
import { newEventId } from '@sara/shared'
import Fastify from 'fastify'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE } from '../../src/auth/session'
import { mindCommit } from '../../src/db/schema'
import { registerSchoolRoutes } from '../../src/school/routes'
import type { MindWriter, RevertResult, SchoolDeps } from '../../src/school/types'
import { openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

async function appWith(revert: (id: string) => Promise<RevertResult>) {
  const app = Fastify()
  await app.register(cookie, { secret: 'test-secret' })
  registerSchoolRoutes(app, { db, writer: { revert } as unknown as MindWriter } as SchoolDeps)
  await app.ready()
  const owner = `${SESSION_COOKIE}=${app.signCookie(`owner:${Date.now()}`)}`
  return { app, owner }
}

describe('the mind commit routes', () => {
  it('FR-MIND-3: the routes are for the owner only', async () => {
    const { app } = await appWith(async () => ({ ok: true, commitId: 'x' }))
    expect((await app.inject({ method: 'GET', url: '/api/mind/commits' })).statusCode).toBe(401)
    const p = await app.inject({ method: 'POST', url: `/api/mind/commits/${newEventId()}/revert` })
    expect(p.statusCode).toBe(401)
  })

  it('FR-MIND-3: the commits are listed newest first and one is reverted by its id', async () => {
    const id = newEventId()
    await db.insert(mindCommit).values({ id, sha: 'a', kind: 'accept', lessonIds: ['l1', 'l2'] })
    const asked: string[] = []
    const { app, owner } = await appWith(async (x) => {
      asked.push(x)
      return { ok: true, commitId: 'r1' }
    })
    const list = await app.inject({
      method: 'GET',
      url: '/api/mind/commits',
      headers: { cookie: owner },
    })
    expect(list.json()).toEqual([
      expect.objectContaining({ id, kind: 'accept', lessons: 2, reverts: null }),
    ])
    const r = await app.inject({
      method: 'POST',
      url: `/api/mind/commits/${id}/revert`,
      headers: { cookie: owner },
    })
    expect(r.json()).toEqual({ ok: true, commitId: 'r1' })
    expect(asked).toEqual([id])
  })

  it('FR-MIND-3: a revert conflict answers 409 with the reason', async () => {
    const { app, owner } = await appWith(async () => ({
      ok: false,
      reason: 'conflict',
      detail: 'эти записи потом меняли ещё 1 раз, сначала откати более поздние',
    }))
    const r = await app.inject({
      method: 'POST',
      url: `/api/mind/commits/${newEventId()}/revert`,
      headers: { cookie: owner },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toContain('потом меняли')
  })

  it('FR-MIND-4: the app decides only interview records, by a real id', async () => {
    const { app, owner } = await appWith(async () => ({ ok: true, commitId: 'x' }))
    const post = (id: string, decision: string) =>
      app.inject({
        method: 'POST',
        url: `/api/interview/lessons/${id}`,
        headers: { cookie: owner },
        payload: { decision },
      })
    expect((await post('not-an-id', 'yes')).statusCode).toBe(404)
    expect((await post(newEventId(), 'yes')).statusCode).toBe(404)
    expect((await post(newEventId(), 'maybe')).statusCode).toBe(400)
  })
})
