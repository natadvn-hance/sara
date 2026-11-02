import type { NoticeKind, TaskAction } from '@sara/shared'
import type { Db } from '../db/client'
import type { BorisMessage, BorisReply } from '../learning/inbox'
import { boundChat } from './binding'
import { withNoticeLog } from './center'
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
  onMessage?(m: BorisMessage): Promise<BorisReply | null>
  /** Boris's /test with the words after it (test orders, docs/ops/test-leads.md). */
  onTest?(args: string): Promise<string>
  voiceDir?: string
  /** A new notice of the bell: the phone and the computer ring (Web Push). */
  onNotice?: (kind: NoticeKind) => void
  /** The pult's address, for /pult. */
  publicUrl?: string
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
        onTest: d.onTest,
        voiceDir: d.voiceDir,
        publicUrl: d.publicUrl,
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
    // Every send leaves a notice for the pult's bell (pult v2 design 6).
    notifier: withNoticeLog(
      {
        sendLeadCard: (c, o) => current().notifier.sendLeadCard(c, o),
        closeLeadCard: (id, c) => current().notifier.closeLeadCard(id, c),
        sendText: (t, o) => current().notifier.sendText(t, o),
        sendButtons: (t, rows, o) => current().notifier.sendButtons(t, rows, o),
        editText: async (id, t, rows, o) => current().notifier.editText?.(id, t, rows, o),
        typing: async () => current().notifier.typing?.(),
        markDone: async (id, note) => current().notifier.markDone?.(id, note),
        closeTopic: async (place, outcome) => current().notifier.closeTopic?.(place, outcome),
        topicLink: async (place) => (await current().notifier.topicLink?.(place)) ?? null,
        setTopicStage: async (place, dot) => current().notifier.setTopicStage?.(place, dot),
        topicPosts: async (place) => (await current().notifier.topicPosts?.(place)) ?? [],
        forumOn: async () => (await current().notifier.forumOn?.()) ?? false,
      },
      d.db,
      d.onNotice,
    ),
  }
}
