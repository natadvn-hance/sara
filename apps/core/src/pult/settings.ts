import { SETTINGS, type SettingKey, type SettingRow, type SettingsView } from '@sara/shared'
import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { account, directionVersion, setting, settingHistory } from '../db/schema'
import { getSetting } from '../settings/store'

/**
 * «Настройки» (M7 design 6.4). The pult changes money and card limits freely; a flag that takes Sara out of the
 * shadow it may only turn off (the pause), never on: that is a deploy step or the switch screen (anti-goal of M7).
 */

type Meta = { title: string; hint?: string; edit: SettingRow['edit']; kind: SettingRow['kind'] }

export const SETTING_META: Partial<Record<SettingKey, Meta>> = {
  'outbound.bids': {
    title: 'Тратит деньги на отклики',
    hint: 'Выключено: «Откликнуться» ничего не тратит и отвечает, что пауза. Каждый отклик всё равно только по твоему нажатию.',
    edit: 'confirm',
    kind: 'flag',
  },
  'outbound.messages': {
    title: 'Пишет клиентам',
    hint: 'Выключено: даже твоё «Отправить» ждёт, пока не включишь. В режиме черновиков клиенту уходит только нажатое.',
    edit: 'confirm',
    kind: 'flag',
  },
  'conv.autopilot': {
    title: 'Автопилот разговоров',
    hint: 'Выключен: клиенту уходит только то, что ты отправил кнопкой «Отправить». Включается после экзамена Сары, не отсюда.',
    edit: 'stop_only',
    kind: 'flag',
  },
  'pipeline.leads': { title: 'Карточки заявок', edit: 'locked', kind: 'flag' },
  'pipeline.conversations': { title: 'Ведёт разговоры', edit: 'locked', kind: 'flag' },
  'conv.v1_writes': { title: 'Клиентам пишет старая Сара', edit: 'locked', kind: 'flag' },
  'conv.reminders': {
    title: 'Напоминает замолчавшим клиентам',
    hint: 'Напоминание приходит тебе черновиком, клиенту уходит только по «Отправить».',
    edit: 'confirm',
    kind: 'flag',
  },
  'school.on': { title: 'Ночная школа', edit: 'locked', kind: 'flag' },
  'money.daily_bids': { title: 'Откликов в день', edit: 'free', kind: 'count' },
  'money.daily_budget_rub': {
    title: 'Бюджет в день',
    hint: 'Пусто: без ограничения.',
    edit: 'free',
    kind: 'rub',
  },
  'money.max_fee_rub': {
    title: 'Не дороже за отклик',
    hint: 'Пусто: без ограничения.',
    edit: 'free',
    kind: 'rub',
  },
  'cards.max_per_day': { title: 'Карточек заявок в день', edit: 'free', kind: 'count' },
  'screen.stops': {
    title: 'Отсев останавливает заявки',
    hint: 'Выключен: отсев только отмечает заявки, карточки идут как раньше.',
    edit: 'free',
    kind: 'flag',
  },
  'screen.min_own_words': {
    title: 'Отсев: меньше скольких своих слов',
    hint: 'Ответы формы Профи.ру не считаются.',
    edit: 'free',
    kind: 'count',
  },
  'conv.cards_per_day': { title: 'Карточек разговоров в день', edit: 'free', kind: 'count' },
  'cards.quiet_hours': {
    title: 'Тихие часы',
    hint: 'По Москве: карточки и push приходят без звука, срочное звонит всегда.',
    edit: 'free',
    kind: 'hours',
  },
  'pult.tabs': {
    title: 'Вкладки внизу',
    hint: 'Четыре раздела внизу телефона и Mini App, остальное в «Ещё».',
    edit: 'free',
    kind: 'other',
  },
  'pult.switch_on': {
    title: 'Включать паузы и отправку из пульта',
    hint: 'Вторым нажатием. Выключено: из пульта их можно только выключить.',
    edit: 'confirm',
    kind: 'flag',
  },
  'notify.push': {
    title: 'Push на телефон и компьютер',
    hint: 'Что звонит на телефоне и компьютере. В Telegram приходит всё, как раньше.',
    edit: 'free',
    kind: 'other',
  },
  'reminder.decision_after_min': {
    title: 'Повторить недошедшую карточку через, мин',
    edit: 'free',
    kind: 'count',
  },
  'conv.night': {
    title: 'Ночь для клиентов',
    hint: 'По Москве: ночью клиентам уходят только срочные ответы.',
    edit: 'free',
    kind: 'hours',
  },
  'conv.reminder_quiet': {
    title: 'Без напоминаний клиентам',
    hint: 'По Москве.',
    edit: 'free',
    kind: 'hours',
  },
  'secretary.turns_per_day': {
    title: 'Ответов Сары в чате в день',
    hint: 'Разговор с Сарой идёт на Opus и тратит общую подписку Claude.',
    edit: 'free',
    kind: 'count',
  },
}

const GROUPS: { id: string; title: string; keys: SettingKey[] }[] = [
  { id: 'pult', title: 'Пульт', keys: ['pult.tabs', 'pult.switch_on'] },
  {
    id: 'work',
    title: 'Работа',
    keys: [
      'outbound.bids',
      'outbound.messages',
      'conv.autopilot',
      'conv.reminders',
      'pipeline.leads',
      'pipeline.conversations',
      'conv.v1_writes',
      'school.on',
    ],
  },
  {
    id: 'money',
    title: 'Деньги',
    keys: ['money.daily_bids', 'money.daily_budget_rub', 'money.max_fee_rub'],
  },
  {
    id: 'screen',
    title: 'Отсев',
    keys: ['screen.stops', 'screen.min_own_words'],
  },
  {
    id: 'cards',
    title: 'Уведомления',
    keys: [
      'cards.max_per_day',
      'conv.cards_per_day',
      'reminder.decision_after_min',
      'cards.quiet_hours',
      'notify.push',
      'conv.night',
      'conv.reminder_quiet',
      'secretary.turns_per_day',
    ],
  },
]

/**
 * Whether the pult may set this value: free keys any valid value; a pause or an outgoing switch off always and on
 * only with Boris's second press (`confirm`); stop-only keys only `false`; locked keys never.
 */
export function pultMay(key: string, value: unknown, confirm = false): key is SettingKey {
  const m = SETTING_META[key as SettingKey]
  if (!m || m.edit === 'locked') return false
  if (m.edit === 'stop_only') return value === false
  if (m.edit === 'confirm') return value === false || confirm
  return true
}

const titleOf = (key: string) => SETTING_META[key as SettingKey]?.title ?? key

/** The keys that turn on with a second press only while «Включать паузы и отправку из пульта» is on. */
export const SWITCH_ON_KEYS: SettingKey[] = ['outbound.bids', 'outbound.messages', 'conv.reminders']

export async function settingsView(db: DbOrTx): Promise<SettingsView> {
  const stored = new Map((await db.select().from(setting)).map((s) => [s.key, s]))
  const switchOn = await getSetting(db, 'pult.switch_on')
  const groups = GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    rows: g.keys.map((key): SettingRow => {
      const m = SETTING_META[key] as Meta
      const s = stored.get(key)
      const parsed = s ? SETTINGS[key].schema.safeParse(s.value) : null
      return {
        key,
        title: m.title,
        hint: m.hint ?? null,
        value: parsed?.success ? parsed.data : SETTINGS[key].default,
        isDefault: !s,
        // With the choice off these only turn off from the pult, and the screen shows it so.
        edit: !switchOn && SWITCH_ON_KEYS.includes(key) ? 'stop_only' : m.edit,
        kind: m.kind,
        changedAt: s?.changedAt ?? null,
        changedBy: s?.changedBy ?? null,
      }
    }),
  }))
  const accounts = await db.select().from(account).orderBy(account.id)
  const directions: SettingsView['directions'] = []
  for (const a of accounts) {
    const [v] = await db
      .select()
      .from(directionVersion)
      .where(eq(directionVersion.accountId, a.id))
      .orderBy(desc(directionVersion.active), desc(directionVersion.version))
      .limit(1)
    const r = v?.rules as
      | {
          threshold: number
          stop_factors: { text: string }[]
          axes: { title: string; weight: number }[]
        }
      | undefined
    if (!v || !r) continue
    directions.push({
      accountId: a.id,
      title: a.title,
      version: v.version,
      threshold: r.threshold,
      stops: r.stop_factors.map((s) => s.text),
      axes: r.axes.map((x) => ({ title: x.title, weight: x.weight })),
    })
  }
  const history = await db.select().from(settingHistory).orderBy(desc(settingHistory.id)).limit(30)
  return {
    groups,
    directions,
    history: history.map((h) => ({
      key: h.key,
      title: titleOf(h.key),
      value: h.value,
      by: h.changedBy,
      at: h.changedAt,
    })),
  }
}
