import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClientModel } from '@sara/profi-node/stand'
import { RoleMeta, TrainerClientOutput } from '@sara/shared'
import { buildClaudeArgs, roleJsonSchema, runClaude } from '../gateway/claudeCli'

/**
 * The client of a test order is played by the trainer's client role (roles/trainer-client, haiku): one line a call,
 * through the same CLI contract as the gateway (spec 7.4). The stand counts the calls against its own daily ceiling.
 */
export function createClientModel(o: {
  claudeBin: string
  rolesDir: string
  token: () => Promise<string | null>
  cwd: string
  extraEnv?: () => Record<string, string>
}): ClientModel {
  const dir = join(o.rolesDir, 'trainer-client')
  return async (turn) => {
    const token = await o.token()
    if (!token)
      return { error: 'нет токена Claude: клиент молчит, напиши за него сам', skipped: true }
    const meta = RoleMeta.parse(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')))
    const run = await runClaude({
      bin: o.claudeBin,
      args: buildClaudeArgs(meta, join(dir, 'role.md'), roleJsonSchema(TrainerClientOutput)),
      input: JSON.stringify(turn),
      token,
      cwd: o.cwd,
      timeoutMs: meta.timeoutMs,
      extraEnv: o.extraEnv?.(),
    })
    if (run.timedOut) return { error: 'модель не ответила вовремя' }
    try {
      const parsed = JSON.parse(run.stdout) as { structured_output?: unknown }
      const checked = TrainerClientOutput.safeParse(parsed.structured_output)
      if (checked.success) return checked.data
    } catch {}
    return { error: `модель ответила не по схеме (код ${run.code})` }
  }
}
