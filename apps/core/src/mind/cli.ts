// pnpm mind:index, pnpm mind:proposals --to <clone>, pnpm mind:accept <path>… [--mind <clone>]: the mind commands of
// development (M4 design 5.2). The core itself only reads the mind folder; these run on a developer's clone.
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { loadConfig } from '../config'
import { createDb } from '../db/client'
import { ensureMindIndex } from './indexer'
import { loadMind, parseRecord } from './loader'
import { exportProposals } from './proposals'

const run = promisify(execFile)
const git = async (dir: string, ...args: string[]) =>
  (await run('git', ['-C', dir, ...args])).stdout.trim()

const PROPOSALS = 'mind/proposals/'

export type Accepted = { id: string; from: string; to: string; committed: boolean }

/** A proposal path from the command line: inside the clone, relative to the root or to `mind/proposals/`. */
function proposalPath(root: string, p: string): string {
  const rel = (isAbsolute(p) ? relative(root, p) : normalize(p)).split(sep).join('/')
  if (rel.startsWith(PROPOSALS)) return rel
  if (rel.startsWith('proposals/')) return `mind/${rel}`
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('mind/') || isAbsolute(rel))
    throw new Error(`${p}: принимаются только файлы из mind/proposals/`)
  return `${PROPOSALS}${rel}`
}

/** The fields at the top with `status: confirmed`; the rest of the file stays as Boris read it. */
function confirm(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, (front) =>
    front.replace(/^status:.*$/m, 'status: confirmed'),
  )
}

/** True when the folder is the top of a git work tree, so a commit never lands in a repository around it. */
async function isClone(root: string): Promise<boolean> {
  try {
    return (
      (await realpath(await git(root, 'rev-parse', '--show-toplevel'))) === (await realpath(root))
    )
  } catch {
    return false
  }
}

/**
 * Boris said yes (FR-MIND-3): each proposal moves from `mind/proposals/` to the same place in the mind as confirmed,
 * one commit per record when the clone is a git work tree. Every file is checked first, so a bad one moves nothing:
 * the rewrite must leave `status: confirmed`, and the place must be free or hold the record with the same id.
 */
export async function acceptProposals(mindDir: string, paths: string[]): Promise<Accepted[]> {
  const root = resolve(mindDir)
  const mind = await loadMind(root)
  const plans: { id: string; from: string; to: string; text: string }[] = []
  for (const p of paths) {
    const from = proposalPath(root, p)
    const to = `mind/${from.slice(PROPOSALS.length)}`
    if (!/^mind\/(shared|directions)\//.test(to))
      throw new Error(`${from}: в разум попадают только shared/ и directions/`)
    const original = await readFile(join(root, from), 'utf8').catch(() => null)
    if (original === null) throw new Error(`${from}: нет такого файла`)
    const text = confirm(original)
    const r = parseRecord(to, text)
    if ('error' in r) throw new Error(`${from}: ${r.error}`)
    if (r.record.front.status !== 'confirmed')
      throw new Error(`${from}: после правки поле status не стало confirmed, файл не принят`)
    const id = r.record.front.id
    const there = await readFile(join(root, to), 'utf8').catch(() => null)
    if (there !== null) {
      // A proposal replaces the record with its own id; a different record at that path is not overwritten.
      const held = parseRecord(to, there)
      const heldId = 'record' in held ? held.record.front.id : null
      if (heldId !== id)
        throw new Error(
          `${from}: на месте ${to} уже лежит ${heldId ? `запись ${heldId}` : 'файл, который разум не читает'}`,
        )
    }
    const other =
      mind.records.find((x) => x.front.id === id && x.path !== to)?.path ??
      plans.find((x) => x.id === id)?.from
    if (other) throw new Error(`${from}: номер ${id} уже есть в ${other}`)
    plans.push({ id, from, to, text })
  }

  const clone = await isClone(root)
  const done: Accepted[] = []
  for (const { id, from, to, text } of plans) {
    const tracked =
      clone &&
      (await git(root, 'ls-files', '--error-unmatch', '--', from).then(
        () => true,
        () => false,
      ))
    await mkdir(dirname(join(root, to)), { recursive: true })
    await writeFile(join(root, to), text)
    await unlink(join(root, from))
    if (clone) {
      await git(root, 'add', '--', to)
      const paths = tracked ? [to, from] : [to]
      await git(root, 'commit', '-q', '-m', `mind: accept ${id} (Boris said yes)`, '--', ...paths)
    }
    done.push({ id, from, to, committed: clone })
  }
  return done
}

const USAGE =
  'Команды: mind index; mind proposals --to <клон sara-mind>; mind accept <путь в mind/proposals>… [--mind <клон>]'

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { to: { type: 'string' }, mind: { type: 'string' } },
  })
  const [command, ...rest] = positionals
  // pnpm --filter runs this inside apps/core; folders are given from where the developer typed the command.
  const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p)
  const config = loadConfig()

  if (command === 'accept') {
    if (rest.length === 0) throw new Error(USAGE)
    const mindDir = values.mind ? here(values.mind) : config.mindDir
    for (const a of await acceptProposals(mindDir, rest)) {
      const commit = a.committed ? 'коммит сделан' : 'папка не git, коммита нет'
      console.log(`${a.id}: ${a.from} → ${a.to}, подтверждено, ${commit}`)
    }
    return
  }
  if (command !== 'index' && command !== 'proposals') throw new Error(USAGE)
  if (command === 'proposals' && !values.to) throw new Error(USAGE)

  const { db, close } = createDb(config.databaseUrl)
  try {
    if (command === 'proposals') {
      const to = here(values.to ?? '')
      console.log(`Выложено предложений: ${await exportProposals(db, to)} в ${to}`)
      return
    }
    for (const e of (await loadMind(config.mindDir)).errors) {
      console.log(`Не загружено: ${e.path}: ${e.message}`)
    }
    const r = await ensureMindIndex(db, config.mindDir)
    const what = r.changed ? 'индекс перестроен' : 'без изменений'
    console.log(
      `Разум ${r.mindVersion} из ${config.mindDir}: записей в индексе ${r.records}, ${what}`,
    )
  } finally {
    await close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2)).catch((e: Error) => {
    console.log(e.message)
    process.exitCode = 1
  })
}
