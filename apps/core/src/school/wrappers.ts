import type { MindSearch } from '../conversation/types'
import type { Gateway } from '../gateway/gateway'
import type { Priority } from '../gateway/queue'

/**
 * The same gateway with every call at this priority, over the role's and the caller's: the trainer asks P1 by day
 * and P3 when it prepares at night, so the engine's client roles (P0) never jump the queue for a training.
 */
export function withPriority(gw: Gateway, p: Priority): Gateway {
  return {
    call: (role, input, schema, opts) => gw.call(role, input, schema, { ...opts, priority: p }),
  }
}

/**
 * The same search without these records: Sara's variant for a reply from a real chat must not see the example made
 * from that very reply (the guess mode, the blind test).
 */
export function withExcluded(mind: MindSearch, ids: string[]): MindSearch {
  const out = new Set(ids)
  return {
    version: () => mind.version(),
    bannedPhrases: () => mind.bannedPhrases(),
    async search(q) {
      const found = await mind.search({ ...q, limit: q.limit + out.size })
      return found.filter((h) => !out.has(h.id)).slice(0, q.limit)
    },
    async byIds(want) {
      return mind.byIds(want.filter((id) => !out.has(id)))
    },
    async byStage(stage, scope) {
      const h = await mind.byStage(stage, scope)
      return h && !out.has(h.id) ? h : null
    },
  }
}
