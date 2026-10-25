import { createHash } from 'node:crypto'
import { type ConvStage, type MindFrontmatter, normalizeText } from '@sara/shared'
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { chatMessage, lead } from '../db/schema'
import { redact } from '../gateway/redact'
import { proposeMind } from '../mind/proposals'
import { V1_ATTACHMENT } from './attribution'

type Row = {
  chatId: string
  orderId: string | null
  platformMessageId: string
  side: string
  author: string
  text: string
  source: string
}

const NO_CLIENT_YET = 'Клиент ещё ничего не написал.'
const UNKNOWN_TURN = 'Неизвестно, что клиент написал перед этим: сообщение из базы старой Сары.'

const moscowDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d)

/** The C6 fields as YAML; every value is a plain word, a date or a JSON-quoted string. */
function frontmatter(f: MindFrontmatter): string {
  const lines = [
    `id: ${f.id}`,
    `type: ${f.type}`,
    `scope: ${f.scope}`,
    `status: ${f.status}`,
    `version: ${f.version}`,
    'sources:',
    ...f.sources.map((s) => `  - ${JSON.stringify(s)}`),
    `valid_from: ${f.valid_from}`,
    `valid_to: ${f.valid_to ?? 'null'}`,
  ]
  if (f.stages?.length) lines.push('stages:', ...f.stages.map((s) => `  - ${s}`))
  return `---\n${lines.join('\n')}\n---\n`
}

/**
 * The client's turn Boris answered: the client messages before his, past any specialist or system message in
 * between (v1 may have answered first, or he wrote twice). Null when the client had not written yet.
 */
function clientTurn(rows: Row[], i: number): string[] | null {
  let j = i - 1
  while (j >= 0 && rows[j]?.side !== 'client') j--
  if (j < 0) return null
  const turn: string[] = []
  for (; j >= 0; j--) {
    const r = rows[j]
    if (r?.side === 'client') turn.unshift(r.text.trim())
    else if (r?.side !== 'system') break
  }
  return turn
}

/**
 * Boris's past messages become speech example proposals (FR-SPEECH-2, FR-MIND-3): each of his messages longer
 * than `minLength`, with the client's turn before it, made impersonal (the client's name, phones, e-mails, links
 * and handles become tags). They wait in `core.mind_proposal` for his «да»; a repeated run adds nothing.
 * `clientNames`: names by order known outside the core, from the v1 snapshot.
 */
export async function proposeSpeechExamples(
  db: Db,
  o: { accountId: string; minLength?: number; clientNames?: Map<string, string> },
): Promise<{ proposed: number; skipped: number }> {
  const minLength = o.minLength ?? 15
  const names = new Map<string, string[]>()
  const addName = (orderId: string, name: string | null | undefined) => {
    if (name?.trim()) names.set(orderId, [...(names.get(orderId) ?? []), name])
  }
  for (const l of await db
    .select({ id: lead.id, clientName: lead.clientName })
    .from(lead)
    .where(eq(lead.accountId, o.accountId)))
    addName(l.id, l.clientName)
  for (const [orderId, name] of o.clientNames ?? []) addName(orderId, name)

  const rows = await db
    .select({
      chatId: chatMessage.chatId,
      orderId: chatMessage.orderId,
      platformMessageId: chatMessage.platformMessageId,
      side: chatMessage.side,
      author: chatMessage.author,
      text: chatMessage.text,
      source: chatMessage.source,
    })
    .from(chatMessage)
    .where(eq(chatMessage.accountId, o.accountId))
    .orderBy(asc(chatMessage.chatId), asc(chatMessage.sentAt), asc(chatMessage.platformMessageId))
  // Messages known only from the v1 snapshot have made-up times, so they never show what came before what.
  const chats = new Map<string, Row[]>()
  const examples: { m: Row; turn: string[] | null | 'unknown' }[] = []
  for (const r of rows) {
    if (r.source === 'v1') {
      if (r.author === 'boris') examples.push({ m: r, turn: 'unknown' })
      continue
    }
    const list = chats.get(r.chatId) ?? []
    list.push(r)
    chats.set(r.chatId, list)
  }
  for (const chat of chats.values())
    for (const [i, m] of chat.entries())
      if (m.author === 'boris') examples.push({ m, turn: clientTurn(chat, i) })

  let proposed = 0
  let skipped = 0
  const today = moscowDate(new Date())
  for (const { m, turn } of examples) {
    const hidden = m.orderId ? (names.get(m.orderId) ?? []) : []
    // Without the client's name it cannot be hidden: no example rather than a name in the mind (NFR-PRIV-2).
    if (
      m.text.trim().length <= minLength ||
      m.text.trim() === V1_ATTACHMENT ||
      hidden.length === 0
    ) {
      skipped++
      continue
    }
    const stages: ConvStage[] = turn === null ? ['bid_sent'] : []
    // One example per wording of Boris: a v1 copy and its real message give the same proposal.
    const id = `e-h-${createHash('sha256').update(normalizeText(m.text)).digest('hex').slice(0, 12)}`
    const client =
      turn === 'unknown'
        ? UNKNOWN_TURN
        : turn === null
          ? NO_CLIENT_YET
          : redact(turn.join('\n\n'), hidden).text
    const content = `${frontmatter({
      id,
      type: 'example',
      scope: 'shared',
      status: 'proposal',
      version: 1,
      sources: [`history:${o.accountId}:${m.platformMessageId}`],
      valid_from: today,
      valid_to: null,
      stages,
    })}\n## Клиент\n\n${client}\n\n## Борис\n\n${redact(m.text.trim(), hidden).text}\n`
    const added = await proposeMind(db, {
      path: `mind/proposals/shared/speech/examples/${id}.md`,
      content,
      kind: 'example',
      source: `history:${o.accountId}:${m.platformMessageId}`,
    })
    if (added) proposed++
    else skipped++
  }
  return { proposed, skipped }
}
