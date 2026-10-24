import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CHECK_SEVERITY, type CheckerOutput } from '@sara/shared'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCheckerRole } from '../../src/conversation/check/checkerRole'
import type { MindHit } from '../../src/conversation/types'
import { createGateway, type Gateway } from '../../src/gateway/gateway'
import { createSecretStore } from '../../src/secrets/store'
import { openTestDb, resetDb } from '../helpers/db'

const ROOT = resolve(import.meta.dirname, '../../../..')
const FAKE = join(ROOT, 'tests/fakes/fake-claude.mjs')
const { db, close } = openTestDb()
afterAll(close)

let dir: string
let log: string
beforeEach(async () => {
  await resetDb(db)
  dir = await mkdtemp(join(tmpdir(), 'checker-'))
  log = join(dir, 'calls.log')
})
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

async function gateway(env: Record<string, string>) {
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  const gw = createGateway({
    db,
    secrets,
    claudeBin: FAKE,
    rolesDir: join(ROOT, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: { FAKE_CLAUDE_ARGS_LOG: log, ...env },
  })
  stops.push(gw.stop)
  return gw
}
const answering = (out: CheckerOutput) =>
  gateway({ FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify({ checker: out }) })
const stdinOf = async () => JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0] ?? '{}')

const NAME = 'Снежана'
const fact = (id: string, title: string, body: string): MindHit => ({
  id,
  type: 'knowledge',
  scope: 'shared',
  title,
  body,
  topic: 'timeline',
  tones: [],
  stages: [],
  exampleClient: null,
  exampleBoris: null,
  rank: 1,
})
const draft = {
  dossierText: `Клиент: ${NAME}. Заказ: лендинг для курсов английского, Краснодар.`,
  facts: [fact('k-landing-time', 'Срок лендинга', 'Лендинг делаем за 2-3 недели.')],
  borisWords: ['Сделаем за три недели, начнём с брифа.'],
  draft: `${NAME}, добрый день! Сделаем лендинг за неделю.`,
  names: [NAME],
}
const CLEAN: CheckerOutput = { unsupported: [], contradicts_boris: null, robotic: [], promises: [] }

describe('the Checker role', () => {
  it("FR-CONV-4: the Checker's unsupported claim becomes an S1 issue", async () => {
    const gw = await answering({ ...CLEAN, unsupported: ['Срок «за неделю» не из записей'] })
    const r = await runCheckerRole(gw, draft)
    expect(r).toEqual({
      issues: [{ id: 'checker.unsupported', detail: 'Срок «за неделю» не из записей' }],
      ran: true,
      modelCallId: expect.any(String),
    })
    expect(CHECK_SEVERITY['checker.unsupported']).toBe('S1')
  })

  it('FR-CONV-4: every note of the Checker becomes its own issue, an empty answer none', async () => {
    const gw = await answering({
      unsupported: ['Неделя не из записей', '  '],
      contradicts_boris: 'Борис назвал три недели',
      robotic: ['Звучит как шаблон', 'Слишком официально'],
      promises: ['Обещан срок без опоры'],
    })
    expect((await runCheckerRole(gw, draft)).issues).toEqual([
      { id: 'checker.unsupported', detail: 'Неделя не из записей' },
      { id: 'checker.contradicts', detail: 'Борис назвал три недели' },
      { id: 'checker.robotic', detail: 'Звучит как шаблон' },
      { id: 'checker.robotic', detail: 'Слишком официально' },
      { id: 'checker.promises', detail: 'Обещан срок без опоры' },
    ])
    const clean = await runCheckerRole(await answering({ ...CLEAN, contradicts_boris: ' ' }), draft)
    expect(clean).toMatchObject({ issues: [], ran: true })
  })

  it('FR-CONV-4: a failed Checker call does not pass the reply silently', async () => {
    const gw = await gateway({ FAKE_CLAUDE_MODE: 'exit1' })
    expect(await runCheckerRole(gw, draft)).toEqual({
      issues: [],
      ran: false,
      modelCallId: expect.any(String),
    })
  })

  it('FR-CONV-4: a Checker that throws counts as not run', async () => {
    const gw: Gateway = {
      call: async () => {
        throw new Error('roles are missing')
      },
    }
    expect(await runCheckerRole(gw, draft)).toEqual({ issues: [], ran: false, modelCallId: null })
  })

  it("FR-CONV-4: the Checker sees the dossier, the cited records, Boris's words and the draft", async () => {
    await runCheckerRole(await answering(CLEAN), draft)
    const { stdin } = await stdinOf()
    for (const part of [
      'лендинг для курсов английского',
      'k-landing-time',
      'Лендинг делаем за 2-3 недели.',
      'Сделаем за три недели, начнём с брифа.',
      'Сделаем лендинг за неделю.',
    ])
      expect(stdin).toContain(part)
  })

  it("NFR-PRIV-2: the client's name reaches the Checker as a tag", async () => {
    await runCheckerRole(await answering(CLEAN), draft)
    const { stdin } = await stdinOf()
    expect(stdin).not.toContain(NAME)
    expect(stdin).toContain('[имя 1]')
  })
})
