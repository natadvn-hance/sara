import { z } from 'zod'
import type { TaskAction } from './telegram'

/** The things of the entity map (ADR-013, M7 design section 4); each has one home in the pult. */
export const ENTITY_KINDS = [
  'account',
  'direction',
  'lead',
  'client',
  'message',
  'turn',
  'meeting',
  'task',
  'question',
  'knowledge',
  'lesson',
  'training',
  'exam',
  'setting',
  'event',
  'cutover',
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

const seg = encodeURIComponent

/**
 * FR-UI-2: the one home path of a thing, the same in the browser and in the Mini App. A message lives inside its
 * client, so its id is `<conversation>:<message>`; a task and a question have no home and open in the inbox.
 */
export function entityPath(kind: EntityKind, id: string): string {
  switch (kind) {
    case 'account':
      return `/accounts/${seg(id)}`
    case 'direction':
      return `/accounts/${seg(id)}/direction`
    case 'lead':
      return `/leads/${seg(id)}`
    case 'client':
      return `/clients/${seg(id)}`
    case 'message': {
      const at = id.indexOf(':')
      return `/clients/${seg(id.slice(0, at))}#m-${seg(id.slice(at + 1))}`
    }
    case 'turn':
      return `/journal/trace/${seg(id)}`
    case 'meeting':
      return `/meetings/${seg(id)}`
    case 'task':
    case 'question':
      return `/inbox#${seg(id)}`
    case 'knowledge':
      return `/mind/${seg(id)}`
    case 'lesson':
      return `/mind/lessons/${seg(id)}`
    case 'training':
      return `/training/${seg(id)}`
    case 'exam':
      return `/exams/${seg(id)}`
    case 'setting':
      return `/settings#${seg(id)}`
    case 'event':
      return `/journal?event=${seg(id)}`
    case 'cutover':
      return `/settings/switch#${seg(id)}`
  }
}

/** A thing as a chip: its kind, id and what the chip shows. */
export const EntityRefSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  id: z.string(),
  title: z.string(),
  sub: z.string().nullable(),
})
export type EntityRef = z.infer<typeof EntityRefSchema>

/** FR-UI-1: the fourteen sections of the pult, in menu order; four of them are the phone's bottom tabs. */
export const SECTIONS = [
  { id: 'today', title: 'Сегодня', path: '/', inTabs: true },
  { id: 'inbox', title: 'Входящие', path: '/inbox', inTabs: false },
  { id: 'leads', title: 'Заявки', path: '/leads', inTabs: true },
  { id: 'clients', title: 'Клиенты', path: '/clients', inTabs: true },
  { id: 'meetings', title: 'Встречи', path: '/meetings', inTabs: false },
  { id: 'mind', title: 'Разум', path: '/mind', inTabs: false },
  { id: 'training', title: 'Тренажёр', path: '/training', inTabs: false },
  { id: 'exams', title: 'Экзамены', path: '/exams', inTabs: false },
  { id: 'analytics', title: 'Аналитика', path: '/analytics', inTabs: false },
  { id: 'accounts', title: 'Аккаунты', path: '/accounts', inTabs: false },
  { id: 'settings', title: 'Настройки', path: '/settings', inTabs: true },
  { id: 'health', title: 'Состояние', path: '/health', inTabs: false },
  { id: 'journal', title: 'Журнал', path: '/journal', inTabs: false },
  { id: 'help', title: 'Справка', path: '/help', inTabs: false },
] as const
export type SectionId = (typeof SECTIONS)[number]['id']

export type TaskKindAction = {
  action: TaskAction
  label: string
  /** The action needs Boris's words (a reason, an answer). */
  needsText?: boolean
  /** Asked before the action goes. */
  confirm?: string
}

/**
 * FR-UI-6: what each kind of task the core creates can do in place, the same actions as its Telegram buttons. A kind
 * not listed here shows as a plain row that opens its thing.
 */
export const TASK_KINDS: Record<string, { title: string; actions: TaskKindAction[] }> = {
  lead_decision: {
    title: 'Решение по заявке',
    actions: [
      { action: 'bid', label: 'Откликнуться' },
      { action: 'skip', label: 'Пропустить' },
    ],
  },
  lead_review: { title: 'Заявка из сводки', actions: [{ action: 'want', label: 'Взял бы' }] },
  lead_held: { title: 'Заявка ждала в сводке', actions: [{ action: 'open', label: 'Показать' }] },
  rule_proposal: {
    title: 'Поправка правил',
    actions: [
      { action: 'apply', label: 'Применить' },
      { action: 'drop', label: 'Не надо' },
    ],
  },
}
