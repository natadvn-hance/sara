import type { MindSearch } from '../conversation/types'
import type { Db } from '../db/client'

/** Search over the confirmed mind (FR-MIND-2). Part B writes the body; until then the mind is empty. */
export function createMindSearch(_db: Db): MindSearch {
  return {
    version: async () => 'empty',
    search: async () => [],
    byIds: async () => [],
    byStage: async () => null,
    bannedPhrases: async () => [],
  }
}
