import { createServer as createHttp } from 'node:http'
import { createServer as createTcp, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { busyPorts } from '../e2e/checkPorts'
import { DEFAULT_BASE, portBase, portsFor } from '../e2e/ports'

const open: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  // A silent listener never reads what it is sent, so its connections would keep close() waiting.
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(open.splice(0).map((s) => new Promise((done) => s.close(done))))
})

async function listenOn(server: Server): Promise<number> {
  open.push(server)
  server.on('connection', (socket) => sockets.add(socket))
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return (server.address() as { port: number }).port
}

async function freePort(): Promise<number> {
  const server = createTcp()
  const port = await listenOn(server)
  await new Promise((done) => server.close(done))
  open.length = 0
  return port
}

describe('the ports of the pult e2e', () => {
  it('NFR-MAINT-1: every server gets its own port, counted from one base', () => {
    const ports = portsFor(28100)
    const numbers = Object.values(ports)
    expect(new Set(numbers).size).toBe(numbers.length)
    expect(Math.min(...numbers)).toBe(28100)
    expect(Math.max(...numbers)).toBeLessThan(28110)
  })

  it('NFR-MAINT-1: the base comes from E2E_PORT_BASE, and a local run has a default of its own', () => {
    expect(portBase({ E2E_PORT_BASE: '28110' })).toBe(28110)
    expect(portBase({})).toBe(DEFAULT_BASE)
    expect(portBase({ E2E_PORT_BASE: '' })).toBe(DEFAULT_BASE)
  })

  it('NFR-MAINT-1: the default base keeps off the ports other projects use on the Mac', () => {
    const taken = [3000, 3100, 3300, 5173, 5174, 7070, 7171, 8080, 18081, 18082, 18083, 54329]
    for (const port of Object.values(portsFor(DEFAULT_BASE))) expect(taken).not.toContain(port)
  })

  it('NFR-MAINT-1: a base that is not a port number stops the run with a plain message', () => {
    expect(() => portBase({ E2E_PORT_BASE: 'abc' })).toThrow('E2E_PORT_BASE')
    expect(() => portBase({ E2E_PORT_BASE: '80' })).toThrow('E2E_PORT_BASE')
    expect(() => portBase({ E2E_PORT_BASE: '65530' })).toThrow('E2E_PORT_BASE')
  })
})

describe('the check before the run', () => {
  it('NFR-MAINT-1: free ports pass', async () => {
    expect(await busyPorts({ core: await freePort(), web: await freePort() })).toEqual([])
  })

  it('NFR-MAINT-1: a port held by a plain listener is named in the message', async () => {
    const port = await listenOn(createTcp())
    const [message] = await busyPorts({ core: port })
    expect(message).toContain(`порт ${port} занят`)
    expect(message).toContain('core')
  })

  it('NFR-MAINT-1: a foreign server answering 404 is caught, which Playwright waits on for 60 seconds', async () => {
    const port = await listenOn(createHttp((_req, res) => res.writeHead(404).end('nope')))
    const [message] = await busyPorts({ core: port })
    expect(message).toContain(`порт ${port} занят`)
    expect(message).toContain('404')
  })

  it('NFR-MAINT-1: every busy port gets a line, the free ones none', async () => {
    const a = await listenOn(createTcp())
    const b = await listenOn(createTcp())
    const free = await freePort()
    const lines = await busyPorts({ core: a, web: free, profiMcp: b })
    expect(lines).toHaveLength(2)
  })
})
