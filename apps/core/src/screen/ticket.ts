import { randomBytes } from 'node:crypto'

/**
 * One-time tickets for the live screen's WebSocket (M7 design, section 7): a browser cannot put a header on a
 * WebSocket, so inside Telegram (no cookie there) the screen first asks for a ticket with its signed request and
 * connects with `?ticket=`. A ticket opens one account's screen once, within a minute.
 */
const TTL_MS = 60_000
const tickets = new Map<string, { accountId: string; expiresAt: number }>()

export function issueTicket(accountId: string, now = Date.now()): string {
  for (const [t, v] of tickets) if (v.expiresAt <= now) tickets.delete(t)
  const ticket = randomBytes(32).toString('hex')
  tickets.set(ticket, { accountId, expiresAt: now + TTL_MS })
  return ticket
}

export function useTicket(ticket: string | undefined, accountId: string, now = Date.now()): boolean {
  if (!ticket) return false
  const found = tickets.get(ticket)
  if (!found) return false
  tickets.delete(ticket)
  return found.accountId === accountId && found.expiresAt > now
}
