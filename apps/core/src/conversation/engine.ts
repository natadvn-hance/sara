import { InterlocutorOutput } from '@sara/shared'
import { agreesToCallProposal, detectCallRequest } from './callDetector'
import { caseLink } from './caseLink'
import { namesCase } from './check/caseChecks'
import { runCheckerRole } from './check/checkerRole'
import { checkReplyText } from './check/codeChecks'
import { decide } from './policy'
import { formatCheckerDossier, formatInterlocutorInput } from './prompt'
import type {
  CaseHit,
  CheckIssue,
  Dossier,
  EngineDeps,
  MindHit,
  MindSearch,
  Recall,
  TurnInput,
  TurnPlan,
} from './types'

/** Records on every turn: who Sara is, the greeting, Boris's topics, Hance's values, the speech portrait. */
const ALWAYS = ['j-constitution', 'j-greeting', 'j-autonomy', 'j-hance-values', 's-portrait']

/** One rewrite after failed checks, then a draft (M4 design 5.6). */
const MAX_ATTEMPTS = 2

const clientTurn = (d: Dossier) => {
  const turn = new Set(d.turnMessageIds)
  return d.messages
    .filter((m) => turn.has(m.platformMessageId))
    .map((m) => m.text)
    .join('\n')
}

const uniq = (hits: MindHit[]) => [...new Map(hits.map((h) => [h.id, h])).values()]

/** How many cases a turn is offered, and how many the search is asked for before the told ones are dropped. */
const CASES_OFFERED = 3
const CASES_FETCHED = 8

/**
 * The most words the case query holds. The case search (mind/search.ts MAX_WORDS) keeps this many distinct words of
 * three letters or more: the first ones for a case search, the last ones for the fact search. The query is cut to the
 * cap here, with the client's words first, so whichever end the search keeps the client's turn is in it.
 */
const CASE_QUERY_WORDS = 32

/**
 * The start of `text` that adds at most `room` words the query does not have yet (a word of three letters or more,
 * the same as the search counts), as written. The words it takes are added to `seen`.
 */
function withinWords(text: string, seen: Set<string>, room: number): string {
  let end = text.length
  let added = 0
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0].toLowerCase()
    if (w.length < 3 || seen.has(w)) continue
    if (added >= room) {
      end = m.index
      break
    }
    seen.add(w)
    added++
  }
  return text.slice(0, end).trim()
}

/** The text of the case query: the client's turn first, then the order's title and text in the room that is left. */
export function caseQuery(said: string, order: Dossier['order']): string {
  const seen = new Set<string>()
  const parts = [withinWords(said, seen, CASE_QUERY_WORDS)]
  for (const part of [order?.title, order?.text]) {
    const kept = part ? withinWords(part, seen, CASE_QUERY_WORDS - seen.size) : ''
    if (kept) parts.push(kept)
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * The cases of Hance for a turn (cases in a conversation): found by the client's words and the order, never one the
 * chat already heard, by its trace or because a message of our side names it by its brand. Without the case search
 * (the stub mind) there are none, and a search that fails costs the turn only its cases.
 */
async function casesFor(mind: MindSearch, d: Dossier, said: string): Promise<CaseHit[]> {
  if (!mind.cases) return []
  const toldIds = (d.toldCases ?? []).map((c) => c.id)
  const ours = d.messages.filter((m) => m.side === 'specialist').map((m) => m.text)
  const text = caseQuery(said, d.order)
  try {
    const found = await mind.cases({
      text,
      scope: d.scope,
      limit: CASES_FETCHED,
      exclude: toldIds,
    })
    return found
      .filter((c) => !toldIds.includes(c.id) && !ours.some((m) => namesCase(m, c.title)))
      .slice(0, CASES_OFFERED)
  } catch (e) {
    console.error('case search failed', e instanceof Error ? e.message : e)
    return []
  }
}

/** Step 2: the mind a turn needs, by what the client wrote (M4 design 5.3). */
export async function recall(mind: MindSearch, d: Dossier): Promise<Recall> {
  const said = clientTurn(d)
  const text = [said, d.order?.title ?? ''].join('\n')
  const [mindVersion, understanding, knowledge, procedure, always, cases] = await Promise.all([
    mind.version(),
    mind.search({ text: said, scope: d.scope, types: ['understanding'], limit: 6 }),
    mind.search({ text, scope: d.scope, types: ['knowledge'], limit: 8 }),
    mind.byStage(d.stage, d.scope),
    mind.byIds(ALWAYS),
    casesFor(mind, d, said),
  ])
  let examples = (
    await mind.search({
      text: said,
      scope: d.scope,
      types: ['example'],
      limit: 5,
      field: 'example_client',
    })
  ).filter((e) => e.exampleBoris)
  if (examples.length < 3 && understanding[0]) {
    const more = await mind.search({
      text: understanding[0].title,
      scope: d.scope,
      types: ['example'],
      limit: 5,
      field: 'example_client',
    })
    examples = uniq([...examples, ...more.filter((e) => e.exampleBoris)]).slice(0, 5)
  }
  return { mindVersion, understanding, knowledge, examples, procedure, always, cases }
}

/** The ids the reply may cite: every record of the turn, and the cases it was offered. */
const recalledIds = (r: Recall, cases: CaseHit[]) =>
  [
    ...r.always,
    ...(r.procedure ? [r.procedure] : []),
    ...r.understanding,
    ...r.knowledge,
    ...r.examples,
    ...cases,
  ].map((h) => h.id)

/** A fault of the case in a reply: the rewrite after one may not tell a case at all. */
const isCaseIssue = (x: CheckIssue) => x.id.startsWith('case.') || x.id === 'checker.case'

/**
 * Steps 2-6 of a turn (FR-CONV-3): recall, understand and say in one Interlocutor call, check by code and by the
 * Checker, one rewrite with the reasons, then the rules. A failed model call is a draft for Boris, never an error.
 */
export async function planTurn(deps: EngineDeps, input: TurnInput): Promise<TurnPlan> {
  const d = input.dossier
  const r = await recall(deps.mind, d)
  const said = clientTurn(d)
  // A phone or a word of a call, or a bare «да» to our message that proposed a call.
  const firstOfTurn = d.messages.findIndex((m) => d.turnMessageIds.includes(m.platformMessageId))
  const before = firstOfTurn > 0 ? d.messages[firstOfTurn - 1] : undefined
  const callRequest =
    detectCallRequest(said) !== null ||
    agreesToCallProposal(said, before?.side === 'specialist' ? before.text : null)
  const banned = await deps.mind.bannedPhrases()
  const told = d.toldCases ?? []
  const knowledgeTexts = Object.fromEntries(r.knowledge.map((k) => [k.id, k.body]))
  const ourPrevious = d.messages.filter((m) => m.side === 'specialist').map((m) => m.text)
  const borisWords = d.messages.filter((m) => m.author === 'boris').map((m) => m.text)
  const byId = new Map(
    [...r.always, ...(r.procedure ? [r.procedure] : []), ...r.understanding, ...r.knowledge].map(
      (h) => [h.id, h],
    ),
  )
  const modelCallIds: string[] = []
  let output: InterlocutorOutput | null = null
  let issues: CheckIssue[] = []
  let failure: string | null = null
  let checkerRan = false
  let attempts = 0
  // A failed case check sends the rewrite out with no case offered and none allowed.
  let withoutCase = false
  let chosen: CaseHit | undefined
  while (attempts < MAX_ATTEMPTS) {
    attempts++
    const offered = withoutCase ? [] : r.cases
    const res = await deps.gateway.call(
      'interlocutor',
      formatInterlocutorInput(d, { ...r, cases: offered }, issues, withoutCase),
      InterlocutorOutput,
      { correlationId: d.conversationId, redact: { names: input.names } },
    )
    modelCallIds.push(res.modelCallId)
    if (!res.ok) {
      failure = res.errorClass
      output = null
      chosen = undefined
      break
    }
    // Only a reply carries a text and a case; with another move they are never checked, so never shown or kept.
    output =
      res.output.move === 'reply' ? res.output : { ...res.output, text: null, case: undefined }
    const choice = output.case ?? null
    chosen = choice?.case_id ? offered.find((c) => c.id === choice.case_id) : undefined
    issues = checkReplyText({
      text: output.text,
      move: output.move,
      factIds: output.fact_ids,
      recalledIds: recalledIds(r, offered),
      knowledgeTexts,
      newDay: d.newDay,
      clientTurnText: said,
      ourPrevious,
      bannedPhrases: banned,
      cases: { offered, told, choice },
    })
    if (output.move === 'reply' && output.text) {
      const checker = await runCheckerRole(deps.gateway, {
        dossierText: formatCheckerDossier(d),
        facts: output.fact_ids
          .map((id) => byId.get(id))
          .filter((h): h is MindHit => h !== undefined),
        borisWords,
        draft: output.text,
        names: input.names,
        correlationId: d.conversationId,
        caseChoice: chosen
          ? { moment: choice?.moment ?? null, why: choice?.why ?? null, hit: chosen }
          : undefined,
      })
      checkerRan = checker.ran
      if (checker.modelCallId) modelCallIds.push(checker.modelCallId)
      issues = [...issues, ...checker.issues]
    }
    if (issues.length === 0) break
    withoutCase = issues.some(isCaseIssue)
  }
  // The link of a case is the code's: put after the checks, when the client asked and the case allows it.
  if (issues.length === 0 && output?.move === 'reply' && output.text && chosen) {
    const link = caseLink(chosen, output.case?.moment ?? null)
    if (link) output = { ...output, text: `${output.text}\n\n${link}` }
  }
  const decision = decide({
    plan: { output, issues, attempts, checkerRan },
    dossier: d,
    settings: input.settings,
    now: input.now,
    callRequest,
  })
  // The case the reply tells for the trace and the card: offered to the last attempt, and no case check refused it.
  const tellsCase = output?.move === 'reply' && !issues.some(isCaseIssue) ? chosen : undefined
  return {
    recall: r,
    output,
    issues,
    attempts,
    decision,
    modelCallIds,
    checkerRan,
    failure,
    case: tellsCase,
  }
}
