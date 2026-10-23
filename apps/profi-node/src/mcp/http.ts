import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

export type ExtraRoute = (
  req: IncomingMessage,
  body: string,
  res: ServerResponse,
) => Promise<boolean>

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => ok(body))
  })
}

/** Serves MCP over stateless Streamable HTTP on /mcp; `extra` may answer other paths. */
export async function serveMcp(
  make: () => Server,
  port: number,
  extra?: ExtraRoute,
): Promise<{ url: string; close(): Promise<void> }> {
  const http = createServer(async (req, res) => {
    const body = await readBody(req)
    if (req.url?.startsWith('/mcp')) {
      const server = make()
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
      return
    }
    if (extra && (await extra(req, body, res))) return
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => http.listen(port, '127.0.0.1', r))
  const actual = (http.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    close: () => new Promise((r) => http.close(() => r())),
  }
}
