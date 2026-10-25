import { z } from 'zod'
import { CONV_STAGES, TONES, TOPICS } from './conversation'
import { MIND_ID_PREFIX, MIND_TYPES } from './mind'
import type { MODELS } from './roles'

/** The trainer's modes (FR-TRAIN-3); the weekly blind test (FR-SPEECH-4) lives beside them. */
export const TRAINER_MODES = ['client', 'guess', 'rate', 'hard', 'interview', 'blind'] as const
export type TrainerMode = (typeof TRAINER_MODES)[number]

/** Where a lesson came from (M5 design 5.1). */
export const LESSON_SOURCES = [
  'edit',
  'say',
  'compare',
  'training',
  'interview',
  'teacher',
  'review',
  'history',
  'import',
] as const
export type LessonSource = (typeof LESSON_SOURCES)[number]

/** What a lesson teaches: how to say it, what is true, which move, how to meet a tone; or a bulk of examples. */
export const LESSON_KINDS = ['voice', 'fact', 'procedure', 'tone', 'bulk'] as const
export type LessonKind = (typeof LESSON_KINDS)[number]
const INSIGHT_KINDS = ['voice', 'fact', 'procedure', 'tone'] as const

export const LESSON_STATES = ['new', 'ready', 'asked', 'yes', 'no', 'skip', 'dropped'] as const
export type LessonState = (typeof LESSON_STATES)[number]

/** How much of the subscription a call weighs, by model (NFR-COST-2); the first week's measure may change it. */
export const MODEL_UNITS: Record<(typeof MODELS)[number], number> = {
  haiku: 1,
  sonnet: 4,
  opus: 20,
}

/** A mind record id a model may name: never a path, only a type letter and plain words (M5 design 5.3). */
export const MIND_RECORD_ID = /^[kusje]-[a-z0-9-]{1,60}$/

/** The trainer's client: one line by a persona, and whether the client ended the dialog. */
export const TrainerClientOutput = z.object({
  text: z.string().min(1).max(800),
  ends: z.enum(['no', 'call_agreed', 'left']),
  mood: z.enum(TONES),
})
export type TrainerClientOutput = z.infer<typeof TrainerClientOutput>

/** The trainer's coach: why Sara answered so, and the lesson the talk ends in, if any (FR-TRAIN-4). */
export const CoachOutput = z
  .object({
    answer: z.string().min(1).max(800),
    insight: z.string().min(1).max(240).nullable(),
    kind: z.enum(INSIGHT_KINDS).nullable(),
  })
  .refine((o) => (o.insight === null) === (o.kind === null), {
    message: 'insight and kind come together',
  })
export type CoachOutput = z.infer<typeof CoachOutput>

/** The lesson maker: one insight from Boris's edit, or a knowledge record from his interview answer (FR-TRAIN-6). */
export const LessonMakerOutput = z.object({
  worth: z.boolean(),
  insight: z.string().max(240),
  kind: z.enum(INSIGHT_KINDS),
  topic: z.enum(TOPICS),
  tone: z.enum(TONES),
  fact: z
    .object({
      title: z.string().min(1).max(120),
      fact: z.string().min(1).max(800),
      when: z.string().max(400),
      not_say: z.string().max(400),
    })
    .nullable(),
})
export type LessonMakerOutput = z.infer<typeof LessonMakerOutput>

/** One draft of the night teacher (FR-TRAIN-7): the code builds the file from these fields, never the model. */
export const TeacherProposal = z
  .object({
    action: z.enum(['create', 'update', 'outdate']),
    record_id: z.string().regex(MIND_RECORD_ID),
    type: z.enum(MIND_TYPES),
    scope: z.string().min(1).max(60),
    title: z.string().min(1).max(120),
    topic: z.enum(TOPICS).optional(),
    tones: z.array(z.enum(TONES)).optional(),
    stages: z.array(z.enum(CONV_STAGES)).optional(),
    section: z.string().min(1).max(60).nullable(),
    sections: z.record(z.string().min(1).max(60), z.string().max(4000)),
    sources: z.array(z.string().min(1).max(120)).min(1).max(20),
    lesson_ids: z.array(z.string().min(1)).max(20),
    why: z.string().min(1).max(300),
  })
  .refine((p) => p.record_id.startsWith(MIND_ID_PREFIX[p.type]), {
    message: 'the record id starts with the letter of its type',
  })
export type TeacherProposal = z.infer<typeof TeacherProposal>

export const TeacherOutput = z.object({
  proposals: z.array(TeacherProposal).max(8),
  questions: z.array(z.string().min(1).max(200)).max(3),
})
export type TeacherOutput = z.infer<typeof TeacherOutput>

const personaFields = {
  archetype: z.string().min(1).max(120),
  niche: z.string().min(1).max(120),
  task: z.string().min(1).max(200),
  mood: z.enum(TONES),
  style: z.string().max(300),
  questions: z.array(z.string().min(1).max(200)).max(6),
  topics: z.array(z.enum(TOPICS)).max(6),
  order: z.object({
    title: z.string().min(1).max(200),
    text: z.string().max(1500),
    budget_text: z.string().max(100).nullable(),
  }),
  difficulty: z.number().int().min(1).max(3),
  hard: z.boolean(),
}

/** A persona the builder made from numbered conversations; one client alone is too close to a real person. */
export const PersonaOutput = z.object({
  personas: z
    .array(
      z.object({ ...personaFields, from: z.array(z.number().int().positive()).min(2).max(40) }),
    )
    .max(6),
})
export type PersonaOutput = z.infer<typeof PersonaOutput>

/** A stored persona (FR-TRAIN-2): every one names the chats it was built from. */
export const Persona = z.object({
  id: z.string().regex(/^p-[a-z0-9-]+$/),
  ...personaFields,
  source_refs: z.array(z.string().min(1)).min(1),
  handmade: z.boolean(),
})
export type Persona = z.infer<typeof Persona>

const GeneratorMessage = z.discriminatedUnion('side', [
  z.object({ side: z.literal('client'), text: z.string().min(1).max(800), topic: z.enum(TOPICS) }),
  z.object({ side: z.literal('specialist'), text: z.string().min(1).max(800) }),
])

/** Whole made-up dialogs, five a call (FR-TRAIN-9); only the client lines are kept, and never as knowledge. */
export const GeneratorOutput = z.object({
  dialogs: z
    .array(
      z.object({
        persona_id: z.string().min(1),
        messages: z.array(GeneratorMessage).min(4).max(16),
      }),
    )
    .max(5),
})
export type GeneratorOutput = z.infer<typeof GeneratorOutput>
