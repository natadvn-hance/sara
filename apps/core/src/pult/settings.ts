import { SETTINGS, type SettingKey, type SettingRow, type SettingsView } from '@sara/shared'
import { desc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/client'
import { account, directionVersion, setting, settingHistory } from '../db/schema'

/**
 * «Настройки» (M7 design 6.4). The pult changes money and card limits freely; a flag that takes Sara out of the
 * shadow it may only turn off (the pause), never on: that is a deploy step or the switch screen (anti-goal of M7).
 */

type Meta = { title: string; hint?: string; edit: SettingRow['edit']; kind: SettingRow['kind'] }

export const SETTING_META: Partial<Record<SettingKey, Meta>> = {
  'outbound.bids': {
    title: 'Тратит деньги на отклики',
    hint: 'Выключить можно здесь. Включает разработчик после проверок.',
    edit: 'stop_only',
    kind: 'flag',
  },
  'outbound.messages': {
    title: 'Пишет клиентам',
    hint: 'Выключить можно здесь. Включает разработчик после проверок.',
    edit: 'stop_only',
    kind: 'flag',
  },
  'conv.autopilot': {
    title: 'Автопилот разговоров',
    hint: 'Выключен: клиенту уходит только то, что ты отправил кнопкой «Отправить».',
    edit: 'stop_only',
    kind: 'flag',
  },
  'pipeline.leads': { title: 'Карточки заявок', edit: 'locked', kind: 'flag' },
  'pipeline.conversations': { title: 'Ведёт разговоры', edit: 'locked', kind: 'flag' },
  'conv.v1_writes': { title: 'Клиентам пишет старая Сара', edit: 'locked', kind: 'flag' },
  'conv.reminders': {
    title: 'Напоминает замолчавшим клиентам',
    hint: 'Выключить можно здесь. Включает разработчик.',
    edit: 'stop_only',
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
  'conv.cards_per_day': { title: 'Карточек разговоров в день', edit: 'free', kind: 'count' },
  'cards.quiet_hours': {
    title: 'Тихие часы карточек',
    hint: 'По Москве, карточки приходят без звука.',
    edit: 'locked',
    kind: 'hours',
  },
  'reminder.decision_after_min': {
    title: 'Повторить недошедшую карточку через, мин',
    edit: 'free',
    kind: 'count',
  },
  'conv.night': {
    title: 'Ночь для клиентов',
    hint: 'Ночью уходят только срочные ответы.',
    edit: 'locked',
    kind: 'hours',
  },
  'conv.reminder_quiet': { title: 'Без напоминаний клиентам', edit: 'locked', kind: 'hours' },
  'calls.offer': {
    title: 'Предлагает созвон после отклика',
    hint: 'Последнее сообщение серии: созвониться на полчаса, три времени на выбор.',
    edit: 'free',
    kind: 'flag',
  },
  'calls.work_hours': {
    title: 'Рабочие часы для созвонов',
    hint: 'По Москве. Выходные и время ближе двух часов не предлагаются.',
    edit: 'locked',
    kind: 'hours',
  },
  'links.blocked': {
    title: 'Ссылки, которые клиентам не даём',
    hint: 'Сайты, которые не работают или не для показа. Сара их не покажет нигде. Добавляет разработчик по твоему слову.',
    edit: 'locked',
    kind: 'other',
  },
  'calls.slot_min': { title: 'Длина созвона, мин', edit: 'free', kind: 'count' },
  'calls.min_ahead_min': { title: 'Созвон не раньше чем через, мин', edit: 'free', kind: 'count' },
}

const GROUPS: { id: string; title: string; keys: SettingKey[] }[] = [
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
    id: 'cards',
    title: 'Уведомления',
    keys: [
      'cards.max_per_day',
      'conv.cards_per_day',
      'reminder.decision_after_min',
      'cards.quiet_hours',
      'conv.night',
      'conv.reminder_quiet',
    ],
  },
  {
    id: 'calls',
    title: 'Созвоны и ссылки',
    keys: [
      'calls.offer',
      'calls.work_hours',
      'calls.slot_min',
      'calls.min_ahead_min',
      'links.blocked',
    ],
  },
]

/** Whether the pult may set this value: free keys any valid value, stop-only keys only `false`. */
export function pultMay(key: string, value: unknown): key is SettingKey {
  const m = SETTING_META[key as SettingKey]
  if (!m || m.edit === 'locked') return false
  if (m.edit === 'stop_only') return value === false
  return true
}

const titleOf = (key: string) => SETTING_META[key as SettingKey]?.title ?? key

export async function settingsView(db: DbOrTx): Promise<SettingsView> {
  const stored = new Map((await db.select().from(setting)).map((s) => [s.key, s]))
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
        edit: m.edit,
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
