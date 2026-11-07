import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { directionVersion, question, ruleProposal, task } from '../../src/db/schema'
import { activeRules, rollbackTo, seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { createGateway, type Gateway, withoutLimitWait } from '../../src/gateway/gateway'
import { backtest } from '../../src/learning/backtest'
import { recordLabel, setReason } from '../../src/learning/labels'
import { maybePropose, onProposalPress, PROPOSAL_WAIT_MS } from '../../src/learning/proposals'
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
  closeLeadCard: async () => {},
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
async function gateway(
  byRole: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Gateway> {
  const secrets = createSecretStore(join(dir, 'data'))
  await secrets.set('claude_oauth_token', 'tok')
  // As the core wires the learning jobs: through a Claude limit they do not wait (app.ts).
  return withoutLimitWait(
    createGateway({
      db,
      secrets,
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      rolesDir: join(dir, 'roles'),
      dataDir: join(dir, 'data'),
      extraEnv: {
        FAKE_CLAUDE_OUTPUT_BY_ROLE: JSON.stringify(byRole),
        FAKE_CLAUDE_ARGS_LOG: join(dir, 'claude.log'),
        ...env,
      },
    }),
  )
}
const PROPOSAL = {
  summary: 'Порог выше: 60 вместо 56',
  why: 'Ты пропускал заявки с высоким баллом: «копейки, не наш клиент»',
  rules: { ...RULES_V1, threshold: 60 },
}
const NOW = new Date('2026-10-25T09:00:00Z')
// The press asks «почему не надо?» on the day after the surprises: the day allows three questions, and at the real
// clock (which was this very day once) the three would already be spent.
const NEXT_DAY = () => new Date(NOW.getTime() + 24 * 3600_000)

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
/** What the proposer got as input in its latest call. */
async function proposerInput(): Promise<string> {
  const calls = (await readFile(join(dir, 'claude.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    .filter((c) => c.args.some((a) => a.endsWith('rules-proposer/role.md')))
  return calls.at(-1)?.stdin ?? ''
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

// Each case runs the fake Claude a dozen times (proposer and backtest): slow on a busy machine.
describe('rule proposals', { timeout: 30000 }, () => {
  it('FR-MIND-3: three answered surprises bring one proposal with its backtest numbers', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('asked')
    const msg = sent.at(-1)
    expect(msg?.text.split('\n')).toEqual([
      'Предлагаю поправку правил (v1 → v2): Порог выше: 60 вместо 56',
      'Почему: Ты пропускал заявки с высоким баллом: «копейки, не наш клиент»',
      'Что меняется: Порог: 56 → 60',
      'На последних 4 заявках это изменило бы 4 решения: 3 в твою сторону, 1 против.',
    ])
    expect(msg?.rows.flat().map((b) => b.text)).toEqual(['Применить', 'Не надо'])
    expect(await countEvents(db, 'rules.proposed')).toBe(1)
  })

  it("NFR-PRIV-2: a client's name inside an order text never reaches the proposer", async () => {
    await threeSurprises()
    await db.execute(
      sql`update core.lead set text = 'Меня зовут Андрей, нужны федеральные каналы' where id = '940001'`,
    )
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    const input = await proposerInput()
    expect(input).toContain('Меня зовут [имя 1], нужны федеральные каналы')
    expect(input).not.toContain('Андрей')
  })

  it("NFR-PRIV-2: a proposal that carries a client's tag is invalid, so no name is written into the rules", async () => {
    await threeSurprises()
    await db.execute(
      sql`update core.lead set text = 'Меня зовут Андрей, нужны федеральные каналы' where id = '940001'`,
    )
    const leaking = {
      ...PROPOSAL,
      rules: {
        ...RULES_V1,
        stop_factors: RULES_V1.stop_factors.map((s, i) =>
          i === 0 ? { ...s, examples: [...s.examples, 'Меня зовут [имя 1]'] } : s,
        ),
      },
    }
    const gw = await gateway({ 'rules-proposer': leaking, scorer: scorerAnswer(58) })
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('invalid')
    expect(await countEvents(db, 'rules.proposal_invalid')).toBe(1)
    expect(await db.select().from(ruleProposal)).toHaveLength(0)
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
    expect(
      await onProposalPress({ db, notifier, now: NEXT_DAY }, await proposalTask(), 'drop'),
    ).toBe('Хорошо, оставляю v1')
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

  it('FR-MIND-3: an answer that breaks the answer schema is journaled as an invalid proposal', async () => {
    await threeSurprises()
    const gw = await gateway({
      'rules-proposer': { summary: 'Порог выше', why: 'так' },
      scorer: scorerAnswer(58),
    })
    const before = sent.length
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('invalid')
    expect(sent.length).toBe(before)
    expect(await countEvents(db, 'rules.proposal_invalid')).toBe(1)
    expect(await db.select().from(ruleProposal)).toHaveLength(0)
  })

  it('FR-MIND-3: a proposer that did not answer at all is not an invalid proposal', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL }, { FAKE_CLAUDE_MODE: 'limit' })
    expect(await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)).toBe('not_yet')
    expect(await countEvents(db, 'rules.proposal_invalid')).toBe(0)
  })

  it('FR-MIND-3: the proposer is told what Boris declined and why', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    expect(await proposerInput()).not.toContain('Борис уже отказался')
    await onProposalPress({ db, notifier, now: NEXT_DAY }, await proposalTask(), 'drop')
    const [why] = await db.select().from(question).where(eq(question.kind, 'why_decline'))
    await answerQuestion(db, {
      text: 'маленький бюджет у нас тоже берут',
      replyToMessageId: why?.telegramMessageId ?? -1,
      voice: false,
      at: new Date(NEXT_DAY().getTime() + 1000),
    })
    expect(
      await maybePropose({ db, gateway: gw, notifier }, ACC, new Date('2026-10-26T09:00:00Z')),
    ).toBe('asked')
    expect(await proposerInput()).toContain(
      [
        'Поправки, от которых Борис уже отказался:',
        '- Порог выше: 60 вместо 56. Его причина: маленький бюджет у нас тоже берут',
      ].join('\n'),
    )
  })

  it('FR-MIND-3: a proposal that went stale is not a refusal', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    await rollbackTo(db, ACC, 1)
    await onProposalPress({ db, notifier }, await proposalTask(), 'apply')
    expect((await db.select().from(ruleProposal))[0]?.state).toBe('stale')
    await maybePropose({ db, gateway: gw, notifier }, ACC, new Date('2026-10-26T09:00:00Z'))
    expect(await proposerInput()).toContain('Случаи, где решение Бориса')
    expect(await proposerInput()).not.toContain('Борис уже отказался')
  })

  it('FR-MIND-3: a proposal made for v1 is not applied after the rules changed', async () => {
    await threeSurprises()
    const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
    await maybePropose({ db, gateway: gw, notifier }, ACC, NOW)
    await rollbackTo(db, ACC, 1)
    expect(await onProposalPress({ db, notifier }, await proposalTask(), 'apply')).toBe(
      'Правила уже поменялись, предложение устарело. Пришлю новое, если повод останется',
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

  describe('a reason Boris keeps closing cards with (07.11.2026)', () => {
    /** `n` closes from the card, each with Sara's guess «не наш профиль: Реклама на ТВ» (the helper's order). */
    async function closes(n: number, from: number) {
      for (let i = 0; i < n; i++) {
        const id = String(from + i)
        await leadWithScore(db, id, 70)
        await recordLabel(db, { leadId: id, label: 'no', source: 'card' })
      }
    }
    const DAY = 24 * 3600_000

    it('five closes with one reason bring a proposal that names it, with the orders he bid on', async () => {
      await closes(5, 960001)
      await setReason(db, '960001', 'profile', new Date())
      await leadWithScore(db, '960009', 70)
      await recordLabel(db, { leadId: '960009', label: 'yes', source: 'card' })
      const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, new Date())).toBe('asked')
      expect(sent.at(-1)?.text.split('\n').slice(0, 3)).toEqual([
        'Предлагаю поправку правил (v1 → v2): Порог выше: 60 вместо 56',
        'Повод: 5 раз закрыл с причиной «не наш профиль: Реклама на ТВ», из них 1 ты выбрал сам',
        'Почему: Ты пропускал заявки с высоким баллом: «копейки, не наш клиент»',
      ])
      const input = await proposerInput()
      expect(input).toContain('Повторяющаяся причина: «не наш профиль: Реклама на ТВ».')
      expect(input).toContain(
        'За 14 дней Борис закрыл 5 таких карточек: причину выбрал сам в 1, в остальных не поправил догадку Сары.',
      )
      expect(input).toContain('Причина: не наш профиль: Реклама на ТВ (выбрал сам)')
      expect(input).toContain(
        'Причина: не наш профиль: Реклама на ТВ (угадала Сара, он не поправил)',
      )
      expect(input).toContain(
        'Заказы, на которые Борис откликнулся (поправка не должна их отсеять):\n- «Реклама на ТВ» (Реклама на ТВ)',
      )
      expect(input).not.toContain('Андрей')
      expect((await db.select().from(ruleProposal))[0]).toMatchObject({
        reasonCode: 'profile',
        reasonDetail: 'Реклама на ТВ',
      })
      // Its message is kept, so it can lose its buttons when it goes stale.
      const [t] = await db.select().from(task).where(eq(task.kind, 'rule_proposal'))
      expect(t?.telegramMessageId).toBe(nextId - 1)
    })

    it('four closes are not enough, and «другое» is no reason to make a rule of', async () => {
      await closes(4, 960011)
      const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, new Date())).toBe('not_yet')
      for (let i = 0; i < 5; i++) {
        const id = String(960021 + i)
        await leadWithScore(db, id, 70)
        await recordLabel(db, { leadId: id, label: 'no', source: 'pult', reason: 'уже работаем' })
      }
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, new Date())).toBe('not_yet')
      expect(await db.select().from(ruleProposal)).toHaveLength(0)
    })

    it('after «Не надо» the same reason needs five new closes', async () => {
      await closes(5, 960031)
      const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
      const day = new Date()
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, day)).toBe('asked')
      await onProposalPress(
        { db, notifier, now: () => new Date(day.getTime() + DAY) },
        await proposalTask(),
        'drop',
      )
      const next = new Date(day.getTime() + DAY)
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, next)).toBe('not_yet')
      await closes(5, 960041)
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, next)).toBe('asked')
    })
  })

  describe('an old proposal holds back no new one (07.11.2026)', () => {
    it('one made for older rules is closed as stale, its buttons say «Устарело», and the same surprises bring a new one', async () => {
      const marked: { id: number; note: string }[] = []
      const withMark: Notifier = {
        ...notifier,
        markDone: async (id, note) => {
          marked.push({ id, note })
        },
      }
      await threeSurprises()
      const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
      await maybePropose({ db, gateway: gw, notifier: withMark }, ACC, NOW)
      const old = await proposalTask()
      const oldMessage = nextId - 1
      await rollbackTo(db, ACC, 1)
      expect(await maybePropose({ db, gateway: gw, notifier: withMark }, ACC, NEXT_DAY())).toBe(
        'asked',
      )
      const rows = await db.select().from(ruleProposal).orderBy(ruleProposal.createdAt)
      expect(rows.map((p) => [p.fromVersion, p.state])).toEqual([
        [1, 'stale'],
        [2, 'asked'],
      ])
      expect(marked).toEqual([{ id: oldMessage, note: 'Устарело' }])
      const [t] = await db.select().from(task).where(eq(task.id, old))
      expect(t).toMatchObject({ state: 'resolved', resolution: 'stale' })
      expect(await countEvents(db, 'rules.expired')).toBe(1)
      // A late press on the old one says what happened, and changes nothing.
      expect(await onProposalPress({ db, notifier }, old, 'apply')).toBe(
        'Правила уже поменялись, предложение устарело. Пришлю новое, если повод останется',
      )
      expect((await activeRules(db, ACC)).version).toBe(2)
    })

    it('one without an answer for three days is closed and waits no more', async () => {
      await threeSurprises()
      const gw = await gateway({ 'rules-proposer': PROPOSAL, scorer: scorerAnswer(58) })
      // Made after his answers, as it always is outside a test.
      const at = new Date(NOW.getTime() + 600_000)
      await maybePropose({ db, gateway: gw, notifier }, ACC, at)
      const later = (ms: number) => new Date(at.getTime() + ms)
      expect(await maybePropose({ db, gateway: gw, notifier }, ACC, later(2 * 86_400_000))).toBe(
        'not_yet',
      )
      expect((await db.select().from(ruleProposal))[0]?.state).toBe('asked')
      // Closed, but its surprises were already put to Boris once: they do not come back on their own.
      expect(
        await maybePropose({ db, gateway: gw, notifier }, ACC, later(PROPOSAL_WAIT_MS + 60_000)),
      ).toBe('not_yet')
      expect((await db.select().from(ruleProposal))[0]?.state).toBe('expired')
      expect((await db.select().from(task).where(eq(task.kind, 'rule_proposal')))[0]).toMatchObject(
        {
          state: 'resolved',
          resolution: 'expired',
        },
      )
      const [e] = await db
        .execute<{ payload: { why: string } }>(
          sql`select payload from core.event where type = 'rules.expired'`,
        )
        .then((r) => r.rows)
      expect(e?.payload.why).toBe('unanswered')
    })
  })
})
