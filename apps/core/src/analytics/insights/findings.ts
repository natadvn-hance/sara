import { type Flow, type Gap, gap, type Level, levelOf } from './stats'

/**
 * One bid of Sara with what is known about it, the way the hypotheses read it (loaded in `load.ts`). A person's name
 * or text never gets here: only the features a hypothesis may name.
 */
export type BidFeature = {
  bidAt: string
  /** Minutes from the order seen by Sara to the bid; null when unknown. */
  delayMin: number | null
  priceRub: number | null
  score: number | null
  service: string
  /** Moscow hour of the bid, 0..23. */
  hour: number
  /** Short messages followed the bid into the chat (Boris's series). */
  series: boolean
  /** The client wrote back. */
  replied: boolean
  /** The client opened the bid (Profi.ru did not give the money back). */
  opened: boolean
  /** Boris's funnel stage reached at least «Переговоры»; null while the stages cannot be trusted. */
  negotiated: boolean | null
}

/** An order of the stream (all orders seen, not only the bid ones) and how late Sara noticed it. */
export type SeenFeature = { category: string; hour: number; lateMin: number | null }

export type Outcome = 'replied' | 'opened' | 'negotiated' | 'late'

export const OUTCOME_RU: Record<Outcome, string> = {
  replied: 'клиент ответил на отклик',
  opened: 'клиент открыл отклик',
  negotiated: 'дошли до переговоров',
  late: 'заявка замечена позже 5 минут после публикации',
}

type Dim = 'delay' | 'price' | 'score' | 'service' | 'daypart' | 'series' | 'category'

export const DIM_RU: Record<Dim, string> = {
  delay: 'скорость отклика',
  price: 'цена отклика',
  score: 'балл заявки',
  service: 'тип услуги',
  daypart: 'время суток',
  series: 'сообщения вдогонку',
  category: 'категория заявки',
}

/** What a hypothesis may say about why, and what to try; the model words it, the code only supplies the ground. */
export const DIM_HINT: Record<Dim, { mechanism: string; check: string }> = {
  delay: {
    mechanism:
      'клиент выбирает из первых откликов, а поздний уже читают среди готовых договорённостей',
    check: 'держать отклик на заявки этой группы быстрее и сравнить долю ответов через неделю',
  },
  price: {
    mechanism: 'цена в отклике задаёт ожидание клиента ещё до разговора',
    check: 'для заявок этой группы пробовать другую вилку цены и сравнить долю ответов',
  },
  score: {
    mechanism:
      'балл показывает, насколько заявка подходит агентству, и клиент это чувствует в отклике',
    check: 'пересмотреть порог балла для отклика и сравнить долю ответов',
  },
  service: {
    mechanism: 'на этот тип услуги отклик либо попадает в запрос клиента, либо нет',
    check: 'для этого типа услуги пересмотреть первую фразу или кейс в отклике',
  },
  daypart: {
    mechanism: 'клиент видит отклик в своё рабочее время и отвечает по нему сразу',
    check: 'сдвинуть отправку откликов этой группы на более удачное время и сравнить',
  },
  series: {
    mechanism: 'второе короткое сообщение либо возвращает внимание клиента, либо мешает ему',
    check: 'включить серию в половине откликов и через две недели сравнить доли ответов',
  },
  category: {
    mechanism:
      'в этой категории заявки чаще попадают к нам с опозданием из-за потока или времени публикации',
    check: 'проверить, как заявки этой категории попадают в ленту, и сократить задержку',
  },
}

export type Finding = {
  /** Same metric, same slice, same direction: a hypothesis is told once (never twice under one fingerprint). */
  fingerprint: string
  level: Level
  flow: Flow
  outcome: Outcome
  dim: Dim
  /** The slice that differs: «отклик за 5 минут и быстрее». */
  group: string
  gap: Gap
  /** Dates (YYYY-MM-DD, Moscow) of the first and the last case. */
  from: string
  to: string
  source: string
}

const MIN_GROUP = 8

const mskDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(iso))

function bandDelay(m: number): string {
  if (m <= 5) return 'отклик за 5 минут и быстрее'
  if (m <= 60) return 'отклик за 5-60 минут'
  if (m <= 360) return 'отклик за 1-6 часов'
  return 'отклик позже 6 часов'
}
function bandPrice(r: number): string {
  if (r < 5000) return 'цена отклика до 5 000 ₽'
  if (r <= 15000) return 'цена отклика 5 000-15 000 ₽'
  return 'цена отклика выше 15 000 ₽'
}
function bandHour(h: number): string {
  if (h < 9) return 'отклик ночью (до 9:00 по Москве)'
  if (h < 13) return 'отклик утром (9-13 по Москве)'
  if (h < 18) return 'отклик днём (13-18 по Москве)'
  return 'отклик вечером (после 18:00 по Москве)'
}

/** Tercile cuts of the scores seen: the scale is Sara's own and moves, so the bands follow the data. */
function scoreBands(rows: BidFeature[]): ((s: number) => string) | null {
  const s = rows
    .map((r) => r.score)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b)
  if (s.length < 3 * MIN_GROUP) return null
  const lo = s[Math.floor(s.length / 3)] ?? 0
  const hi = s[Math.floor((2 * s.length) / 3)] ?? 0
  if (lo === hi) return null
  return (x) =>
    x < lo
      ? `балл заявки ниже ${lo}`
      : x < hi
        ? `балл заявки ${lo}-${hi - 1}`
        : `балл заявки ${hi} и выше`
}

type Slicer<T> = { dim: Dim; label: (r: T) => string | null }

function bidSlicers(rows: BidFeature[]): Slicer<BidFeature>[] {
  const score = scoreBands(rows)
  return [
    { dim: 'delay', label: (r) => (r.delayMin === null ? null : bandDelay(r.delayMin)) },
    { dim: 'price', label: (r) => (r.priceRub === null ? null : bandPrice(r.priceRub)) },
    { dim: 'score', label: (r) => (score && r.score !== null ? score(r.score) : null) },
    { dim: 'service', label: (r) => (r.service ? `услуга «${r.service}»` : null) },
    { dim: 'daypart', label: (r) => bandHour(r.hour) },
    { dim: 'series', label: (r) => (r.series ? 'отклик с серией вдогонку' : 'отклик без серии') },
  ]
}

function compare<T>(
  rows: T[],
  slicer: Slicer<T>,
  hit: (r: T) => boolean | null,
  min: number,
): { group: string; gap: Gap }[] {
  const labelled = rows.flatMap((r) => {
    const l = slicer.label(r)
    const h = hit(r)
    return l === null || h === null ? [] : [{ l, h }]
  })
  const out: { group: string; gap: Gap }[] = []
  for (const g of new Set(labelled.map((x) => x.l))) {
    const inside = labelled.filter((x) => x.l === g)
    const rest = labelled.filter((x) => x.l !== g)
    if (inside.length < min || rest.length < min) continue
    out.push({
      group: g,
      gap: gap(
        { k: inside.filter((x) => x.h).length, n: inside.length },
        { k: rest.filter((x) => x.h).length, n: rest.length },
      ),
    })
  }
  return out
}

/** Every slice of the bids that passes a level, best first: conclusions, then early signals, bigger gaps first. */
export function bidFindings(rows: BidFeature[]): Finding[] {
  if (rows.length === 0) return []
  const days = rows.map((r) => r.bidAt).sort()
  const from = mskDay(days[0] ?? '')
  const to = mskDay(days[days.length - 1] ?? '')
  const outcomes: [Outcome, (r: BidFeature) => boolean | null][] = [
    ['replied', (r) => r.replied],
    ['opened', (r) => r.opened],
    ['negotiated', (r) => r.negotiated],
  ]
  const found: Finding[] = []
  for (const s of bidSlicers(rows))
    for (const [outcome, hit] of outcomes)
      for (const c of compare(rows, s, hit, MIN_GROUP)) {
        const level = levelOf(c.gap, 'bids')
        if (!level) continue
        found.push({
          fingerprint: fingerprintOf(outcome, s.dim, c.group, c.gap.diffPp),
          level,
          flow: 'bids',
          outcome,
          dim: s.dim,
          group: c.group,
          gap: c.gap,
          from,
          to,
          source: 'отклики Сары',
        })
      }
  return found
}

/** The stream of all orders seen: how often one was noticed late, by category and hour. Its own, stricter sizes. */
export function streamFindings(rows: SeenFeature[], from: string, to: string): Finding[] {
  const slicers: Slicer<SeenFeature>[] = [
    { dim: 'category', label: (r) => (r.category ? `категория «${r.category}»` : null) },
    { dim: 'daypart', label: (r) => bandHour(r.hour).replace('отклик', 'заявка опубликована') },
  ]
  const found: Finding[] = []
  for (const s of slicers)
    for (const c of compare(rows, s, (r) => (r.lateMin === null ? null : r.lateMin > 5), 50)) {
      const level = levelOf(c.gap, 'stream')
      if (!level) continue
      found.push({
        fingerprint: fingerprintOf('late', s.dim, c.group, c.gap.diffPp),
        level,
        flow: 'stream',
        outcome: 'late',
        dim: s.dim,
        group: c.group,
        gap: c.gap,
        from,
        to,
        source: 'все заявки, которые видела Сара',
      })
    }
  return found
}

export const fingerprintOf = (outcome: Outcome, dim: Dim, group: string, diff: number): string =>
  `${outcome}|${dim}|${group}|${diff >= 0 ? '+' : '-'}`

const weight = (f: Finding) =>
  (f.level === 'conclusion' ? 1000 : 0) +
  Math.abs(f.gap.diffPp) * Math.sqrt(Math.min(f.gap.a.n, f.gap.b.n))

/**
 * At most `max` hypotheses a day, one per kind of slice (never two about the time of day), none whose fingerprint the
 * caller already told or silenced. An early signal that grew into a conclusion may be told once more.
 */
export function pickFindings(
  all: Finding[],
  told: Map<string, { level: Level; silenced: boolean }>,
  max = 2,
): Finding[] {
  const out: Finding[] = []
  const dims = new Set<string>()
  for (const f of [...all].sort((a, b) => weight(b) - weight(a))) {
    const before = told.get(f.fingerprint)
    if (before && (before.silenced || before.level === f.level || f.level === 'early')) continue
    const key = `${f.flow}:${f.dim}`
    if (dims.has(key)) continue
    dims.add(key)
    out.push(f)
    if (out.length >= max) break
  }
  return out
}
