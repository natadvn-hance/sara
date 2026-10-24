import { type ClientInfo, formatCallback, formatRub, plural } from '@sara/shared'

/** The Analyst's full reading of an order (the lead's draft_analysis). */
export type Reading = {
  said: string
  layers: string
  wants: string
  who: string
  risks: string
  job: string
}

export type LeadCard = {
  taskId: string
  /** Profi.ru's order number: the link to the order is built from it. */
  orderId: string
  title: string
  city: string
  /** The client's budget as the site writes it; null when the order has none. */
  budgetText: string | null
  /** The name from the order list; the order page may know a better one (clientInfo.name). */
  clientName: string
  /** The whole order text; the card shortens it only to fit one Telegram message. */
  text: string
  /** What the order page says about the client; none (an older lead, a page without it): the name alone. */
  clientInfo?: ClientInfo | null
  verdict: 'fit' | 'maybe' | null
  reason: string | null
  /** The fee for the bid; 0 when the site did not show it yet. */
  bidPriceRub: number
  /** The Scorer's total by the rules of `version` (FR-LEAD-3); none when the order was not scored. */
  score?: { value: number; version: number; reason: string } | null
  /** The Scorer did not answer: the card comes anyway, marked. */
  unscored?: boolean
  /** The same card again as a reminder, with the buttons, so Boris can act on it. */
  reminder?: boolean
  /** The bid text with its greeting and the «Стоимость услуги» (FR-LEAD-6); none: the Analyst did not answer. */
  draft?: { text: string; priceRub: number | null } | null
  /**
   * The Analyst's short разбор for the card (what the client really needs, the main risk, the condition) and its
   * full reading for «Разбор» (null: a lead whose reading was stored without it).
   */
  analysis?: { hiddenNeed: string; risk: string; condition: string; reading: Reading | null } | null
}

const orders = (n: number) => `${n} ${plural(n, ['заявку', 'заявки', 'заявок'])}`

/** Every text Sara sends Boris in Telegram (Russian, plain, no long dash). */
export const TEXTS = {
  bound: 'Сара на связи',
  alreadyDone: 'Уже сделано',
  skipped: 'Пропущено',
  bidQueued: 'Отправляю отклик',
  bidsPaused: 'Отклик не ушёл: отправка откликов на паузе',
  bidFailed: 'Отклик не ушёл: площадка ответила ошибкой. Посмотри «Состояние системы».',
  bidUncertain:
    'Не знаю, ушёл ли отклик: площадка не ответила. Проверь заявку на Профи.ру, прежде чем откликаться вручную.',
  bidsPausedPress: 'Отправка откликов на паузе. Включи её и нажми снова.',
  bidSent: (title: string, priceRub: number) =>
    `✅ Отклик отправлен: ${title}, ${formatRub(priceRub)}`,
  sessionDead: (title: string, loginUrl: string) =>
    `🔴 Профи.ру разлогинил аккаунт ${title}. Пока ты не войдёшь, я ничего не вижу на этом аккаунте.\nВойти: ${loginUrl}`,
  banned: (title: string) =>
    `🚫 Профи.ру заблокировал профиль ${title}. Действия аккаунта остановлены.`,
  sessionAlive: (title: string) =>
    `🟢 Сессия ${title} снова живая. Сверяю, что пришло за время простоя.`,
  connectionLost: (sinceMsk: string) =>
    `🌐 Нет связи с Профи.ру с ${sinceMsk}. Пробую раз в 5 минут.`,
  connectionBack: '🌐 Связь с Профи.ру вернулась. Сверяю, что пришло.',
  reminder: (title: string) => `⏰ Заявка ждёт решения: ${title}`,
  whySkip: (title: string) => `Почему пропустил «${title}»? Напиши или скажи голосом.`,
  whyWant: (title: string) => `Почему взял бы «${title}»? Напиши или скажи голосом.`,
  whyDecline: 'Почему не надо эту поправку? Напиши или скажи голосом.',
  noted: (text: string) => `Записала: «${text}»`,
  notAnAnswer: 'Пока я понимаю только ответы на мои вопросы',
  voiceFailed: 'Не смогла разобрать голосовое, напиши текстом, пожалуйста',
  summaryHead: (n: number) => `Сегодня отсеяла ${orders(n)}. На грани:`,
  summaryNone: (n: number) => `Сегодня отсеяла ${orders(n)}, пограничных не было`,
  wantButton: (n: number) => `Взял бы №${n}`,
  wantCard: 'Пишу черновик, пришлю карточку',
  cardSent: 'Прислала карточку заявки',
  analysisButton: 'Разбор',
  analysisSent: 'Прислала разбор',
  analysisFailed: 'Не получилось прислать разбор, нажми кнопку ещё раз',
  noTask: 'Не нашла такую заявку',
  proposal: (
    from: number,
    summary: string,
    why: string,
    changes: string[],
    b: { checked: number; changed: number; towardBoris: number; against: number },
  ) =>
    [
      `Предлагаю поправку правил (v${from} → v${from + 1}): ${summary}`,
      `Почему: ${why}`,
      `Что меняется: ${changes.join('; ')}`,
      `На последних ${b.checked} ${plural(b.checked, ['заявке', 'заявках', 'заявках'])} это изменило бы ${b.changed} ${plural(b.changed, ['решение', 'решения', 'решений'])}: ${b.towardBoris} в твою сторону, ${b.against} против.`,
    ].join('\n'),
  applyButton: 'Применить',
  dropButton: 'Не надо',
  applied: (v: number) => `Применила, теперь правила v${v}`,
  kept: (v: number) => `Хорошо, оставляю v${v}`,
  proposalStale: 'Правила уже поменялись, предложение устарело',
  editButton: 'Изменить',
  askDraft: (title: string) =>
    `Пришли новый текст отклика на «${title}» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама.`,
  waitingDraft: 'Жду новый текст отклика',
  noDraft: 'Сначала нажми «Изменить» и пришли текст отклика',
  draftTooLong: (n: number) =>
    `С приветствием выходит ${n} ${plural(n, ['знак', 'знака', 'знаков'])}, а Профи.ру принимает до 500. Пришли текст короче.`,
  draftSaved: 'Записала новый текст отклика',
  draftLate: 'Заявка уже решена, текст не поменяла',
}

/** Telegram takes at most this many characters in one message, counted after tags and entities are parsed. */
export const MESSAGE_LIMIT = 4096

/** What the card keeps of each value from the site or the model, so the fixed part never fills a message. */
const CAP = {
  title: 200,
  short: 120,
  reason: 400,
  tag: 80,
  draft: 1000,
  reading: 1500,
} as const

const NO_TEXT = 'Текста заявки нет.'
const NO_DRAFT = 'Черновика нет: Аналитик не ответил. Нажми «Изменить» и пришли текст.'
const NO_READING = 'Разбора для этой заявки нет: Аналитик не ответил или заявка пришла раньше.'
const TEXT_HEADING = '<b>Полный текст заявки</b>'
const ENTITY = /&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/gi

/** Every value from the site or the model goes into the HTML through this: <, > and & become entities. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The text Telegram counts against its limit: without tags, an entity as one character (UTF-16 units). */
export function telegramTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(ENTITY, '.').length
}

/** The message without markup, for the case Telegram refuses it: tags gone, entities decoded, links written out. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2: $1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/** `s` cut to at most `max` characters with «…», never in the middle of an emoji. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${sliceWhole(s, max - 1).trimEnd()}…`
}

/** The first `n` UTF-16 units of `s` without a half of a surrogate pair at the end. */
function sliceWhole(s: string, n: number): string {
  const cut = s.slice(0, Math.max(0, n))
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

const clean = (s: string | null | undefined, max: number) => esc(clip((s ?? '').trim(), max))
const noPeriod = (s: string) => s.replace(/[.\s]+$/, '')

const orderUrl = (orderId: string) =>
  `https://profi.ru/backoffice/n.php?o=${encodeURIComponent(orderId)}`
const linkLine = (orderId: string) =>
  `<a href="${orderUrl(orderId)}">Открыть заявку на Профи.ру</a>`

function verdictLine(c: LeadCard): string {
  if (c.verdict === 'fit') return `Подходит: ${clean(c.reason, CAP.reason)}`
  if (c.verdict === 'maybe') return `Возможно: ${clean(c.reason, CAP.reason)}`
  return 'Сортировщик не ответил, проверь сам'
}

function headLines(c: LeadCard): string[] {
  const title = clean(c.title, CAP.title)
  const budget = c.budgetText?.trim()
    ? `бюджет ${clean(c.budgetText, CAP.short)}`
    : 'бюджет не указан'
  const fee =
    c.bidPriceRub > 0 ? `отклик ${formatRub(c.bidPriceRub)}` : 'цена отклика пока неизвестна'
  const facts = [c.city.trim() ? clean(c.city, CAP.short) : null, budget, fee].filter(Boolean)
  return [
    ...(c.reminder ? [`<b>⏰ ${title}</b>`, '<i>Заявка ждёт решения</i>'] : [`<b>🔔 ${title}</b>`]),
    facts.join(' · '),
  ]
}

/** «На Профи.ру с 7 сентября 2020» as the site writes it; a bare date gets the beginning. */
const sinceText = (s: string) => (/^на\s+профи\.ру/i.test(s) ? s : `На Профи.ру с ${s}`)

function clientLines(c: LeadCard): string[] {
  const info = c.clientInfo ?? null
  // The order page's name is the fuller one; the list may give a first name or none.
  const name = info?.name?.trim() || c.clientName.trim()
  const lines = [`<b>Клиент:</b> ${name ? clean(name, CAP.short) : 'имя не указано'}`]
  if (!info) return lines
  const since = info.on_profi_since?.trim()
  const facts = [
    since ? clean(sinceText(since), CAP.short) : null,
    info.phone_verified ? 'номер подтверждён' : null,
  ].filter(Boolean)
  if (facts.length > 0) lines.push(facts.join(' · '))
  const tags = info.review_tags
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => `«${clean(t, CAP.tag)}»`)
  const reviews = [
    info.reviews ? `+${info.reviews.positive} / −${info.reviews.negative}` : null,
    tags.length > 0 ? tags.join(', ') : null,
  ].filter(Boolean)
  if (reviews.length > 0) lines.push(`Отзывы: ${reviews.join(' · ')}`)
  return lines
}

const orderLines = (shown: string) => [
  '<b>Заявка</b>',
  `<blockquote expandable>${esc(shown)}</blockquote>`,
]

function whyLines(c: LeadCard): string[] {
  const why = c.score
    ? [
        `<b>Балл ${c.score.value}</b> (правила v${c.score.version}). ${clean(c.score.reason, CAP.reason)}`,
      ]
    : [verdictLine(c), ...(c.unscored ? ['Без оценки: Оценщик не ответил'] : [])]
  const a = c.analysis
  if (!a) return why
  return [
    ...why,
    `<b>Разбор:</b> ${clean(a.hiddenNeed, CAP.reason)}`,
    `<b>Риск:</b> ${esc(noPeriod(clip(a.risk.trim(), CAP.reason)))}. <b>Условие:</b> ${clean(a.condition, CAP.reason)}`,
  ]
}

function draftLines(c: LeadCard): string[] {
  if (!c.draft) return [NO_DRAFT]
  const price = c.draft.priceRub ? formatRub(c.draft.priceRub) : 'не указана'
  return [
    '<b>Черновик отклика</b>',
    `<blockquote>${clean(c.draft.text, CAP.draft)}</blockquote>`,
    `Стоимость услуги: ${price}`,
  ]
}

/** `shown` is the part of the order text the card carries. */
function cardHtml(c: LeadCard, shown: string): string {
  return [
    headLines(c),
    clientLines(c),
    orderLines(shown),
    whyLines(c),
    draftLines(c),
    [linkLine(c.orderId)],
  ]
    .map((block) => block.join('\n'))
    .join('\n\n')
}

/** The order text cut to `keep` characters: back to a word when one is near, then «…». */
function cutText(text: string, keep: number): string {
  const cut = sliceWhole(text, keep)
  const space = cut.search(/\s\S{0,80}$/)
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The lead card as Telegram HTML, within one message: when it is too long, the order text is shortened with «…»
 * (`textCut`) and «Разбор» brings it whole.
 */
export function renderLeadCard(c: LeadCard): { html: string; textCut: boolean } {
  const text = c.text.trim() || NO_TEXT
  let html = cardHtml(c, text)
  if (telegramTextLength(html) <= MESSAGE_LIMIT) return { html, textCut: false }
  let keep = text.length
  for (let i = 0; i < 10; i++) {
    keep = Math.max(0, keep - (telegramTextLength(html) - MESSAGE_LIMIT) - 1)
    html = cardHtml(c, cutText(text, keep))
    if (telegramTextLength(html) <= MESSAGE_LIMIT) break
  }
  return { html, textCut: true }
}

export const leadCardText = (c: LeadCard): string => renderLeadCard(c).html

const READING_PARTS = [
  ['said', 'Что говорит клиент'],
  ['layers', 'Что за этим стоит'],
  ['wants', 'Чего хочет на самом деле'],
  ['who', 'Кто это'],
  ['risks', 'Риски'],
  ['job', 'Какую задачу решает для клиента'],
] as const

/** The order text in expandable quotes after the heading, in as many pieces as the messages need. */
function addOrderText(text: string, room: { used(): number; flush(): void; add(b: string): void }) {
  let rest = text
  let first = true
  while (rest.length > 0) {
    const heading = first ? `${TEXT_HEADING}\n` : ''
    let avail = MESSAGE_LIMIT - room.used() - telegramTextLength(heading)
    if (avail < 500) {
      room.flush()
      avail = MESSAGE_LIMIT - telegramTextLength(heading)
    }
    let piece = rest
    if (rest.length > avail) {
      const cut = sliceWhole(rest, avail)
      const space = cut.search(/\s\S{0,200}$/)
      piece = space > 0 ? cut.slice(0, space) : cut
    }
    room.add(`${heading}<blockquote expandable>${esc(piece)}</blockquote>`)
    rest = rest.slice(piece.length).trimStart()
    first = false
  }
}

/**
 * «Разбор»: the Analyst's full reading laid out in its own message(s), and the whole order text when the card had to
 * cut it (or when there is no reading at all). Several messages only when the reading and the text do not fit one.
 */
export function analysisMessages(c: LeadCard): string[] {
  const messages: string[] = []
  let cur = ''
  const room = {
    used: () => (cur ? telegramTextLength(cur) + 2 : 0),
    flush() {
      if (cur) messages.push(cur)
      cur = ''
    },
    add(block: string) {
      const next = cur ? `${cur}\n\n${block}` : block
      if (cur && telegramTextLength(next) > MESSAGE_LIMIT) {
        messages.push(cur)
        cur = block
      } else cur = next
    },
  }
  room.add(`<b>Разбор: ${clean(c.title, CAP.title)}</b>`)
  const reading = c.analysis?.reading ?? null
  if (reading) {
    for (const [key, label] of READING_PARTS) {
      const value = reading[key].trim()
      if (value) room.add(`<b>${label}</b>\n${clean(value, CAP.reading)}`)
    }
    const condition = c.analysis?.condition.trim()
    if (condition) room.add(`<b>Условие</b>\n${clean(condition, CAP.reading)}`)
  } else {
    room.add(NO_READING)
  }
  if (!reading || renderLeadCard(c).textCut) addOrderText(c.text.trim() || NO_TEXT, room)
  room.add(linkLine(c.orderId))
  room.flush()
  return messages
}

export function leadCardKeyboard(c: LeadCard) {
  const fee = c.bidPriceRub > 0 ? ` за ${formatRub(c.bidPriceRub)}` : ''
  return {
    inline_keyboard: [
      [{ text: `Откликнуться${fee}`, callback_data: formatCallback(c.taskId, 'bid') }],
      [
        { text: TEXTS.analysisButton, callback_data: formatCallback(c.taskId, 'razbor') },
        { text: TEXTS.editButton, callback_data: formatCallback(c.taskId, 'edit') },
        { text: 'Пропустить', callback_data: formatCallback(c.taskId, 'skip') },
      ],
    ],
  }
}
