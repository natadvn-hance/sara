import {
  DirectionProfileData,
  OnbCases,
  OnbFormat,
  type OnboardingDraft,
  ReplyFormat,
} from '@sara/shared'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../db/client'
import { calibrationItem, directionRun, lead } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import { namesToHide } from '../leads/clientName'
import { bodyOf, greetingOf } from '../leads/draft'
import { sorterInput } from '../leads/sorter'
import type { Profile, ProfilePatch } from './profile'
import { orderOfLead } from './trial'

type LeadRow = typeof lead.$inferSelect

/** How many real orders the sample bids are written on (FR-ACC-3, step 5). */
const SAMPLE_ORDERS = 3
const DASHES = /[\u2013\u2014]/g

// ---------------------------------------------------------------------------------------------------------------
// What steps 5, 6 and 7 confirm, and what the profile becomes from it.

export const FormatData = z.object({
  reply_format: ReplyFormat,
  samples: z.array(z.object({ lead_id: z.string(), greeting: z.string(), body: z.string() })),
})
export type FormatData = z.infer<typeof FormatData>
/** What Boris confirmed in step 5: the format with his approved samples as the examples. */
export const FormatConfirmed = z.object({ reply_format: ReplyFormat })
export type FormatConfirmed = z.infer<typeof FormatConfirmed>
const CasesData = z.object({ cases: DirectionProfileData.shape.cases })
const SpeedData = z.object({ speed: z.enum(['normal', 'fast']) })

const confirmed = <T>(schema: z.ZodType<T>, st: { confirmed?: unknown } | undefined): T | null => {
  const r = schema.safeParse(st?.confirmed)
  return r.success ? r.data : null
}

const SPEED_NAMES = { normal: 'обычная', fast: 'быстрая' } as const

/**
 * The profile the confirmed steps 5-7 make from `base`, what differs from it (only that is saved), and the
 * differences in plain words for the screen. A step Boris did not confirm leaves its part as it was.
 */
export function assembleProfile(
  base: Pick<Profile, 'speed' | 'reply_format' | 'cases'>,
  draft: OnboardingDraft,
): {
  profile: Pick<Profile, 'speed' | 'reply_format' | 'cases'>
  patch: ProfilePatch
  lines: string[]
} {
  const format = confirmed(FormatConfirmed, draft.steps['5'])
  const cases = confirmed(CasesData, draft.steps['6'])
  const speed = confirmed(SpeedData, draft.steps['7'])
  const profile = {
    speed: speed?.speed ?? base.speed,
    reply_format: format?.reply_format ?? base.reply_format,
    cases: cases?.cases ?? base.cases,
  }
  const patch: ProfilePatch = {}
  const lines: string[] = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (!same(profile.reply_format, base.reply_format)) {
    patch.reply_format = profile.reply_format
    lines.push('Формат отклика изменён')
  }
  if (!same(profile.cases, base.cases)) {
    patch.cases = profile.cases
    lines.push(`Кейсов в библиотеке: ${profile.cases.length}`)
  }
  if (profile.speed !== base.speed) {
    patch.speed = profile.speed
    lines.push(`Скорость: ${SPEED_NAMES[profile.speed]}`)
  }
  return { profile, patch, lines }
}

// ---------------------------------------------------------------------------------------------------------------
// Step 5: sample bids.

/**
 * The real orders the sample bids are written on: the ones Boris said «взяли бы» to in a calibration first, then the
 * latest ones Sara showed him, then the latest of any kind.
 */
export async function pickSampleLeads(db: Db, accountId: string): Promise<LeadRow[]> {
  const out: LeadRow[] = []
  const take = (rows: LeadRow[]) => {
    for (const r of rows)
      if (out.length < SAMPLE_ORDERS && !out.some((o) => o.id === r.id)) out.push(r)
  }
  const wanted = await db
    .select({ id: calibrationItem.leadId })
    .from(calibrationItem)
    .innerJoin(directionRun, eq(directionRun.id, calibrationItem.runId))
    .where(sql`${calibrationItem.mark} = 'yes' and ${directionRun.accountId} = ${accountId}`)
    .orderBy(desc(calibrationItem.markedAt))
    .limit(SAMPLE_ORDERS)
  if (wanted.length > 0)
    take(
      await db
        .select()
        .from(lead)
        .where(
          inArray(
            lead.id,
            wanted.map((w) => w.id),
          ),
        ),
    )
  if (out.length < SAMPLE_ORDERS) {
    const shown = await db.execute<{ id: string }>(sql`
      select l.id from core.lead l
      where l.account_id = ${accountId} and l.status <> 'stale'
        and (select s.decision from core.lead_score s where s.lead_id = l.id and not s.backtest
             order by s.created_at desc limit 1) = 'show'
      order by l.seen_at desc limit ${SAMPLE_ORDERS}`)
    if (shown.rows.length > 0)
      take(
        await db
          .select()
          .from(lead)
          .where(
            inArray(
              lead.id,
              shown.rows.map((r) => r.id),
            ),
          )
          .orderBy(desc(lead.seenAt)),
      )
  }
  if (out.length < SAMPLE_ORDERS)
    take(
      await db
        .select()
        .from(lead)
        .where(sql`${lead.accountId} = ${accountId} and ${lead.status} <> 'stale'`)
        .orderBy(desc(lead.seenAt))
        .limit(SAMPLE_ORDERS),
    )
  return out
}

/** The orders by id, in the order of the ids (a correction of step 5 is made on the same orders). */
export async function leadsByIds(db: Db, ids: string[]): Promise<LeadRow[]> {
  if (ids.length === 0) return []
  const rows = await db.select().from(lead).where(inArray(lead.id, ids))
  return ids.flatMap((id) => rows.filter((r) => r.id === id))
}

export type StepProposalResult<T> =
  | { ok: true; understood: string; data: T }
  | { ok: false; reason: 'no_answer' | 'invalid' | 'limit' }

async function ask<T extends { understood: string }>(
  gw: Gateway,
  role: 'onboarding-format' | 'onboarding-cases',
  schema: z.ZodType<T>,
  base: string,
  check: (out: T) => string | null,
): Promise<StepProposalResult<Omit<T, 'understood'>>> {
  let text = base
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await gw.call(role, text, schema, { limitWaitMs: 0 })
    let wrong: string
    if (!r.ok) {
      if (r.errorClass === 'limit_reached') return { ok: false, reason: 'limit' }
      if (r.errorClass !== 'bad_output') return { ok: false, reason: 'no_answer' }
      wrong = `Ответ не подошёл к схеме: ${r.message.replace(/\s+/g, ' ').slice(0, 300)}`
    } else {
      const bad = check(r.output)
      if (!bad) {
        const { understood, ...data } = r.output
        return { ok: true, understood, data }
      }
      wrong = bad
    }
    text = `${base}\n\nПрошлый ответ не подошёл: ${wrong}\nОтветь ещё раз по схеме.`
  }
  return { ok: false, reason: 'invalid' }
}

const words = (i: { say: string; fix?: string; previous?: { understood: string } }) =>
  [
    '',
    'Слова Бориса:',
    i.say,
    ...(i.previous ? ['', `Прошлая попытка Сары: «Я поняла так: ${i.previous.understood}»`] : []),
    ...(i.fix ? ['', `Поправка Бориса: ${i.fix}`] : []),
  ].join('\n')

/**
 * Claude's format and three sample bids on the given real orders. The orders go to the model the way the Scorer
 * reads them, without the client's name; the greeting of each sample is the code's, from the name on the lead.
 */
export async function proposeFormat(
  gw: Gateway,
  leads: LeadRow[],
  i: {
    say: string
    fix?: string
    previous?: { understood: string }
    current: ReplyFormat | null
  },
): Promise<StepProposalResult<FormatData>> {
  const orders = leads.flatMap((l, n) => ['', `Заказ ${n + 1}`, sorterInput(orderOfLead(l))])
  const base = [
    'Шаг 5: формат отклика',
    ...(i.current ? ['', 'Действующий формат:', JSON.stringify(i.current)] : []),
    ...orders,
    words(i),
  ].join('\n')
  const r = await ask(gw, 'onboarding-format', OnbFormat, base, (o) => {
    if (o.samples.length !== leads.length)
      return `Образцов должно быть ровно ${leads.length}, по одному на каждый заказ.`
    const long = o.samples.find((s) => s.length > o.reply_format.max_chars)
    return long ? `Образец длиннее потолка max_chars ${o.reply_format.max_chars}.` : null
  })
  if (!r.ok) return r
  const samples = r.data.samples.map((body, n) => {
    const l = leads[n]
    return {
      lead_id: l?.id ?? '',
      greeting: greetingOf(l?.clientName ?? ''),
      body: bodyOf(body.replace(DASHES, '-')),
    }
  })
  return {
    ok: true,
    understood: r.understood,
    data: { reply_format: r.data.reply_format, samples },
  }
}

/**
 * A sample as Boris wrote it, ready to be an example of the format: no greeting, no dashes, and none of the client
 * names it was written for (a name may stand in a case ending, up to three letters more).
 */
export function cleanExample(
  text: string,
  names: string[],
): { ok: true; text: string } | { ok: false; error: 'empty' | 'has_name' } {
  const body = bodyOf(text.trim().replace(DASHES, '-'))
  if (!body) return { ok: false, error: 'empty' }
  for (const name of names)
    if (
      new RegExp(
        `(?<!\\p{L})${name.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&')}\\p{L}{0,3}(?!\\p{L})`,
        'iu',
      ).test(body)
    )
      return { ok: false, error: 'has_name' }
  return { ok: true, text: body }
}

// ---------------------------------------------------------------------------------------------------------------
// Step 6: cases.

export async function proposeCases(
  gw: Gateway,
  i: {
    say: string
    fix?: string
    previous?: { understood: string }
    current: DirectionProfileData['cases']
  },
): Promise<StepProposalResult<{ cases: DirectionProfileData['cases'] }>> {
  const base = [
    'Шаг 6: кейсы и ссылки',
    ...(i.current.length > 0 ? ['', 'Действующие кейсы:', JSON.stringify(i.current)] : []),
    words(i),
  ].join('\n')
  return ask(gw, 'onboarding-cases', OnbCases, base, () => null)
}
