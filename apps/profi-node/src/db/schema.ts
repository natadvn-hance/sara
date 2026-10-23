import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/** Raw platform data. Only Profi-MCP writes here; kept apart so it can move to a Russian database (ADR-022). */
export const node = pgSchema('node')

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })

export const rawEvent = node.table(
  'raw_event',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    kind: text('kind').notNull(),
    receivedAt: ts('received_at').notNull(),
    url: text('url'),
    body: jsonb('body').notNull(),
  },
  (t) => [index('raw_event_received_idx').on(t.receivedAt)],
)

export const rawOrder = node.table(
  'raw_order',
  {
    orderId: text('order_id').notNull(),
    accountId: text('account_id').notNull(),
    seenAt: ts('seen_at').notNull(),
    body: jsonb('body').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.accountId] })],
)

export const rawMessage = node.table('raw_message', {
  platformMessageId: text('platform_message_id').primaryKey(),
  chatId: text('chat_id').notNull(),
  accountId: text('account_id').notNull(),
  orderId: text('order_id'),
  author: text('author').notNull(),
  sentAt: ts('sent_at').notNull(),
  text: text('text').notNull(),
  read: boolean('read').notNull().default(false),
})

export const outboxNode = node.table(
  'outbox_node',
  {
    eventId: uuid('event_id').primaryKey(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextTryAt: ts('next_try_at').notNull().default(sql`now()`),
    confirmedAt: ts('confirmed_at'),
    deadReason: text('dead_reason'),
  },
  (t) => [index('outbox_node_due_idx').on(t.confirmedAt, t.nextTryAt)],
)
