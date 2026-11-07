import { and, asc, eq, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { chatMessage, conversation } from '../db/schema'
import { formalName } from '../leads/russianNames'

/**
 * The people and the ways to reach them, taken out of a chat by code (Boris, 03.11: «в карточке писались их контакты и
 * имена, и контакты в тг»): the real names of the people he talks to (the order may be for Anna and the talk with
 * Марина Сергеевна), their phones, Telegram and mail. Regular expressions only, no model: the card and the first
 * post of the topic show it, and it is never kept anywhere or written to the journal or to a prompt (ADR-016).
 */

export type Contacts = { names: string[]; phones: string[]; telegrams: string[]; emails: string[] }

/** Ours, never shown as a client's: the number and the Telegram of Boris. */
const OWN_PHONES = new Set(['79002781827'])
const OWN_TELEGRAMS = new Set(['bmnoian'])
/** Names of our own side. */
const OWN_NAMES = new Set(['борис', 'мноян', 'лора', 'сара'])

const PHONE =
  /(?<![\d])(?:\+?7|8)[\s\-.()]*\(?\d{3}\)?[\s\-.]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2}(?![\d])/gu
const TELEGRAM =
  /(?<![\w.])@([A-Za-z][A-Za-z0-9_]{4,31})\b|(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})/gu
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu
const FULL_NAME =
  /([А-ЯЁ][а-яё]{2,})\s+([А-ЯЁ][а-яё]{2,}(?:евн|овн|ичн|ьичн)(?:а|ы|е|у|ой)|[А-ЯЁ][а-яё]{2,}(?:ович|евич|ьич|ич)(?:а|у|ем|е)?)/gu
const CUE =
  /(?:меня зовут|зовут|это|я|набрать|наберите|наберет|наберёт|позвонить|позвоните|позвонит|передать|передайте|попросить|попросите|спросите|для|к|с)\s+([А-ЯЁ][а-яё]{2,})/gu

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const lc = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

/** A name in any case as the nominative of a known first name: «Марине» is «Марина»; null if it is none. */
export function firstNameIn(word: string): string | null {
  const w = lc(word)
  const ends: [string, string][] = [
    ['', ''],
    ['е', 'а'],
    ['е', 'я'],
    ['у', 'а'],
    ['ю', 'я'],
    ['ой', 'а'],
    ['ей', 'я'],
    ['ы', 'а'],
    ['и', 'я'],
    ['ю', 'й'],
    ['у', ''],
    ['а', ''],
    ['ом', ''],
    ['ем', 'й'],
    ['е', ''],
    ['ой', 'а'],
  ]
  for (const [from, to] of ends) {
    if (from && !w.endsWith(from)) continue
    const base = from ? w.slice(0, w.length - from.length) + to : w
    const known = formalName(base)
    if (known) return cap(known)
  }
  return null
}

/** «Сергеевне» is «Сергеевна», «Петровичу» is «Петрович». */
const patronymic = (w: string): string =>
  w
    .replace(/(евн|овн|ичн|ьичн)(?:а|ы|е|у|ой)$/u, '$1а')
    .replace(/(ович|евич|ьич|ич)(?:а|у|ем|е)$/u, '$1')

const digits = (s: string) => s.replace(/\D/g, '')

function phoneOf(raw: string): string | null {
  let d = digits(raw)
  if (d.length === 11 && (d.startsWith('8') || d.startsWith('7'))) d = `7${d.slice(1)}`
  else return null
  if (OWN_PHONES.has(d)) return null
  return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`
}

const uniq = <T>(xs: T[]) => [...new Map(xs.map((x) => [String(x).toLowerCase(), x])).values()]

/** The contacts of a talk; `skip` are names to leave out (the client's name on the order, as it is already shown). */
export function contactsFromChat(texts: string[], skip: string[] = []): Contacts {
  const all = texts.join('\n')
  const phones = uniq([...all.matchAll(PHONE)].flatMap((m) => phoneOf(m[0]) ?? []))
  const emails = uniq([...all.matchAll(EMAIL)].map((m) => m[0].toLowerCase()))
  const telegrams = uniq(
    [...all.matchAll(TELEGRAM)]
      .map((m) => m[1] ?? m[2] ?? '')
      .filter((h) => h && !OWN_TELEGRAMS.has(h.toLowerCase()))
      // The handle of a mail address is no Telegram.
      .filter(
        (h) =>
          !emails.some(
            (e) => e.startsWith(`${h.toLowerCase()}@`) || e.includes(`@${h.toLowerCase()}`),
          ),
      )
      .map((h) => `@${h}`),
  )
  const names: string[] = []
  for (const m of all.matchAll(FULL_NAME)) {
    const first = firstNameIn(m[1] ?? '')
    if (first) names.push(`${first} ${cap(patronymic(m[2] ?? ''))}`)
  }
  const full = new Set(names.map((n) => lc(n.split(' ')[0] ?? '')))
  for (const m of all.matchAll(CUE)) {
    const first = firstNameIn(m[1] ?? '')
    if (first && !full.has(lc(first))) names.push(first)
  }
  const skipped = new Set(skip.map(lc))
  const keep = uniq(names).filter((n) => {
    const f = lc(n.split(' ')[0] ?? '')
    return !OWN_NAMES.has(f) && !skipped.has(f)
  })
  return {
    names: keep.slice(0, 3),
    phones: phones.slice(0, 3),
    telegrams: telegrams.slice(0, 3),
    emails: emails.slice(0, 2),
  }
}

export const noContacts = (c: Contacts) =>
  c.names.length + c.phones.length + c.telegrams.length + c.emails.length === 0

/** One line for a card or a post: «Марина Сергеевна · +7 900 123-45-67 · @name». */
export function contactsLine(c: Contacts): string | null {
  const parts = [...c.names, ...c.phones, ...c.telegrams, ...c.emails]
  return parts.length ? parts.join(' · ') : null
}

/** The contacts of the talk of an order or a conversation, read from the stored chat. */
export async function contactsOf(
  db: DbOrTx,
  key: { conversationId?: string | null; orderId?: string | null },
  skip: string[] = [],
): Promise<Contacts> {
  let id = key.conversationId ?? null
  if (!id && key.orderId) {
    const [c] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.orderId, key.orderId))
    id = c?.id ?? null
  }
  if (!id) return { names: [], phones: [], telegrams: [], emails: [] }
  const rows = await db
    .select({ text: chatMessage.text })
    .from(chatMessage)
    .where(and(eq(chatMessage.conversationId, id), ne(chatMessage.side, 'system')))
    .orderBy(asc(chatMessage.sentAt))
  return contactsFromChat(
    rows.map((r) => r.text),
    skip,
  )
}
