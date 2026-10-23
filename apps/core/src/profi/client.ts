import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  PROFI_ERROR_CLASSES,
  type ProfiErrorClass,
  type ProfiToolName,
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
  }
}
