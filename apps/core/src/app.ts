import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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
import { onClientText, onConvEdit, onConvPress, onConvReply } from './conversation/commands'
import { compareAfterTurn, compareTurn } from './conversation/compare'
import { startConvDaySummary } from './conversation/daySummary'
import { type ConversationEventDeps, createConversationEvents } from './conversation/events'
import { sendTurnReply } from './conversation/outbox'
import { startReconcile } from './conversation/reconcile'
import { reminderGround, setRemindDeps, syncReminders } from './conversation/reminders'
import { registerConversationRoutes } from './conversation/routes'
import { setSendDeps, startSendJob } from './conversation/sendFlow'
import { prepareJob } from './conversation/sendJob'
import { SEND_TEXTS } from './conversation/sendTexts'
import { pokeTurn, setTurnDeps, startTurnFor } from './conversation/turn'
import { createDb, type Db } from './db/client'
import { migrate } from './db/migrate'
import { task } from './db/schema'
import { applyAmendments } from './direction/amendments'
import { seedProfile } from './direction/profile'
import { resumeRuns } from './direction/runs'
import { seedDirection } from './direction/store'
import { createGateway, withoutLimitWait } from './gateway/gateway'
import { type SlotSource, workHoursSource } from './leads/callSlots'
import { cancelHold, holdBid, setHoldDeps } from './leads/hold'
import { resumeQueuedOutbox, setOutboxDeps } from './leads/outbox'
import { createLeadPipeline, type LeadPipeline } from './leads/pipeline'
import { type CardRecheck, startCardRecheck } from './leads/recheck'
import { createRecheckOne } from './leads/recheckOne'
import { SERIES_DELAYS, type SeriesDeps, setSeriesDeps } from './leads/series'
import { type StaleSweep, startStaleSweep } from './leads/staleCards'
import { answerQuestion as answerBorisQuestion, handleBorisMessage } from './learning/inbox'
import { startLearningJobs } from './learning/jobs'
import { DRAFT_KINDS, markAnswered, type QuestionRow, titleOf } from './learning/questions'
import { ensureMindIndex } from './mind/indexer'
import { createMindSearch } from './mind/search'
import { createMindWriter } from './mind/writer'
import { type BotControl, createBotControl } from './notify/botControl'
import { TEXTS } from './notify/cards'
import { createTranscriber } from './notify/transcribe'
import { createProfiClient } from './profi/client'
import { registerProfiEventsRoute } from './profi/eventsRoute'
import { systemView } from './pult/system'
import { startSchoolJobs } from './school/jobs'
import { registerSchoolRoutes } from './school/routes'
import type { SchoolDeps } from './school/types'
import { registerScreenProxy } from './screen/screenProxy'
import { createTurnKeys, registerSecretaryMcp, SECRETARY_MCP_PATH } from './secretary/mcp'
import { createSecretary, type Secretary } from './secretary/secretary'
import type { SecretaryDeps } from './secretary/tools'
import { createSecretStore, type SecretStore } from './secrets/store'
import { getSetting } from './settings/store'
import type { Fetched } from './site/fetch'
import { createResolver, type Press } from './tasks/resolve'
import { launchDbos, shutdownDbos } from './workflows/dbos'
import { setReminderHandler } from './workflows/decisionWait'

/** How often the mind index is checked for records that came into force or went out of it by their dates. */
const MIND_REFRESH_MS = 3600_000

export type RunningApp = {
  url: string
  app: FastifyInstance
  db: Db
  secrets: SecretStore
  bot: BotControl
  pipeline: LeadPipeline
  /** The look at waiting cards (FR-LEAD-5); tests drive it with tick(at). */
  recheck: CardRecheck
  /** The sweep of cards that waited more than a day (FR-LEAD-10); tests call stale.tick instead. */
  stale: StaleSweep
  close(): Promise<void>
}

export type StartOptions = {
  claudeEnv?: () => Record<string, string>
  retryDelaysMs?: number[]
  /** A busy account tab is waited for (default every 2 minutes, 10 times). */
  busyRetry?: { delayMs: number; tries: number }
  /** When an unsure bid is looked for on its order (default after 5 minutes, 30 minutes and 2 hours). */
  reconcileDelaysMs?: number[]
  /** The waits of the series after a bid: before its first message and between the next ones (SERIES_DELAYS). */
  seriesDelayMs?: SeriesDeps['delayMs']
  /** Where the times of the call offer come from (default Boris's working hours); tests fix them. */
  callSlots?: SlotSource
  remindAfterMs?: () => Promise<number>
  notifyRetry?: { maxAttempts: number; intervalSeconds: number }
  /** How often the learning jobs run (default a minute); tests call them directly instead. */
  learningTickMs?: number
  /** How often the school's jobs run (default a minute). */
  schoolTickMs?: number
  /** How often waiting cards are looked at again (default 5 minutes); tests call recheck.tick instead. */
  recheckTickMs?: number
  /** How often cards that waited more than a day are ended (default 5 minutes); tests call stale.tick instead. */
  staleTickMs?: number
  /** The clock of the greeting of a bid (default the real one); tests fix the hour. */
  now?: () => Date
  /** How a page of a client's site is fetched; the tests give a made-up site. */
  siteFetch?: (url: string) => Promise<Fetched>
  /** How a file attached to an order is downloaded; the tests give bytes. */
  fileFetch?: (url: string) => Promise<Fetched>
}

/** Puts the whole core together: database, durable processes, gateway, bot, pipeline and HTTP. */
export async function startApp(config: Config, o: StartOptions = {}): Promise<RunningApp> {
  await migrate(config.databaseUrl)
  const { db, close: closeDb } = createDb(config.databaseUrl)
  const secrets = createSecretStore(config.dataDir)
  const profi = createProfiClient({ url: config.profiMcpUrl, permitSecret: config.permitSecret })

  let pipeline: LeadPipeline | null = null
  // ADR-027: Boris's free words go to the Secretary once the core listens; until then the bot says Sara is starting.
  let secretary: Secretary | null = null
  let secretaryTools: SecretaryDeps | null = null
  const turnKeys = createTurnKeys()
  const commandDeps = (): Parameters<typeof onConvPress>[0] => ({
    db,
    notifier: bot.notifier,
    // A press never holds the bot: the send runs as its own process and Boris gets its result as a new message.
    sendText: async (c, text, author, o) => {
      const job = await prepareJob({ db }, c, text, author, o)
      return job ? startSendJob(job) : SEND_TEXTS.failed
    },
  })
  // A press on a conversation card goes to the conversation, every other press to the lead pipeline; the resolver
  // around it marks the Telegram card when the press came from the pult (pult v2 design 3).
  const press = async (p: Press) => {
    const [t] = await db.select({ kind: task.kind }).from(task).where(eq(task.id, p.taskId))
    if (t?.kind.startsWith('conv_')) return onConvPress(commandDeps(), p)
    return pipeline ? pipeline.onPress(p) : 'Сара ещё запускается'
  }
  const onPress = createResolver({
    db,
    press,
    // The bot is made below with this very press; the card is marked through it once it exists.
    notifier: {
      markDone: async (id, note) => {
        await bot.notifier.markDone?.(id, note)
      },
    },
  })
  /** Boris's answer from the pult takes the same path as his reply in Telegram. */
  const answerQuestion = async (q: QuestionRow, text: string): Promise<string> => {
    const a = { question: q, text, voice: false, at: new Date() }
    if ((DRAFT_KINDS as string[]).includes(q.kind))
      return pipeline ? pipeline.onDraftText(a) : 'Сара ещё запускается'
    if (q.kind === 'conv_edit') {
      const r = await onConvEdit(commandDeps(), a)
      return typeof r === 'string' ? r : r.text
    }
    const ok = await db.transaction((tx) => markAnswered(tx, q, a))
    return ok ? TEXTS.noted(text, await titleOf(db, q)) : TEXTS.notAnAnswer
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
          onSecretary: (w) =>
            secretary ? secretary.take(w) : Promise.resolve('Сара ещё запускается'),
          onClientText: (c) => onClientText(commandDeps(), c),
        },
        m,
      ),
    voiceDir: join(config.dataDir, 'voice'),
    publicUrl: config.publicUrl,
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
    now: o.now,
    mind: createMindSearch(db),
    siteFetch: o.siteFetch,
    fileFetch: o.fileFetch,
  })
  const lp = pipeline
  setOutboxDeps({
    db,
    profi,
    notifier: bot.notifier,
    retryDelaysMs: o.retryDelaysMs ?? [1000, 2000, 4000, 8000, 16000],
    busyRetry: o.busyRetry ?? { delayMs: 2 * 60_000, tries: 10 },
    // The first look a minute after: a bid the node could not see at once is usually on its page by then, and its
    // series still goes in time (30.10.2026).
    reconcileDelaysMs: o.reconcileDelaysMs ?? [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000],
    resendCard: (taskId) => lp.resendCard(taskId),
    closeCard: (taskId) => lp.closeOnSite(taskId, 'press'),
    now: o.now,
  })
  setSeriesDeps({
    db,
    profi,
    delayMs: o.seriesDelayMs ?? SERIES_DELAYS,
    slots: o.callSlots ?? workHoursSource(db),
  })
  setReminderHandler((taskId) => lp.onReminder(taskId))
  secretaryTools = {
    db,
    notifier: bot.notifier,
    onPress,
    saveBidText: (p) => lp.saveBidText(p),
    commands: commandDeps(),
    answerQuestion: (q, a) =>
      answerBorisQuestion(
        {
          db,
          onDraftText: (x) => lp.onDraftText(x),
          onConvEdit: (x) => onConvEdit(commandDeps(), x),
        },
        q,
        a,
      ),
    system: () => systemView(deps),
  }
  // M4: conversations. The mind is read from its folder; an empty or missing mind only makes every turn a draft.
  const mind = createMindSearch(db)
  const refreshMind = () =>
    ensureMindIndex(db, config.mindDir).catch((e) =>
      console.error('mind index failed', e instanceof Error ? e.message : e),
    )
  await refreshMind()
  // Records that come into force or go out of it by their dates are picked up without a restart.
  const mindTimer = setInterval(() => void refreshMind(), MIND_REFRESH_MS)
  mindTimer.unref()
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
    send: (id, round, seenLast) => sendTurnReply({ db, profi }, id, round, seenLast),
    compare: (id) => compareAfterTurn(cardDeps, id),
  })
  // Reminders to clients who went quiet (FR-CONV-12): a durable process per message of ours nobody answered.
  setRemindDeps({ db, profi, gateway, mind, notifier: bot.notifier })
  setSendDeps({ db, profi, notifier: bot.notifier, ground: reminderGround })
  const conversationDeps: ConversationEventDeps = {
    db,
    profi,
    notifier: bot.notifier,
    onTurnNeeded: (c) => startTurnFor(c),
    onTyping: (c) => pokeTurn(c),
    onSpecialist: (c, added) => compareTurn(cardDeps, c.id, added),
    // The reminders follow the chat as read: our message last starts one, a client's message cancels it.
    onChatState: (c, messages) => syncReminders(c, messages),
  }
  const conversationEvents = createConversationEvents(conversationDeps)
  const accountEvents = createProfiEventDispatcher({
    db,
    notifier: bot.notifier,
    publicUrl: config.publicUrl,
  })
  // A bid from the pult waits ten seconds in the core before the same press fires (pult v2 design 4).
  setHoldDeps({ db, press: (p) => onPress(p), notifier: bot.notifier })
  const recheckLead = createRecheckOne({
    db,
    profi,
    close: (taskId) => lp.closeOnSite(taskId, 'recheck'),
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
    onPress,
    answerQuestion,
    bids: { hold: holdBid, cancel: cancelHold, recheck: recheckLead },
    saveBidText: (p) =>
      pipeline
        ? pipeline.saveBidText(p)
        : Promise.resolve({ saved: false, message: 'Сара ещё запускается' }),
    backupLog: config.backupLog,
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
  // The recheck starts below, once the core listens: an order gone from the feed before that waits for its tick.
  let kickRecheck = () => {}
  registerProfiEventsRoute(app, {
    db,
    nodeToken: config.nodeToken,
    onEvent: (e) =>
      routeProfiEvent(
        {
          db,
          onOrderSeen: (x) => lp.onOrderSeen(x),
          onOrderGone: () => kickRecheck(),
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
  registerSecretaryMcp(app, { keys: turnKeys, deps: () => secretaryTools })
  const url = await app.listen({ port: config.port, host: config.host })
  const port = (app.server.address() as AddressInfo).port
  secretary = createSecretary({
    db,
    converse: gateway.converse,
    notifier: bot.notifier,
    keys: turnKeys,
    mcpUrl: () => `http://127.0.0.1:${port}${SECRETARY_MCP_PATH}`,
    dataDir: config.dataDir,
    publicUrl: config.publicUrl,
    titleOf: (q) => titleOf(db, q),
  })

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

  // Waiting cards whose order closed on Profi.ru lose their buttons (FR-LEAD-5).
  const recheck = startCardRecheck({
    db,
    profi,
    notifier: bot.notifier,
    close: (taskId) => lp.closeOnSite(taskId, 'recheck'),
    tickMs: o.recheckTickMs,
    now: o.now,
  })
  kickRecheck = () => recheck.kick()
  // Cards that waited more than a day are no longer offered: ended and turned short, a few at a time (FR-LEAD-10).
  const stale = startStaleSweep({
    db,
    close: (taskId, at) => lp.closeStale(taskId, at),
    tickMs: o.staleTickMs,
    now: o.now,
  })

  return {
    url,
    app,
    db,
    secrets,
    bot,
    pipeline: lp,
    recheck,
    stale,
    async close() {
      recheck.stop()
      stale.stop()
      learning.stop()
      schoolJobs.stop()
      reconcile.stop()
      clearInterval(mindTimer)
      conversationSummary.stop()
      gateway.stop()
      await bot.stop()
      await app.close()
      await shutdownDbos()
      await closeDb()
    },
  }
}
