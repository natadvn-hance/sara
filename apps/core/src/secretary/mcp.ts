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
export type TurnKeys<T = TurnContext> = {
  open(t: T): string
  close(key: string): void
  find(key: string): T | null
}

export function createTurnKeys<T = TurnContext>(): TurnKeys<T> {
  const turns = new Map<string, T>()
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

/** A table of tools served over MCP for the turns of one kind (the Secretary, the topic chat). */
export type ToolServer<T> = {
  name: string
  list(): { name: string; description: string; input: z.ZodObject }[]
  run(t: T, name: string, args: unknown): Promise<{ text: string; isError: boolean }>
}

/** The MCP server of one request: the tools of the turn its key opened. */
function serverFor<T>(tools: ToolServer<T>, t: T): Server {
  const server = new Server({ name: tools.name, version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.list().map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: z.toJSONSchema(def.input) as { type: 'object' },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await tools.run(t, req.params.name, req.params.arguments)
    return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
  })
  return server
}

/**
 * Tools over stateless Streamable HTTP at `path` (ADR-027). A request from another machine, without the key of a turn
 * that runs now, or before the core is ready, finds nothing here.
 */
export function registerToolMcp<T>(
  app: FastifyInstance,
  path: string,
  d: { keys: TurnKeys<T>; tools: () => ToolServer<T> | null },
): void {
  app.post(path, async (req, reply) => {
    const key = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    // The socket's own address: a proxy header can never make a request local.
    const local = LOOPBACK.has(req.socket.remoteAddress ?? '')
    const turn = local && key ? d.keys.find(key) : null
    const tools = d.tools()
    if (!turn || !tools) return reply.code(404).send({ error: 'not found' })
    const server = serverFor(tools, turn)
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
      url: path,
      handler: async (_req, reply) => reply.code(405).send({ error: 'method not allowed' }),
    })
}

/** Sara's tools for the Secretary's turns. */
export function registerSecretaryMcp(
  app: FastifyInstance,
  d: { keys: TurnKeys; deps: () => SecretaryDeps | null },
): void {
  registerToolMcp(app, SECRETARY_MCP_PATH, {
    keys: d.keys,
    tools: () => {
      const deps = d.deps()
      if (!deps) return null
      return {
        name: 'sara-secretary',
        list: () =>
          Object.entries(SECRETARY_TOOLS).map(([name, def]) => ({
            name,
            description: def.description,
            input: def.input,
          })),
        run: (t, name, args) => runTool(deps, t, name, args),
      }
    },
  })
}
