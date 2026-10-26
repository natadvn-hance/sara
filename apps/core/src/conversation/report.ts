import { gte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { convTurn } from '../db/schema'
import { AUTHOR_RU } from './texts'

type Row = typeof convTurn.$inferSelect

const count = <T>(xs: T[], key: (x: T) => string | null | undefined) => {
  const m = new Map<string, number>()
  for (const x of xs) {
    const k = key(x)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
}

const listOf = (pairs: [string, number][]) =>
  pairs.length ? pairs.map(([k, n]) => `${k} ${n}`).join(', ') : 'нет'

/** The numbers of the shadow turns (M4 design 5.12), for a developer and for the evening summary. */
export function turnStats(rows: Row[]) {
  const compared = rows.filter((r) => r.actualMessageId !== null)
  const scored = compared.filter((r) => r.similarity !== null)
  const avg = scored.length
    ? Math.round(scored.reduce((s, r) => s + (r.similarity ?? 0), 0) / scored.length)
    : null
  return {
    turns: rows.length,
    drafted: rows.filter((r) => r.outcome === 'drafted').length,
    called: rows.filter((r) => r.outcome === 'called_boris').length,
    noReply: rows.filter((r) => r.outcome === 'no_reply').length,
    cancelled: rows.filter((r) => r.outcome === 'answered' || r.outcome === 'unclear').length,
    sent: rows.filter((r) => r.outcome === 'sent').length,
    failed: rows.filter((r) => r.outcome === 'failed').length,
    cards: rows.filter((r) => r.cardMessageId !== null).length,
    compared,
    avg,
  }
}

/** `pnpm report:conv --days 7`: what the shadow turns did (FR-OPS-4). */
export async function convReport(db: Db, days: number, now = new Date()): Promise<string> {
  const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString()
  const rows = await db.select().from(convTurn).where(gte(convTurn.createdAt, since))
  const s = turnStats(rows)
  const issues = rows.flatMap((r) =>
    ((r.checks as { issues?: { id: string }[] } | null)?.issues ?? []).map((i) => i.id),
  )
  const failures = rows.filter(
    (r) => (r.checks as { failure?: string | null } | null)?.failure,
  ).length
  const understanding = (r: Row) => r.understanding as { topic?: string; tone?: string } | null
  return [
    `Разговоры за ${days} дн.`,
    `Ходов: ${s.turns}: черновиков ${s.drafted}, позвала бы тебя ${s.called}, без ответа ${s.noReply}, отменено ${s.cancelled}, отправлено ${s.sent}, сбоев ${s.failed}.`,
    `Карточек: ${s.cards}.`,
    `Сравнений: ${s.compared.length} (${listOf(
      count(s.compared, (r) =>
        r.actualAuthor ? AUTHOR_RU[r.actualAuthor as keyof typeof AUTHOR_RU] : null,
      ),
    )}), среднее сходство ${s.avg === null ? 'нет' : `${s.avg}%`}.`,
    `Проверка не прошла: ${listOf(count(issues, (x) => x))}.`,
    `Темы: ${listOf(count(rows, (r) => understanding(r)?.topic))}.`,
    `Тоны: ${listOf(count(rows, (r) => understanding(r)?.tone))}.`,
    `Сбоев модели: ${failures}.`,
  ].join('\n')
}
