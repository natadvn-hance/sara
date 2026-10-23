import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
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
