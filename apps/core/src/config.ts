import { resolve } from 'node:path'

export type Config = {
  databaseUrl: string
  dataDir: string
  port: number
  publicUrl: string
  profiMcpUrl: string
  profiScreenUrl: string
  accounts: { id: string; title: string; egressIp: string }[]
  nodeToken: string
  permitSecret: string
  claudeBin: string
  telegramApiRoot: string | undefined
  rolesDir: string
  production: boolean
}

const ROOT = resolve(import.meta.dirname, '../../..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production'
  const required = (name: string, devDefault: string): string => {
    const v = env[name]
    if (v) return v
    if (production)
      throw new Error(`Не задана переменная ${name}: без неё Сара в работе не запускается.`)
    return devDefault
  }
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://sara:sara@localhost:54329/sara',
    dataDir: resolve(env.SARA_DATA_DIR ?? resolve(ROOT, '.sara')),
    port: Number(env.SARA_PORT ?? 3300),
    publicUrl: env.SARA_PUBLIC_URL ?? 'http://localhost:5173',
    profiMcpUrl: env.SARA_PROFI_MCP_URL ?? 'http://localhost:7070/mcp',
    profiScreenUrl:
      env.SARA_PROFI_SCREEN_URL ??
      (env.SARA_PROFI_MCP_URL ?? 'http://localhost:7070/mcp')
        .replace(/^http/, 'ws')
        .replace(/\/mcp$/, ''),
    accounts: JSON.parse(
      env.SARA_ACCOUNTS ??
        '[{"id":"hance-marketing","title":"Hance маркетинг","egressIp":"127.0.0.1"}]',
    ),
    nodeToken: required('SARA_NODE_TOKEN', 'dev-node-token'),
    permitSecret: required('SARA_PERMIT_SECRET', 'dev-permit-secret'),
    claudeBin: env.SARA_CLAUDE_BIN ?? 'claude',
    telegramApiRoot: env.SARA_TELEGRAM_API_ROOT || undefined,
    rolesDir: resolve(env.SARA_ROLES_DIR ?? resolve(ROOT, 'roles')),
    production,
  }
}
