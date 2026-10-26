import { ReminderOutput } from '@sara/shared'
import type { Db } from '../db/client'
import type { Gateway } from '../gateway/gateway'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { checkReplyText } from './check/codeChecks'
import { buildDossier, clientNames } from './dossier'
import { ALWAYS } from './engine'
import { formatReminderInput } from './prompt'
import type { ReminderTone } from './reminderLadder'
import { getConversation } from './store'
import type { CheckIssue, MindHit, MindSearch } from './types'

/** The reminders of the ladder that carry a text (the dormant day has none); `of` in the input counts them. */
export type TextStep = 1 | 2 | 3
const LADDER_STEPS = 3

export type WrittenReminder = {
  /** The text that passed the checks; null when the model gave none or none that passed. */
  text: string | null
  factIds: string[]
  /** What the code checks found in the last text the model wrote. */
  issues: CheckIssue[]
  attempts: number
  /** The gateway's error class when the model call failed. */
  failure: string | null
  modelCallIds: string[]
  mindVersion: string | null
  recalled: string[]
}

/** One rewrite after failed checks, as the Interlocutor gets (M4 design 5.6). */
const MAX_ATTEMPTS = 2
const KNOWLEDGE_LIMIT = 4

/**
 * Writes the reminder to a client who went quiet (FR-CONV-12): the dossier and the mind go to the `reminder` role
 * through the gateway with the client's name hidden, and the text must pass the code checks that apply to it: a
 * reminder is always a new day, so it greets; it holds no number the cited records do not hold, no promise to call,
 * no dash, no robotic phrase and no story of a project (cases are not told in a reminder, Boris's rule). A text that
 * fails is written once more with the reasons; a second fail is no text, and the caller decides what goes instead.
 */
export async function writeReminder(
  d: { db: Db; gateway: Gateway; mind: MindSearch; profi?: ProfiClient },
  i: {
    conversationId: string
    step: TextStep
    tone: ReminderTone
    read: boolean
    now: Date
    /** How long the call may wait out the Claude limit; left out, the gateway's default. */
    limitWaitMs?: number
  },
): Promise<WrittenReminder> {
  const conv = await getConversation(d.db, i.conversationId)
  if (!conv) throw new Error(`conversation ${i.conversationId} not found`)
  const out: WrittenReminder = {
    text: null,
    factIds: [],
    issues: [],
    attempts: 0,
    failure: null,
    modelCallIds: [],
    mindVersion: null,
    recalled: [],
  }
  // The whole chat, our later reminders too: the dossier is not cut at an anchor.
  const dossier = await buildDossier(d.db, conv.id, i.now, {
    night: await getSetting(d.db, 'conv.night'),
    profi: d.profi,
  })
  const names = await clientNames(d.db, conv, dossier)
  const lastOurs = dossier.messages.findLast((m) => m.side === 'specialist')
  let records: MindHit[]
  let knowledge: MindHit[]
  let banned: string[]
  try {
    const found = await Promise.all([
      d.mind.version(),
      d.mind.byIds(ALWAYS),
      d.mind.search({
        text: [dossier.order?.title, dossier.order?.text, lastOurs?.text]
          .filter(Boolean)
          .join('\n'),
        scope: dossier.scope,
        types: ['knowledge'],
        limit: KNOWLEDGE_LIMIT,
      }),
      d.mind.bannedPhrases(),
    ])
    out.mindVersion = found[0]
    knowledge = found[2]
    records = [...found[1], ...knowledge]
    banned = found[3]
  } catch (e) {
    console.error('reminder: the mind is not readable', e instanceof Error ? e.message : e)
    out.failure = 'mind'
    return out
  }
  out.recalled = records.map((h) => h.id)
  const knowledgeTexts = Object.fromEntries(knowledge.map((k) => [k.id, k.body]))
  const ourPrevious = dossier.messages.filter((m) => m.side === 'specialist').map((m) => m.text)
  let issues: CheckIssue[] = []
  while (out.attempts < MAX_ATTEMPTS) {
    out.attempts++
    const res = await d.gateway.call(
      'reminder',
      formatReminderInput(
        dossier,
        records,
        {
          ordinal: i.step,
          of: LADDER_STEPS,
          friendly: i.tone === 'friendly',
          read: i.read,
        },
        issues,
      ),
      ReminderOutput,
      {
        correlationId: conv.id,
        redact: { names },
        ...(i.limitWaitMs !== undefined && { limitWaitMs: i.limitWaitMs }),
      },
    )
    out.modelCallIds.push(res.modelCallId)
    if (!res.ok) {
      out.failure = res.errorClass
      out.issues = []
      return out
    }
    const text = res.output.text.trim()
    out.factIds = res.output.fact_ids
    issues = checkReplyText({
      text,
      move: 'reply',
      factIds: res.output.fact_ids,
      recalledIds: out.recalled,
      knowledgeTexts,
      newDay: true,
      clientTurnText: '',
      ourPrevious,
      bannedPhrases: banned,
      // No case is offered: a story of a project in a reminder is case.unknown.
      cases: { offered: [], told: dossier.toldCases ?? [], choice: null },
    })
    out.issues = issues
    if (issues.length === 0) {
      out.text = text
      return out
    }
  }
  return out
}
