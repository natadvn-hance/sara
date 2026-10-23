import { createServer } from 'node:http'
import type { EventEnvelope } from '@sara/shared'

/** A stand-in for the core's C8 endpoint: it can be down, refuse, or accept. */
export async function startTestCore() {
  const received: EventEnvelope[] = []
  let mode: 'up' | 'down' | 'refuse' | 'unauthorized' = 'up'
  const seen = new Set<string>()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      if (mode === 'down') return res.writeHead(503).end()
      if (mode === 'refuse') return res.writeHead(400).end('{"error":"broken"}')
      if (mode === 'unauthorized') return res.writeHead(401).end('{"error":"unauthorized"}')
      const e = JSON.parse(body) as EventEnvelope
      const duplicate = seen.has(e.id)
      if (!duplicate) {
        seen.add(e.id)
        received.push(e)
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ accepted: true, duplicate }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/internal/profi/events`,
    received,
    up: () => {
      mode = 'up'
    },
    down: () => {
      mode = 'down'
    },
    refuse: () => {
      mode = 'refuse'
    },
    unauthorized: () => {
      mode = 'unauthorized'
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
