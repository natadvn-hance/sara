// pnpm exam [--only <id>] [--compare] [--judge] [--judge-counts]: runs the exam of scenarios through the turn engine
// (FR-TRAIN-8). `--compare` is the deploy guard: exit code 1 on any S1 or a worse score than the last run of the same
// set. pnpm exam:build [--limit N]: proposes scenarios from the history of the chats.
// Runs only where the Claude token is (the server); in CI it refuses.

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { createGateway } from '../gateway/gateway'
import { ensureMindIndex } from '../mind/indexer'
import { createMindSearch } from '../mind/search'
import { createSecretStore } from '../secrets/store'
import { buildScenarios } from './build'
import { ExamSetupError, runExam, type ScenarioResult } from './run'

const ROOT = resolve(import.meta.dirname, '../../../..')

/** A mistake of the one who runs the command: said in plain words, exit code 2. */
export class UsageError extends Error {}

export type Args = {
  command: 'run' | 'build'
  only: string[]
  compare: boolean
  judge: boolean
  judgeCounts: boolean
  limit: number
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'run',
    only: [],
    compare: false,
    judge: false,
    judgeCounts: false,
    limit: 30,
  }
  const rest = [...argv]
  if (rest[0] === 'build') {
    args.command = 'build'
    rest.shift()
  }
  while (rest.length > 0) {
    const flag = rest.shift()
    if (flag === '--only') {
      const value = rest.shift()
      if (!value || value.startsWith('--'))
        throw new UsageError('После --only нужен номер сценария.')
      args.only.push(...value.split(',').filter(Boolean))
    } else if (flag === '--compare') args.compare = true
    else if (flag === '--judge') args.judge = true
    else if (flag === '--judge-counts') {
      args.judge = true
      args.judgeCounts = true
    } else if (flag === '--limit') {
      const n = Number(rest.shift())
      if (!Number.isInteger(n) || n < 1)
        throw new UsageError('После --limit нужно целое число больше нуля.')
      args.limit = n
    } else
      throw new UsageError(
        `Не понимаю «${flag}». Можно: --only <номер>, --compare, --judge, --judge-counts; build --limit N.`,
      )
  }
  if (args.command === 'build' && (args.only.length > 0 || args.compare || args.judge))
    throw new UsageError('build понимает только --limit.')
  if (args.command === 'run' && argv.includes('--limit'))
    throw new UsageError('--limit есть только у build.')
  if (args.compare && args.only.length > 0)
    throw new UsageError('Сторож выкладки сравнивает весь набор: --compare нельзя вместе с --only.')
  return args
}

/** The exam calls the real Claude on the subscription and is for the server; CI checks the engine with the fake CLI. */
export function assertNotCi(env: NodeJS.ProcessEnv): void {
  const ci = env.CI
  if (ci && ci !== 'false' && ci !== '0')
    throw new UsageError(
      'Экзамен не запускается в CI: он ходит к настоящему Claude, токен подписки живёт только на сервере.',
    )
}

export type Io = { out: (line: string) => void; err: (line: string) => void }

const num = (x: number) => x.toFixed(2).replace('.', ',')

function lineOf(r: ScenarioResult): string[] {
  const g = r.grade
  return [
    `${r.id}: ${num(g.score)} ${g.severity ?? 'ок'}`,
    ...g.failures.map((f) => `    ${f.severity} ${f.id}: ${f.detail}`),
    ...g.advisory.map((f) => `    судья, не считается, ${f.severity} ${f.id}: ${f.detail}`),
  ]
}

/** The answers the fake Claude CLI is told to give (tests and the check under node): only its own variables. */
const fakeClaudeEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (e): e is [string, string] => e[0].startsWith('FAKE_CLAUDE_') && e[1] !== undefined,
    ),
  )

/**
 * Where the scenarios are: the handmade ones in the repository and the ones from history in the mind folder.
 * `SARA_EXAM_DIRS` (folders divided by a colon) names them instead, for a check of the command on a small set.
 */
function examDirs(env: NodeJS.ProcessEnv, mindDir: string): string[] {
  if (env.SARA_EXAM_DIRS) return env.SARA_EXAM_DIRS.split(':').filter(Boolean)
  return [join(ROOT, 'tests/exam/scenarios'), join(mindDir, 'exam/scenarios')]
}

async function execute(args: Args, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const config = loadConfig(env)
  const { db, close } = createDb(config.databaseUrl)
  const gateway = createGateway({
    db,
    secrets: createSecretStore(config.dataDir),
    claudeBin: config.claudeBin,
    rolesDir: config.rolesDir,
    dataDir: config.dataDir,
    concurrency: 2,
    extraEnv: fakeClaudeEnv(env),
  })
  try {
    if (args.command === 'build') {
      const n = await buildScenarios(db, { limit: args.limit })
      io.out(`Предложено сценариев: ${n}.`)
      if (n > 0)
        io.out(
          'Они лежат в core.mind_proposal (вид scenario). В sara-mind их выкладывает разработка, в экзамен они попадают после «да» Бориса.',
        )
      return 0
    }
    await ensureMindIndex(db, config.mindDir)
    const mind = createMindSearch(db)
    const mindVersion = await mind.version()
    io.out(`Экзамен, разум ${mindVersion}.`)
    const summary = await runExam(
      { db, gateway, mind, rolesDir: config.rolesDir },
      {
        dirs: examDirs(env, config.mindDir),
        only: args.only,
        judge: args.judge,
        judgeCounts: args.judgeCounts,
        concurrency: 2,
        scope: config.accounts[0]?.id ?? 'shared',
        onResult: (r) => {
          for (const l of lineOf(r)) io.out(l)
        },
      },
    )
    io.out(
      `Прогон ${summary.runId}: итог ${num(summary.score)}, S1 ${summary.s1}, S2 ${summary.s2}, S3 ${summary.s3}, сценариев ${summary.scenarios}.`,
    )
    io.out(
      summary.previousScore === null
        ? 'Прошлого прогона того же набора нет.'
        : `Прошлый прогон того же набора: ${num(summary.previousScore)}.`,
    )
    if (summary.unanswered > 0)
      io.out(
        `Собеседник не ответил в сценариях: ${summary.unanswered}. Проверь связь с Claude (pnpm probe:claude): такой прогон не показывает, как Сара отвечает.`,
      )
    if (summary.passed) io.out('Прошёл: S1 нет, итог не хуже прошлого.')
    else if (summary.unanswered > 0) io.out('Не прошёл: часть сценариев осталась без ответа.')
    else if (summary.s1 > 0) io.out(`Не прошёл: есть S1 (${summary.s1}).`)
    else io.out('Не прошёл: итог хуже прошлого прогона.')
    return args.compare && !summary.passed ? 1 : 0
  } finally {
    gateway.stop()
    await close()
  }
}

/** The command; returns the exit code: 0, 1 (the guard did not pass), 2 (the command cannot run as asked). */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = { out: console.log, err: console.error },
): Promise<number> {
  try {
    assertNotCi(env)
    return await execute(parseArgs(argv), env, io)
  } catch (e) {
    if (e instanceof UsageError || e instanceof ExamSetupError) {
      io.err(e.message)
      return 2
    }
    throw e
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e)
      process.exit(1)
    },
  )
}
