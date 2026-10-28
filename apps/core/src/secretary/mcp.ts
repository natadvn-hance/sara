import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { runTool, SECRETARY_TOOLS, type SecretaryDeps, type TurnContext } from './tools'

/** Where the CLI of a turn finds Sara's tools: the core itself, from the same machine only. */
export const SECRETARY_MCP_PATH = '/internal/secretary/mcp'
/** The server's name in the CLI's config: its tools are `mcp__sara__<name>`. */
export const SECRETARY_MCP_SERVER = 'sara'

/** The keys of the turns that run now: a key opens the tools of its turn and of no other, and only while it runs. */
export type TurnKeys = {
  open(t: TurnContext): string
  close(key: string): void
  find(key: string): TurnContext | null
}

export function createTurnKeys(): TurnKeys {
  const turns = new Map<string, TurnContext>()
  return {
    open(t) {
      const key = randomBytes(32).toString('hex')
      turns.set(key, t)
      return key
    },
    close: (key) => void turns.delete(key),
    find(key) {
      const given = Buffer.from(key)
      for (const [k, t] of turns) {
        const known = Buffer.from(k)
        if (known.length === given.length && timingSafeEqual(known, given)) return t
      }
      return null
    },
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The MCP server of one request: the tools of the turn its key opened. */
function serverFor(d: SecretaryDeps, t: TurnContext): Server {
  const server = new Server(
    { name: 'sara-secretary', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(SECRETARY_TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: z.toJSONSchema(def.input) as { type: 'object' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await runTool(d, t, req.params.name, req.params.arguments)
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
  })
  return server
}

/**
 * Sara's tools over stateless Streamable HTTP (ADR-027). A request from another machine, without the key of a turn
 * that runs now, or before the core is ready, finds nothing here.
 */
export function registerSecretaryMcp(
  app: FastifyInstance,
  d: { keys: TurnKeys; deps: () => SecretaryDeps | null },
): void {
  app.post(SECRETARY_MCP_PATH, async (req, reply) => {
    const key = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    // The socket's own address: a proxy header can never make a request local.
    const local = LOOPBACK.has(req.socket.remoteAddress ?? '')
    const turn = local && key ? d.keys.find(key) : null
    const deps = d.deps()
    if (!turn || !deps) return reply.code(404).send({ error: 'not found' })
    const server = serverFor(deps, turn)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    reply.hijack()
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req.raw, reply.raw, req.body)
  })
  // No stream and no session to end: a stateless server answers only POST.
  for (const method of ['GET', 'DELETE'] as const)
    app.route({
      method,
      url: SECRETARY_MCP_PATH,
      handler: async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }),
    })
}
