const NBSP = ' '

export function formatRub(n: number): string {
  const digits = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${digits}${NBSP}₽`
}
