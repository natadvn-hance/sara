import type { ChatAuthor, ClientInfo, ConvStage } from '@sara/shared'
import { formatCheckerDossier, formatInterlocutorInput } from '../../src/conversation/prompt'
import type { Dossier, MindHit, Recall } from '../../src/conversation/types'

/**
 * A scene of an eval sample (roles/<role>/evals/samples.json): the data of a turn, from which the stored role input is
 * built by the real formatters, so a sample never drifts from what the role reads.
 */
export type SceneRecord = { id: string; type: MindHit['type']; title: string; body: string }
export type Scene = {
  order: { title: string; category: string; city: string; budget: string | null; text: string }
  clientName?: string
  profiSince?: string | null
  bid?: { author: ChatAuthor; text: string } | null
  history: { author: ChatAuthor; text: string }[]
  said: string
  borisNote?: string | null
  stage: ConvStage
  owner?: 'sara' | 'boris'
  newDay: boolean
  night?: boolean
  recall?: {
    always: SceneRecord[]
    procedure: SceneRecord | null
    understanding: SceneRecord[]
    knowledge: SceneRecord[]
    cases?: SceneRecord[]
  }
  examples?: { id: string; client: string; boris: string }[]
}

const START = Date.UTC(2026, 9, 23, 9, 0, 0)
const STEP = 20 * 60_000

const hit = (r: SceneRecord): MindHit => ({
  id: r.id,
  type: r.type,
  scope: 'shared',
  title: r.title,
  body: r.body,
  topic: null,
  tones: [],
  stages: [],
  exampleClient: null,
  exampleBoris: null,
  rank: 1,
})

export function sceneDossier(s: Scene): Dossier {
  const messages = [...s.history.map((m) => ({ author: m.author, text: m.text })), { author: 'client' as const, text: s.said }].map(
    (m, k) => ({
      author: m.author,
      side: m.author === 'client' ? ('client' as const) : ('specialist' as const),
      text: m.text,
      sentAt: new Date(START + k * STEP).toISOString(),
      platformMessageId: `s-${k}`,
    }),
  )
  const clientInfo = s.profiSince
    ? ({ name: null, on_profi_since: `На Профи.ру с ${s.profiSince} года`, phone_verified: null, reviews: null, review_tags: [] } satisfies ClientInfo)
    : null
  return {
    conversationId: 'eval',
    accountId: 'eval',
    scope: 'eval',
    order: { title: s.order.title, category: s.order.category, city: s.order.city, budgetText: s.order.budget, text: s.order.text },
    clientName: s.clientName ?? null,
    clientInfo,
    bid: s.bid ?? null,
    messages,
    turnMessageIds: [`s-${messages.length - 1}`],
    borisNote: s.borisNote ?? null,
    stage: s.stage,
    owner: s.owner ?? 'sara',
    ownerReason: s.owner === 'boris' ? 'wrote' : null,
    newDay: s.newDay,
    night: s.night ?? false,
    lastOursAt: null,
    remindersSent: 0,
  }
}

export function sceneRecall(s: Scene): Recall {
  const r = s.recall
  return {
    mindVersion: 'eval',
    always: (r?.always ?? []).map(hit),
    procedure: r?.procedure ? hit(r.procedure) : null,
    understanding: (r?.understanding ?? []).map(hit),
    knowledge: (r?.knowledge ?? []).map(hit),
    examples: (s.examples ?? []).map((e) => ({
      ...hit({ id: e.id, type: 'example', title: e.id, body: '' }),
      exampleClient: e.client,
      exampleBoris: e.boris,
    })),
  }
}

/** The Interlocutor's input, exactly as the engine would build it for this scene. */
export const interlocutorInputOf = (s: Scene) =>
  formatInterlocutorInput(sceneDossier(s), sceneRecall(s), []).trimEnd()

/** The Checker's «Досье», exactly as the engine would build it for this scene. */
export const checkerDossierOf = (s: Scene) => formatCheckerDossier(sceneDossier(s))
