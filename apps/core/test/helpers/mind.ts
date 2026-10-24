import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { MindFrontmatter } from '@sara/shared'
import { stringify } from 'yaml'

const run = promisify(execFile)

/** An empty folder standing in for a sara-mind clone. */
export function tempMind(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sara-mind-'))
}

type Front = Partial<MindFrontmatter> & Pick<MindFrontmatter, 'id' | 'type'>

/** The text of a mind record: fields at the top between `---`, then the Markdown body. */
export function recordText(front: Front | Record<string, unknown>, body: string): string {
  const full = {
    scope: 'shared',
    status: 'confirmed',
    version: 1,
    sources: ['boris:test'],
    valid_from: '2026-01-01',
    valid_to: null,
    ...front,
  }
  return `---\n${stringify(full)}---\n\n${body}\n`
}

/** Writes a file at `rel` inside the clone, creating its folders. */
export async function putFile(root: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), text)
}

export function putRecord(
  root: string,
  rel: string,
  front: Front | Record<string, unknown>,
  body: string,
): Promise<void> {
  return putFile(root, rel, recordText(front, body))
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', dir, ...args])).stdout.trim()
}

/** Makes the folder a git repository with a local author and one commit of everything in it. */
export async function gitCommitAll(dir: string, message = 'mind'): Promise<string> {
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.name', 'Test')
  await git(dir, 'config', 'user.email', 'test@example.invalid')
  await git(dir, 'config', 'commit.gpgsign', 'false')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}
