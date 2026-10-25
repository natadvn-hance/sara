import { newEventId } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { event, lesson, mindProposal } from '../../../src/db/schema'
import { exampleChange } from '../../../src/school/lessons/records'
import { createLesson, decideLesson } from '../../../src/school/lessons/store'
import type { MindChange, NewLesson } from '../../../src/school/types'
import { openTestDb, resetDb } from '../../helpers/db'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const example = (): MindChange =>
  exampleChange({
    scope: 'shared',
    topic: 'timeline',
    tone: 'hurry',
    stage: 'talking',
    clientText: 'Анна: когда начнёте?',
    borisText: 'Анна, добрый день! Сроки скажу после созвона',
    insight: 'Срок не обещать в переписке',
    source: 'edit:conv-turn:1',
    names: ['Анна'],
  })

const newLesson = (sourceRef: string, changes: MindChange[] = [example()]): NewLesson => ({
  source: 'edit',
  sourceRef,
  scope: 'shared',
  topic: 'timeline',
  tone: 'hurry',
  questionType: null,
  clientText: 'когда начнёте?',
  before: 'Начнём в понедельник',
  after: 'Сроки скажу после созвона',
  insight: 'Срок не обещать в переписке',
  kind: 'procedure',
  state: 'ready',
  inPlace: false,
  sim: false,
  modelCallId: null,
  changes,
})

describe('lessons', () => {
  it('FR-TRAIN-6: a second lesson from the same source is not created', async () => {
    const a = await createLesson(db, newLesson('conv-turn:1'))
    const b = await createLesson(db, newLesson('conv-turn:1'))
    expect(a.created).toBe(true)
    expect(b).toEqual({ id: a.id, n: a.n, created: false })
    expect(await db.select().from(mindProposal)).toHaveLength(1)
  })

  it('FR-TRAIN-6: ten lessons in one millisecond get ten record ids and ten proposal paths', async () => {
    const made = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.transaction((tx) => createLesson(tx, newLesson(`conv-turn:${i}`))),
      ),
    )
    const rows = await db.select().from(mindProposal)
    expect(new Set(made.map((m) => m.n)).size).toBe(10)
    expect(new Set(rows.map((r) => r.recordId)).size).toBe(10)
    expect(new Set(rows.map((r) => r.path)).size).toBe(10)
    const one = rows.find((r) => r.recordId === `e-l-${made[0]?.n}`)
    expect(one?.path).toBe(`mind/proposals/shared/speech/examples/e-l-${made[0]?.n}.md`)
    expect(one).toMatchObject({ kind: 'example', action: 'create', state: 'new' })
  })

  it('FR-TRAIN-7: two drafts of one record get two proposal paths', async () => {
    const update = (sourceRef: string): NewLesson => ({
      ...newLesson(sourceRef, [
        {
          ...example(),
          action: 'update',
          recordId: 's-portrait',
          type: 'speech',
          section: 'Форма',
        },
      ]),
      source: 'teacher',
    })
    const a = await createLesson(db, update('run-1:0'))
    const b = await createLesson(db, update('run-1:1'))
    const paths = (await db.select().from(mindProposal)).map((r) => r.path).sort()
    expect(paths).toEqual([
      `mind/proposals/shared/speech/s-portrait.l${a.n}.md`,
      `mind/proposals/shared/speech/s-portrait.l${b.n}.md`,
    ])
  })

  it('FR-TRAIN-6: a lesson is decided once', async () => {
    const l = await createLesson(db, newLesson('conv-turn:1'))
    expect((await decideLesson(db, l.id, { decision: 'yes' }))?.state).toBe('yes')
    expect(await decideLesson(db, l.id, { decision: 'no' })).toBeNull()
    const [p] = await db.select().from(mindProposal)
    expect(p?.state).toBe('new')
    const types = (await db.select().from(event)).map((e) => e.type)
    expect(types.filter((t) => t === 'lesson.decided')).toHaveLength(1)
  })

  it("FR-MIND-3: «нет» and «не важно» decline the lesson's proposals", async () => {
    const no = await createLesson(db, newLesson('conv-turn:1'))
    const skip = await createLesson(db, newLesson('conv-turn:2'))
    await decideLesson(db, no.id, { decision: 'no', reason: 'не так' })
    await decideLesson(db, skip.id, { decision: 'skip' })
    const rows = await db.select().from(mindProposal)
    expect(rows.map((r) => [r.state, r.rejectReason]).sort()).toEqual([
      ['declined', 'не важно'],
      ['declined', 'не так'],
    ])
    const [l] = await db.select().from(lesson).where(eq(lesson.id, no.id))
    expect(l?.reason).toBe('не так')
  })

  it('FR-MIND-3: a lesson makes proposals, never mind files', async () => {
    const l = await createLesson(db, newLesson('conv-turn:1'))
    const [p] = await db.select().from(mindProposal)
    expect(p?.lessonId).toBe(l.id)
    expect((p?.change as MindChange | undefined)?.recordId).toBe(`e-l-${l.n}`)
    expect(p?.content).toContain('## Борис')
  })

  it('FR-TRAIN-6: a lesson whose proposal cannot be kept leaves nothing behind', async () => {
    await expect(
      createLesson(db, newLesson('conv-turn:1', [example(), example()])),
    ).rejects.toThrow()
    expect(await db.select().from(lesson)).toEqual([])
    expect(await db.select().from(mindProposal)).toEqual([])
  })

  it('NFR-PRIV-2: a name or a phone in the insight never reaches the example', () => {
    const c = exampleChange({
      scope: 'shared',
      topic: 'call',
      tone: 'neutral',
      stage: null,
      clientText: 'Позвоните',
      borisText: 'Созвонимся завтра',
      insight: 'Анна просит звонить на +7 999 123-45-67',
      source: 'edit:conv-turn:2',
      names: ['Анна'],
    })
    expect(JSON.stringify(c)).not.toContain('Анна')
    expect(JSON.stringify(c)).not.toContain('999')
    expect(c.fields.title).toContain('[имя 1]')
  })

  it("NFR-PRIV-2: «Анна, добрый день» in Boris's text becomes the name label in the example", async () => {
    const c = example()
    expect(c.sections['Борис']).toBe('[имя 1], добрый день! Сроки скажу после созвона')
    expect(c.sections['Клиент']).toBe('[имя 1]: когда начнёте?')
    expect(JSON.stringify(c)).not.toContain('Анна')
    expect(newEventId()).toBeTruthy()
  })
})
