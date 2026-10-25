import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { newEventId } from '@sara/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { chatMessage, examRun, mindProposal } from '../../src/db/schema'
import { assertNotCi, main, parseArgs, UsageError } from '../../src/exam/cli'
import { createSecretStore } from '../../src/secrets/store'
import { interlocutorAnswer } from '../helpers/conversation'
import { openTestDb, resetDb, testDatabaseUrl } from '../helpers/db'

const run = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '../../../..')
const CORE = join(ROOT, 'apps/core')
const { db, close } = openTestDb()
afterAll(close)
beforeEach(() => resetDb(db))

describe('the exam command line', { timeout: 30_000 }, () => {
  it('FR-TRAIN-8: the flags are --only, --compare, --judge and --judge-counts, and build takes --limit', () => {
    expect(parseArgs([])).toEqual({
      command: 'run',
      only: [],
      compare: false,
      judge: false,
      judgeCounts: false,
      limit: 30,
    })
    expect(parseArgs(['--only', 'x-a', '--only', 'x-b,x-c']).only).toEqual(['x-a', 'x-b', 'x-c'])
    expect(parseArgs(['--compare'])).toMatchObject({ compare: true, judge: false })
    expect(parseArgs(['--judge'])).toMatchObject({ judge: true, judgeCounts: false })
    // A judge that counts is a judge that runs.
    expect(parseArgs(['--judge-counts'])).toMatchObject({ judge: true, judgeCounts: true })
    expect(parseArgs(['build'])).toMatchObject({ command: 'build', limit: 30 })
    expect(parseArgs(['build', '--limit', '12'])).toMatchObject({ command: 'build', limit: 12 })
  })

  it('FR-TRAIN-8: a mistake in the flags is refused with the reason', () => {
    for (const bad of [
      ['--only'],
      ['--compare', '--only', 'x-a'],
      ['--nonsense'],
      ['build', '--compare'],
      ['build', '--only', 'x-a'],
      ['build', '--limit', '0'],
      ['build', '--limit', 'many'],
      ['x-a'],
    ])
      expect(() => parseArgs(bad), bad.join(' ')).toThrow(UsageError)
  })

  it('FR-TRAIN-8: the exam refuses to run in CI', () => {
    expect(() => assertNotCi({ CI: 'true' })).toThrow(/CI/)
    expect(() => assertNotCi({ CI: '1' })).toThrow(/CI/)
    expect(() => assertNotCi({})).not.toThrow()
    expect(() => assertNotCi({ CI: 'false' })).not.toThrow()
    expect(() => assertNotCi({ CI: '' })).not.toThrow()
  })

  it('FR-TRAIN-8: the command run as the server runs it exits at once in CI, before it opens a database', async () => {
    // A database address that leads nowhere: a run that got past the CI check would fail on it instead.
    const env = {
      ...process.env,
      CI: 'true',
      DATABASE_URL: 'postgres://sara:sara@127.0.0.1:1/none',
    }
    const r = await run(process.execPath, ['--import', 'tsx', 'src/exam/cli.ts', '--compare'], {
      cwd: CORE,
      env,
    }).then(
      () => ({ code: 0, stderr: '' }),
      (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
    )
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/CI/)
    expect(r.stderr).not.toMatch(/ECONNREFUSED/)
  })

  describe('with the fake Claude CLI', () => {
    const CALL_BORIS = interlocutorAnswer({
      move: 'call_boris',
      topic: 'price',
      text: null,
      fact_ids: [],
    })
    const NONE = interlocutorAnswer({ move: 'none', topic: 'smalltalk', text: null, fact_ids: [] })

    async function envWith(answer: unknown): Promise<NodeJS.ProcessEnv> {
      const dir = await mkdtemp(join(tmpdir(), 'exam-cli-'))
      await createSecretStore(join(dir, 'data')).set('claude_oauth_token', 'tok')
      // A set of one scenario, so that the whole set can be run and compared.
      await mkdir(join(dir, 'scenarios'))
      await copyFile(
        join(ROOT, 'tests/exam/scenarios/x-t-01-price-first.json'),
        join(dir, 'scenarios/x-t-01-price-first.json'),
      )
      return {
        SARA_EXAM_DIRS: join(dir, 'scenarios'),
        DATABASE_URL: testDatabaseUrl(),
        SARA_DATA_DIR: join(dir, 'data'),
        SARA_MIND_DIR: join(dir, 'mind'),
        SARA_CLAUDE_BIN: join(ROOT, 'tests/fakes/fake-claude.mjs'),
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ interlocutor: answer }),
      }
    }
    const io = () => {
      const lines: string[] = []
      return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }
    }

    it('FR-TRAIN-8: one scenario runs, is printed and stored, and --compare passes it', async () => {
      const { lines, io: sink } = io()
      const code = await main(['--compare'], await envWith(CALL_BORIS), sink)
      expect(code, lines.join('\n')).toBe(0)
      const text = lines.join('\n')
      expect(text).toContain('x-t-01-price-first')
      expect(text).toMatch(/итог 1/i)
      expect(text).toMatch(/прошёл/i)
      const [stored] = await db.select().from(examRun)
      expect(stored).toMatchObject({ score: 1, passed: true })
      expect(stored?.mindVersion).toBeTruthy()
    })

    it('FR-TRAIN-8: --compare exits 1 on a worse run than the last one of the same set', async () => {
      const first = io()
      expect(await main(['--compare'], await envWith(CALL_BORIS), first.io)).toBe(0)
      // The same scenario now gets a «none» where Boris was to be called: the wrong move.
      const second = io()
      const code = await main(['--compare'], await envWith(NONE), second.io)
      expect(code).toBe(1)
      expect(second.lines.join('\n')).toMatch(/не прошёл/i)
      expect(second.lines.join('\n')).toMatch(/хуже/i)
    })

    it('FR-TRAIN-8: without --compare a worse run is reported and the exit code stays 0', async () => {
      expect(await main([], await envWith(CALL_BORIS), io().io)).toBe(0)
      const worse = io()
      expect(await main([], await envWith(NONE), worse.io)).toBe(0)
      expect(worse.lines.join('\n')).toMatch(/не прошёл/i)
      const runs = await db.select().from(examRun).orderBy(examRun.startedAt)
      expect(runs.map((r) => r.passed)).toEqual([true, false])
    })

    it('FR-TRAIN-8: a run in which the Interlocutor did not answer says so and does not pass --compare', async () => {
      const sink = io()
      const env = { ...(await envWith(CALL_BORIS)), FAKE_CLAUDE_MODE: 'exit1' }
      const code = await main(['--compare'], env, sink.io)
      expect(code).toBe(1)
      const text = sink.lines.join('\n')
      expect(text).toMatch(/Собеседник не ответил/)
      expect(text).toMatch(/probe:claude/)
      const [stored] = await db.select().from(examRun)
      expect(stored).toMatchObject({ passed: false, score: 0.5, s1: 0 })
    })

    it('FR-TRAIN-8: the exam refuses to run in CI before it touches anything', async () => {
      const sink = io()
      const env = { ...(await envWith(CALL_BORIS)), CI: 'true' }
      expect(await main(['--only', 'x-t-01-price-first'], env, sink.io)).toBe(2)
      expect(sink.lines.join('\n')).toMatch(/CI/)
      expect(await db.select().from(examRun)).toEqual([])
    })

    it('FR-TRAIN-8: an unknown scenario or a flag mistake is refused with exit code 2', async () => {
      const sink = io()
      expect(await main(['--only', 'x-no-such'], await envWith(CALL_BORIS), sink.io)).toBe(2)
      expect(sink.lines.join('\n')).toContain('x-no-such')
      const flags = io()
      expect(await main(['--compare', '--only', 'x-a'], await envWith(CALL_BORIS), flags.io)).toBe(
        2,
      )
    })

    it('FR-TRAIN-8: exam:build proposes scenarios from the history and says how many', async () => {
      const at = (t: string) => `2026-10-01T${t}:00Z`
      let n = 0
      for (const [author, text, time] of [
        ['sara_v1', 'Анна, добрый день! Увидели ваш заказ.', '10:00'],
        ['client', 'Как будем работать?', '10:30'],
        ['boris', 'Начнём с короткого созвона, расскажу как идёт работа.', '11:00'],
      ] as const)
        await db.insert(chatMessage).values({
          id: newEventId(),
          accountId: 'hance-marketing',
          chatId: 'c1',
          platformMessageId: `m-${++n}`,
          side: author === 'client' ? 'client' : 'specialist',
          author,
          authorBasis: author === 'client' ? 'side' : 'v1_boris_text',
          text,
          sentAt: at(time),
          source: 'v1',
        })
      const sink = io()
      expect(await main(['build', '--limit', '5'], await envWith(CALL_BORIS), sink.io)).toBe(0)
      expect(sink.lines.join('\n')).toMatch(/Предложено сценариев: 1/)
      expect(await db.select().from(mindProposal)).toHaveLength(1)
    })
  })
})
