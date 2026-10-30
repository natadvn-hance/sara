import { z } from 'zod'
import { ENTITY_KINDS, NOTICE_KINDS } from './entities'

/**
 * The Inbox and the bell (pult v2 design 3 and 6): what waits for Boris and what Sara told him, with the presses
 * each row takes on the spot. The Inbox stores nothing: it is the open tasks and the open questions of the core.
 */

const at = z.string()

/** A thing the row is about, with the one path that is its home. */
export const EntityRef = z.object({
  kind: z.enum(ENTITY_KINDS),
  id: z.string(),
  title: z.string(),
})
export type EntityRef = z.infer<typeof EntityRef>

/** One press the row offers: where it goes and what it needs beside the press. */
export const InboxAction = z.object({
  id: z.string(),
  label: z.string(),
  look: z.enum(['primary', 'ghost', 'danger']),
  needs: z.enum(['fee', 'reason', 'text', 'confirm']).nullable(),
  /** The POST path of the press, with the ids already in it. */
  path: z.string(),
})
export type InboxAction = z.infer<typeof InboxAction>

export const InboxItem = z.object({
  /** `task:<uuid>` or `question:<uuid>`. */
  id: z.string(),
  source: z.enum(['task', 'question']),
  kind: z.string(),
  title: z.string(),
  sub: z.string().nullable(),
  /** The draft, the client's words or the question itself, when the row has a text to read. */
  text: z.string().nullable(),
  at,
  urgent: z.boolean(),
  entity: EntityRef.nullable(),
  link: z.string().nullable(),
  actions: z.array(InboxAction),
  /** The bid's fee for a lead decision, so the press carries the price Boris saw. */
  feeRub: z.number().int().nullable(),
  /** A bid put off for ten seconds from this row: when it fires. */
  hold: z.object({ executeAt: at }).nullable(),
})
export type InboxItem = z.infer<typeof InboxItem>

export const InboxView = z.object({
  items: z.array(InboxItem),
  counts: z.object({
    leads: z.number().int(),
    drafts: z.number().int(),
    questions: z.number().int(),
    other: z.number().int(),
  }),
})
export type InboxView = z.infer<typeof InboxView>

export const NoticeState = z.enum(['new', 'seen', 'done'])
export type NoticeState = z.infer<typeof NoticeState>

export const NoticeRow = z.object({
  id: z.string(),
  kind: z.enum(NOTICE_KINDS),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  state: NoticeState,
  at,
  seenAt: at.nullable(),
  doneAt: at.nullable(),
  taskId: z.string().nullable(),
  questionId: z.string().nullable(),
})
export type NoticeRow = z.infer<typeof NoticeRow>

export const NoticeList = z.object({
  items: z.array(NoticeRow),
  /** Rows in the state `new`, for the bell. */
  unseen: z.number().int(),
})
export type NoticeList = z.infer<typeof NoticeList>

/** One event of the live stream (`GET /api/stream`): what changed, never the data itself. */
export const StreamEvent = z.object({
  type: z.string(),
  kind: z.string(),
  id: z.string(),
  at,
})
export type StreamEvent = z.infer<typeof StreamEvent>
