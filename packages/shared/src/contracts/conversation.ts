import { z } from 'zod'
import { MessageAuthor } from './profi'

/** Which side of the chat a message is on, as the platform shows it. */
export const MessageSide = MessageAuthor
export type MessageSide = z.infer<typeof MessageSide>

/** Whose voice a message is (ADR-024): a specialist message is Boris's or old Sara's only with proof. */
export const CHAT_AUTHORS = ['client', 'boris', 'sara', 'sara_v1', 'system', 'unknown'] as const
export type ChatAuthor = (typeof CHAT_AUTHORS)[number]

/** Why the author was decided so (M4 design 5.1). */
export const AUTHOR_BASES = [
  'side',
  'outbox',
  'before_v1',
  'v1_boris_text',
  'v1_dictated',
  'v1_taken',
  'v1_bid',
  'v1_bid_edited',
  'v1_proposed',
  'v1_template',
  'telegram_export',
  'after_cutover',
  'say',
  'v1_or_boris',
] as const
export type AuthorBasis = (typeof AUTHOR_BASES)[number]

/** Topics of autonomy (FR-AUTO-1). */
export const TOPICS = [
  'price',
  'contract',
  'discount',
  'nda',
  'call',
  'process',
  'timeline',
  'cases',
  'about',
  'smalltalk',
  'other',
] as const
export type Topic = (typeof TOPICS)[number]

/** Always Boris's: Sara calls him, and no setting may raise them (FR-AUTO-2). */
export const LOCKED_TOPICS = [
  'price',
  'contract',
  'discount',
  'nda',
] as const satisfies readonly Topic[]

/** The client's tone (FR-SPEECH-3). */
export const TONES = [
  'neutral',
  'joke',
  'irritation',
  'hurry',
  'doubt',
  'compliment',
  'rudeness',
  'bargaining',
] as const
export type Tone = (typeof TONES)[number]

export const MOVES = ['reply', 'call_boris', 'none'] as const
export type Move = (typeof MOVES)[number]

/** Stages a conversation can be in (spec 7.2, from the bid on). */
export const CONV_STAGES = [
  'bid_sent',
  'talking',
  'call_proposed',
  'call_booked',
  'call_done',
  'dormant',
] as const
export type ConvStage = (typeof CONV_STAGES)[number]

/**
 * The four signals that call for a case of Hance (docs/product/cases-in-negotiation.md, section 2): the client asked
 * for examples, the order asks for cases, a doubt or objection (price, term, «will it work for us»), the client
 * described a problem that matches a case.
 */
export const CASE_MOMENTS = ['asked', 'order_asks', 'doubt', 'same_problem'] as const
export type CaseMoment = (typeof CASE_MOMENTS)[number]

/** The case the Interlocutor chose for this reply: none (all null), or an id from the turn's «Кейсы» with its moment. */
export const CaseChoice = z.object({
  moment: z.enum(CASE_MOMENTS).nullable(),
  case_id: z.string().nullable(),
  why: z.string().max(300).nullable(),
})
export type CaseChoice = z.infer<typeof CaseChoice>

/**
 * The Interlocutor's answer (FR-CONV-3, steps 3 and 4 in one call). The fields come in the order the model thinks:
 * what was heard, the type of question, topic and tone, the move and why, the case, the text, and the mind ids it
 * rests on.
 */
export const InterlocutorOutput = z.object({
  heard: z.object({ said: z.string().max(600), behind: z.string().max(600) }),
  question_type: z.string().nullable(),
  topic: z.enum(TOPICS),
  tone: z.enum(TONES),
  move: z.enum(MOVES),
  urgent: z.boolean(),
  why: z.string().max(300),
  /** A case of Hance told in the text, with the moment that called for it (cases in a conversation). */
  case: CaseChoice.optional(),
  /** The sites of Hance shown to a client of a site order who asked for examples: ids from «Сайты Hance» (the code adds the links). */
  sites: z.array(z.string().max(80)).max(4).optional(),
  text: z.string().max(1500).nullable(),
  fact_ids: z.array(z.string()).max(12),
  example_ids: z.array(z.string()).max(8),
  missing: z.string().max(300).nullable(),
})
export type InterlocutorOutput = z.infer<typeof InterlocutorOutput>

const notes = z.array(z.string().max(200)).max(5)

/** The Checker's answer (FR-CONV-4): any non-empty field fails the reply. */
export const CheckerOutput = z.object({
  unsupported: notes,
  contradicts_boris: z.string().max(300).nullable(),
  robotic: notes,
  promises: notes,
  /** Notes on the case told in the draft: not by the situation, sounds like an ad, not tied to the client's task. */
  case: notes.default([]),
})
export type CheckerOutput = z.infer<typeof CheckerOutput>

/** A reminder to a client who went quiet (FR-CONV-12). */
export const ReminderOutput = z.object({
  text: z.string().min(1).max(600),
  fact_ids: z.array(z.string()).max(6),
})
export type ReminderOutput = z.infer<typeof ReminderOutput>

/** The exam judge's marks (FR-TRAIN-8). */
export const ExaminerOutput = z.object({
  tone: z.number().int().min(1).max(5),
  voice: z.number().int().min(1).max(5),
  procedure_ok: z.boolean(),
  notes: z.string().max(400),
})
export type ExaminerOutput = z.infer<typeof ExaminerOutput>

/** Checks of a reply (M4 design 5.6); the severity is the exam's class (test strategy 4.4). */
export const CHECK_SEVERITY = {
  'facts.unknown': 'S1',
  'facts.none': 'S1',
  'facts.numbers': 'S1',
  'greeting.missing': 'S2',
  'greeting.extra': 'S3',
  dash: 'S2',
  'robotic.phrase': 'S3',
  'robotic.ai': 'S1',
  'robotic.list': 'S3',
  'robotic.markup': 'S3',
  'robotic.length': 'S3',
  'robotic.repeat': 'S3',
  'robotic.quote': 'S3',
  'style.neuro': 'S3',
  'promise.call': 'S1',
  empty: 'S2',
  'checker.unsupported': 'S1',
  'checker.contradicts': 'S1',
  'checker.robotic': 'S3',
  'checker.promises': 'S1',
  // Cases in a conversation: an invented case or a closed name or number is a lie or a leak (S1).
  'case.unknown': 'S1',
  'case.no_moment': 'S2',
  'case.repeat': 'S2',
  'case.many': 'S2',
  'case.closed': 'S1',
  'case.ad': 'S3',
  'case.link': 'S3',
  'case.no_examples': 'S2',
  'voice.third_person': 'S2',
  'checker.case': 'S2',
} as const satisfies Record<string, 'S1' | 'S2' | 'S3'>
export type CheckId = keyof typeof CHECK_SEVERITY
export const CHECK_IDS = Object.keys(CHECK_SEVERITY) as CheckId[]

/** A case of Hance invented for an exam scenario, in the shape the case search gives (cases in a conversation). */
export const ExamCase = z
  .object({
    id: z.string().regex(/^k-case-[a-z0-9-]+$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    role: z.string().nullable().default(null),
    /** The result of the case, or null when none is recorded. */
    result: z.string().nullable().default(null),
    /** The items of «Как показывать клиенту». */
    show_rules: z.array(z.string().min(1)).default([]),
    /** False when the company may not be named (NDA). */
    name_open: z.boolean(),
    /** True only when the numbers of the result may be named. */
    numbers_open: z.boolean(),
  })
  .strict()
export type ExamCase = z.infer<typeof ExamCase>

/** A message of an exam scenario; a specialist message of unknown voice stays `unknown` (ADR-024). */
const ExamMessage = z
  .object({
    author: z.enum(CHAT_AUTHORS),
    text: z.string().min(1),
    at: z.iso.datetime(),
  })
  .strict()

/** One exam scenario (FR-TRAIN-8, M4 design 5.13): the chat so far, and what Sara should do next. */
export const ExamScenario = z
  .object({
    id: z.string().regex(/^x-[a-z0-9-]+$/),
    title: z.string().min(1),
    source: z.object({ kind: z.enum(['history', 'handmade']), ref: z.string().nullable() }),
    tags: z.object({
      question_type: z.string().nullable(),
      stage: z.enum(CONV_STAGES),
      tone: z.enum(TONES),
      archetype: z.string().nullable(),
      hard: z.boolean(),
      /** The scenario holds a phone, an e-mail or a link on purpose, as a trap (handmade ones are otherwise free of them). */
      trap: z.boolean().default(false),
    }),
    golden: z.boolean(),
    order: z.object({
      title: z.string(),
      category: z.string().default(''),
      text: z.string(),
      budget_text: z.string().nullable(),
      city: z.string(),
    }),
    client_name: z.string().nullable(),
    /**
     * The cases of Hance this scenario offers the Interlocutor under «Кейсы»: invented, in the scenario's own data, so
     * the exam does not depend on the cases of the mind. A scenario without them offers none.
     */
    cases: z.array(ExamCase).default([]),
    /** The bid that opened the chat and whose it was; null when the scenario does not need it. */
    bid: z
      .object({ text: z.string().min(1), author: z.enum(CHAT_AUTHORS) })
      .nullable()
      .default(null),
    messages: z.array(ExamMessage).min(1),
    state: z.object({
      owner: z.enum(['sara', 'boris', 'paused']),
      owner_reason: z.enum(['take', 'wrote']).nullable(),
      boris_note: z.string().nullable(),
    }),
    now: z.iso.datetime(),
    expect: z.object({
      move: z.enum(MOVES),
      urgent: z.boolean().optional(),
      topic: z.enum(TOPICS).optional(),
      /** `needed`: the reply must tell one of the scenario's cases; `none`: it must tell no case at all. */
      case: z.enum(['needed', 'none']).optional(),
      /** Whether the reply must start with a greeting (true) or must not (false); absent: by the new day rule. */
      greeting: z.boolean().optional(),
      must_not_contain: z.array(z.string()).default([]),
      must_mention_any: z.array(z.string()).default([]),
      boris_reply: z.string().nullable().default(null),
    }),
    rubric: z.string().nullable().default(null),
  })
  .strict()
export type ExamScenario = z.infer<typeof ExamScenario>
