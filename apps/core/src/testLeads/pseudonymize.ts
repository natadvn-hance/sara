import { createHash } from 'node:crypto'
import type { RealCopy } from '@sara/profi-node/stand'
import { ClientInfo } from '@sara/shared'
import { z } from 'zod'
// The same finder of names, phones, mails and links the core hides from the model (ADR-016).
import { redact } from '../gateway/redact'

/** A real lead as the test orders copy it from `core.lead`. */
export const LeadRow = z.object({
  id: z.string().min(1),
  title: z.string(),
  category: z.string(),
  city: z.string(),
  text: z.string(),
  client_name: z.string(),
  budget_text: z.string().nullable(),
  bid_price_rub: z.number().int().nonnegative(),
  client_info: ClientInfo.nullable().optional(),
})
export type LeadRow = z.infer<typeof LeadRow>

const NAMES = [
  'Алина',
  'Вера',
  'Дарья',
  'Евгения',
  'Жанна',
  'Ксения',
  'Лилия',
  'Марина',
  'Нина',
  'Олеся',
  'Полина',
  'Римма',
  'Арсений',
  'Богдан',
  'Глеб',
  'Денис',
  'Егор',
  'Захар',
  'Игнат',
  'Кирилл',
  'Леонид',
  'Матвей',
  'Назар',
  'Роман',
]

/** The same lead always gets the same made-up name, so an import done again shows the same people. */
function pick(seed: string, n: number): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % n
}

const FAKE: Record<string, (n: number) => string> = {
  телефон: (n) => `+7 900 000-00-${String(n).padStart(2, '0')}`,
  почта: (n) => `client${n}@example.com`,
  ссылка: (n) => `example.com/${n}`,
}

/**
 * Takes the client's name, phones, mails, links and @-handles out of a real lead and puts made-up ones in their place.
 * The client's own name gets one made-up name everywhere; any other name `names` gives gets another.
 */
export function pseudonymize(row: LeadRow): RealCopy {
  const realName = row.client_name.trim()
  const start = pick(row.id, NAMES.length)
  const madeUp = (k: number) => NAMES[(start + k) % NAMES.length] as string
  const names = [realName, row.client_info?.name ?? null]
  const clean = (text: string): string => {
    const r = redact(text, names)
    let otherNames = 0
    const given = new Map<string, string>()
    return r.text.replace(
      /\[(телефон|почта|ссылка|имя) (\d+)\]/gu,
      (tag, kind: string, n: string) => {
        if (kind !== 'имя') return FAKE[kind]?.(Number(n)) ?? tag
        const value = r.tags.get(tag) ?? ''
        // A case form of the client's name (Ирины, Ирине) is still the client.
        const isClient =
          realName && value.toLowerCase().startsWith(realName.slice(0, 3).toLowerCase())
        if (isClient) return madeUp(0)
        const known = given.get(value)
        if (known) return known
        const other = madeUp(++otherNames)
        given.set(value, other)
        return other
      },
    )
  }
  return {
    title: clean(row.title),
    category: row.category,
    city: row.city,
    text: clean(row.text),
    client_name: realName ? madeUp(0) : '',
    budget_text: row.budget_text === null ? null : clean(row.budget_text),
    bid_price_rub: row.bid_price_rub,
    client_info: row.client_info
      ? {
          ...row.client_info,
          name: row.client_info.name ? madeUp(0) : null,
          review_tags: row.client_info.review_tags.map(clean),
        }
      : null,
  }
}
