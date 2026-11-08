import { isThinking } from './clientCues'

/**
 * The situation of a client who went quiet after our message (FR-CONV-12, spec 2026-11-07-organic-pings), read by the
 * code from the chat and the meeting card: which scenario it is, the words it stands on and when the first ping may
 * go. Pure: plain patterns over the words, nothing is asked of a model. The Pinger later chooses only inside it.
 */

export type PingKind =
  | 'messenger'
  | 'after_meeting'
  | 'our_promise'
  | 'named_date'
  | 'awaiting'
  | 'thinking'
  | 'since_bid'
  | 'mid'

/** What we wait for from the client. */
export type AwaitedItem = 'tz' | 'materials' | 'budget' | 'call_time'

export type PingScenario = {
  kind: PingKind
  /** The words of the chat the scenario stands on (the client's or ours), cut to a line. */
  quote: string | null
  /** What we wait for from the client, when the chat says it. */
  item: AwaitedItem | null
  /** A Moscow day `YYYY-MM-DD`: the day the client named, or the day of the meeting's next step. */
  day: string | null
  /** The meeting card's next step after a call that was held. */
  nextStep: string | null
}

/** A message of the chat as the scenario needs it, in the chat's order. */
export type ChatLine = { id: string; side: string; text: string; at: string }

/** The last meeting of the conversation that was held, from the meeting card (`core.meeting`). */
export type HeldMeeting = { nextStep: string | null; nextStepOn: string | null }

export const SCENARIO_RU: Record<PingKind, string> = {
  messenger: 'клиент ушел в мессенджер',
  after_meeting: 'созвон был, после него клиент молчит',
  our_promise: 'мы обещали клиенту, он ждет нас',
  named_date: 'клиент сам назвал день, когда вернется',
  awaiting: 'ждем от клиента конкретное',
  thinking: 'клиент взял время подумать',
  since_bid: 'клиент молчит с отклика, ни разу не писал',
  mid: 'клиент замолчал посреди разговора',
}

export const ITEM_RU: Record<AwaitedItem, string> = {
  tz: 'ТЗ или бриф',
  materials: 'материалы',
  budget: 'бюджет',
  call_time: 'время созвона',
}

const DAY_MS = 24 * 3600_000
const HOUR_MS = 3600_000
/** The Moscow hour a ping after a named day goes at, the morning after it. */
const MORNING = 10
const QUOTE_MAX = 160

/**
 * The waits of each scenario in days: the first from our last message, the next two from the ping before. At least a
 * day after our message and two days between pings (Boris, 06.11.2026). A stranger since the bid is pressed less often
 * than a client who talked to us; a client who has something to prepare, or to think over, gets two days.
 */
export const PING_WAITS: Record<
  Exclude<PingKind, 'messenger'>,
  { first: number; second: number; third: number }
> = {
  since_bid: { first: 1, second: 3, third: 4 },
  mid: { first: 1, second: 2, third: 3 },
  thinking: { first: 2, second: 2, third: 3 },
  awaiting: { first: 2, second: 2, third: 3 },
  named_date: { first: 1, second: 2, third: 3 },
  after_meeting: { first: 2, second: 2, third: 3 },
  // No ping to the client: Boris hears a day after our message.
  our_promise: { first: 1, second: 2, third: 3 },
}

/** Lower case with ё as е. */
const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е')

const cut = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1).trimEnd()}…` : t
}

/** The sentences of a text, each as written and folded. */
function sentences(text: string): { raw: string; low: string }[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, low: fold(raw) }))
}

// ---- Moscow days ------------------------------------------------------------------------------------------------

/** The Moscow day of a moment, `YYYY-MM-DD` (Moscow is UTC+3 all year). */
export function moscowDay(at: Date): string {
  return new Date(at.getTime() + 3 * HOUR_MS).toISOString().slice(0, 10)
}

const dayUtc = (day: string) => Date.parse(`${day}T00:00:00Z`)
const plusDays = (day: string, n: number) =>
  new Date(dayUtc(day) + n * DAY_MS).toISOString().slice(0, 10)
/** 0 Sunday … 6 Saturday. */
const weekday = (day: string) => new Date(dayUtc(day)).getUTCDay()
/** The next day after `day` that falls on `wd` (a week later when `day` is one). */
const nextWeekday = (day: string, wd: number) => plusDays(day, ((wd - weekday(day) + 6) % 7) + 1)

/** 10:00 Moscow of the day after `day`. */
export function morningAfter(day: string): Date {
  return new Date(dayUtc(day) + DAY_MS + (MORNING - 3) * HOUR_MS)
}

const validDay = (day: string | null | undefined) =>
  day && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(dayUtc(day)) ? day : null

// ---- A day the client named -------------------------------------------------------------------------------------

/** The client's own next move in a sentence: a day in it is when he will come back, not a deadline of the work. */
const CLIENT_ACTION =
  /(?<!\p{L})(?:напишу|напишем|отпишусь|отпишемся|отвечу|ответим|свяжусь|свяжемся|вернусь|вернемся|сообщу|сообщим|дам знать|дадим знать|скажу|скажем|решу|решим|определюсь|определимся|посмотрю|посмотрим|пришлю|пришлем|скину|скинем|отправлю|отправим|подготовлю|подготовим|созвонимся|обсудим|подумаю|подумаем|согласую|согласуем|выйду на связь|появлюсь)(?!\p{L})/u

const WEEKDAYS: [RegExp, number][] = [
  [/понедельник/u, 1],
  [/вторник/u, 2],
  [/сред[уыае]/u, 3],
  [/четверг/u, 4],
  [/пятниц[уыае]/u, 5],
  [/суббот[уыае]/u, 6],
  [/воскресень/u, 0],
]
const WEEKDAY_AT =
  /(?<!\p{L})(?:в|во|к|ко|до|на)\s+(?:следующ\p{L}*\s+)?(понедельник\p{L}*|вторник\p{L}*|сред[уыае]|четверг\p{L}*|пятниц[уыае]|суббот[уыае]|воскресень[еяю])(?!\p{L})/u
const MONTHS = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма[йя]',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
]
const DAY_MONTH = new RegExp(`(?<!\\d)(\\d{1,2})(?:-?го)?\\s+(${MONTHS.join('|')})\\p{L}*`, 'u')
const DOTTED = /(?<![\d.,])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d.,]*\d)/u
const OF_MONTH =
  /(?<!\p{L})(?:после|до|к|ко)\s+(\d{1,2})(?:-?(?:го|му)(?:\s+чис\p{L}*)?|\s+чис\p{L}*)/u
const IN_SPAN =
  /(?<!\p{L})через\s+(\d{1,2}|день|два|две|три|пару|несколько|неделю|месяц)(?:\s+(дн\p{L}*|день|недел\p{L}*|месяц\p{L}*))?/u

const SPAN_WORDS: Record<string, number> = { два: 2, две: 2, три: 3, пару: 2, несколько: 3 }

/** A date of `month` (1-12) and `dayOf`, the next one on or after `from` (this year or the next). */
function dateFrom(from: string, month: number, dayOf: number, year?: number): string | null {
  if (month < 1 || month > 12 || dayOf < 1 || dayOf > 31) return null
  const y0 = year ?? Number(from.slice(0, 4))
  const make = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, dayOf))
    return d.getUTCDate() === dayOf ? d.toISOString().slice(0, 10) : null
  }
  const d = make(y0)
  if (!d) return null
  return year !== undefined || d >= from ? d : make(y0 + 1)
}

/** The day a sentence names, counted from the Moscow day `base` the client wrote on; null when it names none. */
function dayIn(low: string, base: string): string | null {
  if (/(?<!\p{L})послезавтра(?!\p{L})/u.test(low)) return plusDays(base, 2)
  if (/(?<!\p{L})завтра(?!\p{L})/u.test(low)) return plusDays(base, 1)
  if (/(?<!\p{L})сегодня(?!\p{L})/u.test(low)) return base
  const wd = WEEKDAY_AT.exec(low)
  if (wd) {
    const n = WEEKDAYS.find(([re]) => re.test(wd[1] ?? ''))?.[1]
    if (n !== undefined) return nextWeekday(base, n)
  }
  if (/(?<!\p{L})на\s+выходных(?!\p{L})/u.test(low)) return nextWeekday(base, 0)
  // «В конце недели»: the coming Friday (said on a Friday or at the weekend, the next one).
  if (/(?<!\p{L})в\s+конце\s+(?:этой\s+)?недели(?!\p{L})/u.test(low)) return nextWeekday(base, 5)
  if (/(?<!\p{L})в\s+начале\s+(?:следующей\s+)?недели(?!\p{L})/u.test(low))
    return nextWeekday(base, 1)
  // «На следующей неделе»: the middle of it, so the ping comes on its Thursday.
  if (/(?<!\p{L})(?:на\s+следующей\s+неделе|на\s+неделе\s+следующей)(?!\p{L})/u.test(low))
    return plusDays(nextWeekday(base, 1), 2)
  if (/(?<!\p{L})на\s+этой\s+неделе(?!\p{L})/u.test(low))
    return weekday(base) >= 1 && weekday(base) <= 4 ? nextWeekday(base, 5) : base
  const span = IN_SPAN.exec(low)
  if (span) {
    const [, n = '', unit = ''] = span
    const count = /^\d+$/.test(n) ? Number(n) : (SPAN_WORDS[n] ?? 1)
    if (n === 'неделю') return plusDays(base, 7)
    if (n === 'месяц') return plusDays(base, 30)
    if (unit.startsWith('недел')) return plusDays(base, count * 7)
    if (unit.startsWith('месяц')) return plusDays(base, count * 30)
    return plusDays(base, count)
  }
  const dm = DAY_MONTH.exec(low)
  if (dm) {
    const month = MONTHS.findIndex((m) => new RegExp(`^${m}`, 'u').test(dm[2] ?? '')) + 1
    return dateFrom(base, month, Number(dm[1]))
  }
  const dotted = DOTTED.exec(low)
  if (dotted) {
    const y = dotted[3] ? Number(dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3]) : undefined
    return dateFrom(base, Number(dotted[2]), Number(dotted[1]), y)
  }
  const of = OF_MONTH.exec(low)
  if (of) {
    const n = Number(of[1])
    const [y, m] = base.split('-').map(Number) as [number, number]
    const thisMonth = dateFrom(`${y}-${String(m).padStart(2, '0')}-01`, m, n, y)
    if (thisMonth && thisMonth > base) return thisMonth
    return m === 12 ? dateFrom(`${y + 1}-01-01`, 1, n, y + 1) : dateFrom(base, m + 1, n, y)
  }
  return null
}

/**
 * The day the client named for his own next move («напишу в понедельник», «через неделю пришлю ТЗ», «отпишусь после
 * 15-го»), counted from when he wrote it; the last such sentence wins. A date of the work itself («сайт нужен к 15
 * декабря») is not one: the sentence must say what the client will do.
 */
export function namedDay(text: string, at: Date): { day: string; quote: string } | null {
  const base = moscowDay(at)
  let found: { day: string; quote: string } | null = null
  for (const s of sentences(text)) {
    if (!CLIENT_ACTION.test(s.low)) continue
    const day = dayIn(s.low, base)
    if (day) found = { day, quote: cut(s.raw) }
  }
  return found
}

// ---- What we wait for, what we promised ---------------------------------------------------------------------------

const ITEMS: [AwaitedItem, RegExp][] = [
  ['tz', /(?<!\p{L})(?:тз|техзадани\p{L}*|техническ\p{L}*\s+задани\p{L}*|бриф\p{L}*)(?!\p{L})/u],
  [
    'materials',
    /(?<!\p{L})(?:материал\p{L}*|фото\p{L}*|файл\p{L}*|доступ(?:ы|а|ов|ом)?|презентаци\p{L}*|макет\p{L}*|документ\p{L}*|логотип\p{L}*|прайс\p{L}*|исходник\p{L}*|выгрузк\p{L}*)(?!\p{L})/u,
  ],
  ['budget', /(?<!\p{L})бюджет\p{L}*/u],
]
const CALL_TIME =
  /(?<!\p{L})(?:когда|во\s+сколько|в\s+какое\s+время|какое\s+время|в\s+какой\s+день|какой\s+день)(?!\p{L})[^.?!\n]{0,40}(?:созвон|звонк|позвон|удобн)/u

/** Our sentence asks the client for something. */
const REQUEST =
  /\?|(?<!\p{L})(?:пришлите|пришлете|скиньте|скинете|отправьте|отправите|поделитесь|направьте|подскажите|уточните|напишите|можете|сможете|получится|подготовьте|дайте|расскажите)(?!\p{L})/u
/** The client's sentence promises to send or find out something. */
const CLIENT_SENDS =
  /(?<!\p{L})(?:пришлю|пришлем|скину|скинем|отправлю|отправим|подготовлю|подготовим|уточню|уточним|соберу|соберем|сброшу|направлю|согласую|согласуем)(?!\p{L})/u
/** Our side promises to do something itself. */
const OUR_PROMISE =
  /(?<!\p{L})(?:пришлю|отправлю|подготовлю|изучу|посмотрю|проанализирую|разберу|соберу|набросаю|сделаю|рассчитаю|посчитаю|продумаю|подберу|составлю|оценю|скину|распишу|покажу|вернусь\s+с|напишу\s+(?:вам\s+)?(?:план|предложени\p{L}*|кп|смет\p{L}*|стратеги\p{L}*|иде\p{L}*))(?!\p{L})/u

function itemOf(low: string): AwaitedItem | null {
  if (CALL_TIME.test(low)) return 'call_time'
  return ITEMS.find(([, re]) => re.test(low))?.[0] ?? null
}

/**
 * What we wait for from the client: what our message asked of him (the ТЗ, materials, the budget, a time for the call)
 * or what he said he would send. Our request comes first.
 */
export function awaitedItem(
  ours: string,
  client: string,
): { item: AwaitedItem; quote: string } | null {
  for (const s of sentences(ours)) {
    const item = itemOf(s.low)
    if (item && (item === 'call_time' || REQUEST.test(s.low))) return { item, quote: cut(s.raw) }
  }
  for (const s of sentences(client)) {
    const item = CLIENT_SENDS.test(s.low) ? itemOf(s.low) : null
    if (item) return { item, quote: cut(s.raw) }
  }
  return null
}

/**
 * Our message promises something of ours (a mockup, «изучу бизнес», «подготовлю предложение») and asks the client for
 * nothing: the next move is ours, so the reminder is Boris's, not the client's.
 */
export function ourPromise(ours: string): string | null {
  const all = sentences(ours)
  if (all.some((s) => REQUEST.test(s.low))) return null
  return all.find((s) => OUR_PROMISE.test(s.low))?.raw ?? null
}

// ---- Moved to a messenger -----------------------------------------------------------------------------------------

const MESSENGER =
  /(?<![\p{L}/])(?:телеграм\p{L}*|телег\p{L}+|тг|tg|telegram|ватсап\p{L}*|вотсап\p{L}*|вацап\p{L}*|whatsapp|t\.me|wa\.me)(?![\p{L}])/u
const CALL_WORDS = /(?<!\p{L})(?:со)?звон\p{L}*|(?<!\p{L})встреч\p{L}*/u
const HANDLE = /(?<![\w@])@[a-z0-9_]{4,32}(?![\w])/u
const REFUSE_MESSENGER =
  /(?<!\p{L})(?:нет\s+(?:телеграм\p{L}*|тг|ватсап\p{L}*|вотсап\p{L}*)|не\s+(?:пользу\p{L}*|удобн\p{L}*|сиж\p{L}*|хочу|буду|могу)|без\s+(?:телеграм\p{L}*|мессенджер\p{L}*)|лучше\s+(?:здесь|тут))(?!\p{L})/u
const AGREE =
  /^(?:да|давайте|давай|ок|окей|ok|хорошо|отлично|договорились|удобно|можно|конечно|супер|принято|норм\p{L}*|добавил\p{L}*|написал\p{L}*)(?!\p{L})/u
const WROTE_THERE =
  /(?<!\p{L})(?:написал\p{L}*|добавил\p{L}*|постучал\p{L}*|стучусь|пишу)\s+(?:вам\s+|вас\s+)?(?:в|туда)(?!\p{L})/u
const INVITE =
  /(?<!\p{L})(?:пишите|напишите|давайте|удобнее|лучше|добавьте|свяжитесь|мой|мне\s+в|мне\s+на|переходим|перейдем)(?!\p{L})/u

/**
 * The client went over to Telegram or WhatsApp: after our offer («можем в тг @bmnoian») his next words agree or say he
 * wrote there, or he himself asked to talk in a messenger. Then nothing more is written to him on Profi.ru. Null when
 * the chat says no such thing; otherwise the client's words.
 */
export function movedToMessenger(lines: ChatLine[], handle: string | null): string | null {
  const own = handle ? fold(handle.trim()) : ''
  const offers = (low: string) => MESSENGER.test(low) || (own !== '' && low.includes(own))
  for (let k = 0; k < lines.length; k++) {
    const m = lines[k]
    if (!m) continue
    const low = fold(m.text)
    if (m.side === 'client') {
      if (offers(low) && INVITE.test(low) && !REFUSE_MESSENGER.test(low)) return cut(m.text)
      continue
    }
    if (m.side !== 'specialist' || !offers(low)) continue
    const turn: ChatLine[] = []
    for (let j = k + 1; j < lines.length; j++) {
      const n = lines[j]
      if (!n || n.side === 'system') continue
      if (n.side !== 'client') break
      turn.push(n)
    }
    if (turn.length === 0) continue
    const words = turn.map((t) => t.text).join('\n')
    const said = fold(words)
    if (REFUSE_MESSENGER.test(said)) continue
    const mentions = MESSENGER.test(said) || HANDLE.test(said) || WROTE_THERE.test(said)
    const yes = AGREE.test(said.trim()) && said.length <= 60 && !CALL_WORDS.test(low)
    if (mentions || yes) return cut(words)
  }
  return null
}

// ---- The scenario -----------------------------------------------------------------------------------------------

/** The client's messages right before our message `anchorId`, joined, and when the last of them came. */
function turnBefore(lines: ChatLine[], anchorId: string): { text: string; at: string } | null {
  const at = lines.findIndex((m) => m.id === anchorId)
  const turn: ChatLine[] = []
  for (let k = at - 1; at >= 0 && k >= 0; k--) {
    const m = lines[k]
    if (!m || m.side === 'system') continue
    if (m.side !== 'client') break
    turn.unshift(m)
  }
  const last = turn.at(-1)
  return last ? { text: turn.map((m) => m.text).join('\n'), at: last.at } : null
}

/**
 * The scenario of the silence after our message `anchorId`, the first that fits from the top: the client went to a
 * messenger, a call was held, we promised something, the client named a day, we wait for something concrete, he went
 * to think it over, he never wrote since the bid, or he went quiet mid-conversation.
 */
export function pingScenario(i: {
  lines: ChatLine[]
  anchorId: string
  meeting: HeldMeeting | null
  /** Boris's Telegram as the bids give it (`series.telegram`). */
  handle: string | null
}): PingScenario {
  const none = { quote: null, item: null, day: null, nextStep: null }
  const moved = movedToMessenger(i.lines, i.handle)
  if (moved) return { ...none, kind: 'messenger', quote: moved }
  if (i.meeting)
    return {
      ...none,
      kind: 'after_meeting',
      day: validDay(i.meeting.nextStepOn),
      nextStep: i.meeting.nextStep?.trim() || null,
    }
  const at = i.lines.findIndex((m) => m.id === i.anchorId)
  const ours = i.lines[at]?.text ?? ''
  const before = at < 0 ? [] : i.lines.slice(0, at)
  const turn = turnBefore(i.lines, i.anchorId)
  const waited = awaitedItem(ours, turn?.text ?? '')
  if (!before.some((m) => m.side === 'client'))
    return { ...none, kind: 'since_bid', item: waited?.item ?? null }
  const promise = ourPromise(ours)
  if (promise) return { ...none, kind: 'our_promise', quote: cut(promise) }
  const named = turn ? namedDay(turn.text, new Date(turn.at)) : null
  if (named)
    return {
      ...none,
      kind: 'named_date',
      quote: named.quote,
      day: named.day,
      item: waited?.item ?? null,
    }
  if (waited) return { ...none, kind: 'awaiting', quote: waited.quote, item: waited.item }
  if (turn && isThinking(turn.text)) return { ...none, kind: 'thinking', quote: cut(turn.text) }
  return { ...none, kind: 'mid' }
}

/**
 * The waits of a scenario in milliseconds, and the first moment its first ping may come: the morning after a day the
 * client named or after the next step of a call. The floor of a day after our message stays the caller's.
 */
export function pingWaits(sc: PingScenario): {
  first: number
  second: number
  third: number
  notBefore: Date | null
} {
  const w = sc.kind === 'messenger' ? PING_WAITS.mid : PING_WAITS[sc.kind]
  const dated = (sc.kind === 'named_date' || sc.kind === 'after_meeting') && sc.day
  return {
    first: (sc.kind === 'after_meeting' && sc.day ? 1 : w.first) * DAY_MS,
    second: w.second * DAY_MS,
    third: w.third * DAY_MS,
    notBefore: dated && sc.day ? morningAfter(sc.day) : null,
  }
}

const dayMonth = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`

/** Why a ping comes now, in the code's words, for the card when the model gave none. */
export function scenarioWhy(sc: PingScenario, read: boolean): string {
  const seen = read ? 'Сообщение прочитано, ответа нет' : 'Наше сообщение еще не прочитано'
  switch (sc.kind) {
    case 'after_meeting':
      return sc.nextStep
        ? `После созвона шаг: ${sc.nextStep}${sc.day ? ` (до ${dayMonth(sc.day)})` : ''}, клиент молчит`
        : 'Созвон был, после него клиент молчит'
    case 'named_date':
      return `Клиент обещал вернуться к ${sc.day ? dayMonth(sc.day) : 'этому дню'}, этот день прошел`
    case 'awaiting':
      return `Ждем от клиента ${sc.item ? ITEM_RU[sc.item] : 'ответ'}. ${seen}`
    case 'thinking':
      return `Клиент взял время подумать. ${seen}`
    case 'since_bid':
      return `Клиент молчит с отклика. ${seen}`
    case 'our_promise':
      return 'Мы обещали клиенту, он ждет нас'
    case 'messenger':
      return 'Клиент ушел в мессенджер'
    default:
      return `Клиент замолчал посреди разговора. ${seen}`
  }
}
