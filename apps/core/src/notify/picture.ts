import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { formatCallback, formatRub, isTestOrder } from '@sara/shared'
import satori from 'satori'
import { firstName } from '../leads/clientName'
import type { CardStage, CardState } from './cardState'
import { type LeadCard, orderUrl, TEXTS } from './cards'

/**
 * The header of a lead card in Hance's own look (Boris, 11.11.2026): the logo of hance.pro, Involve for words and Martian
 * Mono for labels and figures, after the voice app's screen («[01]» labels, squares of a score, a green pill) and the
 * proposal for ARTEQON IQ (a big orange title, a black panel of figures). Since 12.11.2026 only the top of the first long
 * card (Boris: «верни как было и просто сверху сделай вот такую штуку… и цвет фона белый чисто»): the logo and the pill,
 * the client and the time, the title, the black panel with the score, the budget, the fee and the squares. It goes as the
 * link preview above the working text card; a photo card of 11 и 12.11 is still drawn in its later states.
 */

const C = {
  bg: '#FFFFFF',
  ink: '#1A1A1A',
  ink2: '#4A4844',
  muted: '#6B6A65',
  muted2: '#9D978F',
  line: '#DCD9D3',
  cell: '#E4E1DB',
  accent: '#FF3D00',
  accentMid: '#FF8A62',
  accentLight: '#FFD9C9',
  accentInk: '#C93000',
  green: '#005A52',
  lcd: '#201F1D',
  lcdLine: '#383633',
  lcdText: '#F3F2EF',
  white: '#FFFFFF',
} as const

const SANS = 'Involve'
const MONO = 'Martian Mono'
/** The width the header is laid out at, and the width of the picture Telegram gets (sharp on a phone). */
const W = 450
/** 3:2 (12.11.2026): a wide header, never taller. */
const H = (W * 2) / 3
export const PICTURE_WIDTH = 1080
const PAD = 18

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
/** `s` on one line, cut after a whole word to at most `max` characters with «…». */
function clipWords(s: string, max: number): string {
  const t = clip(s, 100_000)
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const space = head.lastIndexOf(' ')
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,.;:·-]+$/u, '')}…`
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
    { alignItems: 'center', borderRadius: 999, padding: '7px 15px 7px 13px', backgroundColor: bg },
    box({
      width: 8,
      height: 8,
      borderRadius: 2,
      marginRight: 9,
      backgroundColor: tone === 'quiet' ? C.muted : tone === 'accent' ? C.white : C.accent,
    }),
    // Involve sits high in its line: a little padding on top puts its letters on the dot's axis.
    txt({ fontFamily: SANS, fontSize: 15, color, lineHeight: 1, paddingTop: 2.5 }, text),
  )
}

/** The logo of hance.pro on the left, the state's pill on the right. */
function topBar(stage: CardStage): Node {
  return box(
    { justifyContent: 'space-between', alignItems: 'center' },
    { type: 'img', props: { src: logoSrc(), style: { width: 132, height: 26 } } },
    pill(stage),
  )
}

/** «[01] НОВАЯ ЗАЯВКА»: the voice app's numbered label, its number in orange. */
function numbered(n: string, label: string, marginTop = 14): Node {
  return box(
    { alignItems: 'center', marginTop },
    mono(11.5, C.accent, `[${n}]`, { marginRight: 10 }),
    mono(11.5, C.ink2, label, { whiteSpace: 'nowrap' }),
  )
}

/**
 * The order's title, large in Involve: one line as large as it fits, a longer one on two lines; `shrink` points smaller
 * when the header would not fit 3:2.
 */
function headline(title: string, quiet: boolean, compact: boolean, shrink = 0): Node {
  const t = clipWords(title, compact ? 80 : 60)
  const base = compact
    ? t.length <= 40
      ? 28
      : t.length <= 70
        ? 24
        : 22
    : t.length <= 22
      ? 34
      : t.length <= 26
        ? 30
        : t.length <= 50
          ? 28
          : 24
  const size = base - shrink
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
  const from = [0xff, 0xd9, 0xc9]
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
    { justifyContent: 'space-between', marginTop: 14 },
    ...Array.from({ length: n }, (_, i) =>
      box({
        width: 10,
        height: 10,
        borderRadius: 2,
        backgroundColor: i < lit ? ramp(i / (n - 1)) : C.lcdLine,
      }),
    ),
  )
}

const NBSP = String.fromCharCode(0xa0)
/** A sum on one line where it can: no break inside a number, after «от» or «до», or before «₽». */
const keepSum = (s: string) =>
  s
    .replace(/(\d)\s+(?=\d{3}(?!\d))/g, `$1${NBSP}`)
    .replace(/(^|\s)(от|до)\s+(?=\d)/gu, `$1$2${NBSP}`)
    .replace(/\s+₽/g, `${NBSP}₽`)

/**
 * The dark panel of figures (Boris, 11.11.2026: the black one holds more than a light plate): the score large in
 * orange, the budget, the fee and similar decisions on the right, the score's row of squares along the bottom.
 */
function scorePanel(c: LeadCard, fee: string): Node {
  const score = c.score?.value ?? null
  const rows: [string, string][] = [
    ['Бюджет', keepSum(clip(c.budgetText?.trim() ? c.budgetText : 'не указан', 24))],
    ['Отклик', fee],
  ]
  if (c.autobid) rows.push(['Сама', 'откликнулась бы'])
  return box(
    {
      flexDirection: 'column',
      backgroundColor: C.lcd,
      borderRadius: 22,
      padding: '14px 18px 15px',
      marginTop: 14,
    },
    box(
      { justifyContent: 'space-between' },
      box(
        { flexDirection: 'column', width: 132 },
        mono(10, C.muted2, 'Балл'),
        box(
          { alignItems: 'flex-end', marginTop: 4 },
          score === null
            ? mono(13, C.lcdText, 'нет оценки', { marginTop: 14 })
            : txt(
                {
                  fontFamily: MONO,
                  fontWeight: 500,
                  fontSize: 50,
                  lineHeight: 1,
                  color: C.accent,
                  letterSpacing: -2.5,
                },
                String(score),
              ),
          score === null ? null : mono(12, C.muted2, '/100', { marginLeft: 5, marginBottom: 5 }),
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
            mono(10, C.muted2, label, { flexShrink: 0, marginRight: 12 }),
            txt(
              {
                fontFamily: MONO,
                fontWeight: 500,
                fontSize: value.length > 14 ? 12 : 14,
                lineHeight: 1.25,
                color: C.lcdText,
                textAlign: 'right',
                justifyContent: 'flex-end',
                flexShrink: 1,
              },
              value,
            ),
          ),
        ),
      ),
    ),
    scoreSquares(c),
  )
}

/** The client in the card's label line: the name, since when, the reviews (Boris: «клиент, всё коротко»). */
function clientLine(c: LeadCard): string {
  if (isTestOrder(c.orderId)) return 'Тест · понарошку'
  const info = c.clientInfo ?? null
  const raw = info?.name?.trim() || c.clientName.trim()
  const name = raw ? (firstName(raw) ?? raw) : 'Клиент'
  const since = info?.on_profi_since?.match(/(19|20)\d\d/)?.[0]
  const reviews = info?.reviews
    ? info.reviews.positive + info.reviews.negative === 0
      ? 'отзывов нет'
      : `+${info.reviews.positive}/−${info.reviews.negative}`
    : null
  return clip(
    [clip(name, 18), since ? `с ${since}` : null, reviews].filter(Boolean).join(' · '),
    40,
  )
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

/** The sheet; `fixed`: exactly 3:2 (the header of a new card), its free room between the title and the panel. */
const frame = (fixed: boolean, ...children: (Node | null)[]): Node =>
  box(
    {
      flexDirection: 'column',
      width: W,
      ...(fixed ? { height: H } : {}),
      boxSizing: 'border-box',
      backgroundColor: C.bg,
      padding: PAD,
      fontFamily: SANS,
    },
    ...children,
  )
/** The free room of a 3:2 header: it keeps the panel at the bottom. */
const room = (): Node => box({ flexGrow: 1 })

function cardTree(c: LeadCard, st: CardState, now: Date, shrink: number, fixed: boolean): Node {
  if (st.s !== 'new')
    return frame(
      false,
      topBar(st.s),
      headline(c.title, QUIET.includes(st.s), true),
      ...stateBlock(c, st),
    )
  const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : '?')
  return frame(
    fixed,
    topBar(st.s),
    box(
      { justifyContent: 'space-between', alignItems: 'center' },
      numbered('01', clientLine(c)),
      mono(11.5, C.muted, mskClock(now), { marginTop: 14 }),
    ),
    headline(c.title, false, false, shrink),
    room(),
    scorePanel(c, fee),
  )
}

const heightOf = (svg: string) => Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 0)

/**
 * The picture of a lead card in state `st`: PNG, 1080 pixels wide. A new card's is the 3:2 header (a title too long for
 * it gets smaller until it fits); a later state of a photo card of 11 и 12.11 is a short card, the title and what happened.
 */
export async function renderCardPicture(
  c: LeadCard,
  st: CardState,
  now: Date = new Date(),
): Promise<{ png: Buffer; width: number; height: number }> {
  const draw = (tree: Node, height?: number) =>
    satori(tree as unknown as Parameters<typeof satori>[0], {
      width: W,
      ...(height ? { height } : {}),
      fonts: loadFonts(),
    })
  const fixed = st.s === 'new'
  let shrink = 0
  while (fixed && shrink < 8 && heightOf(await draw(cardTree(c, st, now, shrink, false))) > H)
    shrink += 2
  const svg = await draw(cardTree(c, st, now, shrink, fixed), fixed ? H : undefined)
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: PICTURE_WIDTH },
    background: C.bg,
    font: { loadSystemFonts: false },
  }).render()
  return { png: Buffer.from(r.asPng()), width: r.width, height: r.height }
}

/** Telegram draws the buttons: of its three colours, red is the nearest to Hance's orange (Boris, 11.11.2026). */
type Key = { text: string; callback_data?: string; url?: string; style?: 'danger' }

/**
 * The buttons under the picture. A new card: the bid with its fee (the main one), then «Правка», «Разбор»,
 * «Пропустить», the same presses as the text card's.
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
          style: 'danger',
        },
      ],
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
