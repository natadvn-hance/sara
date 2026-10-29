import type { InboxView } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { count } from '../app/format'
import { Card, Empty, Head, Screen, Seg } from '../ui/kit'
import { TaskRow } from '../ui/task'

/**
 * «Входящие» (FR-UI-6, pult v2 design 3): everything that waits for Boris in one list, the urgent and the old on
 * top, decided right here. Nothing is stored: it is the open tasks and questions of the core.
 */

type Filter = 'all' | 'leads' | 'clients' | 'questions'

const OF: Record<Filter, (kind: string, source: string) => boolean> = {
  all: () => true,
  leads: (k) => k.startsWith('lead_') || k === 'rule_proposal',
  clients: (k) => k.startsWith('conv_'),
  questions: (_k, s) => s === 'question',
}

function Body({ v }: { v: InboxView }) {
  const [filter, setFilter] = useState<Filter>('all')
  const items = v.items.filter((i) => OF[filter](i.kind, i.source))
  const urgent = items.filter((i) => i.urgent)
  const rest = items.filter((i) => !i.urgent)
  if (v.items.length === 0)
    return (
      <Card title="Ничего не ждёт тебя" icon="check">
        <Empty title="Всё решено">
          Новые заявки, черновики ответов и вопросы Сары появятся здесь сами, и каждое решается в
          одно-два нажатия.
        </Empty>
      </Card>
    )
  return (
    <div className="grid">
      <div style={{ overflowX: 'auto' }}>
        <Seg
          label="Что показать"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Всё ${v.items.length}` },
            { value: 'leads', label: `Заявки ${v.counts.leads}` },
            { value: 'clients', label: `Клиенты ${v.counts.drafts}` },
            { value: 'questions', label: `Вопросы ${v.counts.questions}` },
          ]}
        />
      </div>
      {urgent.length ? (
        <Card
          title="Срочно"
          icon="alert"
          i={1}
          end={<span className="mono muted">{urgent.length}</span>}
        >
          <ol className="tasks">
            {urgent.map((i) => (
              <TaskRow key={i.id} item={i} />
            ))}
          </ol>
        </Card>
      ) : null}
      <Card
        title={urgent.length ? 'Остальное' : 'Ждёт тебя'}
        icon="inbox"
        i={2}
        end={<span className="mono muted">{count(rest.length, ['дело', 'дела', 'дел'])}</span>}
      >
        {rest.length === 0 ? (
          <Empty title="Здесь пусто" />
        ) : (
          <ol className="tasks">
            {rest.map((i) => (
              <TaskRow key={i.id} item={i} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}

export function InboxScreen() {
  const q = useScreen<InboxView>('/api/inbox')
  return (
    <div className="page">
      <Head
        eyebrow="Решения в одно нажатие"
        title="Входящие,"
        accent="что ждёт"
        after="тебя"
        lead="Заявки, черновики ответов, вопросы Сары и срочное. Нажатие здесь то же, что кнопка на карточке в Telegram: карточка там закроется сама."
      />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
