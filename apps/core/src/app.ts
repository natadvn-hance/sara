import { join } from 'node:path'
import type { TaskAction } from '@sara/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { seedAccounts } from './accounts/accounts'
import { createProfiEventDispatcher, routeProfiEvent } from './accounts/profiEvents'
import { speedReport } from './analytics/speed'
import type { AppDeps } from './api/deps'
import { buildServer } from './api/server'
import { requireSession } from './auth/session'
import type { Config } from './config'
import { forwardTurn, sendTurnCard } from './conversation/cards'
import { onConvEdit, onConvPress, onConvReply } from './conversation/commands'
import { compareTurn } from './conversation/compare'
import { startConvDaySummary } from './conversation/daySummary'
import { type ConversationEventDeps, createConversationEvents } from './conversation/events'
import { sendTextNow, sendTurnReply } from './conversation/outbox'
import { startReconcile } from './conversation/reconcile'
import { registerConversationRoutes } from './conversation/routes'
import { pokeTurn, setTurnDeps, startTurnFor } from './conversation/turn'
import { createDb, type Db } from './db/client'
import { migrate } from './db/migrate'
import { task } from './db/schema'
import { applyAmendments } from './direction/amendments'
import { seedProfile } from './direction/profile'
import { resumeRuns } from './direction/runs'
import { seedDirection } from './direction/store'
import { createGateway, withoutLimitWait } from './gateway/gateway'
import { resumeQueuedOutbox, setOutboxDeps } from './leads/outbox'
import { createLeadPipeline, type LeadPipeline } from './leads/pipeline'
import { handleBorisMessage } from './learning/inbox'
import { startLearningJobs } from './learning/jobs'
import { ensureMindIndex } from './mind/indexer'
import { createMindSearch } from './mind/search'
import { createMindWriter } from './mind/writer'
import { type BotControl, createBotControl } from './notify/botControl'
import { createTranscriber } from './notify/transcribe'
import { createProfiClient } from './profi/client'
import { registerProfiEventsRoute } from './profi/eventsRoute'
import { startSchoolJobs } from './school/jobs'
import { registerSchoolRoutes } from './school/routes'
import type { SchoolDeps } from './school/types'
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
  /** A busy account tab is waited for (default every 2 minutes, 10 times). */
  busyRetry?: { delayMs: number; tries: number }
  /** When an unsure bid is looked for on its order (default after 5 minutes, 30 minutes and 2 hours). */
  reconcileDelaysMs?: number[]
  remindAfterMs?: () => Promise<number>
  notifyRetry?: { maxAttempts: number; intervalSeconds: number }
  /** How often the learning jobs run (default a minute); tests call them directly instead. */
  learningTickMs?: number
  /** How often the school's jobs run (default a minute). */
  schoolTickMs?: number
}

/** Puts the whole core together: database, durable processes, gateway, bot, pipeline and HTTP. */
export async function startApp(config: Config, o: StartOptions = {}): Promise<RunningApp> {
  await migrate(config.databaseUrl)
  const { db, close: closeDb } = createDb(config.databaseUrl)
  const secrets = createSecretStore(config.dataDir)
  const profi = createProfiClient({ url: config.profiMcpUrl, permitSecret: config.permitSecret })

  let pipeline: LeadPipeline | null = null
  const commandDeps = (): Parameters<typeof onConvPress>[0] => ({
    db,
    notifier: bot.notifier,
    sendText: (c, text, author) => sendTextNow({ db, profi }, c, text, author),
  })
  // A press on a conversation card goes to the conversation, every other press to the lead pipeline.
  const onPress = async (p: { taskId: string; action: TaskAction }) => {
    const [t] = await db.select({ kind: task.kind }).from(task).where(eq(task.id, p.taskId))
    if (t?.kind.startsWith('conv_')) return onConvPress(commandDeps(), p)
    return pipeline ? pipeline.onPress(p) : 'Сара ещё запускается'
  }
  const transcriber = createTranscriber({
    ffmpegBin: config.ffmpegBin,
    whisperBin: config.whisperBin,
    modelPath: config.whisperModel,
    workDir: join(config.dataDir, 'voice'),
  })
  const bot = createBotControl({
    db,
    apiRoot: config.telegramApiRoot,
    onPress,
    onMessage: (m) =>
      handleBorisMessage(
        {
          db,
          transcriber,
          onDraftText: (a) =>
            pipeline ? pipeline.onDraftText(a) : Promise.resolve('Сара ещё запускается'),
          onCardReply: (r) => onConvReply(commandDeps(), r),
          onConvEdit: (a) => onConvEdit(commandDeps(), a),
        },
        m,
      ),
    voiceDir: join(config.dataDir, 'voice'),
  })
  const gateway = createGateway({
    db,
    secrets,
    claudeBin: config.claudeBin,
    rolesDir: config.rolesDir,
    dataDir: config.dataDir,
    extraEnv: o.claudeEnv,
    notifier: bot.notifier,
  })
  pipeline = createLeadPipeline({
    db,
    gateway,
    notifier: bot.notifier,
    profi,
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
    busyRetry: o.busyRetry ?? { delayMs: 2 * 60_000, tries: 10 },
    reconcileDelaysMs: o.reconcileDelaysMs ?? [5 * 60_000, 30 * 60_000, 2 * 3600_000],
    resendCard: (taskId) => lp.resendCard(taskId),
  })
  setReminderHandler((taskId) => lp.onReminder(taskId))
  // M4: conversations. The mind is read from its folder; an empty or missing mind only makes every turn a draft.
  const mind = createMindSearch(db)
  await ensureMindIndex(db, config.mindDir).catch((e) =>
    console.error('mind index failed', e instanceof Error ? e.message : e),
  )
  const cardDeps = { db, notifier: bot.notifier }
  setTurnDeps({
    db,
    profi,
    gateway,
    mind,
    card: async (id) => {
      await sendTurnCard(cardDeps, id)
    },
    forward: (id) => forwardTurn(cardDeps, id),
    // In shadow the turn never reaches a send; after the switch it goes through the message outbox.
    send: (id, round) => sendTurnReply({ db, profi }, id, round),
  })
  const conversationDeps: ConversationEventDeps = {
    db,
    profi,
    notifier: bot.notifier,
    onTurnNeeded: (c) => startTurnFor(c),
    onTyping: (c) => pokeTurn(c),
    onSpecialist: (c, added) => compareTurn(cardDeps, c.id, added),
  }
  const conversationEvents = createConversationEvents(conversationDeps)
  const accountEvents = createProfiEventDispatcher({
    db,
    notifier: bot.notifier,
    publicUrl: config.publicUrl,
  })
  await launchDbos(config.databaseUrl)

  const deps: AppDeps = {
    db,
    secrets,
    gateway,
    profi,
    bot,
    rolesDir: config.rolesDir,
    production: config.production,
    telegramApiRoot: config.telegramApiRoot,
    accounts: config.accounts,
  }
  await seedAccounts(db, config.accounts)
  for (const a of config.accounts) {
    await seedDirection(db, a.id)
    await seedProfile(db, a.id)
    // Rules Boris dictated to a developer become his new version, once (FR-MIND-3).
    await applyAmendments(db, a.id)
  }
  // A check cut off by a restart goes on (its finished scores are cached), through a limit it does not wait.
  await resumeRuns({ db, gateway: withoutLimitWait(gateway), rolesDir: config.rolesDir })
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
        {
          db,
          onOrderSeen: (x) => lp.onOrderSeen(x),
          onAccountEvent: accountEvents,
          onConversationEvent: conversationEvents,
        },
        e,
      ),
  })
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    scoped.get('/api/metrics/speed', async () => speedReport(db))
  })
  const school: SchoolDeps = {
    db,
    // Night jobs meet a limit at once instead of standing still for hours (NFR-COST-2).
    gateway: withoutLimitWait(gateway),
    notifier: bot.notifier,
    mind: createMindSearch(db),
    writer: createMindWriter({
      db,
      mindDir: config.mindDir,
      secrets,
      reindex: async () => {
        await ensureMindIndex(db, config.mindDir)
      },
    }),
    accountIds: config.accounts.map((a) => a.id),
    mindDir: config.mindDir,
    publicUrl: config.publicUrl,
  }
  registerSchoolRoutes(app, school)
  registerConversationRoutes(app, commandDeps())
  const url = await app.listen({ port: config.port, host: config.host })

  const token = await secrets.get('telegram_bot_token')
  if (token) await bot.start(token).catch((e) => console.error('Telegram bot did not start', e))
  // Bids whose delivery never started (a crash right after Boris's press) are picked up now, once the bot can
  // tell Boris about one given back.
  await resumeQueuedOutbox(db)
  const learning = startLearningJobs({
    db,
    notifier: bot.notifier,
    // A minute tick must not stand still for hours: through a limit the learning waits for tomorrow instead.
    gateway: withoutLimitWait(gateway),
    accountIds: config.accounts.map((a) => a.id),
    tickMs: o.learningTickMs,
  })
  const schoolJobs = startSchoolJobs({ ...school, tickMs: o.schoolTickMs })
  const conversationSummary = startConvDaySummary({ db, notifier: bot.notifier }, o.learningTickMs)
  const reconcile = startReconcile(
    conversationDeps,
    config.accounts.map((a) => a.id),
  )

  return {
    url,
    app,
    db,
    secrets,
    bot,
    pipeline: lp,
    async close() {
      learning.stop()
      schoolJobs.stop()
      reconcile.stop()
      conversationSummary.stop()
      gateway.stop()
      await bot.stop()
      await app.close()
      await shutdownDbos()
      await closeDb()
    },
  }
}
