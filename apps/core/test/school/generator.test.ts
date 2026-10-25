import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MindHit, MindSearch } from '../../src/conversation/types'
import { mindGap, persona, simDialog } from '../../src/db/schema'
import { generateDialogs, generatorJob } from '../../src/school/generator'
import { setSetting } from '../../src/settings/store'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'

const { db, close } = openTestDb()
afterAll(close)
beforeEach(async () => {
  await resetDb(db)
  await setSetting(db, 'school.on', true, 'boris')
})

const NOW = new Date('2026-10-26T03:00:00+03:00')
const SPECIALIST = 'Здравствуйте, сайт стоит от 80 000, сделаем за месяц'

async function personas(n: number) {
  for (let i = 1; i <= n; i++)
    await db.insert(persona).values({
      id: `p-test-${i}`,
      archetype: 'Владелец кафе',
      niche: 'Общепит',
      task: 'Сайт с меню',
      mood: 'doubt',
      order: { title: 'Сайт', text: 'Сайт с меню', budget_text: null },
      difficulty: 2,
      sourceRefs: ['chat-1', 'chat-2'],
    })
}

const dialog = (personaId: string) => ({
  persona_id: personaId,
  messages: [
    { side: 'client', text: 'Сколько стоит сайт?', topic: 'price' },
    { side: 'specialist', text: SPECIALIST },
    { side: 'client', text: 'А вы работаете по договору с ИП?', topic: 'contract' },
    { side: 'specialist', text: 'Да, конечно' },
  ],
})
const five = { dialogs: [1, 2, 3, 4, 5].map((i) => dialog(`p-test-${i}`)) }

/** A mind that knows the price and nothing else. */
const mind = (rank = 0.5): MindSearch => ({
  version: async () => 'v',
  search: async (q) =>
    /стоит/i.test(q.text)
      ? [
          {
            id: 'k-price',
            type: 'knowledge',
            scope: 'shared',
            title: 'Цена',
            body: 'от 80 000',
            topic: 'price',
            tones: [],
            stages: [],
            exampleClient: null,
            exampleBoris: null,
            rank,
          } satisfies MindHit,
        ]
      : [],
  byIds: async () => [],
  byStage: async () => null,
  bannedPhrases: async () => [],
})

describe('the dialog generator', () => {
  it('FR-TRAIN-9: 50 dialogs come from 10 calls', async () => {
    await personas(7)
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    expect(await generateDialogs({ db, gateway: gw.gateway, mind: mind() }, NOW)).toBe('done')
    const calls = await gw.calls()
    expect(calls).toHaveLength(10)
    expect(calls.every((c) => c.role === 'dialog-generator')).toBe(true)
    expect(calls[0]?.stdin).toContain('p-test-1')
    expect(calls[1]?.stdin).toContain('p-test-6')
    expect(await db.select().from(simDialog)).toHaveLength(50)
    expect(await generatorJob.estimate({ db } as never, NOW)).toBe(40)
    expect(generatorJob).toMatchObject({ name: 'generator', models: ['sonnet'] })
  })

  it('FR-TRAIN-9: the specialist side of a generated dialog is never stored', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs({ db, gateway: gw.gateway, mind: mind() }, NOW)
    const dialogs = await db.select().from(simDialog)
    expect(dialogs[0]?.clientMessages).toEqual([
      { text: 'Сколько стоит сайт?', topic: 'price' },
      { text: 'А вы работаете по договору с ИП?', topic: 'contract' },
    ])
    const stored = JSON.stringify([dialogs, await db.select().from(mindGap)])
    expect(stored).not.toContain('80 000')
    expect(stored).not.toContain('Да, конечно')
  })

  it('FR-TRAIN-9: a client question with no matching record becomes a gap with its topic', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs({ db, gateway: gw.gateway, mind: mind() }, NOW)
    const gaps = await db.select().from(mindGap)
    expect(gaps).toHaveLength(5)
    expect(gaps.every((g) => g.topic === 'contract' && /^sim:[0-9a-f-]+:1$/.test(g.turnId))).toBe(
      true,
    )
    expect(gaps[0]?.text).toBe('А вы работаете по договору с ИП?')
    const [d] = await db.select().from(simDialog)
    expect(d?.gaps).toEqual([1])
  })

  it('FR-TRAIN-9: a record of the topic with a low rank does not close the gap', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs({ db, gateway: gw.gateway, mind: mind(0.001) }, NOW)
    expect(await db.select().from(mindGap)).toHaveLength(10)
  })

  it('FR-TRAIN-9: no personas, no calls; dialogs older than 30 days are removed', async () => {
    await db.insert(simDialog).values({
      id: newEventId(),
      clientMessages: [],
      createdAt: new Date(NOW.getTime() - 31 * 86_400_000).toISOString(),
    })
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    expect(await generateDialogs({ db, gateway: gw.gateway, mind: mind() }, NOW)).toBe('nothing')
    expect(await gw.calls()).toHaveLength(0)
    expect(await db.select().from(simDialog)).toEqual([])
  })

  it('FR-TRAIN-9: a generated dialog never reaches the exam or the golden set builders', async () => {
    const root = resolve(import.meta.dirname, '../../src')
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.ts')) files.push(full)
      }
    }
    await walk(join(root, 'exam'))
    await walk(join(root, 'school/exams'))
    for (const f of files) {
      const text = await readFile(f, 'utf8')
      expect(text, f).not.toMatch(/simDialog|sim_dialog|\/generator'/)
    }
  })
})
