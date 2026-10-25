import { moscowHoursEnd } from './time'

/**
 * Reminders to a client who went quiet after our side's message (FR-CONV-12, M4 design 5.11). This file is the
 * ladder and the ready texts (pure); the durable process `convRemind` is in reminders.ts.
 */

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

export type ReminderStep = 1 | 2 | 'dormant' | 3 | 4
export type ReminderTone = 'check_in' | 'friendly'

export type NextReminder = {
  at: Date
  step: ReminderStep
  tone: ReminderTone
  /** Whether the client read our message; it shapes the text, never the time. */
  read: boolean
}

/** A reminder never goes within this long after the one before it (tests shorten it). */
const MIN_GAP_MS = DAY_MS

/** Moscow hours without reminders to clients (the setting's default). */
const DEFAULT_QUIET = { from: 23, to: 9 }

/**
 * The next step of the ladder (design 5.11), counted from our side's last message: a day, three days, and on the
 * seventh day the client is dormant and Boris gets one task. Only when Boris says «Напоминать дальше» the ladder goes
 * on: 10 days after the dormant day, then 30 days after that, the last one friendly (old Sara's ladder since 12.09).
 * `sent` is how many reminders of the ladder are done. A time inside the quiet hours moves to the morning, a time
 * already past is now, and two reminders keep a day between them. Null: nothing more to say.
 */
export function nextReminder(i: {
  lastOursAt: string
  sent: number
  read: boolean
  continued: boolean
  now: Date
  /** When the reminder before this one went. */
  lastSentAt?: string | null
  /** Moscow hours without reminders to clients (`conv.reminder_quiet`). */
  quiet?: { from: number; to: number }
  /** The least time between two reminders. */
  minGapMs?: number
}): NextReminder | null {
  const from = new Date(i.lastOursAt).getTime()
  if (Number.isNaN(from)) return null
  const plan: Record<number, { step: ReminderStep; after: number; tone: ReminderTone }> = {
    0: { step: 1, after: DAY_MS, tone: 'check_in' },
    1: { step: 2, after: 3 * DAY_MS, tone: 'check_in' },
    2: i.continued
      ? { step: 3, after: 17 * DAY_MS, tone: 'check_in' }
      : { step: 'dormant', after: 7 * DAY_MS, tone: 'check_in' },
    3: { step: 4, after: 47 * DAY_MS, tone: 'friendly' },
  }
  const p = i.continued || i.sent <= 2 ? plan[i.sent] : undefined
  if (!p) return null
  let due = from + p.after
  const sentAt = i.lastSentAt ? new Date(i.lastSentAt).getTime() : Number.NaN
  if (p.step !== 'dormant' && !Number.isNaN(sentAt))
    due = Math.max(due, sentAt + (i.minGapMs ?? MIN_GAP_MS))
  let at = new Date(Math.max(due, i.now.getTime()))
  // The dormant day is a task for Boris, whose notices have their own quiet; only a message to the client waits.
  if (p.step !== 'dormant') at = moscowHoursEnd(at, i.quiet ?? DEFAULT_QUIET) ?? at
  return { at, step: p.step, tone: p.tone, read: i.read }
}

/**
 * The ready text of old Sara (followUpTemplates.js, 06.10.2026): it goes when the model gives no text for 3 hours
 * past the time, because a reminder must go out for sure. Gender-neutral on purpose, the account is Hance.
 */
export function reminderFallback(clientName: string | null, tone: ReminderTone): string {
  const first = (clientName ?? '').trim().split(/\s+/)[0]
  const greeting = first ? `${first}, здравствуйте.` : 'Здравствуйте.'
  return tone === 'friendly'
    ? `${greeting} Если вопрос ещё открыт, пишите в любой момент: помогу разобраться, с чего начать. Хорошего дня!`
    : `${greeting} Если задача ещё актуальна, давайте обсудим детали: подскажу, с чего начать. Удобно созвониться на 15 минут?`
}
