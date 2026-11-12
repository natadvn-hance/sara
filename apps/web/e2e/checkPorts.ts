// Before the e2e run: a port that is already taken stops it at once, with the name of what holds it.
// Playwright waits 60 seconds on a foreign server that answers 404 (it counts only 200 to 403 as «taken»).
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { BASE, PORTS } from './ports'

const run = promisify(execFile)

/** The addresses to try: a server may hold only the IPv4 or only the IPv6 side of localhost. */
const HOSTS = ['127.0.0.1', '::1']

/**
 * A connect tells whether something listens. Binding the port ourselves would not: on macOS a server on `*:3100`
 * and our bind to 127.0.0.1:3100 can both succeed.
 */
function listensOn(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 700 })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => done(false))
  })
}

async function isTaken(port: number): Promise<boolean> {
  return (await Promise.all(HOSTS.map((h) => listensOn(h, port)))).some(Boolean)
}

/** The process that listens (needs lsof; the Mac has it, a runner without it still gets the other half). */
async function processOn(port: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
    const pid = /^p(\d+)$/m.exec(stdout)?.[1]
    const name = /^c(.+)$/m.exec(stdout)?.[1]
    return pid ? `${name ?? 'процесс'} (PID ${pid})` : null
  } catch {
    return null
  }
}

/** What the server says to a plain request: a stranger that answers 404 is the case Playwright does not catch. */
function answerOn(port: number): Promise<string | null> {
  return new Promise((done) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', agent: false, timeout: 1500 },
      (res) => {
        res.destroy()
        done(`на запрос отвечает ${res.statusCode}`)
      },
    )
    // destroy closes the socket at once, so a silent listener is not held open by the check.
    req.once('timeout', () => req.destroy())
    req.once('error', () => done(null))
    req.end()
  })
}

/** A line for each taken port, none for the free ones. `ports` maps a name (what the port is for) to its number. */
export async function busyPorts(ports: Record<string, number>): Promise<string[]> {
  const lines = await Promise.all(
    Object.entries(ports).map(async ([name, port]) => {
      if (!(await isTaken(port))) return null
      const who = [await processOn(port), await answerOn(port)].filter(Boolean).join(', ')
      return `порт ${port} занят: ${who || 'неизвестный процесс'}; нужен для «${name}»`
    }),
  )
  return lines.filter((l): l is string => l !== null)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const busy = await busyPorts(PORTS)
  if (busy.length > 0) {
    for (const line of busy) console.error(line)
    console.error(
      `Тесты пульта не запущены. Освободи эти порты или задай другую базу: E2E_PORT_BASE=<число> (сейчас ${BASE}; нужны эта база и пять портов после неё).`,
    )
    process.exit(1)
  }
  console.log(`Порты e2e свободны: ${Object.values(PORTS).join(', ')}`)
}
