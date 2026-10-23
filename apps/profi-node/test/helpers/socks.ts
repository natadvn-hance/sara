import { connect, createServer, type Socket } from 'node:net'

/** Minimal SOCKS5 (no auth, CONNECT only) for tests: records where the browser asked to go. */
export async function startTestSocks() {
  const targets: string[] = []
  const open = new Set<Socket>()
  const server = createServer((client: Socket) => {
    open.add(client)
    client.on('close', () => open.delete(client))
    client.once('data', () => {
      client.write(Buffer.from([5, 0]))
      client.once('data', (req: Buffer) => {
        const atyp = req[3]
        let host = ''
        let off = 4
        if (atyp === 1) {
          host = [...req.subarray(4, 8)].join('.')
          off = 8
        } else if (atyp === 3) {
          const len = req[4] ?? 0
          host = req.subarray(5, 5 + len).toString()
          off = 5 + len
        } else if (atyp === 4) {
          host = (req.subarray(4, 20).toString('hex').match(/.{4}/g) ?? []).join(':')
          off = 20
        }
        const port = req.readUInt16BE(off)
        targets.push(`${host}:${port}`)
        const upstream = connect(
          port,
          host === '0000:0000:0000:0000:0000:0000:0000:0001' ? '::1' : host,
          () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            client.pipe(upstream).pipe(client)
          },
        )
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `socks5://127.0.0.1:${port}`,
    targets,
    close: () =>
      new Promise<void>((r) => {
        for (const c of open) c.destroy()
        server.close(() => r())
      }),
  }
}
