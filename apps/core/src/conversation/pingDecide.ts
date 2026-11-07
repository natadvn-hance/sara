import { PingerOutput } from '@sara/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { modelCall } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'
import { checkReplyText } from './check/codeChecks'
import { hookIssues, hookSourced } from './check/hookChecks'
import { buildDossier, clientNames } from './dossier'
import { ALWAYS } from './engine'
import { morningAfter, moscowDay, type PingScenario, scenarioWhy } from './pingScenario'
import { formatPingInput } from './prompt'
import { getConversation } from './store'
import type { CheckIssue, MindHit, MindSearch } from './types'
import { scopesOf, VOICE_ALWAYS, withoutTrial } from './voice'

/**
 * The Pinger decides about a client who went quiet (FR-CONV-12, spec 2026-11-07-organic-pings): write to him now,
 * wait once more inside the window the code gave, or tell Boris instead; and the text. The code's hard rules were
 * spoken before this is asked (reminderSteps.ts `checkGround`); here the code keeps the model inside them: «later» never
 * past the window, a fact only with a page the search really gave, and every text through the code checks.
 */

export type PingChoice =
  | { kind: 'ping'; text: string; why: string; source: string | null }
  | { kind: 'later'; at: string; why: string }
  | { kind: 'boris'; note: string; why: string }

export type Decided = {
  /** Null: no answer that passed (the model failed, or its text failed the checks twice). */
  choice: PingChoice | null
  /** The Pinger's calls of the day are spent: ask again at this moment (the next morning). */
  capped: string | null
  /** The last text the model wrote, whether it passed or not. */
  text: string | null
  factIds: string[]
  issues: CheckIssue[]
  attempts: number
  /** The gateway's error class when the model call failed; `off` when the day's limit of calls is 0. */
  failure: string | null
  modelCallIds: string[]
  mindVersion: string | null
  recalled: string[]
}

/** The reminders that carry a text: three per silence, then the task for Boris. */
export const PINGS_PER_SILENCE = 3
/** One rewrite after failed checks, as the Interlocutor gets (M4 design 5.6). */
const MAX_ATTEMPTS = 2
const KNOWLEDGE_LIMIT = 4
const DAY_MS = 24 * 3600_000
/** The mind records every ping reads: the constitution, greeting, autonomy, values, speech, and Boris's tone. */
const PING_RECORDS = [...ALWAYS, 'j-tone']
/** The pseudo record of a fresh fact from the web: its numbers may be said once its page is proven. */
const WEB = 'web'

/** How many times the Pinger was called since Moscow midnight. */
async function callsToday(db: Db, now: Date): Promise<number> {
  const midnight = new Date(`${moscowDay(now)}T00:00:00+03:00`).toISOString()
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(modelCall)
    .where(and(eq(modelCall.role, 'pinger'), gte(modelCall.startedAt, midnight)))
  return r?.n ?? 0
}

export async function decidePing(
  d: { db: Db; gateway: Gateway; mind: MindSearch; profi?: ProfiClient },
  i: {
    conversationId: string
    scenario: PingScenario
    /** Which ping of the silence this is (1-3). */
    step: number
    read: boolean
    now: Date
    /** «Later» is still allowed up to this moment; null: decide now. */
    laterUntil: Date | null
    /** How long «one day» of «later» is (tests shorten it). */
    dayMs?: number
    /** How long the call may wait out the Claude limit; left out, the gateway's default. */
    limitWaitMs?: number
  },
): Promise<Decided> {
  const out: Decided = {
    choice: null,
    capped: null,
    text: null,
    factIds: [],
    issues: [],
    attempts: 0,
    failure: null,
    modelCallIds: [],
    mindVersion: null,
    recalled: [],
  }
  const sc = i.scenario
  // We promised the client something: the next move is ours, the code tells Boris without asking a model.
  if (sc.kind === 'our_promise') {
    out.choice = {
      kind: 'boris',
      note: `Мы обещали клиенту: «${sc.quote ?? 'что то сделать'}». Он ждет нас.`,
      why: scenarioWhy(sc, i.read),
    }
    return out
  }
  const perDay = await getSetting(d.db, 'conv.pings_per_day')
  // 0 turns the Pinger off: the ready text of the scenario goes, nothing is asked of a model.
  if (perDay === 0) {
    out.failure = 'off'
    return out
  }
  if ((await callsToday(d.db, i.now)) >= perDay) {
    out.capped = morningAfter(moscowDay(i.now)).toISOString()
    return out
  }
  const conv = await getConversation(d.db, i.conversationId)
  if (!conv) throw new Error(`conversation ${i.conversationId} not found`)
  // The whole chat, our earlier pings too: the dossier is not cut at an anchor.
  const dossier = await buildDossier(d.db, conv.id, i.now, {
    night: await getSetting(d.db, 'conv.night'),
    profi: d.profi,
  })
  const names = await clientNames(d.db, conv, dossier)
  const lastOurs = dossier.messages.findLast((m) => m.side === 'specialist')
  const sinceBid = !dossier.messages.some((m) => m.side === 'client')
  let records: MindHit[]
  let knowledge: MindHit[]
  let banned: string[]
  try {
    const found = await Promise.all([
      d.mind.version(),
      d.mind
        .byIds(dossier.voice ? [...PING_RECORDS, ...VOICE_ALWAYS] : PING_RECORDS)
        .then((hits) => withoutTrial(hits, dossier.voice)),
      d.mind.search({
        text: [dossier.order?.title, dossier.order?.text, lastOurs?.text]
          .filter(Boolean)
          .join('\n'),
        scope: scopesOf(dossier.scope, dossier.voice),
        types: ['knowledge'],
        limit: KNOWLEDGE_LIMIT,
      }),
      d.mind.bannedPhrases({ trial: dossier.voice }),
    ])
    out.mindVersion = found[0]
    knowledge = found[2]
    records = [...found[1], ...knowledge]
    banned = found[3]
  } catch (e) {
    console.error('ping: the mind is not readable', e instanceof Error ? e.message : e)
    out.failure = 'mind'
    return out
  }
  out.recalled = records.map((h) => h.id)
  const knowledgeTexts: Record<string, string> = Object.fromEntries(
    knowledge.map((k) => [k.id, k.body]),
  )
  const ourPrevious = dossier.messages.filter((m) => m.side === 'specialist').map((m) => m.text)
  const day = i.dayMs ?? DAY_MS
  let issues: CheckIssue[] = []
  let noNews = false
  while (out.attempts < MAX_ATTEMPTS) {
    out.attempts++
    const res = await d.gateway.call(
      'pinger',
      formatPingInput(
        dossier,
        records,
        {
          scenario: sc,
          ordinal: i.step,
          of: PINGS_PER_SILENCE,
          read: i.read,
          sinceBid,
          now: i.now,
          laterUntil: i.laterUntil,
          noNews,
        },
        issues,
      ),
      PingerOutput,
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
    const o = res.output
    const why = o.why_now.trim() || scenarioWhy(sc, i.read)
    if (o.decision === 'boris') {
      out.choice = { kind: 'boris', note: o.boris_note?.trim() || why, why }
      return out
    }
    if (o.decision === 'later' && i.laterUntil) {
      // The model picks the day, the code keeps it inside the window: never past it, never sooner than a day.
      const want = i.now.getTime() + (o.later_days ?? 1) * day
      const at = new Date(Math.min(want, i.laterUntil.getTime()))
      out.choice = { kind: 'later', at: at.toISOString(), why }
      return out
    }
    const text = o.text.trim()
    out.text = text || null
    out.factIds = o.fact_ids
    if (!text) {
      // «Later» once the window is spent, or no text at all: it is asked once more to decide now.
      issues = [
        {
          id: 'empty',
          detail: 'ждать больше нельзя: напиши клиенту сейчас (decision ping) или скажи Борису',
        },
      ]
      out.issues = issues
      continue
    }
    const sourced = hookSourced(o.hook, res.sources)
    const hook = sourced ? o.hook : null
    issues = [
      ...checkReplyText({
        text,
        move: 'reply',
        factIds: hook ? [...o.fact_ids, WEB] : o.fact_ids,
        recalledIds: hook ? [...out.recalled, WEB] : out.recalled,
        knowledgeTexts: hook ? { ...knowledgeTexts, [WEB]: hook.fact } : knowledgeTexts,
        newDay: true,
        clientTurnText: '',
        ourPrevious,
        bannedPhrases: banned,
        // No case is offered: a story of a project in a ping is case.unknown.
        cases: { offered: [], told: dossier.toldCases ?? [], choice: null },
      }),
      ...hookIssues({ text, hook: o.hook, seen: res.sources }),
    ]
    out.issues = issues
    if (issues.length === 0) {
      out.choice = { kind: 'ping', text, why, source: hook?.source_url ?? null }
      return out
    }
    // A fact without its page, or a number from nowhere: the rewrite goes without news.
    noNews ||= issues.some((x) => x.id === 'hook.unsourced' || x.id === 'facts.numbers')
  }
  return out
}
