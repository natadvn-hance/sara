import { type AuthorBasis, type ChatAuthor, type MessageSide, normalizeText } from '@sara/shared'
import type { V1Lead } from './v1Snapshot'

/** What is known about one chat when its specialist messages are told apart (M4 design 5.1, ADR-024). */
export type AttributionContext = {
  /** When v1 began writing (its earliest lead); null: no snapshot. */
  v1StartedAt: string | null
  /** Old Sara's record of the chat's order; null: v1 never had it. */
  lead: V1Lead | null
  /** Normalized texts v1 sent to clients, from Boris's Telegram export. */
  v1Texts: Set<string>
  /** Normalized texts Boris had old Sara send as they are, from the same export («Отправила клиенту твой текст»). */
  borisTexts?: Set<string>
  /** Messages the new Sara sent into this chat; `author: 'boris'` is a text he dictated. */
  ourOutbox: { text: string; at: string; author?: 'sara' | 'boris' }[]
  v1Writes: boolean
  /** When old Sara stopped writing (conv.v1_writes turned off); null: not known, so the switch proves nothing. */
  v1StoppedAt?: string | null
  /** The bid the new Sara sent for the chat's order (a confirmed bid in the outbox). */
  ourBid?: string | null
}

/**
 * One chat message. `approxTime`: its time is the moment it was read, not sent, so no rule goes by its time.
 * `inBid`: a specialist message before any client message of the chat, where the platform shows the bid.
 */
export type HistoryMessage = {
  side: MessageSide
  text: string
  sentAt: string
  approxTime?: boolean
  inBid?: boolean
}

/** Ready-made texts v1 sent as they are (daemon.js and followUpTemplates.js, the client's name left out). */
export const V1_TEMPLATES: string[] = [
  'Да, давайте созвонимся. Во сколько вам удобно?',
  'Здравствуйте. Если вопрос ещё открыт, пишите в любой момент: помогу разобраться, с чего начать. Хорошего дня!',
  'Здравствуйте. Если задача ещё актуальна, давайте обсудим детали: подскажу, с чего начать. Удобно созвониться на 15 минут?',
  // Only the start: the meeting time follows.
  'Отлично, договорились! Встреча:',
]

/** v1's text for a bubble with no words of its own (checkReply.js cleanMessageText): nobody's words. */
export const V1_ATTACHMENT = '[вложение без текста]'

const OUTBOX_WINDOW_MS = 10 * 60_000
/** v1 kept only the last 1000 characters of Boris's words, so the oldest of them may begin mid-sentence. */
const BORIS_TEXT_LIMIT = 1000
/** The shortest cut-off start of his words that still proves a message. */
const MIN_CUT_PROOF = 15

// A prefix keeps its colon (normalizeText drops it at the end), so «Встреча:» never matches «Встречаемся».
const TEMPLATES = V1_TEMPLATES.map((t) => ({
  text: t.endsWith(':') ? `${normalizeText(t)}:` : normalizeText(t),
  prefix: t.endsWith(':'),
  greeting: t.startsWith('Здравствуйте'),
}))

function isTemplate(norm: string): boolean {
  return TEMPLATES.some(({ text, prefix, greeting }) => {
    if (prefix) return norm.startsWith(text)
    if (norm === text) return true
    // v1 put the client's first name before its greeting templates: «Ирина, здравствуйте. …».
    return (
      greeting && norm.endsWith(text) && /^\p{L}[\p{L}-]*, $/u.test(norm.slice(0, -text.length))
    )
  })
}

type BorisWords = { runs: Set<string>; heads: string[] }
const borisWordsCache = new WeakMap<V1Lead, BorisWords>()

/**
 * Boris's messages inside `boris_wrote_text`: every run of whole paragraphs (v1 joined his messages with a blank
 * line, and one message may hold several paragraphs), and, when v1 cut the text, the runs from its cut start.
 */
function borisWords(lead: V1Lead): BorisWords {
  const known = borisWordsCache.get(lead)
  if (known) return known
  const raw = lead.borisWroteText ?? ''
  const paras = raw.split(/\n\s*\n/).filter((p) => p.trim() !== '' && p.trim() !== V1_ATTACHMENT)
  const runs = new Set<string>()
  const heads: string[] = []
  for (let i = 0; i < paras.length; i++) {
    for (let j = i; j < paras.length; j++) {
      const run = normalizeText(paras.slice(i, j + 1).join('\n\n'))
      if (run !== '') runs.add(run)
      if (i === 0 && raw.length >= BORIS_TEXT_LIMIT && run.length >= MIN_CUT_PROOF) heads.push(run)
    }
  }
  const words = { runs, heads }
  borisWordsCache.set(lead, words)
  return words
}

const same = (norm: string, other: string | null | undefined) =>
  other !== null && other !== undefined && normalizeText(other) === norm

/**
 * Whose voice a message is. A specialist message is Boris's or old Sara's only with proof; without it, while v1
 * still writes from the same account, it stays unknown (ADR-024). The checks go in the order of design 5.1: our
 * outbox, Boris's proofs, v1's proofs, the switch, unknown.
 */
export function attribute(
  m: HistoryMessage,
  c: AttributionContext,
): { author: ChatAuthor; basis: AuthorBasis } {
  if (m.side !== 'specialist') return { author: m.side, basis: 'side' }
  const norm = m.text.trim() === V1_ATTACHMENT ? '' : normalizeText(m.text)
  const sent = Date.parse(m.sentAt)
  const lead = c.lead

  if (norm !== '') {
    for (const o of c.ourOutbox) {
      if (normalizeText(o.text) !== norm) continue
      const gap = sent - Date.parse(o.at)
      // A message read in a first reading carries the reading time, which is only ever later than the send.
      if (m.approxTime ? gap >= -OUTBOX_WINDOW_MS : Math.abs(gap) <= OUTBOX_WINDOW_MS)
        return o.author === 'boris'
          ? { author: 'boris', basis: 'say' }
          : { author: 'sara', basis: 'outbox' }
    }
    if (m.inBid && c.ourBid && (same(norm, c.ourBid) || norm.startsWith('стоимость')))
      return { author: 'sara', basis: 'outbox' }
  }

  if (!m.approxTime && c.v1StartedAt && sent < Date.parse(c.v1StartedAt))
    return { author: 'boris', basis: 'before_v1' }

  // Boris's proofs and old Sara's are weighed together: v1 kept its own sent reply among Boris's words when its
  // mark lagged (checkReply.js), so a text that proves both proves neither (M4 design 5.1, ADR-024).
  const boris = borisProof(m, norm, sent, c)
  const v1 = v1Proof(m, norm, c)
  if (boris && v1) return { author: 'unknown', basis: 'v1_or_boris' }
  if (boris) return { author: 'boris', basis: boris }
  if (v1) return { author: 'sara_v1', basis: v1 }

  // After the switch a message from our side that is not ours is Boris's, if it was sent after the switch.
  if (!c.v1Writes && c.v1StoppedAt && !m.approxTime && sent > Date.parse(c.v1StoppedAt))
    return { author: 'boris', basis: 'after_cutover' }
  return { author: 'unknown', basis: 'v1_or_boris' }
}

function borisProof(
  m: HistoryMessage,
  norm: string,
  sent: number,
  c: AttributionContext,
): AuthorBasis | null {
  const lead = c.lead
  if (norm !== '') {
    if (lead) {
      const words = borisWords(lead)
      if (words.runs.has(norm) || words.heads.some((h) => norm.endsWith(h))) return 'v1_boris_text'
      if (same(norm, lead.dictatedReply)) return 'v1_dictated'
    }
    if (c.borisTexts?.has(norm)) return 'v1_dictated'
  }
  if (!m.approxTime && lead?.takenByBorisAt && sent > Date.parse(lead.takenByBorisAt))
    return 'v1_taken'
  return null
}

function v1Proof(m: HistoryMessage, norm: string, c: AttributionContext): AuthorBasis | null {
  if (norm === '') return null
  const lead = c.lead
  if (lead?.respondedAt && lead.draftResponse) {
    const bid = same(norm, lead.draftResponse) || (m.inBid === true && norm.startsWith('стоимость'))
    if (bid) {
      const edited =
        lead.draftResponseOriginal !== null &&
        normalizeText(lead.draftResponseOriginal) !== normalizeText(lead.draftResponse)
      return edited ? 'v1_bid_edited' : 'v1_bid'
    }
  }
  if (same(norm, lead?.proposedReply)) return 'v1_proposed'
  if (isTemplate(norm)) return 'v1_template'
  if (c.v1Texts.has(norm)) return 'telegram_export'
  return null
}
