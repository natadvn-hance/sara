import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  autonomyCounter,
  examRun,
  lesson,
  mindCommit,
  mindGap,
  mindProposal,
  persona,
  trainingItem,
  trainingSession,
} from '../../src/db/schema'
import { dbErrorMessage, openTestDb, resetDb } from '../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const newLesson = (sourceRef: string) => ({
  id: newEventId(),
  source: 'edit',
  sourceRef,
  kind: 'voice',
})

describe('M5 tables', () => {
  it('FR-TRAIN-6: a lesson from the same source is stored once', async () => {
    await db.insert(lesson).values(newLesson('turn-1'))
    const again = await db
      .insert(lesson)
      .values(newLesson('turn-1'))
      .onConflictDoNothing()
      .returning({ id: lesson.id })
    expect(again).toHaveLength(0)
  })

  it('FR-TRAIN-6: lessons get growing serial numbers, even in one transaction', async () => {
    const ns = await db.transaction(async (tx) => {
      const out: number[] = []
      for (const ref of ['a', 'b', 'c']) {
        const [r] = await tx.insert(lesson).values(newLesson(ref)).returning({ n: lesson.n })
        out.push(r?.n ?? 0)
      }
      return out
    })
    expect(ns[0]).toBeGreaterThan(0)
    expect(ns).toEqual([ns[0], (ns[0] ?? 0) + 1, (ns[0] ?? 0) + 2])
    const [row] = await db.select().from(lesson).where(eq(lesson.sourceRef, 'a'))
    expect(row).toMatchObject({
      state: 'new',
      inPlace: false,
      sim: false,
      attempts: 0,
      insight: '',
    })
  })

  it('FR-TRAIN-2: a persona without sources is refused by the database', async () => {
    const p = {
      id: 'p-coffee',
      archetype: 'Владелец кофейни',
      niche: 'общепит',
      task: 'реклама',
      mood: 'hurry',
      order: { title: 'SMM', text: '', budget_text: null },
      difficulty: 2,
      sourceRefs: [],
    }
    expect(await dbErrorMessage(db.insert(persona).values(p))).toMatch(/persona_sources/)
    await db.insert(persona).values({ ...p, sourceRefs: ['chat:1', 'chat:2'] })
  })

  it('FR-MIND-3: old proposals, gaps and exam runs read with the new columns at their defaults', async () => {
    await db.insert(mindProposal).values({
      id: newEventId(),
      path: 'mind/proposals/shared/speech/examples/e-h-1.md',
      content: '---\nid: e-h-1\n---',
      kind: 'example',
      source: 'history:hance-marketing:1',
    })
    const [p] = await db.select().from(mindProposal)
    expect(p).toMatchObject({ action: 'create', lessonId: null, change: null, commitId: null })
    await db.insert(mindGap).values({ id: newEventId(), turnId: 'conv-turn:1', text: 'цена' })
    const [g] = await db.select().from(mindGap)
    expect(g?.lessonId).toBeNull()
    await db
      .insert(examRun)
      .values({ id: newEventId(), mindVersion: 'empty', rolesVersion: {}, scenarioSet: 'x' })
    const [r] = await db.select().from(examRun)
    expect(r).toMatchObject({ kind: 'deploy', trigger: null })
  })

  it('FR-MIND-3: a mind commit, a training with its items and an autonomy counter are stored', async () => {
    await db.insert(mindCommit).values({ id: newEventId(), sha: 'abc123', kind: 'accept' })
    const sessionId = newEventId()
    await db.insert(trainingSession).values({ id: sessionId, mode: 'client' })
    await db.insert(trainingItem).values({ id: newEventId(), sessionId, mode: 'client' })
    await db.insert(trainingItem).values({ id: newEventId(), mode: 'guess', chatId: '95147898' })
    const items = await db.select().from(trainingItem)
    expect(items.map((i) => i.state)).toEqual(['prepared', 'prepared'])
    await db.insert(autonomyCounter).values({ topic: 'timeline', scope: 'shared' })
    expect(
      await dbErrorMessage(
        db.insert(autonomyCounter).values({ topic: 'timeline', scope: 'shared' }),
      ),
    ).toMatch(/duplicate|unique/)
  })
})
