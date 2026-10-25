import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MindHit, MindSearch } from '../../src/conversation/types'
import { mindGap, persona, simDialog } from '../../src/db/schema'
import { cleanSim, generateDialogs, generatorJob } from '../../src/school/generator'
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
const DAY = 86_400_000
const SPECIALIST = 'Здравствуйте, сайт стоит от 80 000, сделаем за месяц'

async function personas(n: number) {
  for (let i = 1; i <= n; i++)
    await db.insert(persona).values({
      id: `p-test-${String(i).padStart(2, '0')}`,
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
const five = { dialogs: [1, 2, 3, 4, 5].map((i) => dialog(`p-test-0${i}`)) }

const hit = (topic: MindHit['topic'], rank = 0.5): MindHit => ({
  id: 'k-x',
  type: 'knowledge',
  scope: 'shared',
  title: 'запись',
  body: 'текст',
  topic,
  tones: [],
  stages: [],
  exampleClient: null,
  exampleBoris: null,
  rank,
})

/** A mind that answers with `hits(text, scope)`; `empty` is a mind with no records at all. */
const mind = (
  hits: (text: string, scope: string) => MindHit[] = (t) =>
    /стоит/i.test(t) ? [hit('price')] : [],
  o: { empty?: boolean } = {},
): MindSearch => ({
  version: async () => (o.empty ? 'empty' : 'v1'),
  search: async (q) => hits(q.text, q.scope),
  byIds: async () => [],
  byStage: async () => null,
  bannedPhrases: async () => [],
})

const deps = (
  gateway: Parameters<typeof generateDialogs>[0]['gateway'],
  m = mind(),
  accountIds: string[] = [],
) => ({
  db,
  gateway,
  mind: m,
  accountIds,
})

describe('the dialog generator', () => {
  it('FR-TRAIN-9: 50 dialogs come from 10 calls', async () => {
    await personas(25)
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    expect(await generateDialogs(deps(gw.gateway), NOW)).toBe('done')
    const calls = await gw.calls()
    expect(calls).toHaveLength(10)
    expect(calls.every((c) => c.role === 'dialog-generator')).toBe(true)
    expect(await db.select().from(simDialog)).toHaveLength(50)
    expect(await generatorJob.estimate({ db } as never, NOW)).toBe(40)
    expect(generatorJob).toMatchObject({ name: 'generator', models: ['sonnet'] })
  })

  it('FR-TRAIN-9: with two personas the night makes one call, and the rotation moves on each night', async () => {
    await personas(7)
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs(deps(gw.gateway), NOW)
    await generateDialogs(deps(gw.gateway), new Date(NOW.getTime() + DAY))
    const nights = (await gw.calls()).map((c) => c.stdin)
    // Seven personas, two dialogs each: three calls a night; the second night starts elsewhere.
    expect(nights).toHaveLength(6)
    expect(nights[3]).not.toBe(nights[0])
    await resetDb(db)
    await personas(2)
    const few = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs(deps(few.gateway), NOW)
    expect(await few.calls()).toHaveLength(1)
  })

  it('FR-TRAIN-9: the specialist side of a generated dialog is never stored', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    await generateDialogs(deps(gw.gateway), NOW)
    const dialogs = await db.select().from(simDialog)
    expect(dialogs[0]?.clientMessages).toEqual([
      { text: 'Сколько стоит сайт?', topic: 'price' },
      { text: 'А вы работаете по договору с ИП?', topic: 'contract' },
    ])
    const stored = JSON.stringify([dialogs, await db.select().from(mindGap)])
    expect(stored).not.toContain('80 000')
    expect(stored).not.toContain('Да, конечно')
  })

  it('FR-TRAIN-9: a client question with no record of its topic becomes one gap with its topic', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    // A price record answers every query: the contract question still has no record of its own topic.
    await generateDialogs(
      deps(
        gw.gateway,
        mind(() => [hit('price')]),
      ),
      NOW,
    )
    const gaps = await db.select().from(mindGap)
    // Five dialogs ask the same contract question: one gap, not five.
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ topic: 'contract', text: 'А вы работаете по договору с ИП?' })
    expect(gaps[0]?.turnId).toMatch(/^sim:[0-9a-f-]+:1$/)
  })

  it('FR-TRAIN-9: only the first three hits count, and a low rank does not close a gap', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const fourth = mind(() => [
      hit('other'),
      hit('other'),
      hit('other'),
      hit('price'),
      hit('contract'),
    ])
    await generateDialogs(
      deps((await fakeGateway(db, { 'dialog-generator': five })).gateway, fourth),
      NOW,
    )
    expect(await db.select().from(mindGap)).toHaveLength(2)
    await resetDb(db)
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const low = mind(() => [hit('price', 0.001), hit('contract', 0.001)])
    await generateDialogs(
      deps((await fakeGateway(db, { 'dialog-generator': five })).gateway, low),
      NOW,
    )
    expect(await db.select().from(mindGap)).toHaveLength(2)
  })

  it("FR-TRAIN-9: a record in a direction's mind closes the gap", async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    const byScope = mind((_t, scope) => (scope === 'hance' ? [hit('price'), hit('contract')] : []))
    await generateDialogs(deps(gw.gateway, byScope, ['hance']), NOW)
    expect(await db.select().from(mindGap)).toEqual([])
  })

  it('FR-TRAIN-9: an empty mind gives no gaps, and a night gives at most 30', async () => {
    await personas(5)
    await setSetting(db, 'school.generator_dialogs', 5, 'boris')
    const many = {
      dialogs: [1, 2, 3, 4, 5].map((d) => ({
        persona_id: `p-test-0${d}`,
        messages: Array.from({ length: 16 }, (_, i) =>
          i % 2 === 0
            ? { side: 'client', text: `Вопрос ${d}-${i} про договор`, topic: 'contract' }
            : { side: 'specialist', text: 'Ответ' },
        ),
      })),
    }
    const gw = await fakeGateway(db, { 'dialog-generator': many })
    await generateDialogs(
      deps(
        gw.gateway,
        mind(() => [], { empty: true }),
      ),
      NOW,
    )
    expect(await db.select().from(simDialog)).toHaveLength(5)
    expect(await db.select().from(mindGap)).toEqual([])
    await generateDialogs(
      deps(
        gw.gateway,
        mind(() => []),
      ),
      NOW,
    )
    expect(await db.select().from(mindGap)).toHaveLength(30)
  })

  it('FR-TRAIN-9: the limit ends the night at once, and two failed calls in a row end it too', async () => {
    await personas(25)
    const broken = await fakeGateway(db, { 'dialog-generator': { dialogs: 'нет' } })
    expect(await generateDialogs(deps(broken.gateway), NOW)).toBe('nothing')
    // Ten calls planned; the gateway may try a bad answer once more, but the night stops after two failures.
    expect((await broken.calls()).length).toBeLessThanOrEqual(4)
    const limited = await fakeGateway(
      db,
      { 'dialog-generator': five },
      { FAKE_CLAUDE_MODE: 'limit' },
    )
    expect(await generateDialogs(deps(limited.gateway), NOW)).toBe('nothing')
    expect(await limited.calls()).toHaveLength(1)
  })

  it('FR-TRAIN-9: no personas, no calls', async () => {
    const gw = await fakeGateway(db, { 'dialog-generator': five })
    expect(await generateDialogs(deps(gw.gateway), NOW)).toBe('nothing')
    expect(await gw.calls()).toHaveLength(0)
  })

  it('FR-TRAIN-9: lines and unasked gaps older than 30 days go, younger ones and asked gaps stay', async () => {
    const old = new Date(NOW.getTime() - 31 * DAY).toISOString()
    const young = new Date(NOW.getTime() - 10 * DAY).toISOString()
    await db.insert(simDialog).values([
      { id: newEventId(), clientMessages: [], createdAt: old },
      { id: newEventId(), clientMessages: [], createdAt: young },
    ])
    await db.insert(mindGap).values([
      { id: newEventId(), turnId: 'sim:a:0', text: 'старый', createdAt: old },
      {
        id: newEventId(),
        turnId: 'sim:b:0',
        text: 'спрошенный',
        createdAt: old,
        questionId: newEventId(),
      },
      { id: newEventId(), turnId: 'sim:c:0', text: 'новый', createdAt: young },
      { id: newEventId(), turnId: 'conv-turn:1', text: 'из работы', createdAt: old },
    ])
    await cleanSim(db, NOW)
    expect(await db.select().from(simDialog)).toHaveLength(1)
    expect((await db.select().from(mindGap)).map((g) => g.text).sort()).toEqual([
      'из работы',
      'новый',
      'спрошенный',
    ])
  })

  it('FR-TRAIN-9: no code but the generator reads the generated dialogs', async () => {
    const root = resolve(import.meta.dirname, '../../src')
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.ts')) files.push(full)
      }
    }
    await walk(root)
    expect(files.length).toBeGreaterThan(50)
    const readers: string[] = []
    for (const f of files)
      if (/simDialog|sim_dialog/.test(await readFile(f, 'utf8'))) readers.push(relative(root, f))
    // The exam and golden set builders (apps/core/src/exam, school/exams) must never be among them.
    expect(readers.sort()).toEqual(['db/schema.ts', 'school/generator.ts'])
  })
})
