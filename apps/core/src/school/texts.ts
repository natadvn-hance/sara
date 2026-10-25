import { plural } from '@sara/shared'

const cut = (s: string | null, max = 200) =>
  !s ? '' : s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

export type BatchLine = {
  i: number
  topic: string | null
  clientText: string | null
  before: string | null
  after: string | null
  /** Whose words «after» is: Boris's edit, his message from history, a scenario, a record of the starting mind. */
  afterLabel: string
  insight: string
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
  moved: '↪️ в следующей пачке',
}

/** The school's words to Boris: Russian, plain, no long dash (NFR-UX-1). */
export const SCHOOL_TEXTS = {
  batchHead: (n: number) =>
    `📚 Уроки из работы: ${n}\nОтметь каждый: да (запомню), нет (спрошу почему), не важно.`,
  /** One lesson of a batch; `scale` shortens every text alike, so five long lessons still fit one message. */
  batchLine(l: BatchLine, scale = 1): string {
    const max = (n: number) => Math.max(40, Math.floor(n * scale))
    const lines = [
      `${l.i}. ${l.topic ? `${TOPIC_WORDS[l.topic] ?? l.topic}. ` : ''}${cut(l.clientText, max(120))}`.trim(),
      l.before ? `Я: «${cut(l.before, max(200))}»` : null,
      l.after ? `${l.afterLabel}: «${cut(l.after, max(200))}»` : null,
      `Вывод: ${cut(l.insight, max(240)) || 'без вывода, посмотри сам'}`,
    ]
    return lines.filter((x): x is string => !!x).join('\n')
  },
  mark: (state: string): string | null => MARK[state] ?? null,
  afterLabel: (source: string, kind: string): string =>
    source === 'history'
      ? kind === 'voice'
        ? 'Твоё сообщение'
        : 'Сценарий'
      : source === 'import'
        ? 'Запись'
        : 'Ты',
  yesButton: (i: number) => `${i}: да`,
  noButton: 'нет',
  skipButton: 'не важно',
  allButton: 'Все да',
  undoButton: 'Отменить',
  written: (n: number) => `Записала в разум ${n} ${plural(n, ['урок', 'урока', 'уроков'])}.`,
  refused: (i: number, why: string) => `Урок ${i} не записала: ${cut(why, 60)}.`,
  writeWaits: 'Записать в разум пока не вышло, запишу позже.',
  willWrite: 'Записываю в разум, итог напишу здесь.',
  nothingToWrite: 'В разум ничего не записываю.',
  whyLesson: (i: number) =>
    `Урок ${i}: почему нет? Ответь на это сообщение текстом или голосом, учту в следующий раз.`,
  decided: 'Отметила',
  reverting: 'Откатываю, итог напишу под пачкой.',
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
  historyWriting: (n: number) => `Записываю в разум: ${n}, итог напишу на карточке.`,
  historyWritten: (n: number) => `Записала в разум: ${n}`,
  historyInsight: (bulk: 'examples' | 'scenarios') =>
    bulk === 'examples' ? 'Твоё сообщение из истории Профи.ру' : 'Сценарий экзамена из истории',
}
