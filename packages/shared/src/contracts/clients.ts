import { z } from 'zod'
import { InboxItem } from './inbox'
import { ConvMessage, FUNNEL_STAGES } from './pult'

/**
 * «Клиенты» and «Встречи» (pult v2 design 5 and 9): a client is a conversation of M4 with its stage in Boris's
 * funnel, the open things that wait for him, the chat, his note and the outcome of the deal.
 */

const at = z.string()
const rub = z.number().int()

export const ClientOutcome = z.object({
  outcome: z.enum(['won', 'lost']),
  amountRub: rub.nullable(),
  reason: z.string().nullable(),
  at,
})
export type ClientOutcome = z.infer<typeof ClientOutcome>

export const ClientRow = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  stage: z.enum(FUNNEL_STAGES),
  owner: z.enum(['sara', 'boris']),
  closed: z.boolean(),
  /** Something of this client waits for Boris: a draft, his held text, a question. */
  waits: z.boolean(),
  last: z.string().nullable(),
  lastAt: at.nullable(),
  lastSide: z.enum(['client', 'us', 'profi']).nullable(),
  amountRub: rub.nullable(),
})
export type ClientRow = z.infer<typeof ClientRow>

export const ClientList = z.object({
  rows: z.array(ClientRow),
  /** What a press on «Отправить» does while the drafts mode is on, said once. */
  drafting: z.string().nullable(),
})
export type ClientList = z.infer<typeof ClientList>

export const MeetingRow = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string(),
  title: z.string(),
  at: at.nullable(),
  channel: z.string().nullable(),
  note: z.string().nullable(),
  outcome: z.enum(['held', 'missed', 'moved']).nullable(),
  amountRub: rub.nullable(),
  /** Set by Boris here, or seen in the chat by the deal's stage (a call proposed or booked). */
  source: z.enum(['manual', 'deal']),
})
export type MeetingRow = z.infer<typeof MeetingRow>

export const MeetingList = z.object({ rows: z.array(MeetingRow) })
export type MeetingList = z.infer<typeof MeetingList>

export const ClientView = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.enum(FUNNEL_STAGES),
  owner: z.enum(['sara', 'boris']),
  closed: z.boolean(),
  orderId: z.string().nullable(),
  orderTitle: z.string().nullable(),
  chatUrl: z.string().nullable(),
  note: z.string().nullable(),
  service: z.string().nullable(),
  outcome: ClientOutcome.nullable(),
  spentRub: rub,
  messages: z.array(ConvMessage),
  /** The open things of this client, decided right here with the Inbox's presses. */
  tasks: z.array(InboxItem),
  meetings: z.array(MeetingRow),
  /** Why «Отправить» would not reach the client now; null: it would go. */
  sendHold: z.string().nullable(),
})
export type ClientView = z.infer<typeof ClientView>
