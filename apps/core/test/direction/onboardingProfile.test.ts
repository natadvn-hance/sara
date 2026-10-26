import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { directionVersion, event, lead } from '../../src/db/schema'
import {
  confirmFormat,
  confirmSpeed,
  confirmStep,
  finishOnboarding,
  getOnboarding,
  skipStep,
  startOnboarding,
  submitStep,
} from '../../src/direction/onboarding'
import { getProfile, seedProfile } from '../../src/direction/profile'
import { seedDirection } from '../../src/direction/store'
import { RULES_V1 } from '../../src/direction/v1'
import { setSetting } from '../../src/settings/store'
import { calibrate } from '../helpers/calibration'
import { openTestDb, resetDb } from '../helpers/db'
import { fakeGateway } from '../helpers/gateway'
import { leadWithScore } from '../helpers/learning'
import { ABOUT, CASE, CASES_ANSWER, FORMAT_ANSWER, IDEAL, STOPS } from '../helpers/onboarding'

const { db, close } = openTestDb()
afterAll(close)

const ACC = 'hance-marketing'
const ANSWERS = {
  'onboarding-about': ABOUT,
  'onboarding-stops': STOPS,
  'onboarding-ideal': IDEAL,
  'onboarding-format': FORMAT_ANSWER,
  'onboarding-cases': CASES_ANSWER,
}
const NAMES = ['Андрей', 'Мария', 'Олег']
// The samples as they are kept: the voice rules took the period off the end of each paragraph (rule 4).
const SAMPLES = [
  'Понимаю, для вас важно быстро начать запись\n\nКогда хотите открыть запись онлайн?',
  'Похоже, сайт нужен без долгого запуска\n\nЧто для вас главное в первый месяц?',
  'Задача ясна: нужен понятный первый шаг\n\nКакой срок для вас критичен?',
]
beforeEach(async () => {
  await resetDb(db)
  await seedDirection(db, ACC)
  await seedProfile(db, ACC)
  for (const [i, name] of NAMES.entries()) {
    const id = `97200${i}`
    await leadWithScore(db, id, 70)
    await db
      .update(lead)
      .set({
        clientName: name,
        title: `Заказ про сайт ${i}`,
        seenAt: new Date(Date.now() - i * 60_000).toISOString(),
      })
      .where(eq(lead.id, id))
  }
})

async function stepFive() {
  const f = await fakeGateway(db, ANSWERS)
  await startOnboarding(db, ACC, 'edit')
  for (const n of [1, 2, 3] as const) await skipStep(db, ACC, n)
  const r = await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'две части, спокойно' })
  return { f, r }
}
type Sample = { lead_id: string; greeting: string; body: string }
const samplesOf = async () => {
  const data = (await getOnboarding(db, ACC))?.steps['5']?.proposal?.data as
    | { samples: Sample[] }
    | undefined
  return data?.samples ?? []
}

describe('step 5: the format and three sample bids', { timeout: 60000 }, () => {
  it('FR-ACC-3: step 5 gives three sample bids on real leads, with the greeting from the program', async () => {
    const { r } = await stepFive()
    expect(r.ok).toBe(true)
    const samples = await samplesOf()
    expect(samples).toHaveLength(3)
    // The greeting follows the hour in Moscow (rule 5): the name, then the part of the day of this moment.
    for (const [i, name] of NAMES.entries())
      expect(samples.find((s) => s.lead_id === `97200${i}`)?.greeting).toMatch(
        new RegExp(`^${name}, (доброе утро|добрый день|добрый вечер)!$`),
      )
    expect(samples[0]?.body).toBe(SAMPLES[0])
    const proposal = (await getOnboarding(db, ACC))?.steps['5']?.proposal
    expect(proposal?.understood).toBe(FORMAT_ANSWER.understood)
  })

  it('FR-ACC-3: the model gets the orders and never a client name', async () => {
    const { f } = await stepFive()
    const call = (await f.calls()).find((c) => c.role === 'onboarding-format')
    expect(call?.stdin).toContain('Заказ про сайт 0')
    expect(call?.stdin).toContain('Заказ про сайт 2')
    for (const name of NAMES) expect(call?.stdin).not.toContain(name)
  })

  it('FR-ACC-3: the orders are those Boris would take in a calibration, else the latest shown', async () => {
    // Nothing marked: the latest three shown leads (all three here).
    const a = await stepFive()
    expect((await a.f.calls()).find((c) => c.role === 'onboarding-format')?.stdin).toContain(
      'Заказ про сайт 1',
    )
    // Four leads, Boris said «взяли бы» to two other ones in a calibration: those come first.
    await resetDb(db)
    await seedDirection(db, ACC)
    await seedProfile(db, ACC)
    const { ids } = await calibrate(
      db,
      ACC,
      [...Array(10).fill('no'), 'yes', 'yes'] as ('yes' | 'no')[],
      Array(12).fill(70),
    )
    expect(ids).toHaveLength(12)
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })
    const input = (await f.calls()).find((c) => c.role === 'onboarding-format')?.stdin ?? ''
    const marked = await db.execute<{ title: string }>(
      sql`select l.title from core.calibration_item i join core.lead l on l.id = i.lead_id where i.mark = 'yes'`,
    )
    for (const row of marked.rows) expect(input).toContain(row.title)
  })

  it("FR-ACC-3: Boris's edited samples become the examples without the greeting and the client name", async () => {
    await stepFive()
    const samples = await samplesOf()
    const edited = samples.map((s, i) => ({
      lead_id: s.lead_id,
      // He edited the whole text, greeting and all, as he saw it.
      body: `${s.greeting} Правленный образец ${i}. Что для вас главное?`,
    }))
    const r = await confirmFormat(db, ACC, edited)
    expect(r.ok).toBe(true)
    const v = await getOnboarding(db, ACC)
    const confirmed = v?.steps['5']?.confirmed as { reply_format: { examples: string[] } }
    expect(confirmed.reply_format.examples).toEqual([
      'Правленный образец 0. Что для вас главное?',
      'Правленный образец 1. Что для вас главное?',
      'Правленный образец 2. Что для вас главное?',
    ])
    for (const e of confirmed.reply_format.examples)
      for (const n of NAMES) expect(e).not.toContain(n)
  })

  it('FR-ACC-3: a client name inside a sample is refused, so it never reaches the model through the examples', async () => {
    await stepFive()
    const samples = await samplesOf()
    const first = samples[0]
    if (!first) throw new Error('no sample')
    const name = NAMES.find((n) => first.greeting.startsWith(n)) ?? ''
    const r = await confirmFormat(db, ACC, [
      { lead_id: first.lead_id, body: `Понимаю вас, ${name}, и готова помочь.` },
    ])
    expect(r).toEqual({ ok: false, error: 'has_name' })
    expect((await getOnboarding(db, ACC))?.steps['5']?.confirmed).toBeNull()
  })

  it('FR-ACC-3: confirming without edits takes the samples as proposed, and a lead that is not in the step is refused', async () => {
    await stepFive()
    expect((await confirmFormat(db, ACC, [{ lead_id: 'nope', body: 'текст' }])).ok).toBe(false)
    expect((await confirmFormat(db, ACC)).ok).toBe(true)
    const confirmed = (await getOnboarding(db, ACC))?.steps['5']?.confirmed as {
      reply_format: { examples: string[] }
    }
    expect(confirmed.reply_format.examples).toEqual(SAMPLES)
  })

  it('FR-ACC-3: a sample longer than the format allows is asked again, then a miss', async () => {
    const long = { ...FORMAT_ANSWER, samples: ['ж'.repeat(450), 'б', 'в'] }
    const f = await fakeGateway(db, { ...ANSWERS, 'onboarding-format': long })
    await startOnboarding(db, ACC, 'edit')
    const r = await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })
    expect(r).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await f.calls()).filter((c) => c.role === 'onboarding-format')).toHaveLength(2)
  })

  it('FR-ACC-3: without leads there is nothing to write samples on, and the step says so', async () => {
    await resetDb(db)
    await seedDirection(db, ACC)
    await seedProfile(db, ACC)
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    expect(await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })).toMatchObject({
      ok: false,
      reason: 'no_leads',
    })
  })
})

describe('steps 6 and 7: cases, speed and money', { timeout: 60000 }, () => {
  it('FR-ACC-3: step 6 gives the case library with show rules, and a library with a bad link is a miss', async () => {
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    expect(
      await submitStep({ db, gateway: f.gateway }, ACC, 6, {
        say: `один кейс, сайт клиники ${CASE.url}`,
      }),
    ).toMatchObject({ ok: true })
    const proposal = (await getOnboarding(db, ACC))?.steps['6']?.proposal
    expect(proposal?.data).toEqual({ cases: [CASE] })
    expect(await confirmStep(db, ACC, 6)).not.toBeNull()
    const bad = { ...CASES_ANSWER, cases: [{ ...CASE, url: 'http://hance.example/x' }] }
    const g = await fakeGateway(db, { ...ANSWERS, 'onboarding-cases': bad })
    await startOnboarding(db, ACC, 'edit')
    expect(await submitStep({ db, gateway: g.gateway }, ACC, 6, { say: 'кейс' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
  })

  it('FR-ACC-3: step 7 keeps the speed and the view names what contradicts it', async () => {
    await startOnboarding(db, ACC, 'edit')
    const v = await confirmSpeed(db, ACC, 'fast')
    expect(v?.steps['7']?.confirmed).toEqual({ speed: 'fast' })
    expect(v?.contradictions.map((c) => c.id)).toEqual(['fast_without_bids'])
    await setSetting(db, 'outbound.bids', true, 'boris')
    expect((await getOnboarding(db, ACC))?.contradictions).toEqual([])
  })

  it('FR-ACC-3: the view tells in plain words what the profile steps would change', async () => {
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    expect((await getOnboarding(db, ACC))?.profileChanges).toEqual([])
    await submitStep({ db, gateway: f.gateway }, ACC, 6, { say: `кейс ${CASE.url}` })
    await confirmStep(db, ACC, 6)
    await confirmSpeed(db, ACC, 'fast')
    expect((await getOnboarding(db, ACC))?.profileChanges).toEqual([
      'Кейсов в библиотеке: 1',
      'Скорость: быстрая',
    ])
  })
})

describe('finishing with the profile', { timeout: 60000 }, () => {
  async function allSteps(threshold?: number) {
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    await skipStep(db, ACC, 1)
    await skipStep(db, ACC, 2)
    await skipStep(db, ACC, 3)
    await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })
    await confirmFormat(db, ACC)
    await submitStep({ db, gateway: f.gateway }, ACC, 6, { say: `кейс ${CASE.url}` })
    await confirmStep(db, ACC, 6)
    await confirmSpeed(db, ACC, 'fast')
    return f
  }
  const versions = async () => (await db.select().from(directionVersion)).length

  it('FR-ACC-3: a draft that only changes the profile finishes without a calibration or a reason', async () => {
    await allSteps()
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: true, version: null })
    expect(await versions()).toBe(1)
    const p = await getProfile(db, ACC)
    expect(p).toMatchObject({ speed: 'fast', cases: [CASE] })
    expect(p.reply_format?.max_chars).toBe(400)
    expect(p.reply_format?.examples).toEqual(SAMPLES)
  })

  it('FR-ACC-3: finishing saves the profile and the rules version in one transaction', async () => {
    const f = await allSteps()
    // Rules change too: step 3 again, with another threshold; a reason lets it through without a calibration.
    const ideal = await fakeGateway(db, {
      'onboarding-ideal': { ...IDEAL, axes: RULES_V1.axes, threshold: 50, notes: RULES_V1.notes },
    })
    await submitStep({ db, gateway: ideal.gateway }, ACC, 3, { say: 'порог ниже' })
    await confirmStep(db, ACC, 3)
    expect(f).toBeTruthy()
    expect(await finishOnboarding(db, ACC, { override: { reason: 'позже проверю' } })).toEqual({
      ok: true,
      version: 2,
    })
    expect(await versions()).toBe(2)
    expect((await getProfile(db, ACC)).cases).toHaveLength(1)
  })

  it('FR-ACC-3: if the profile cannot be saved the version is not made either, and the draft stays open', async () => {
    const ideal = await fakeGateway(db, {
      'onboarding-ideal': { ...IDEAL, axes: RULES_V1.axes, threshold: 50, notes: RULES_V1.notes },
    })
    await allSteps()
    await submitStep({ db, gateway: ideal.gateway }, ACC, 3, { say: 'порог' })
    await confirmStep(db, ACC, 3)
    await db.execute(
      sql`create or replace function core.boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`,
    )
    await db.execute(
      sql`create trigger boom before insert or update on core.direction_profile for each row execute function core.boom()`,
    )
    try {
      await expect(finishOnboarding(db, ACC, { override: { reason: 'да' } })).rejects.toThrow()
    } finally {
      await db.execute(sql`drop trigger if exists boom on core.direction_profile`)
      await db.execute(sql`drop function if exists core.boom()`)
    }
    expect(await versions()).toBe(1)
    expect(await getOnboarding(db, ACC)).not.toBeNull()
    expect(JSON.stringify(await db.select().from(event))).not.toContain('Правленный')
  })

  it('FR-ACC-3: a profile that changed nothing makes no profile version', async () => {
    await startOnboarding(db, ACC, 'edit')
    for (const n of [1, 2, 3] as const) await skipStep(db, ACC, n)
    await confirmSpeed(db, ACC, 'normal')
    expect(await finishOnboarding(db, ACC, {})).toEqual({ ok: true, version: null })
    expect((await getProfile(db, ACC)).version).toBe(0)
  })
})

describe('the review of step 5: names, contacts and links never get through', {
  timeout: 60000,
}, () => {
  const setLead = (id: string, set: Partial<typeof lead.$inferInsert>) =>
    db.update(lead).set(set).where(eq(lead.id, id))
  const idOf = (i: number) => `97200${i}`
  /** Step 5 over leads where lead `i` is named `name`; the first sample belongs to the first lead in the step. */
  async function confirmWith(name: string, info: unknown, body: string) {
    await setLead(idOf(0), { clientName: name, clientInfo: info })
    await stepFive()
    const first = (await samplesOf()).find((x) => x.lead_id === idOf(0))
    if (!first) throw new Error('lead 0 is not in the step')
    return confirmFormat(db, ACC, [{ lead_id: first.lead_id, body }])
  }

  it('FR-ACC-3: a name in another case ending is refused like the gateway would hide it', async () => {
    expect(await confirmWith('Мария', null, 'Для Марии это важно, понимаю.')).toEqual({
      ok: false,
      error: 'has_name',
    })
  })

  it('FR-ACC-3: a hyphenated name is refused by its parts and never breaks the step', async () => {
    expect(await confirmWith('Анна-Мария', null, 'Понимаю вас, Анна.')).toEqual({
      ok: false,
      error: 'has_name',
    })
  })

  it('FR-ACC-3: the name from the order page counts too', async () => {
    expect(await confirmWith('Клиент', { name: 'Ксения' }, 'Ксения, понимаю вас.')).toEqual({
      ok: false,
      error: 'has_name',
    })
  })

  it('FR-ACC-3: a phone, a link or a tag in a sample is refused, so client contacts stay out of the examples', async () => {
    for (const body of [
      'Позвоните мне, +7 916 123-45-67.',
      'Смотрите https://client.example/page',
      'Как в [ссылка 1], понимаю.',
    ])
      expect(await confirmWith('Олег', null, body)).toEqual({ ok: false, error: 'has_contact' })
  })

  it('FR-ACC-3: an order text that names the client reaches the model with the name hidden', async () => {
    await db
      .update(lead)
      .set({ clientName: 'Ольга', text: 'Здравствуйте, меня зовут Ольга, нужен лендинг' })
      .where(eq(lead.id, idOf(0)))
    const { f } = await stepFive()
    const call = (await f.calls()).find((c) => c.role === 'onboarding-format')
    expect(call?.stdin).toContain('нужен лендинг')
    expect(call?.stdin).not.toContain('Ольга')
  })

  it('FR-ACC-3: a sample with a tag the model left in is asked again and then a miss', async () => {
    const tagged = { ...FORMAT_ANSWER, samples: ['Как в [ссылка 1], понимаю.', 'б', 'в'] }
    const f = await fakeGateway(db, { ...ANSWERS, 'onboarding-format': tagged })
    await startOnboarding(db, ACC, 'edit')
    expect(await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
  })

  it('FR-ACC-3: a sample is held to the format together with its greeting', async () => {
    const near = { ...FORMAT_ANSWER, samples: ['ж'.repeat(390), 'б', 'в'] }
    const f = await fakeGateway(db, { ...ANSWERS, 'onboarding-format': near })
    await startOnboarding(db, ACC, 'edit')
    expect(await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    await stepFive()
    const first = (await samplesOf())[0]
    const r = await confirmFormat(db, ACC, [
      { lead_id: first?.lead_id ?? '', body: 'ж'.repeat(385) },
    ])
    expect(r).toEqual({ ok: false, error: 'too_long' })
  })

  it('FR-ACC-3: a sample is held to the format with the longest greeting of the day, whatever the hour it was made at', async () => {
    await stepFive()
    const first = (await samplesOf())[0]
    // «Андрей, добрый вечер!» is the longest of the three: 21 and 2 for the empty line.
    const fits = 400 - 'Андрей, добрый вечер!'.length - 2
    expect(first?.greeting.startsWith('Андрей, ')).toBe(true)
    const over = await confirmFormat(db, ACC, [
      { lead_id: first?.lead_id ?? '', body: 'ж'.repeat(fits + 1) },
    ])
    expect(over).toEqual({ ok: false, error: 'too_long' })
    const exact = await confirmFormat(db, ACC, [
      { lead_id: first?.lead_id ?? '', body: 'ж'.repeat(fits) },
    ])
    expect(exact.ok).toBe(true)
  })

  it('NFR-UX-1: a sample of the direction has no dash, no hyphen in a common word, no final period and no emoji', async () => {
    const dash = String.fromCharCode(0x2014)
    const f = await fakeGateway(db, {
      ...ANSWERS,
      'onboarding-format': {
        ...FORMAT_ANSWER,
        samples: [`Понимаю ${dash} что-то важное 🤝.\n\nКогда запуск?`, 'б', 'в'],
      },
    })
    await startOnboarding(db, ACC, 'edit')
    for (const n of [1, 2, 3] as const) await skipStep(db, ACC, n)
    await submitStep({ db, gateway: f.gateway }, ACC, 5, { say: 'формат' })
    expect((await samplesOf())[0]?.body).toBe('Понимаю что то важное\n\nКогда запуск?')
  })

  it('FR-ACC-3: what Boris edited stays in the step when he comes back to it', async () => {
    await stepFive()
    const first = (await samplesOf())[0]
    await confirmFormat(db, ACC, [
      { lead_id: first?.lead_id ?? '', body: 'Моя правка. Что главное?' },
    ])
    expect((await samplesOf())[0]?.body).toBe('Моя правка. Что главное?')
  })

  it('FR-ACC-3: step 6 only takes links Boris gave, and says so when one was invented', async () => {
    const f = await fakeGateway(db, ANSWERS)
    await startOnboarding(db, ACC, 'edit')
    expect(
      await submitStep({ db, gateway: f.gateway }, ACC, 6, { say: 'кейс про клинику без ссылки' }),
    ).toMatchObject({ ok: false, reason: 'invalid' })
    expect(
      await submitStep({ db, gateway: f.gateway }, ACC, 6, {
        say: `кейс про клинику ${CASE.url}`,
      }),
    ).toMatchObject({ ok: true })
  })

  it('FR-ACC-3: the sample orders left out are those sorted out or stale', async () => {
    await db
      .update(lead)
      .set({ status: 'sorted_out' })
      .where(eq(lead.id, idOf(0)))
    await db
      .update(lead)
      .set({ status: 'stale' })
      .where(eq(lead.id, idOf(1)))
    const { f } = await stepFive()
    const stdin = (await f.calls()).find((c) => c.role === 'onboarding-format')?.stdin ?? ''
    expect(stdin).toContain('Заказ про сайт 2')
    expect(stdin).not.toContain('Заказ про сайт 0')
    expect(stdin).not.toContain('Заказ про сайт 1')
  })
})
