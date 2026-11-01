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

/**
 * The range a bid gives in «Стоимость услуги» (Boris, 31.10.2026: «в отклике нужно указывать резонный диапазон, как у
 * старой Сары»): the Analyst's own «до», or half again over «от» when none came or it does not stand over «от».
 */
export function priceRange(
  fromRub: number,
  toRub: number | null | undefined,
): { from: number; to: number } {
  return { from: fromRub, to: toRub && toRub > fromRub ? toRub : priceUpTo(fromRub) }
}

const NUM = String.raw`\d{1,3}(?:[\s\u00a0]\d{3})+|\d+(?:[.,]\d+)?`
const THOUSAND = String.raw`(?:тыс(?:яч[а-я]*)?\.?|т\.?\s?р\.?|[кk])`

/**
 * A range as Boris or Sara write it: «30 000 - 60 000», «от 30 до 60 тыс.», «30-60к», or one price («45000»).
 * `to` is null for one price. null when no price stands in it. Thousands («тыс», «к») multiply a number under 1000.
 */
export function parsePriceRange(text: string): { from: number; to: number | null } | null {
  const t = text.toLowerCase()
  const thousands = new RegExp(THOUSAND, 'u').test(t)
  const nums = [...t.matchAll(new RegExp(NUM, 'gu'))].map((m) => {
    const n = Number(m[0].replace(/[\s\u00a0]/g, '').replace(',', '.'))
    return thousands && n < 1000 ? n * 1000 : n
  })
  const [a, b] = nums
  if (a === undefined || !Number.isFinite(a) || a <= 0) return null
  if (b === undefined || !Number.isFinite(b) || b <= 0) return { from: Math.round(a), to: null }
  const [from, to] = a <= b ? [a, b] : [b, a]
  return { from: Math.round(from), to: to > from ? Math.round(to) : null }
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
