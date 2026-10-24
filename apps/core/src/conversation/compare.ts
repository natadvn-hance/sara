import { normalizeText } from '@sara/shared'
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { convTurn } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { type CardDeps, redrawCard } from './cards'
import { CONV_TEXTS } from './texts'
import type { StoredMessage } from './types'

/** A shadow turn waits for the real reply this long (M4 design 5.12). */
const COMPARE_WINDOW_MS = 3 * 24 * 3600_000

const grams = (s: string): Set<string> => {
  const t = ` ${normalizeText(s).replace(/[^\p{L}\p{N} ]/gu, '')} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/** How alike two texts read, 0 to 100: shared three-letter pieces of the normalized texts (Jaccard). */
export function similarity(a: string, b: string): number {
  const x = grams(a)
  const y = grams(b)
  if (x.size === 0 && y.size === 0) return 100
  let both = 0
  for (const g of x) if (y.has(g)) both++
  return Math.round((100 * both) / (x.size + y.size - both))
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * Our side wrote in the chat: the latest finished shadow turn without a real reply gets it, its similarity and its
 * author (M4 design 5.12), and its card is edited without a sound. One comparison per turn.
 */
export async function compareTurn(
  d: CardDeps,
  conversationId: string,
  added: StoredMessage[],
): Promise<void> {
  const actual = added.find((m) => m.side === 'specialist')
  if (!actual) return
  const since = new Date(new Date(actual.sentAt).getTime() - COMPARE_WINDOW_MS).toISOString()
  const [t] = await d.db
    .select()
    .from(convTurn)
    .where(
      and(
        eq(convTurn.conversationId, conversationId),
        isNull(convTurn.actualMessageId),
        inArray(convTurn.outcome, ['drafted', 'called_boris']),
        gte(convTurn.createdAt, since),
      ),
    )
    .orderBy(desc(convTurn.createdAt))
    .limit(1)
  if (!t) return
  const score = t.text ? similarity(t.text, actual.text) : null
  const updated = await d.db
    .update(convTurn)
    .set({
      actualMessageId: actual.platformMessageId,
      actualAuthor: actual.author,
      similarity: score,
    })
    .where(and(eq(convTurn.id, t.id), isNull(convTurn.actualMessageId)))
    .returning()
  const row = updated[0]
  if (!row) return
  await appendEvent(d.db, {
    type: 'conv.compared',
    v: 1,
    entity: { kind: 'conv_turn', id: t.id },
    account_id: actual.accountId,
    actor: 'sara',
    occurred_at: new Date().toISOString(),
    causation_id: null,
    correlation_id: conversationId,
    reason: null,
    payload: {
      actual_message_id: actual.platformMessageId,
      author: actual.author,
      similarity: score,
    },
  })
  await redrawCard(
    d,
    row,
    CONV_TEXTS.compared(hhmm(actual.sentAt), actual.author, actual.text, score),
  )
}
