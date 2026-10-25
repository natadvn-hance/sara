// pnpm exam [--only <id>] [--compare] [--judge] [--judge-counts]: runs the exam of scenarios through the turn engine
// (FR-TRAIN-8). `--compare` is the deploy guard: exit code 1 on any S1 or a worse score than the last run of the same
// set. pnpm exam:build [--limit N]: proposes scenarios from the history of the chats.
// Runs only where the Claude token is (the server); in CI it refuses.

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { createGateway } from '../gateway/gateway'
import { createMindSearch } from '../mind/search'
import { createSecretStore } from '../secrets/store'
import { buildScenarios } from './build'
import { mindStateProblem, readMindState } from './mindState'
import { ExamSetupError, type ExamSummary, runExam, type ScenarioResult } from './run'

const ROOT = resolve(import.meta.dirname, '../../../..')

/** A mistake of the one who runs the command: said in plain words, exit code 2. */
export class UsageError extends Error {}

export type Args = {
  command: 'run' | 'build' | 'help'
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
  if (argv.includes('--help') || argv.includes('-h')) return { ...args, command: 'help' }
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

/**
 * The answers the fake Claude CLI is told to give (tests and the check under node): only its own variables, and never
 * in production, where no fake is run and nothing of the environment should reach the child.
 */
export const fakeClaudeEnv = (env: NodeJS.ProcessEnv): Record<string, string> =>
  env.NODE_ENV === 'production'
    ? {}
    : Object.fromEntries(
        Object.entries(env).filter(
          (e): e is [string, string] => e[0].startsWith('FAKE_CLAUDE_') && e[1] !== undefined,
        ),
      )

export const HELP = [
  'pnpm exam [--only <номер>] [--compare] [--judge] [--judge-counts]',
  '  Прогоняет сценарии экзамена через движок хода (без отправки) и сохраняет прогон в core.exam_run.',
  '  --only <номер>  только эти сценарии (можно несколько раз или через запятую); такой прогон считается отдельным набором',
  '  --compare       сторож выкладки: сравнивает с последним прошедшим прогоном того же набора (или по неизменившимся сценариям)',
  '  --judge         позвать судью: его оценки показываются, но итог не меняют',
  '  --judge-counts  оценки судьи считаются (только после сверки с оценками Бориса на золотом наборе); отдельный набор',
  'pnpm exam:build [--limit N]',
  '  Предлагает сценарии из истории чатов строками core.mind_proposal (вид scenario).',
  'Коды выхода: 0 прошёл или сторож не включён; 1 сторож не пропускает (S1, сценарий без ответа модели, сценарий хуже, чем в прошлом',
  'прошедшем прогоне, разум менялся во время прогона); 2 не запустился (CI, ошибка в аргументах, набор не читается, индекс разума',
  'не совпадает с папкой); 3 сравнивать не с чем. Код выхода 3 лечится так: сначала прогони выложенную версию без --compare.',
  'SARA_EXAM_DIRS (папки через двоеточие) заменяет папки сценариев для проверки на малом наборе; с --compare не годится.',
  'Очередь P3 упорядочивает только вызовы внутри процесса экзамена: боевые ходы идут в процессе ядра и её не видят,',
  'а подписка у них общая. Поэтому запускай экзамен ночью.',
]

/**
 * Where the scenarios are: the handmade ones in the repository and the ones from history in the mind folder.
 * `SARA_EXAM_DIRS` (folders divided by a colon) names them instead, for a check of the command on a small set.
 */
function examDirs(env: NodeJS.ProcessEnv, mindDir: string): string[] {
  if (env.SARA_EXAM_DIRS) return env.SARA_EXAM_DIRS.split(':').filter(Boolean)
  return [join(ROOT, 'tests/exam/scenarios'), join(mindDir, 'exam/scenarios')]
}

export const NO_BASELINE =
  'Прошлого прошедшего прогона на этом наборе нет: сначала прогони выложенную версию (pnpm exam без --compare, на выложенном коде).'

/** Says how the run went and returns the exit code: 0, 1 (the guard did not pass), 3 (the guard has nothing to compare with). */
export function verdict(args: Args, summary: ExamSummary, io: Io): number {
  io.out(
    `Прогон ${summary.runId}: набор ${summary.setHash}, сценариев ${summary.scenarios}, итог ${num(summary.score)}, S1 ${summary.s1}, S2 ${summary.s2}, S3 ${summary.s3}.`,
  )
  if (summary.baseline === 'same')
    io.out(
      `Сравнение с последним прошедшим прогоном того же набора (${summary.comparedTo}): ${num(summary.previousScore ?? 0)}.`,
    )
  else if (summary.baseline === 'overlap')
    io.out(
      `Набор изменился. Сравнение с последним прошедшим прогоном (${summary.comparedTo}) по сценариям, которые не менялись: ${summary.overlap}.`,
    )
  else io.out('Прошедшего прогона для сравнения нет.')
  if (summary.unanswered > 0)
    io.out(
      `Модель не ответила в сценариях: ${summary.unanswered} (Собеседник, Проверяющий или судья, который считается). Проверь связь с Claude (pnpm probe:claude): такой прогон не показывает, как Сара отвечает.`,
    )
  if (summary.mindShifted > 0)
    io.out(
      `Индекс разума менялся во время прогона (сценариев с другой версией: ${summary.mindShifted}): такой прогон не считается, запусти его снова.`,
    )
  if (summary.worse.length > 0)
    io.out(`Хуже, чем в прошлом прошедшем прогоне, стали сценарии: ${summary.worse.join(', ')}.`)
  if (summary.passed) io.out('Прошёл: S1 нет, ни один сценарий не стал хуже.')
  else if (summary.unanswered > 0) io.out('Не прошёл: часть сценариев осталась без ответа.')
  else if (summary.mindShifted > 0) io.out('Не прошёл: разум менялся во время прогона.')
  else if (summary.s1 > 0) io.out(`Не прошёл: есть S1 (${summary.s1}).`)
  else if (summary.worse.length > 0) io.out('Не прошёл: итог хуже прошлого прошедшего прогона.')
  else if (args.compare && summary.baseline === null) io.out(NO_BASELINE)
  else io.out('Не прошёл: итог хуже прошлого прогона.')
  if (!args.compare || summary.passed) return 0
  return summary.baseline === null && summary.s1 === 0 && summary.unanswered === 0 ? 3 : 1
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
    // The exam reads the index the core keeps and never builds it: a candidate mind would go live before the guard.
    const problem = mindStateProblem(await readMindState(db, config.mindDir))
    if (problem) throw new ExamSetupError(problem)
    const mind = createMindSearch(db)
    const mindVersion = await mind.version()
    io.out(`Экзамен, разум ${mindVersion}.`)
    const summary = await runExam(
      { db, gateway, mind, rolesDir: config.rolesDir, claudeBin: config.claudeBin },
      {
        dirs: examDirs(env, config.mindDir),
        only: args.only,
        judge: args.judge,
        judgeCounts: args.judgeCounts,
        guard: args.compare,
        concurrency: 2,
        scope: config.accounts[0]?.id ?? 'shared',
        onResult: (r) => {
          for (const l of lineOf(r)) io.out(l)
        },
      },
    )
    return verdict(args, summary, io)
  } finally {
    gateway.stop()
    await close()
  }
}

/** The command; returns the exit code: 0, 1 (the guard did not pass), 2 (cannot run as asked), 3 (no baseline). */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = { out: console.log, err: console.error },
): Promise<number> {
  try {
    // The help is read anywhere, CI included: it runs nothing.
    if (argv.includes('--help') || argv.includes('-h')) {
      for (const line of HELP) io.out(line)
      return 0
    }
    assertNotCi(env)
    const args = parseArgs(argv)
    if (args.compare && env.SARA_EXAM_DIRS)
      throw new UsageError(
        'Сторож выкладки читает набор целиком: --compare нельзя вместе с SARA_EXAM_DIRS.',
      )
    return await execute(args, env, io)
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
