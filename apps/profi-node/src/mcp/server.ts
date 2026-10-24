import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  type GetOrderInput,
  type GetOrderOutput,
  type ListChatsInput,
  type ListChatsOutput,
  type ListFeedInput,
  type ListFeedOutput,
  PROFI_TOOLS,
  type ProfiErrorClass,
  type ProfiToolName,
  type ReadChatInput,
  type ReadChatOutput,
  type SessionHealthInput,
  type SessionHealthOutput,
  type SubmitBidInput,
  type SubmitBidOutput,
} from '@sara/shared'
import { z } from 'zod'

export type ProfiToolsImpl = {
  sessionHealth(i: SessionHealthInput): Promise<SessionHealthOutput>
  listFeed(i: ListFeedInput): Promise<ListFeedOutput>
  getOrder(i: GetOrderInput): Promise<GetOrderOutput>
  listChats(i: ListChatsInput): Promise<ListChatsOutput>
  readChat(i: ReadChatInput): Promise<ReadChatOutput>
  submitBid(i: SubmitBidInput): Promise<SubmitBidOutput>
}

/** A tool failure the core understands (contract C2 error classes). */
export class ProfiToolError extends Error {
  constructor(
    readonly errorClass: ProfiErrorClass,
    message: string,
  ) {
    super(message)
  }
}

const DESCRIPTIONS: Record<ProfiToolName, string> = {
  'profi.session_health': 'Состояние входа аккаунта: жива ли сессия, баланс, присутствие, IP.',
  'profi.list_feed': 'Заказы из ленты, которые служба уже видела.',
  'profi.get_order': 'Заказ целиком: открыт ли, цена отклика, есть ли уже отклик этого аккаунта.',
  'profi.list_chats': 'Чаты аккаунта с последним сообщением и числом непрочитанных.',
  'profi.read_chat': 'Сообщения чата с номером площадки, автором, временем и отметкой «прочитано».',
  'profi.submit_bid': 'Отклик на заказ через интерфейс площадки с проверкой экраном.',
}

function call(impl: ProfiToolsImpl, name: ProfiToolName, data: unknown): Promise<object> {
  switch (name) {
    case 'profi.session_health':
      return impl.sessionHealth(data as SessionHealthInput)
    case 'profi.list_feed':
      return impl.listFeed(data as ListFeedInput)
    case 'profi.get_order':
      return impl.getOrder(data as GetOrderInput)
    case 'profi.list_chats':
      return impl.listChats(data as ListChatsInput)
    case 'profi.read_chat':
      return impl.readChat(data as ReadChatInput)
    case 'profi.submit_bid':
      return impl.submitBid(data as SubmitBidInput)
  }
}

/** MCP server for contract C2, built on the low-level Server so our zod contracts stay the source of truth. */
export function createProfiMcpServer(impl: ProfiToolsImpl): Server {
  const server = new Server(
    { name: 'sara-profi', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (Object.keys(PROFI_TOOLS) as ProfiToolName[]).map((name) => ({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: z.toJSONSchema(PROFI_TOOLS[name].input) as { type: 'object' },
      outputSchema: z.toJSONSchema(PROFI_TOOLS[name].output) as { type: 'object' },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as ProfiToolName
    const tool = PROFI_TOOLS[name]
    const fail = (errorClass: ProfiErrorClass, message: string) => ({
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({ errorClass, message }) }],
    })
    if (!tool) return fail('INTERNAL', `unknown tool ${req.params.name}`)
    const input = tool.input.safeParse(req.params.arguments ?? {})
    if (!input.success) return fail('INTERNAL', input.error.message)
    try {
      const out = await call(impl, name, input.data)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out) }],
        structuredContent: out,
      }
    } catch (e) {
      if (e instanceof ProfiToolError) return fail(e.errorClass, e.message)
      throw e
    }
  })

  return server
}
