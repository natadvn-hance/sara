import { dayMonth, stamp } from './topicPosts'

/**
 * The card of a meeting in the client's topic (Boris, 03.11: «сара сама не понимает когда была назначена встреча»):
 * the state, the day and time, how and who calls, and the words of the chat it stands on. Pinned and edited in place as
 * the meeting is booked, moved or cancelled. Telegram HTML, every value escaped, no long dash.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const hyphen = (s: string) => esc(s.replace(/[\u2014\u2013]/g, '-'))

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const HOW: Record<string, string> = {
  phone: 'по телефону',
  telegram: 'в Telegram',
  video: 'по видео',
}
const CALLER: Record<string, string> = { we: 'звоним мы', client: 'звонит клиент' }

export type MeetingCardView = {
  status: 'booked' | 'maybe' | 'cancelled' | 'held' | 'missed' | 'expired'
  /** The time of the call (ISO); none while it is only «maybe». */
  at: string | null
  how: string | null
  caller: string | null
  quote: string | null
  /** The time it was before, when the meeting was moved. */
  movedFrom?: string | null
  /** After the call: what came of it, the next step and its day. */
  result?: string | null
  nextStep?: string | null
  nextStepOn?: string | null
}

/** «Среда, 5 ноября, 15:30»: the day of the week and the date in Moscow. */
function dayAndTime(iso: string, now: Date): string {
  const when = stamp(iso, now)
  const weekday = WEEKDAYS[new Date(new Date(iso).getTime() + 3 * 3600_000).getUTCDay()] ?? ''
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${when}`
}

const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`

export function meetingCard(v: MeetingCardView, now: Date = new Date()): string {
  const head =
    v.status === 'booked'
      ? '📞 <b>Созвон назначен</b>'
      : v.status === 'held'
        ? '✅ <b>Встреча прошла</b>'
        : v.status === 'missed'
          ? '🚫 <b>Встреча не состоялась</b>'
          : v.status === 'expired'
            ? '⏳ <b>Время встречи прошло, итога нет</b>'
            : v.status === 'cancelled'
              ? v.at
                ? '🚫 <b>Созвон отменён</b>'
                : '🚫 <b>Договорённость о созвоне снята</b>'
              : '🤔 <b>Похоже, договорились о созвоне</b>'
  const how = [v.how ? HOW[v.how] : null, v.caller ? CALLER[v.caller] : null]
    .filter(Boolean)
    .join(' · ')
  return [
    head,
    v.at
      ? `<b>${hyphen(dayAndTime(v.at, now))}</b> · по Москве`
      : '<i>Твёрдого времени в переписке нет</i>',
    how ? hyphen(how) : null,
    v.quote?.trim() ? `<blockquote>${hyphen(v.quote.trim())}</blockquote>` : null,
    v.movedFrom ? `<i>Перенесено, было ${hyphen(lower(dayAndTime(v.movedFrom, now)))}</i>` : null,
    v.result?.trim() ? `<b>Итог:</b> ${hyphen(v.result.trim())}` : null,
    v.nextStep?.trim()
      ? `<b>Дальше:</b> ${hyphen(v.nextStep.trim())}${v.nextStepOn ? ` · до ${hyphen(dayMonth(v.nextStepOn, now))}` : ''}`
      : null,
  ]
    .filter(Boolean)
    .join('\n')
}
