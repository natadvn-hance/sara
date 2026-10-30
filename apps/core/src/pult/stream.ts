import type { FastifyInstance } from 'fastify'
import { subscribe } from '../journal/bus'

/** The stream's heartbeat, so a proxy never closes a quiet connection. */
const PING_MS = 25_000

/**
 * `GET /api/stream` (pult v2 design 6): server-sent events, one line per event of the journal, with the type, the
 * kind and the id of the thing and nothing else. The pult reads the open screens again on each.
 */
export function registerStreamRoute(scoped: FastifyInstance): void {
  scoped.get('/api/stream', async (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': ready\n\n')
    const send = (line: string) => {
      if (!res.writableEnded && !res.destroyed) res.write(line)
    }
    const off = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`))
    const ping = setInterval(() => send(': ping\n\n'), PING_MS)
    const done = () => {
      off()
      clearInterval(ping)
    }
    req.raw.on('close', done)
    res.on('close', done)
    res.on('error', done)
  })
}
