import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { formatCallback, formatRub, isTestOrder } from '@sara/shared'
import satori from 'satori'
import { firstName } from '../leads/clientName'
import type { CardStage, CardState } from './cardState'
import { type LeadCard, orderUrl, plusMinus, TEXTS } from './cards'

/**
 * The lead card as a picture in Hance's own look (Boris, 11.11.2026): the logo of hance.pro, Involve for words and
 * Martian Mono for labels and figures, after the voice app's screen (a green pill, mono labels) and the proposal for
 * ARTEQON IQ (a big orange title, a black panel of figures). Since 12.11.2026 a 4:3 picture of the main only, by the mock
 * Boris approved: the logo and the pill with the time, the title, where and who, a black panel of three figures, one line
 * each for the plus, the minus and the risk. The long texts go as Telegram text under it (cardText.ts).
 */

const C = {
  bg: '#F3F2EF',
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
/** The width the card is laid out at (the mock of 12.11.2026) and the width of the picture Telegram gets. */
const W = 440
/** 4:3 (12.11.2026): Telegram shows a picture of this shape large, at the full width of the message. */
const H = (W * 3) / 4
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
/** The first sentence of a text, without the final period, cut after a whole word to at most `max` characters. */
export function thought(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(DASHES, '-').replace(/\s+/g, ' ').trim()
  const first = (t.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z«])/)[0] ?? t).replace(/[.\s]+$/, '')
  if (first.length <= max) return first
  const cut = first.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  let head = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')
  // A line never ends on a word that leads somewhere: «а», «и», «не», «для»…
  for (let i = 0; i < 3; i++)
    head = head.replace(
      /[\s,]+(а|и|но|не|ни|в|во|на|с|со|к|по|за|для|без|из|от|до|о|об|что|как)$/i,
      '',
    )
  return `${head}…`
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

/** The state as the voice app's pill: a filled capsule with a dot, never an outline; a new card's has its time. */
function pill(stage: CardStage, time?: string): Node {
  const { text, tone } = LABEL[stage]
  const bg = { green: C.green, accent: C.accent, ink: C.ink, quiet: C.cell }[tone]
  const color = tone === 'quiet' ? C.ink2 : C.white
  return box(
    { alignItems: 'center', borderRadius: 999, padding: '6px 14px 6px 12px', backgroundColor: bg },
    box({
      width: 7,
      height: 7,
      borderRadius: 2,
      marginRight: 8,
      backgroundColor: tone === 'quiet' ? C.muted : tone === 'accent' ? C.white : C.accent,
    }),
    // Involve sits high in its line: a little padding on top puts its letters on the dot's axis.
    txt(
      { fontFamily: SANS, fontSize: 14, color, lineHeight: 1, paddingTop: 2.5 },
      time ? `${text} · ${time}` : text,
    ),
  )
}

/** The logo of hance.pro on the left, the state's pill on the right. */
function topBar(stage: CardStage, time?: string): Node {
  return box(
    { justifyContent: 'space-between', alignItems: 'center' },
    { type: 'img', props: { src: logoSrc(), style: { width: 128, height: 25 } } },
    pill(stage, time),
  )
}

/**
 * The order's title, large in Involve: one line as large as it fits, a longer one on two lines; `shrink` points smaller
 * when the card would not fit 4:3.
 */
function headline(title: string, quiet: boolean, shrink: number): Node {
  const t = clipWords(title, 60)
  const base = t.length <= 22 ? 34 : t.length <= 27 ? 28 : t.length <= 48 ? 26 : 22
  const size = base - shrink
  return txt(
    {
      fontFamily: SANS,
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1.06,
      letterSpacing: -size * 0.03,
      color: quiet ? C.ink2 : C.accent,
      marginTop: 12,
    },
    t,
  )
}

/** Who the client is, short: the first name and since when on Profi.ru. */
export function whoLine(c: LeadCard): string {
  if (isTestOrder(c.orderId)) return 'тест, понарошку'
  const info = c.clientInfo ?? null
  const raw = info?.name?.trim() || c.clientName.trim()
  const name = clip(raw ? (firstName(raw) ?? raw) : 'Клиент', 18)
  const since = info?.on_profi_since?.match(/(19|20)\d\d/)?.[0]
  return since ? `${name}, на Профи с ${since}` : name
}

/** The line under the title fits the card at this many characters. */
const META_MAX = 48

/** Where and who, under the title (the mock of 12.11.2026): «дистанционно · Москва · Артём, на Профи с 2023». */
function metaLine(c: LeadCard): Node {
  const who = whoLine(c)
  // The place gives way first, part by part from its end: who the client is matters more than the city.
  const parts = clip(c.city, 100)
    .replace(/^Дистанционно/u, 'дистанционно')
    .split(' · ')
    .filter(Boolean)
  while (parts.length > 0 && [...parts, who].join(' · ').length > META_MAX) parts.pop()
  return words(14, C.muted, clip([...parts, who].join(' · '), META_MAX), {
    marginTop: 6,
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
  })
}

const NBSP = String.fromCharCode(0xa0)
/** A sum on one line where it can: no break inside a number, after «от» or «до», or before «₽». */
const keepSum = (s: string) =>
  s
    .replace(/(\d)\s+(?=\d{3}(?!\d))/g, `$1${NBSP}`)
    .replace(/(^|\s)(от|до)\s+(?=\d)/gu, `$1$2${NBSP}`)
    .replace(/\s+₽/g, `${NBSP}₽`)

/**
 * The dark panel of figures in three columns (the mock of 12.11.2026): the score large in orange, the client's budget
 * and the fee for the bid.
 */
function scorePanel(c: LeadCard, fee: string): Node {
  const score = c.score?.value ?? null
  const figure = (s: string, more: Style = {}) =>
    txt(
      {
        fontFamily: MONO,
        fontWeight: 500,
        fontSize: 14,
        lineHeight: 1.2,
        color: C.lcdText,
        ...more,
      },
      s,
    )
  const cell = (label: string, style: Style, ...body: (Node | null)[]) =>
    box(
      { flexDirection: 'column', justifyContent: 'space-between', minWidth: 0, ...style },
      mono(9, C.muted2, label),
      box({ flexDirection: 'column', marginTop: 6 }, ...body),
    )
  const next: Style = {
    flex: 1,
    paddingLeft: 12,
    marginLeft: 12,
    borderLeft: `1px solid ${C.lcdLine}`,
  }
  return box(
    { backgroundColor: C.lcd, borderRadius: 20, padding: '12px 16px 13px', marginTop: 12 },
    cell(
      'Балл',
      { flexShrink: 0 },
      score === null
        ? figure('нет оценки', { fontSize: 13 })
        : box(
            { alignItems: 'flex-end' },
            txt(
              {
                fontFamily: MONO,
                fontWeight: 500,
                fontSize: 36,
                lineHeight: 1,
                color: C.accent,
                letterSpacing: -1.8,
              },
              String(score),
            ),
            mono(11, C.muted2, '/100', { marginLeft: 4, marginBottom: 3 }),
          ),
    ),
    cell(
      'Бюджет',
      { ...next, flex: 1.3 },
      figure(keepSum(clip(c.budgetText?.trim() ? c.budgetText : 'не указан', 24))),
    ),
    cell(
      'Отклик',
      next,
      figure(fee),
      c.autobid
        ? words(11, C.accentMid, 'сама бы откликнулась', { marginTop: 3, lineHeight: 1.15 })
        : null,
    ),
  )
}

/** A filled marker square of the list, its sign in `ink` (white, or orange on the dark for the risk). */
function marker(sign: string, fill: string, ink: string = C.white): Node {
  return box(
    {
      width: 16,
      height: 16,
      borderRadius: 4,
      backgroundColor: fill,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 9,
      flexShrink: 0,
    },
    txt({ fontFamily: MONO, fontWeight: 500, fontSize: 11, lineHeight: 1, color: ink }, sign),
  )
}

/** A reason fits its one line of the card at this many characters. */
const WHY_MAX = 46

/**
 * Why the order fits, one line each (the mock of 12.11.2026): the plus, the minus and the risk last, an orange sign on
 * dark (Boris, 11.11.2026: the risk on its own pink plate looked machine-made).
 */
function whyRows(c: LeadCard): Node | null {
  const pm = plusMinus(c.score?.reason ?? c.reason ?? '')
  const rows: Node[] = []
  // Every item starts the same way, as the plus and the minus do after «Подходит:».
  const lower = (t: string) =>
    /^[А-ЯЁA-Z][а-яёa-z]/.test(t) ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t
  const row = (m: Node, text: string) =>
    box(
      { alignItems: 'center', marginTop: rows.length === 0 ? 0 : 6 },
      m,
      words(14, C.ink, lower(text), {
        lineHeight: 1.3,
        flex: 1,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }),
    )
  if (pm.plus.trim()) rows.push(row(marker('+', C.accent), thought(pm.plus, WHY_MAX)))
  if (pm.minus?.trim()) rows.push(row(marker('−', C.ink), thought(pm.minus, WHY_MAX)))
  const risk = c.analysis?.risk?.trim()
  if (risk) rows.push(row(marker('!', C.ink, C.accent), thought(risk, WHY_MAX)))
  if (rows.length === 0) return null
  return box({ flexDirection: 'column', marginTop: 12 }, ...rows)
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

/** The card's sheet; `fixed`: exactly 4:3 (a new card), its free room between the title and what follows. */
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
/** The free room of a 4:3 card: it keeps the figures and the reasons at the bottom. */
const room = (): Node => box({ flexGrow: 1 })

function cardTree(c: LeadCard, st: CardState, now: Date, shrink: number, fixed: boolean): Node {
  if (st.s !== 'new')
    return frame(
      fixed,
      topBar(st.s),
      headline(c.title, QUIET.includes(st.s), shrink),
      room(),
      ...stateBlock(c, st),
    )
  const fee = st.f ?? (c.bidPriceRub > 0 ? formatRub(c.bidPriceRub) : '?')
  return frame(
    fixed,
    topBar(st.s, mskClock(now)),
    headline(c.title, false, shrink),
    metaLine(c),
    room(),
    scorePanel(c, fee),
    whyRows(c),
  )
}

const heightOf = (svg: string) => Number(svg.match(/height="([\d.]+)"/)?.[1] ?? 0)

/**
 * The picture of a lead card in state `st`: PNG, 1080 pixels wide. A new card is 4:3 with the main of the order, and a
 * title too long for it gets smaller until it fits; a later state is a short card, the title and what happened.
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
