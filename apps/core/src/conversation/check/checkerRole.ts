import { CheckerOutput } from '@sara/shared'
import type { Gateway, RoleCallResult } from '../../gateway/gateway'
import type { CheckIssue, MindHit } from '../types'

/** The Checker's input: the headings its instruction (roles/checker/role.md) reads. */
function checkerInput(i: {
  dossierText: string
  facts: MindHit[]
  borisWords: string[]
  draft: string
}): string {
  const facts = i.facts.length
    ? i.facts.map((f) => `[${f.id}] ${f.title}\n${f.body.trim()}`).join('\n\n')
    : 'Черновик не ссылается ни на одну запись.'
  const boris = i.borisWords.length
    ? i.borisWords.map((w) => `- ${w.trim()}`).join('\n')
    : 'Подтверждённых слов Бориса в этом чате нет. Кто писал сообщения «наша сторона», неизвестно: мог и Борис.'
  return [
    `## Досье\n${i.dossierText.trim()}`,
    `## Записи разума\n${facts}`,
    `## Слова Бориса в этом чате\n${boris}`,
    `## Черновик\n${i.draft.trim()}`,
  ].join('\n\n')
}

/** A long or medium dash, with the spaces around it: the model writes them though the role forbids them. */
const LONG_DASH = new RegExp(`\\s*[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]\\s*`, 'g')
/** A note is read by Boris on a card and fed back to the Interlocutor: a short hyphen, never a long dash (NFR-UX-1). */
const tidy = (n: string) => n.replace(LONG_DASH, ' - ').trim()
const notes = (list: string[]) => list.map(tidy).filter(Boolean)

/** The Checker role over a draft (FR-CONV-4): any note it makes is a reason the draft fails. */
export async function runCheckerRole(
  gw: Gateway,
  i: {
    dossierText: string
    facts: MindHit[]
    borisWords: string[]
    draft: string
    names: string[]
    /** The conversation the draft is for: the journal ties the call to it, as the Interlocutor's call. */
    correlationId?: string
  },
): Promise<{ issues: CheckIssue[]; ran: boolean; modelCallId: string | null }> {
  let r: RoleCallResult<CheckerOutput>
  try {
    r = await gw.call('checker', checkerInput(i), CheckerOutput, {
      correlationId: i.correlationId,
      redact: { names: i.names },
    })
  } catch (e) {
    // The turn goes on «без Проверяющего», as a draft: the code checks decide alone.
    console.error('checker not run', e instanceof Error ? e.message : e)
    return { issues: [], ran: false, modelCallId: null }
  }
  if (!r.ok) return { issues: [], ran: false, modelCallId: r.modelCallId }
  const o = r.output
  const contradicts = o.contradicts_boris ? tidy(o.contradicts_boris) : ''
  const issues: CheckIssue[] = [
    ...notes(o.unsupported).map((detail) => ({ id: 'checker.unsupported' as const, detail })),
    ...(contradicts ? [{ id: 'checker.contradicts' as const, detail: contradicts }] : []),
    ...notes(o.robotic).map((detail) => ({ id: 'checker.robotic' as const, detail })),
    ...notes(o.promises).map((detail) => ({ id: 'checker.promises' as const, detail })),
  ]
  return { issues, ran: true, modelCallId: r.modelCallId }
}
