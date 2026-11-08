import { leadKind } from '@sara/shared'

/**
 * Why Boris closed a card, from a short list (Boris, 05.11.2026: «если я закрыл заявку, то чтобы это становилось какой
 * то осмысленной информацией»; he does not want to write it). Sara guesses one from what the card already knew; Boris
 * may correct it with one press, never must (docs/superpowers/specs/2026-11-07-learn-from-closes.md).
 */
export const REASON_CODES = [
  'profile',
  'site',
  'budget',
  'client',
  'vague',
  'compete',
  'fee',
  'border',
  'other',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]
/** `detail` makes «не наш профиль» concrete («SMM ведение»), or holds Boris's own words for «другое». */
export type Reason = { code: ReasonCode; detail: string | null }

export const REASON_TITLES: Record<ReasonCode, string> = {
  profile: 'не наш профиль',
  site: 'сайт, а не маркетинг',
  budget: 'маленький бюджет',
  client: 'слабый клиент',
  vague: 'задача неясная',
  compete: 'много конкурентов',
  fee: 'дорогой отклик',
  border: 'балл у самого порога',
  other: 'другое',
}

/** The buttons under a folded card; «балл у порога» is Sara's own word, Boris does not think in it. */
export const REASON_BUTTONS = {
  profile: 'Не наш профиль',
  site: 'Сайт',
  budget: 'Бюджет',
  client: 'Клиент',
  vague: 'Неясно',
  compete: 'Конкуренты',
  fee: 'Дорогой отклик',
  other: 'Другое',
} as const
export type ButtonCode = keyof typeof REASON_BUTTONS

/** The press of a reason button: `why` and the code, one word for the callback data (`t:<task>:whybudget`). */
export const reasonAction = (code: ButtonCode) => `why${code}` as const
export type ReasonAction = ReturnType<typeof reasonAction>
export const REASON_ACTIONS = Object.keys(REASON_BUTTONS).map((c) =>
  reasonAction(c as ButtonCode),
) as ReasonAction[]
export function codeOfAction(action: string): ButtonCode | null {
  const code = action.startsWith('why') ? action.slice(3) : ''
  return code in REASON_BUTTONS ? (code as ButtonCode) : null
}

export const isReasonCode = (s: unknown): s is ReasonCode =>
  typeof s === 'string' && (REASON_CODES as readonly string[]).includes(s)

/** The reason as the card and the proposer read it: «не наш профиль: SMM ведение»; Boris's own words as they are. */
export function reasonText(r: Reason): string {
  if (r.code === 'other' && r.detail) return r.detail
  return r.detail ? `${REASON_TITLES[r.code]}: ${r.detail}` : REASON_TITLES[r.code]
}

/** What the card knew when Boris decided. The title and category feed only the guess, never the journal. */
export type GuessInput = {
  title: string
  category: string
  budgetText: string | null
  feeRub: number | null
  score: number | null
  /** The threshold of the order's kind under the rules it was scored by; null: unknown. */
  threshold: number | null
  stopFactor: string | null
  redFlags: string[]
  axes: { id: string; score: number }[]
  /** Profi.ru's own lines about the client («Договаривается в 20% случаев»). */
  clientLines: string[]
}

/** A budget at or under this many roubles is small for Hance. */
export const SMALL_BUDGET_RUB = 15_000
/** A fee from this much is felt, on a card that was only just over the threshold. */
const DEAR_FEE_RUB = 900
/** A client who agrees in this share of his orders or less is a weak one. */
const LOW_DEAL_RATE = 30
/** An axis this low (of 100) can be the reason on its own. */
const WEAK_AXIS = 45

const SMM =
  /smm|смм|соцсет|социальн\w* сет|инстаграм|instagram|вконтакт|\bвк\b|телеграм-?канал|ведени\w* (групп|аккаунт|страниц|канал)|контент-?план|рилс|reels|сторис|stories/i
const ADS = /директ|таргет|контекстн|авито|настройк\w* реклам|рекламн\w* кампани|рекламщик/i
const MARKETPLACE = /маркетплейс|wildberries|вайлдберриз|\bwb\b|ozon|озон|карточк\w* товар/i
const DESIGN = /дизайн|логотип|баннер|визитк|фирменн\w* стил|инфографик/i
const STRATEGY = /стратег/i

const STOPS: Record<string, Reason> = {
  direct: { code: 'profile', detail: 'настройка рекламы' },
  narrow_tool: { code: 'profile', detail: 'узкая работа в одном инструменте' },
  vacancy: { code: 'profile', detail: 'вакансия в штат' },
  one_off_tech: { code: 'profile', detail: 'разовая техническая задача' },
  percent: { code: 'budget', detail: 'работа за процент' },
}
const FLAGS: Record<string, Reason & { weight: number }> = {
  zero_budget: { code: 'budget', detail: 'бюджет 0', weight: 70 },
  cheap: { code: 'budget', detail: 'ищут самого дешевого', weight: 70 },
  no_product: { code: 'client', detail: 'не понимает свой продукт', weight: 60 },
  chaotic: { code: 'vague', detail: null, weight: 65 },
  self_employed: { code: 'client', detail: 'самозанятый', weight: 45 },
}
const AXES: Record<string, Reason> = {
  client: { code: 'client', detail: null },
  system: { code: 'profile', detail: 'разовая задача' },
  budget: { code: 'budget', detail: null },
  competition: { code: 'compete', detail: null },
  ltv: { code: 'budget', detail: 'маленький чек' },
}

const rub = (n: number) => `${new Intl.NumberFormat('ru-RU').format(n).replace(/\s/g, ' ')} ₽`

/** The highest sum in the budget line («от 30 000 до 50 000 ₽» is 50000, «до 15 тыс.» is 15000); null: none. */
export function budgetMaxRub(text: string | null | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase().replace(/[  ]/g, ' ')
  let max: number | null = null
  // «к» counts only right after the number («15к»), so «10 000 ₽ к оплате» stays ten thousand.
  for (const m of t.matchAll(/(\d[\d ]*(?:[.,]\d+)?)(?:\s*(тыс|млн)|(к)(?![а-я]))?/g)) {
    const n = Number((m[1] ?? '').replace(/ /g, '').replace(',', '.'))
    if (!Number.isFinite(n)) continue
    const v = m[2] === 'млн' ? n * 1_000_000 : m[2] || m[3] ? n * 1000 : n
    if (max === null || v > max) max = v
  }
  return max
}

type Candidate = Reason & { weight: number }

/**
 * Every reason the card points to, the strongest first, one per code (its strongest detail). The stop factor speaks
 * loudest, then the words of the order's own title and category, its kind, the red flags, a weak axis, the money.
 */
export function rankReasons(f: GuessInput): Candidate[] {
  const out: Candidate[] = []
  const add = (r: Reason, weight: number) => out.push({ ...r, weight })
  const what = `${f.category} ${f.title}`
  const kind = leadKind(f.category)

  if (f.stopFactor) add(STOPS[f.stopFactor] ?? { code: 'profile', detail: null }, 100)
  if (SMM.test(what) && !(kind === 'marketing' && STRATEGY.test(what)))
    add({ code: 'profile', detail: 'SMM ведение' }, kind === 'marketing' ? 55 : 80)
  if (ADS.test(what) && kind !== 'marketing')
    add({ code: 'profile', detail: 'настройка рекламы' }, 75)
  if (MARKETPLACE.test(what)) add({ code: 'profile', detail: 'маркетплейс' }, 75)
  if (DESIGN.test(what) && kind !== 'marketing') add({ code: 'profile', detail: 'дизайн' }, 60)
  if (kind === 'sites') add({ code: 'site', detail: null }, 70)
  if (kind === 'other') add({ code: 'profile', detail: f.category.trim().slice(0, 40) || null }, 50)

  for (const id of f.redFlags) {
    const r = FLAGS[id]
    if (r) add({ code: r.code, detail: r.detail }, r.weight)
  }
  const budget = budgetMaxRub(f.budgetText)
  if (budget !== null && budget > 0 && budget <= SMALL_BUDGET_RUB)
    add({ code: 'budget', detail: `до ${rub(budget)}` }, 60)
  for (const line of f.clientLines) {
    const m = /договаривается\D{0,12}(\d{1,3})\s*%/i.exec(line)
    const rate = m ? Number(m[1]) : null
    if (rate !== null && rate <= LOW_DEAL_RATE)
      add({ code: 'client', detail: `договаривается в ${rate}%` }, 55)
  }
  const weakest = [...f.axes].sort((a, b) => a.score - b.score)[0]
  if (weakest && weakest.score <= WEAK_AXIS) {
    const r = AXES[weakest.id]
    if (r) add(r, 40)
  }
  const near = f.score !== null && f.threshold !== null ? f.score - f.threshold : null
  if (f.feeRub !== null && f.feeRub >= DEAR_FEE_RUB && near !== null && near < 10)
    add({ code: 'fee', detail: rub(f.feeRub) }, 50)
  if (near !== null && near >= 0 && near < 5) add({ code: 'border', detail: null }, 35)

  const best = new Map<ReasonCode, Candidate>()
  for (const c of out) {
    const was = best.get(c.code)
    if (!was || c.weight > was.weight || (c.weight === was.weight && !was.detail && c.detail))
      best.set(c.code, c)
  }
  return [...best.values()].sort(
    (a, b) => b.weight - a.weight || REASON_CODES.indexOf(a.code) - REASON_CODES.indexOf(b.code),
  )
}

/** Sara's guess: the strongest reason the card points to; null when it points to none. */
export function guessReason(f: GuessInput): Reason | null {
  const top = rankReasons(f)[0]
  return top ? { code: top.code, detail: top.detail } : null
}

/** The order the buttons fall back to when the card points to fewer reasons. */
const BUTTON_ORDER: ButtonCode[] = [
  'profile',
  'site',
  'budget',
  'client',
  'vague',
  'compete',
  'fee',
]

/**
 * The three reasons under a folded card besides the current one: the likeliest first, then the usual ones, and
 * «Другое» last, always.
 */
export function reasonButtons(ranked: Candidate[], current: ReasonCode | null): ButtonCode[] {
  const pick: ButtonCode[] = []
  for (const c of [...ranked.map((r) => r.code), ...BUTTON_ORDER]) {
    if (pick.length === 3) break
    if (c === current || c === 'other' || !(c in REASON_BUTTONS)) continue
    if (!pick.includes(c as ButtonCode)) pick.push(c as ButtonCode)
  }
  return [...pick, 'other']
}

/** The detail a pressed code takes: the ranking's own for that code («SMM ведение»), else none. */
export function detailFor(ranked: Candidate[], code: ReasonCode): string | null {
  return ranked.find((r) => r.code === code)?.detail ?? null
}

const WORDS: [RegExp, Reason][] = [
  [/smm|смм|соцсет|ведени\w* (групп|аккаунт|страниц)/i, { code: 'profile', detail: 'SMM ведение' }],
  [/сайт|лендинг/i, { code: 'site', detail: null }],
  [/отклик\w* дорог|дорог\w* отклик/i, { code: 'fee', detail: null }],
  [/бюджет|дешев|дёшев|копейк|мало (плат|денег)|денег нет/i, { code: 'budget', detail: null }],
  [/непонят|неясн|мутн|размыт/i, { code: 'vague', detail: null }],
  [/конкурент|много откликов|поздно/i, { code: 'compete', detail: null }],
  [/самозан|клиент/i, { code: 'client', detail: null }],
  [/профил|не наш|не наше|не мы|не берём|не берем|не делаем/i, { code: 'profile', detail: null }],
]

/** Boris's own words with a close (the pult) as a reason from the list; words that name none are «другое» as said. */
export function reasonFromWords(text: string): Reason {
  const t = text.trim()
  for (const [re, r] of WORDS) if (re.test(t)) return r
  return { code: 'other', detail: t.slice(0, 80) || null }
}
