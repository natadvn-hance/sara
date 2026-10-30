import { ClientInfo } from '@sara/shared'
import { eq } from 'drizzle-orm'
import { lead } from '../db/schema'
import { namesToHide } from '../leads/clientName'
import { studyLeadSite } from '../site'
import type { StudyDeps } from '../site/study'
import type { ConversationRow } from './types'

/**
 * A site the client names in the chat (Boris, 30.10.2026): when the lead has no site of its own yet and the client's words
 * of this turn give an address, it is read before the reply is planned, so the reply can lean on it. A chat with no lead in
 * the core (begun by old Sara's bid) has nowhere to keep a site and is left alone. Never throws; a site already read for
 * this lead costs nothing.
 */
export async function readSiteOfTurn(
  d: StudyDeps,
  conv: Pick<ConversationRow, 'orderId'>,
  clientTexts: string[],
): Promise<void> {
  if (!conv.orderId || clientTexts.length === 0) return
  try {
    const [l] = await d.db.select().from(lead).where(eq(lead.id, conv.orderId))
    if (!l) return
    await studyLeadSite(d, {
      leadId: l.id,
      correlationId: l.correlationId,
      text: clientTexts.join('\n'),
      source: 'chat',
      order: { title: l.title, category: l.category, text: l.text },
      names: namesToHide(l.clientName, ClientInfo.safeParse(l.clientInfo).data?.name),
    })
  } catch (e) {
    console.error('turn: site not read', e instanceof Error ? e.message.slice(0, 200) : e)
  }
}
