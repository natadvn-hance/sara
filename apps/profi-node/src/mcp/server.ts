import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  PROFI_TOOLS,
  type ProfiErrorClass,
  type ProfiToolName,
  type SessionHealthInput,
  type SessionHealthOutput,
  type SubmitBidInput,
  type SubmitBidOutput,
} from '@sara/shared'
import { z } from 'zod'

export type ProfiToolsImpl = {
  sessionHealth(i: SessionHealthInput): Promise<SessionHealthOutput>
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
  'profi.submit_bid': 'Отклик на заказ через интерфейс площадки с проверкой экраном.',
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
      const out =
        name === 'profi.submit_bid'
          ? await impl.submitBid(input.data as SubmitBidInput)
          : await impl.sessionHealth(input.data as SessionHealthInput)
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
