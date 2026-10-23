import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createFakeTelegram, type FakeTelegram } from '../../../../tests/fakes/telegramApi'
import { buildServer } from '../../src/api/server'
import type { Db } from '../../src/db/client'
import { createGateway } from '../../src/gateway/gateway'
import { createBotControl } from '../../src/notify/botControl'
import type { ProfiClient } from '../../src/profi/client'
import { createSecretStore } from '../../src/secrets/store'

export const ROOT = resolve(import.meta.dirname, '../../../..')

export type TestApp = {
  app: FastifyInstance
  tg: FakeTelegram
  close(): Promise<void>
  cookie(): string
}

/** Core HTTP server with fake Telegram, fake Claude CLI and a stub Profi client. */
export async function buildTestApp(
  db: Db,
  claudeEnv: Record<string, string> = {},
): Promise<TestApp> {
  const dir = await mkdtemp(join(tmpdir(), 'app-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
  const tg = await createFakeTelegram()
  const secrets = createSecretStore(join(dir, 'data'))
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_OUTPUT: '{"ok":true}', ...claudeEnv },
  })
  const profi: ProfiClient = {
    sessionHealth: async () => ({
      alive: true,
      balance_rub: 5000,
      presence: true,
      egress_ip: '127.0.0.1',
    }),
    submitBid: async () => {
      throw new Error('not used here')
    },
  }
  const bot = createBotControl({ db, apiRoot: tg.apiRoot, onPress: async () => 'ok' })
  const app = await buildServer({
    db,
    secrets,
    gateway,
    profi,
    bot,
    production: false,
    telegramApiRoot: tg.apiRoot,
  })
  let sessionCookie = ''
  app.addHook('onSend', async (_req, reply, payload) => {
    const set = reply.getHeader('set-cookie')
    if (set) sessionCookie = String(Array.isArray(set) ? set[0] : set).split(';')[0] ?? ''
    return payload
  })
  return {
    app,
    tg,
    cookie: () => sessionCookie,
    async close() {
      await bot.stop()
      await app.close()
      await tg.close()
    },
  }
}
