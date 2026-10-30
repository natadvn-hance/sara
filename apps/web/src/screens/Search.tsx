import type { SearchHit, SearchView } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { navigate, queryOf, usePath } from '../app/router'
import { SECTIONS } from '../app/Shell'
import { Icon } from '../ui/icons'
import { A, Card, Empty, Head, Screen } from '../ui/kit'

/** The search (FR-UI-1, FR-UI-2): a thing opens from anywhere it is named, and so does every section. */

const KIND_ICON: Record<SearchHit['kind'], string> = {
  lead: 'leads',
  client: 'users',
  mind: 'mind',
  section: 'right',
  meeting: 'calendar',
}
const KIND_RU: Record<SearchHit['kind'], string> = {
  lead: 'заявка',
  client: 'клиент',
  mind: 'разум',
  section: 'раздел',
  meeting: 'встреча',
}

/** The pult's own sections match on the pult's side, so a section opens from the search without the core. */
function sectionHits(q: string): SearchHit[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  return SECTIONS.filter((s) => s.title.toLowerCase().includes(needle)).map((s) => ({
    kind: 'section',
    id: s.id,
    title: s.title,
    sub: null,
    link: s.to,
  }))
}

function Hits({ v }: { v: SearchView }) {
  const hits = [...sectionHits(v.q), ...v.hits]
  if (hits.length === 0)
    return (
      <Empty title="Ничего не нашла">
        Попробуй номер заказа, имя клиента, слово из темы заявки или название раздела.
      </Empty>
    )
  return (
    <div className="list">
      {hits.map((h) => (
        <A key={`${h.kind}:${h.id}`} to={h.link} className="row">
          <span className="score">
            <Icon name={KIND_ICON[h.kind]} />
          </span>
          <span className="row-main">
            <span className="row-title">{h.title}</span>
            <span className="row-sub">
              {KIND_RU[h.kind]}
              {h.sub ? ` · ${h.sub}` : ''}
            </span>
          </span>
          <span className="row-end">
            <Icon name="right" />
          </span>
        </A>
      ))}
    </div>
  )
}

export function SearchScreen() {
  const path = usePath()
  const q = queryOf(path)
  const [draft, setDraft] = useState(q)
  const res = useScreen<SearchView>(
    q.trim().length >= 2 ? `/api/search?q=${encodeURIComponent(q.trim())}` : null,
    0,
  )
  return (
    <div className="page">
      <Head title="Поиск" />
      <form
        className="search is-page"
        aria-label="Поиск"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(draft.trim())}`)
        }}
      >
        <Icon name="search" />
        <input
          id="search-page"
          aria-label="Поиск"
          placeholder="Номер заказа, клиент, тема…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
      <Card title={q ? `Нашла по «${q}»` : 'Что искать'} icon="search">
        {q.trim().length >= 2 ? (
          <Screen q={res}>{(v) => <Hits v={v} />}</Screen>
        ) : (
          <Empty title="Введи хотя бы два знака">
            Номер заказа находится первым; разделы пульта тоже ищутся.
          </Empty>
        )}
      </Card>
    </div>
  )
}
