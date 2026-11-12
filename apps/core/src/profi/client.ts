import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  GetOrderOutput,
  ListChatsOutput,
  PROFI_ERROR_CLASSES,
  type ProfiErrorClass,
  type ProfiToolName,
  ReadChatOutput,
  type SendMessageInput,
  SendMessageOutput,
  SessionHealthOutput,
  type SubmitBidInput,
  SubmitBidOutput,
} from '@sara/shared'
import { signMessagePermit, signPermit } from '@sara/shared/permit'
import type { ZodType } from 'zod'

export class ProfiError extends Error {
  constructor(
    readonly errorClass: ProfiErrorClass,
    message: string,
  ) {
    super(message)
  }
}

export type ProfiClient = {
  sessionHealth(accountId: string): Promise<SessionHealthOutput>
  /** The order as its page shows it now: open, the fee, the client (FR-LEAD-5). */
  getOrder(accountId: string, orderId: string): Promise<GetOrderOutput>
  /** The deadline (not_after) and the permit are the client's own: it knows how long it waits. */
  submitBid(i: Omit<SubmitBidInput, 'permit' | 'not_after'>): Promise<SubmitBidOutput>
  readChat(accountId: string, chatId: string): Promise<ReadChatOutput>
  listChats(accountId: string): Promise<ListChatsOutput>
  sendMessage(i: MessageToSend): Promise<SendMessageOutput>
}

/**
 * A message as the core hands it over. `asWritten`: Boris's own words (his «say»), whose quotes stay his; the mark
 * never leaves the core, the node gets the contract only.
 */
export type MessageToSend = Omit<SendMessageInput, 'permit'> & { asWritten?: boolean }

/**
 * How long a tool that works in the account tab is waited for: the tab may first finish the feed check and the chat
 * walk (#79). The SDK's own minute gave up while the bid still waited in the node's queue. A message waits the same:
 * the tab's queue (up to 150 s), the typing (up to 25 s) and the check that it stands in the chat (up to 15 s) can
 * together take minutes, and a slow send that succeeded must not look like a lost answer.
 */
/** Whatever reaches a client has no «ё» (Boris, 31.10.2026): the last point before the node, whoever wrote the text. */
const withoutYo = (text: string) => text.replace(/ё/g, 'е').replace(/Ё/g, 'Е')

/**
 * Sara's text reaches a client with plain quotes (Boris, 11.11.2026; his skill «Голос Бориса»: «ёлочки» are what gives a
 * model away): «», „“ and “” become ". Boris's own words keep his. The chat and the outbox compare texts through
 * `normalizeText`, which drops every kind of quote, so a sent text is still found as ours.
 */
export function forClient(text: string, o: { asWritten?: boolean } = {}): string {
  const plain = withoutYo(text)
  return o.asWritten ? plain : plain.replace(/[«»„“”]/g, '"')
}

const TAB_TIMEOUT_MS = 4 * 60_000
/** The node presses nothing in the last half minute of the wait: its answer could no longer arrive in time. */
const PRESS_MARGIN_MS = 30_000

function toolError(content: unknown): ProfiError {
  const first = Array.isArray(content) ? content[0] : undefined
  try {
    const parsed = JSON.parse((first as { text?: string })?.text ?? '')
    const cls = (PROFI_ERROR_CLASSES as readonly string[]).includes(parsed.errorClass)
      ? parsed.errorClass
      : 'INTERNAL'
    return new ProfiError(cls, String(parsed.message ?? 'tool failed'))
  } catch {
    return new ProfiError('INTERNAL', 'tool failed without details')
  }
}

/** Core side of contract C2. A transport or protocol failure is UNCERTAIN: the action may have happened. */
export function createProfiClient(o: {
  url: string
  permitSecret: string
  /**
   * How long get_order may take (default 90 s). The node reads the order page in its one tab, in turn with the
   * minute check and other orders, so it can take far longer than the 60 s the protocol allows by default.
   */
  getOrderTimeoutMs?: number
  /** How long submit_bid and send_message are waited for (default 4 minutes); tests wait less. */
  tabTimeoutMs?: number
}): ProfiClient {
  const tabMs = o.tabTimeoutMs ?? TAB_TIMEOUT_MS
  async function call<T>(
    name: ProfiToolName,
    args: Record<string, unknown>,
    out: ZodType<T>,
    timeout?: number,
  ): Promise<T> {
    const client = new Client({ name: 'sara-core', version: '0.1.0' })
    let result: Awaited<ReturnType<Client['callTool']>>
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(o.url)))
      result = await client.callTool(
        { name, arguments: args },
        undefined,
        timeout ? { timeout } : undefined,
      )
    } catch (e) {
      throw new ProfiError('UNCERTAIN', e instanceof Error ? e.message : String(e))
    } finally {
      // Closing hangs up the request: the node hears it and presses nothing any more.
      await client.close().catch(() => {})
    }
    if (result.isError) throw toolError(result.content)
    const parsed = out.safeParse(result.structuredContent)
    if (!parsed.success) {
      // A bid answer that breaks the contract still came after the node acted: it may be on the site.
      const cls = name === 'profi.submit_bid' ? 'UNCERTAIN' : 'INTERNAL'
      throw new ProfiError(cls, 'tool answer breaks the contract')
    }
    return parsed.data
  }

  return {
    sessionHealth: (accountId) =>
      call('profi.session_health', { account_id: accountId }, SessionHealthOutput),
    getOrder: (accountId, orderId) =>
      call(
        'profi.get_order',
        { account_id: accountId, order_id: orderId },
        GetOrderOutput,
        o.getOrderTimeoutMs ?? 90_000,
      ),
    submitBid: (i) => {
      const unsigned = {
        ...i,
        text: forClient(i.text),
        not_after: new Date(
          Date.now() + tabMs - Math.min(PRESS_MARGIN_MS, tabMs / 4),
        ).toISOString(),
      }
      return call(
        'profi.submit_bid',
        { ...unsigned, permit: signPermit(o.permitSecret, unsigned) },
        SubmitBidOutput,
        tabMs,
      )
    },
    readChat: (accountId, chatId) =>
      call('profi.read_chat', { account_id: accountId, chat_id: chatId }, ReadChatOutput),
    listChats: (accountId) => call('profi.list_chats', { account_id: accountId }, ListChatsOutput),
    sendMessage: ({ asWritten, ...i }) => {
      const text = forClient(i.text, { asWritten })
      return call(
        'profi.send_message',
        {
          ...i,
          text,
          permit: signMessagePermit(o.permitSecret, {
            accountId: i.account_id,
            chatId: i.chat_id,
            text,
            key: i.idempotency_key,
          }),
        },
        SendMessageOutput,
        tabMs,
      )
    },
  }
}
