import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { directionVersion, question, ruleProposal, task } from '../../src/db/schema'
import { activeRules, rollbackTo, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { createGateway, type Gateway } from '../../src/gateway/gateway'
import { backtest } from '../../src/learning/backtest'
import { recordLabel } from '../../src/learning/labels'
import { maybePropose, onProposalPress } from '../../src/learning/proposals'
import { answerQuestion, askWhy } from '../../src/learning/questions'
import type { Notifier } from '../../src/notify/notifier'
import { createSecretStore } from '../../src/secrets/store'
import { openTestDb, resetDb } from '../helpers/db'
import { countEvents } from '../helpers/events'
import { leadWithScore } from '../helpers/learning'
import { scorerAnswer } from '../helpers/scorer'

const ROOT = resolve(import.meta.dirname, '../../../..')
const ACC = 'hance-marketing'
const { db, close } = openTestDb()
afterAll(close)
type Sent = { text: string; rows: { text: string; callbackData: string }[][] }
let sent: Sent[] = []
let nextId = 700
const notifier: Notifier = {
  sendLeadCard: async () => ({ messageId: nextId++ }),
  sendText: async (text) => {
    sent.push({ text, rows: [] })
    return { messageId: nextId++ }
  },
  sendButtons: async (text, rows) => {
    sent.push({ text, rows })
    return { messageId: nextId++ }
  },
}
let dir: string
async function gateway(byRole: Record<string, unknown>): Promise<Gateway> {
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  return createGateway({
    db,
    secrets,
    claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
    rolesDir: join(dir, 'roles'),
    dataDir: join(dir, 'data'),
    extraEnv: { FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole) },
  })
}
const PROPOSAL = {
  summary: 'Порог выше: 60 вместо 56',
  why: 'Ты пропускал заявки с высоким баллом: «копейки, не наш клиент»',
  rules: { ...RULES_V1, threshold: 60 },
}
const NOW = new Date('2026-10-25T09:00:00Z')

/** Three skips Sara did not expect, each with Boris's reason, and one yes. */
async function threeSurprises() {
  for (const [i, id] of ['940001', '940002', '940003'].entries()) {
    await leadWithScore(db, id, 80)
    await recordLabel(db, { leadId: id, label: 'no', source: 'card' })
    await askWhy(
      { db, notifier },
      { kind: 'why_skip', entityId: id, title: 'Т' },
      new Date(NOW.getTime() + i * 60_000),
    )
    await answerQuestion(db, {
      text: 'копейки, не наш клиент',
      replyToMessageId: null,
      voice: false,
      at: new Date(NOW.getTime() + i * 60_000 + 1000),
    })
  }
  await leadWithScore(db, '940004', 70)
  await recordLabel(db, { leadId: '940004', label: 'yes', source: 'card' })
}
const proposalTask = async () =>
  (await db.select().from(task).where(eq(task.kind, 'rule_proposal')))[0]?.id ?? ''

beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
  sent = []
  dir = await mkdtemp(join(tmpdir(), 'proposals-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
})

describe('rule proposals', () => {
  it('FR-MIND-3: three answered surprises bring one proposal with its backtest numbers', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('asked')
    const msg = sent.at(-1)
    expect(msg?.text.split('\n')).toEqual([
      'Предлагаю поправку правил (v1 → v2): Порог выше: 60 вместо 56',
      'Почему: Ты пропускал заявки с высоким баллом: «копейки, не наш клиент»',
      'Что меняется: Порог: 56 → 60',
      'На последних 4 заявках это изменило бы 4 решений: 3 в твою сторону, 1 против.',
    ])
    expect(msg?.rows.flat().map((b) => b.text)).toEqual(['Применить', 'Не надо'])
    expect(await countEvents(db, 'rules.proposed')).toBe(1)
  })

  it('FR-MIND-3: nothing changes until «Применить»', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    expect((await activeRules(db, ACC)).version).toBe(1)
    const t = await proposalTask()
    expect(await onProposalPress({ db, notifier }, t, 'apply')).toBe('Применила, теперь правила v2')
    expect(await activeRules(db, ACC)).toMatchObject({ version: 2, rules: { threshold: 60 } })
    const [v2] = await db.select().from(directionVersion).where(eq(directionVersion.version, 2))
    expect(v2).toMatchObject({ createdBy: 'boris', reason: 'Порог выше: 60 вместо 56' })
    expect(await onProposalPress({ db, notifier }, t, 'apply')).toBe('Уже сделано')
    expect((await activeRules(db, ACC)).version).toBe(2)
  })

  it('FR-MIND-3: «Не надо» keeps the rules and asks why', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, new Date('2026-10-25T09:30:00Z'))
    expect(await onProposalPress({ db, notifier }, await proposalTask(), 'drop')).toBe(
      'Хорошо, оставляю v1',
    )
    expect((await activeRules(db, ACC)).version).toBe(1)
    expect((await db.select().from(ruleProposal))[0]?.state).toBe('declined')
    expect(sent.at(-1)?.text).toBe('Почему не надо эту поправку? Напиши или скажи голосом.')
    expect((await db.select().from(question)).some((q) => q.kind === 'why_decline')).toBe(true)
  })

  it('FR-MIND-3: no new proposal while one waits, and not twice a day', async () => {
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await leadWithScore(db, '940009', 80)
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('not_yet')
    await threeSurprises()
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('asked')
    expect(
      await maybePropose({ db, gateway: gw, notifier }, ACC, new Date(NOW.getTime() + 60_000)),
    ).toBe('not_yet')
    await onProposalPress({ db, notifier }, await proposalTask(), 'drop')
    // Declined, but the day already had its proposal.
    expect(
      await maybePropose({ db, gateway: gw, notifier }, ACC, new Date(NOW.getTime() + 120_000)),
    ).toBe('not_yet')
    expect(await countEvents(db, 'rules.proposed')).toBe(1)
  })

  it('FR-MIND-3: rules that break the schema are thrown away without a message', async () => {
    await threeSurprises()
    const broken = {
      ...PROPOSAL,
      rules: { ...RULES_V1, axes: RULES_V1.axes.map((a) => ({ ...a, weight: 30 })) },
    }
    const gw = await gateway({ 'rules-proposer': broken, scorer: scorerAnswer(58) })
    const before = sent.length
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('invalid')
    expect(sent.length).toBe(before)
    expect(await countEvents(db, 'rules.proposal_invalid')).toBe(1)
    expect(await db.select().from(ruleProposal)).toHaveLength(0)
  })

  it('FR-MIND-3: a proposal made for v1 is not applied after the rules changed', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    await rollbackTo(db, ACC, 1)
    expect(await onProposalPress({ db, notifier }, await proposalTask(), 'apply')).toBe(
      'Правила уже поменялись, предложение устарело',
    )
    expect(await activeRules(db, ACC)).toMatchObject({ version: 2, rules: { threshold: 56 } })
  })

  it('FR-MIND-3: a proposal Telegram did not take leaves nothing waiting', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    const failing: Notifier = {
      ...notifier,
      sendButtons: async () => {
        throw new Error('telegram down')
      },
    }
    await expect(maybePropose({ db, gateway: gw, notifier: failing }, ACC, NOW)).rejects.toThrow()
    expect(await db.select().from(ruleProposal)).toHaveLength(0)
    expect(await db.select().from(task).where(eq(task.kind, 'rule_proposal'))).toHaveLength(0)
    // The next day the same surprises still count.
    expect(
      await maybePropose({ db, gateway: gw, notifier }, ACC, new Date('2026-10-26T09:00:00Z')),
    ).toBe('asked')
  })

  it('FR-MIND-3: «Применить» is all or nothing: a failed write can be pressed again', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    const t = await proposalTask()
    await db.execute(
      sql`create or replace function core.fail_version() returns trigger language plpgsql as $$ begin raise exception 'disk full'; end $$`,
    )
    await db.execute(sql`drop trigger if exists fail_version on core.direction_version`)
    await db.execute(
      sql`create trigger fail_version before insert on core.direction_version for each row execute function core.fail_version()`,
    )
    try {
      await expect(onProposalPress({ db, notifier }, t, 'apply')).rejects.toThrow()
    } finally {
      await db.execute(sql`drop trigger if exists fail_version on core.direction_version`)
    }
    expect((await db.select().from(ruleProposal))[0]?.state).toBe('asked')
    expect(await onProposalPress({ db, notifier }, t, 'apply')).toBe('Применила, теперь правила v2')
  })

  it('FR-MIND-3: a proposal that touches more than one part of the rules, or none, is thrown away', async () => {
    await threeSurprises()
    const two = {
      ...PROPOSAL,
      rules: {
        ...RULES_V1,
        threshold: 60,
        stop_factors: RULES_V1.stop_factors.filter((f) => f.id !== 'direct'),
      },
    }
    const gw = await gateway({ 'rules-proposer': two, scorer: scorerAnswer(58) })
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('invalid')
    const same = await gateway({
      'rules-proposer': { ...PROPOSAL, rules: RULES_V1 },
      scorer: scorerAnswer(58),
    })
    expect(
      await maybePropose({ db, gateway: same, notifier }, ACC, new Date('2026-10-26T09:00:00Z')),
    ).toBe('invalid')
    expect(await countEvents(db, 'rules.proposal_invalid')).toBe(2)
    expect(await db.select().from(ruleProposal)).toHaveLength(0)
  })

  it('FR-MIND-3: the backtest compares like with like, the old and the new rules on the same model', async () => {
    // The live decisions were «show» (80), but today's model scores these orders 50 under any rules.
    await threeSurprises()
    const gw = await gateway({ scorer: scorerAnswer(50) })
    const r = await backtest({ db, gateway: gw }, ACC, RULES_V1, { ...RULES_V1, threshold: 57 }, 2)
    expect(r).toEqual({ checked: 4, changed: 0, towardBoris: 0, against: 0 })
  })
})
