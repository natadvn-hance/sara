import type {
  ChatAuthor,
  ExamScenario,
  LessonKind,
  LessonSource,
  LessonState,
  MindFrontmatter,
  MindType,
  Move,
  Tone,
  Topic,
} from '@sara/shared'
import type { CheckIssue, Decision, MindSearch } from '../conversation/types'
import type { Db } from '../db/client'
import type { Gateway } from '../gateway/gateway'
import type { Notifier } from '../notify/notifier'

/**
 * The types the M5 parts share (plan «Карта интерфейсов»). Part 0 lays them down with stub bodies at their paths;
 * the parts fill the bodies and never change these shapes.
 */

export type LessonRow = {
  id: string
  n: number
  source: LessonSource
  sourceRef: string
  scope: string
  topic: Topic | null
  tone: Tone | null
  questionType: string | null
  clientText: string | null
  before: string | null
  after: string | null
  insight: string
  kind: LessonKind
  state: LessonState
  inPlace: boolean
  sim: boolean
  attempts: number
  batchId: string | null
  taskId: string | null
  reason: string | null
  modelCallId: string | null
  commitId: string | null
  createdAt: string
  decidedAt: string | null
}

/** What a lesson changes in sara-mind; the writer builds the file from it at the moment it writes. */
export type MindChange = {
  /** A mind record or an exam scenario file. */
  file: 'record' | 'scenario'
  action: 'create' | 'update' | 'outdate'
  /** May hold «{n}», replaced by the lesson's serial number inside createLesson. */
  recordId: string
  type: MindType | null
  scope: string
  /** Fields besides id, type, scope, status, version: the writer sets those. */
  fields: Pick<MindFrontmatter, 'title' | 'tags' | 'topic' | 'tones' | 'stages' | 'examples'>
  /** Section heading without «## » → its text (records only). */
  sections: Record<string, string>
  /** The whole scenario (scenarios only). */
  scenario: ExamScenario | null
  /** Only this section on update; null = the whole file. */
  section: string | null
  baseVersion: number | null
  sources: string[]
}

/** A lesson before it has its serial number. */
export type NewLesson = Omit<
  LessonRow,
  | 'id'
  | 'n'
  | 'state'
  | 'batchId'
  | 'taskId'
  | 'reason'
  | 'commitId'
  | 'createdAt'
  | 'decidedAt'
  | 'attempts'
> & {
  state: 'new' | 'ready' | 'asked' | 'dropped'
  changes: MindChange[]
}

export type GuardInput = {
  change: MindChange
  text: string
  lesson: LessonRow | null
  sourceLessons: LessonRow[]
  existingIds: Set<string>
  clientNames: string[]
  scopes: string[]
}

export type Refused = { proposalId: string; reason: string }

export type WriteResult =
  | {
      ok: true
      commitId: string
      sha: string
      mindVersion: string
      written: string[]
      refused: Refused[]
    }
  | { ok: false; reason: 'nothing' | 'no_git' | 'locked'; detail: string; refused: Refused[] }

export type RevertResult =
  | { ok: true; commitId: string }
  | { ok: false; reason: 'conflict' | 'unknown' | 'no_git' | 'locked'; detail: string }

/** The only code that writes into sara-mind (ADR-025). */
export type MindWriter = {
  apply(
    proposalIds: string[],
    why: { lessonIds: string[]; batchId: string | null },
  ): Promise<WriteResult>
  revert(commitId: string): Promise<RevertResult>
  sync(o?: {
    rebuild?: boolean
  }): Promise<{ pushed: boolean; pulled: number; error: string | null }>
}

export type SchoolDeps = {
  db: Db
  gateway: Gateway
  notifier: Notifier
  mind: MindSearch
  writer: MindWriter
  accountIds: string[]
  mindDir: string
  publicUrl: string
}

export type ModelName = 'haiku' | 'sonnet' | 'opus'

/** One job of the night school (M5 design 5.12): once a night, inside the window and the budget. */
export type NightJob = {
  name: string
  atMsk: { hour: number; minute: number }
  /** Runs only on the weekly night, with the weekly units on top. */
  weekly?: boolean
  /** Never on the weekly night (the golden exam: the weekly run covers it). */
  notWeekly?: boolean
  /** Models the job calls: a limit on one of them in the last 12 hours skips the job. */
  models: ModelName[]
  /** Always runs: no school.on, budget or limit check (the mind exchange). */
  free?: boolean
  estimate(d: SchoolDeps, now: Date): Promise<number>
  run(d: SchoolDeps, now: Date): Promise<'done' | 'nothing'>
}

/** What Sara would answer in the trainer, by the M4 turn engine. */
export type SaraVariant = {
  text: string | null
  move: Move
  why: string
  topic: Topic
  tone: Tone
  questionType: string | null
  factIds: string[]
  exampleIds: string[]
  issues: CheckIssue[]
  decision: Decision['action']
  modelCallIds: string[]
  mindVersion: string
  failure: string | null
}

export type EditWeight = 'same' | 'minor' | 'substantial'

/** One finished conversation turn as autonomy sees it (from core.conv_turn and its events). */
export type TurnFacts = {
  turnId: string
  topic: Topic
  finishedAt: string
  draft: string | null
  /** «Хорошо», a Boris text of weight same, or a proven Boris reply of weight same. */
  approved: boolean
  /** Weight of Boris's text or proven reply; null when he did nothing. */
  edit: EditWeight | null
  /** Sent by Sara herself after the switch: «Не так», or Boris wrote before the client answered. */
  selfSentCorrected: boolean
}

/** Messages the school sends of its own accord, most important first (M5 design 5.16). */
export const NOTICE_KINDS = [
  'golden_worse',
  'sync_failed',
  'batch',
  'autonomy',
  'history_card',
  'interview',
  'exam_week',
  'blind_week',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export type { ChatAuthor }
