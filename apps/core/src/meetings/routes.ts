import { Availability } from '@sara/shared'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { getSetting, setSetting } from '../settings/store'
import { slotLabel } from './labels'
import { busyFrom, pickOffer } from './slots'

const BAD_WINDOWS = 'Проверь окна: начало раньше конца, окна дня не пересекаются.'
const BAD_NUMBERS =
  'Проверь числа: созвон 15-120 минут, зазор 0-60 минут, встреч в день 1-10, не раньше чем через 0-72 часа, вперёд 1-21 день.'
const BAD_DAYS = 'Проверь особые дни: каждая дата один раз, не больше 60 дней.'

/** The plain reason for the first thing wrong in the free time Boris sent. */
function reasonOf(issues: { path: PropertyKey[] }[]): string {
  const path = issues[0]?.path ?? []
  if (path[0] === 'week' || path.includes('windows')) return BAD_WINDOWS
  if (path[0] === 'exceptions') return BAD_DAYS
  return BAD_NUMBERS
}

/** Boris's free time and the next three times Sara would offer from it (FR-MEET-1, design 5.1). */
async function view(d: AppDeps) {
  const availability = await getSetting(d.db, 'meet.availability')
  const now = new Date()
  const { busy, dayCount } = await busyFrom(d.db, now, { softHolds: true })
  const preview = pickOffer(availability, busy, dayCount, now).map((startsAt) => ({
    startsAt,
    label: slotLabel(startsAt, now),
  }))
  return { availability, preview }
}

export function registerMeetingRoutes(app: FastifyInstance, d: AppDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)

    scoped.get('/api/meetings/availability', () => view(d))

    scoped.post('/api/meetings/availability', async (req, reply) => {
      const parsed = Availability.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: reasonOf(parsed.error.issues) })
      await setSetting(d.db, 'meet.availability', parsed.data, 'boris')
      return view(d)
    })
  })
}
