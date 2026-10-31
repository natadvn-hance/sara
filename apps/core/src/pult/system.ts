import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SystemPart, SystemView } from '@sara/shared'
import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { AppDeps } from '../api/deps'
import type { DbOrTx } from '../db/client'
import { account, event, modelCall } from '../db/schema'
import { runHealthChecks } from '../health/checks'
import { notTest } from '../testLeads/sql'

/** «Здоровье» (M7): the node of Profi.ru, the session, the link, the backups and the Claude limit, read only. */

const MODELS = ['haiku', 'sonnet', 'opus'] as const

/** When this core started: the last deploy or restart, for «Состояние». */
const STARTED_AT = new Date().toISOString()
/** The version of Sara this core runs, from the repository's package.json (release-please keeps it). */
const VERSION = (() => {
  try {
    const root = resolve(import.meta.dirname, '../../../..')
    return (
      (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string })
        .version ?? '?'
    )
  } catch {
    return '?'
  }
})()
const DAY_MS = 24 * 3600 * 1000

export type ClaudeLimit = { limited: boolean; until: string | null; since: string | null }

/** Each model's last word decides, as the gateway reads it after a restart: a limit answer after the last answer. */
export async function claudeLimit(db: DbOrTx): Promise<ClaudeLimit> {
  let out: ClaudeLimit = { limited: false, until: null, since: null }
  for (const model of MODELS) {
    const [last] = await db
      .select({
        errorClass: modelCall.errorClass,
        at: modelCall.startedAt,
        resetAt: sql<string | null>`${event.payload}->>'resetAt'`,
      })
      .from(modelCall)
      .leftJoin(
        event,
        and(
          eq(event.entityKind, 'model_call'),
          sql`${event.entityId} = ${modelCall.id}::text`,
          eq(event.type, 'model.failed'),
        ),
      )
      .where(
        and(
          eq(modelCall.model, model),
          or(
            eq(modelCall.ok, true),
            eq(modelCall.errorClass, 'bad_output'),
            and(eq(modelCall.errorClass, 'limit_reached'), gt(modelCall.durationMs, 0)),
          ),
        ),
      )
      .orderBy(desc(modelCall.startedAt))
      .limit(1)
    if (last?.errorClass === 'limit_reached' && !out.limited)
      out = { limited: true, until: last.resetAt, since: last.at }
  }
  return out
}

export type ProfiLink = { lost: boolean; at: string | null }

/** The node sends these only after a page of Profi.ru answered it; a test order's come from the made-up site. */
const SITE_ANSWERED = ['profi.order_seen', 'profi.client_message', 'profi.balance_changed']

/**
 * The link to Profi.ru from the journal: the last «connection lost» or «back», where a «lost» with an order, a message
 * or the wallet read after it is over too (at: when the first of them came). On 29.10.2026 node restarts lost the
 * «back» and «Нет связи» stayed on the pult and in the secretary's words for days while orders came every few minutes.
 */
export async function profiLink(db: DbOrTx): Promise<ProfiLink> {
  const [last] = await db
    .select({ type: event.type, at: event.occurredAt })
    .from(event)
    .where(inArray(event.type, ['profi.connection_lost', 'profi.connection_back']))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  if (last?.type !== 'profi.connection_lost') return { lost: false, at: last?.at ?? null }
  const [answered] = await db
    .select({ at: event.occurredAt })
    .from(event)
    .where(
      and(
        inArray(event.type, SITE_ANSWERED),
        gt(event.occurredAt, last.at),
        notTest(event.entityId),
      ),
    )
    .orderBy(asc(event.occurredAt))
    .limit(1)
  return answered ? { lost: false, at: answered.at } : { lost: true, at: last.at }
}

/** The line «Связь с Профи.ру» of «Здоровье». */
async function linkPart(db: DbOrTx): Promise<SystemPart> {
  const link = await profiLink(db)
  const base = { id: 'link', title: 'Связь с Профи.ру' }
  if (link.lost)
    return {
      ...base,
      tone: 'bad',
      text: 'Профи.ру не открывается с сервера',
      fix: 'Сара пробует сама раз в 5 минут и напишет «Связь вернулась».',
      at: link.at,
    }
  return {
    ...base,
    tone: 'ok',
    text: link.at ? 'Связь есть, последний перерыв закончился' : 'Перерывов связи не было',
    fix: null,
    at: link.at,
  }
}

/** The backup log the host writes (infra/backup): the last dump and the last restore check. */
export async function backupPart(path: string | undefined, now: Date): Promise<SystemPart> {
  const base = { id: 'backup', title: 'Резервные копии' }
  if (!path)
    return {
      ...base,
      tone: 'warn',
      text: 'Ядро не видит журнал копий',
      fix: 'Копии делаются на сервере ночью; чтобы видеть их здесь, разработчику нужно открыть ядру журнал /var/log/sara-backup.log.',
      at: null,
    }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {
      ...base,
      tone: 'warn',
      text: 'Журнал копий пока пуст',
      fix: 'Первая копия появится ночью.',
      at: null,
    }
  }
  const lines = text.trim().split('\n')
  const lastOf = (word: string) =>
    lines
      .filter((l) => l.includes(` ${word} `))
      .at(-1)
      ?.split(' ')[0] ?? null
  const dump = lastOf('dump')
  const restore = lastOf('restore')
  if (!dump)
    return {
      ...base,
      tone: 'warn',
      text: 'Копий в журнале нет',
      fix: 'Напиши разработке: ночная копия не записана.',
      at: null,
    }
  const old = now.getTime() - Date.parse(dump) > 36 * 3600 * 1000
  return {
    ...base,
    tone: old ? 'bad' : 'ok',
    text: `${old ? 'Последняя копия старше полутора суток' : 'Ночная копия есть'}${restore ? ', проверка восстановления проходила' : ''}`,
    fix: old ? 'Напиши разработке: ночная копия не сделана.' : null,
    at: dump,
  }
}

export async function systemView(d: AppDeps & { backupLog?: string }): Promise<SystemView> {
  const now = new Date()
  const checks = await runHealthChecks(d)
  const parts: SystemPart[] = checks.map((c) => ({
    id: c.id === 'profi' ? 'session' : c.id,
    title: c.id === 'profi' ? 'Сессия Профи.ру' : c.title,
    tone: c.ok ? 'ok' : 'bad',
    text: c.detail,
    fix: c.fix,
    at: null,
  }))
  // The node itself: it answers at all, before what it says of the session.
  let node: SystemPart
  try {
    const h = await d.profi.sessionHealth(d.accounts?.[0]?.id ?? d.accountId ?? 'hance-marketing')
    node = {
      id: 'node',
      title: 'Узел Профи.ру',
      tone: h.dead_events ? 'warn' : 'ok',
      text: `Отвечает${h.queued_events === undefined ? '' : `, событий в очереди к ядру ${h.queued_events}`}`,
      fix: h.dead_events ? 'Напиши разработке: часть событий не прошла проверку ядра.' : null,
      at: now.toISOString(),
    }
  } catch {
    node = {
      id: 'node',
      title: 'Узел Профи.ру',
      tone: 'bad',
      text: 'Служба браузера Профи.ру не отвечает',
      fix: 'Напиши разработке: контейнер profi-node не отвечает ядру.',
      at: null,
    }
  }
  parts.splice(1, 0, node)
  parts.push(await linkPart(d.db), await backupPart(d.backupLog, now))

  const limit = await claudeLimit(d.db)
  // The status check knows only its own probe; the roles working in the last two hours say as much (M7, 28.10).
  const claude = parts.find((p) => p.id === 'claude')
  if (claude && claude.tone !== 'ok' && !limit.limited) {
    const [last] = await d.db
      .select({ at: modelCall.startedAt })
      .from(modelCall)
      .where(
        and(
          eq(modelCall.ok, true),
          gt(modelCall.startedAt, new Date(now.getTime() - 2 * 3600 * 1000).toISOString()),
        ),
      )
      .orderBy(desc(modelCall.startedAt))
      .limit(1)
    if (last)
      Object.assign(claude, {
        tone: 'ok',
        text: 'Работает: Сара думает и пишет',
        fix: null,
        at: last.at,
      })
  }
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const roles = await d.db
    .select({
      role: modelCall.role,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where not ${modelCall.ok})::int`,
      ms: sql<number>`coalesce(sum(${modelCall.durationMs}), 0)::int`,
    })
    .from(modelCall)
    .where(gt(modelCall.startedAt, since))
    .groupBy(modelCall.role)
    .orderBy(desc(sql`count(*)`))
  const accounts = await d.db.select().from(account).orderBy(account.id)
  return {
    parts,
    deploy: { version: VERSION, startedAt: STARTED_AT },
    claude: { limited: limit.limited, until: limit.until, roles },
    accounts: accounts.map((a) => ({
      id: a.id,
      title: a.title,
      login: a.loginState,
      paused: a.paused,
      balanceRub: a.balanceRub,
    })),
  }
}
