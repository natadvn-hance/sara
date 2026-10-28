import { formatRub, plural } from '@sara/shared'

/** Words and figures of the pult (design system, section 4): rubles «1 250 ₽», Moscow time «чт 15:30», no long dash. */

export const rub = (n: number | null | undefined): string =>
  n === null || n === undefined ? 'нет' : formatRub(n)

const MSK = 'Europe/Moscow'

export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: MSK,
  })
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: MSK,
  })
}

/** «сейчас», «4 мин назад», «2 ч назад», «вчера 14:02», «12 окт» */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'нет данных'
  const min = Math.round((now - Date.parse(iso)) / 60_000)
  if (min < 1) return 'сейчас'
  if (min < 60) return `${min} мин назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч назад`
  if (h < 48) return `вчера ${hhmm(iso)}`
  return new Date(iso)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: MSK })
    .replace(/\.$/, '')
}

/** How long a lead has waited: «ждёт 25 мин», «ждёт 3 ч». */
export function waited(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 60) return `ждёт ${min} мин`
  const h = Math.floor(min / 60)
  return `ждёт ${h} ч`
}

/** The color of the wait (M7 design 5.3): calm up to an hour, warn 1-4 hours, bad longer. */
export function waitTone(iso: string, now = Date.now()): 'ok' | 'warn' | 'bad' {
  const h = (now - Date.parse(iso)) / 3_600_000
  return h < 1 ? 'ok' : h < 4 ? 'warn' : 'bad'
}

export function count(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`
}

export const pct = (v: number | null): string =>
  v === null ? 'нет' : `${String(v).replace('.', ',')}%`

/** The first letter of a name for the round avatar. */
export const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

/** A CSV of a table, with a BOM so Excel reads Cyrillic. */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\n')}`
}
