// The test stand's Profi.ru in its container (infra/compose.staging.yml, docs/ops/staging.md).
import { resolve } from 'node:path'
import { LIVE_TIMING, type Timing } from './clients'
import { createClientModel, tokenFrom } from './model'
import { createStand } from './stand'

const env = process.env
const required = (name: string): string => {
  const v = env[name]
  if (!v) throw new Error(`Не задана переменная ${name}: стенд не запускается.`)
  return v
}
const ROOT = resolve(import.meta.dirname, '../../../..')
const token = tokenFrom(env.STAND_CORE_SECRETS ?? '/core-data/secrets.json')
// STAND_FAST=1: clients answer within seconds, for a quick look and the scenario check.
const timing: Timing =
  env.STAND_FAST === '1'
    ? { readMs: [1000, 2000], firstReplyMs: [8000, 12000], replyMs: [5000, 8000], typingMs: 1500 }
    : LIVE_TIMING

const stand = await createStand({
  port: Number(env.STAND_PORT ?? 7070),
  host: env.STAND_HOST ?? '0.0.0.0',
  coreEventsUrl: env.SARA_CORE_EVENTS_URL ?? 'http://core:3300/internal/profi/events',
  nodeToken: required('SARA_NODE_TOKEN'),
  permitSecret: required('SARA_PERMIT_SECRET'),
  dataDir: env.STAND_DATA_DIR ?? '/stand-data',
  model: createClientModel({
    claudeBin: env.SARA_CLAUDE_BIN ?? 'claude',
    rolesDir: env.SARA_ROLES_DIR ?? resolve(ROOT, 'roles'),
    token,
    cwd: env.STAND_DATA_DIR ?? '/stand-data',
  }),
  modelReady: async () => (await token()) !== null,
  timing,
  limits: {
    daily: Number(env.STAND_CLIENT_DAILY_LIMIT ?? 40),
    perChat: Number(env.STAND_CLIENT_CHAT_LIMIT ?? 8),
  },
})
console.log(`Профи.ру понарошку: ${stand.url}/stand/`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stand.close().then(() => process.exit(0))
  })
}
