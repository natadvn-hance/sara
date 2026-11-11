import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { formatCallback, formatRub, isTestOrder, priceRange } from '@sara/shared'
import satori from 'satori'
import { isCallOffer, SLOTS_MARK } from '../leads/callSlots'
import { firstName } from '../leads/clientName'
import { isTelegramLine } from '../leads/telegramLine'
import type { CardStage, CardState, CardView } from './cardState'
import { type LeadCard, orderUrl, plusMinus, TEXTS } from './cards'

/**
 * The lead card as a picture in Hance's own look (Boris, 11.11.2026): the logo of hance.pro, Involve for words and
 * Martian Mono for labels and figures, after the voice app's screen («[01]» labels, squares of a score, a green pill) and the
 * proposal for ARTEQON IQ (a big orange title, a black panel of figures). One card from the title to the client's
 * words; the bid text is a view of the same picture, switched by its buttons; no Telegram text under it.
 */

const C = {
  bg: '#F3F2EF',
  ink: '#1A1A1A',
  ink2: '#55514D',
  muted: '#8B857F',
  line: '#DCD9D3',
  cell: '#E4E1DB',
  accent: '#FF3D00',
  accentMid: '#FF8A66',
  accentLight: '#FFC3AE',
  accentInk: '#C93000',
  green: '#005A52',
  lcd: '#191816',
  lcdLine: '#383633',
  lcdText: '#F3F2EF',
  white: '#FFFFFF',
} as const

const SANS = 'Involve'
const MONO = 'Martian Mono'
/** The width the card is laid out at, and the width of the picture Telegram gets (sharp on a phone). */
const W = 380
export const PICTURE_WIDTH = 1080
const PAD = 26
const INNER = W - 2 * PAD

const asset = (name: string) => readFileSync(new URL(`../../assets/${name}`, import.meta.url))

type Font = { name: string; data: Buffer; weight: 400 | 500 | 600; style: 'normal' }
let fonts: Font[] | null = null
/** The fonts, read once: Involve for words, Martian Mono for labels and figures. */
function loadFonts(): Font[] {
  fonts ??= [
    { name: SANS, data: asset('fonts/Involve-Regular.ttf'), weight: 400, style: 'normal' },
    { name: SANS, data: asset('fonts/Involve-SemiBold.ttf'), weight: 600, style: 'normal' },
    { name: MONO, data: asset('fonts/MartianMono-Regular.ttf'), weight: 400, style: 'normal' },
    { name: MONO, data: asset('fonts/MartianMono-Medium.ttf'), weight: 500, style: 'normal' },
  ]
  return fonts
}
let logo: string | null = null
const logoSrc = () => {
  logo ??= `data:image/svg+xml;base64,${asset('hance-logo.svg').toString('base64')}`
  return logo
}

type Style = Record<string, string | number>
type Node = { type: string; props: { style?: Style; children?: Child[] | string; src?: string } }
type Child = Node | string

/** A block laid out as a row or a column; empty children are left out. */
const box = (style: Style, ...children: (Child | null | false | undefined)[]): Node => ({
  type: 'div',
  props: {
    style: { display: 'flex', ...style },
    children: children.filter((c): c is Child => Boolean(c)),
  },
})
/** One run of text. */
const txt = (style: Style, s: string): Node => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children: s },
})
const mono = (size: number, color: string, s: string, more: Style = {}) =>
  txt(
    {
      fontFamily: MONO,
      fontSize: size,
      color,
      letterSpacing: size * 0.04,
      textTransform: 'uppercase',
      ...more,
    },
    s,
  )
const words = (size: number, color: string, s: string, more: Style = {}) =>
  txt({ fontFamily: SANS, fontSize: size, lineHeight: 1.4, color, ...more }, s)

const DASHES = /[\u2013\u2014]/g
/** `s` on one line, cut to `max` characters with «…»; no long dash reaches the picture. */
function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(DASHES, '-').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
/** A text cut to `max` characters with «…», its paragraphs kept and no long dash. */
function clipKeep(s: string, max: number): string {
  const t = s
    .replace(DASHES, '-')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}
/** The first sentence of a text, without the final period. */
function thought(s: string | null | undefined, max: number): string {
  const t = (s ?? '').trim()
  const first = t.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/)[0] ?? t
  return clip(first.replace(/[.\s]+$/, ''), max)
}

const LABEL: Record<CardStage, { text: string; tone: 'green' | 'accent' | 'ink' | 'quiet' }> = {
  new: { text: 'Новая заявка', tone: 'green' },
  sending: { text: 'Отправляю отклик', tone: 'accent' },
  sent: { text: 'Ждём ответа', tone: 'ink' },
  found: { text: 'Отклик на Профи', tone: 'ink' },
  unsure: { text: 'Не знаю, ушёл ли', tone: 'accent' },
  closed: { text: 'Закрыта на Профи', tone: 'quiet' },
  skipped: { text: 'Пропущена', tone: 'quiet' },
  stale: { text: 'Устарела', tone: 'quiet' },
  done: { text: 'Решено', tone: 'quiet' },
  note: { text: 'Статус', tone: 'quiet' },
}

/** The state as the voice app's pill: a filled capsule with a dot, never an outline. */
function pill(stage: CardStage): Node {
  const { text, tone } = LABEL[stage]
  const bg = { green: C.green, accent: C.accent, ink: C.ink, quiet: C.cell }[tone]
  const color = tone === 'quiet' ? C.ink2 : C.white
  return box(
    { alignItems: 'center', borderRadius: 999, padding: '7px 14px 7px 12px', backgroundColor: bg },
    box({
      width: 7,
      height: 7,
      borderRadius: 2,
      marginRight: 8,
      backgroundColor: tone === 'quiet' ? C.muted : tone === 'accent' ? C.white : C.accent,
    }),
    // Involve sits high in its line: a little padding on top puts its letters on the dot's axis.
    txt({ fontFamily: SANS, fontSize: 13.5, color, lineHeight: 1, paddingTop: 2.5 }, text),
  )
}

/** The logo of hance.pro on the left, the state's pill on the right. */
function topBar(stage: CardStage): Node {
  return box(
    { justifyContent: 'space-between', alignItems: 'center' },
    { type: 'img', props: { src: logoSrc(), style: { width: 118, height: 23 } } },
    pill(stage),
  )
}

/** «[01] НОВАЯ ЗАЯВКА»: the voice app's numbered label, its number in orange. */
function numbered(n: string, label: string, marginTop = 26): Node {
  return box(
    { alignItems: 'center', marginTop },
    mono(10, C.accent, `[${n}]`, { marginRight: 9 }),
    mono(10, C.ink2, label, { whiteSpace: 'nowrap' }),
  )
}

/** The order's title, large in Involve; smaller as it grows. */
function headline(title: string, quiet: boolean, compact: boolean): Node {
  const t = clip(title, compact ? 90 : 110)
  const size = compact
    ? t.length <= 40
      ? 25
      : t.length <= 70
        ? 21
        : 19
    : t.length <= 24
      ? 34
      : t.length <= 52
        ? 27
        : t.length <= 80
          ? 23
          : 21
  return txt(
    {
      fontFamily: SANS,
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1.04,
      letterSpacing: -size * 0.035,
      color: quiet ? C.ink2 : C.accent,
      marginTop: 12,
    },
    t,
  )
}

/** The colour of a lit square at `t` along the bar: pale orange at the start, Hance's orange at the end. */
function ramp(t: number): string {
  const from = [0xff, 0xd2, 0xc2]
  const to = [0xff, 0x3d, 0x00]
  const ch = (i: number) =>
    Math.round((from[i] ?? 0) + ((to[i] ?? 0) - (from[i] ?? 0)) * Math.max(0, Math.min(1, t)))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

/**
 * The score as one row of squares (Boris, 11.11.2026): as many lit as the score, each a little deeper than the one
 * before, from pale orange to Hance's orange; the rest stay dark. A low score is pale, a high one reaches full orange.
 */
function scoreSquares(c: LeadCard): Node {
  const n = 26
  const score = c.score?.value ?? 0
  const lit = Math.round((score / 100) * n)
  return box(
    { justifyContent: 'space-between', marginTop: 20 },
    ...Array.from({ length: n }, (_, i) =>
      box({
        width: 9,
        height: 9,
        borderRadius: 2,
        backgroundColor: i < lit ? ramp(i / (n - 1)) : C.lcdLine,
      }),
    ),
  )
}

/**
 * The dark panel of figures (Boris, 11.11.2026: the black one holds more than a light plate): the score large in
 * orange, the budget, the fee and similar decisions on the right, the score's row of squares along the bottom.
 */
function scorePanel(c: LeadCard, fee: string): Node {
  const score = c.score?.value ?? null
  const s = c.similar
  const rows: [string, string][] = [
    ['Бюджет', clip(c.budgetText?.trim() ? c.budgetText : 'не указан', 20)],
    ['Отклик', fee],
  ]
  if (s && s.n > 0) rows.push(['Похожие', s.enough ? `${s.bid} из ${s.n}` : `${s.n}, мало`])
  if (c.autobid) rows.push(['Сама', 'откликнулась бы'])
  return box(
    {
      flexDirection: 'column',
      backgroundColor: C.lcd,
      borderRadius: 20,
      padding: '18px 18px 20px',
      marginTop: 24,
    },
    box(
      { justifyContent: 'space-between' },
      box(
        { flexDirection: 'column', width: 112 },
        mono(9, C.muted, 'Балл'),
        box(
          { alignItems: 'flex-end', marginTop: 4 },
          score === null
            ? mono(13, C.lcdText, 'нет оценки', { marginTop: 14 })
            : txt(
                {
                  fontFamily: MONO,
                  fontWeight: 500,
                  fontSize: 46,
                  lineHeight: 1,
                  color: C.accent,
                  letterSpacing: -2.5,
                },
                String(score),
              ),
          score === null ? null : mono(11, C.muted, '/100', { marginLeft: 5, marginBottom: 5 }),
        ),
      ),
      box(
        { flexDirection: 'column', flex: 1, marginLeft: 12, justifyContent: 'center' },
        ...rows.map(([label, value], i) =>
          box(
            {
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: i === 0 ? 0 : 8,
              marginTop: i === 0 ? 0 : 8,
              borderTop: i === 0 ? 'none' : `1px solid ${C.lcdLine}`,
            },
            mono(9, C.muted, label),
            txt({ fontFamily: MONO, fontWeight: 500, fontSize: 12, color: C.lcdText }, value),
          ),
        ),
      ),
    ),
    scoreSquares(c),
  )
}

/** The facts under the client's name fit one line of the card at this many characters. */
const FACTS_MAX = 42

/** The client as a passport line: an initial, the name, how he answers, since when, the reviews. */
function clientRow(c: LeadCard): Node {
  const info = c.clientInfo ?? null
  const raw = info?.name?.trim() || c.clientName.trim()
  const first = raw ? firstName(raw) : null
  const name = first && !/^\p{Script=Cyrillic}/u.test(raw) ? `${first} (${raw})` : raw
  // One line of facts, so the name and the line stand exactly as tall as the initial's square beside them.
  const since = info?.on_profi_since?.match(/(19|20)\d\d/)?.[0]
  const base = [
    since ? `с ${since}` : null,
    info?.reviews
      ? info.reviews.positive + info.reviews.negative === 0
        ? 'отзывов нет'
        : `отзывы +${info.reviews.positive}/−${info.reviews.negative}`
      : null,
  ].filter((x): x is string => x !== null)
  // How the client answers comes first when the whole of it fits the line; it is never cut, nor are the reviews.
  const room = FACTS_MAX - base.join(' · ').length - (base.length > 0 ? 3 : 0)
  const said = clip(info?.summaries?.[0]?.description, 60)
  const facts = said && said.length <= room ? [said, ...base] : base
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return box(
    { alignItems: 'center', marginTop: 26 },
    box(
      {
        width: 38,
        height: 38,
        borderRadius: 10,
        backgroundColor: C.ink,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
      },
      txt({ fontFamily: SANS, fontWeight: 600, fontSize: 17, color: C.bg }, initial),
    ),
    box(
      { flexDirection: 'column', flex: 1, minWidth: 0 },
      txt(
        {
          fontFamily: SANS,
          fontWeight: 600,
          fontSize: 16,
          lineHeight: 1.15,
          color: C.ink,
          letterSpacing: -0.2,
        },
        clip(name || 'Имя не указано', 34),
      ),
      facts.length > 0
        ? mono(9, C.muted, clip(facts.join(' · '), FACTS_MAX), {
            marginTop: 4,
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
          })
        : null,
    ),
  )
}

/** A filled marker square of the list, its sign in `ink` (white, or orange on the dark for the risk). */
function marker(sign: string, fill: string, ink: string = C.white): Node {
  return box(
    {
      width: 18,
      height: 18,
      borderRadius: 5,
      backgroundColor: fill,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
      marginTop: 1,
    },
    txt({ fontFamily: MONO, fontWeight: 500, fontSize: 12, color: ink }, sign),
  )
}

/**
 * Why the order fits, as one list on one grid: the plus, the minus, a question to ask, and the risk last, an orange
 * sign on dark (Boris, 11.11.2026: the risk on its own pink plate looked machine-made).
 */
function whyRows(c: LeadCard): Node | null {
  const pm = plusMinus(c.score?.reason ?? c.reason ?? '')
  const rows: Node[] = []
  // Every item starts the same way, as the plus and the minus do after «Подходит:».
  const lower = (t: string) =>
    /^[А-ЯЁA-Z][а-яёa-z]/.test(t) ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t
  const row = (m: Node, text: string) =>
    box(
      { alignItems: 'flex-start', marginTop: rows.length === 0 ? 0 : 12 },
      m,
      words(15, C.ink, lower(text), { lineHeight: 1.3, flex: 1, minWidth: 0 }),
    )
  if (pm.plus.trim()) rows.push(row(marker('+', C.accent), thought(pm.plus, 90)))
  if (pm.minus?.trim()) rows.push(row(marker('−', C.ink), thought(pm.minus, 90)))
  for (const l of (c.clarify ?? []).slice(0, 1)) rows.push(row(marker('?', C.muted), clip(l, 90)))
  const risk = c.analysis?.risk?.trim()
  if (risk) rows.push(row(marker('!', C.ink, C.accent), thought(risk, 100)))
  if (rows.length === 0) return null
  return box({ flexDirection: 'column', marginTop: 24 }, ...rows)
}

/**
 * A text set apart as Hance does it: a hairline, a numbered mono label, then the words themselves, with no plate and
 * no rounded box (Boris, 11.11.2026).
 */
function passage(n: string, label: string, text: string, more: string | null): Node[] {
  return [
    box({ height: 1, backgroundColor: C.line, marginTop: 26 }),
    numbered(n, label, 20),
    words(15, C.ink, text, { lineHeight: 1.45, marginTop: 12, whiteSpace: 'pre-wrap' }),
    more ? mono(9, C.muted, more, { marginTop: 12 }) : null,
  ].filter((x): x is Node => Boolean(x))
}

/** The client's own words under the reasons: about five lines on the card, the rest in «Разбор». */
function clientWords(c: LeadCard): Node[] {
  const flat = c.text.replace(/\s*\n+\s*/g, ' ').trim()
  if (!flat) return []
  const max = 170
  return passage(
    '02',
    'Сообщение клиента',
    clipKeep(flat, max),
    flat.length > max ? 'Целиком в «Разборе»' : null,
  )
}

/** Rows of a label and a text on one grid, hairlines between them: the series under the bid. */
function labelRows(rows: [string, string][]): Node | null {
  if (rows.length === 0) return null
  return box(
    { flexDirection: 'column', marginTop: 6 },
    ...rows.map(([label, text]) =>
      box(
        {
          alignItems: 'flex-start',
          paddingTop: 10,
          marginTop: 10,
          borderTop: `1px solid ${C.line}`,
        },
        mono(9, C.muted, label, { width: 78, marginTop: 3 }),
        words(14, C.ink2, text, { flex: 1, minWidth: 0 }),
      ),
    ),
  )
}

/** The view «Текст отклика»: the bid as it will go, its price, and what follows it into the chat. */
function bidView(c: LeadCard): Node[] {
  const d = c.draft
  const price = d?.priceRub
    ? (() => {
        const r = priceRange(d.priceRub, d.priceToRub)
        return `от ${formatRub(r.from)} до ${formatRub(r.to)}`
      })()
    : null
  const follow = (d?.followUps ?? []).map((t): [string, string] => [
    isCallOffer(t) ? 'Созвон' : isTelegramLine(t) ? 'Телеграм' : 'Вдогонку',
    clip(t.split(SLOTS_MARK).join('три времени по рабочим часам'), 80),
  ])
  return [
    numbered('01', ['Отклик', price].filter(Boolean).join(' · ')),
    headline(clip(c.title, 70), false, true),
    ...passage(
      '02',
      'Текст отклика',
      d ? clipKeep(d.text, 600) : 'Черновика нет: нажми «Правка» и пришли текст отклика.',
      null,
    ),
    labelRows(follow),
  ].filter((x): x is Node => Boolean(x))
}

const mskClock = (d: Date) =>
  d.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })

/** The dark panel of a bid that went: the time large in orange, what it cost on the right. */
function sentBlock(c: LeadCard, st: CardState): Node {
  const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : null)
  return box(
    {
      justifyContent: 'space-between',
      alignItems: 'flex-end',
      backgroundColor: C.lcd,
      borderRadius: 18,
      padding: '14px 16px 16px',
      marginTop: 16,
    },
    box(
      { flexDirection: 'column' },
      mono(9, C.muted, st.s === 'found' ? 'Найден на Профи' : 'Отклик ушёл'),
      txt(
        {
          fontFamily: MONO,
          fontWeight: 500,
          fontSize: 34,
          lineHeight: 1,
          color: C.accent,
          marginTop: 6,
          letterSpacing: -1,
        },
        st.t ?? '',
      ),
    ),
    fee
      ? box(
          { flexDirection: 'column', alignItems: 'flex-end' },
          mono(9, C.muted, 'Списано'),
          txt(
            { fontFamily: MONO, fontWeight: 500, fontSize: 18, color: C.lcdText, marginTop: 6 },
            fee,
          ),
        )
      : null,
  )
}

/** The state's own part on a short card: the steps of the sending, the bid that went, or a note. */
function stateBlock(c: LeadCard, st: CardState): Node[] {
  if (st.s === 'sending') {
    const steps = ['Отклик', 'Вдогонку', 'Созвон', 'Телеграм']
    return [
      box(
        { marginTop: 16 },
        ...steps.map((s, i) =>
          box(
            {
              flex: 1,
              marginLeft: i === 0 ? 0 : 6,
              padding: '9px 0',
              borderRadius: 999,
              justifyContent: 'center',
              backgroundColor: i === 0 ? C.accent : C.cell,
            },
            mono(8.5, i === 0 ? C.white : C.ink2, s),
          ),
        ),
      ),
    ]
  }
  if (st.s === 'sent' || st.s === 'found')
    return [
      sentBlock(c, st),
      st.n ? words(14, C.ink2, clip(st.n, 160), { marginTop: 12 }) : null,
    ].filter((x): x is Node => Boolean(x))
  const note =
    st.s === 'unsure'
      ? 'Площадка не ответила. Проверь заявку на Профи.ру, прежде чем откликаться вручную.'
      : st.n
  return [
    note
      ? words(15, st.s === 'unsure' ? C.accentInk : C.ink2, clip(note, 180), { marginTop: 12 })
      : null,
    st.t ? mono(9, C.muted, `${st.t} мск`, { marginTop: 12 }) : null,
  ].filter((x): x is Node => Boolean(x))
}

const QUIET: CardStage[] = ['closed', 'skipped', 'stale', 'done', 'note']

const frame = (...children: (Node | null)[]): Node =>
  box(
    {
      flexDirection: 'column',
      width: W,
      boxSizing: 'border-box',
      backgroundColor: C.bg,
      padding: PAD,
      fontFamily: SANS,
    },
    ...children,
  )

function cardTree(c: LeadCard, st: CardState, now: Date): Node {
  const view: CardView = st.s === 'new' ? (st.v ?? 'card') : 'card'
  if (view === 'bid') return frame(topBar(st.s), ...bidView(c))
  if (st.s !== 'new')
    return frame(topBar(st.s), headline(c.title, QUIET.includes(st.s), true), ...stateBlock(c, st))
  const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : '?')
  const where = isTestOrder(c.orderId) ? 'Тест · понарошку' : 'Профи.ру'
  return frame(
    topBar(st.s),
    box(
      { justifyContent: 'space-between', alignItems: 'center' },
      numbered('01', isTestOrder(c.orderId) ? where : clip(c.city, 30) || where),
      mono(10, C.muted, mskClock(now), { marginTop: 26 }),
    ),
    headline(c.title, false, false),
    scorePanel(c, fee),
    clientRow(c),
    whyRows(c),
    ...clientWords(c),
  )
}

/**
 * The picture of a lead card in state `st`: PNG, 1080 pixels wide. A new card is the full poster (or its bid view); any
 * later state is a short card with the title and what happened.
 */
export async function renderCardPicture(
  c: LeadCard,
  st: CardState,
  now: Date = new Date(),
): Promise<{ png: Buffer; width: number; height: number }> {
  const svg = await satori(cardTree(c, st, now) as unknown as Parameters<typeof satori>[0], {
    width: W,
    fonts: loadFonts(),
  })
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: PICTURE_WIDTH },
    background: C.bg,
    font: { loadSystemFonts: false },
  }).render()
  return { png: Buffer.from(r.asPng()), width: r.width, height: r.height }
}

const VIEW_BUTTON: Record<CardView, string> = {
  card: 'Карточка',
  bid: 'Текст отклика',
}

type Key = { text: string; callback_data?: string; url?: string; style?: 'primary' }

/** The data of a button that switches a new card's view in place («v:<task>:bid»): no press of the task, only a look. */
export const viewCallback = (taskId: string, v: CardView) => `v:${taskId}:${v}`
export function parseViewCallback(data: string): { taskId: string; view: CardView } | null {
  const m = /^v:([0-9a-f-]{36}):(card|bid)$/i.exec(data)
  return m?.[1] && m[2] ? { taskId: m[1], view: m[2] as CardView } : null
}

/**
 * The buttons under the picture. A new card: the bid with its fee (the main one); the view it is not showing («Текст
 * отклика» or «Карточка»); «Правка», «Разбор», «Пропустить», the same presses as the text card's.
 * A short card: `rows` (the reasons under a closed one), the client's chat and the order on Profi.ru as links.
 */
export function pictureKeyboard(
  c: LeadCard,
  st: CardState,
  rows: { text: string; callbackData: string }[][] = [],
): Key[][] {
  if (st.s === 'new') {
    const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : null)
    return [
      [
        {
          text: fee ? `Отправить отклик · ${fee}` : 'Отправить отклик',
          callback_data: formatCallback(c.taskId, 'bid'),
          style: 'primary',
        },
      ],
      (['card', 'bid'] as const)
        .filter((v) => v !== (st.v ?? 'card'))
        .map((v) => ({ text: VIEW_BUTTON[v], callback_data: viewCallback(c.taskId, v) })),
      [
        { text: 'Правка', callback_data: formatCallback(c.taskId, 'edit') },
        { text: TEXTS.analysisButton, callback_data: formatCallback(c.taskId, 'razbor') },
        { text: 'Пропустить', callback_data: formatCallback(c.taskId, 'skip') },
      ],
    ]
  }
  const own: Key[][] = rows
    .filter((r) => r.length > 0)
    .map((r) => r.map((b) => ({ text: b.text, callback_data: b.callbackData })))
  if (st.s === 'sending' || st.s === 'done' || st.s === 'note') return own
  const links: Key[] = []
  if (st.u && (st.s === 'sent' || st.s === 'found'))
    links.push({ text: 'Чат с клиентом', url: st.u })
  if (!isTestOrder(c.orderId)) links.push({ text: 'Открыть на Профи', url: orderUrl(c.orderId) })
  return links.length > 0 ? [...own, links] : own
}
