import { plural, type Weekday } from '@sara/shared'
import { addDays, msk } from './time'

/** How times read to Boris and to clients: «в четверг, 29 октября, в 15:00», «завтра в 11:00» (design 5.2, 5.4). */

const ON_WEEKDAY: Record<Weekday, string> = {
  mon: 'в понедельник',
  tue: 'во вторник',
  wed: 'в среду',
  thu: 'в четверг',
  fri: 'в пятницу',
  sat: 'в субботу',
  sun: 'в воскресенье',
}
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
]

export function slotLabel(startsAt: string, now: Date): string {
  const s = msk(startsAt)
  const today = msk(now).date
  if (s.date === today) return `сегодня в ${s.hhmm}`
  if (s.date === addDays(today, 1)) return `завтра в ${s.hhmm}`
  const [, mo, d] = s.date.split('-').map(Number) as [number, number, number]
  return `${ON_WEEKDAY[s.weekday]}, ${d} ${MONTHS[mo - 1]}, в ${s.hhmm}`
}

/** Hours from UTC of the larger Russian cities (no daylight saving since 2014); unknown: null. */
const CITY_UTC: Record<string, number> = {
  калининград: 2,
  москва: 3,
  'санкт-петербург': 3,
  петербург: 3,
  краснодар: 3,
  сочи: 3,
  'ростов-на-дону': 3,
  воронеж: 3,
  волгоград: 3,
  казань: 3,
  'нижний новгород': 3,
  ярославль: 3,
  тула: 3,
  рязань: 3,
  липецк: 3,
  ставрополь: 3,
  махачкала: 3,
  симферополь: 3,
  севастополь: 3,
  белгород: 3,
  курск: 3,
  тверь: 3,
  самара: 4,
  саратов: 4,
  ульяновск: 4,
  ижевск: 4,
  астрахань: 4,
  тольятти: 4,
  екатеринбург: 5,
  челябинск: 5,
  пермь: 5,
  уфа: 5,
  тюмень: 5,
  оренбург: 5,
  сургут: 5,
  омск: 6,
  новосибирск: 7,
  барнаул: 7,
  томск: 7,
  кемерово: 7,
  новокузнецк: 7,
  красноярск: 7,
  иркутск: 8,
  'улан-удэ': 8,
  чита: 9,
  якутск: 9,
  владивосток: 10,
  хабаровск: 10,
  магадан: 11,
  'петропавловск-камчатский': 12,
}
const MOSCOW = 3

export function cityOffset(city: string | null): number | null {
  if (!city) return null
  return CITY_UTC[city.trim().toLowerCase().replace(/ё/g, 'е')] ?? null
}

/** After one time: «по Москве, у вас 19:00», or «время московское» when the client lives on Moscow time or we do not know. */
export function zoneNote(startsAt: string, city: string | null): string {
  const off = cityOffset(city)
  if (off === null || off === MOSCOW) return 'время московское'
  return `по Москве, у вас ${msk(new Date(Date.parse(startsAt) + (off - MOSCOW) * 3_600_000)).hhmm}`
}

/** After several times: «время московское, у вас на 4 часа больше». */
export function zoneNoteList(city: string | null): string {
  const off = cityOffset(city)
  if (off === null || off === MOSCOW) return 'время московское'
  const diff = Math.abs(off - MOSCOW)
  return `время московское, у вас на ${diff} ${plural(diff, ['час', 'часа', 'часов'])} ${off > MOSCOW ? 'больше' : 'меньше'}`
}

export function joinOptions(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} или ${labels.at(-1)}`
}
