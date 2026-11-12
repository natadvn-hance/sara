/**
 * Every port the pult e2e uses, in one place. There is one base number and a fixed offset from it for each server, so
 * two runs at once (the two CI runners, a dev session) only need two different bases: CI sets E2E_PORT_BASE per runner
 * in ci.yml, the way it picks the Postgres port. The base is far from what the Mac's other projects use (3000, 3100,
 * 5173, 8080 ...), and the block of ten ports after it is reserved for one run.
 */
export const DEFAULT_BASE = 28120

const OFFSETS = {
  core: 0,
  web: 1,
  telegramApi: 2,
  telegramControl: 3,
  standControl: 4,
  profiMcp: 5,
} as const

export type PortName = keyof typeof OFFSETS

/** The lowest port a run may start at, and the highest that still leaves the whole block of ten under 65535. */
const LOWEST = 1024
const HIGHEST = 65500

export function portBase(env: Record<string, string | undefined> = process.env): number {
  const raw = env.E2E_PORT_BASE
  if (raw === undefined || raw === '') return DEFAULT_BASE
  const base = Number(raw)
  if (!Number.isInteger(base) || base < LOWEST || base > HIGHEST)
    throw new Error(
      `E2E_PORT_BASE должен быть целым числом от ${LOWEST} до ${HIGHEST}, а сейчас «${raw}».`,
    )
  return base
}

export function portsFor(base: number): Record<PortName, number> {
  return Object.fromEntries(
    Object.entries(OFFSETS).map(([name, offset]) => [name, base + offset]),
  ) as Record<PortName, number>
}

export const BASE = portBase()
export const PORTS = portsFor(BASE)

export const HOST = '127.0.0.1'

/** The addresses the servers answer on, for the config, the fakes and the specs. */
export const URLS = {
  core: `http://${HOST}:${PORTS.core}`,
  web: `http://${HOST}:${PORTS.web}`,
  telegramApi: `http://${HOST}:${PORTS.telegramApi}`,
  telegramControl: `http://${HOST}:${PORTS.telegramControl}/_control`,
  standControl: `http://${HOST}:${PORTS.standControl}/_control`,
  profiMcp: `http://${HOST}:${PORTS.profiMcp}/mcp`,
} as const
