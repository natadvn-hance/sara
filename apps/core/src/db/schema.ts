import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

export const core = pgSchema('core')

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })

export const event = core.table(
  'event',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    v: integer('v').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    accountId: text('account_id'),
    actor: text('actor').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    recordedAt: ts('recorded_at').notNull().defaultNow(),
    causationId: uuid('causation_id'),
    correlationId: uuid('correlation_id').notNull(),
    reason: text('reason'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    index('event_entity_idx').on(t.entityKind, t.entityId),
    index('event_correlation_idx').on(t.correlationId),
    index('event_type_idx').on(t.type, t.occurredAt),
  ],
)

export const lead = core.table('lead', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  city: text('city').notNull(),
  text: text('text').notNull(),
  clientName: text('client_name').notNull(),
  budgetText: text('budget_text'),
  bidPriceRub: integer('bid_price_rub').notNull(),
  seenAt: ts('seen_at').notNull(),
  status: text('status').notNull().default('new'),
  correlationId: uuid('correlation_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** The bid text with its greeting (FR-LEAD-6): the Analyst's draft or Boris's edit; null: none yet. */
  draftText: text('draft_text'),
  /** The «Стоимость услуги» for the bid form; null leaves the field empty. */
  draftPriceRub: integer('draft_price_rub'),
  /** The top of the price range of the draft, «до»; null: half again over «от» (31.10.2026). */
  draftPriceToRub: integer('draft_price_to_rub'),
  /** The Analyst's reading of the order and its short разбор (hidden need, risk, condition); null: none. */
  draftAnalysis: jsonb('draft_analysis'),
  /** What the order page says about the client (contract ClientInfo), read when the order page is opened. */
  clientInfo: jsonb('client_info'),
  /**
   * The series after the bid (Boris, 29.10.2026): the texts of the one or two short messages that follow it into the
   * order's chat, a case's link already in; null: none written (a lead from before the series, or none fitted).
   */
  draftFollowUps: jsonb('draft_follow_ups').$type<string[]>(),
  /**
   * Stage 1 «Отсев» (contract LeadScreen, docs/product/lead-analysis.md): the criteria that fired with their quotes,
   * the unclear ones and those without data; null: an order not screened (before the screen, or the screen off).
   */
  screen: jsonb('screen'),
  /**
   * The client's own site as Sara read it (contract LeadSite): the read with its short summary against the order, and the
   * domains of example sites the client named. Null: the order and the chat name no site.
   */
  clientSite: jsonb('client_site'),
})

/**
 * The pages of a client's site, read once a day per domain (Boris, 30.10.2026): the text and facts the code took out of
 * them, never the HTML. A day's cache keeps the site from being asked twice for two orders or two turns of one chat.
 */
export const siteCache = core.table('site_cache', {
  domain: text('domain').primaryKey(),
  url: text('url').notNull(),
  /** 'ok' the home page opened; 'failed' it did not (`error` says why, kept a shorter time). */
  status: text('status').notNull(),
  error: text('error'),
  /** Whether the pages beyond the home page were read too. */
  deep: boolean('deep').notNull().default(false),
  cms: text('cms'),
  signals: jsonb('signals'),
  pages: jsonb('pages').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
})

export const account = core.table('account', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  profiProfileId: text('profi_profile_id'),
  loginState: text('login_state').notNull().default('unknown'),
  presence: boolean('presence').notNull().default(false),
  egressIp: text('egress_ip').notNull(),
  balanceRub: integer('balance_rub'),
  balanceAt: ts('balance_at'),
  paused: boolean('paused').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const deal = core.table('deal', {
  id: uuid('id').primaryKey(),
  leadId: text('lead_id')
    .notNull()
    .unique()
    .references(() => lead.id),
  accountId: text('account_id').notNull(),
  stage: text('stage').notNull(),
  owner: text('owner').notNull().default('sara'),
  turn: text('turn').notNull().default('client'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const task = core.table('task', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  entityKind: text('entity_kind').notNull(),
  entityId: text('entity_id').notNull(),
  priority: text('priority').notNull().default('P1'),
  dueAt: ts('due_at'),
  state: text('state').notNull().default('open'),
  resolution: text('resolution'),
  resolvedAt: ts('resolved_at'),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const outbox = core.table(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    confirmedAt: ts('confirmed_at'),
    errorClass: text('error_class'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  // Whatever the key, one order never has two bids (FR-LEAD-4): the database itself refuses the second.
  (t) => [
    uniqueIndex('outbox_one_bid_per_order')
      .on(sql`(${t.payload}->>'leadId')`)
      .where(sql`${t.kind} = 'bid'`),
  ],
)

/** What each direction that judged an order said about it (FR-LEAD-4); the router picks one from these. */
export const leadCandidate = core.table(
  'lead_candidate',
  {
    orderId: text('order_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Null when the Scorer gave no answer (the order then comes unscored). */
    score: integer('score'),
    /** show, drop or unscored. */
    decision: text('decision').notNull(),
    stopFactor: text('stop_factor'),
    /** The score over this direction's own threshold: comparable between directions, the scores are not. */
    margin: integer('margin'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.accountId] })],
)

/** Which direction got the order: decided once and never reopened. No account means nobody fit. */
export const leadRoute = core.table('lead_route', {
  orderId: text('order_id').primaryKey(),
  accountId: text('account_id'),
  /** none or routed. */
  state: text('state').notNull(),
  needsChoice: boolean('needs_choice').notNull().default(false),
  /** The other directions that fit, by account id. */
  alternatives: jsonb('alternatives').notNull(),
  decidedAt: ts('decided_at').notNull().defaultNow(),
})

export const modelCall = core.table('model_call', {
  id: uuid('id').primaryKey(),
  role: text('role').notNull(),
  roleVersion: integer('role_version').notNull(),
  model: text('model').notNull(),
  priority: text('priority').notNull(),
  startedAt: ts('started_at').notNull(),
  durationMs: integer('duration_ms').notNull(),
  ok: boolean('ok').notNull(),
  errorClass: text('error_class'),
  pseudonymized: boolean('pseudonymized').notNull().default(false),
})

export const setting = core.table('setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  changedBy: text('changed_by').notNull(),
  changedAt: ts('changed_at').notNull().defaultNow(),
})

export const settingHistory = core.table('setting_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  changedBy: text('changed_by').notNull(),
  changedAt: ts('changed_at').notNull().defaultNow(),
})

export const ownerAuth = core.table(
  'owner_auth',
  {
    id: integer('id').primaryKey().default(1),
    passwordHash: text('password_hash'),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('owner_auth_single_row', sql`${t.id} = 1`)],
)

/** Boris's forum (docs/product/telegram-forum.md): the group with topics his messages go to once he bound it. */
export const telegramForum = core.table(
  'telegram_forum',
  {
    id: integer('id').primaryKey().default(1),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    title: text('title'),
    /** The topic of new orders; null in the General topic. */
    leadsThreadId: integer('leads_thread_id'),
    /** The topic «📊 Аналитика» (Boris, 01.11.2026), made by Sara on the first hypothesis; null: not made yet. */
    analyticsThreadId: integer('analytics_thread_id'),
    boundAt: ts('bound_at').notNull().defaultNow(),
  },
  (t) => [check('telegram_forum_single_row', sql`${t.id} = 1`)],
)

/**
 * A hypothesis of the «📊 Аналитика» topic (docs/product/analytics-hypotheses.md): what Sara told Boris, with the numbers it
 * stands on, and what he answered. `preview` is a run that only showed (nothing was sent).
 */
export const analyticsHypothesis = core.table('analytics_hypothesis', {
  id: uuid('id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  level: text('level').notNull(),
  status: text('status').notNull(),
  text: text('text').notNull(),
  facts: jsonb('facts').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  decidedAt: ts('decided_at'),
})

/** The topic of one client's order in a forum; the key is the order's number, `conv:<id>` for a chat without one. */
export const forumTopic = core.table(
  'forum_topic',
  {
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    key: text('key').notNull(),
    threadId: integer('thread_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** The name without the stage a closed topic gets. */
    name: text('name').notNull(),
    closedAt: ts('closed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.key] }),
    uniqueIndex('forum_topic_thread').on(t.chatId, t.threadId),
  ],
)

/**
 * A message in a forum. The core knows it by this row's id with a minus, and a message of Boris's own chat by its
 * Telegram number, so the numbers of the two chats never meet in a task or a card.
 */
export const telegramPost = core.table(
  'telegram_post',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: integer('message_id').notNull(),
    threadId: integer('thread_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('telegram_post_message').on(t.chatId, t.messageId)],
)

/** Versions of an account's direction rules (FR-ACC-2); exactly one is active per account. */
export const directionVersion = core.table(
  'direction_version',
  {
    accountId: text('account_id').notNull(),
    version: integer('version').notNull(),
    rules: jsonb('rules').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    reason: text('reason').notNull(),
    active: boolean('active').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.version] }),
    uniqueIndex('direction_version_one_active').on(t.accountId).where(sql`${t.active}`),
  ],
)

/** The Scorer's verdicts (FR-LEAD-3); backtest rows are trial scores under proposed rules, never acted on. */
export const leadScore = core.table(
  'lead_score',
  {
    id: uuid('id').primaryKey(),
    leadId: text('lead_id').notNull(),
    version: integer('version').notNull(),
    score: integer('score').notNull(),
    decision: text('decision').notNull(),
    stopFactor: text('stop_factor'),
    redFlags: jsonb('red_flags').notNull(),
    axes: jsonb('axes').notNull(),
    reason: text('reason').notNull(),
    confidence: real('confidence').notNull(),
    model: text('model').notNull(),
    backtest: boolean('backtest').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('lead_score_lead').on(t.leadId, t.backtest)],
)

/** Boris's decision on a lead, the example the rules learn from; one per lead. */
export const leadLabel = core.table('lead_label', {
  leadId: text('lead_id').primaryKey(),
  label: text('label').notNull(),
  source: text('source').notNull(),
  reason: text('reason'),
  voice: boolean('voice').notNull().default(false),
  score: integer('score'),
  scoreVersion: integer('score_version'),
  surprise: boolean('surprise').notNull().default(false),
  at: ts('at').notNull().defaultNow(),
})

/** Sara's «почему?» to Boris and his answer in his own words. */
export const question = core.table(
  'question',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    entityId: text('entity_id').notNull(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    askedAt: ts('asked_at').notNull().defaultNow(),
    answeredAt: ts('answered_at'),
    answer: text('answer'),
  },
  (t) => [index('question_open').on(t.answeredAt, t.askedAt)],
)

/** Once-a-day jobs: the row for a day is inserted by the one run that does the job. */
export const jobRun = core.table(
  'job_run',
  { name: text('name').notNull(), day: date('day', { mode: 'string' }).notNull() },
  (t) => [primaryKey({ columns: [t.name, t.day] })],
)

/** A change of the direction rules Sara proposed; it applies only on Boris's «Применить» (FR-MIND-3). */
export const ruleProposal = core.table('rule_proposal', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull(),
  fromVersion: integer('from_version').notNull(),
  rules: jsonb('rules').notNull(),
  summary: text('summary').notNull(),
  why: text('why').notNull(),
  backtest: jsonb('backtest').notNull(),
  state: text('state').notNull(),
  taskId: uuid('task_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  decidedAt: ts('decided_at'),
})

/**
 * What a direction holds besides its scoring rules (FR-ACC-2): its state, speed mode, reply format and case
 * library. One row per account; every change grows `version` and is journaled.
 */
export const directionProfile = core.table('direction_profile', {
  accountId: text('account_id').primaryKey(),
  // A row nobody gave a state does not win orders: only a seed or Boris's save makes a direction work.
  state: text('state').notNull().default('draft'),
  speed: text('speed').notNull().default('normal'),
  replyFormat: jsonb('reply_format'),
  cases: jsonb('cases').notNull().default(sql`'[]'::jsonb`),
  /** 0: the seeded row nobody has changed; every save adds one. */
  version: integer('version').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

// M4: conversations, the mind index and the exam (M4 design 5.15, ADR-024).

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

/** One chat of an account: who leads the client and how far Sara has answered (ADR-024). */
export const conversation = core.table(
  'conversation',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    chatId: text('chat_id').notNull(),
    orderId: text('order_id'),
    /** The deal when the new Sara made the bid; null for chats begun by old Sara's bid. */
    dealId: uuid('deal_id').references(() => deal.id),
    origin: text('origin').notNull().default('v1'),
    owner: text('owner').notNull().default('sara'),
    /** Why Boris leads: «Беру сам» (take) or he wrote himself after the switch (wrote). */
    ownerReason: text('owner_reason'),
    borisNote: text('boris_note'),
    closedAt: ts('closed_at'),
    /** The last client message a finished turn answered. */
    handledThrough: text('handled_through'),
    lastClientHeardAt: ts('last_client_heard_at'),
    typingAt: ts('typing_at'),
    unclearCount: integer('unclear_count').notNull().default(0),
    /** Pult v2: Boris's own note on the client for the client log, never told to Sara (that is `boris_note`). */
    note: text('note'),
    /** Pult v2: the service of the deal, as Boris names it («стратегия», «сайт»). */
    service: text('service'),
    /** Pult v2: how the deal ended, by Boris: `won` (a contract) or `lost`; null while it goes on. */
    outcome: text('outcome'),
    outcomeReason: text('outcome_reason'),
    amountRub: integer('amount_rub'),
    outcomeAt: ts('outcome_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversation_account_chat').on(t.accountId, t.chatId)],
)

/**
 * Where the reminders «клиент ждёт ответа» of a conversation stand (Boris, 31.10: a client must never be left without
 * an answer): the last client message they are about, how many steps of the ladder went, when, and the message of the
 * last one in Telegram, which the next one replaces. The row goes when the client is answered, taken or closed.
 */
export const convOwed = core.table('conv_owed', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversation.id),
  anchorMessageId: text('anchor_message_id').notNull(),
  steps: integer('steps').notNull().default(0),
  lastAt: ts('last_at'),
  messageId: bigint('message_id', { mode: 'number' }),
})

/**
 * The once-only micro-steps shown in a client's topic («Клиент прочитал отклик», «Созвон назначен», «Заказ закрыт на
 * сайте»), by the topic's key and the step: a row is the step shown.
 */
export const topicStep = core.table(
  'topic_step',
  { key: text('key').notNull(), step: text('step').notNull() },
  (t) => [primaryKey({ columns: [t.key, t.step] })],
)

/**
 * What a client's topic already shows (Boris, 01.11: the topic is the chat with the client, every message once): the
 * intro, the bid, the messages after it and the chat messages, by the topic's key and a reference (`bid`, `series:2`,
 * `msg:<platform id>`, `restored`). The restore of old history reads it so that nothing is shown twice.
 */
export const topicShown = core.table(
  'topic_shown',
  { key: text('key').notNull(), ref: text('ref').notNull() },
  (t) => [primaryKey({ columns: [t.key, t.ref] })],
)

/** Every chat message Sara knows, live or exported from history, with whose voice it is (FR-CONV-2, FR-TRAIN-1). */
export const chatMessage = core.table(
  'chat_message',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    chatId: text('chat_id').notNull(),
    orderId: text('order_id'),
    platformMessageId: text('platform_message_id').notNull(),
    side: text('side').notNull(),
    author: text('author').notNull(),
    authorBasis: text('author_basis').notNull(),
    text: text('text').notNull(),
    sentAt: ts('sent_at').notNull(),
    /** The time is the moment of reading, not of sending (a history reading or a v1-only message). */
    approxTime: boolean('approx_time').notNull().default(false),
    read: boolean('read').notNull().default(false),
    source: text('source').notNull(),
    conversationId: uuid('conversation_id').references(() => conversation.id),
    /** When the core first saw it (its own clock, truer than the page's HH:MM). */
    heardAt: ts('heard_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_message_platform').on(t.accountId, t.platformMessageId),
    index('chat_message_conversation').on(t.conversationId, t.sentAt),
  ],
)

/** The trace of one turn, from hearing the client to what went out (FR-CONV-3, FR-OPS-4). */
export const convTurn = core.table(
  'conv_turn',
  {
    id: text('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id),
    kind: text('kind').notNull().default('reply'),
    anchorMessageId: text('anchor_message_id').notNull(),
    messageIds: jsonb('message_ids').notNull().default([]),
    state: text('state').notNull().default('started'),
    mindVersion: text('mind_version'),
    recalled: jsonb('recalled'),
    understanding: jsonb('understanding'),
    move: text('move'),
    urgent: boolean('urgent').notNull().default(false),
    text: text('text'),
    factIds: jsonb('fact_ids').notNull().default([]),
    exampleIds: jsonb('example_ids').notNull().default([]),
    missing: text('missing'),
    checks: jsonb('checks'),
    decision: text('decision'),
    decisionReason: text('decision_reason'),
    outcome: text('outcome'),
    modelCallIds: jsonb('model_call_ids').notNull().default([]),
    taskId: uuid('task_id'),
    cardMessageId: bigint('card_message_id', { mode: 'number' }),
    borisText: text('boris_text'),
    actualMessageId: text('actual_message_id'),
    actualAuthor: text('actual_author'),
    similarity: integer('similarity'),
    timings: jsonb('timings').notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('conv_turn_conversation').on(t.conversationId, t.createdAt)],
)

/**
 * One reply of Boris shown in the daily post (FR-SPEECH-5): the row is what keeps a pair from coming twice and what the
 * post is drawn from on each press. The texts are as Boris saw them: client data behind tags, his typos fixed. A row's
 * id is the id of the task behind its buttons.
 */
export const replyPick = core.table(
  'reply_pick',
  {
    id: uuid('id').primaryKey(),
    turnId: text('turn_id').notNull().unique(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id),
    /** The first of Boris's messages in the reply: two turns over one client message show him once. */
    firstMessageId: text('first_message_id').notNull(),
    /** When the last of them was sent: what the client's answer is counted from. */
    repliedAt: ts('replied_at').notNull(),
    similarity: integer('similarity').notNull(),
    /** Its place in the post, from 0. */
    position: integer('position').notNull(),
    clientText: text('client_text').notNull(),
    draftText: text('draft_text').notNull(),
    replyText: text('reply_text').notNull(),
    /** The words of a commercial promise found in the reply. */
    promises: jsonb('promises').$type<string[]>().notNull().default([]),
    postMessageId: bigint('post_message_id', { mode: 'number' }),
    /** The button pressed: `apply` («В образцы») or `drop` («Не надо»); null while it waits. */
    decision: text('decision'),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reply_pick_reply').on(t.conversationId, t.firstMessageId)],
)

/** The searchable copy of the confirmed mind records (FR-MIND-2); proposals never get here (FR-MIND-3). */
export const mindIndex = core.table(
  'mind_index',
  {
    recordId: text('record_id').primaryKey(),
    path: text('path').notNull(),
    type: text('type').notNull(),
    scope: text('scope').notNull(),
    topic: text('topic'),
    tones: jsonb('tones').notNull().default([]),
    stages: jsonb('stages').notNull().default([]),
    title: text('title').notNull(),
    body: text('body').notNull(),
    exampleClient: text('example_client'),
    exampleBoris: text('example_boris'),
    version: integer('version').notNull(),
    mindVersion: text('mind_version').notNull(),
    tsv: tsvector('tsv').notNull(),
    embedding: vector('embedding', { dimensions: 384 }),
  },
  (t) => [index('mind_index_tsv').using('gin', t.tsv)],
)

/** What a turn lacked to answer (FR-MIND-4): the most frequent becomes a question to Boris. */
export const mindGap = core.table('mind_gap', {
  id: uuid('id').primaryKey(),
  turnId: text('turn_id').notNull(),
  text: text('text').notNull(),
  topic: text('topic'),
  questionId: uuid('question_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** M5: the interview lesson that closed the gap. */
  lessonId: uuid('lesson_id'),
})

/** A file Sara proposes for the mind; it reaches sara-mind only through a developer and Boris's «да». */
export const mindProposal = core.table('mind_proposal', {
  id: uuid('id').primaryKey(),
  path: text('path').notNull().unique(),
  content: text('content').notNull(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  state: text('state').notNull().default('new'),
  createdAt: ts('created_at').notNull().defaultNow(),
  exportedAt: ts('exported_at'),
  // M5 (ADR-025): the lesson Boris says «да» to, and what the mind writer builds from it.
  lessonId: uuid('lesson_id'),
  action: text('action').notNull().default('create'),
  recordId: text('record_id'),
  section: text('section'),
  baseVersion: integer('base_version'),
  /** The fields and sections the writer builds the file from; empty on M4's rows, which carry `content` whole. */
  change: jsonb('change'),
  decidedAt: ts('decided_at'),
  commitId: uuid('commit_id'),
  rejectReason: text('reject_reason'),
})

/** One exam run (FR-TRAIN-8). */
export const examRun = core.table('exam_run', {
  id: uuid('id').primaryKey(),
  mindVersion: text('mind_version').notNull(),
  rolesVersion: jsonb('roles_version').notNull(),
  scenarioSet: text('scenario_set').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  score: real('score'),
  s1: integer('s1').notNull().default(0),
  s2: integer('s2').notNull().default(0),
  s3: integer('s3').notNull().default(0),
  passed: boolean('passed'),
  comparedTo: uuid('compared_to'),
  /** M5: before a deploy, the weekly run or the golden run after a day of lessons. */
  kind: text('kind').notNull().default('deploy'),
  /** M5: the mind commit or version that started the run. */
  trigger: text('trigger'),
})

export const examResult = core.table(
  'exam_result',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => examRun.id),
    scenarioId: text('scenario_id').notNull(),
    move: text('move'),
    text: text('text'),
    checks: jsonb('checks').notNull().default([]),
    judge: jsonb('judge'),
    severity: text('severity'),
    score: real('score').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.scenarioId] })],
)

/** An open onboarding of a direction (FR-ACC-3): the draft Boris builds step by step; one row per account. */
export const directionOnboarding = core.table('direction_onboarding', {
  accountId: text('account_id').primaryKey(),
  mode: text('mode').notNull(),
  /** The active rules version the draft started from; finishing over a newer one is refused. */
  basedOnVersion: integer('based_on_version'),
  draft: jsonb('draft').notNull(),
  state: text('state').notNull().default('open'),
  startedAt: ts('started_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/**
 * Why Boris saved a rules version below the calibration target (his words, so never in the journal). Kept for
 * good: the draft row that first held it is replaced by the next onboarding.
 */
export const directionOverride = core.table(
  'direction_override',
  {
    accountId: text('account_id').notNull(),
    version: integer('version').notNull(),
    reason: text('reason').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.version] })],
)

/**
 * Scores made to try rules out (a recompute, a calibration), cached by the rules' hash so the same lead under the
 * same rules and the same scorer prompt is never paid for twice. They never act on a lead.
 */
export const trialScore = core.table(
  'trial_score',
  {
    rulesHash: text('rules_hash').notNull(),
    leadId: text('lead_id').notNull(),
    /** 'plain': haiku only; 'escalated': as in work, sonnet near the threshold. */
    mode: text('mode').notNull(),
    roleVersion: integer('role_version').notNull(),
    score: integer('score').notNull(),
    decision: text('decision').notNull(),
    stopFactor: text('stop_factor'),
    redFlags: jsonb('red_flags').notNull(),
    axes: jsonb('axes').notNull(),
    reason: text('reason').notNull(),
    confidence: real('confidence').notNull(),
    model: text('model').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rulesHash, t.leadId, t.mode, t.roleVersion] })],
)

/**
 * A long job over a direction's rules that Boris watches (FR-ACC-5, FR-ACC-4): a recompute on the last leads or a
 * calibration. Its leads are fixed at the start, its scores are in `trial_score`, so a restart continues it. One
 * job at a time is waiting or running.
 */
export const directionRun = core.table('direction_run', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull(),
  kind: text('kind').notNull(),
  /** The rules being tried. */
  rules: jsonb('rules').notNull(),
  rulesHash: text('rules_hash').notNull(),
  /** The rules to compare with (the active ones at the start); null when nothing is compared. */
  baseRules: jsonb('base_rules'),
  baseHash: text('base_hash'),
  leadIds: jsonb('lead_ids').notNull(),
  seed: integer('seed').notNull().default(0),
  state: text('state').notNull().default('queued'),
  total: integer('total').notNull(),
  done: integer('done').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  stopReason: text('stop_reason'),
  /** The scorer prompt version the run scored with; its result reads only scores of this version. */
  scorerVersion: integer('scorer_version'),
  /** Touched at the start and after every lead: a run nobody touched for long is a dead one. */
  updatedAt: ts('updated_at').notNull().defaultNow(),
  /** The latest rules change Sara proposed after this run (calibration): summary, why, the lines and the rules. */
  advice: jsonb('advice'),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
})

/** One lead of a calibration and Boris's mark on it (FR-ACC-4); the score stays hidden until he has marked all. */
export const calibrationItem = core.table(
  'calibration_item',
  {
    runId: uuid('run_id').notNull(),
    leadId: text('lead_id').notNull(),
    position: integer('position').notNull(),
    /** 'yes' (would take it), 'no', 'unsure'; null: not marked yet. */
    mark: text('mark'),
    /** Why Boris decided so, in his words, when he wrote it (never in the journal). */
    note: text('note'),
    markedAt: ts('marked_at'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.leadId] })],
)

// M5: lessons, mind commits, the trainer and the school (M5 design 5.19).

/** One thing Boris taught Sara (FR-TRAIN-6): was, became, the insight; its proposals wait for his «да». */
export const lesson = core.table(
  'lesson',
  {
    id: uuid('id').primaryKey(),
    /** The serial number: record ids `e-l-<n>` and `k-i-<n>` come from it (a uuid v7 starts with the minute). */
    n: bigserial('n', { mode: 'number' }).notNull().unique(),
    source: text('source').notNull(),
    sourceRef: text('source_ref').notNull(),
    scope: text('scope').notNull().default('shared'),
    topic: text('topic'),
    tone: text('tone'),
    questionType: text('question_type'),
    /** The client's line, without the name and contacts. */
    clientText: text('client_text'),
    before: text('before'),
    after: text('after'),
    insight: text('insight').notNull().default(''),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('new'),
    /** Decided where Boris was (trainer, interview), not in a batch. */
    inPlace: boolean('in_place').notNull().default(false),
    /** Made from a generated client line: it never gives an example (FR-TRAIN-9). */
    sim: boolean('sim').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    batchId: uuid('batch_id'),
    taskId: uuid('task_id'),
    reason: text('reason'),
    modelCallId: uuid('model_call_id'),
    commitId: uuid('commit_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    uniqueIndex('lesson_source_ref').on(t.source, t.sourceRef),
    index('lesson_state').on(t.state, t.createdAt),
  ],
)

/** Lessons sent to Boris in one Telegram message (FR-TRAIN-6). */
export const lessonBatch = core.table('lesson_batch', {
  id: uuid('id').primaryKey(),
  lessonIds: jsonb('lesson_ids').notNull().default([]),
  taskId: uuid('task_id'),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  sentAt: ts('sent_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  commitId: uuid('commit_id'),
})

/** A commit the mind writer made in sara-mind (ADR-025); its id is the commit's `Sara-Commit:` line. */
export const mindCommit = core.table('mind_commit', {
  id: uuid('id').primaryKey(),
  sha: text('sha').notNull(),
  kind: text('kind').notNull(),
  proposalIds: jsonb('proposal_ids').notNull().default([]),
  lessonIds: jsonb('lesson_ids').notNull().default([]),
  mindVersionBefore: text('mind_version_before'),
  revertsId: uuid('reverts_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  pushedAt: ts('pushed_at'),
})

/** A made-up client for the trainer, built from real Profi.ru chats without their words (FR-TRAIN-2). */
export const persona = core.table(
  'persona',
  {
    id: text('id').primaryKey(),
    archetype: text('archetype').notNull(),
    niche: text('niche').notNull(),
    task: text('task').notNull(),
    mood: text('mood').notNull(),
    style: text('style').notNull().default(''),
    questions: jsonb('questions').notNull().default([]),
    topics: jsonb('topics').notNull().default([]),
    order: jsonb('order').notNull(),
    difficulty: integer('difficulty').notNull(),
    hard: boolean('hard').notNull().default(false),
    sourceRefs: jsonb('source_refs').notNull(),
    handmade: boolean('handmade').notNull().default(false),
    active: boolean('active').notNull().default(true),
    builtAt: ts('built_at').notNull().defaultNow(),
    runId: uuid('run_id'),
  },
  (t) => [check('persona_sources', sql`jsonb_array_length(${t.sourceRefs}) > 0`)],
)

/** One training of Boris's in the trainer (FR-TRAIN-3), or the week's blind test (mode `blind`). */
export const trainingSession = core.table('training_session', {
  id: uuid('id').primaryKey(),
  mode: text('mode').notNull(),
  personaId: text('persona_id'),
  via: text('via').notNull().default('miniapp'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
  endedBy: text('ended_by'),
  itemsCount: integer('items_count').notNull().default(0),
  avgSimilarity: real('avg_similarity'),
  lessonsYes: integer('lessons_yes').notNull().default(0),
  mindVersion: text('mind_version'),
})

/** One card of a training: the client's line, Sara's variant, Boris's answer or verdict (FR-TRAIN-4). */
export const trainingItem = core.table(
  'training_item',
  {
    id: uuid('id').primaryKey(),
    /** Empty while the card waits, prepared at night. */
    sessionId: uuid('session_id').references(() => trainingSession.id),
    mode: text('mode').notNull(),
    state: text('state').notNull().default('prepared'),
    personaId: text('persona_id'),
    /** The real chat behind the card: guess, blind and golden keep apart pools of chats. */
    chatId: text('chat_id'),
    sourceRef: text('source_ref'),
    dialog: jsonb('dialog').notNull().default([]),
    clientText: text('client_text'),
    saraText: text('sara_text'),
    saraPlan: jsonb('sara_plan'),
    borisText: text('boris_text'),
    realBorisText: text('real_boris_text'),
    similarity: integer('similarity'),
    verdict: text('verdict'),
    topic: text('topic'),
    tone: text('tone'),
    questionType: text('question_type'),
    blindWeek: date('blind_week', { mode: 'string' }),
    blindFlip: boolean('blind_flip'),
    judge: jsonb('judge'),
    lessonId: uuid('lesson_id'),
    modelCallIds: jsonb('model_call_ids').notNull().default([]),
    mindVersion: text('mind_version'),
    preparedAt: ts('prepared_at').notNull().defaultNow(),
    answeredAt: ts('answered_at'),
  },
  (t) => [
    index('training_item_mode').on(t.mode, t.state, t.preparedAt),
    index('training_item_chat').on(t.chatId),
  ],
)

/** The client lines of a made-up dialog (FR-TRAIN-9): kept 30 days, never knowledge. */
export const simDialog = core.table('sim_dialog', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id'),
  personaId: text('persona_id'),
  clientMessages: jsonb('client_messages').notNull(),
  gaps: jsonb('gaps').notNull().default([]),
  createdAt: ts('created_at').notNull().defaultNow(),
})

/** Approvals in a row and the last edit of a topic (FR-AUTO-3, FR-AUTO-4); the level itself is conv.autonomy. */
export const autonomyCounter = core.table(
  'autonomy_counter',
  {
    topic: text('topic').notNull(),
    scope: text('scope').notNull(),
    streak: integer('streak').notNull().default(0),
    lastEditAt: ts('last_edit_at'),
    lastSubstantialAt: ts('last_substantial_at'),
    lastReason: text('last_reason'),
    lastTurnId: text('last_turn_id'),
    trainerGood: integer('trainer_good').notNull().default(0),
    trainerTotal: integer('trainer_total').notNull().default(0),
    proposedAt: ts('proposed_at'),
    proposalTaskId: uuid('proposal_task_id'),
    snoozedUntil: ts('snoozed_until'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.topic, t.scope] })],
)

/**
 * The Secretary's chat with Boris (ADR-027): his words and Sara's answers, the memory of the conversation. Kept a
 * week: the words may name clients, and the answers to old questions are of no use.
 */
export const secretaryMessage = core.table(
  'secretary_message',
  {
    id: uuid('id').primaryKey(),
    /** 'boris' or 'sara'. */
    author: text('author').notNull(),
    text: text('text').notNull(),
    at: ts('at').notNull().defaultNow(),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  },
  (t) => [index('secretary_message_at').on(t.at)],
)

/**
 * The bell of the pult (pult v2 design 6): every message Sara sends Boris on her own, with its state. `done` is not
 * stored: a notice is done when its task is resolved or its question answered, wherever that happened.
 */
export const notice = core.table(
  'notice',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    link: text('link'),
    taskId: uuid('task_id'),
    questionId: uuid('question_id'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
    seenAt: ts('seen_at'),
    /** A notice without a task or question Boris put away himself. */
    doneAt: ts('done_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('notice_created').on(t.createdAt), index('notice_task').on(t.taskId)],
)

/**
 * A bid from the pult with ten seconds to cancel (pult v2 design 4, M7 design 6.3): one row per task; `held`, then
 * `cancelled` or `fired`. The hold lives here, so a closed Mini App does not lose it and «Отменить» from any device
 * tells the truth.
 */
export const bidHold = core.table('bid_hold', {
  taskId: uuid('task_id').primaryKey(),
  requestId: uuid('request_id').notNull().unique(),
  state: text('state').notNull(),
  expectedFeeRub: integer('expected_fee_rub').notNull(),
  executeAt: ts('execute_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/**
 * A call with a client (pult v2 design 9): set by Boris in the pult, with its outcome. Calls the chats only speak
 * of (a deal at «созвон предложен») are shown beside these, not stored here.
 */
export const meeting = core.table(
  'meeting',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id'),
    title: text('title').notNull(),
    startsAt: ts('starts_at'),
    channel: text('channel'),
    note: text('note'),
    /** `held`, `missed`, `moved`, `cancelled`; null before. */
    outcome: text('outcome'),
    /**
     * `booked` (a call on the calendar), `maybe` (the chat says they agreed but no firm time: no slot is taken, the stage
     * does not move) or `cancelled`. Meetings Boris wrote down himself are `booked`.
     */
    status: text('status').notNull().default('booked'),
    /** Where the meeting came from: `boris` (written in the pult), `chat` (read from the correspondence), later `call`. */
    source: text('source').notNull().default('boris'),
    /** How the call goes and who calls, as the chat says (`phone`, `telegram`, `video`; `we`, `client`). */
    how: text('how'),
    caller: text('caller'),
    /** The words of the chat the meeting stands on. */
    quote: text('quote'),
    /** The card of the meeting in the client's topic (a post reference), edited in place. */
    cardRef: bigint('card_ref', { mode: 'number' }),
    /** What came of the call, in a line or two, the next step and its day (Moscow, `YYYY-MM-DD`). */
    result: text('result'),
    nextStep: text('next_step'),
    nextStepOn: text('next_step_on'),
    /** Who told it: `lora` (her note of Boris's story), `boris` (his words in the topic). */
    resultSource: text('result_source'),
    resultAt: ts('result_at'),
    /** The time passed with no outcome: the card said so, quietly. */
    expiredAt: ts('expired_at'),
    /** The reminder of the next step, sent once on its day. */
    nextRemindedAt: ts('next_reminded_at'),
    amountRub: integer('amount_rub'),
    createdBy: text('created_by').notNull().default('boris'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('meeting_starts').on(t.startsAt)],
)

/**
 * Boris's Google Sheet (FR-ANL-7, docs/ops/google-sheet.md): one row per bid Sara keeps in his «Лог клиентов». The
 * sheet itself finds the row by its order (developer metadata), so a row Boris moves stays the same row.
 */
export const sheetRow = core.table('sheet_row', {
  orderId: text('order_id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** `new`: not in the sheet yet; `active`: Sara keeps it; `gone`: Boris deleted the row, Sara leaves it be. */
  state: text('state').notNull().default('new'),
  /** What Sara last wrote, column by column: a cell that holds something else is Boris's. */
  written: jsonb('written').$type<Record<string, string | number>>().notNull().default({}),
  /** Columns Boris changed by hand in this row: Sara never writes them again. */
  boris: jsonb('boris').$type<string[]>().notNull().default([]),
  /** Since when the sheet lags behind what Sara knows of this bid; null: it has it all. */
  pendingSince: ts('pending_since'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** The link to Boris's sheet: since when bids go there, the last answer, the last failure and the next try. */
export const sheetSync = core.table(
  'sheet_sync',
  {
    id: integer('id').primaryKey().default(1),
    /** Bids from this moment on go to the sheet; the earlier ones wait for Boris's «Внести» (`backfill`). */
    since: ts('since').notNull(),
    /** The past bids: `none` (not offered yet), `asked` (the preview waits for Boris), `running`, `done`, `declined`. */
    backfill: text('backfill').notNull().default('none'),
    backfillMessageId: bigint('backfill_message_id', { mode: 'number' }),
    lastOkAt: ts('last_ok_at'),
    lastWriteAt: ts('last_write_at'),
    lastError: text('last_error'),
    lastErrorAt: ts('last_error_at'),
    failures: integer('failures').notNull().default(0),
    nextTryAt: ts('next_try_at'),
  },
  (t) => [check('sheet_sync_single_row', sql`${t.id} = 1`)],
)

/** A browser that asked to ring (pult v2 design 6): one row per Web Push endpoint. */
export const pushSubscription = core.table('push_subscription', {
  endpoint: text('endpoint').primaryKey(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  label: text('label'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** The last push the service refused for a reason other than the subscription being gone. */
  failedAt: ts('failed_at'),
})
