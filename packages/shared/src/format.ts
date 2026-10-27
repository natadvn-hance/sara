const NBSP = ' '

export function formatRub(n: number): string {
  const digits = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${digits}${NBSP}₽`
}

/**
 * The top of the price range a bid gives in «Стоимость услуги» (Boris, 27.10.2026: «как старая Сара, закономерный
 * диапазон»): half again over «от», rounded up to a thousand, and always at least a thousand over it.
 */
export function priceUpTo(fromRub: number): number {
  return Math.max(fromRub + 1000, Math.ceil((fromRub * 1.5) / 1000) * 1000)
}

/** The Russian word for n things: forms for 1, 2-4 and 5 (1 решение, 2 решения, 5 решений; 11-14 решений). */
export function plural(
  n: number,
  forms: readonly [one: string, few: string, many: string],
): string {
  const ten = Math.abs(n) % 10
  const hundred = Math.abs(n) % 100
  if (hundred >= 11 && hundred <= 14) return forms[2]
  if (ten === 1) return forms[0]
  if (ten >= 2 && ten <= 4) return forms[1]
  return forms[2]
}

/**
 * A message as people read it, for telling the same words apart from different ones (M4 design 5.1): lower case,
 * ё as е, long and medium dashes as a hyphen, every run of spaces and line breaks as one space, quotes and the
 * punctuation at the ends dropped.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[«»"„“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,!?;:()]+|[\s.,!?;:()]+$/g, '')
}
