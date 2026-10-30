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

/**
 * When an order closed on Profi.ru, as far as Sara knows it (FR-LEAD-5): from its publication (or from the moment Sara
 * first saw it, when the board gave no time) to its closing. The closing is exact when the order left the feed, or a
 * look shortly before still found it open; otherwise it is only known to be «by» `at`.
 */
export type ClosedWhen = {
  since: string
  /** `since` is the publication; false: the moment Sara first saw the order. */
  published: boolean
  at: string
  exact: boolean
  /** The last moment the order was seen open; null: none known. */
  openUntil: string | null
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
  /** The screen could not tell core from background: «Уточнить в отклике: …» (docs/product/lead-analysis.md). */
  clarify?: string[]
  /**
   * The layout with a line that the order waits for a decision. Sara sends no card as a reminder any more; only the
   * length check of the «Разбор» message still builds it.
   */
  reminder?: boolean
  /**
   * The bid text with its greeting and the «Стоимость услуги» (FR-LEAD-6); none: the Analyst did not answer.
   * `followUps`: the series that follows the bid into the chat (Boris, 29.10.2026), approved by the same press.
   */
  draft?: {
    text: string
    priceRub: number | null
    note?: string | null
    followUps?: string[]
  } | null
  /**
   * The Analyst's short разбор for the card (what the client really needs, the main risk, the condition) and its
   * full reading for «Разбор» (null: a lead whose reading was stored without it).
   */
  analysis?: { hiddenNeed: string; risk: string; condition: string; reading: Reading | null } | null
  /** The order closed on Profi.ru: when, for the short closed card. */
  closed?: ClosedWhen | null
  /** The card waited more than a day (FR-LEAD-10): from its first message to now, for the short stale card. */
  stale?: { since: string; at: string } | null
}

const orders = (n: number) => `${n} ${plural(n, ['заявку', 'заявки', 'заявок'])}`

/** Why the node pressed nothing, by its error class, and what Boris can do (after «Отклик на «…» не ушёл: »). */
const REFUSED: Record<string, string> = {
  SESSION_DEAD:
    'Профи.ру разлогинил аккаунт. Ничего не нажала. Войди и нажми «Откликнуться» снова, карточка у тебя.',
  BANNED: 'Профи.ру заблокировал профиль. Ничего не нажала.',
  LAYOUT_CHANGED:
    'страница заказа на Профи.ру выглядит не так, как я умею читать. Ничего не нажала. Откликнись вручную на Профи.ру или подожди исправления, карточка у тебя.',
  NOT_FOUND:
    'служба Профи.ру не знает этот аккаунт или заказ. Ничего не нажала. Посмотри «Состояние системы».',
  ORDER_CLOSED: 'заявка уже закрыта на Профи.ру. Ничего не нажала, деньги не списаны.',
  NO_MONEY:
    'на кошельке Профи.ру не хватает денег. Ничего не нажала. Пополни кошелёк и нажми «Откликнуться» снова, карточка у тебя.',
  UNSAFE_PAYMENT:
    'Профи.ру просит оплату не с кошелька, а я плачу только с кошелька. Ничего не оплатила. Откликнись вручную, если заявка нужна.',
  PRICE_CHANGED: 'на Профи.ру он стоит дороже, чем на карточке. Ничего не нажала.',
  RATE_LIMITED:
    'вкладка аккаунта долго была занята: открыт живой экран, нет связи с Профи.ру или чужой IP. Ничего не нажала. Нажми «Откликнуться» снова, когда она освободится, карточка у тебя.',
  INTERNAL:
    'сбой у меня до нажатия, ничего не отправлено. Посмотри «Состояние системы» и нажми «Откликнуться» снова, карточка у тебя.',
}

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
  lostRoute: 'Эта заявка досталась другому направлению',
  bidSent: (title: string, spentRub: number) =>
    `✅ Отклик отправлен: ${title}, ${formatRub(spentRub)}`,
  bidRefused: (title: string, errorClass: string) =>
    `Отклик на «${title}» не ушёл: ${REFUSED[errorClass] ?? REFUSED.INTERNAL}`,
  bidDearer: (title: string, wasRub: number, nowRub: number | null) =>
    nowRub !== null
      ? `Отклик на «${title}» не ушёл: на Профи.ру он теперь стоит ${formatRub(nowRub)}, а на карточке было ${formatRub(wasRub)}. Ничего не нажала. Карточка снова у тебя с новой ценой, нажми ещё раз, если она подходит.`
      : `Отклик на «${title}» не ушёл: Профи.ру просит за него больше, чем ${formatRub(wasRub)} на карточке, а новой цены на странице заказа не видно. Ничего не нажала. Посмотри заявку на Профи.ру и откликнись вручную, если она нужна.`,
  bidAlreadyThere: (title: string) =>
    `Отклик на «${title}» уже есть на Профи.ру, второй не отправляла. Деньги не списаны.`,
  bidFoundLater: (title: string, rub: number, seriesLate = false) =>
    `✅ Проверила: отклик на «${title}» есть на Профи.ру, ${formatRub(rub)}${seriesLate ? '. Сообщения вдогонку не отправляла: с нажатия прошло больше 15 минут, они бы читались как напоминание' : ''}`,
  bidStale: (title: string) =>
    `Отклик на «${title}» не ушёл: я перезапускалась, а с нажатия прошло больше часа. Ничего не нажала, карточка снова у тебя.`,
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
  noted: (text: string, title?: string | null) =>
    title ? `Записала по «${title}»: «${text}»` : `Записала: «${text}»`,
  whichQuestion: (waiting: string[]) =>
    `Не поняла, к какому моему вопросу это. Сейчас жду:\n${waiting.map((w) => `- ${w}`).join('\n')}\nНажми «Ответить» на нужном моём сообщении и пришли текст ещё раз.`,
  waitingFor: {
    edit_draft: (title: string | null) =>
      title ? `новый текст отклика на «${title}»` : 'новый текст отклика',
    edit_price: (title: string | null) => (title ? `цену услуги для «${title}»` : 'цену услуги'),
    why_skip: (title: string | null) =>
      title ? `почему пропустил «${title}»` : 'почему пропустил',
    why_want: (title: string | null) => (title ? `почему взял бы «${title}»` : 'почему взял бы'),
    why_decline: (_title: string | null) => 'почему не надо поправку правил',
  },
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
    `Пришли новый текст отклика на «${title}» ответом на это сообщение, текстом или голосом. Приветствие я добавлю сама. Цену услуги можно прислать отдельной строкой, например «цена 5000».`,
  waitingDraft: 'Жду новый текст отклика',
  askPrice: (title: string) =>
    `Профи.ру не примет отклик на «${title}» без стоимости услуги. Пришли цену ответом на это сообщение, например «5000» или «цена 5000».`,
  waitingPrice: 'Жду цену услуги',
  feeChecking: 'Цену отклика ещё не знаю: открываю заявку, пришлю карточку с ценой',
  feeUnknown: (title: string) =>
    `Не смогла узнать цену отклика на «${title}», отклик не отправила. Откликнись вручную на Профи.ру, если заявка нужна.`,
  priceSaved: (title: string) => `Записала цену услуги для «${title}»`,
  draftAndPriceSaved: (title: string) => `Записала новый текст и цену услуги для «${title}»`,
  priceNotFound: 'Не нашла цену в ответе. Пришли её числом, например «5000» или «цена 5000».',
  noPrice: 'Без стоимости услуги Профи.ру отклик не примет. Пришли цену ответом на мой вопрос.',
  noDraft: 'Сначала нажми «Изменить» и пришли текст отклика',
  /** `evening`: the count is with the evening greeting, the longest of the day, and the one Boris sees now is shorter. */
  draftTooLong: (n: number, evening = false) =>
    `С ${evening ? 'вечерним ' : ''}приветствием выходит ${n} ${plural(n, ['знак', 'знака', 'знаков'])}, а Профи.ру принимает до 500. Пришли текст короче.`,
  /** On the card of an old draft that fills the whole 500 characters (made before the greeting followed the hour). */
  greetingNameDropped: 'Имя в приветствии не поместилось в 500 знаков, отклик уйдёт без имени',
  greetingKept:
    'Приветствие по времени суток не поместилось в 500 знаков, отклик уйдёт с прежним приветствием',
  draftSaved: (title: string) => `Записала новый текст отклика для «${title}»`,
  followUpsSaved: (title: string) => `Записала сообщения вдогонку для «${title}»`,
  followUpsTooLong: (max: number) =>
    `Сообщений вдогонку может быть не больше двух, каждое до ${max} знаков. Не сохранила.`,
  draftLate: 'Заявка уже решена, текст не поменяла',
  /** The card of an order closed on Profi.ru, in short (Boris, 30.10.2026): the buttons are gone. */
  closedCard: '🔒 Заявка закрыта',
  closedAfter: (span: string, published: boolean) =>
    `закрылась через ${span} ${published ? 'после публикации' : 'после того, как я её увидела'}`,
  closedBy: (clock: string, openFor: string | null) =>
    openFor ? `была открыта не меньше ${openFor}, закрыта к ${clock}` : `закрыта к ${clock}`,
  closedLink: 'Открыть на Профи.ру',
  /** A card that waited more than a day (FR-LEAD-10): no longer offered, the buttons are gone. */
  staleCard: '⌛ Заявка устарела',
  staleWaited: (span: string) => `ждала решения ${span}`,
  /** Many waiting cards look closed at once: more likely the site changed than that all of them closed. */
  recheckDoubt: (closed: number, checked: number) =>
    `Похоже, Профи.ру поменял страницу заказа: ${closed} из ${checked} проверенных заявок выглядят закрытыми. Карточки не трогаю, посмотри сам.`,
}

/** Telegram takes at most this many characters in one message, counted after tags and entities are parsed. */
export const MESSAGE_LIMIT = 4096

/**
 * What a card or a «Разбор» message may hold: a little under the limit, so the same message as plain text (the link
 * written out after its words) still fits when Telegram refuses the markup.
 */
const FIT = MESSAGE_LIMIT - 100
/** From this length the «Разбор» message carries the order text even when today's card is not cut: it may have been. */
const FULL_TEXT_ABOVE = 2500
/** The order text in «Разбор» stops here (a few messages); the link to the order is at the end. */
const FULL_TEXT_MAX = 16000

/** What the card keeps of each value from the site or the model, so the fixed part never fills a message. */
const CAP = {
  title: 200,
  short: 120,
  reason: 400,
  tag: 80,
  draft: 1000,
  followUp: 600,
  reading: 1500,
  line: 200,
  who: 90,
} as const

const NO_TEXT = 'Текста заявки нет.'
const NO_DRAFT =
  'Черновика нет: Аналитик не ответил. Нажми «Изменить» и пришли текст, а цену услуги отдельной строкой, например «цена 5000».'
// Calibration (#79): the field is required on every live answer, so a bid without it never goes (K2).
const NO_PRICE =
  'не указана. Без неё Профи.ру отклик не примет: пришли её через «Изменить» отдельной строкой, например «цена 5000».'
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

/** The same for sending: within the limit even so, the last line (the written-out link) kept. */
export function plainFallback(html: string): string {
  const plain = htmlToPlain(html)
  if (plain.length <= MESSAGE_LIMIT) return plain
  const at = plain.lastIndexOf('\n')
  const link = plain.slice(at + 1)
  return `${clip(plain.slice(0, Math.max(0, at)), MESSAGE_LIMIT - link.length - 2)}\n\n${link}`
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
  const budget = c.budgetText?.trim() ? clean(c.budgetText, CAP.short) : 'бюджет не указан'
  const fee =
    c.bidPriceRub > 0 ? `отклик ${formatRub(c.bidPriceRub)}` : 'цена отклика пока неизвестна'
  const facts = [c.score ? `🎯 <b>балл ${c.score.value}</b>` : null, `💰 ${budget}`, `🧾 ${fee}`]
  return [
    ...(c.reminder ? [`<b>⏰ ${title}</b>`, '<i>Заявка ждёт решения</i>'] : [`<b>🔔 ${title}</b>`]),
    ...(c.city.trim() ? [`📍 ${clean(c.city, CAP.short)}`] : []),
    facts.filter(Boolean).join('  ·  '),
  ]
}

/** «На Профи.ру с 7 сентября 2020» as the site writes it; a bare date gets the beginning. */
const sinceText = (s: string) =>
  /^на\s+профи\.ру/i.test(s) ? s : `на Профи.ру с ${s.replace(/^с\s+/i, '')}`

/** The client in one line (Boris, sample 3, 27.10.2026): name, since when, the phone, the reviews. */
function clientLines(c: LeadCard): string[] {
  const info = c.clientInfo ?? null
  // The order page's name is the fuller one; the list may give a first name or none.
  const name = info?.name?.trim() || c.clientName.trim()
  const parts = [`👤 <b>${name ? clean(name, CAP.short) : 'имя не указано'}</b>`]
  if (info) {
    const since = info.on_profi_since?.trim()
    if (since) parts.push(clean(sinceText(since).replace(/^На /, 'на '), CAP.short))
    if (info.phone_verified) parts.push('номер подтверждён')
    const tags = info.review_tags
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => `«${clean(t, CAP.tag)}»`)
    if (info.reviews && info.reviews.positive + info.reviews.negative === 0 && tags.length === 0)
      parts.push('отзывов пока нет')
    else if (info.reviews || tags.length > 0)
      parts.push(
        [
          info.reviews ? `отзывы +${info.reviews.positive} / −${info.reviews.negative}` : null,
          tags.length > 0 ? tags.join(', ') : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
  }
  return [parts.join(' · ')]
}

const orderLines = (shown: string) => [
  '<b>📄 Текст заявки</b>',
  `<blockquote expandable>${esc(shown)}</blockquote>`,
]

/** A line of the card is one thought: the first sentence, at most `max` characters, without the final period. */
const line = (s: string | null | undefined, max: number = CAP.line) => {
  const t = (s ?? '').trim()
  const first = t.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/)[0] ?? t
  return esc(clip(noPeriod(first), max))
}

/** The Scorer's reason as a plus and a minus: it often reads «Заказ подходит: … Минусы: …». */
function plusMinus(reason: string): { plus: string; minus: string | null } {
  const r = reason.trim().replace(/^(заказ\s+)?(подходит|возможно)\s*:\s*/i, '')
  const [plus = '', ...rest] = r.split(/\s*Минус(?:ы)?\s*:\s*/i)
  return { plus, minus: rest.length > 0 ? rest.join(' ') : null }
}

function whyBlocks(c: LeadCard): string[][] {
  const reason = c.score?.reason ?? c.reason ?? ''
  const pm = plusMinus(reason)
  // An old lead without a score keeps the Sorter's own words («Подходит: …», «Возможно: …»).
  const why = c.score
    ? [
        '<b>Почему подходит</b>',
        ...(pm.plus.trim() ? [`➕ ${line(pm.plus)}`] : []),
        ...(pm.minus?.trim() ? [`➖ ${line(pm.minus)}`] : []),
      ]
    : [verdictLine(c)]
  if (c.unscored) why.push('Без оценки: Оценщик не ответил')
  for (const l of c.clarify ?? []) why.push(`❓ ${esc(l)}`)
  const a = c.analysis
  if (!a) return [why]
  const who = a.reading?.who?.trim()
  const need = a.hiddenNeed.trim()
  const risk = a.risk.trim()
  const condition = a.condition.trim()
  // «Брать, если сроки понятны» already says it: the label takes «Брать, если», the line the rest.
  const takeIf = /^брать,?\s+если\s+/i.test(condition)
  const analysis = [
    who ? `<b>Кто клиент:</b> ${line(who, CAP.who)}` : null,
    need ? `<b>Хочет:</b> ${line(need)}` : null,
    risk ? `<b>Риск:</b> ${line(risk)}` : null,
    condition
      ? takeIf
        ? `<b>Брать, если:</b> ${line(condition.replace(/^брать,?\s+если\s+/i, ''))}`
        : `<b>Условие:</b> ${line(condition)}`
      : null,
  ].filter((x): x is string => x !== null)
  return analysis.length > 0 ? [why, analysis] : [why]
}

/**
 * The series under the bid (Boris, 29.10.2026): what goes into the chat a minute or two after it, each message as its
 * own quote. Nothing when the bid has none.
 */
function followUpLines(c: LeadCard): string[] {
  const series = c.draft?.followUps ?? []
  if (series.length === 0) return []
  return [
    '<b>✍️ Вдогонку</b>  ·  через 1-2 минуты после отклика',
    ...series.map((t) => `<blockquote>${clean(t, CAP.followUp)}</blockquote>`),
    '<i>Уйдёт тем же нажатием, если клиент ещё не ответил</i>',
  ]
}

function draftLines(c: LeadCard): string[] {
  if (!c.draft) return [NO_DRAFT]
  const price = c.draft.priceRub ? `  ·  услуга ${formatRub(c.draft.priceRub)}` : ''
  return [
    `<b>✍️ Отклик</b>${price}`,
    `<blockquote>${clean(c.draft.text, CAP.draft)}</blockquote>`,
    ...(c.draft.note ? [`<i>${c.draft.note}</i>`] : []),
    ...(c.draft.priceRub ? [] : [`Стоимость услуги: ${NO_PRICE}`]),
  ]
}

/**
 * `shown` is the part of the order text the card carries; `last` is a block after the link (the closed line).
 * Boris chose this layout from three samples on 27.10.2026: the main facts first, the order text last and folded.
 */
function cardHtml(c: LeadCard, shown: string): string {
  return [
    headLines(c),
    clientLines(c),
    ...whyBlocks(c),
    draftLines(c),
    ...(c.draft?.followUps?.length ? [followUpLines(c)] : []),
    orderLines(shown),
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
  if (telegramTextLength(html) <= FIT) return { html, textCut: false }
  let keep = text.length
  for (let i = 0; i < 10; i++) {
    keep = Math.max(0, keep - (telegramTextLength(html) - FIT) - 1)
    html = cardHtml(c, cutText(text, keep))
    if (telegramTextLength(html) <= FIT) break
  }
  return { html, textCut: true }
}

export const leadCardText = (c: LeadCard): string => renderLeadCard(c).html

/** A stretch of time in Boris's words: «40 мин», «2 ч 15 мин», «1 день 3 ч». */
export function spanText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`
  const days = `${Math.floor(h / 24)} ${plural(Math.floor(h / 24), ['день', 'дня', 'дней'])}`
  return h % 24 ? `${days} ${h % 24} ч` : days
}

const mskClock = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
  })

/** How long the order was open, as honestly as the journal knows it. */
function closedWhenText(w: ClosedWhen): string {
  const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a)
  if (w.exact) return TEXTS.closedAfter(spanText(ms(w.since, w.at)), w.published)
  const openFor =
    w.openUntil && w.published && ms(w.since, w.openUntil) >= 60_000
      ? spanText(ms(w.since, w.openUntil))
      : null
  return TEXTS.closedBy(mskClock(w.at), openFor)
}

/**
 * The card of an order closed on Profi.ru, in short (Boris, 30.10.2026): that it closed, the order's title, how long
 * it was open, and the link. The full card and its buttons are gone. A card that went stale (`stale`, FR-LEAD-10)
 * says so instead, with how long it waited.
 */
export function closedLeadCardText(c: LeadCard): string {
  const head = c.stale
    ? [
        `<b>${TEXTS.staleCard}</b>`,
        clean(c.title, CAP.title),
        TEXTS.staleWaited(spanText(Date.parse(c.stale.at) - Date.parse(c.stale.since))),
      ]
    : [`<b>${TEXTS.closedCard}</b>`, clean(c.title, CAP.title)]
  if (c.closed && !c.stale) head.push(closedWhenText(c.closed))
  return `${head.join(' · ')}\n<a href="${orderUrl(c.orderId)}">${TEXTS.closedLink}</a>`
}

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
    let avail = FIT - room.used() - telegramTextLength(heading)
    if (avail < 500) {
      room.flush()
      avail = FIT - telegramTextLength(heading)
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
      if (cur && telegramTextLength(next) > FIT) {
        messages.push(cur)
        cur = block
      } else cur = next
    },
  }
  room.add(`<b>Разбор: ${clean(c.title, CAP.title)}</b>`)
  const reading = c.analysis?.reading ?? null
  const text = c.text.trim() || NO_TEXT
  if (reading) {
    for (const [key, label] of READING_PARTS) {
      const value = reading[key].trim()
      if (value) room.add(`<b>${label}</b>\n${clean(value, CAP.reading)}`)
    }
    const condition = c.analysis?.condition.trim()
    if (condition) room.add(`<b>Условие</b>\n${clean(condition, CAP.reading)}`)
  } else if (c.analysis) {
    // Only the short lines were kept: they are the whole reading there is.
    const parts = [
      ['Чего хочет на самом деле', c.analysis.hiddenNeed],
      ['Риски', c.analysis.risk],
      ['Условие', c.analysis.condition],
    ] as const
    for (const [label, value] of parts) {
      if (value.trim()) room.add(`<b>${label}</b>\n${clean(value, CAP.reading)}`)
    }
  } else {
    room.add(NO_READING)
  }
  if (!reading || text.length > FULL_TEXT_ABOVE || renderLeadCard(c).textCut)
    addOrderText(text.length > FULL_TEXT_MAX ? cutText(text, FULL_TEXT_MAX) : text, room)
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
