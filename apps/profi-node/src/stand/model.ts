import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RoleMeta, TrainerClientOutput } from '@sara/shared'
// The stand plays the client through the same CLI contract as the core's gateway (spec 7.4).
import { buildClaudeArgs, roleJsonSchema, runClaude } from '../../../core/src/gateway/claudeCli'

export type ClientTurn = {
  persona: Record<string, unknown>
  order: { title: string; text: string; budget_text: string | null }
  /** The hard behaviour the client holds, in words; null: an ordinary client. */
  behaviour: string | null
  dialog: { who: 'клиент' | 'исполнитель'; text: string }[]
}

export type ClientModel = (turn: ClientTurn) => Promise<TrainerClientOutput | { error: string }>

/**
 * The trainer's client role (roles/trainer-client, haiku) writes the client's next line. The token is the stand core's
 * own, read from its secrets file each call: Boris types it once in the stand's setup wizard.
 */
export function createClientModel(o: {
  claudeBin: string
  rolesDir: string
  token: () => Promise<string | null>
  cwd: string
  extraEnv?: Record<string, string>
}): ClientModel {
  const dir = join(o.rolesDir, 'trainer-client')
  return async (turn) => {
    const token = await o.token()
    if (!token) return { error: 'нет токена Claude: пройди мастер в пульте стенда' }
    const meta = RoleMeta.parse(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')))
    const run = await runClaude({
      bin: o.claudeBin,
      args: buildClaudeArgs(meta, join(dir, 'role.md'), roleJsonSchema(TrainerClientOutput)),
      input: JSON.stringify(turn),
      token,
      cwd: o.cwd,
      timeoutMs: meta.timeoutMs,
      extraEnv: o.extraEnv,
    })
    if (run.timedOut) return { error: 'модель не ответила вовремя' }
    try {
      const parsed = JSON.parse(run.stdout) as { structured_output?: unknown; is_error?: boolean }
      const checked = TrainerClientOutput.safeParse(parsed.structured_output)
      if (checked.success) return checked.data
    } catch {}
    return { error: `модель ответила не по схеме (код ${run.code})` }
  }
}

/** The token from the stand core's secrets file (the same `secrets.json` its wizard writes). */
export const tokenFrom = (file: string) => async (): Promise<string | null> => {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')).claude_oauth_token
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}
