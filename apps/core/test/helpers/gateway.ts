import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Db } from '../../src/db/client'
import { createGateway, type Gateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'

const ROOT = resolve(import.meta.dirname, '../../../..')

export type FakeGateway = {
  gateway: Gateway
  /** Every call the fake CLI got, newest last: the role and what it read on its input. */
  calls(): Promise<{ role: string; model: string | undefined; stdin: string }[]>
}

/** A real gateway over the fake Claude CLI, which answers by role (`{"$sequence": [...]}` for one answer per call). */
export async function fakeGateway(
  db: Db,
  byRole: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<FakeGateway> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-gw-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: {
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole),
      FAKE_CLAUDE_ARGS_LOG: join(dir, 'claude.log'),
      FAKE_CLAUDE_COUNTER_FILE: join(dir, 'counter.json'),
      ...env,
    },
  })
  return {
    gateway,
    async calls() {
      const text = await readFile(join(dir, 'claude.log'), 'utf8').catch(() => '')
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const c = JSON.parse(l) as { args: string[]; stdin: string }
          const file = c.args[c.args.indexOf('--system-prompt-file') + 1] ?? ''
          const model = c.args.includes('--model')
            ? c.args[c.args.indexOf('--model') + 1]
            : undefined
          return { role: /roles\/([^/]+)\/role\.md$/.exec(file)?.[1] ?? '', model, stdin: c.stdin }
        })
    },
  }
}
