import { formatRub, plural } from '@sara/shared'
import { desc, eq, sql } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { account, event } from '../db/schema'
import type { ProfiClient } from '../profi/client'
import { getSetting } from '../settings/store'

/** Why a bid was not recorded, in Boris's words (Russian, plain, no long dash). */
export const MONEY_TEXTS = {
  noWallet: 'Не вижу баланс кошелька на Профи.ру, отклик не отправила. Нажми ещё раз через минуту.',
  unknownFee:
    'Не знаю цену отклика на эту заявку, отклик не отправила. Откликнись вручную на Профи.ру, если заявка нужна.',
  overCeiling: (fee: number, max: number) =>
    `Отклик стоит ${formatRub(fee)}, это выше потолка ${formatRub(max)} за отклик. Отклик не отправила.`,
  lowWallet: (available: number, fee: number, queued: boolean) =>
    `На кошельке ${formatRub(available)}${queued ? ' за вычетом откликов в очереди' : ''}, а отклик стоит ${formatRub(fee)}. Пополни кошелёк и нажми снова.`,
  overBudget: (budget: number, spent: number, fee: number) =>
    `Бюджет дня ${formatRub(budget)}: уже ${formatRub(spent)}, отклик стоит ${formatRub(fee)}. Отклик не отправила.`,
  overCap: (n: number, cap: number) =>
    `Сегодня уже ${n} ${plural(n, ['отклик', 'отклика', 'откликов'])} из ${cap}, это дневной лимит. Отклик не отправила.`,
}

/** How long a press waits for the wallet: Telegram's answer to a button must not expire meanwhile. */
const WALLET_WAIT_MS = 5000

/**
 * The wallet from the session health; null when the node does not answer within `waitMs` or does not know it
 * yet.
 */
export async function readWallet(
  profi: Pick<ProfiClient, 'sessionHealth'>,
  accountId: string,
  waitMs = WALLET_WAIT_MS,
): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
  })
  try {
    return await Promise.race([profi.sessionHealth(accountId).then((h) => h.balance_rub), late])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

type Day = { sent: number; spent: number; pending: number; pendingRub: number; queuedRub: number }

/**
 * The Moscow day of `now` from the journal (bid.sent, spend.recorded), plus the bids that may still spend:
 * queued ones and today's unsure ones. Failed and given back bids spent nothing.
 */
export async function dayOf(tx: DbOrTx, now: Date): Promise<Day> {
  const r = await tx.execute<Day>(sql`
    with d as (
      select ((${now.toISOString()}::timestamptz at time zone 'Europe/Moscow')::date::timestamp
        at time zone 'Europe/Moscow') as s
    ), p as (
      select o.state, coalesce((o.payload->>'priceRub')::int, 0) as rub from core.outbox o, d
      where o.kind = 'bid'
        and (o.state = 'queued' or (o.state = 'uncertain' and o.created_at >= d.s and o.created_at < d.s + interval '1 day'))
    )
    select
      (select count(*)::int from core.event e, d where e.type = 'bid.sent'
         and e.occurred_at >= d.s and e.occurred_at < d.s + interval '1 day') as sent,
      (select coalesce(sum((e.payload->>'amount_rub')::int), 0)::int from core.event e, d
         where e.type = 'spend.recorded' and e.occurred_at >= d.s and e.occurred_at < d.s + interval '1 day') as spent,
      (select count(*)::int from p) as pending,
      (select coalesce(sum(rub), 0)::int from p) as "pendingRub",
      (select coalesce(sum(rub), 0)::int from p where state = 'queued') as "queuedRub"`)
  const row = r.rows[0]
  if (!row) throw new Error('day of bids is not readable')
  return row
}

/**
 * FR-LEAD-9: the money check before a bid is recorded, inside the bid's transaction. The money lock makes two
 * presses at once check one after the other, so neither can pass a limit the other already used. Returns the
 * reason for Boris, or null when the bid may be recorded. The pause (outbound.bids) is checked by the caller
 * before the wallet is read.
 */
export async function refuseSpend(
  tx: DbOrTx,
  c: { feeRub: number; balanceRub: number | null; now: Date },
): Promise<string | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sara:money'))`)
  // The node sends 0 when the order page could not be read. The fee is also the most the node may pay
  // (max_fee_rub), so an unknown one never goes, whatever the limits.
  if (c.feeRub <= 0) return MONEY_TEXTS.unknownFee
  if (c.balanceRub === null) return MONEY_TEXTS.noWallet
  const max = await getSetting(tx, 'money.max_fee_rub')
  const budget = await getSetting(tx, 'money.daily_budget_rub')
  if (max !== null && c.feeRub > max) return MONEY_TEXTS.overCeiling(c.feeRub, max)
  const day = await dayOf(tx, c.now)
  const available = c.balanceRub - day.queuedRub
  if (available < c.feeRub) return MONEY_TEXTS.lowWallet(available, c.feeRub, day.queuedRub > 0)
  const spent = day.spent + day.pendingRub
  if (budget !== null && spent + c.feeRub > budget)
    return MONEY_TEXTS.overBudget(budget, spent, c.feeRub)
  const cap = await getSetting(tx, 'money.daily_bids')
  const bids = day.sent + day.pending
  if (bids >= cap) return MONEY_TEXTS.overCap(bids, cap)
  return null
}

/**
 * The wallet as the core last heard it, without asking the node: the newer of the account row and the last balance
 * the node reported. «Сегодня» of the pult and the bot's status both say this one.
 */
export async function walletNow(
  db: DbOrTx,
): Promise<{ balanceRub: number | null; at: string | null }> {
  const [acc] = await db.select().from(account).orderBy(account.id).limit(1)
  const [ev] = await db
    .select({
      at: event.occurredAt,
      rub: sql<number | null>`(${event.payload}->>'balance_rub')::int`,
    })
    .from(event)
    .where(eq(event.type, 'profi.balance_changed'))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  const fromAcc = acc?.balanceRub !== null && acc?.balanceRub !== undefined
  if (ev?.rub !== null && ev?.rub !== undefined && (!fromAcc || (acc?.balanceAt ?? '') < ev.at))
    return { balanceRub: ev.rub, at: ev.at }
  return fromAcc
    ? { balanceRub: acc?.balanceRub ?? null, at: acc?.balanceAt ?? null }
    : { balanceRub: null, at: null }
}
