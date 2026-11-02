import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CASE_MOMENTS,
  CheckerOutput,
  CONV_STAGES,
  ExaminerOutput,
  InterlocutorOutput,
  MOVES,
  ReminderOutput,
  TOPICS,
} from '@sara/shared'
import { describe, expect, it } from 'vitest'
import { loadRole } from '../../src/gateway/roles'
import { checkerDossierOf, interlocutorInputOf, type Scene } from '../helpers/evalScenes'

const ROLES = join(resolve(import.meta.dirname, '../../../..'), 'roles')

/** The M4 roles: their meta (design 5.14, plan D2 and D3) and the schema each answers with. */
const M4_ROLES = {
  interlocutor: {
    meta: {
      version: 14,
      model: 'opus',
      fallbackModel: 'sonnet',
      priority: 'P0',
      timeoutMs: 120000,
    },
    schema: InterlocutorOutput,
  },
  checker: {
    meta: { version: 6, model: 'haiku', fallbackModel: 'sonnet', priority: 'P0', timeoutMs: 60000 },
    schema: CheckerOutput,
  },
  reminder: {
    meta: { version: 2, model: 'sonnet', priority: 'P1', timeoutMs: 120000 },
    schema: ReminderOutput,
  },
  examiner: {
    meta: { version: 2, model: 'sonnet', fallbackModel: 'opus', priority: 'P3', timeoutMs: 120000 },
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
      expect(meta, name).toEqual({ name, ...M4_ROLES[name].meta })
      expect(await readFile(promptPath, 'utf8'), name).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it('FR-CONV-4: the Checker takes any story of a project as unsupported when Sara chose no case', async () => {
    const role = await readFile(join(ROLES, 'checker/role.md'), 'utf8')
    expect(role).toContain('Сара не выбрала кейс: любой рассказ о проекте это unsupported')
  })

  it('FR-SITE-29: the Interlocutor thinks before it answers and never says there are no examples while there is something to show', async () => {
    const role = await readFile(join(ROLES, 'interlocutor/role.md'), 'utf8')
    expect(role).toMatch(/## Как ты думаешь/)
    expect(role).toMatch(/что человек спросил на самом деле/)
    expect(role).toMatch(/Никогда не говори клиенту «нет примеров», «нет кейса»/)
    expect(role).toMatch(/По заказу на сайт всегда есть сайты/)
    // «А вы кто вообще» is a question about Hance, not a try to break the rules.
    expect(role).toMatch(/«А вы кто вообще».*не проверка на бота/)
    expect(role).not.toMatch(/честно скажи, что похожий опыт/)
  })

  it('FR-CONV-4: the Checker catches inventions about the client but does not push an answer into a template', async () => {
    const role = await readFile(join(ROLES, 'checker/role.md'), 'utf8')
    expect(role).toMatch(/Не утверждения и общие слова о том, чем занимается Hance/)
    expect(role).toMatch(/что Сара говорит о клиенте, его бизнесе или сайте, чего нет в досье/)
    expect(role).toMatch(/живая короткая фраза, простой ответ в одну строку/)
    expect(role).toMatch(/Не требуй шаблонных формулировок/)
  })

  it('FR-CONV-5: the Interlocutor takes «хорошо» after a call proposal as agreement, not as the end', async () => {
    const role = await readFile(join(ROLES, 'interlocutor/role.md'), 'utf8')
    // The rule for «none» names the exception, so the two places that mention «ок» and «хорошо» agree.
    const none = role.split('\n').find((l) => /^5\. move/.test(l)) ?? ''
    expect(none).toMatch(/согласие на созвон/)
    expect(none).toMatch(/call_boris и urgent/)
  })

  it('FR-CONV-3: the Interlocutor writes a full answer when it marks call_boris, with no invented price and no call time', async () => {
    const role = await readFile(join(ROLES, 'interlocutor/role.md'), 'utf8')
    const rule =
      role.split('\n').find((l) => l.startsWith('При ходе call_boris в text напиши')) ?? ''
    expect(rule).toMatch(/такой же полный ответ клиенту/)
    expect(rule).toMatch(/никогда не называй цену/)
    expect(rule).toMatch(/Время звонка не называй/)
    // The field list no longer says the text of a call is empty.
    const field = role.split('\n').find((l) => /^10\. text/.test(l)) ?? ''
    expect(field).toMatch(/call_boris это такой же полный ответ клиенту/)
    expect(field).not.toMatch(/При ходе call_boris и none: null/)
  })

  it('FR-CONV-4: the Interlocutor role states what the code checks and names the input as the engine builds it', async () => {
    const role = await readFile(join(ROLES, 'interlocutor/role.md'), 'utf8')
    // The length rule of robotic.length, and the numbers of the examples that the facts check would reject.
    expect(role).toMatch(/длиннее 40 знаков, ответ не длиннее четырёх её длин/)
    expect(role).toMatch(/числа, цены и сроки из образцов в свой текст не переноси/i)
    // The authors, the flags and the stages as prompt.ts prints them.
    for (const word of [
      'Сара (старая)',
      'Профи.ру',
      'наша сторона',
      'Новый день',
      'Ночь по Москве',
    ])
      expect(role, word).toContain(word)
    for (const stage of CONV_STAGES) expect(role, stage).toContain(stage)
    expect(role).not.toContain('Сара v1')
  })

  it('FR-CONV-14: the Interlocutor role writes as Boris in the first person and answers price and bargaining by substance', async () => {
    const role = await readFile(join(ROLES, 'interlocutor/role.md'), 'utf8')
    expect(role).toMatch(/от лица Бориса Мнояна/)
    expect(role).toMatch(/Никогда не пиши о Борисе в третьем лице/)
    expect(role).toMatch(/по цене уложимся, это не проблема/)
    expect(role).toMatch(/подробное письмо подробный ответ/)
    expect(role).not.toMatch(
      /на него лично ответит Борис|звонит только Борис|Эти темы всегда у Бориса/,
    )
  })

  it('FR-CONV-4: the examiner does not judge facts it has no records for, and its example holds no invented number', async () => {
    const role = await readFile(join(ROLES, 'examiner/role.md'), 'utf8')
    expect(role).not.toMatch(/которых нет в переписке и записях/)
    expect(role).toMatch(/Записей разума у тебя нет/)
    for (const line of role.split('\n').filter((l) => l.startsWith('Пример.')))
      expect(line.replace(/На \d:/g, ''), line).not.toMatch(/\d/)
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

  it('FR-CONV-3: the stored sample inputs are what the real formatters build from their scenes', async () => {
    // UPDATE_EVAL_SAMPLES=1 rewrites the stored text after a change of prompt.ts, then the test checks it again.
    const update = process.env.UPDATE_EVAL_SAMPLES === '1'
    for (const [role, field, build] of [
      ['interlocutor', 'input', interlocutorInputOf],
      ['checker', 'dossierText', checkerDossierOf],
    ] as const) {
      const file = join(ROLES, role, 'evals/samples.json')
      const list = await samples(role)
      if (update) {
        for (const s of list) s[field] = build(s.scene as Scene)
        await writeFile(file, `${JSON.stringify(list, null, 2)}\n`)
      }
      for (const s of list) expect(s[field], `${role}: ${s.title}`).toBe(build(s.scene as Scene))
    }
  })

  it('FR-CONV-3: the Interlocutor samples expect a move and a topic, the Checker samples a verdict per field', async () => {
    const talk = await samples('interlocutor')
    expect(talk).toHaveLength(11)
    for (const s of talk) {
      const expected = s.expected as { move: string; topic: string }
      expect(MOVES).toContain(expected.move)
      expect(TOPICS).toContain(expected.topic)
      // The invented client's name is given, so a run hides it from the model like a real one.
      for (const n of s.names as string[]) expect(s.input).toContain(n)
    }
    const checks = await samples('checker')
    expect(checks).toHaveLength(11)
    for (const s of checks)
      expect(Object.keys(s.expected as object).sort()).toEqual(
        Object.keys(CheckerOutput.shape).sort(),
      )
  })

  it('FR-CONV-4: the case samples cover a case that is needed, one that is not, and none to offer', async () => {
    const offered = (s: Record<string, unknown>) =>
      ((s.scene as Scene).recall?.cases ?? []).map((c) => c.id)
    const talk = (await samples('interlocutor')).slice(8)
    expect(
      talk.map((s) => (s.expected as { case: { case_id: string | null } }).case.case_id),
    ).toEqual(['k-case-21', null, null])
    for (const s of talk) {
      const want = (s.expected as { case: { case_id: string | null; moment: string | null } }).case
      // A case that is expected is among those the sample offers, with one of the four moments.
      if (want.case_id) {
        expect(offered(s)).toContain(want.case_id)
        expect(CASE_MOMENTS).toContain(want.moment)
      } else expect(want.moment).toBeNull()
      expect(s.input as string).toContain('## Кейсы')
    }
    // The last offers none, and its input says so.
    expect(offered(talk[2] ?? {})).toEqual([])
    expect(talk[2]?.input).toContain('Подходящих кейсов нет, не выдумывай')
    // The Checker samples: a case that fits passes, a needless one is noted, an invented one is unsupported.
    const checks = (await samples('checker')).slice(8)
    const verdicts = checks.map((s) => s.expected as { case: boolean; unsupported: boolean })
    expect(verdicts.map((v) => [v.case, v.unsupported])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ])
    for (const s of checks) {
      const choice = s.caseChoice as { case_id: string; moment: string } | null
      if (choice) expect(offered(s)).toContain(choice.case_id)
    }
    expect(checks[2]?.caseChoice).toBeNull()
  })
})
