/** What a stopped or failed check says, by the reason the core gave (recompute and calibration alike). */
export const STOPPED: Record<string, string> = {
  limit: 'Подожди, лимит Claude кончился. Попробуй позже.',
  not_connected: 'Claude не подключён: вставь токен в мастере настройки.',
}
export const FAILED: Record<string, string> = {
  nothing_scored:
    'Не получилось оценить ни одной заявки. Проверь, что Claude подключён, и попробуй ещё раз.',
  stale: 'Проверка зависла и закрыта. Запусти заново.',
}
export const stoppedText = (reason: string | null) =>
  STOPPED[reason ?? ''] ?? 'Проверка остановлена. Попробуй ещё раз.'
export const failedText = (reason: string | null) =>
  FAILED[reason ?? ''] ?? 'Проверка сломалась. Попробуй ещё раз.'
export const pct = (x: number) => `${Math.round(x * 100)}%`
