import { plural } from '@sara/shared'

const cut = (s: string | null, max = 200) =>
  !s ? '' : s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

export type BatchLine = {
  i: number
  topic: string | null
  clientText: string | null
  before: string | null
  after: string | null
  insight: string
  state: string
}

/** The autonomy topics (M4) as Boris says them. */
export const TOPIC_WORDS: Record<string, string> = {
  price: 'Цена',
  contract: 'Договор',
  discount: 'Скидки',
  nda: 'NDA',
  call: 'Созвон',
  process: 'Порядок работы',
  timeline: 'Сроки',
  cases: 'Кейсы',
  about: 'О Hance',
  smalltalk: 'Разговор',
  other: 'Другое',
}

const MARK: Record<string, string> = {
  yes: '✅ запомню',
  no: '✖️ не буду',
  skip: '➖ пропустила',
}

/** The school's words to Boris: Russian, plain, no long dash (NFR-UX-1). */
export const SCHOOL_TEXTS = {
  batchHead: (n: number) =>
    `📚 Уроки из работы: ${n}\nОтметь каждый: да (запомню), нет (спрошу почему), не важно.`,
  batchLine(l: BatchLine): string {
    const lines = [
      `${l.i}. ${l.topic ? `${TOPIC_WORDS[l.topic] ?? l.topic}. ` : ''}${cut(l.clientText, 120)}`.trim(),
      l.before ? `Я: «${cut(l.before)}»` : null,
      l.after ? `Ты: «${cut(l.after)}»` : null,
      `Вывод: ${cut(l.insight, 240) || 'без вывода, посмотри сам'}`,
      MARK[l.state] ?? null,
    ]
    return lines.filter((x): x is string => !!x).join('\n')
  },
  yesButton: (i: number) => `${i}: да`,
  noButton: 'нет',
  skipButton: 'не важно',
  allButton: 'Все да',
  undoButton: 'Отменить',
  written: (n: number) => `Записала в разум ${n} ${plural(n, ['урок', 'урока', 'уроков'])}.`,
  refused: (i: number, why: string) => `Урок ${i} не записала: ${why}.`,
  writeWaits: 'Записать в разум пока не вышло, запишу позже.',
  nothingToWrite: 'В разум ничего не записываю.',
  rolledOver: 'Остальное перенесла в новую пачку.',
  whyLesson: (i: number) =>
    `Урок ${i}: почему нет? Ответь на это сообщение текстом или голосом, учту в следующий раз.`,
  decided: 'Отметила',
  reverted: 'Откатила эту запись в разуме.',
  revertConflict: (detail: string) => `Не откатила: ${detail}`,
  revertFailed: 'Не вышло откатить, попробую объяснить разработке.',
  historyCard: (bulk: 'examples' | 'scenarios', n: number) =>
    bulk === 'examples'
      ? `📚 Нашла ${n} ${plural(n, ['твоё сообщение', 'твоих сообщения', 'твоих сообщений'])} в чатах Профи.ру. Сделать их образцами речи?`
      : `📚 Нашла ${n} ${plural(n, ['сценарий', 'сценария', 'сценариев'])} экзамена в истории чатов Профи.ру. Принять их?`,
  allYesButton: 'Да, все',
  byFiveButton: 'Посмотреть по 5',
  notNowButton: 'Не сейчас',
  historyLater: 'Хорошо, спрошу через неделю',
  historyByFive: (n: number) => `Пришлю их пачками по 5, всего ${n}`,
  historyWritten: (n: number) => `Записала в разум: ${n}`,
  historyInsight: (bulk: 'examples' | 'scenarios') =>
    bulk === 'examples' ? 'Твоё сообщение из истории Профи.ру' : 'Сценарий экзамена из истории',
}
