import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRole } from '../../src/gateway/roles'
import { topicStreaks } from '../../src/school/autonomy/streak'
import { saraVariant } from '../../src/school/trainer/variant'

const ROLES = resolve(import.meta.dirname, '../../../../roles')

describe('M5 stubs at their paths', () => {
  it('FR-TRAIN-6: stub bodies answer as the interface map says until their parts are built', async () => {
    await expect(saraVariant({} as never, {} as never)).rejects.toThrow(/not built/)
    expect(topicStreaks([]).size).toBe(0)
  })

  it('FR-TRAIN-7: every M5 role has its meta and text', async () => {
    for (const name of [
      'trainer-client',
      'trainer-coach',
      'lesson-maker',
      'teacher',
      'persona-builder',
      'dialog-generator',
    ] as const) {
      const r = await loadRole(ROLES, name)
      expect(r.meta.name).toBe(name)
    }
    expect((await loadRole(ROLES, 'teacher')).meta).toMatchObject({ model: 'opus', priority: 'P3' })
    expect((await loadRole(ROLES, 'trainer-client')).meta).toMatchObject({
      model: 'haiku',
      priority: 'P1',
    })
  })
})
