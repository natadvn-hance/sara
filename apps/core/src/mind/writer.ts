import type { Db } from '../db/client'
import type { MindWriter } from '../school/types'
import type { SecretStore } from '../secrets/store'
import type { GitRunner } from './git'

/** The only code that writes into sara-mind, after Boris's «да» (ADR-025). Part B writes the body. */
export function createMindWriter(_d: {
  db: Db
  mindDir: string
  reindex(): Promise<void>
  secrets?: SecretStore
  git?: GitRunner
}): MindWriter {
  return {
    apply: async () => ({ ok: false, reason: 'no_git', detail: 'not built', refused: [] }),
    revert: async () => ({ ok: false, reason: 'no_git', detail: 'not built' }),
    sync: async () => ({ pushed: false, pulled: 0, error: 'not built' }),
  }
}
