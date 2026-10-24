import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
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
  state: text('state').notNull().default('on'),
  speed: text('speed').notNull().default('normal'),
  replyFormat: jsonb('reply_format'),
  cases: jsonb('cases').notNull().default(sql`'[]'::jsonb`),
  version: integer('version').notNull().default(1),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})
