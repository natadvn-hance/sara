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
import { signPermit } from '@sara/shared/permit'
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
  submitBid(i: Omit<SubmitBidInput, 'permit'>): Promise<SubmitBidOutput>
  readChat(accountId: string, chatId: string): Promise<ReadChatOutput>
  listChats(accountId: string): Promise<ListChatsOutput>
  getOrder(accountId: string, orderId: string): Promise<GetOrderOutput>
  sendMessage(i: Omit<SendMessageInput, 'permit'>): Promise<SendMessageOutput>
}

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
export function createProfiClient(o: { url: string; permitSecret: string }): ProfiClient {
  async function call<T>(
    name: ProfiToolName,
    args: Record<string, unknown>,
    out: ZodType<T>,
  ): Promise<T> {
    const client = new Client({ name: 'sara-core', version: '0.1.0' })
    let result: Awaited<ReturnType<Client['callTool']>>
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(o.url)))
      result = await client.callTool({ name, arguments: args })
    } catch (e) {
      throw new ProfiError('UNCERTAIN', e instanceof Error ? e.message : String(e))
    } finally {
      await client.close().catch(() => {})
    }
    if (result.isError) throw toolError(result.content)
    const parsed = out.safeParse(result.structuredContent)
    if (!parsed.success) throw new ProfiError('INTERNAL', 'tool answer breaks the contract')
    return parsed.data
  }

  return {
    sessionHealth: (accountId) =>
      call('profi.session_health', { account_id: accountId }, SessionHealthOutput),
    submitBid: (i) =>
      call(
        'profi.submit_bid',
        { ...i, permit: signPermit(o.permitSecret, i.idempotency_key) },
        SubmitBidOutput,
      ),
    readChat: (accountId, chatId) =>
      call('profi.read_chat', { account_id: accountId, chat_id: chatId }, ReadChatOutput),
    listChats: (accountId) => call('profi.list_chats', { account_id: accountId }, ListChatsOutput),
    getOrder: (accountId, orderId) =>
      call('profi.get_order', { account_id: accountId, order_id: orderId }, GetOrderOutput),
    sendMessage: (i) =>
      call(
        'profi.send_message',
        { ...i, permit: signPermit(o.permitSecret, i.idempotency_key) },
        SendMessageOutput,
      ),
  }
}
