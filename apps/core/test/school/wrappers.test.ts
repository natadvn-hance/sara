import { describe, expect, it } from 'vitest'
import type { MindHit, MindSearch } from '../../src/conversation/types'
import type { CallOptions, Gateway } from '../../src/gateway/gateway'
import { withExcluded, withPriority } from '../../src/school/wrappers'

function recordingGateway(): { gw: Gateway; opts: (CallOptions | undefined)[] } {
  const opts: (CallOptions | undefined)[] = []
  const gw: Gateway = {
    call: async (_role, _input, _schema, o) => {
      opts.push(o)
      return {
        ok: false,
        errorClass: 'limit_reached',
        message: '',
        durationMs: 0,
        modelCallId: 'x',
      }
    },
  }
  return { gw, opts }
}

const hit = (id: string): MindHit => ({
  id,
  type: 'example',
  scope: 'shared',
  title: id,
  body: '',
  topic: null,
  tones: [],
  stages: [],
  exampleClient: null,
  exampleBoris: null,
  rank: 1,
})

function fakeMind(ids: string[]): MindSearch & { asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    version: async () => 'v1',
    search: async (q) => {
      asked.push(q.limit)
      return ids.slice(0, q.limit).map(hit)
    },
    byIds: async (want) => want.map(hit),
    byStage: async () => hit('j-stage-talking'),
    bannedPhrases: async () => ['Рад помочь'],
  }
}

describe('school wrappers', () => {
  it("FR-TRAIN-3: training calls go as P1, not as a client's P0", async () => {
    const { gw, opts } = recordingGateway()
    const schema = { parse: (x: unknown) => x } as never
    await withPriority(gw, 'P1').call('interlocutor', 'x', schema)
    await withPriority(gw, 'P1').call('checker', 'x', schema, { priority: 'P0', limitWaitMs: 0 })
    expect(opts.map((o) => o?.priority)).toEqual(['P1', 'P1'])
    expect(opts[1]?.limitWaitMs).toBe(0)
  })

  it('NFR-COST-2: night preparation goes as P3 through the same wrapper', async () => {
    const { gw, opts } = recordingGateway()
    await withPriority(gw, 'P3').call('interlocutor', 'x', { parse: (x: unknown) => x } as never)
    expect(opts[0]?.priority).toBe('P3')
  })

  it('FR-SPEECH-4: an excluded example never comes back from search', async () => {
    const mind = fakeMind(['e-h-1', 'e-h-2', 'e-h-3', 'e-h-4', 'e-h-5'])
    const wrapped = withExcluded(mind, ['e-h-1', 'e-h-2'])
    const found = await wrapped.search({
      text: 'цена',
      scope: 'shared',
      types: ['example'],
      limit: 3,
    })
    expect(found.map((h) => h.id)).toEqual(['e-h-3', 'e-h-4', 'e-h-5'])
    expect(mind.asked).toEqual([5])
    expect((await wrapped.byIds(['e-h-1', 'e-h-3'])).map((h) => h.id)).toEqual(['e-h-3'])
    expect(await withExcluded(mind, ['j-stage-talking']).byStage('talking', 'shared')).toBeNull()
    expect(await wrapped.version()).toBe('v1')
    expect(await wrapped.bannedPhrases()).toEqual(['Рад помочь'])
  })
})
