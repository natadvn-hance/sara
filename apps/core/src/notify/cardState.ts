import { formatRub } from '@sara/shared'
import { type CloseReason, closedWhenText, type LeadCard, spanText, TEXTS } from './cards'

/**
 * Where a lead card stands (FR-NOTIF-6): one message per order that changes in place, from new to sent, closed or
 * skipped. The picture card is drawn from the order and this state.
 */

export const CARD_STAGES = [
  'new',
  'sending',
  'sent',
  'found',
  'unsure',
  'closed',
  'skipped',
  'stale',
  'done',
  'note',
] as const
export type CardStage = (typeof CARD_STAGES)[number]

export type CardState = {
  s: CardStage
  /** The bid's fee, written out («55 ₽»). */
  f?: string
  /** The clock of the state's moment in Moscow («14:05»). */
  t?: string
  /** The same moment in Unix seconds. */
  at?: number
  /** One plain note (how the series went, why the card closed). */
  n?: string
  /** The client's chat (his forum topic). */
  u?: string
}

const clock = (d: Date) =>
  d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })

/** A state read back from the database; anything else is the note state. */
export function asState(v: unknown): CardState {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<CardState>
  return (CARD_STAGES as readonly string[]).includes(o.s ?? '') ? (o as CardState) : { s: 'note' }
}

/** The card as Boris may press it: new, with the fee it shows now (a bid that did not go, a fee the site changed). */
export function newState(c: Pick<LeadCard, 'bidPriceRub'>): CardState {
  return { s: 'new', ...(c.bidPriceRub > 0 && { f: formatRub(c.bidPriceRub) }) }
}

/** The bid's news as a state (the same facts as `foldedBidCard`, cards.ts). */
export function foldedCardState(o: {
  state: 'sending' | 'sent' | 'found' | 'unsure'
  at?: string | null
  feeRub?: number | null
  chatUrl?: string | null
  note?: string | null
}): CardState {
  if (o.state === 'sending' || o.state === 'unsure') return { s: o.state }
  const at = o.at ? new Date(o.at) : null
  return {
    s: o.state,
    ...(o.feeRub && o.feeRub > 0 && { f: formatRub(o.feeRub) }),
    ...(at && { t: clock(at), at: Math.floor(at.getTime() / 1000) }),
    ...(o.chatUrl && { u: o.chatUrl }),
    ...(o.note && { n: o.note }),
  }
}

function reasonText(r: CloseReason | null | undefined): string | null {
  if (!r) return null
  if (!r.text) return r.by === 'guess' ? TEXTS.reasonUnknown : null
  return r.by === 'boris' ? TEXTS.reasonBoris(r.text) : TEXTS.reasonGuess(r.text)
}

/** The short card as a state: closed on Profi.ru, closed by Boris («Пропустить»), or gone stale (as cards.ts says it). */
export function closedCardState(c: LeadCard, now: Date = new Date()): CardState {
  const base = { t: clock(now), at: Math.floor(now.getTime() / 1000) }
  const reason = reasonText(c.closeReason)
  if (c.closedByBoris) return { s: 'skipped', ...base, ...(reason && { n: reason }) }
  if (c.stale) {
    const waited = TEXTS.staleWaited(spanText(Date.parse(c.stale.at) - Date.parse(c.stale.since)))
    return { s: 'stale', ...base, n: [waited, reason].filter(Boolean).join('. ') }
  }
  return { s: 'closed', ...base, ...(c.closed && { n: closedWhenText(c.closed) }) }
}
