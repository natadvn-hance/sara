import { formatCallback, isTestOrder, plural, type SystemPart } from '@sara/shared'
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sheetRow, sheetSync } from '../db/schema'
import type { Notifier } from '../notify/notifier'
import { type LogRow, logRows, monthName } from '../pult/analytics'

/**
 * FR-ANL-7: Boris's Google Sheet «Profi.ru трекер лидов» gets Sara's bids next to the pult (Boris, 30.10.2026: «она
 * писала данные в таблицу параллельно»). The rows are the pult's client log (`logRows`), so the numbers agree. The
 * script in his sheet (infra/sheet/sara-sheet.gs) keeps a row per order and writes a cell only while it holds what
 * Sara wrote last: a cell Boris changed is his from then on.
 *
 * The queue is the difference between what Sara knows and what she last wrote (`core.sheet_row`), so nothing is
 * lost across restarts and a failed send is tried again with a growing pause. A failure never stops Sara's work;
 * «Состояние» in the pult says when the sheet lags.
 */

export const SHEET_COLUMNS = [
  'month',
  'client',
  'service',
  'stage',
  'deal',
  'spend',
  'ltv',
  'note',
] as const
export type SheetColumn = (typeof SHEET_COLUMNS)[number]
export type SheetValues = Record<SheetColumn, string | number>

/** Boris's columns of «Лог клиентов», in his formats: the month as a word, sums in roubles, empty when unknown. */
export function sheetValues(r: LogRow): SheetValues {
  return {
    month: monthName(r.month),
    client: r.client,
    service: r.service,
    stage: r.stage,
    deal: r.dealRub ?? '',
    spend: r.spendRub,
    ltv: r.ltvRub ?? '',
    note: r.note ?? '',
  }
}

/** As the script compares cells: 30000 and «30000» are one value, spaces at the ends do not count. */
export function norm(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return String(v)
  const s = String(v).trim()
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s
}

/** The earliest moment: «since» of a backfill, so every bid of the journal is a row. */
export const EPOCH = '2000-01-01T00:00:00.000Z'

/** The press of «Внести» has no task row: this id only carries the callback (sheet/backfill.ts). */
export const SHEET_TASK_ID = 'a5a5a5a5-0000-4000-8000-5eeeeeee0001'

export type SheetOp = {
  key: string
  create: boolean
  /** Look first for Boris's own row of the same client and month, and take it instead of adding a second. */
  match?: boolean
  values: Partial<SheetValues>
  /** What Sara wrote in these cells last time: the script writes a cell only while it still holds this. */
  expect: Partial<SheetValues>
}

type SheetResult = {
  key: string
  status: 'created' | 'updated' | 'gone' | 'adopted' | 'doubt' | 'error'
  written?: string[]
  kept?: string[]
  /** `adopted`: what Boris's row holds now, by column. */
  current?: Partial<Record<SheetColumn, string | number>>
  /** `doubt`: why the row was not added. */
  reason?: string
  error?: string
}

type SheetAnswer = { ok: boolean; error?: string; results?: SheetResult[] }

export type SheetTick =
  | { state: 'off' | 'waiting' | 'idle' }
  | { state: 'sent'; ops: number }
  | { state: 'failed'; error: string }

export type SheetSync = { tick(at?: Date): Promise<SheetTick>; stop(): void }

/** Without a write for this long the link is checked with a ping, so «Состояние» knows it still works. */
const PING_EVERY_MS = 6 * 3600_000
/** One request carries at most this many rows. */
const BATCH = 50
/** The pause after the n-th failure in a row: 1, 2, 4... minutes, never more than half an hour. */
const backoffMs = (failures: number) => Math.min(2 ** (failures - 1), 30) * 60_000

/** Boris's words for what went wrong, for «Состояние». */
const ERRORS: Record<string, string> = {
  secret: 'Скрипт таблицы не принял секрет Сары: в таблице старый скрипт или не тот секрет',
  no_sheet: 'В таблице нет вкладки «Лог клиентов»',
  bad_json: 'Скрипт таблицы не понял запрос',
}

const RANK: Record<string, number> = {
  Отклик: 0,
  Переговоры: 1,
  'В работе': 2,
  Закрыта: 3,
}

/**
 * Sara's stage replaces the one in Boris's own row only when it is further on. A won deal stays won, a drop stays a
 * drop (Boris knows it first), a stage that is not one of the five is replaced.
 */
export function stageWins(sara: string, current: string): boolean {
  if (sara === current || current === 'Закрыта') return false
  if (!(current in RANK) && current !== 'Отвалился') return sara !== ''
  if (sara === 'Закрыта') return true
  if (current === 'Отвалился') return false
  if (sara === 'Отвалился') return true
  return (RANK[sara] ?? -1) > (RANK[current] ?? -1)
}

const listNames = (names: string[]) =>
  names.length > 15
    ? `${names.slice(0, 15).join('; ')} и еще ${names.length - 15}`
    : names.join('; ')

export function backfillText(c: {
  total: number
  added: number
  matched: number
  doubts: string[]
}): string {
  return [
    '📊 Таблица подключена. Прошлые отклики из журнала Сары можно внести.',
    `Всего: ${c.total}.`,
    `Добавлю новых строк: ${c.added}.`,
    `Сопоставлю с твоими строками (они уже есть, не дублирую): ${c.matched}.`,
    c.doubts.length
      ? `Под вопросом, не вношу (${c.doubts.length}): ${listNames(c.doubts)}.`
      : 'Под вопросом: ничего.',
    'Вносить?',
  ].join('\n')
}

export function startSheetSync(d: {
  db: Db
  url: string | undefined
  secret: string | undefined
  fetch?: typeof fetch
  /** Boris's chat: the preview of the past bids and its summary; without it the past bids are not offered. */
  notifier?: Pick<Notifier, 'sendButtons' | 'sendText'>
  now?: () => Date
  /** How often the sheet is brought up to date (default a minute); tests call tick instead. */
  tickMs?: number
  timeoutMs?: number
}): SheetSync {
  const now = d.now ?? (() => new Date())
  const send = d.fetch ?? fetch
  const configured = !!(d.url && d.secret)

  async function post(body: object): Promise<SheetAnswer> {
    let res: Response
    try {
      res = await send(d.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: d.secret, ...body }),
        redirect: 'follow',
        signal: AbortSignal.timeout(d.timeoutMs ?? 30_000),
      })
    } catch (e) {
      throw new Error(`Google не ответил: ${(e as Error).message}`)
    }
    if (!res.ok) throw new Error(`Google ответил ошибкой ${res.status}`)
    let a: SheetAnswer
    try {
      a = (await res.json()) as SheetAnswer
    } catch {
      throw new Error(
        'По ссылке не скрипт таблицы: при развертывании нужен доступ «Все» и ссылка, которая кончается на /exec',
      )
    }
    if (!a.ok) throw new Error(ERRORS[a.error ?? ''] ?? `Скрипт таблицы ответил: ${a.error}`)
    return a
  }

  async function state(at: Date) {
    await d.db.insert(sheetSync).values({ id: 1, since: at.toISOString() }).onConflictDoNothing()
    const [s] = await d.db.select().from(sheetSync).where(eq(sheetSync.id, 1))
    if (!s) throw new Error('sheet state is not readable')
    return s
  }

  async function failed(at: Date, failures: number, error: string): Promise<SheetTick> {
    const n = failures + 1
    await d.db
      .update(sheetSync)
      .set({
        failures: n,
        lastError: error,
        lastErrorAt: at.toISOString(),
        nextTryAt: new Date(at.getTime() + backoffMs(n)).toISOString(),
      })
      .where(eq(sheetSync.id, 1))
    console.error('sheet sync failed', error)
    return { state: 'failed', error }
  }

  async function pass(at: Date): Promise<SheetTick> {
    if (!configured) return { state: 'off' }
    const s = await state(at)
    if (s.nextTryAt && Date.parse(s.nextTryAt) > at.getTime()) return { state: 'waiting' }
    if (s.backfill === 'none' && d.notifier) {
      try {
        await askBackfill(at, s.since)
      } catch (e) {
        return failed(at, s.failures, (e as Error).message)
      }
    }
    const rows = (await logRows(d.db, { since: s.since })).filter((r) => !isTestOrder(r.orderId))
    const known = new Map((await d.db.select().from(sheetRow)).map((k) => [k.orderId, k] as const))
    const labels = new Map(rows.map((r) => [r.orderId, `${r.client}, ${monthName(r.month)}`]))
    const ops: SheetOp[] = []
    for (const r of rows) {
      const k = known.get(r.orderId)
      if (k?.state === 'gone' || k?.state === 'doubt') continue
      const want = sheetValues(r)
      const boris = new Set(k?.boris ?? [])
      const written = k?.written ?? {}
      const create = !k || k.state === 'new'
      const op: SheetOp = { key: r.orderId, create, values: {}, expect: {} }
      if (create) op.match = true
      for (const c of SHEET_COLUMNS) {
        if (boris.has(c) || (!create && norm(want[c]) === norm(written[c]))) continue
        op.values[c] = want[c]
        op.expect[c] = written[c] ?? ''
      }
      if (Object.keys(op.values).length === 0) {
        if (k?.pendingSince)
          await d.db
            .update(sheetRow)
            .set({ pendingSince: null })
            .where(eq(sheetRow.orderId, r.orderId))
        continue
      }
      ops.push(op)
      if (!k)
        await d.db
          .insert(sheetRow)
          .values({ orderId: r.orderId, accountId: r.accountId, pendingSince: at.toISOString() })
          .onConflictDoNothing()
      else if (!k.pendingSince)
        await d.db
          .update(sheetRow)
          .set({ pendingSince: at.toISOString() })
          .where(eq(sheetRow.orderId, r.orderId))
    }

    if (ops.length === 0) {
      if (s.backfill === 'running') await finishBackfill(at)
      if (s.lastOkAt && at.getTime() - Date.parse(s.lastOkAt) < PING_EVERY_MS)
        return { state: 'idle' }
      try {
        await post({ ping: true })
      } catch (e) {
        return failed(at, s.failures, (e as Error).message)
      }
      await d.db
        .update(sheetSync)
        .set({ lastOkAt: at.toISOString(), failures: 0, lastError: null, nextTryAt: null })
        .where(eq(sheetSync.id, 1))
      return { state: 'idle' }
    }

    for (let i = 0; i < ops.length; i += BATCH) {
      const batch = ops.slice(i, i + BATCH)
      let a: SheetAnswer
      try {
        a = await post({ ops: batch })
      } catch (e) {
        return failed(at, s.failures, (e as Error).message)
      }
      const results = new Map((a.results ?? []).map((r) => [r.key, r] as const))
      const errors: string[] = []
      for (const op of batch) {
        const r = results.get(op.key)
        if (!r || r.status === 'error') {
          errors.push(r?.error ?? `нет ответа по заказу ${op.key}`)
          continue
        }
        await settle(op, r, labels.get(op.key) ?? op.key)
      }
      await d.db
        .update(sheetSync)
        .set({ lastOkAt: at.toISOString(), lastWriteAt: at.toISOString() })
        .where(eq(sheetSync.id, 1))
      // A row the script could not write waits like a failed request: the same growing pause.
      if (errors.length)
        return failed(at, s.failures, `Скрипт таблицы не записал строку: ${errors[0]}`)
    }
    await d.db
      .update(sheetSync)
      .set({ failures: 0, lastError: null, nextTryAt: null })
      .where(eq(sheetSync.id, 1))
    return { state: 'sent', ops: ops.length }
  }

  /** What the sheet now holds: the cells written are Sara's last values, the cells kept are Boris's from now on. */
  async function settle(op: SheetOp, r: SheetResult, label: string) {
    if (r.status === 'doubt') {
      await d.db
        .update(sheetRow)
        .set({
          state: 'doubt',
          written: { _doubt: `${label}: ${r.reason ?? 'есть сомнение'}` },
          pendingSince: null,
          updatedAt: sql`now()`,
        })
        .where(eq(sheetRow.orderId, op.key))
      return
    }
    if (r.status === 'adopted') {
      // Boris's own row now carries this order: what it holds is his, except the empty cells and a stage Sara outranks.
      const current = r.current ?? {}
      const written: Record<string, string | number> = { _how: 'adopted' }
      const boris: string[] = []
      for (const c of SHEET_COLUMNS) {
        const have = current[c]
        written[c] = have ?? ''
        if (norm(have) === '') continue
        const sara = norm(op.values.stage)
        if (c === 'stage' && (norm(have) === sara || stageWins(sara, norm(have)))) continue
        boris.push(c)
      }
      await d.db
        .update(sheetRow)
        .set({ state: 'active', written, boris, pendingSince: null, updatedAt: sql`now()` })
        .where(eq(sheetRow.orderId, op.key))
      return
    }
    if (r.status === 'gone') {
      await d.db
        .update(sheetRow)
        .set({ state: 'gone', pendingSince: null, updatedAt: sql`now()` })
        .where(eq(sheetRow.orderId, op.key))
      return
    }
    const [k] = await d.db.select().from(sheetRow).where(eq(sheetRow.orderId, op.key))
    const written = { ...(k?.written ?? {}) }
    if (r.status === 'created') written._how = 'created'
    for (const c of r.written ?? []) {
      const v = op.values[c as SheetColumn]
      if (v !== undefined) written[c] = v
    }
    const boris = [...new Set([...(k?.boris ?? []), ...(r.kept ?? [])])]
    await d.db
      .update(sheetRow)
      .set({ state: 'active', written, boris, pendingSince: null, updatedAt: sql`now()` })
      .where(eq(sheetRow.orderId, op.key))
  }

  /**
   * The bids from before the link: the script says how each would go (a new row, Boris's own row taken, a doubt),
   * Boris gets one message with the counts and «Внести». Nothing is written before his press.
   */
  async function askBackfill(at: Date, since: string) {
    const old = (await logRows(d.db, { since: EPOCH })).filter(
      (r) => !isTestOrder(r.orderId) && Date.parse(r.bidAt) < Date.parse(since),
    )
    const known = new Set(
      (await d.db.select({ id: sheetRow.orderId }).from(sheetRow)).map((r) => r.id),
    )
    const fresh = old.filter((r) => !known.has(r.orderId))
    if (fresh.length === 0) {
      await d.db.update(sheetSync).set({ backfill: 'done' }).where(eq(sheetSync.id, 1))
      return
    }
    const ops: SheetOp[] = fresh.map((r) => ({
      key: r.orderId,
      create: true,
      match: true,
      values: sheetValues(r),
      expect: {},
    }))
    const a = await post({ preview: true, ops })
    const by = new Map((a.results ?? []).map((r) => [r.key, r] as const))
    let added = 0
    let matched = 0
    const doubts: string[] = []
    for (const r of fresh) {
      const res = by.get(r.orderId)
      if (res?.status === 'adopted') matched++
      else if (res?.status === 'doubt') doubts.push(`${r.client}, ${monthName(r.month)}`)
      else added++
    }
    const m = await d.notifier?.sendButtons(
      backfillText({ total: fresh.length, added, matched, doubts }),
      [
        [
          { text: 'Внести', callbackData: formatCallback(SHEET_TASK_ID, 'apply') },
          { text: 'Не вносить', callbackData: formatCallback(SHEET_TASK_ID, 'drop') },
        ],
      ],
    )
    await d.db
      .update(sheetSync)
      .set({ backfill: 'asked', backfillMessageId: m?.messageId ?? null })
      .where(eq(sheetSync.id, 1))
    console.log(
      `sheet backfill asked at ${at.toISOString()}: ${added} new, ${matched} matched, ${doubts.length} doubts`,
    )
  }

  /** The past bids are all in: one line of what happened. */
  async function finishBackfill(at: Date) {
    await d.db.update(sheetSync).set({ backfill: 'done' }).where(eq(sheetSync.id, 1))
    const rows = await d.db.select().from(sheetRow)
    const how = (h: string) => rows.filter((r) => r.written._how === h).length
    const doubts = rows
      .filter((r) => r.state === 'doubt')
      .map((r) => String(r.written._doubt ?? r.orderId))
    await d.notifier?.sendText(
      [
        '📊 Прошлые отклики в таблице.',
        `Добавила строк: ${how('created')}. Сопоставила с твоими: ${how('adopted')}.`,
        doubts.length
          ? `Не внесла, нужно твое решение (${doubts.length}): ${listNames(doubts)}.`
          : 'Сомнительных нет.',
      ].join('\n'),
    )
    console.log(`sheet backfill done at ${at.toISOString()}`)
  }

  // One pass at a time: a slow Google never overlaps the next tick.
  let running: Promise<SheetTick> | null = null
  function tick(at?: Date): Promise<SheetTick> {
    if (running) return running
    running = pass(at ?? now()).finally(() => {
      running = null
    })
    return running
  }
  const timer = configured
    ? setInterval(
        () => void tick().catch((e) => console.error('sheet sync failed', (e as Error).message)),
        d.tickMs ?? 60_000,
      )
    : null
  return {
    tick,
    stop() {
      if (timer) clearInterval(timer)
    },
  }
}

/** A sheet that waits longer than this is behind (Boris sees it in red on «Состояние»). */
const LAG_MS = 15 * 60_000

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  })

/** «Google Таблица» on «Состояние»; null when no sheet is linked. */
export async function sheetPart(
  db: Db,
  configured: boolean,
  now: Date,
): Promise<SystemPart | null> {
  if (!configured) return null
  const base = { id: 'sheet', title: 'Google Таблица' }
  const [s] = await db.select().from(sheetSync).where(eq(sheetSync.id, 1))
  const [p] = (
    await db.execute<{ n: number; since: Date | string | null }>(sql`
      select count(*)::int as n, min(pending_since) as since from core.sheet_row
      where pending_since is not null and state <> 'gone'`)
  ).rows
  const waiting = p?.n ?? 0
  // A raw query gives the time as a Date: «Состояние» carries it as text.
  const since = p?.since ? new Date(p.since).toISOString() : null
  const lagging = !!since && now.getTime() - Date.parse(since) > LAG_MS
  const [dq] = (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from core.sheet_row where state = 'doubt'`,
    )
  ).rows
  const doubts = dq?.n ?? 0
  const extra =
    (s?.backfill === 'asked' ? ' Жду твоего ответа про прошлые отклики.' : '') +
    (doubts ? ` Под вопросом строк: ${doubts}.` : '')
  const retry = s?.nextTryAt ? ` Следующая попытка в ${hhmm(s.nextTryAt)}.` : ''
  if (lagging && since)
    return {
      ...base,
      tone: 'bad',
      text: `Таблица отстала: ${waiting} ${plural(waiting, ['строка ждет', 'строки ждут', 'строк ждут'])} с ${hhmm(since)}`,
      fix: `${s?.lastError ?? 'Запись в таблицу не проходит'}. Сара пробует сама.${retry}`,
      at: since,
    }
  if (s?.lastError)
    return {
      ...base,
      tone: 'warn',
      text: 'Последняя запись в таблицу не прошла, Сара повторит',
      fix: `${s.lastError}.${retry}`,
      at: s.lastErrorAt,
    }
  if (!s?.lastOkAt)
    return {
      ...base,
      tone: 'warn',
      text: 'Подключаю таблицу: первая проверка в течение минуты',
      fix: null,
      at: null,
    }
  return {
    ...base,
    tone: s.backfill === 'asked' ? 'warn' : 'ok',
    text:
      (s.lastWriteAt
        ? 'Пишет отклики в «Лог клиентов».'
        : 'Связь есть, новых откликов для таблицы пока не было.') + extra,
    fix: null,
    at: s.lastWriteAt ?? s.lastOkAt,
  }
}
