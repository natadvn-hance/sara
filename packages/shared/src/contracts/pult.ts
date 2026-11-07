import { z } from 'zod'
import { LeadScreen } from './screen'

/**
 * C4, the pult's screens (M7): what the core answers for each screen. The pult reads, and acts only through the
 * functions the Telegram buttons call; the core checks its answers against these schemas in tests.
 */

const at = z.string()
const rub = z.number().int()

/** How a line reads: calm, waiting for Boris, worth a look, broken. */
export const LineTone = z.enum(['ok', 'wait', 'warn', 'bad'])
export type LineTone = z.infer<typeof LineTone>

/** Sara's state in one line, the worst first (M7 design 5.1). */
export const PultState = z.object({
  tone: LineTone,
  text: z.string(),
  detail: z.string().nullable(),
})
export type PultState = z.infer<typeof PultState>

/** One thing Sara did, from the journal, in Boris's words. */
export const FeedItem = z.object({
  id: z.string(),
  at,
  area: z.enum(['lead', 'bid', 'conv', 'mind', 'money', 'system']),
  text: z.string(),
  tone: LineTone,
  /** The pult path of the thing it is about; null: no home. */
  link: z.string().nullable(),
})
export type FeedItem = z.infer<typeof FeedItem>

/** One open thing that waits for Boris. */
export const WaitingItem = z.object({
  id: z.string(),
  kind: z.enum(['leads', 'draft', 'question', 'rules', 'task']),
  title: z.string(),
  sub: z.string().nullable(),
  at,
  link: z.string().nullable(),
})
export type WaitingItem = z.infer<typeof WaitingItem>

export const TodayView = z.object({
  now: at,
  state: PultState,
  /** What Sara is busy with now, from her last steps. */
  doing: z.object({ text: z.string(), at: at.nullable() }),
  waiting: z.object({
    leads: z.number().int(),
    drafts: z.number().int(),
    questions: z.number().int(),
    items: z.array(WaitingItem),
  }),
  wallet: z.object({ balanceRub: rub.nullable(), at: at.nullable(), shortRub: rub.nullable() }),
  day: z.object({
    bids: z.number().int(),
    bidsCap: z.number().int(),
    spentRub: rub,
    budgetRub: rub.nullable(),
    maxFeeRub: rub.nullable(),
    cards: z.number().int(),
    cardsCap: z.number().int(),
  }),
  feed: z.array(FeedItem),
  period: z.object({
    days: z.number().int(),
    found: z.number().int(),
    passed: z.number().int(),
    bids: z.number().int(),
    replied: z.number().int(),
    won: z.number().int(),
    spentRub: rub,
  }),
})
export type TodayView = z.infer<typeof TodayView>

/**
 * One of the two numbers of a lead (Boris, 29.10.2026: «Два числа»): 0-100 with its own reasons; null while it is
 * still being worked out («считается»).
 */
export const ScorePart = z.object({
  value: z.number().int().nullable(),
  reasons: z.array(z.string()),
})
export type ScorePart = z.infer<typeof ScorePart>

/** «Насколько наше» (fit to Hance) and «Шанс дойти до денег» (the chance of a deal), and the two together. */
export const LeadScores = z.object({
  fit: ScorePart,
  chance: ScorePart,
  /** The order of the queue by default: both numbers together; the fit alone while the chance is not known. */
  combined: z.number().int().nullable(),
})
export type LeadScores = z.infer<typeof LeadScores>

/**
 * The two numbers together: the geometric mean, so a lead strong in one and weak in the other does not rise above
 * one good in both; with one number only, that number.
 */
export function combinedScore(fit: number | null, chance: number | null): number | null {
  if (fit === null) return chance
  if (chance === null) return fit
  return Math.round(Math.sqrt(Math.max(0, fit) * Math.max(0, chance)))
}

/** The order the queue can be read in (pult v2 design 4). */
export const QUEUE_ORDERS = ['combined', 'fit', 'chance'] as const
export type QueueOrder = (typeof QUEUE_ORDERS)[number]

export const LeadRow = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  city: z.string(),
  category: z.string(),
  score: z.number().int().nullable(),
  scores: LeadScores.optional(),
  feeRub: rub,
  priceFromRub: rub.nullable(),
  seenAt: at,
  hasDraft: z.boolean(),
  /** A bid put off for ten seconds from the pult: when it fires. */
  heldUntil: at.nullable().optional(),
})
export type LeadRow = z.infer<typeof LeadRow>

export const LeadDecided = z.object({
  id: z.string(),
  title: z.string(),
  decision: z.enum(['bid', 'skip', 'closed', 'other']),
  at,
  feeRub: rub,
  /** Boris's reason of a skip, when he gave one. */
  reason: z.string().nullable().optional(),
})
export type LeadDecided = z.infer<typeof LeadDecided>

export const LeadQueue = z.object({
  queue: z.array(LeadRow),
  /** Open decisions older than a day, not shown (FR-LEAD-10). */
  older: z.number().int(),
  decided: z.array(LeadDecided),
  /** Why a press on «Откликнуться» would not spend now, for every lead alike (the pause). */
  paused: z.string().nullable(),
})
export type LeadQueue = z.infer<typeof LeadQueue>

export const ReadingLine = z.object({ label: z.string(), text: z.string() })

export const LeadView = z.object({
  lead: z.object({
    id: z.string(),
    accountId: z.string(),
    title: z.string(),
    city: z.string(),
    category: z.string(),
    text: z.string(),
    budgetText: z.string().nullable(),
    clientName: z.string(),
    client: z
      .object({
        since: z.string().nullable(),
        phone: z.boolean().nullable(),
        reviews: z.string().nullable(),
        /** The site's own lines about the client, with the mark of their colour. */
        summaries: z.array(z.object({ mark: z.string(), text: z.string() })).optional(),
      })
      .nullable(),
    /**
     * The client's own site as Sara read it (Boris, 30.10.2026): the domain with its short summary, or «сайт не
     * открылся»; and the example sites the client named. None: the order and the chat name no site.
     */
    site: z
      .object({
        own: z.object({ domain: z.string(), text: z.string() }).nullable(),
        examples: z.array(z.string()),
        /** «Изучила: сайт, 2 ссылки · …» (Boris, 30.10.2026 evening); null: no links beyond the site. */
        studied: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    seenAt: at,
    status: z.string(),
    feeRub: rub,
    url: z.string(),
  }),
  /** Stage 1 «Отсев» (docs/product/lead-analysis.md): why the order was stopped or marked; null, not screened. */
  screen: LeadScreen.nullable().optional(),
  score: z
    .object({
      value: z.number().int(),
      /** The two numbers (pult v2 design 4); the fit is the score above until the scoring v2 says more. */
      scores: LeadScores.optional(),
      threshold: z.number().int().nullable(),
      rulesVersion: z.number().int(),
      reason: z.string(),
      stopFactor: z.string().nullable(),
      redFlags: z.array(z.string()),
      confidence: z.number().nullable().optional(),
      axes: z.array(
        z.object({
          title: z.string(),
          weight: z.number().nullable(),
          score: z.number(),
          why: z.string(),
        }),
      ),
    })
    .nullable(),
  analysis: z
    .object({
      hiddenNeed: z.string(),
      risk: z.string(),
      condition: z.string(),
      reading: z.array(ReadingLine),
    })
    .nullable(),
  bid: z.object({
    text: z.string().nullable(),
    priceFromRub: rub.nullable(),
    priceToRub: rub.nullable(),
    limit: z.number().int(),
    /** The series after the bid (Boris, 29.10.2026): the one or two messages the same press sends after it. */
    followUps: z.array(z.string()).default([]),
    /** The most characters a message of the series may have when Boris edits it. */
    followUpLimit: z.number().int().default(500),
  }),
  task: z
    .object({ id: z.string(), open: z.boolean(), resolution: z.string().nullable() })
    .nullable(),
  /** What would refuse a bid now, in Boris's words; empty: nothing seen in the way. */
  obstacles: z.array(z.string()),
  /** A bid put off for ten seconds (pult v2 design 4): when it fires; null: none is held. */
  hold: z.object({ requestId: z.string(), executeAt: at }).nullable().optional(),
  /** Boris's label after a skip from the pult, with his reason. */
  label: z.object({ label: z.string(), reason: z.string().nullable() }).nullable().optional(),
})
export type LeadView = z.infer<typeof LeadView>

export const ConvRow = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  group: z.enum(['waiting', 'boris', 'sara', 'closed']),
  last: z.string().nullable(),
  lastAt: at.nullable(),
  lastSide: z.enum(['client', 'us', 'profi']).nullable(),
})
export type ConvRow = z.infer<typeof ConvRow>

export const ConvList = z.object({ rows: z.array(ConvRow), drafting: z.string().nullable() })
export type ConvList = z.infer<typeof ConvList>

export const ConvMessage = z.object({
  id: z.string(),
  side: z.enum(['client', 'us', 'profi']),
  author: z.string(),
  text: z.string(),
  at,
  approx: z.boolean(),
  read: z.boolean(),
})
export type ConvMessage = z.infer<typeof ConvMessage>

export const ConvView = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.enum(['sara', 'boris']),
  closed: z.boolean(),
  orderId: z.string().nullable(),
  orderTitle: z.string().nullable(),
  chatUrl: z.string().nullable(),
  note: z.string().nullable(),
  messages: z.array(ConvMessage),
  draft: z
    .object({
      taskId: z.string(),
      kind: z.enum(['reply', 'reminder']),
      text: z.string(),
      why: z.string().nullable(),
      tone: z.string().nullable(),
      facts: z.array(z.object({ id: z.string(), title: z.string() })),
      at,
    })
    .nullable(),
  /** Why «Отправить» would not reach the client now; null: it would go. */
  sendHold: z.string().nullable(),
})
export type ConvView = z.infer<typeof ConvView>

/** Boris's funnel stages (docs/product/analytics-metrics.md). */
export const FUNNEL_STAGES = ['Отклик', 'Переговоры', 'В работе', 'Закрыта', 'Отвалился'] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

export const AnalyticsView = z.object({
  year: z.number().int(),
  clients: z.array(
    z.object({
      month: z.string(),
      client: z.string(),
      service: z.string(),
      stage: z.enum(FUNNEL_STAGES),
      dealRub: rub.nullable(),
      spendRub: rub,
      ltvRub: rub.nullable(),
      note: z.string().nullable(),
      link: z.string().nullable(),
    }),
  ),
  funnel: z.array(
    z.object({
      stage: z.enum(FUNNEL_STAGES),
      count: z.number().int(),
      share: z.number().nullable(),
    }),
  ),
  months: z.array(
    z.object({
      month: z.string(),
      bids: z.number().int(),
      won: z.number().int(),
      lost: z.number().int(),
      conversion: z.number().nullable(),
      avgCheckRub: rub.nullable(),
      revenueRub: rub.nullable(),
      spendRub: rub,
      cacRub: rub.nullable(),
    }),
  ),
  /** Calls by month: booked, held, missed, without a word (one function for the pult, the sheet and the summary). */
  meetings: z
    .array(
      z.object({
        month: z.string(),
        booked: z.number().int(),
        held: z.number().int(),
        missed: z.number().int(),
        noWord: z.number().int(),
      }),
    )
    .default([]),
  /** What the tables do not know yet, said plainly. */
  notes: z.array(z.string()),
})
export type AnalyticsView = z.infer<typeof AnalyticsView>

export const MindRecordRow = z.object({
  id: z.string(),
  type: z.string(),
  scope: z.string(),
  title: z.string(),
  topic: z.string().nullable(),
  version: z.number().int(),
})

export const MindView = z.object({
  mindVersion: z.string().nullable(),
  groups: z.array(
    z.object({ type: z.string(), title: z.string(), records: z.array(MindRecordRow) }),
  ),
  proposals: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      kind: z.string(),
      source: z.string(),
      state: z.string(),
      action: z.string(),
      at,
      preview: z.string(),
    }),
  ),
  gaps: z.array(
    z.object({ text: z.string(), topic: z.string().nullable(), count: z.number().int() }),
  ),
})
export type MindView = z.infer<typeof MindView>

export const MindRecordView = z.object({
  record: MindRecordRow.extend({
    body: z.string(),
    exampleClient: z.string().nullable(),
    exampleBoris: z.string().nullable(),
    path: z.string(),
    tones: z.array(z.string()),
    stages: z.array(z.string()),
  }),
  used: z.array(z.object({ turnId: z.string(), conversationId: z.string(), at })),
  proposals: z.array(z.object({ id: z.string(), state: z.string(), action: z.string(), at })),
})
export type MindRecordView = z.infer<typeof MindRecordView>

/**
 * How the pult may change a setting: freely; on and off with a second press for turning on (`confirm`); only toward
 * the pause; or not at all (a deploy or the switch).
 */
export const SettingEdit = z.enum(['free', 'confirm', 'stop_only', 'locked'])

export const SettingRow = z.object({
  key: z.string(),
  title: z.string(),
  hint: z.string().nullable(),
  value: z.unknown(),
  isDefault: z.boolean(),
  edit: SettingEdit,
  kind: z.enum(['flag', 'count', 'rub', 'hours', 'text', 'other']),
  changedAt: at.nullable(),
  changedBy: z.string().nullable(),
})
export type SettingRow = z.infer<typeof SettingRow>

export const SettingsView = z.object({
  groups: z.array(z.object({ id: z.string(), title: z.string(), rows: z.array(SettingRow) })),
  directions: z.array(
    z.object({
      accountId: z.string(),
      title: z.string(),
      version: z.number().int(),
      threshold: z.number().int(),
      /** The thresholds in force by the kind of the order (marketing, sites, the rest). */
      thresholds: z.object({
        marketing: z.number().int(),
        sites: z.number().int(),
        other: z.number().int(),
      }),
      stops: z.array(z.string()),
      axes: z.array(z.object({ title: z.string(), weight: z.number().int() })),
    }),
  ),
  history: z.array(
    z.object({ key: z.string(), title: z.string(), value: z.unknown(), by: z.string(), at }),
  ),
})
export type SettingsView = z.infer<typeof SettingsView>

export const SystemPart = z.object({
  id: z.string(),
  title: z.string(),
  tone: LineTone,
  text: z.string(),
  fix: z.string().nullable(),
  at: at.nullable(),
})
export type SystemPart = z.infer<typeof SystemPart>

export const SystemView = z.object({
  parts: z.array(SystemPart),
  /** The core's version and its last start (the last deploy or restart). */
  deploy: z.object({ version: z.string(), startedAt: at.nullable() }).optional(),
  claude: z.object({
    limited: z.boolean(),
    until: at.nullable(),
    roles: z.array(
      z.object({
        role: z.string(),
        calls: z.number().int(),
        failed: z.number().int(),
        ms: z.number().int(),
      }),
    ),
  }),
  accounts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      login: z.string(),
      paused: z.boolean(),
      balanceRub: rub.nullable(),
    }),
  ),
})
export type SystemView = z.infer<typeof SystemView>

/** The answer to a press from the pult: the same words the bot would show. */
export const PressAnswer = z.object({ message: z.string() })
export type PressAnswer = z.infer<typeof PressAnswer>
