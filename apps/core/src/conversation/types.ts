import type {
  AuthorBasis,
  CaseChoice,
  ChatAuthor,
  CheckId,
  ClientInfo,
  ConvStage,
  InterlocutorOutput,
  MessageSide,
  MindType,
  Move,
  Tone,
  Topic,
} from '@sara/shared'
import type { Gateway } from '../gateway/gateway'

/**
 * The types the M4 parts share (plan «Карта интерфейсов»). Part 0 lays them down with stub bodies at their paths;
 * parts B, C and D fill the bodies and never change these shapes.
 */

export type StoredMessage = {
  id: string
  accountId: string
  chatId: string
  orderId: string | null
  platformMessageId: string
  side: MessageSide
  author: ChatAuthor
  authorBasis: AuthorBasis
  text: string
  sentAt: string
  approxTime: boolean
  read: boolean
  source: 'node' | 'v1' | 'telegram_export'
  conversationId: string | null
  heardAt: string | null
}

export type ConversationRow = {
  id: string
  accountId: string
  chatId: string
  orderId: string | null
  dealId: string | null
  origin: 'sara' | 'v1'
  owner: 'sara' | 'boris' | 'paused'
  ownerReason: 'take' | 'wrote' | 'topic' | null
  borisNote: string | null
  closedAt: string | null
  handledThrough: string | null
  lastClientHeardAt: string | null
  typingAt: string | null
  unclearCount: number
}

export type MindHit = {
  id: string
  type: MindType
  scope: string
  title: string
  body: string
  topic: Topic | null
  tones: Tone[]
  stages: ConvStage[]
  exampleClient: string | null
  exampleBoris: string | null
  rank: number
}

/** A case of Hance from the mind (Task B6): the record plus what a turn needs to tell it and what it may show. */
export type CaseHit = MindHit & {
  /** The first paragraph of the body after the heading. */
  summary: string
  /** The section «Результат», or null when the record has none. */
  result: string | null
  /** The items of «Как показывать клиенту». */
  showRules: string[]
  /** False when a rule says not to name the company (NDA). */
  nameOpen: boolean
  /** True only when a rule says the numbers of the result may be named. */
  numbersOpen: boolean
}

export type Recall = {
  mindVersion: string
  understanding: MindHit[]
  knowledge: MindHit[]
  examples: MindHit[]
  procedure: MindHit | null
  /** The constitution, the autonomy rules and the speech portrait: on every turn. */
  always: MindHit[]
  /** Up to three cases of Hance that fit the client's words, none of them already told in this chat. */
  cases: CaseHit[]
}

export type MindSearch = {
  version(): Promise<string>
  search(q: {
    text: string
    scope: string
    types: MindType[]
    limit: number
    field?: 'body' | 'example_client'
  }): Promise<MindHit[]>
  byIds(ids: string[]): Promise<MindHit[]>
  byStage(stage: ConvStage, scope: string): Promise<MindHit | null>
  bannedPhrases(): Promise<string[]>
  /** Cases of Hance that fit the text, never the ones in `exclude` (already told in the chat). */
  cases?(q: { text: string; scope: string; limit: number; exclude?: string[] }): Promise<CaseHit[]>
}

export type DossierMessage = {
  author: ChatAuthor
  side: MessageSide
  text: string
  sentAt: string
  platformMessageId: string
}

export type Dossier = {
  conversationId: string
  accountId: string
  /** The direction's mind scope (the account id). */
  scope: string
  order: {
    title: string
    category: string
    city: string
    budgetText: string | null
    text: string
  } | null
  clientName: string | null
  clientInfo: ClientInfo | null
  bid: { text: string; author: ChatAuthor } | null
  messages: DossierMessage[]
  /** The client messages this turn answers. */
  turnMessageIds: string[]
  borisNote: string | null
  stage: ConvStage
  owner: ConversationRow['owner']
  ownerReason: ConversationRow['ownerReason']
  newDay: boolean
  night: boolean
  lastOursAt: string | null
  remindersSent: number
  /** Cases already told in this chat, from the traces of its earlier turns (left out: none). */
  toldCases?: { id: string; title: string }[]
}

/** The case side of a reply's code checks (cases in a conversation). */
export type CaseCheck = {
  /** The cases the turn offered the Interlocutor under «Кейсы». */
  offered: CaseHit[]
  /** Cases already told in this chat. */
  told: { id: string; title: string }[]
  /** What the Interlocutor chose; null when its answer had no case. */
  choice: CaseChoice | null
}

export type CheckInput = {
  text: string | null
  move: Move
  factIds: string[]
  recalledIds: string[]
  /** Knowledge record id → its text, for the numbers check. */
  knowledgeTexts: Record<string, string>
  newDay: boolean
  clientTurnText: string
  ourPrevious: string[]
  bannedPhrases: string[]
  /** The cases of this turn and the Interlocutor's choice; left out, only the ad and link checks of a case run. */
  cases?: CaseCheck
}

export type CheckIssue = { id: CheckId; detail: string }

export type PolicySettings = {
  /** Shadow: old Sara still writes to clients (conv.v1_writes). */
  v1Writes: boolean
  /** Autopilot (conv.autopilot): off, Sara sends nothing by herself, a would-be «send» is a draft for Boris's press. */
  autopilot: boolean
  /** The «Пишет клиентам» switch (outbound.messages). */
  outboundMessages: boolean
  accountPaused: boolean
  night: { from: number; to: number }
  autonomy: Record<Topic, 'self' | 'draft' | 'call'>
}

export type Decision = {
  action: 'send' | 'draft' | 'call_boris' | 'forward' | 'hold' | 'nothing'
  /** What Sara would have done herself, shown on the shadow card. */
  would: 'send' | 'call_boris' | 'nothing' | 'forward' | 'hold' | 'draft'
  reason: string
  holdUntil: string | null
}

export type TurnInput = { dossier: Dossier; names: string[]; settings: PolicySettings; now: Date }

export type TurnPlan = {
  recall: Recall
  output: InterlocutorOutput | null
  issues: CheckIssue[]
  attempts: number
  decision: Decision
  modelCallIds: string[]
  checkerRan: boolean
  failure: string | null
  /** The case the final reply tells: one it was offered and no check refused; none when the reply has no valid case. */
  case?: CaseHit
}

export type EngineDeps = { gateway: Gateway; mind: MindSearch }
