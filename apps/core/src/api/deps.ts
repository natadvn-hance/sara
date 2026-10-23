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
  production: boolean
  telegramApiRoot?: string
  accountId?: string
}
