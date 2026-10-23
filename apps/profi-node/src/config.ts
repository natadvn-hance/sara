import { resolve } from 'node:path'
import { z } from 'zod'

const Account = z.object({
  id: z.string().min(1),
  proxy: z.string().nullable(),
  egressIp: z.string().min(1),
})

export type NodeConfig = {
  databaseUrl: string
  coreEventsUrl: string
  nodeToken: string
  permitSecret: string
  dataDir: string
  port: number
  profiBaseUrl: string
  rtpHost: string
  egressEchoUrl: string
  headless: boolean
  accounts: z.infer<typeof Account>[]
  production: boolean
}

export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const production = env.NODE_ENV === 'production'
  const required = (name: string, devDefault: string) => {
    const v = env[name]
    if (v) return v
    if (production)
      throw new Error(`Не задана переменная ${name}: без неё служба Профи-MCP не запускается.`)
    return devDefault
  }
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara',
    coreEventsUrl: env.SARA_CORE_EVENTS_URL ?? 'http://127.0.0.1:3300/internal/profi/events',
    nodeToken: required('SARA_NODE_TOKEN', 'dev-node-token'),
    permitSecret: required('SARA_PERMIT_SECRET', 'dev-permit-secret'),
    dataDir: resolve(env.PROFI_DATA_DIR ?? resolve(import.meta.dirname, '../../../.sara/profi')),
    port: Number(env.PROFI_PORT ?? 7070),
    profiBaseUrl: env.PROFI_BASE_URL ?? 'https://profi.ru',
    rtpHost: env.PROFI_RTP_HOST ?? 'online.profi.ru',
    egressEchoUrl: env.PROFI_EGRESS_ECHO_URL ?? 'https://api.ipify.org',
    headless: env.PROFI_HEADLESS !== 'false',
    accounts: z.array(Account).parse(JSON.parse(env.PROFI_ACCOUNTS ?? '[]')),
    production,
  }
}
