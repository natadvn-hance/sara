import { formatRub } from '@sara/shared'
import type { Db } from '../db/client'
import { leadQueue } from '../pult/leads'
import { SETTING_META } from '../pult/settings'
import { todayView } from '../pult/today'
import { getSetting, setSetting } from '../settings/store'

/**
 * Sara's commands in the bot's menu (Boris, 30.10.2026: «список команд по кнопке, тест там и другие»). They read and
 * change what the pult does, through the same functions; in his forum they work in any topic as in his chat.
 */

/** What a command answers: a line, or a line with one button that opens a page (the pult). */
export type CommandReply = string | { text: string; open: { text: string; url: string } }

export type CommandContext = {
  db: Db
  publicUrl: string | null
  /** The words after the command (/test …). */
  args: string
  /** Test orders into the live Sara; none while they are starting (docs/ops/test-leads.md). */
  test?: (args: string) => Promise<string>
}

export type BotCommand = {
  /** Telegram's command: lower case letters, digits and underscores. */
  name: string
  /** Its line in the menu, a few words. */
  description: string
  /** Left out: the bot itself answers it (the forum's binding needs Telegram). */
  run?(c: CommandContext): Promise<CommandReply>
}

const OUTBOUND = ['outbound.messages', 'outbound.bids'] as const
const OUTBOUND_RU: Record<(typeof OUTBOUND)[number], string> = {
  'outbound.messages': 'не пишу клиентам',
  'outbound.bids': 'не трачу деньги на отклики',
}

const MSK = 'Europe/Moscow'
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: MSK })

export const COMMAND_TEXTS = {
  soon: 'Скоро: тестовые заявки придут вместе с тестовым стендом.',
  noPult: 'Адрес пульта не настроен.',
  pult: 'Пульт Сары: заявки, клиенты, настройки.',
  openPult: 'Открыть пульт',
  settings: 'Настройки: пороги заявок по видам, паузы, лимиты.',
  paused:
    'Пауза: не пишу клиентам и не трачу деньги на отклики. Чаты читаю и всё присылаю, как раньше. Снять: /resume',
  notPaused: 'Паузы нет: пишу клиентам и откликаюсь, как обычно. Поставить: /pause',
  queueEmpty: 'Заявок, ждущих решения, нет.',
}

async function stopped(db: Db) {
  const off: (typeof OUTBOUND)[number][] = []
  for (const k of OUTBOUND) if (!(await getSetting(db, k))) off.push(k)
  return off
}

/** /status: the day in a few lines, from the same view as «Сегодня» in the pult. */
async function status(c: CommandContext): Promise<string> {
  const t = await todayView(c.db, 1)
  const w = t.waiting
  const off = await stopped(c.db)
  const wallet =
    t.wallet.balanceRub === null
      ? 'Кошелёк: пока не знаю'
      : `Кошелёк: ${formatRub(t.wallet.balanceRub)}${t.wallet.at ? ` (на ${hhmm(t.wallet.at)})` : ''}${
          t.wallet.shortRub ? `, на отклик не хватает ${formatRub(t.wallet.shortRub)}` : ''
        }`
  const day = t.day
  return [
    `Сейчас: ${t.state.text}`,
    t.state.detail,
    t.doing.text ? `Делаю: ${t.doing.text}` : null,
    `Ждёт тебя: заявок ${w.leads}, черновиков ${w.drafts}, вопросов ${w.questions}`,
    wallet,
    `Сегодня: откликов ${day.bids} из ${day.bidsCap}, потрачено ${formatRub(day.spentRub)}${
      day.budgetRub !== null ? ` из ${formatRub(day.budgetRub)}` : ''
    }, карточек ${day.cards} из ${day.cardsCap}`,
    off.length ? `На паузе: ${off.map((k) => OUTBOUND_RU[k]).join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/** /queue: the leads that wait for his decision, best first, as in the pult's queue. */
async function queue(c: CommandContext): Promise<CommandReply> {
  const q = await leadQueue(c.db)
  if (q.queue.length === 0) return COMMAND_TEXTS.queueEmpty
  const shown = q.queue.slice(0, 10)
  const lines = shown.map(
    (l, i) =>
      `${i + 1}. ${l.title} · ${l.score === null ? 'без балла' : `балл ${l.score}`} · отклик ${formatRub(l.feeRub)} · №${l.id}`,
  )
  const more = q.queue.length - shown.length
  const text = [
    `Ждут решения: ${q.queue.length}`,
    ...lines,
    more > 0 ? `И ещё ${more}.` : null,
    q.older > 0 ? `Старше суток: ${q.older}, в пульте.` : null,
    q.paused ? `Сейчас отклик не уйдёт: ${q.paused}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return c.publicUrl
    ? { text, open: { text: COMMAND_TEXTS.openPult, url: `${c.publicUrl}/leads` } }
    : text
}

/** /pause: the switch that only stops, as the pult's (FR-OPS-1): reading and notices go on. */
async function pause(c: CommandContext): Promise<string> {
  for (const k of OUTBOUND) if (await getSetting(c.db, k)) await setSetting(c.db, k, false, 'boris')
  return COMMAND_TEXTS.paused
}

/** /resume: turning the outbound on again is the pult's step, with its own check; here what is off and where. */
async function resume(c: CommandContext): Promise<CommandReply> {
  const off = await stopped(c.db)
  if (off.length === 0) return COMMAND_TEXTS.notPaused
  const hint = SETTING_META['outbound.messages']?.hint
  const text = [
    `Сейчас на паузе: ${off.map((k) => OUTBOUND_RU[k]).join(', ')}.`,
    'Включить снова можно в пульте, в «Настройках».',
    hint ?? null,
  ]
    .filter(Boolean)
    .join('\n')
  return c.publicUrl
    ? { text, open: { text: COMMAND_TEXTS.openPult, url: `${c.publicUrl}/settings` } }
    : text
}

async function pult(c: CommandContext): Promise<CommandReply> {
  if (!c.publicUrl) return COMMAND_TEXTS.noPult
  return { text: COMMAND_TEXTS.pult, open: { text: COMMAND_TEXTS.openPult, url: c.publicUrl } }
}

/** /settings: the settings screen of the pult as the Mini App (the thresholds by kind are there, 3.11). */
async function settings(c: CommandContext): Promise<CommandReply> {
  if (!c.publicUrl) return COMMAND_TEXTS.noPult
  return {
    text: COMMAND_TEXTS.settings,
    open: { text: COMMAND_TEXTS.openPult, url: `${c.publicUrl}/settings?focus=thresholds` },
  }
}

/** The menu, in its order. /test and /test_clear go to the test orders; without them they say «скоро». */
export const COMMANDS: BotCommand[] = [
  { name: 'status', description: 'Что сейчас: состояние, кошелёк, ждёт тебя', run: status },
  { name: 'queue', description: 'Заявки, которые ждут решения', run: queue },
  {
    name: 'test',
    description: 'Подкинуть тестовую заявку',
    run: async (c) => (c.test ? c.test(c.args) : COMMAND_TEXTS.soon),
  },
  {
    name: 'test_clear',
    description: 'Стереть тестовое',
    run: async (c) => (c.test ? c.test('стереть') : COMMAND_TEXTS.soon),
  },
  { name: 'pause', description: 'Пауза: не пишу клиентам и не трачу деньги', run: pause },
  { name: 'resume', description: 'Снять паузу', run: resume },
  { name: 'pult', description: 'Открыть пульт', run: pult },
  { name: 'settings', description: 'Настройки: пороги заявок, паузы', run: settings },
  { name: 'forum', description: 'Привязать группу с темами' },
  { name: 'forum_off', description: 'Вернуть всё в личный чат' },
  { name: 'help', description: 'Что умеют команды', run: async () => helpText() },
]

export function helpText(): string {
  return ['Команды Сары:', ...COMMANDS.map((c) => `/${c.name}: ${c.description}`)].join('\n')
}
