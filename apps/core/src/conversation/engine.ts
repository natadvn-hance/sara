import { InterlocutorOutput } from '@sara/shared'
import { detectCallRequest } from './callDetector'
import { runCheckerRole } from './check/checkerRole'
import { checkReplyText } from './check/codeChecks'
import { decide } from './policy'
import { formatInterlocutorInput } from './prompt'
import type {
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

/** Step 2: the mind a turn needs, by what the client wrote (M4 design 5.3). */
export async function recall(mind: MindSearch, d: Dossier): Promise<Recall> {
  const said = clientTurn(d)
  const text = [said, d.order?.title ?? ''].join('\n')
  const [mindVersion, understanding, knowledge, procedure, always] = await Promise.all([
    mind.version(),
    mind.search({ text: said, scope: d.scope, types: ['understanding'], limit: 6 }),
    mind.search({ text, scope: d.scope, types: ['knowledge'], limit: 8 }),
    mind.byStage(d.stage, d.scope),
    mind.byIds(ALWAYS),
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
  return { mindVersion, understanding, knowledge, examples, procedure, always }
}

const recalledIds = (r: Recall) =>
  [
    ...r.always,
    ...(r.procedure ? [r.procedure] : []),
    ...r.understanding,
    ...r.knowledge,
    ...r.examples,
  ].map((h) => h.id)

/**
 * Steps 2-6 of a turn (FR-CONV-3): recall, understand and say in one Interlocutor call, check by code and by the
 * Checker, one rewrite with the reasons, then the rules. A failed model call is a draft for Boris, never an error.
 */
export async function planTurn(deps: EngineDeps, input: TurnInput): Promise<TurnPlan> {
  const d = input.dossier
  const r = await recall(deps.mind, d)
  const said = clientTurn(d)
  const callRequest = detectCallRequest(said) !== null
  const banned = await deps.mind.bannedPhrases()
  const ids = recalledIds(r)
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
  while (attempts < MAX_ATTEMPTS) {
    attempts++
    const res = await deps.gateway.call(
      'interlocutor',
      formatInterlocutorInput(d, r, issues),
      InterlocutorOutput,
      { correlationId: d.conversationId, redact: { names: input.names } },
    )
    modelCallIds.push(res.modelCallId)
    if (!res.ok) {
      failure = res.errorClass
      output = null
      break
    }
    output = res.output
    issues = checkReplyText({
      text: output.text,
      move: output.move,
      factIds: output.fact_ids,
      recalledIds: ids,
      knowledgeTexts,
      newDay: d.newDay,
      clientTurnText: said,
      ourPrevious,
      bannedPhrases: banned,
    })
    if (output.move === 'reply' && output.text) {
      const checker = await runCheckerRole(deps.gateway, {
        dossierText: said,
        facts: output.fact_ids
          .map((id) => byId.get(id))
          .filter((h): h is MindHit => h !== undefined),
        borisWords,
        draft: output.text,
        names: input.names,
      })
      checkerRan = checker.ran
      if (checker.modelCallId) modelCallIds.push(checker.modelCallId)
      issues = [...issues, ...checker.issues]
    }
    if (issues.length === 0) break
  }
  const decision = decide({
    plan: { output, issues, attempts, checkerRan },
    dossier: d,
    settings: input.settings,
    now: input.now,
    callRequest,
  })
  return { recall: r, output, issues, attempts, decision, modelCallIds, checkerRan, failure }
}
