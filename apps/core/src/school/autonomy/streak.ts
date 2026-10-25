import type { Topic } from '@sara/shared'
import type { TurnFacts } from '../types'

export type TopicStreak = {
  streak: number
  lastEditAt: string | null
  lastSubstantialAt: string | null
  lastTurnId: string | null
}

/** Approvals in a row by topic (FR-AUTO-3). Part F writes the body. */
export function topicStreaks(_facts: TurnFacts[]): Map<Topic, TopicStreak> {
  return new Map()
}
