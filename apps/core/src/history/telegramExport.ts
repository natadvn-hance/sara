import { readFileSync } from 'node:fs'
import { normalizeText } from '@sara/shared'

type Part = string | { text?: string }
type Message = { type?: string; from_id?: string; text?: string | Part[] }

/** Notices of old Sara that quote what she sent to a client (v1 notifier/formatNotification.js). */
const V1_NOTICES = ['🤖', '🔁', '✅ Отклик отправлен']
/** «🤖» notices that carried Boris's own words: his voice, never proof of v1's. */
const BORIS_NOTICES = ['🤖 Отправила клиенту твой текст', '🤖 Твой текст уже в чате']

const flat = (t: Message['text']) =>
  typeof t === 'string'
    ? t
    : (t ?? []).map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join('')

/** The quote of a notice: what went to the client, after the first blank line, without the «Ссылка» line. */
function quoteOf(text: string): string {
  const paras = text.split(/\n\s*\n/).slice(1)
  if (paras.at(-1)?.trim() === 'Ссылка') paras.pop()
  return normalizeText(paras.join('\n\n'))
}

/**
 * Boris's Telegram Desktop export of his chat with old Sara (JSON, one chat), read for whose words went to clients
 * (M4 design 5.1): `v1Texts` from her «🤖», «🔁» and «✅ Отклик отправлен» notices, `borisTexts` from the notices
 * that carried his own text («Отправила клиенту твой текст»). Only the bot's messages count: Boris's own message
 * that starts with the same icon is not a notice. Normalized.
 */
export function readTelegramExport(path: string): {
  v1Texts: Set<string>
  borisTexts: Set<string>
} {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { id?: number; messages?: Message[] }
  if (!Array.isArray(data.messages))
    throw new Error(`Это не выгрузка одного чата Telegram: нет списка messages в ${path}`)
  // In a chat with a bot the bot writes as user<chat id>; an export without these numbers keeps every message.
  const bot = data.id !== undefined ? `user${data.id}` : null
  const v1Texts = new Set<string>()
  const borisTexts = new Set<string>()
  for (const m of data.messages) {
    if (m.type !== undefined && m.type !== 'message') continue
    if (bot && m.from_id !== undefined && m.from_id !== bot) continue
    const text = flat(m.text)
    if (!V1_NOTICES.some((h) => text.startsWith(h))) continue
    const sent = quoteOf(text)
    if (sent === '') continue
    if (BORIS_NOTICES.some((h) => text.startsWith(h))) borisTexts.add(sent)
    else v1Texts.add(sent)
  }
  return { v1Texts, borisTexts }
}

/** The texts old Sara sent to clients, from the same export (readTelegramExport). */
export function readTelegramV1Texts(path: string): Set<string> {
  return readTelegramExport(path).v1Texts
}
