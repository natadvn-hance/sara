import type { MindRecordView, MindView } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { ago, count } from '../app/format'
import { idOf, usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Card, Empty, Head, Pill, Screen, Seg } from '../ui/kit'

/** «Разум Сары» (M7 design 5.5), read only: records by part, proposals waiting for Boris's «да», what she lacked. */

const STATE_RU: Record<string, string> = {
  new: 'ждёт «да»',
  accepted: 'принято',
  rejected: 'отклонено',
  exported: 'у разработчика',
  written: 'записано',
}

function Overview({ v, current }: { v: MindView; current: string | null }) {
  const [type, setType] = useState(
    v.groups.find((g) => g.records.length)?.type ?? v.groups[0]?.type ?? '',
  )
  const group = v.groups.find((g) => g.type === type)
  return (
    <div className="grid">
      <Card
        title="Записи"
        icon="mind"
        end={
          <span className="mono muted">
            {v.mindVersion ? `версия ${v.mindVersion.slice(0, 7)}` : 'разум пуст'}
          </span>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <Seg
            label="Часть разума"
            value={type}
            onChange={setType}
            options={v.groups.map((g) => ({
              value: g.type,
              label: `${g.title} ${g.records.length}`,
            }))}
          />
        </div>
        {group && group.records.length ? (
          <div className="list">
            {group.records.map((r) => (
              <A
                key={r.id}
                to={`/mind/${encodeURIComponent(r.id)}`}
                className="row"
                current={r.id === current}
              >
                <span className="row-main">
                  <span className="row-title">{r.title}</span>
                  <span className="row-sub">
                    {r.scope === 'common' ? 'общее для Hance' : r.scope}
                    {r.topic ? ` · ${r.topic}` : ''} · v{r.version}
                  </span>
                </span>
                <span className="row-end mono">{r.id}</span>
              </A>
            ))}
          </div>
        ) : (
          <Empty title="В этой части пока пусто">
            Записи появятся после твоего «да» на предложения Сары.
          </Empty>
        )}
      </Card>
      <Card
        title="Предложения"
        icon="bell"
        end={<span className="mono muted">{v.proposals.length}</span>}
      >
        {v.proposals.length === 0 ? (
          <Empty title="Предложений нет">
            Когда Сара чему-то научится, она предложит запись, и та ждёт твоего «да».
          </Empty>
        ) : (
          <div className="list">
            {v.proposals.map((p) => (
              <div key={p.id} className="row" style={{ cursor: 'default' }}>
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 400 }}>
                    {p.preview || p.path}
                  </span>
                  <span className="row-sub">
                    {p.kind} · {p.action === 'create' ? 'новая' : 'правка'} · {ago(p.at)}
                  </span>
                </span>
                <span className="row-end">
                  <Pill tone={p.state === 'new' ? 'wait' : 'ok'}>
                    {STATE_RU[p.state] ?? p.state}
                  </Pill>
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Разум меняется только после твоего «да»: здесь только посмотреть.
        </p>
      </Card>
      {v.gaps.length ? (
        <Card title="Чего не хватало за 30 дней" icon="alert">
          <div className="list">
            {v.gaps.map((g) => (
              <div key={`${g.text}-${g.topic}`} className="row" style={{ cursor: 'default' }}>
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 400 }}>
                    {g.text}
                  </span>
                  <span className="row-sub">{count(g.count, ['раз', 'раза', 'раз'])}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function RecordView({ v }: { v: MindRecordView }) {
  const r = v.record
  return (
    <div className="grid">
      <A to="/mind" className="back">
        <Icon name="left" /> Разум
      </A>
      <header className="grid reveal" style={{ gap: 10 }}>
        <div className="chips">
          <Pill>{r.type}</Pill>
          <Pill>{r.scope === 'common' ? 'общее для Hance' : r.scope}</Pill>
          <Pill>версия {r.version}</Pill>
          {r.topic ? <Pill>{r.topic}</Pill> : null}
        </div>
        <h2 className="h2">{r.title}</h2>
        <p className="muted mono">
          {r.id} · {r.path}
        </p>
      </header>
      <Card title="Запись" icon="book" i={1}>
        <p className="prose">{r.body}</p>
        {r.exampleClient || r.exampleBoris ? (
          <div className="chat">
            {r.exampleClient ? <div className="bubble">{r.exampleClient}</div> : null}
            {r.exampleBoris ? <div className="bubble is-us">{r.exampleBoris}</div> : null}
          </div>
        ) : null}
        {r.tones.length || r.stages.length ? (
          <div className="chips">
            {[...r.tones, ...r.stages].map((x) => (
              <Pill key={x}>{x}</Pill>
            ))}
          </div>
        ) : null}
      </Card>
      <Card title="Где использована" icon="chat" i={2}>
        {v.used.length === 0 ? (
          <Empty title="Пока ни в одном ответе" />
        ) : (
          <div className="list">
            {v.used.map((u) => (
              <A key={u.turnId} to={`/conversations/${u.conversationId}`} className="row">
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 400 }}>
                    Ответ клиенту
                  </span>
                  <span className="row-sub">{ago(u.at)}</span>
                </span>
                <span className="row-end">
                  <Icon name="right" />
                </span>
              </A>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export function MindScreen() {
  const path = usePath()
  const id = idOf(path, 'mind')
  const all = useScreen<MindView>('/api/mind', 60_000)
  const one = useScreen<MindRecordView>(id ? `/api/mind/${encodeURIComponent(id)}` : null, 60_000)
  return (
    <div className={`page${id ? ' has-detail' : ''}`}>
      <Head
        eyebrow="Только чтение"
        title="Разум"
        accent="Сары"
        lead="Что она знает о Hance и клиентах, как говорит и что предлагает выучить. Меняется только после твоего «да»."
      />
      <div className={`split${id ? ' has-detail' : ''}`}>
        <div className="split-list">
          <Screen q={all}>{(v) => <Overview v={v} current={id} />}</Screen>
        </div>
        <div className="split-detail">
          {id ? (
            <Screen q={one}>{(v) => <RecordView v={v} />}</Screen>
          ) : (
            <Card title="Запись" icon="mind">
              <Empty title="Выбери запись слева">
                Здесь будет её текст, примеры и ответы, где Сара на неё опиралась.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
