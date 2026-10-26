import type { TaskAction } from '@sara/shared'
import type { Db } from '../db/client'
import type { BorisMessage } from '../learning/inbox'
import { boundChat } from './binding'
import type { Notifier } from './notifier'
import { createTelegramRuntime, type TelegramRuntime } from './telegram'

export type BotControl = {
  start(token: string): Promise<void>
  stop(): Promise<void>
  isBound(): Promise<boolean>
  botUsername(): string | null
  lastError(): string | null
  notifier: Notifier
}

/** Owns the one running bot; the wizard can (re)start it with a new token. */
export function createBotControl(d: {
  db: Db
  apiRoot?: string
  onPress(p: { taskId: string; action: TaskAction }): Promise<string>
  onMessage?(m: BorisMessage): Promise<string>
  voiceDir?: string
}): BotControl {
  let runtime: TelegramRuntime | null = null
  const current = (): TelegramRuntime => {
    if (!runtime) throw new Error('Telegram bot is not started')
    return runtime
  }
  return {
    async start(token) {
      if (runtime) await runtime.stop()
      runtime = createTelegramRuntime({
        token,
        apiRoot: d.apiRoot,
        db: d.db,
        onPress: d.onPress,
        onMessage: d.onMessage,
        voiceDir: d.voiceDir,
      })
      await runtime.start()
    },
    async stop() {
      await runtime?.stop()
      runtime = null
    },
    isBound: async () => (await boundChat(d.db)) !== null,
    botUsername: () => runtime?.botUsername() ?? null,
    lastError: () => runtime?.lastError() ?? null,
    notifier: {
      sendLeadCard: (c, o) => current().notifier.sendLeadCard(c, o),
      closeLeadCard: (id, c) => current().notifier.closeLeadCard(id, c),
      sendText: (t, o) => current().notifier.sendText(t, o),
      sendButtons: (t, rows, o) => current().notifier.sendButtons(t, rows, o),
      editText: async (id, t, rows) => current().notifier.editText?.(id, t, rows),
    },
  }
}
