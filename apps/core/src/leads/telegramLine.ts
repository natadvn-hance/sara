/**
 * The last message of the series (Boris, 31.10.2026: «пускай Сара отправляет мой тг ещё одним сообщением вдогонку»):
 * his Telegram in his words (his samples have «Давайте в тг @bmnoian»). The nick is the setting `series.telegram`;
 * an empty one turns the message off.
 */

/** The message for a nick like «@bmnoian»; null when there is none. */
export function telegramLineOf(handle: string): string | null {
  const nick = handle.trim()
  return nick === '' ? null : `Если удобнее, пишите в тг ${nick})`
}

/** Whether a text of the series is that message, whatever the nick. */
export const isTelegramLine = (text: string): boolean =>
  /^Если удобнее, пишите в тг @\S+\)$/.test(text.trim())
