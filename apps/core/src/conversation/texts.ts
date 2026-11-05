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

/** The text as Telegram HTML: <, > and & become entities. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The first sentence of a reason, for the one line Boris reads, and what is left of it for the fold. */
const firstSentence = (r: string): [string, string] => {
  const t = r.trim()
  const m = /^(.+?[.!?])(\s+|$)/su.exec(t)
  const first = (m?.[1] ?? t).replace(/[.\s]+$/, '')
  const cut = first.length > 140 ? `${first.slice(0, 139)}…` : first
  return [cut, m ? t.slice(m[0].length).trim() : '']
}

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
  /** A client waits for Boris's answer (Boris, 31.10): in his topic, with the draft's buttons when there is a draft. */
  owedReminder: (v: {
    name: string | null
    waited: string
    words: string
    draft: string | null
    canAnswer: boolean
  }) => {
    const e = (x: string) => esc(hyphenated(x))
    const words = v.words.trim()
    return [
      `⏰ <b>${e(v.name ?? 'Клиент')}</b> ждёт ответа ${v.waited}`,
      words
        ? `<blockquote>${e(words.length > 300 ? `${words.slice(0, 299)}…` : words)}</blockquote>`
        : null,
      v.draft
        ? `<b>✍️ Ответ Сары:</b>\n<blockquote>${e(v.draft.trim())}</blockquote>`
        : e(
            v.canAnswer
              ? 'Ответ ждёт твоего «Отправить».'
              : 'Ответа Сары нет: напиши клиенту сам или нажми «Беру сам».',
          ),
    ]
      .filter(Boolean)
      .join('\n')
  },

  /** One list of the clients who wait, to the general topic (daily, and after a deploy). */
  owedSummary: (
    list: { name: string | null; order: string | null; waited: string; link: string | null }[],
  ) => {
    const e = (x: string) => esc(hyphenated(x))
    const rows = list.map((c) => {
      const who = e(c.name ?? 'Клиент')
      const head = c.link ? `<a href="${c.link}">${who}</a>` : who
      return `• ${head}${c.order ? `, заказ «${e(c.order)}»` : ''}: ждёт ${c.waited}`
    })
    return [`⏰ <b>Ждут твоего ответа: ${list.length}</b>`, ...rows].join('\n')
  },

  authorUnclear: (chatId: string) =>
    `⚠️ В чате заказа ${chatId} не понимаю, кто написал последние сообщения: клиент или наша сторона. Пока ничего не отвечаю, посмотри сам.`,

  /**
   * The card of a turn (M4 design 5.12) in Telegram HTML: a short head, the draft as a quote under «Ответ Сары», one
   * human line of why, and the rest (tone, case, what the checks found) in a quote that folds. The client's words are
   * not repeated: they came a moment before as their own message (Boris, 31.10). In the client's topic the order is
   * in the topic's name, so the head is only the name.
   */
  card(v: CardView, o: { inTopic?: boolean } = {}): string {
    const call = v.decision === 'call_boris'
    const e = (x: string) => esc(hyphenated(x))
    const head = o.inTopic ? e(v.name ?? 'Клиент') : e(who(v))
    const lines = [call ? `🔔 <b>${head}</b>: ${e(wouldRu(v))}` : `💬 <b>${head}</b>`]
    if (v.text) {
      const label = v.callsBoris
        ? 'Черновик для тебя:'
        : v.shadow
          ? 'Ответила бы так:'
          : '✍️ Ответ Сары:'
      lines.push('', `<b>${label}</b>`, `<blockquote>${e(v.text.trim())}</blockquote>`)
    } else lines.push('', e(call ? 'Сама не отвечаю, это к тебе.' : 'Ответа не написала.'))
    const more: string[] = []
    if (!call) {
      const [short, rest] = firstSentence(wouldRu(v))
      lines.push(`${v.shadow ? 'Сама бы' : 'Почему черновик'}: ${e(short)}.`)
      if (rest) more.push(rest)
    }
    if (v.callsBoris && v.text && v.issues.length)
      more.push(`В черновике не так: ${v.issues.join('; ')}.`)
    if (v.tone && v.tone !== 'neutral') more.push(`Тон: ${TONE_RU[v.tone]}.`)
    if (v.caseUsed) more.push(caseLine(v.caseUsed))
    if (more.length) lines.push(`<blockquote expandable>${e(more.join('\n'))}</blockquote>`)
    if (v.shadow) lines.push('Режим тени: клиенту ничего не ушло.')
    // A draft that failed the dash check is still shown to Boris, with a hyphen (NFR-UX-1).
    return lines.join('\n').replace(/(?<!\.)\.\.(?!\.)/g, '.')
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
  /** The card is closed because the reminder is no longer wanted (the next came, the client wrote). */
  notNeeded: 'Это напоминание уже не нужно.',
  /** A press at night: the reminder goes at the end of the quiet hours, as every reminder does. */
  held: (hour: number) => `Сейчас тихие часы: напоминание уйдёт в ${hour}:00 по Москве.`,
  declined: 'Хорошо, это напоминание клиенту не отправляю.',
  gone: (why: string) => `Напоминание уже не нужно: ${why}. Клиенту ничего не отправила.`,
  notNow: (why: string) =>
    `Сейчас не могу отправить напоминание: ${why}. Нажми «Отправить» позже, карточка остаётся.`,
  stale: 'Клиент успел написать: напоминание не ушло. Посмотри чат.',
  sent: 'Отправила напоминание клиенту.',
  alreadyDone: 'Это напоминание уже обработано. Второй раз не отправляю.',
}
