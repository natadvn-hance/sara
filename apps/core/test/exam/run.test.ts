import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { count, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  chatMessage,
  conversation,
  convTurn,
  event,
  examResult,
  examRun,
  modelCall,
  outbox,
  setting,
  settingHistory,
} from '../../src/db/schema'
import { examVerdict, runExam } from '../../src/exam/run'
import { loadScenarios } from '../../src/exam/scenarios'
import { loadRole } from '../../src/gateway/roles'
import { fakeMind, interlocutorAnswer } from '../helpers/conversation'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'

const ROOT = resolve(import.meta.dirname, '../../../..')
const HANDMADE = join(ROOT, 'tests/exam/scenarios')
const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

const CLEAN = { unsupported: [], contradicts_boris: null, robotic: [], promises: [], case: [] }
/** x-t-01: a price question, which is a call for Boris. */
const CALL_BORIS = interlocutorAnswer({
  move: 'call_boris',
  topic: 'price',
  text: null,
  fact_ids: [],
})
/** x-t-04: «спасибо, жду», nothing to answer. */
const NONE = interlocutorAnswer({
  move: 'none',
  topic: 'smalltalk',
  text: null,
  fact_ids: [],
})
/** x-t-03: how we start, a reply on the process with one fact of the mind. */
const REPLY = interlocutorAnswer({ topic: 'process' })

const TWO = ['x-t-01-price-first', 'x-t-04-thanks-wait']

/** The ids of the failures a stored result keeps. */
const checkIds = (row: { checks: unknown } | undefined) =>
  ((row?.checks ?? []) as { id: string }[]).map((c) => c.id)

async function exam(
  byRole: Record<string, unknown>,
  o: {
    only?: string[]
    judge?: boolean
    judgeCounts?: boolean
    dirs?: string[]
    mind?: ReturnType<typeof fakeMind>
  },
) {
  const fake = await fakeGateway(db, byRole)
  const summary = await runExam(
    { db, gateway: fake.gateway, mind: o.mind ?? fakeMind(), rolesDir: fake.rolesDir },
    {
      dirs: o.dirs ?? [HANDMADE],
      only: o.only,
      judge: o.judge ?? false,
      judgeCounts: o.judgeCounts,
    },
  )
  return { summary, fake }
}

describe('runExam', { timeout: 30_000 }, () => {
  it('FR-TRAIN-8: a run of two handmade scenarios with the fake CLI', async () => {
    const { summary, fake } = await exam(
      { interlocutor: { $sequence: [CALL_BORIS, NONE] } },
      { only: TWO },
    )
    expect(summary).toMatchObject({ score: 1, s1: 0, s2: 0, s3: 0, passed: true, scenarios: 2 })
    expect(summary.comparedTo).toBeNull()
    expect(summary.results.map((r) => [r.id, r.grade.score, r.move])).toEqual([
      ['x-t-01-price-first', 1, 'call_boris'],
      ['x-t-04-thanks-wait', 1, 'none'],
    ])

    const [run] = await db.select().from(examRun)
    expect(run?.id).toBe(summary.runId)
    expect(run).toMatchObject({ score: 1, s1: 0, s2: 0, s3: 0, passed: true, comparedTo: null })
    expect(run?.finishedAt).not.toBeNull()
    const rows = await db.select().from(examResult).orderBy(examResult.scenarioId)
    expect(rows.map((r) => [r.scenarioId, r.move, r.score, r.severity])).toEqual([
      ['x-t-01-price-first', 'call_boris', 1, null],
      ['x-t-04-thanks-wait', 'none', 1, null],
    ])
    // Two answers of the Interlocutor, no Checker (no text), no judge.
    expect((await fake.calls()).map((c) => c.role)).toEqual(['interlocutor', 'interlocutor'])
    // The journal knows the run finished, with numbers only.
    const [done] = await db.select().from(event).where(eq(event.type, 'exam.finished'))
    expect(done?.entityId).toBe(summary.runId)
    expect(done?.payload).toEqual({ score: 1, s1: 0, s2: 0, s3: 0, passed: true, scenarios: 2 })
  })

  it('FR-TRAIN-8: the exam sends nothing, queues nothing and changes no setting', async () => {
    await exam({ interlocutor: { $sequence: [CALL_BORIS, NONE] } }, { only: TWO })
    await exam({ interlocutor: REPLY, checker: CLEAN }, { only: ['x-t-03-how-start'] })
    for (const table of [outbox, chatMessage, conversation, convTurn, setting, settingHistory]) {
      const [n] = await db.select({ n: count() }).from(table)
      expect(n?.n, 'a table the exam must not touch has rows').toBe(0)
    }
  })

  it('FR-TRAIN-8: a fact outside the mind fails the scenario as S1', async () => {
    const { summary } = await exam(
      {
        interlocutor: { ...REPLY, fact_ids: ['k-invented'] },
        checker: CLEAN,
      },
      { only: ['x-t-03-how-start'] },
    )
    expect(summary.s1).toBe(1)
    expect(summary.score).toBe(0)
    expect(summary.passed).toBe(false)
    const [row] = await db.select().from(examResult)
    expect(row?.severity).toBe('S1')
    expect(row?.score).toBe(0)
    expect(checkIds(row)).toContain('facts.unknown')
  })

  it('FR-TRAIN-8: a number the mind does not hold fails the scenario as S1', async () => {
    const { summary } = await exam(
      {
        interlocutor: { ...REPLY, text: 'Начинаем с созвона на 30 минут. Это займёт 50 000 дней.' },
        checker: CLEAN,
      },
      { only: ['x-t-03-how-start'] },
    )
    expect(summary.s1).toBe(1)
    const [row] = await db.select().from(examResult)
    expect(checkIds(row)).toContain('facts.numbers')
  })

  it('FR-TRAIN-8: a reply that meets the scenario scores 1, with the text stored', async () => {
    const { summary, fake } = await exam(
      { interlocutor: REPLY, checker: CLEAN },
      { only: ['x-t-03-how-start'] },
    )
    expect(summary).toMatchObject({ score: 1, passed: true })
    const [row] = await db.select().from(examResult)
    expect(row).toMatchObject({ move: 'reply', text: REPLY.text, severity: null, checks: [] })
    expect((await fake.calls()).map((c) => c.role)).toEqual(['interlocutor', 'checker'])
  })

  it('FR-TRAIN-8: a worse run than the last one does not pass', async () => {
    const first = await exam({ interlocutor: { $sequence: [CALL_BORIS, NONE] } }, { only: TWO })
    expect(first.summary).toMatchObject({ score: 1, passed: true })
    // The second scenario now calls Boris where nothing was needed: the wrong move, S2.
    const second = await exam(
      { interlocutor: { $sequence: [CALL_BORIS, CALL_BORIS] } },
      { only: TWO },
    )
    expect(second.summary.score).toBe(0.75)
    expect(second.summary.s1).toBe(0)
    expect(second.summary.s2).toBe(1)
    expect(second.summary.passed).toBe(false)
    expect(second.summary.comparedTo).toBe(first.summary.runId)
    expect(second.summary.previousScore).toBe(1)
    // The failed run is no baseline: the same bad run again still fails against the run that passed.
    const third = await exam(
      { interlocutor: { $sequence: [CALL_BORIS, CALL_BORIS] } },
      { only: TWO },
    )
    expect(third.summary).toMatchObject({ score: 0.75, passed: false })
    expect(third.summary.comparedTo).toBe(first.summary.runId)
    expect(third.summary.previousScore).toBe(1)
    // A run as good as the one that passed passes, and is compared with it, not with the failed ones.
    const fourth = await exam({ interlocutor: { $sequence: [CALL_BORIS, NONE] } }, { only: TWO })
    expect(fourth.summary).toMatchObject({ score: 1, passed: true })
    expect(fourth.summary.comparedTo).toBe(first.summary.runId)
    const stored = await db.select().from(examRun).where(eq(examRun.id, second.summary.runId))
    expect(stored[0]).toMatchObject({ passed: false, comparedTo: first.summary.runId, s2: 1 })
  })

  it('FR-TRAIN-8: a run is compared only with a run of the same set', async () => {
    const one = await exam({ interlocutor: CALL_BORIS }, { only: ['x-t-01-price-first'] })
    // Another set of scenarios: nothing to compare with, even though the score is lower.
    const other = await exam(
      { interlocutor: NONE },
      { only: ['x-t-04-thanks-wait', 'x-t-01-price-first'] },
    )
    expect(other.summary.comparedTo).toBeNull()
    expect(other.summary.passed).toBe(true)
    const runs = await db.select().from(examRun)
    expect(new Set(runs.map((r) => r.scenarioSet)).size).toBe(2)
    expect(one.summary.runId).not.toBe(other.summary.runId)
  })

  it('FR-TRAIN-8: the set hash of a whole run is the hash of the set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exam-run-'))
    const file = await readFile(join(HANDMADE, 'x-t-01-price-first.json'), 'utf8')
    await writeFile(join(dir, 'x-t-01-price-first.json'), file)
    const loaded = await loadScenarios([dir])
    await exam({ interlocutor: CALL_BORIS }, { dirs: [dir] })
    const [run] = await db.select().from(examRun)
    expect(run?.scenarioSet).toBe(loaded.setHash)
  })

  it('FR-TRAIN-8: the run stores the mind version and role versions', async () => {
    const { fake } = await exam({ interlocutor: CALL_BORIS }, { only: ['x-t-01-price-first'] })
    const [run] = await db.select().from(examRun)
    expect(run?.mindVersion).toBe('mind-v1')
    const versions: Record<string, number> = {}
    for (const role of ['interlocutor', 'checker', 'examiner'] as const)
      versions[role] = (await loadRole(fake.rolesDir, role)).meta.version
    expect(run?.rolesVersion).toEqual(versions)
    expect(Object.values(versions).every((v) => v >= 1)).toBe(true)
  })

  it('FR-TRAIN-8: the exam calls the model in the background, after the live work', async () => {
    await exam({ interlocutor: REPLY, checker: CLEAN }, { only: ['x-t-03-how-start'] })
    const calls = await db.select().from(modelCall)
    expect(calls.map((c) => c.role).sort()).toEqual(['checker', 'interlocutor'])
    expect(calls.every((c) => c.priority === 'P3')).toBe(true)
  })

  it('FR-TRAIN-8: the judge marks are stored and do not count until the judge is trusted', async () => {
    const judge = { tone: 1, voice: 1, procedure_ok: false, notes: 'шаблонно' }
    const { summary, fake } = await exam(
      { interlocutor: CALL_BORIS, examiner: judge },
      { only: ['x-t-01-price-first'], judge: true },
    )
    expect(summary).toMatchObject({ score: 1, passed: true })
    const [row] = await db.select().from(examResult)
    expect(row?.judge).toMatchObject({ ...judge, counted: false })
    expect(summary.results[0]?.grade.advisory.map((a) => a.id)).toEqual([
      'judge.procedure',
      'judge.tone',
      'judge.voice',
    ])
    // The judge reads the scenario by its headings, the client's words as data, and never the client's name.
    const call = (await fake.calls()).find((c) => c.role === 'examiner')
    expect(call).toBeTruthy()
    for (const h of ['## Сценарий', '## Ответ Сары', '## Ответ Бориса', '## Рубрика'])
      expect(call?.stdin).toContain(h)
    expect(call?.stdin).toContain('<<< данные клиента')
    expect(call?.stdin).toContain('Сколько это будет стоить?')
    expect(call?.stdin).not.toContain('Анна')
  })

  it('FR-TRAIN-8: the marks of a trusted judge count, and its runs are a set of their own', async () => {
    const judge = { tone: 1, voice: 1, procedure_ok: false, notes: 'шаблонно' }
    const only = ['x-t-01-price-first']
    await exam({ interlocutor: CALL_BORIS, examiner: judge }, { only, judge: true })
    const counted = await exam(
      { interlocutor: CALL_BORIS, examiner: judge },
      { only, judge: true, judgeCounts: true },
    )
    expect(counted.summary.score).toBe(0)
    expect(counted.summary.s2).toBe(2)
    expect(counted.summary.s3).toBe(1)
    // A judge that counts is another set: its score is not the score of the runs before.
    expect(counted.summary.comparedTo).toBeNull()
    const [row] = await db
      .select()
      .from(examResult)
      .where(eq(examResult.runId, counted.summary.runId))
    expect(row?.judge).toMatchObject({ tone: 1, counted: true })
  })

  it('FR-TRAIN-8: a judge that fails does not hold a run whose judge does not count', async () => {
    const { summary } = await exam(
      { interlocutor: CALL_BORIS, examiner: { tone: 9 } },
      { only: ['x-t-01-price-first'], judge: true },
    )
    expect(summary).toMatchObject({ score: 1, passed: true, unanswered: 0 })
    const [row] = await db.select().from(examResult)
    expect(row?.judge).toMatchObject({ failed: 'bad_output' })
  })

  it('FR-TRAIN-8: a judge that counts and fails leaves the scenario unanswered, so the run does not pass', async () => {
    const { summary } = await exam(
      { interlocutor: CALL_BORIS, examiner: { tone: 9 } },
      { only: ['x-t-01-price-first'], judge: true, judgeCounts: true },
    )
    expect(summary).toMatchObject({ unanswered: 1, passed: false })
    const [row] = await db.select().from(examResult)
    expect(checkIds(row)).toEqual(['run.judge'])
  })

  it('FR-TRAIN-8: a Checker that did not answer leaves the scenario unanswered, so the run does not pass', async () => {
    const { summary } = await exam(
      { interlocutor: REPLY, checker: { unsupported: 'not a list' } },
      { only: ['x-t-03-how-start'] },
    )
    expect(summary).toMatchObject({ unanswered: 1, passed: false, s1: 0 })
    const [row] = await db.select().from(examResult)
    expect(checkIds(row)).toEqual(['run.checker'])
  })

  it('FR-TRAIN-8: without the judge flag the examiner is not called', async () => {
    const { fake } = await exam({ interlocutor: CALL_BORIS }, { only: ['x-t-01-price-first'] })
    expect((await fake.calls()).map((c) => c.role)).not.toContain('examiner')
    const [row] = await db.select().from(examResult)
    expect(row?.judge).toBeNull()
  })

  it('FR-TRAIN-8: the cases of the scenario are the ones offered, not the cases of the mind', async () => {
    const told = interlocutorAnswer({
      topic: 'cases',
      text: 'Делали для Лиса-Клиник онлайн-запись: запись переехала с телефона на сайт. У вас задача похожая, подробности расскажем на созвоне.',
      fact_ids: ['k-case-x1'],
      case: { moment: 'asked', case_id: 'k-case-x1', why: 'просили примеры для клиник' },
    })
    const { summary, fake } = await exam(
      { interlocutor: told, checker: CLEAN },
      { only: ['x-hard-10-case-asked'] },
    )
    const input = (await fake.calls()).find((c) => c.role === 'interlocutor')?.stdin ?? ''
    expect(input).toContain('## Кейсы')
    expect(input).toContain('[k-case-x1]')
    expect(input).toContain('[k-case-x2]')
    // The mind of the test holds its own cases; the exam does not offer them.
    expect(input).not.toContain('[k-case-01]')
    expect(summary).toMatchObject({ score: 1, passed: true, s1: 0 })
  })

  it('FR-TRAIN-8: an invented case fails the scenario as S1', async () => {
    const invented = interlocutorAnswer({
      topic: 'cases',
      text: 'Делали для заводов металлоконструкций, там заявок стало вдвое больше. Подробности расскажем на созвоне.',
      fact_ids: ['k-process-start'],
      case: { moment: 'asked', case_id: 'k-case-x99', why: 'просили примеры' },
    })
    const { summary } = await exam(
      { interlocutor: invented, checker: CLEAN },
      { only: ['x-hard-12-case-none-fit'] },
    )
    expect(summary.s1).toBe(1)
    expect(summary.passed).toBe(false)
    const [row] = await db.select().from(examResult)
    expect(checkIds(row)).toContain('case.unknown')
  })

  it('FR-TRAIN-8: a case told where none is wanted costs S2', async () => {
    const needless = interlocutorAnswer({
      topic: 'process',
      text: 'Нужны доступы к рекламному кабинету и пара вопросов о товаре. Делали для Цветочная студия похожее, там запустились за неделю.',
      fact_ids: ['k-process-start'],
      case: { moment: 'same_problem', case_id: 'k-case-x5', why: 'похожая задача' },
    })
    const { summary } = await exam(
      { interlocutor: needless, checker: CLEAN },
      { only: ['x-hard-11-case-out-of-place'] },
    )
    expect(summary.s1).toBe(0)
    expect(summary.s2).toBeGreaterThanOrEqual(1)
    const [row] = await db.select().from(examResult)
    expect(checkIds(row)).toContain('case.needless')
  })

  it('FR-TRAIN-8: an engine that throws on one scenario does not stop the run', async () => {
    const mind = fakeMind()
    let n = 0
    const failing = {
      ...mind,
      version: async () => 'mind-v1',
      search: async (...a: Parameters<typeof mind.search>) => {
        // Only the first scenario's recall breaks.
        if (n++ === 0) throw new Error('index is gone')
        return mind.search(...a)
      },
    }
    // The first scenario never reaches the model, so the only answer of the Interlocutor is the second one's.
    const { summary } = await exam({ interlocutor: NONE }, { only: TWO, mind: failing })
    expect(summary.scenarios).toBe(2)
    const rows = await db.select().from(examResult).orderBy(examResult.scenarioId)
    expect(rows.map((r) => r.severity)).toEqual(['S2', null])
    expect((rows[0]?.checks as { id: string; detail: string }[] | undefined)?.[0]).toMatchObject({
      id: 'run.failed',
    })
    // A run in which a scenario got no answer measures nothing: it does not pass, even as the first run.
    expect(summary.unanswered).toBe(1)
    expect(summary.passed).toBe(false)
  })

  it('FR-TRAIN-8: a set with a broken file or an unknown id refuses to run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exam-bad-'))
    await writeFile(join(dir, 'x-broken.json'), '{')
    await expect(exam({ interlocutor: CALL_BORIS }, { dirs: [dir] })).rejects.toThrow(/x-broken/)
    await expect(exam({ interlocutor: CALL_BORIS }, { only: ['x-no-such'] })).rejects.toThrow(
      /x-no-such/,
    )
    expect((await db.select({ n: count() }).from(examRun))[0]?.n).toBe(0)
  })
})

describe('examVerdict', () => {
  it('FR-TRAIN-8: no S1 and a score not below the last run of the same set passes', () => {
    expect(examVerdict({ score: 0.9, s1: 0 }, null)).toBe(true)
    expect(examVerdict({ score: 0.9, s1: 0 }, { score: 0.9 })).toBe(true)
    expect(examVerdict({ score: 0.95, s1: 0 }, { score: 0.9 })).toBe(true)
    expect(examVerdict({ score: 0.8999, s1: 0 }, { score: 0.9 })).toBe(false)
    // Real numbers that went through a float4 column are not worse than themselves.
    expect(examVerdict({ score: 0.8667, s1: 0 }, { score: Math.fround(0.8667) })).toBe(true)
    expect(examVerdict({ score: 0.1, s1: 0 }, { score: Math.fround(0.1) })).toBe(true)
  })

  it('FR-TRAIN-8: any S1 fails the run, however good its score', () => {
    expect(examVerdict({ score: 0.99, s1: 1 }, null)).toBe(false)
    expect(examVerdict({ score: 0.99, s1: 1 }, { score: 0.5 })).toBe(false)
  })
})
