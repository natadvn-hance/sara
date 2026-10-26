import type { LessonMakerOutput } from '@sara/shared'
import type { Gateway } from '../../gateway/gateway'
import type { Priority } from '../../gateway/queue'

/** One insight from Boris's edit, or a knowledge record from his interview answer. Part A writes the body. */
export async function makeInsight(
  _gw: Gateway,
  _i: {
    mode: 'edit' | 'interview'
    clientText: string | null
    before: string | null
    after: string
    question: string | null
    why: string | null
    names: string[]
    priority: Priority
  },
): Promise<LessonMakerOutput | null> {
  return null
}
