import type { TaskAction } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { task } from '../db/schema'
import type { Notifier } from '../notify/notifier'

/** Where a press came from: the Telegram button, the pult, the secretary in the bot, or a held bid that fired. */
export type PressSource = 'telegram' | 'pult' | 'secretary' | 'hold'

export type Press = {
  taskId: string
  action: TaskAction
  source?: PressSource
  /** Boris's reason for a skip from the pult: kept on the label, no «почему?» asked in Telegram. */
  reason?: string | null
}

const DONE_RU: Partial<Record<TaskAction, string>> = {
  bid: 'отклик',
  skip: 'закрыто',
  send: 'отправлено',
  take: 'клиент твой',
  close: 'закрыто',
  apply: 'применено',
  drop: 'оставлено как было',
  good: 'хорошо',
}

/**
 * One dispatcher for every press (pult v2 design 3): the same function the Telegram button calls, and after it,
 * when the task closed from somewhere else than Telegram, the card in Telegram loses its buttons and says
 * «Решено в приложении». The bell reads the task's state, so its row is done without another write.
 */
export function createResolver(d: {
  db: Db
  press(p: Press): Promise<string>
  notifier: Pick<Notifier, 'markDone'>
}) {
  return async function resolveTask(p: Press): Promise<string> {
    const source = p.source ?? 'telegram'
    const [before] = await d.db.select().from(task).where(eq(task.id, p.taskId))
    const answer = await d.press({ ...p, source })
    if (!before || source === 'telegram') return answer
    const [after] = await d.db.select().from(task).where(eq(task.id, p.taskId))
    if (!after || after.state === 'open' || before.state !== 'open' || !after.telegramMessageId)
      return answer
    // A closed lead card is already edited into «📁 Заявка закрыта»: no button is put back on it.
    if (p.action === 'skip' && after.kind === 'lead_decision') return answer
    try {
      await d.notifier.markDone?.(
        after.telegramMessageId,
        `Решено в приложении: ${DONE_RU[p.action] ?? 'готово'}`,
      )
    } catch (e) {
      console.error('card not marked', e instanceof Error ? e.message.slice(0, 200) : e)
    }
    return answer
  }
}
