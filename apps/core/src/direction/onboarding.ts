import {
  DirectionRules,
  newEventId,
  OnbAbout,
  OnbIdeal,
  OnboardingDraft,
  type OnboardingStep,
  OnbStops,
  type StepState,
} from '@sara/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { ZodType } from 'zod'
import type { Db, DbOrTx, Tx } from '../db/client'
import { directionOnboarding, directionOverride } from '../db/schema'
import type { Gateway } from '../gateway/gateway'
import type { RoleName } from '../gateway/roles'
import { appendEvent } from '../journal/journal'
import { rulesText } from '../leads/scorer'
import { rulesDiff } from './diff'
import { activeRules, insertVersion } from './store'

export type AboutData = Omit<OnbAbout, 'understood'>
export type StopsData = Omit<OnbStops, 'understood'>
export type IdealData = Omit<OnbIdeal, 'understood'>
export type StepData = AboutData | StopsData | IdealData

/** What earlier steps already fixed, so a later step does not contradict them (ids and the description only). */
export type Confirmed = {
  about?: string
  stopFactors?: { id: string; text: string }[]
  redFlags?: { id: string; text: string }[]
}

export type StepInput = {
  /** Boris's words for this step. */
  say: string
  /** His correction after «Нет, поправить», with the attempt it is about. */
  fix?: string
  previous?: { understood: string }
  confirmed: Confirmed
  /** The active rules when Boris edits a direction instead of starting one. */
  current: DirectionRules | null
}

export type StepProposal =
  | { ok: true; understood: string; data: StepData }
  | { ok: false; reason: 'no_answer' | 'invalid' | 'limit' }

type StepSpec = {
  role: RoleName
  title: string
  schema: ZodType<{ understood: string }>
  /** What the code checks beyond the schema; a message is sent back to the model, null is fine. */
  check(data: never): string | null
}

const WEIGHTS = 'Веса осей должны давать в сумме ровно 100, а id осей быть разными.'
const IDS = 'Id стоп-факторов и красных флагов должны быть разными.'

/** The rules need an axis, so a step that has none borrows a placeholder to be checked as the rules would be. */
const PLACEHOLDER_AXES = [{ id: 'a', title: 'a', weight: 100, how: 'a' }]

const STEPS: Record<1 | 2 | 3, StepSpec> = {
  1: {
    role: 'onboarding-about',
    title: 'чем занимается аккаунт',
    schema: OnbAbout,
    check: () => null,
  },
  2: {
    role: 'onboarding-stops',
    title: 'чего не берём',
    schema: OnbStops,
    check: (d: StopsData) => {
      const ok = DirectionRules.safeParse({
        about: 'a',
        stop_factors: d.stop_factors,
        red_flags: d.red_flags,
        axes: PLACEHOLDER_AXES,
        threshold: 50,
        notes: [],
      }).success
      const flags = new Set(d.red_flags.map((f) => f.id))
      return ok && flags.size === d.red_flags.length ? null : IDS
    },
  },
  3: {
    role: 'onboarding-ideal',
    title: 'идеальная заявка',
    schema: OnbIdeal,
    check: (d: IdealData) =>
      DirectionRules.safeParse({
        about: 'a',
        stop_factors: [],
        red_flags: [],
        axes: d.axes,
        threshold: d.threshold,
        notes: d.notes,
      }).success
        ? null
        : WEIGHTS,
  },
}

const brief = (x: { id: string; text: string }) =>
  `${x.id}: ${x.text.length > 120 ? `${x.text.slice(0, 117)}...` : x.text}`

function inputText(step: 1 | 2 | 3, i: StepInput): string {
  const lines = [`Шаг ${step}: ${STEPS[step].title}`]
  if (i.current)
    lines.push('', 'Действующие правила направления (Борис правит их):', rulesText(i.current))
  const c = i.confirmed
  const known = [
    c.about ? `Описание направления: ${c.about}` : null,
    c.stopFactors?.length ? `Стоп-факторы: ${c.stopFactors.map(brief).join('; ')}` : null,
    c.redFlags?.length ? `Красные флаги: ${c.redFlags.map(brief).join('; ')}` : null,
  ].filter((x): x is string => x !== null)
  if (known.length > 0) lines.push('', 'Подтверждено на прошлых шагах:', ...known)
  lines.push('', 'Слова Бориса:', i.say)
  if (i.previous) lines.push('', `Прошлая попытка Сары: «Я поняла так: ${i.previous.understood}»`)
  if (i.fix) lines.push('', `Поправка Бориса: ${i.fix}`)
  return lines.join('\n')
}

/**
 * Claude's reading of what Boris said for one step (FR-ACC-3). The answer is checked by the schema and by the
 * rules' own checks; one that fails is asked for once more, naming what was wrong, and a second failure is a miss
 * that touches nothing. The gateway never waits out a Claude limit here: Boris is looking at the screen.
 */
export async function proposeStep(
  d: { gateway: Gateway },
  step: Extract<OnboardingStep, 1 | 2 | 3>,
  input: StepInput,
): Promise<StepProposal> {
  const spec = STEPS[step]
  const base = inputText(step, input)
  let text = base
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await d.gateway.call(spec.role, text, spec.schema, { limitWaitMs: 0 })
    let wrong: string
    if (!r.ok) {
      if (r.errorClass === 'limit_reached') return { ok: false, reason: 'limit' }
      if (r.errorClass !== 'bad_output') return { ok: false, reason: 'no_answer' }
      wrong = `Ответ не подошёл к схеме: ${r.message.replace(/\s+/g, ' ').slice(0, 300)}`
    } else {
      const { understood, ...data } = r.output
      const bad = spec.check(data as never)
      if (!bad) return { ok: true, understood, data: data as StepData }
      wrong = bad
    }
    text = `${base}\n\nПрошлый ответ не подошёл: ${wrong}\nОтветь ещё раз по схеме.`
  }
  return { ok: false, reason: 'invalid' }
}

// ---------------------------------------------------------------------------------------------------------------
// The draft: one open onboarding per account, saved on every step (FR-ACC-3).

export type OnboardingMode = 'new' | 'edit'
const STEP_KEYS = ['1', '2', '3'] as const
const isStep = (n: number): n is 1 | 2 | 3 => n === 1 || n === 2 || n === 3

export type OnboardingView = {
  mode: OnboardingMode
  basedOn: number | null
  /** The step to work on now: the first of 1-3 neither confirmed nor skipped; 4 when they are all done. */
  step: number
  steps: Record<string, StepState>
  /** The rules as the confirmed steps would make them; null while a new direction lacks a section. */
  rules: DirectionRules | null
  /** What those rules change against the active ones, in plain Russian (rulesDiff). */
  changes: string[]
  /** Whether they change anything: a list in another order is no change. The same check finishing uses. */
  changed: boolean
  /** The stored draft no longer reads (the contract moved on): it can only be cancelled. */
  broken?: boolean
}

const emptyStep = (): StepState => ({
  say: '',
  attempts: [],
  proposal: null,
  confirmed: null,
  skipped: false,
})

const AboutSchema = OnbAbout.omit({ understood: true })
const StopsSchema = OnbStops.omit({ understood: true })
const IdealSchema = OnbIdeal.omit({ understood: true })

function confirmedOf<T>(schema: ZodType<T>, st: StepState | undefined): T | null {
  if (!st || st.confirmed == null) return null
  const r = schema.safeParse(st.confirmed)
  return r.success ? r.data : null
}

/**
 * The rules the confirmed steps make. In edit mode a section Boris did not confirm stays as `base` has it; a new
 * direction (no base) needs all of steps 1-3, else null.
 */
export function assembleRules(
  base: DirectionRules | null,
  draft: OnboardingDraft,
): DirectionRules | null {
  const about = confirmedOf(AboutSchema, draft.steps['1'])
  const stops = confirmedOf(StopsSchema, draft.steps['2'])
  const ideal = confirmedOf(IdealSchema, draft.steps['3'])
  const r = DirectionRules.safeParse({
    about: about?.about ?? base?.about,
    stop_factors: stops?.stop_factors ?? base?.stop_factors,
    red_flags: stops?.red_flags ?? base?.red_flags,
    axes: ideal?.axes ?? base?.axes,
    threshold: ideal?.threshold ?? base?.threshold,
    notes: ideal?.notes ?? base?.notes,
  })
  return r.success ? r.data : null
}

const lock = (tx: DbOrTx, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)

type Row = typeof directionOnboarding.$inferSelect
/** The stored draft, or null when it no longer fits the contract. */
const draftOf = (row: Row): OnboardingDraft | null => {
  const r = OnboardingDraft.safeParse(row.draft)
  return r.success ? r.data : null
}

async function openRow(db: DbOrTx, accountId: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(directionOnboarding)
    .where(eq(directionOnboarding.accountId, accountId))
  return row && row.state === 'open' ? row : null
}

async function viewOf(db: DbOrTx, row: Row): Promise<OnboardingView> {
  const draft = draftOf(row)
  const mode = row.mode === 'new' ? 'new' : 'edit'
  if (!draft)
    return {
      mode,
      basedOn: row.basedOnVersion,
      step: 1,
      steps: {},
      rules: null,
      changes: [],
      changed: false,
      broken: true,
    }
  const active = (await activeRules(db, row.accountId)).rules
  const base = mode === 'edit' ? active : null
  const pending = STEP_KEYS.find((k) => {
    const st = draft.steps[k]
    return !st || (st.confirmed == null && !st.skipped)
  })
  const rules = assembleRules(base, draft)
  const diff = rules ? rulesDiff(active, rules) : null
  return {
    mode,
    basedOn: row.basedOnVersion,
    step: pending ? Number(pending) : 4,
    steps: draft.steps,
    rules,
    changes: diff?.lines ?? [],
    changed: (diff?.sections.length ?? 0) > 0,
  }
}

const journal = (
  type:
    | 'direction.onboarding_started'
    | 'direction.step_confirmed'
    | 'direction.onboarding_finished'
    | 'direction.onboarding_cancelled',
  accountId: string,
  payload: Record<string, unknown>,
  reason: string | null = null,
) => ({
  type,
  v: 1,
  entity: { kind: 'direction', id: accountId },
  account_id: accountId,
  actor: 'boris' as const,
  occurred_at: new Date().toISOString(),
  causation_id: null,
  correlation_id: newEventId(),
  reason,
  payload,
})

async function write(tx: DbOrTx, accountId: string, draft: OnboardingDraft): Promise<void> {
  await tx
    .update(directionOnboarding)
    .set({ draft, updatedAt: new Date().toISOString() })
    .where(eq(directionOnboarding.accountId, accountId))
}

export async function getOnboarding(db: Db, accountId: string): Promise<OnboardingView | null> {
  const row = await openRow(db, accountId)
  return row ? viewOf(db, row) : null
}

/** The open onboarding as it is, or a fresh draft (never two at once, a repeat start changes nothing). */
export async function startOnboarding(
  db: Db,
  accountId: string,
  mode: OnboardingMode,
): Promise<OnboardingView> {
  return db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const open = await openRow(tx, accountId)
    if (open) return viewOf(tx, open)
    const based = (await activeRules(tx, accountId)).version
    const fresh = {
      accountId,
      mode,
      basedOnVersion: based,
      draft: { steps: {} },
      state: 'open',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await tx
      .insert(directionOnboarding)
      .values(fresh)
      .onConflictDoUpdate({ target: directionOnboarding.accountId, set: fresh })
    await appendEvent(tx, journal('direction.onboarding_started', accountId, { mode }))
    const [row] = await tx
      .select()
      .from(directionOnboarding)
      .where(eq(directionOnboarding.accountId, accountId))
    if (!row) throw new Error('onboarding row vanished')
    return viewOf(tx, row)
  })
}

export type SubmitResult =
  | { ok: true; view: OnboardingView }
  | {
      ok: false
      reason: 'no_answer' | 'invalid' | 'limit' | 'no_onboarding' | 'bad_step' | 'broken'
      view: OnboardingView | null
    }

/**
 * Boris says (or corrects) a step: Claude reads it and the reading is stored as the step's proposal beside the
 * earlier attempts. A miss changes nothing in the draft. The model is called outside any transaction.
 */
export async function submitStep(
  d: { db: Db; gateway: Gateway },
  accountId: string,
  step: number,
  a: { say: string; fix?: string },
): Promise<SubmitResult> {
  const row = await openRow(d.db, accountId)
  if (!row) return { ok: false, reason: 'no_onboarding', view: null }
  const view = await viewOf(d.db, row)
  if (!isStep(step)) return { ok: false, reason: 'bad_step', view }
  const draft = draftOf(row)
  if (!draft) return { ok: false, reason: 'broken', view }
  const confirmed: Confirmed = {
    about: confirmedOf(AboutSchema, draft.steps['1'])?.about,
    stopFactors: confirmedOf(StopsSchema, draft.steps['2'])?.stop_factors,
    redFlags: confirmedOf(StopsSchema, draft.steps['2'])?.red_flags,
  }
  const previous = draft.steps[String(step)]?.proposal
  const current = view.mode === 'edit' ? (await activeRules(d.db, accountId)).rules : null
  const r = await proposeStep(d, step, {
    say: a.say,
    fix: a.fix,
    previous: a.fix && previous ? { understood: previous.understood } : undefined,
    confirmed,
    current,
  })
  if (!r.ok) return { ok: false, reason: r.reason, view }
  return d.db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const now = await openRow(tx, accountId)
    // The draft Boris said this to may be gone (cancelled, started again): the answer is not for the new one.
    if (!now || now.startedAt !== row.startedAt)
      return { ok: false as const, reason: 'no_onboarding' as const, view: null }
    const next = draftOf(now)
    if (!next) return { ok: false as const, reason: 'broken' as const, view: null }
    const old = next.steps[String(step)] ?? emptyStep()
    // A new reading is not confirmed yet: what Boris confirmed earlier is not what he is looking at now.
    next.steps[String(step)] = {
      ...old,
      say: a.say,
      proposal: { understood: r.understood, data: r.data },
      attempts: [...old.attempts, { fix: a.fix ?? null, understood: r.understood }],
      confirmed: null,
      skipped: false,
    }
    await write(tx, accountId, next)
    return { ok: true as const, view: await viewOf(tx, { ...now, draft: next }) }
  })
}

/** «Да, правильно»: the step's latest reading becomes what the draft holds. Null: nothing to confirm. */
export async function confirmStep(
  db: Db,
  accountId: string,
  step: number,
): Promise<OnboardingView | null> {
  return db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const row = await openRow(tx, accountId)
    if (!row || !isStep(step)) return null
    const draft = draftOf(row)
    const st = draft?.steps[String(step)]
    if (!draft || !st?.proposal) return null
    draft.steps[String(step)] = { ...st, confirmed: st.proposal.data, skipped: false }
    await write(tx, accountId, draft)
    await appendEvent(tx, journal('direction.step_confirmed', accountId, { step }))
    return viewOf(tx, { ...row, draft })
  })
}

/** Edit mode only: the step stays as the active rules have it. A new direction cannot skip steps 1-3. */
export async function skipStep(
  db: Db,
  accountId: string,
  step: number,
): Promise<OnboardingView | null> {
  return db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const row = await openRow(tx, accountId)
    if (!row || !isStep(step) || row.mode !== 'edit') return null
    const draft = draftOf(row)
    if (!draft) return null
    const st = draft.steps[String(step)] ?? emptyStep()
    draft.steps[String(step)] = { ...st, confirmed: null, skipped: true }
    await write(tx, accountId, draft)
    return viewOf(tx, { ...row, draft })
  })
}

/** After rules changed under the draft: the confirmed steps stay, the rest comes from the newest active rules. */
export async function rebaseOnboarding(db: Db, accountId: string): Promise<OnboardingView | null> {
  return db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const row = await openRow(tx, accountId)
    if (!row) return null
    const version = (await activeRules(tx, accountId)).version
    await tx
      .update(directionOnboarding)
      .set({ basedOnVersion: version, updatedAt: new Date().toISOString() })
      .where(eq(directionOnboarding.accountId, accountId))
    return viewOf(tx, { ...row, basedOnVersion: version })
  })
}

/** Closes the open draft, once; a draft that is already finished or cancelled stays as it is. */
export async function cancelOnboarding(db: Db, accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lock(tx, `onboarding:${accountId}`)
    const closed = await tx
      .update(directionOnboarding)
      .set({ state: 'cancelled', updatedAt: new Date().toISOString() })
      .where(
        and(eq(directionOnboarding.accountId, accountId), eq(directionOnboarding.state, 'open')),
      )
      .returning({ id: directionOnboarding.accountId })
    if (closed.length > 0)
      await appendEvent(tx, journal('direction.onboarding_cancelled', accountId, {}))
  })
}

const SECTION_NAMES = {
  about: 'описание',
  stop_factors: 'стоп-факторы',
  red_flags: 'красные флаги',
  axes: 'оси',
  threshold: 'порог',
  notes: 'уточнения',
} as const

export type FinishResult =
  | { ok: true; version: number | null }
  | { ok: false; error: 'closed' | 'stale' | 'incomplete' | 'needs_calibration' }

/**
 * «Включить»: the confirmed steps become Boris's new rules version, in one transaction with closing the draft.
 * Refused when the rules moved on since the draft began (stale), when a new direction lacks a section, and, until
 * a calibration passed on exactly these rules, unless Boris saves anyway with a reason. The reason is kept in
 * `direction_override`, never in the journal. Rules that change nothing make no version (a list in another
 * order is no change).
 */
export async function finishOnboarding(
  db: Db,
  accountId: string,
  opts: {
    override?: { reason: string }
    calibrated?: (tx: Tx, rules: DirectionRules) => Promise<boolean>
  },
): Promise<FinishResult> {
  return db.transaction(async (tx): Promise<FinishResult> => {
    // The same lock insertVersion takes, so a version from anywhere else cannot slip in between; then the
    // draft's own lock (no path takes them the other way round), so a step cannot change under the finish.
    await lock(tx, `direction:${accountId}`)
    await lock(tx, `onboarding:${accountId}`)
    const row = await openRow(tx, accountId)
    if (!row) return { ok: false, error: 'closed' }
    const active = await activeRules(tx, accountId)
    if (row.basedOnVersion !== active.version) return { ok: false, error: 'stale' }
    const draft = draftOf(row)
    const rules = draft ? assembleRules(row.mode === 'edit' ? active.rules : null, draft) : null
    if (!rules) return { ok: false, error: 'incomplete' }
    const done = (version: number | null) =>
      tx
        .update(directionOnboarding)
        .set({ state: 'finished', updatedAt: new Date().toISOString() })
        .where(eq(directionOnboarding.accountId, accountId))
        .then(() => ({ ok: true as const, version }))
    const sections = rulesDiff(active.rules, rules).sections
    if (sections.length === 0) {
      await appendEvent(
        tx,
        journal('direction.onboarding_finished', accountId, { version: null, sections }),
      )
      return done(null)
    }
    const reason = opts.override?.reason.trim() ?? ''
    const passed = (await opts.calibrated?.(tx, rules)) ?? false
    if (!passed && !reason) return { ok: false, error: 'needs_calibration' }
    const version = await insertVersion(tx, {
      accountId,
      rules,
      createdBy: 'boris',
      reason: `Онбординг: изменены ${sections.map((x) => SECTION_NAMES[x]).join(', ')}`,
    })
    await appendEvent(
      tx,
      journal('direction.onboarding_finished', accountId, {
        version,
        sections,
        ...(passed ? {} : { override: true }),
      }),
    )
    // Why Boris saved below the target stays for good, apart from the draft that the next onboarding replaces.
    if (!passed) await tx.insert(directionOverride).values({ accountId, version, reason })
    return done(version)
  })
}
