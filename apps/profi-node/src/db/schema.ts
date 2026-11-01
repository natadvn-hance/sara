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
  /** Came before Sara watched this chat (its first reading): kept, never sent as news. */
  history: boolean('history').notNull().default(false),
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

/**
 * A press of the send button, written before the press: a call with the same key after it may only look whether the
 * bid is on the page, never press again (NFR-REL-4). result is the confirmed answer, repeated to every later call.
 */
export const bidAttempt = node.table('bid_attempt', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  accountId: text('account_id').notNull(),
  orderId: text('order_id').notNull(),
  /** What the form said it would charge. */
  dueRub: integer('due_rub').notNull(),
  /** The wallet right before the press: a retry knows the press went by the wallet down from it (null: older rows). */
  walletRub: integer('wallet_rub'),
  pressedAt: ts('pressed_at').notNull(),
  result: jsonb('result'),
})

/**
 * A press of the send button of a chat message, written before the press: a call with the same key after it (also
 * after a restart) may only look whether the message is in the chat, never type again (NFR-REL-4). result is the
 * confirmed answer, repeated to every later call. It holds no text: the permit already ties the key to the text.
 */
export const messageAttempt = node.table('message_attempt', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  accountId: text('account_id').notNull(),
  chatId: text('chat_id').notNull(),
  /** The last message the core saw before this one (null: the chat had none): where a later look starts. */
  expectLastMessageId: text('expect_last_message_id'),
  pressedAt: ts('pressed_at').notNull(),
  result: jsonb('result'),
})

/** A stop the node set for itself and keeps until a person clears it; never purged. */
export const nodeFlag = node.table(
  'node_flag',
  {
    accountId: text('account_id').notNull(),
    name: text('name').notNull(),
    reason: text('reason').notNull(),
    setAt: ts('set_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.name] })],
)
