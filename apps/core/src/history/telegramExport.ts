import { readFileSync } from 'node:fs'
import { normalizeText } from '@sara/shared'

type Part = string | { text?: string }
type Message = { type?: string; text?: string | Part[] }

/** Notices of old Sara that quote what she sent to a client (v1 notifier/formatNotification.js). */
const V1_NOTICES = ['🤖', '🔁', '✅ Отклик отправлен']
/** «🤖» notices that carried Boris's own words: his voice, never proof of v1's. */
const BORIS_NOTICES = ['🤖 Отправила клиенту твой текст', '🤖 Твой текст уже в чате']

const flat = (t: Message['text']) =>
  typeof t === 'string'
    ? t
    : (t ?? []).map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join('')

/**
 * The texts old Sara sent to clients, from Boris's Telegram Desktop export of his chat with her (JSON, one chat):
 * the quote after the first blank line of each notice, without the «Ссылка» line, normalized (M4 design 5.1).
 */
export function readTelegramV1Texts(path: string): Set<string> {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { messages?: Message[] }
  if (!Array.isArray(data.messages))
    throw new Error(`Это не выгрузка одного чата Telegram: нет списка messages в ${path}`)
  const texts = new Set<string>()
  for (const m of data.messages) {
    if (m.type !== undefined && m.type !== 'message') continue
    const text = flat(m.text)
    if (!V1_NOTICES.some((h) => text.startsWith(h))) continue
    if (BORIS_NOTICES.some((h) => text.startsWith(h))) continue
    const paras = text.split(/\n\s*\n/).slice(1)
    if (paras.at(-1)?.trim() === 'Ссылка') paras.pop()
    const sent = normalizeText(paras.join('\n\n'))
    if (sent !== '') texts.add(sent)
  }
  return texts
}
