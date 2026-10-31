import { MindView, newEventId, SystemView } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mindProposal } from '../../src/db/schema'
import { decideProposal, MIND_TEXTS } from '../../src/pult/mindDecide'
import type { MindWriter } from '../../src/school/types'
import { buildTestApp, type TestApp } from '../helpers/app'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'

const { db, close } = openTestDb()
afterAll(close)

const A = newEventId()
const B = newEventId()
let t: TestApp

beforeEach(async () => {
  await resetDb(db)
  t = await buildTestApp(db)
  await t.app.inject({
    method: 'POST',
    url: '/api/setup/password',
    payload: { password: 'длинныйпароль1' },
  })
  await db.insert(mindProposal).values([
    {
      id: A,
      path: 'mind/proposals/a.md',
      content: '---\ntype: knowledge\n---\nЦену называем вилкой',
      kind: 'knowledge',
      source: 'turn',
    },
    {
      id: B,
      path: 'mind/proposals/b.md',
      content: '---\ntype: example\n---\nОбразец',
      kind: 'example',
      source: 'turn',
    },
  ])
})
afterEach(() => t.close())

const post = async (url: string, payload: object = {}) => {
  const r = await t.app.inject({ method: 'POST', url, payload, headers: { cookie: t.cookie() } })
  return { status: r.statusCode, body: r.json() as { message?: string; error?: string } }
}
const stateOf = async (id: string) =>
  (await db.select().from(mindProposal).where(eq(mindProposal.id, id)))[0]

describe('«Разум»: Boris’s «да» and «нет» to a proposal (FR-MIND-3)', () => {
  it('FR-MIND-3: without the writer «да» is accepted and waits for its writing; «нет» keeps the reason; nothing twice', async () => {
    expect((await post(`/api/mind/proposals/${A}/decide`, { decision: 'yes' })).body).toEqual({
      message: MIND_TEXTS.waiting,
    })
    expect((await stateOf(A))?.state).toBe('accepted')
    expect(
      (await post(`/api/mind/proposals/${B}/decide`, { decision: 'no', reason: 'устарело' })).body,
    ).toEqual({
      message: MIND_TEXTS.rejected,
    })
    expect(await stateOf(B)).toMatchObject({ state: 'rejected', rejectReason: 'устарело' })
    expect((await post(`/api/mind/proposals/${A}/decide`, { decision: 'no' })).status).toBe(409)
    expect((await post(`/api/mind/proposals/${A}/decide`, { decision: 'maybe' })).status).toBe(400)
    expect(await countEvents(db, 'mind.decided')).toBe(2)
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/mind',
      headers: { cookie: t.cookie() },
    })
    expect(
      MindView.parse(r.json())
        .proposals.map((p) => p.state)
        .sort(),
    ).toEqual(['accepted', 'rejected'])
  })

  it('FR-MIND-3: with the writer «да» goes through it, and only what it wrote is «записано»', async () => {
    const asked: string[][] = []
    const writer = (ok: boolean): MindWriter => ({
      apply: async (ids) => {
        asked.push(ids)
        return ok
          ? {
              ok: true,
              commitId: newEventId(),
              sha: 'abc',
              mindVersion: 'abc',
              written: ids,
              refused: [],
            }
          : { ok: false, reason: 'no_git', detail: 'not built', refused: [] }
      },
      revert: async () => ({ ok: false, reason: 'no_git', detail: '' }),
      sync: async () => ({ pushed: false, pulled: 0, error: null }),
    })
    expect(await decideProposal({ db, writer: writer(true) }, A, 'yes', null)).toEqual({
      ok: true,
      message: MIND_TEXTS.written,
    })
    expect((await stateOf(A))?.state).toBe('written')
    expect(await decideProposal({ db, writer: writer(false) }, B, 'yes', null)).toEqual({
      ok: true,
      message: MIND_TEXTS.waiting,
    })
    expect((await stateOf(B))?.state).toBe('accepted')
    expect(asked).toEqual([[A], [B]])
  })
})

describe('«Состояние»', () => {
  it('FR-OPS-4: the version Sara runs and when the core started (the last deploy or restart)', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/system',
      headers: { cookie: t.cookie() },
    })
    const v = SystemView.parse(r.json())
    expect(v.deploy?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(Date.parse(v.deploy?.startedAt ?? '')).toBeLessThanOrEqual(Date.now())
  })
})
