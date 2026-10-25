import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRole } from '../../src/gateway/roles'
import { guardRecord } from '../../src/mind/guard'
import { renderRecord } from '../../src/mind/render'
import { createMindWriter } from '../../src/mind/writer'
import { topicStreaks } from '../../src/school/autonomy/streak'
import { editWeight } from '../../src/school/lessons/edit'
import { makeInsight } from '../../src/school/lessons/maker'
import { createLesson, decideLesson } from '../../src/school/lessons/store'
import { deferredNotices, takeNotice } from '../../src/school/notices'
import { saraVariant } from '../../src/school/trainer/variant'

const ROLES = resolve(import.meta.dirname, '../../../../roles')
const db = {} as never

describe('M5 stubs at their paths', () => {
  it('stub bodies answer as the interface map says until their parts are built', async () => {
    expect(await takeNotice(db, new Date(), 'batch')).toBe(true)
    expect(await deferredNotices(db, '2026-10-25')).toEqual([])
    expect(() => renderRecord({} as never, null, '2026-10-25')).toThrow(/render is not built/)
    expect(guardRecord({} as never)).toBeNull()
    const writer = createMindWriter({ db, mindDir: '/nowhere', reindex: async () => {} })
    expect(await writer.apply([], { lessonIds: [], batchId: null })).toMatchObject({
      ok: false,
      reason: 'no_git',
    })
    expect(await writer.revert('x')).toMatchObject({ ok: false, reason: 'no_git' })
    expect(await writer.sync()).toEqual({ pushed: false, pulled: 0, error: 'not built' })
    await expect(createLesson(db, {} as never)).rejects.toThrow(/lessons are not built/)
    await expect(decideLesson(db, 'x', { decision: 'yes' })).rejects.toThrow(
      /lessons are not built/,
    )
    expect(await makeInsight({} as never, {} as never)).toBeNull()
    expect(editWeight('a', 'b', { substantialBelow: 70, names: [] })).toBe('minor')
    await expect(saraVariant({} as never, {} as never)).rejects.toThrow(/not built/)
    expect(topicStreaks([]).size).toBe(0)
  })

  it('every M5 role has its meta and text', async () => {
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
