import { formatCallback, formatRub } from '@sara/shared'

export type LeadCard = {
  taskId: string
  title: string
  city: string
  verdict: 'fit' | 'maybe' | null
  reason: string | null
  bidPriceRub: number
  /** The Scorer's total by the rules of `version` (FR-LEAD-3); none when the order was not scored. */
  score?: { value: number; version: number; reason: string } | null
  /** The Scorer did not answer: the card comes anyway, marked. */
  unscored?: boolean
  /** The same card again as a reminder, with the buttons, so Boris can act on it. */
  reminder?: boolean
}

/** Every text Sara sends Boris in Telegram (Russian, plain, no long dash). */
export const TEXTS = {
  bound: 'Сара на связи',
  alreadyDone: 'Уже сделано',
  skipped: 'Пропущено',
  bidQueued: 'Отправляю отклик',
  bidsPaused: 'Отклик не ушёл: отправка откликов на паузе',
  bidFailed: 'Отклик не ушёл: площадка ответила ошибкой. Посмотри «Состояние системы».',
  bidUncertain:
    'Не знаю, ушёл ли отклик: площадка не ответила. Проверь заявку на Профи.ру, прежде чем откликаться вручную.',
  bidsPausedPress: 'Отправка откликов на паузе. Включи её и нажми снова.',
  bidSent: (title: string, priceRub: number) =>
    `✅ Отклик отправлен: ${title}, ${formatRub(priceRub)}`,
  sessionDead: (title: string, loginUrl: string) =>
    `🔴 Профи.ру разлогинил аккаунт ${title}. Пока ты не войдёшь, я ничего не вижу на этом аккаунте.\nВойти: ${loginUrl}`,
  banned: (title: string) =>
    `🚫 Профи.ру заблокировал профиль ${title}. Действия аккаунта остановлены.`,
  sessionAlive: (title: string) =>
    `🟢 Сессия ${title} снова живая. Сверяю, что пришло за время простоя.`,
  connectionLost: (sinceMsk: string) =>
    `🌐 Нет связи с Профи.ру с ${sinceMsk}. Пробую раз в 5 минут.`,
  connectionBack: '🌐 Связь с Профи.ру вернулась. Сверяю, что пришло.',
  reminder: (title: string) => `⏰ Заявка ждёт решения: ${title}`,
}

function verdictLine(c: LeadCard): string {
  if (c.verdict === 'fit') return `Подходит: ${c.reason ?? ''}`
  if (c.verdict === 'maybe') return `Возможно: ${c.reason ?? ''}`
  return 'Сортировщик не ответил, проверь сам'
}

export function leadCardText(c: LeadCard): string {
  const head = c.reminder
    ? `⏰ Заявка ждёт решения: ${c.title}, ${c.city}`
    : `🔔 Заявка · ${c.title}, ${c.city}`
  const why = c.score
    ? [`Балл ${c.score.value} (правила v${c.score.version}). ${c.score.reason}`]
    : [verdictLine(c), ...(c.unscored ? ['Без оценки: Оценщик не ответил'] : [])]
  return [head, ...why, `Отклик ${formatRub(c.bidPriceRub)}`].join('\n')
}

export function leadCardKeyboard(c: LeadCard) {
  return {
    inline_keyboard: [
      [
        {
          text: `Откликнуться за ${formatRub(c.bidPriceRub)}`,
          callback_data: formatCallback(c.taskId, 'bid'),
        },
        { text: 'Пропустить', callback_data: formatCallback(c.taskId, 'skip') },
      ],
    ],
  }
}
