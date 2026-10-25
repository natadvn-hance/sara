import { normalizeText } from '@sara/shared'
import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { chatMessage, convTurn } from '../db/schema'
import { appendEvent } from '../journal/journal'
import { getSetting } from '../settings/store'
import { type CardDeps, redrawCard } from './cards'
import { storedOf } from './sync'
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

/** The real reply is this turn's: its author, its similarity, the event, and the card told without a sound. */
async function record(
  d: CardDeps,
  t: typeof convTurn.$inferSelect,
  actual: StoredMessage,
): Promise<void> {
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
    correlation_id: t.conversationId,
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

/**
 * In shadow our side may answer while the turn is still running: the event found the turn busy and skipped it. When
 * the turn is over, its own step takes the first message of our side after the client messages it answered that is
 * not Sara's own, and compares the draft with it (M4 design 5.9, 5.12). A turn that has a real reply keeps it.
 */
export async function compareAfterTurn(d: CardDeps, turnId: string): Promise<void> {
  if (!(await getSetting(d.db, 'conv.v1_writes'))) return
  const [t] = await d.db.select().from(convTurn).where(eq(convTurn.id, turnId))
  if (!t || t.actualMessageId !== null) return
  const covered = ((t.messageIds as string[] | null) ?? []).at(-1)
  if (!covered) return
  const rows = await d.db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.conversationId, t.conversationId))
    .orderBy(asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  const at = rows.findIndex((r) => r.platformMessageId === covered)
  if (at < 0) return
  const actual = rows
    .slice(at + 1)
    .map(storedOf)
    .find((m) => m.side === 'specialist' && m.author !== 'sara')
  if (actual) await record(d, t, actual)
}

/**
 * Our side wrote in the chat: the latest finished shadow turn without a real reply gets it, its similarity and its
 * author (M4 design 5.12), and its card is edited without a sound. One comparison per turn; a turn still running
 * is compared by its own step when it ends (`compareAfterTurn`).
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
  await record(d, t, actual)
}
