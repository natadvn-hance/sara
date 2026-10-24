import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CheckerOutput,
  ExaminerOutput,
  InterlocutorOutput,
  MOVES,
  ReminderOutput,
  TOPICS,
} from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { loadRole } from '../../src/gateway/roles'

const ROLES = join(resolve(import.meta.dirname, '../../../..'), 'roles')

/** The M4 roles: their meta (design 5.14, plan D2 and D3) and the schema each answers with. */
const M4_ROLES = {
  interlocutor: {
    meta: { model: 'sonnet', fallbackModel: 'opus', priority: 'P0', timeoutMs: 120000 },
    schema: InterlocutorOutput,
  },
  checker: {
    meta: { model: 'haiku', fallbackModel: 'sonnet', priority: 'P0', timeoutMs: 60000 },
    schema: CheckerOutput,
  },
  reminder: {
    meta: { model: 'sonnet', priority: 'P1', timeoutMs: 120000 },
    schema: ReminderOutput,
  },
  examiner: {
    meta: { model: 'sonnet', fallbackModel: 'opus', priority: 'P3', timeoutMs: 120000 },
    schema: ExaminerOutput,
  },
} as const
const NAMES = Object.keys(M4_ROLES) as (keyof typeof M4_ROLES)[]

const samples = async (role: string) =>
  JSON.parse(await readFile(join(ROLES, role, 'evals/samples.json'), 'utf8')) as Record<
    string,
    unknown
  >[]

describe('the M4 roles', () => {
  it('NFR-UX-1: role texts have no long dash and every role loads', async () => {
    for (const name of NAMES) {
      const { meta, promptPath } = await loadRole(ROLES, name)
      expect(meta, name).toEqual({ name, version: 1, ...M4_ROLES[name].meta })
      expect(await readFile(promptPath, 'utf8'), name).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it('FR-CONV-3: every M4 role explains each output field in the schema order', async () => {
    for (const name of NAMES) {
      const lines = (await readFile(join(ROLES, name, 'role.md'), 'utf8')).split('\n')
      const at = Object.keys(M4_ROLES[name].schema.shape).map((field) =>
        lines.findIndex((l) => new RegExp(`^\\d+\\. ${field}\\b`).test(l)),
      )
      expect(
        at.every((n) => n >= 0),
        `${name}: ${at}`,
      ).toBe(true)
      expect(
        at.every((n, k) => k === 0 || n > (at[k - 1] ?? -1)),
        `${name}: ${at}`,
      ).toBe(true)
    }
  })

  it('FR-CONV-3: the Interlocutor samples expect a move and a topic, the Checker samples a verdict per field', async () => {
    const talk = await samples('interlocutor')
    expect(talk).toHaveLength(8)
    for (const s of talk) {
      const expected = s.expected as { move: string; topic: string }
      expect(MOVES).toContain(expected.move)
      expect(TOPICS).toContain(expected.topic)
      // The invented client's name is given, so a run hides it from the model like a real one.
      for (const n of s.names as string[]) expect(s.input).toContain(n)
    }
    const checks = await samples('checker')
    expect(checks).toHaveLength(8)
    for (const s of checks)
      expect(Object.keys(s.expected as object).sort()).toEqual(
        Object.keys(CheckerOutput.shape).sort(),
      )
  })
})
