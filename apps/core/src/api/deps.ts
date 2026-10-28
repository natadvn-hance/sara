import type { TaskAction } from '@sara/shared'
import type { Db } from '../db/client'
import type { Gateway } from '../gateway/gateway'
import type { BotControl } from '../notify/botControl'
import type { ProfiClient } from '../profi/client'
import type { SecretStore } from '../secrets/store'

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
  onPress?: (p: { taskId: string; action: TaskAction }) => Promise<string>
  /** The host's backup log for the health screen (config.backupLog). */
  backupLog?: string
}

export type AccountConfig = { id: string; title: string; egressIp: string }
