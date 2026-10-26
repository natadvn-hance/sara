import type { ChatAuthor, Tone } from '@sara/shared'

/** Texts of the conversation module for Boris (NFR-UX-1: plain Russian, no long dash). */

export const TONE_RU: Record<Tone, string> = {
  neutral: 'спокойный',
  joke: 'шутка',
  irritation: 'раздражение',
  hurry: 'спешка',
  doubt: 'сомнение',
  compliment: 'комплимент',
  rudeness: 'грубость',
  bargaining: 'торг',
}

export const AUTHOR_RU: Record<ChatAuthor, string> = {
  client: 'клиент',
  boris: 'ты',
  sara: 'я',
  sara_v1: 'Сара v1',
  system: 'Профи.ру',
  unknown: 'Сара v1 или ты',
}

const quote = (s: string, max = 400) => {
  const t = s.trim()
  return `«${t.length > max ? `${t.slice(0, max - 1)}…` : t}»`
}

/** Words from outside (a client's, Boris's, the page's) may hold a long dash; Boris reads a short hyphen (NFR-UX-1). */
const hyphenated = (s: string) => s.replace(/[\u2014\u2013]/g, '-')

export type CardView = {
  name: string | null
  orderTitle: string | null
  clientWords: string
  text: string | null
  decision: string | null
  reason: string | null
  /** Shadow: old Sara still writes, nothing went to the client. */
  shadow: boolean
  tone: Tone | null
  factIds: string[]
  examples: number
  /** The case of Hance the reply tells and why it was chosen (Boris reads it under «Почему так»). */
  caseUsed: { title: string; why: string | null } | null
  /** The turn calls Boris (or would, in shadow): its text is a draft for him, not Sara's reply. */
  callsBoris: boolean
  /** What the code checks found in the text, for Boris to read beside a draft meant for him. */
  issues: string[]
}

/** «Кейс: <название>, потому что <причина>.» */
const caseLine = (c: NonNullable<CardView['caseUsed']>) => {
  const why = c.why?.trim().replace(/[.\s]+$/, '')
  return `Кейс: ${c.title}${why ? `, потому что ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}.`
}

const who = (v: CardView) =>
  [v.name ?? 'Клиент', v.orderTitle ? `заказ «${v.orderTitle}»` : null].filter(Boolean).join(', ')

/** What Sara would have done herself, from the rules' decision reason. */
const wouldRu = (v: CardView) => {
  const reason = (v.reason ?? '').replace(/^режим тени; сама бы: /, '')
  if (v.decision === 'call_boris') return `позвала бы тебя: ${reason}`
  if (v.shadow && reason) return reason
  return reason || 'прислала бы тебе черновик'
}

const REMINDERS_AFTER: Record<number, string> = {
  1: 'одного напоминания',
  2: 'двух напоминаний',
  3: 'трёх напоминаний',
}

const REMINDER_STEP_RU = {
  1: 'Первое напоминание',
  2: 'Второе напоминание',
  3: 'Третье напоминание, последнее',
} as const

export const CONV_TEXTS = {
  authorUnclear: (chatId: string) =>
    `⚠️ В чате заказа ${chatId} не понимаю, кто написал последние сообщения: клиент или наша сторона. Пока ничего не отвечаю, посмотри сам.`,

  /** The card of a turn (M4 design 5.12). */
  card(v: CardView): string {
    const head = v.decision === 'call_boris' ? `🔔 ${who(v)}: ${wouldRu(v)}` : `💬 ${who(v)}`
    const lines = [head, `Клиент: ${quote(v.clientWords)}`, '']
    if (v.text) {
      lines.push(
        v.callsBoris ? 'Черновик для тебя:' : v.shadow ? 'Ответила бы так:' : 'Черновик ответа:',
        v.text.trim(),
        '',
      )
      if (v.callsBoris && v.issues.length)
        lines.push(`В черновике не так: ${v.issues.join('; ')}.`, '')
    } else
      lines.push(
        v.decision === 'call_boris' ? 'Сама не отвечаю, это к тебе.' : 'Ответа не написала.',
        '',
      )
    const meta = [
      v.decision === 'call_boris'
        ? null
        : `${v.shadow ? 'Сама бы' : 'Почему черновик'}: ${wouldRu(v)}.`,
      v.tone ? `Тон: ${TONE_RU[v.tone]}.` : null,
    ].filter(Boolean)
    if (meta.length) lines.push(meta.join(' '))
    if (v.caseUsed) lines.push(caseLine(v.caseUsed))
    lines.push(
      `Опора: ${v.factIds.length ? v.factIds.join(', ') : 'нет записей разума'}. Образцов: ${v.examples}.`,
    )
    if (v.shadow) lines.push('Режим тени: клиенту ничего не ушло.')
    // A draft that failed the dash check is still shown to Boris, with a hyphen (NFR-UX-1).
    return hyphenated(lines.join('\n'))
  },

  /** What really went to the client, added to the shadow card. */
  compared: (atHhmm: string, author: ChatAuthor, text: string, similarity: number | null) =>
    hyphenated(
      `Ушло клиенту в ${atHhmm} (${AUTHOR_RU[author]}): ${quote(text, 300)}.${
        similarity === null ? '' : ` Сходство с моим: ${similarity}%.`
      }`,
    ),

  answeredYourself: 'Ты ответил сам, черновик не нужен.',

  /** The words of a client Boris leads, or of a closed conversation (FR-NOTIF-1, «Клиент написал»). */
  forward: (name: string | null, orderTitle: string | null, words: string, closed: boolean) =>
    hyphenated(
      `💬 ${[name ?? 'Клиент', orderTitle ? `заказ «${orderTitle}»` : null].filter(Boolean).join(', ')}${
        closed ? ' (разговор закрыт)' : ''
      } пишет: ${quote(words)}`,
    ),

  /** How a send that ran on its own ended, as a new message to Boris (the press was answered at once). */
  sendResult: (name: string | null, orderTitle: string | null, text: string) =>
    hyphenated(
      `${/^Отправила/.test(text) ? '✅' : '⚠️'} ${[name ?? 'Клиент', orderTitle ? `заказ «${orderTitle}»` : null].filter(Boolean).join(', ')}: ${text}`,
    ),

  /**
   * The task for Boris when a client is silent three days after the last reminder (FR-CONV-12, M4 design 5.11);
   * `sent` is how many reminders really went, which can be fewer than three (cards ignored, «Не надо», pauses).
   */
  dormant: (name: string | null, orderTitle: string | null, sent: number) => {
    const order = orderTitle ? `заказ «${orderTitle}»` : null
    const who = name
      ? [name, order].filter(Boolean).join(', ')
      : ['Клиент', order].filter(Boolean).join(', ')
    const first =
      sent > 0
        ? `${name ? `${who}: клиент` : who} молчит после ${REMINDERS_AFTER[sent] ?? `${sent} напоминаний`}.`
        : `${name ? `${who}: клиент` : who} молчит, а напоминания ему не уходили.`
    return hyphenated(
      [
        `😴 ${first}`,
        sent > 0
          ? 'Ответа нет уже три дня после последнего. Больше напоминать не буду.'
          : 'Больше напоминать не буду.',
        'Закрыть разговор?',
      ].join('\n'),
    )
  },

  /**
   * The card of a reminder in drafts mode: nothing goes to the client until Boris presses «Отправить» (FR-CONV-12).
   * `step` is the step of the ladder: the first, second or third (the last) reminder.
   */
  reminderCard: (v: {
    name: string | null
    orderTitle: string | null
    step: 1 | 2 | 3
    text: string
  }) =>
    hyphenated(
      [
        '⏰ Напомнить клиенту?',
        [v.name ?? 'Клиент', v.orderTitle ? `заказ «${v.orderTitle}»` : null]
          .filter(Boolean)
          .join(', '),
        `${REMINDER_STEP_RU[v.step]}: клиент не ответил на наше последнее сообщение.`,
        '',
        'Текст напоминания:',
        v.text.trim(),
        '',
        'Без твоего нажатия клиенту ничего не уйдёт.',
      ].join('\n'),
    ),

  buttons: {
    skip: 'Не надо',
    good: 'Хорошо',
    edit: 'Изменить',
    send: 'Отправить',
    take: 'Беру сам',
    close: 'Закрыть',
    giveBack: 'Вернуть Саре',
  },
}

/** What Boris is told when he answers the card of a reminder (FR-CONV-12). */
export const REMIND_TEXTS = {
  declined: 'Хорошо, это напоминание клиенту не отправляю.',
  gone: (why: string) => `Напоминание уже не нужно: ${why}. Клиенту ничего не отправила.`,
  notNow: (why: string) =>
    `Сейчас не могу отправить напоминание: ${why}. Нажми «Отправить» позже, карточка остаётся.`,
  stale: 'Клиент успел написать: напоминание не ушло. Посмотри чат.',
  sent: 'Отправила напоминание клиенту.',
  alreadyDone: 'Это напоминание уже обработано. Второй раз не отправляю.',
}
