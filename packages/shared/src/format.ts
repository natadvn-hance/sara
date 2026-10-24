const NBSP = ' '

export function formatRub(n: number): string {
  const digits = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${digits}${NBSP}₽`
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
