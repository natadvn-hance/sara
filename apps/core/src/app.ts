import type { FastifyInstance } from 'fastify'
import { seedAccounts } from './accounts/accounts'
import { createProfiEventDispatcher, routeProfiEvent } from './accounts/profiEvents'
import { speedReport } from './analytics/speed'
import type { AppDeps } from './api/deps'
import { buildServer } from './api/server'
import { requireSession } from './auth/session'
import type { Config } from './config'
import { createDb, type Db } from './db/client'
import { migrate } from './db/migrate'
import { seedDirection } from './direction/store'
import { createGateway } from './gateway/gateway'
import { resumeQueuedOutbox, setOutboxDeps } from './leads/outbox'
import { createLeadPipeline, type LeadPipeline } from './leads/pipeline'
import { type BotControl, createBotControl } from './notify/botControl'
import { createProfiClient } from './profi/client'
import { registerProfiEventsRoute } from './profi/eventsRoute'
import { registerScreenProxy } from './screen/screenProxy'
import { createSecretStore, type SecretStore } from './secrets/store'
import { getSetting } from './settings/store'
import { launchDbos, shutdownDbos } from './workflows/dbos'
import { setReminderHandler } from './workflows/decisionWait'

export type RunningApp = {
  url: string
  app: FastifyInstance
  db: Db
  secrets: SecretStore
  bot: BotControl
  pipeline: LeadPipeline
  close(): Promise<void>
}

export type StartOptions = {
  claudeEnv?: () => Record<string, string>
  retryDelaysMs?: number[]
  remindAfterMs?: () => Promise<number>
  notifyRetry?: { maxAttempts: number; intervalSeconds: number }
}

/** Puts the whole core together: database, durable processes, gateway, bot, pipeline and HTTP. */
export async function startApp(config: Config, o: StartOptions = {}): Promise<RunningApp> {
  await migrate(config.databaseUrl)
  const { db, close: closeDb } = createDb(config.databaseUrl)
  const secrets = createSecretStore(config.dataDir)
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: config.claudeBin,
    rolesDir: config.rolesDir,
    dataDir: config.dataDir,
    extraEnv: o.claudeEnv,
  })
  const profi = createProfiClient({ url: config.profiMcpUrl, permitSecret: config.permitSecret })

  let pipeline: LeadPipeline | null = null
  const bot = createBotControl({
    db,
    apiRoot: config.telegramApiRoot,
    onPress: (p) => (pipeline ? pipeline.onPress(p) : Promise.resolve('Сара ещё запускается')),
  })
  pipeline = createLeadPipeline({
    db,
    gateway,
    notifier: bot.notifier,
    remindAfterMs:
      o.remindAfterMs ??
      (async () => (await getSetting(db, 'reminder.decision_after_min')) * 60_000),
    notifyRetry: o.notifyRetry,
  })
  const lp = pipeline
  setOutboxDeps({
    db,
    profi,
    notifier: bot.notifier,
    retryDelaysMs: o.retryDelaysMs ?? [1000, 2000, 4000, 8000, 16000],
    resendCard: (taskId) => lp.resendCard(taskId),
  })
  setReminderHandler((taskId) => lp.onReminder(taskId))
  const accountEvents = createProfiEventDispatcher({
    db,
    notifier: bot.notifier,
    publicUrl: config.publicUrl,
  })
  await launchDbos(config.databaseUrl)
  // Bids whose delivery never started (a crash right after Boris's press) are picked up now.
  await resumeQueuedOutbox(db)

  const deps: AppDeps = {
    db,
    secrets,
    gateway,
    profi,
    bot,
    production: config.production,
    telegramApiRoot: config.telegramApiRoot,
    accounts: config.accounts,
  }
  await seedAccounts(db, config.accounts)
  for (const a of config.accounts) await seedDirection(db, a.id)
  const app = await buildServer(deps)
  await registerScreenProxy(app, {
    profiScreenUrl: config.profiScreenUrl,
    nodeToken: config.nodeToken,
  })
  registerProfiEventsRoute(app, {
    db,
    nodeToken: config.nodeToken,
    onEvent: (e) =>
      routeProfiEvent(
        { db, onOrderSeen: (x) => lp.onOrderSeen(x), onAccountEvent: accountEvents },
        e,
      ),
  })
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    scoped.get('/api/metrics/speed', async () => speedReport(db))
  })
  const url = await app.listen({ port: config.port, host: config.host })

  const token = await secrets.get('telegram_bot_token')
  if (token) await bot.start(token).catch((e) => console.error('Telegram bot did not start', e))

  return {
    url,
    app,
    db,
    secrets,
    bot,
    pipeline: lp,
    async close() {
      await bot.stop()
      await app.close()
      await shutdownDbos()
      await closeDb()
    },
  }
}
