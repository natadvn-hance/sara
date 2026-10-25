import { type EntityKind, type EntityRef, entityPath } from '@sara/shared'
import { Link } from './list'

const KIND: Record<EntityKind, string> = {
  account: 'Аккаунт',
  direction: 'Направление',
  lead: 'Заявка',
  client: 'Клиент',
  message: 'Сообщение',
  turn: 'Ход Сары',
  meeting: 'Встреча',
  task: 'Задача',
  question: 'Вопрос',
  knowledge: 'Знание',
  lesson: 'Урок',
  training: 'Тренировка',
  exam: 'Экзамен',
  setting: 'Настройка',
  event: 'Событие',
  cutover: 'Переключение',
}

/** FR-UI-2: a thing looks the same everywhere, and a tap opens its one home. */
export function EntityChip({ entity }: { entity: EntityRef }) {
  return (
    <Link
      href={entityPath(entity.kind, entity.id)}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-sm hover:border-muted"
    >
      <span className="text-muted">{`${KIND[entity.kind]}:`}</span>
      <span className="truncate">{entity.title}</span>
    </Link>
  )
}
