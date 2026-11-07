import { firstName } from '../leads/clientName'
import type { PingScenario } from './pingScenario'
import { moscowHoursEnd } from './time'

/**
 * Reminders to a client who went quiet after our side's message (FR-CONV-12, M4 design 5.11). This file is the
 * ladder and the ready texts (pure); the durable process `convRemind` is in reminders.ts.
 */

const DAY_MS = 24 * 3600_000

export type ReminderStep = 1 | 2 | 3 | 'dormant'
export type ReminderTone = 'check_in' | 'friendly'

export type NextReminder = {
  at: Date
  step: ReminderStep
  tone: ReminderTone
  /** Whether the client read our message; it shapes the text, never the time. */
  read: boolean
}

/** Moscow hours without reminders to clients (the setting's default). */
const DEFAULT_QUIET = { from: 23, to: 9 }

/** The waits of the ladder (rule 11 of «Голос Hance для Сары», Boris, 26.10.2026), in days. */
const FIRST_DAYS = 1
const SECOND_DAYS = 2
const THIRD_DAYS = 3
const SILENT_DAYS = 3

/** The waits of the ladder, each counted from the step before it; tests shorten them. */
export type Waits = { second?: number; third?: number; silent?: number }

/**
 * The next step of the ladder (design 5.11, Boris's rule 11): the first reminder a day after our side's last message
 * (two for a client who went to think it over), the second two days after the first, the third three days after the
 * second, and the third is the last. If the client is still silent three days after the third, that is a step of its
 * own, `dormant`: one task for Boris, no message to the client. `sent` is how many steps are done. A step counts from
 * `prevAt`, when the step before it went (or, if it was only skipped, when it was due); left out, the times of the
 * ladder itself are taken. A reminder inside the quiet hours moves to the morning, a time already past is now. Null:
 * nothing more to do.
 */
export function nextReminder(i: {
  lastOursAt: string
  sent: number
  read: boolean
  now: Date
  /** When the step before this one went or was due. */
  prevAt?: string | null
  /** Moscow hours without reminders to clients (`conv.reminder_quiet`). */
  quiet?: { from: number; to: number }
  /** The first reminder's wait: a day, but two for a client who went to think it over. */
  firstAfterMs?: number
  /** The first reminder never comes before this: the morning after a day the client named (spec 2026-11-07). */
  firstNotBefore?: Date | null
  /** The waits after the first step (2, 3 and 3 days); tests shorten them. */
  waitsMs?: Waits
}): NextReminder | null {
  const from = new Date(i.lastOursAt).getTime()
  if (Number.isNaN(from)) return null
  const waits = [
    i.firstAfterMs ?? FIRST_DAYS * DAY_MS,
    i.waitsMs?.second ?? SECOND_DAYS * DAY_MS,
    i.waitsMs?.third ?? THIRD_DAYS * DAY_MS,
    i.waitsMs?.silent ?? SILENT_DAYS * DAY_MS,
  ]
  const steps: { step: ReminderStep; tone: ReminderTone }[] = [
    { step: 1, tone: 'check_in' },
    { step: 2, tone: 'check_in' },
    { step: 3, tone: 'friendly' },
    { step: 'dormant', tone: 'check_in' },
  ]
  const p = steps[i.sent]
  const wait = waits[i.sent]
  if (!p || wait === undefined) return null
  // The time of the step before: when it went, or the ladder's own time for it.
  let before = from
  for (let k = 0; k < i.sent; k++) before += waits[k] ?? 0
  const prev = i.prevAt ? new Date(i.prevAt).getTime() : Number.NaN
  const base = i.sent === 0 ? from : Number.isNaN(prev) ? before : prev
  const floor = i.sent === 0 && i.firstNotBefore ? i.firstNotBefore.getTime() : 0
  let at = new Date(Math.max(base + wait, floor, i.now.getTime()))
  // The dormant day is a task for Boris, whose notices have their own quiet; only a message to the client waits.
  if (p.step !== 'dormant') at = moscowHoursEnd(at, i.quiet ?? DEFAULT_QUIET) ?? at
  return { at, step: p.step, tone: p.tone, read: i.read }
}

/**
 * The ready text of old Sara (followUpTemplates.js, 06.10.2026): it goes when the model gives no text that passes the
 * checks, because a reminder must go out for sure. Gender-neutral on purpose, the account is Hance. Variant 1 is the
 * other wording for the second time, so a client never reads the same ready text twice in a row.
 */
export function reminderFallback(
  clientName: string | null,
  tone: ReminderTone,
  variant: 0 | 1 = 0,
): string {
  const first = clientName ? firstName(clientName) : null
  const greeting = first ? `${first}, здравствуйте.` : 'Здравствуйте.'
  if (tone === 'friendly')
    return variant === 0
      ? `${greeting} Если вопрос ещё открыт, пишите в любой момент: помогу разобраться, с чего начать. Хорошего дня!`
      : `${greeting} Не буду отвлекать: если вопрос снова станет актуальным, просто напишите, я на связи. Хорошего дня!`
  return variant === 0
    ? `${greeting} Если задача ещё актуальна, давайте обсудим детали: подскажу, с чего начать. Удобно созвониться на 15 минут?`
    : `${greeting} Пишу ещё раз про ваш заказ. Если он в силе, давайте обсудим, с чего начать: удобно здесь, в переписке, или лучше созвониться?`
}

type Pair = readonly [string, string]

/** The two wordings of a ready ping for the scenarios that have their own (spec 2026-11-07-organic-pings). */
function scenarioTexts(hello: string, sc: PingScenario): Pair | null {
  if (sc.kind === 'awaiting' && sc.item === 'tz')
    return [
      `${hello} Как у вас с ТЗ? Можно в любом виде, хоть парой строк, дальше разберемся вместе`,
      `${hello} Если с ТЗ пока не складывается, можно обсудить задачу на коротком созвоне и собрать его по итогам`,
    ]
  if (sc.kind === 'awaiting' && sc.item === 'materials')
    return [
      `${hello} Получится прислать материалы? Можно частями, начну с того, что уже есть`,
      `${hello} Пишу про материалы: пришлите то, что под рукой, остальное доберем по ходу`,
    ]
  if (sc.kind === 'awaiting' && sc.item === 'budget')
    return [
      `${hello} Получилось прикинуть бюджет? Даже примерная вилка поможет понять, с чего лучше начать`,
      `${hello} Если цифру пока назвать сложно, расскажите, какой результат нужен, от него и оттолкнемся`,
    ]
  if (sc.kind === 'awaiting' && sc.item === 'call_time')
    return [
      `${hello} Когда вам удобно созвониться? Подстроюсь под ваше время`,
      `${hello} Подскажите день и время, когда вам удобно, и созвонимся`,
    ]
  if (sc.kind === 'after_meeting')
    return [
      `${hello} Спасибо еще раз за разговор. Как вам то, что обсудили?`,
      `${hello} Пишу по итогам нашего созвона: остались вопросы или переходим к следующему шагу?`,
    ]
  if (sc.kind === 'named_date')
    return [
      `${hello} Вы хотели вернуться к заказу примерно в эти дни. Как у вас, получилось посмотреть?`,
      `${hello} Пишу, как договаривались: удалось посмотреть? Если нужно еще время, просто скажите`,
    ]
  return null
}

/**
 * The ready text of a ping when the Pinger gave none that passed the checks: about what we wait for, the call that
 * was held or the day the client named; for the rest old Sara's texts (`reminderFallback`). It holds no news and no
 * fact, so nothing in it needs a source.
 */
export function pingFallback(
  clientName: string | null,
  sc: PingScenario | null,
  tone: ReminderTone,
  variant: 0 | 1 = 0,
): string {
  const first = clientName ? firstName(clientName) : null
  const own = sc ? scenarioTexts(first ? `${first}, добрый день!` : 'Добрый день!', sc) : null
  return own ? own[variant] : reminderFallback(clientName, tone, variant)
}
