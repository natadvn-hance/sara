import type { Gateway } from '../../gateway/gateway'
import type { CheckIssue, MindHit } from '../types'

/** The Checker role over a draft (FR-CONV-4). Part D writes the body. */
export async function runCheckerRole(
  _gw: Gateway,
  _i: {
    dossierText: string
    facts: MindHit[]
    borisWords: string[]
    draft: string
    names: string[]
  },
): Promise<{ issues: CheckIssue[]; ran: boolean; modelCallId: string | null }> {
  return { issues: [], ran: false, modelCallId: null }
}
