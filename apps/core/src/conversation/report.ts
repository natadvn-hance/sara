import { and, asc, eq, gt, gte, ne } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, convTurn } from '../db/schema'
import { similarity } from './compare'
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

/** A text as the report quotes it: on one line, no long dash, not too long (NFR-UX-1). */
const shown = (s: string, max = 300) => {
  const t = s
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const STEP_ORDER = ['1', '2', '3', 'dormant']
const stepOf = (r: Row) =>
  String((r.understanding as { step?: number | string } | null)?.step ?? '')

/**
 * The reminders of the period (FR-CONV-12, design 5.11): how many, how they ended, and in shadow what Sara would
 * have sent beside what went to the client after it, since old Sara writes the reminders then.
 */
async function reminderLines(db: Db, rows: Row[]): Promise<string[]> {
  if (rows.length === 0) return ['Напоминания: нет.']
  const by = (outcome: string) => rows.filter((r) => r.outcome === outcome).length
  const steps = STEP_ORDER.flatMap((k) => {
    const n = rows.filter((r) => stepOf(r) === k).length
    return n > 0 ? [`${k === 'dormant' ? 'молчание после трёх' : `шаг ${k}`} ${n}`] : []
  })
  const lines = [
    `Напоминания: ${rows.length}: черновиков в тени ${by('drafted')}, карточек Борису, ждут ответа ${by('carded')}, отправлено ${by('sent')}, Борис сказал «не надо» ${by('declined')}, устарело ${by('expired') + by('answered')}, пропущено ${by('skipped')}, остановлено ${by('stopped')}, молчат после трёх напоминаний ${by('dormant')}.`,
    `По шагам: ${steps.join(', ')}.`,
  ]
  const drafts = rows
    .filter((r) => r.outcome === 'drafted' && r.text)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-10)
  if (drafts.length > 0) lines.push('Черновики напоминаний в тени:')
  for (const r of drafts) {
    const [next] = await db
      .select()
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, r.conversationId),
          eq(chatMessage.side, 'specialist'),
          ne(chatMessage.author, 'sara'),
          gt(chatMessage.sentAt, r.createdAt),
        ),
      )
      .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
      .limit(1)
    const after = next
      ? `Ушло потом (${AUTHOR_RU[next.author as keyof typeof AUTHOR_RU]}, сходство ${similarity(r.text ?? '', next.text)}%): «${shown(next.text)}».`
      : 'Ушло потом: пока ничего.'
    lines.push(`Шаг ${stepOf(r)}. Ответила бы: «${shown(r.text ?? '')}». ${after}`)
  }
  return lines
}

/** `pnpm report:conv --days 7`: what the shadow turns did (FR-OPS-4). */
export async function convReport(db: Db, days: number, now = new Date()): Promise<string> {
  const since = new Date(now.getTime() - days * 24 * 3600_000).toISOString()
  const all = await db.select().from(convTurn).where(gte(convTurn.createdAt, since))
  // A reminder is not the answer to a client turn: it has its own lines below.
  const rows = all.filter((r) => r.kind === 'reply')
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
    ...(await reminderLines(
      db,
      all.filter((r) => r.kind === 'reminder'),
    )),
  ].join('\n')
}
