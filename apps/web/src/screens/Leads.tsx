import type { LeadQueue, LeadView } from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { ago, count, rub, waited, waitTone } from '../app/format'
import { idOf, usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen } from '../ui/kit'

/** «Заявки» (M7 design 5.3): the queue by value, one lead with why its score, the разбор, the bid and the decision. */

const DECIDED: Record<LeadQueue['decided'][number]['decision'], string> = {
  bid: 'отклик',
  skip: 'пропущена',
  closed: 'закрылась',
  other: 'решена',
}

function Queue({ q, current }: { q: LeadQueue; current: string | null }) {
  return (
    <div className="grid">
      {q.paused ? <p className="callout tone-wait">{q.paused}</p> : null}
      <Card
        title="Ждут решения"
        icon="leads"
        end={<span className="mono muted">{q.queue.length}</span>}
      >
        {q.queue.length === 0 ? (
          <Empty title="Очередь пуста">
            Заявки, которые подходят под правила, появятся здесь, самая ценная сверху.
          </Empty>
        ) : (
          <div className="list">
            {q.queue.map((l) => (
              <A
                key={l.id}
                to={`/leads/${encodeURIComponent(l.id)}`}
                className="row"
                current={l.id === current}
              >
                <span className={`score${(l.score ?? 0) >= 70 ? ' is-high' : ''}`} title="балл">
                  {l.score ?? '?'}
                </span>
                <span className="row-main">
                  <span className="row-title">{l.title}</span>
                  <span className="row-sub">
                    {l.city} · <span className="mono">{rub(l.feeRub)}</span> ·{' '}
                    <span
                      style={{
                        color: `var(--${waitTone(l.seenAt) === 'ok' ? 'muted' : waitTone(l.seenAt) === 'warn' ? 'warn' : 'danger'})`,
                      }}
                    >
                      {waited(l.seenAt)}
                    </span>
                  </span>
                </span>
              </A>
            ))}
          </div>
        )}
        {q.older > 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Ещё {count(q.older, ['заявка старше', 'заявки старше', 'заявок старше'])} суток не
            показаны: на старый заказ отклик почти не окупается.
          </p>
        ) : null}
      </Card>
      {q.decided.length ? (
        <Card title="Решено за сутки" icon="check">
          <div className="list">
            {q.decided.map((d) => (
              <A
                key={d.id}
                to={`/leads/${encodeURIComponent(d.id)}`}
                className="row"
                current={d.id === current}
              >
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 400 }}>
                    {d.title}
                  </span>
                  <span className="row-sub">
                    {DECIDED[d.decision]} · {ago(d.at)}
                  </span>
                </span>
              </A>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

function Decide({ v }: { v: LeadView }) {
  const { press, busy } = usePress()
  const [confirm, setConfirm] = useState(false)
  const t = v.task
  if (!t) return null
  if (!t.open)
    return (
      <p className="callout tone-ok">
        Решено:{' '}
        {t.resolution === 'bid'
          ? 'отклик'
          : t.resolution === 'skip'
            ? 'пропущена'
            : (t.resolution ?? 'закрыта')}
        .
      </p>
    )
  const fee = v.lead.feeRub
  return (
    <div className="sticky-actions reveal">
      {v.obstacles.length ? (
        <div className="callout tone-warn">
          <strong>Сейчас отклик не уйдёт:</strong>
          <span>{v.obstacles.join(', ')}.</span>
          <A to="/settings" className="link">
            Лимиты и паузы
          </A>
        </div>
      ) : null}
      {confirm ? (
        <div className="grid" style={{ gap: 10 }}>
          <p>
            Потратить <strong>{rub(fee)}</strong> на отклик на «{v.lead.title}»?
          </p>
          <div className="actions">
            <Btn
              look="primary"
              icon="send"
              disabled={busy !== null}
              onClick={async () => {
                await press('bid', `/api/tasks/${t.id}/bid`, { expectedFeeRub: fee })
                setConfirm(false)
              }}
            >
              Да, откликнуться
            </Btn>
            <Btn onClick={() => setConfirm(false)}>Нет</Btn>
          </div>
        </div>
      ) : (
        <div className="actions">
          <Btn
            look="primary"
            icon="send"
            disabled={busy !== null || fee <= 0}
            onClick={() => setConfirm(true)}
          >
            {fee > 0 ? `Откликнуться за ${rub(fee)}` : 'Цена отклика неизвестна'}
          </Btn>
          <Btn disabled={busy !== null} onClick={() => press('skip', `/api/tasks/${t.id}/skip`)}>
            Пропустить
          </Btn>
        </div>
      )}
    </div>
  )
}

/** The bid text with its price range; while the decision is open it is edited here, the card in Telegram stays. */
function BidCard({ v }: { v: LeadView }) {
  const { press, busy } = usePress()
  const [draft, setDraft] = useState<{ text: string; price: string } | null>(null)
  const open = v.task?.open === true
  const text = draft ? draft.text : (v.bid.text ?? '')
  const over = text.length > v.bid.limit
  const price = draft
    ? draft.price.trim() === ''
      ? null
      : Number(draft.price)
    : v.bid.priceFromRub
  const priceOk = price === null || (Number.isInteger(price) && price > 0)
  return (
    <Card
      title="Отклик"
      icon="send"
      i={4}
      end={
        <span className="mono" style={{ color: over ? 'var(--danger)' : 'var(--muted)' }}>
          {text.length}/{v.bid.limit}
        </span>
      }
    >
      {draft ? (
        <div className="grid" style={{ gap: 12 }}>
          <label className="kv" htmlFor="bid-text">
            <span className="muted" style={{ fontSize: 13 }}>
              Текст отклика: приветствие Сара поставит сама по времени отправки
            </span>
            <textarea
              id="bid-text"
              className="quote"
              rows={9}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              style={{ font: 'inherit', color: 'inherit', resize: 'vertical' }}
            />
          </label>
          <label className="kv" htmlFor="bid-price" style={{ maxWidth: 260 }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Стоимость услуги «от», ₽ («до» Сара посчитает сама)
            </span>
            <input
              id="bid-price"
              className="quote mono"
              inputMode="numeric"
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/[^\d]/g, '') })}
              style={{ padding: '10px 14px' }}
            />
          </label>
          <div className="actions">
            <Btn
              look="primary"
              icon="check"
              disabled={busy !== null || over || !priceOk || text.trim() === ''}
              onClick={async () => {
                const ok = await press('text', `/api/leads/${encodeURIComponent(v.lead.id)}/text`, {
                  text: draft.text,
                  priceRub: price,
                })
                if (ok) setDraft(null)
              }}
            >
              Сохранить
            </Btn>
            <Btn onClick={() => setDraft(null)}>Отмена</Btn>
          </div>
        </div>
      ) : v.bid.text ? (
        <div className="quote">{v.bid.text}</div>
      ) : (
        <Empty title="Текста отклика ещё нет">Сара напишет его после разбора заявки.</Empty>
      )}
      {draft ? null : (
        <>
          <div className="chips">
            <Pill>
              Стоимость услуги:{' '}
              {v.bid.priceFromRub === null
                ? 'не указана'
                : `от ${rub(v.bid.priceFromRub)} до ${rub(v.bid.priceToRub)}`}
            </Pill>
            <Pill>Цена отклика: {rub(v.lead.feeRub)}</Pill>
          </div>
          {open ? (
            <div className="actions">
              <Btn
                size="sm"
                icon="book"
                onClick={() =>
                  setDraft({
                    text: v.bid.text ?? '',
                    price: v.bid.priceFromRub === null ? '' : String(v.bid.priceFromRub),
                  })
                }
              >
                Изменить текст
              </Btn>
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

function Lead({ v }: { v: LeadView }) {
  const l = v.lead
  const s = v.score
  return (
    <div className="grid">
      <A to="/leads" className="back">
        <Icon name="left" /> Заявки
      </A>
      <header className="grid reveal" style={{ gap: 10 }}>
        <div className="chips">
          <Pill>{l.category}</Pill>
          <Pill>{l.city}</Pill>
          {l.budgetText ? <Pill>бюджет {l.budgetText}</Pill> : null}
          <Pill tone={waitTone(l.seenAt)}>{waited(l.seenAt)}</Pill>
        </div>
        <h2 className="h2">{l.title}</h2>
        <p className="muted">
          {l.clientName || 'Клиент без имени'}
          {l.client?.since ? ` · ${l.client.since}` : ''}
          {l.client?.phone ? ' · номер подтверждён' : ''}
          {l.client?.reviews ? ` · ${l.client.reviews}` : ''}
        </p>
      </header>

      <Card title="Заказ" icon="book" i={1}>
        <p className="prose">{l.text}</p>
        <a className="link" href={l.url} target="_blank" rel="noreferrer">
          Открыть на Профи.ру <Icon name="external" />
        </a>
      </Card>

      {s ? (
        <Card
          title={`Почему ${s.value}`}
          icon="target"
          i={2}
          end={<span className="mono muted">правила v{s.rulesVersion}</span>}
        >
          <div className="num">
            <b>{s.value}</b>
            <small>{s.threshold === null ? 'баллов' : `из 100, порог ${s.threshold}`}</small>
          </div>
          <p>{s.reason}</p>
          {s.stopFactor ? <p className="callout tone-bad">Стоп-фактор: {s.stopFactor}</p> : null}
          {s.redFlags.length ? (
            <p className="callout tone-warn">Флаги: {s.redFlags.join(', ')}</p>
          ) : null}
          <div className="bars">
            {s.axes.map((a) => (
              <div className="bar" key={a.title}>
                <div className="bar-top">
                  <span>
                    {a.title}
                    {a.weight !== null ? (
                      <span className="muted mono"> · вес {a.weight}%</span>
                    ) : null}
                  </span>
                  <span className="mono">{a.score}</span>
                </div>
                <div className="bar-track">
                  <span style={{ width: `${a.score}%` }} />
                </div>
                <span className="muted" style={{ fontSize: 13 }}>
                  {a.why}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {v.analysis ? (
        <Card title="Разбор" icon="mind" i={3}>
          <dl className="grid grid-3" style={{ margin: 0 }}>
            <div className="kv">
              <dt>Скрытая потребность</dt>
              <dd>{v.analysis.hiddenNeed}</dd>
            </div>
            <div className="kv">
              <dt>Риск</dt>
              <dd>{v.analysis.risk}</dd>
            </div>
            <div className="kv">
              <dt>Условие</dt>
              <dd>{v.analysis.condition}</dd>
            </div>
          </dl>
          {v.analysis.reading.length ? (
            <details>
              <summary>
                <Icon name="right" /> Полный разбор
              </summary>
              <dl className="grid" style={{ marginTop: 14 }}>
                {v.analysis.reading.map((r) => (
                  <div className="kv" key={r.label}>
                    <dt>{r.label}</dt>
                    <dd className="text-2">{r.text}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </Card>
      ) : null}

      <BidCard v={v} />

      <Decide v={v} />
    </div>
  )
}

export function LeadsScreen() {
  const path = usePath()
  const id = idOf(path, 'leads')
  const list = useScreen<LeadQueue>('/api/leads')
  const one = useScreen<LeadView>(id ? `/api/leads/${encodeURIComponent(id)}` : null)
  return (
    <div className={`page${id ? ' has-detail' : ''}`}>
      <Head
        eyebrow="Очередь по ценности"
        title="Заявки,"
        accent="которые ждут"
        after="тебя"
        lead="Сверху самая ценная: балл, потом цена отклика. Решение здесь то же, что кнопка на карточке в Telegram."
      />
      <div className={`split${id ? ' has-detail' : ''}`}>
        <div className="split-list">
          <Screen q={list}>{(q) => <Queue q={q} current={id} />}</Screen>
        </div>
        <div className="split-detail">
          {id ? (
            <Screen q={one}>{(v) => <Lead v={v} />}</Screen>
          ) : (
            <Card title="Заявка" icon="leads">
              <Empty title="Выбери заявку слева">
                Здесь будут заказ, почему такой балл, разбор Сары, текст отклика и решение.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
