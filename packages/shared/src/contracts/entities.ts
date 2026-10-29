import type { TaskAction } from './telegram'

/**
 * The map of things (M7 design 4, pult v2 design 2): every thing has one home in the pult, and every place that
 * names it links there. The paths are the same in the browser and in the Mini App.
 */
export const ENTITY_KINDS = [
  'lead',
  'client',
  'meeting',
  'mind',
  'setting',
  'account',
  'journal',
  'notice',
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

export function entityPath(kind: EntityKind, id: string): string {
  const safe = encodeURIComponent(id)
  switch (kind) {
    case 'lead':
      return `/leads/${safe}`
    case 'client':
      return `/clients/${safe}`
    case 'meeting':
      return `/meetings/${safe}`
    case 'mind':
      return `/mind/${safe}`
    case 'setting':
      return `/settings#${safe}`
    case 'account':
      return `/settings/rules/${safe}`
    case 'journal':
      return `/journal/trace/${safe}`
    case 'notice':
      return `/notices#${safe}`
  }
}

/** The six kinds of notifications (FR-NOTIF-1, spec 7.11), the same in Telegram and in the pult's bell. */
export const NOTICE_KINDS = [
  'lead',
  'draft',
  'client',
  'meeting',
  'urgent',
  'summary',
  'system',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export const NOTICE_KIND_RU: Record<NoticeKind, string> = {
  lead: 'Заявка',
  draft: 'Черновик',
  client: 'Клиент написал',
  meeting: 'Встреча',
  urgent: 'Срочно',
  summary: 'Сводка',
  system: 'Сара',
}

/** What a press needs beside the press itself: the fee Boris saw, a reason, his text, or a second press. */
export type ActionNeeds = 'fee' | 'reason' | 'text' | 'confirm' | null

export type TaskActionSpec = {
  action: TaskAction
  label: string
  look: 'primary' | 'ghost' | 'danger'
  needs: ActionNeeds
}

const a = (
  action: TaskAction,
  label: string,
  look: TaskActionSpec['look'] = 'ghost',
  needs: ActionNeeds = null,
): TaskActionSpec => ({ action, label, look, needs })

/**
 * Every kind of task the core makes and what Boris can do with it on the spot (FR-UI-6). The Inbox builds its rows
 * from this table; a kind that is not here shows «Открыть» alone and breaks nothing.
 */
export const TASK_KINDS: Record<string, { title: string; actions: TaskActionSpec[] }> = {
  lead_decision: {
    title: 'Заявка ждёт решения',
    actions: [
      a('bid', 'Откликнуться', 'primary', 'fee'),
      a('skip', 'Пропустить', 'ghost', 'reason'),
    ],
  },
  lead_review: {
    title: 'Отсеянная заявка из сводки',
    actions: [a('want', 'Взял бы', 'primary')],
  },
  lead_held: {
    title: 'Заявка сверх лимита карточек',
    actions: [a('open', 'Показать', 'primary')],
  },
  rule_proposal: {
    title: 'Поправка правил отбора',
    actions: [a('apply', 'Применить', 'primary', 'confirm'), a('drop', 'Не надо')],
  },
  conv_draft: {
    title: 'Черновик ответа клиенту',
    actions: [
      a('send', 'Отправить', 'primary'),
      a('take', 'Беру сам'),
      a('close', 'Закрыть', 'danger', 'confirm'),
    ],
  },
  conv_reminder: {
    title: 'Напоминание клиенту',
    actions: [a('send', 'Отправить', 'primary'), a('skip', 'Не надо')],
  },
  conv_dormant: {
    title: 'Клиент молчит',
    actions: [a('close', 'Закрыть', 'danger', 'confirm')],
  },
  conv_say: {
    title: 'Твой текст клиенту',
    actions: [a('send', 'Отправить', 'primary'), a('skip', 'Не надо')],
  },
}

/** The question kinds Sara asks Boris and how each reads in the Inbox. */
export const QUESTION_KINDS: Record<string, { title: string; answer: string }> = {
  why_skip: { title: 'Почему пропустил?', answer: 'Причина' },
  why_want: { title: 'Почему взял бы?', answer: 'Причина' },
  why_decline: { title: 'Почему не надо поправку?', answer: 'Причина' },
  edit_draft: { title: 'Жду новый текст отклика', answer: 'Текст отклика' },
  edit_price: { title: 'Жду стоимость услуги', answer: 'Цена, ₽' },
  conv_edit: { title: 'Жду твой вариант ответа клиенту', answer: 'Текст клиенту' },
}
