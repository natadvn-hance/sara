import { MODEL_UNITS } from '@sara/shared'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { ModelName } from './types'

const STATE_WORDS: Record<string, string> = {
  new: 'без вывода',
  ready: 'ждут пачки',
  asked: 'спрошены',
  yes: 'да',
  no: 'нет',
  skip: 'не важно',
  dropped: 'отброшены',
}

/**
 * pnpm report:school (M5 design 5.12): what the school spent and did in the last days, so the budget numbers can be
 * set after the first week. Only numbers and ids, never a client's words.
 */
export async function schoolReport(db: Db, days: number): Promise<string> {
  const since = sql`now() - make_interval(days => ${days})`
  const out: string[] = [`Школа Сары за ${days} дн.`]

  const units = await db.execute<{ day: string; role: string; model: string; n: number }>(sql`
    select to_char(started_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day, role, model, count(*)::int as n
    from core.model_call
    where priority = 'P3' and started_at > ${since}
    group by 1, 2, 3 order by 1, 2`)
  out.push(
    '',
    'Единицы вызовов P3 по дням: ночная школа и фоновые прогоны (haiku 1, sonnet 4, opus 20):',
  )
  if (units.rows.length === 0) out.push('  пока нет')
  const byDay = new Map<string, Map<string, number>>()
  for (const r of units.rows) {
    const roles = byDay.get(r.day) ?? new Map<string, number>()
    roles.set(r.role, (roles.get(r.role) ?? 0) + (MODEL_UNITS[r.model as ModelName] ?? 0) * r.n)
    byDay.set(r.day, roles)
  }
  for (const [day, roles] of byDay) {
    const total = [...roles.values()].reduce((a, b) => a + b, 0)
    const parts = [...roles].map(([role, u]) => `${role}: ${u}`).join(', ')
    out.push(`  ${day}: ${total} (${parts})`)
  }

  const skips = await db.execute<{ day: string; job: string; reason: string }>(sql`
    select to_char(occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day,
      payload->>'job' as job, payload->>'reason' as reason
    from core.event where type = 'school.night_skipped' and occurred_at > ${since}
    order by occurred_at`)
  out.push('', 'Пропуски ночных задач:')
  if (skips.rows.length === 0) out.push('  нет')
  for (const s of skips.rows) out.push(`  ${s.day} ${s.job}: ${s.reason}`)

  const lessons = await db.execute<{ source: string; state: string; n: number }>(sql`
    select source, state, count(*)::int as n from core.lesson
    where created_at > ${since} group by 1, 2 order by 1, 2`)
  out.push('', 'Уроки:')
  if (lessons.rows.length === 0) out.push('  пока нет')
  const bySource = new Map<string, string[]>()
  for (const l of lessons.rows)
    bySource.set(l.source, [
      ...(bySource.get(l.source) ?? []),
      `${STATE_WORDS[l.state] ?? l.state} ${l.n}`,
    ])
  for (const [source, parts] of bySource) out.push(`  ${source}: ${parts.join(', ')}`)

  const trainings = await db.execute<{ mode: string; n: number; sim: number | null }>(sql`
    select mode, count(*)::int as n, round(avg(avg_similarity))::int as sim from core.training_session
    where finished_at is not null and started_at > ${since} group by 1 order by 1`)
  out.push(
    '',
    trainings.rows.length === 0
      ? 'Тренировки: пока нет'
      : `Тренировки: ${trainings.rows.map((t) => `${t.mode} ${t.n}${t.sim === null ? '' : `, сходство ${t.sim}%`}`).join('; ')}`,
  )

  const commits = await db.execute<{ kind: string; n: number }>(sql`
    select kind, count(*)::int as n
    from core.mind_commit where created_at > ${since} group by 1 order by 1`)
  const pushed = await db.execute<{ last_push: string | null }>(sql`
    select to_char(max(pushed_at) at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') as last_push
    from core.mind_commit`)
  out.push(
    commits.rows.length === 0
      ? 'Коммиты разума: пока нет'
      : `Коммиты разума: ${commits.rows.map((c) => `${c.kind} ${c.n}`).join(', ')}; последний в GitHub: ${pushed.rows[0]?.last_push ?? 'не отправлялись'}`,
  )

  const exams = await db.execute<{ kind: string; n: number; score: number | null }>(sql`
    select kind, count(*)::int as n,
      (array_agg(score order by started_at desc))[1] as score
    from core.exam_run where started_at > ${since} group by 1 order by 1`)
  out.push(
    exams.rows.length === 0
      ? 'Экзамены: пока нет'
      : `Экзамены: ${exams.rows.map((e) => `${e.kind} ${e.n}${e.score === null ? '' : `, последний ${e.score.toFixed(2)}`}`).join('; ')}`,
  )

  const autonomy = await db.execute<{ topic: string; streak: number }>(sql`
    select topic, streak from core.autonomy_counter order by topic`)
  out.push(
    autonomy.rows.length === 0
      ? 'Самостоятельность: счётчиков пока нет'
      : `Серии одобрений: ${autonomy.rows.map((a) => `${a.topic} ${a.streak}`).join(', ')}`,
  )
  return out.join('\n')
}
