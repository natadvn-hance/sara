import { ProbeOutput } from '@sara/shared'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import type { AppDeps } from '../api/deps'
import { modelCall } from '../db/schema'
import { getMe } from '../notify/telegramApi'

export type HealthCheck = {
  id: 'db' | 'telegram' | 'claude' | 'profi'
  ok: boolean
  title: string
  detail: string
  fix: string | null
}

async function dbCheck(d: AppDeps): Promise<HealthCheck> {
  const base = { id: 'db' as const, title: 'База данных' }
  try {
    await d.db.execute(sql`select 1`)
    return { ...base, ok: true, detail: 'Работает', fix: null }
  } catch {
    return {
      ...base,
      ok: false,
      detail: 'Нет связи с базой',
      fix: 'Проверь, что запущен Docker и служба postgres.',
    }
  }
}

async function telegramCheck(d: AppDeps): Promise<HealthCheck> {
  const base = { id: 'telegram' as const, title: 'Telegram' }
  const token = await d.secrets.get('telegram_bot_token')
  if (!token)
    return {
      ...base,
      ok: false,
      detail: 'Бот не подключён',
      fix: 'Открой мастер запуска, шаг Telegram.',
    }
  const me = await getMe(token, d.telegramApiRoot)
  if (!me.ok) {
    return {
      ...base,
      ok: false,
      detail: 'Telegram не отвечает на токен бота',
      fix: 'Открой мастер запуска, шаг Telegram, и вставь токен заново.',
    }
  }
  const polling = d.bot.lastError()
  if (polling) return { ...base, ok: false, detail: 'Бот не получает сообщения', fix: polling }
  if (!(await d.bot.isBound())) {
    return {
      ...base,
      ok: false,
      detail: `Бот @${me.username} найден, чат не привязан`,
      fix: `Напиши боту @${me.username} команду /start.`,
    }
  }
  return { ...base, ok: true, detail: `Бот @${me.username} на связи`, fix: null }
}

async function claudeCheck(d: AppDeps): Promise<HealthCheck> {
  const base = { id: 'claude' as const, title: 'Claude' }
  if (!(await d.secrets.get('claude_oauth_token'))) {
    return {
      ...base,
      ok: false,
      detail: 'Claude не подключён',
      fix: 'Открой мастер запуска, шаг Claude.',
    }
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const [last] = await d.db
    .select()
    .from(modelCall)
    .where(and(eq(modelCall.role, 'probe'), gt(modelCall.startedAt, since)))
    .orderBy(desc(modelCall.startedAt))
    .limit(1)
  if (last?.ok)
    return { ...base, ok: true, detail: `Пробный вызов прошёл за ${last.durationMs} мс`, fix: null }
  return {
    ...base,
    ok: false,
    detail: last ? 'Последний пробный вызов не прошёл' : 'Пробного вызова за сутки не было',
    fix: 'Нажми «Проверить снова». Если не поможет, вставь новый токен в мастере, шаг Claude.',
  }
}

async function profiCheck(d: AppDeps): Promise<HealthCheck> {
  const base = { id: 'profi' as const, title: 'Профи.ру' }
  try {
    const acc = d.accounts?.[0]
    const h = await d.profi.sessionHealth(acc?.id ?? d.accountId ?? 'hance-marketing')
    if (h.alive && acc && h.egress_ip !== acc.egressIp) {
      return {
        ...base,
        ok: false,
        detail: `Вкладка выходит в сеть с чужого IP ${h.egress_ip ?? 'неизвестно'}`,
        fix: 'Аккаунт стоит. Напиши разработке: нужно проверить выход через SOCKS аккаунта.',
      }
    }
    if (h.alive && h.eyes_seeing === false) {
      return {
        ...base,
        ok: false,
        detail: 'Сессия жива, но глаза не видят: 10 минут ничего не узнано на сайте',
        fix: 'Похоже, Профи.ру поменял страницы. Напиши разработке.',
      }
    }
    if (h.alive) {
      const ip = acc ? `, IP ${h.egress_ip} свой` : ''
      const queue = h.queued_events === undefined ? '' : `, в очереди к ядру ${h.queued_events}`
      return { ...base, ok: true, detail: `Сессия жива${ip}${queue}`, fix: null }
    }
    return {
      ...base,
      ok: false,
      detail: 'Профи.ру разлогинил аккаунт',
      fix: 'Войди в аккаунт снова на экране «Аккаунты».',
    }
  } catch {
    return {
      ...base,
      ok: false,
      detail: 'Служба Профи-MCP не отвечает',
      fix: 'Проверь, что запущена служба Профи-MCP.',
    }
  }
}

export async function runHealthChecks(d: AppDeps): Promise<HealthCheck[]> {
  return Promise.all([dbCheck(d), telegramCheck(d), claudeCheck(d), profiCheck(d)])
}

export async function recheckClaude(d: AppDeps): Promise<void> {
  await d.gateway.call('probe', 'Проверка связи.', ProbeOutput)
}
