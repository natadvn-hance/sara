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
  /** The Analyst's reading of the order and its short разбор (hidden need, risk, condition); null: none. */
  draftAnalysis: jsonb('draft_analysis'),
  /** What the order page says about the client (contract ClientInfo), read when the order page is opened. */
  clientInfo: jsonb('client_info'),
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

export const outbox = core.table('outbox', {
  id: uuid('id').primaryKey(),
  kind: text('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
  state: text('state').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  confirmedAt: ts('confirmed_at'),
  errorClass: text('error_class'),
  createdAt: ts('created_at').notNull().defaultNow(),
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
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversation_account_chat').on(t.accountId, t.chatId)],
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
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
})
