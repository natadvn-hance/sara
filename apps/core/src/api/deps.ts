import type { Db } from '../db/client'
import type { Gateway } from '../gateway/gateway'
import type { QuestionRow } from '../learning/questions'
import type { BotControl } from '../notify/botControl'
import type { ProfiClient } from '../profi/client'
import type { MindWriter } from '../school/types'
import type { SecretStore } from '../secrets/store'
import type { Press } from '../tasks/resolve'

export type AppDeps = {
  db: Db
  secrets: SecretStore
  gateway: Gateway
  profi: ProfiClient
  bot: BotControl
  /** Where the roles' prompts are, for jobs that score on their own (the runs of the direction pages). */
  rolesDir: string
  production: boolean
  telegramApiRoot?: string
  accountId?: string
  /** Accounts of this server with the IP each must go out from (FR-ACC-1). */
  accounts?: AccountConfig[]
  /** The press of a Telegram button, for the pult's buttons: the same function, the same events (M7 design 2). */
  onPress?: (p: Press) => Promise<string>
  /**
   * Bids from the pult (pult v2 design 4): a press waits ten seconds in the core and can be cancelled from anywhere;
   * «Перепроверить» reads the order page now.
   */
  bids?: {
    hold(
      leadId: string,
      expectedFeeRub: number,
    ): Promise<
      | { ok: true; message: string; executeAt: string }
      | { ok: false; status: number; message: string; code?: string }
    >
    cancel(leadId: string): Promise<{ ok: boolean; message: string }>
    recheck(leadId: string): Promise<{ message: string; closed: boolean }>
  }
  /** Boris's answer to a question of Sara from the pult: the same path as his reply in Telegram (pult v2 design 3). */
  answerQuestion?: (q: QuestionRow, text: string) => Promise<string>
  /** The pult's edit of a bid text or its service price, as the answer after «Изменить» without a new card. */
  saveBidText?: (p: {
    taskId: string
    text: string | null
    priceRub: number | null
    followUps?: string[] | null
  }) => Promise<{
    saved: boolean
    message: string
  }>
  /** The one writer of the mind (M5, ADR-025): Boris's «да» from the pult goes through it; unset, it waits. */
  mindWriter?: MindWriter
  /** The host's backup log for the health screen (config.backupLog). */
  backupLog?: string
  /** A Google Sheet is linked (config.sheet): «Состояние» shows whether it keeps up. */
  sheetLinked?: boolean
}

export type AccountConfig = { id: string; title: string; egressIp: string }
