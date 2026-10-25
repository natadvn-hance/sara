import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { makeInsight } from '../../../src/school/lessons/maker'
import { openTestDb, resetDb } from '../../helpers/db'
import { fakeGateway } from '../../helpers/gateway'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const answer = {
  worth: true,
  insight: 'Срок не обещать в переписке',
  kind: 'procedure',
  topic: 'timeline',
  tone: 'hurry',
  fact: null,
}

const edit = {
  mode: 'edit' as const,
  clientText: 'Анна: когда начнёте? Мой телефон +7 999 123-45-67',
  before: 'Начнём в понедельник',
  after: 'Анна, сроки скажу после созвона',
  question: null,
  why: 'клиент торопит',
  names: ['Анна'],
  priority: 'P3' as const,
}

describe('the lesson maker', () => {
  it('FR-TRAIN-6: an edit becomes one insight from one haiku call', async () => {
    const f = await fakeGateway(db, { 'lesson-maker': answer })
    expect(await makeInsight(f.gateway, edit)).toEqual(answer)
    const calls = await f.calls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: 'lesson-maker', model: 'haiku' })
  })

  it('FR-MIND-4: an interview answer goes to sonnet', async () => {
    const f = await fakeGateway(db, {
      'lesson-maker': {
        ...answer,
        kind: 'fact',
        fact: { title: 'Цена', fact: 'от 80 000', when: '', not_say: '' },
      },
    })
    const r = await makeInsight(f.gateway, {
      ...edit,
      mode: 'interview',
      question: 'Сколько стоит сайт?',
      after: 'от 80 000',
    })
    expect(r?.fact?.title).toBe('Цена')
    expect((await f.calls())[0]?.model).toBe('sonnet')
  })

  it('FR-TRAIN-6: a model failure gives null, not an exception', async () => {
    const f = await fakeGateway(db, { 'lesson-maker': { worth: 'нет' } })
    expect(await makeInsight(f.gateway, edit)).toBeNull()
  })

  it("NFR-PRIV-2: the client's name never reaches the lesson maker", async () => {
    const f = await fakeGateway(db, { 'lesson-maker': answer })
    await makeInsight(f.gateway, edit)
    const stdin = (await f.calls())[0]?.stdin ?? ''
    expect(stdin).toContain('Текст Бориса')
    expect(stdin).not.toContain('Анна')
    expect(stdin).not.toContain('999 123')
  })
})
