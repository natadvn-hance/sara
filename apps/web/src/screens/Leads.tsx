import {
  type LeadQueue,
  type LeadRow,
  type LeadView,
  type QueueOrder,
  SCREEN_RU,
  type ScorePart,
} from '@sara/shared'
import { useState } from 'react'
import { usePress, useScreen } from '../app/data'
import { ago, count, rub, waited, waitTone } from '../app/format'
import { idOf, usePath } from '../app/router'
import { Icon } from '../ui/icons'
import { A, Btn, Card, Empty, Head, Pill, Screen, Seg } from '../ui/kit'
import { HoldBar, SKIP_REASONS } from '../ui/task'

/** «Заявки» (M7 design 5.3): the queue by value, one lead with why its score, the разбор, the bid and the decision. */

const DECIDED: Record<LeadQueue['decided'][number]['decision'], string> = {
  bid: 'отклик',
  skip: 'пропущена',
  closed: 'закрылась',
  other: 'решена',
}

const ORDER_KEY = 'sara.leads.order'

/** The order Boris chose last time on this device; the two numbers together by default. */
function readOrder(): QueueOrder {
  try {
    const o = window.localStorage.getItem(ORDER_KEY)
    return o === 'fit' || o === 'chance' ? o : 'combined'
  } catch {
    return 'combined'
  }
}

const ORDER_RU: Record<QueueOrder, string> = {
  combined: 'Вместе',
  fit: 'Насколько наше',
  chance: 'Шанс',
}

/** The two numbers of a lead in one line: «наше 72 · шанс считается». */
function Numbers({ r }: { r: LeadRow }) {
  const fit = r.scores?.fit.value ?? r.score
  const chance = r.scores?.chance.value ?? null
  return (
    <span className="nums">
      <span className="num-pill">
        наше <b>{fit ?? '?'}</b>
      </span>
      <span className={`num-pill${chance === null ? ' is-pending' : ''}`}>
        шанс <b>{chance ?? 'считается'}</b>
      </span>
    </span>
  )
}

function QueueRow({ r, current }: { r: LeadRow; current: string | null }) {
  const tone = waitTone(r.seenAt)
  return (
    <A to={`/leads/${encodeURIComponent(r.id)}`} className="row" current={r.id === current}>
      <span className="row-main">
        <span className="row-title">{r.title}</span>
        <span className="row-sub">
          {r.city} · <span className="mono">{rub(r.feeRub)}</span> ·{' '}
          <span className={tone === 'ok' ? '' : `tone-${tone === 'warn' ? 'warn' : 'bad'}`}>
            {waited(r.seenAt)}
          </span>
          {r.heldUntil ? ' · откликаюсь' : ''}
        </span>
        <Numbers r={r} />
      </span>
    </A>
  )
}

function Queue({
  q,
  current,
  order,
  setOrder,
}: {
  q: LeadQueue
  current: string | null
  order: QueueOrder
  setOrder: (o: QueueOrder) => void
}) {
  const [view, setView] = useState<'queue' | 'decided'>('queue')
  return (
    <div className="grid">
      {q.paused ? <p className="callout tone-wait">{q.paused}</p> : null}
      <div className="toolbar">
        <Seg
          label="Какие заявки"
          value={view}
          onChange={setView}
          options={[
            { value: 'queue', label: `Ждут ${q.queue.length}` },
            { value: 'decided', label: 'Решённые' },
          ]}
        />
        {view === 'queue' ? (
          <Seg
            label="Порядок"
            value={order}
            onChange={setOrder}
            options={(['combined', 'fit', 'chance'] as const).map((o) => ({
              value: o,
              label: ORDER_RU[o],
            }))}
          />
        ) : null}
      </div>
      {view === 'queue' ? (
        <Card>
          {q.queue.length === 0 ? (
            <Empty title="Очередь пуста">
              Подходящие заявки появятся здесь, самая ценная сверху.
            </Empty>
          ) : (
            <div className="list">
              {q.queue.map((r) => (
                <QueueRow key={r.id} r={r} current={current} />
              ))}
            </div>
          )}
          {q.older > 0 ? (
            <p className="muted small">
              Ещё {count(q.older, ['заявка старше', 'заявки старше', 'заявок старше'])} суток не
              показаны.
            </p>
          ) : null}
        </Card>
      ) : (
        <Card>
          {q.decided.length === 0 ? (
            <Empty title="За месяц решений не было" />
          ) : (
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
                      {DECIDED[d.decision]}
                      {d.reason ? `, ${d.reason}` : ''} · {ago(d.at)}
                      {d.decision === 'bid' ? ` · ${rub(d.feeRub)}` : ''}
                    </span>
                  </span>
                </A>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

/**
 * The decision: «Откликнуться» waits ten seconds in the core and can be cancelled; «Пропустить» asks why here, one
 * tap on a reason or none; «Перепроверить» reads the order page now.
 */
function Decide({ v }: { v: LeadView }) {
  const { press, busy } = usePress()
  const [skipping, setSkipping] = useState(false)
  const [reason, setReason] = useState('')
  const t = v.task
  if (!t) return null
  if (!t.open)
    return (
      <p className="callout tone-ok">
        Решено:{' '}
        {t.resolution === 'bid'
          ? 'отклик'
          : t.resolution === 'skip'
            ? `пропущена${v.label?.reason ? `, ${v.label.reason}` : ''}`
            : (t.resolution ?? 'закрыта')}
        .
      </p>
    )
  const fee = v.lead.feeRub
  const base = `/api/leads/${encodeURIComponent(v.lead.id)}`
  const skip = (why: string | null) => press('skip', `${base}/skip`, why ? { reason: why } : {})
  return (
    <div className="sticky-actions">
      {v.obstacles.length ? (
        <p className="callout tone-warn">
          Сейчас отклик не уйдёт: {v.obstacles.join(', ')}.{' '}
          <A to="/settings" className="link">
            Лимиты и паузы
          </A>
        </p>
      ) : null}
      {v.hold ? (
        <HoldBar executeAt={v.hold.executeAt} feeRub={fee} cancelPath={`${base}/bid/cancel`} />
      ) : skipping ? (
        <div className="grid" style={{ gap: 8 }}>
          <span className="text-2">Почему пропускаешь? Можно без причины.</span>
          <div className="chips">
            {SKIP_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                className="pill is-btn"
                disabled={busy !== null}
                onClick={() => skip(r)}
              >
                {r}
              </button>
            ))}
            <button
              type="button"
              className="pill is-btn"
              disabled={busy !== null}
              onClick={() => skip(null)}
            >
              без причины
            </button>
          </div>
          <div className="actions">
            <input
              className="field"
              aria-label="Причина своими словами"
              placeholder="Или своими словами"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Btn
              size="sm"
              look="primary"
              disabled={busy !== null || !reason.trim()}
              onClick={() => skip(reason.trim())}
            >
              Пропустить
            </Btn>
            <Btn size="sm" onClick={() => setSkipping(false)}>
              Отмена
            </Btn>
          </div>
        </div>
      ) : (
        <div className="actions">
          <Btn
            look="primary"
            icon="send"
            disabled={busy !== null || fee <= 0}
            onClick={() => press('bid', `${base}/bid`, { expectedFeeRub: fee })}
          >
            {fee > 0 ? `Откликнуться за ${rub(fee)}` : 'Цена отклика неизвестна'}
          </Btn>
          <Btn disabled={busy !== null} onClick={() => setSkipping(true)}>
            Пропустить
          </Btn>
          <Btn
            size="sm"
            icon="refresh"
            disabled={busy !== null}
            onClick={() => press('recheck', `${base}/recheck`)}
          >
            Перепроверить
          </Btn>
        </div>
      )}
    </div>
  )
}

/** One of the two numbers with its reasons; a number still being worked out says so. */
function ScoreBlock({
  title,
  part,
  hint,
}: {
  title: string
  part: ScorePart | undefined
  hint: string
}) {
  const value = part?.value ?? null
  return (
    <div className="score-block">
      <div className="num">
        <b className={value === null ? 'is-pending' : ''}>{value ?? 'считается'}</b>
        <small>{title}</small>
      </div>
      {part && part.reasons.length ? (
        <ul className="reasons">
          {part.reasons.slice(0, 4).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{hint}</p>
      )}
    </div>
  )
}

/**
 * The places of the series after the bid (Boris, 29.10.2026): the links, two lines and the call offer (30.10.2026);
 * an empty one is not sent.
 */
const FOLLOW_UP_SLOTS = ['first', 'second', 'third', 'fourth'] as const

/** The bid text with its price range; while the decision is open it is edited here, the card in Telegram stays. */
function BidCard({ v }: { v: LeadView }) {
  const { press, busy } = usePress()
  const [draft, setDraft] = useState<{ text: string; price: string; followUps: string[] } | null>(
    null,
  )
  const open = v.task?.open === true
  const text = draft ? draft.text : (v.bid.text ?? '')
  const over = text.length > v.bid.limit
  const seriesOver = (draft?.followUps ?? []).some((f) => f.trim().length > v.bid.followUpLimit)
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
          {FOLLOW_UP_SLOTS.map((slot, k) => (
            <label key={slot} className="kv" htmlFor={`bid-follow-${slot}`}>
              <span className="muted" style={{ fontSize: 13 }}>
                Вдогонку {k + 1}: через 1-2 минуты после отклика, если клиент ещё не ответил. Пусто:
                не отправлять. {'{слоты}'} Сара заменит на три времени для созвона
              </span>
              <textarea
                id={`bid-follow-${slot}`}
                className="quote"
                rows={3}
                value={draft.followUps[k] ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    followUps: draft.followUps.map((x, j) => (j === k ? e.target.value : x)),
                  })
                }
                style={{ font: 'inherit', color: 'inherit', resize: 'vertical' }}
              />
            </label>
          ))}
          <div className="actions">
            <Btn
              look="primary"
              icon="check"
              disabled={busy !== null || over || seriesOver || !priceOk || text.trim() === ''}
              onClick={async () => {
                const ok = await press('text', `/api/leads/${encodeURIComponent(v.lead.id)}/text`, {
                  text: draft.text,
                  priceRub: price,
                  followUps: draft.followUps.map((f) => f.trim()).filter((f) => f !== ''),
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
        <>
          <div className="quote">{v.bid.text}</div>
          {v.bid.followUps.length > 0 ? (
            <div className="grid" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 13 }}>
                Вдогонку, через 1-2 минуты после отклика. Уйдёт тем же нажатием, если клиент ещё не
                ответил
              </span>
              {v.bid.followUps.map((f) => (
                <div key={f} className="quote" style={{ whiteSpace: 'pre-line' }}>
                  {f}
                </div>
              ))}
            </div>
          ) : null}
        </>
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
                    // Every place always: a series Sara did not write can be written here.
                    followUps: FOLLOW_UP_SLOTS.map((_slot, k) => v.bid.followUps[k] ?? ''),
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
        {l.site?.own ? (
          <p className="muted">
            🌐 Сайт клиента: {l.site.own.domain} · {l.site.own.text}
          </p>
        ) : null}
        {l.site?.studied ? <p className="muted">📎 Изучила: {l.site.studied}</p> : null}
        {l.site && l.site.examples.length > 0 ? (
          <p className="muted">🔗 Пример, который нравится клиенту: {l.site.examples.join(', ')}</p>
        ) : null}
      </header>

      {v.screen && (v.screen.hits.length > 0 || v.screen.clarify.length > 0) ? (
        <Card
          title={
            v.screen.hits.length === 0
              ? 'Отсев: уточнить в отклике'
              : v.screen.stops
                ? 'Отсеяна'
                : 'Отсеяла бы'
          }
          icon="shield"
          i={1}
        >
          {v.screen.hits.map((h) => (
            <p className="callout tone-bad" key={h.criterion}>
              ⛔ {SCREEN_RU[h.criterion]}: {h.basis}
            </p>
          ))}
          {v.screen.clarify.map((c) => (
            <p className="callout tone-warn" key={c.criterion}>
              Уточнить в отклике: {SCREEN_RU[c.criterion]}
              {c.basis ? `, ${c.basis}` : ''}
            </p>
          ))}
          {v.screen.no_data.length ? (
            <p className="muted">
              Нет данных: {v.screen.no_data.map((c) => SCREEN_RU[c]).join(', ')}
            </p>
          ) : null}
        </Card>
      ) : null}

      <Card title="Заказ" icon="book" i={1}>
        <p className="prose">{l.text}</p>
        <a className="link" href={l.url} target="_blank" rel="noreferrer">
          Открыть на Профи.ру <Icon name="external" />
        </a>
      </Card>

      {s ? (
        <Card
          title="Почему так"
          icon="target"
          end={<span className="mono muted">правила v{s.rulesVersion}</span>}
        >
          <div className="score-pair">
            <ScoreBlock
              title="Насколько наше"
              part={s.scores?.fit ?? { value: s.value, reasons: [s.reason] }}
              hint="Соответствие Hance по правилам отбора."
            />
            <ScoreBlock
              title="Шанс дойти до денег"
              part={s.scores?.chance}
              hint="Сара научится считать шанс сделки со следующим обновлением оценки."
            />
          </div>
          <p className="muted small">
            {s.threshold === null ? '' : `Порог ${s.threshold}. `}
            {s.confidence !== null && s.confidence !== undefined
              ? `Уверенность Сары ${Math.round(s.confidence * 100)}%. `
              : ''}
            <A to={`/settings/rules/${encodeURIComponent(l.accountId)}`} className="link">
              Правила отбора
            </A>
          </p>
          {s.stopFactor ? <p className="callout tone-bad">Стоп-фактор: {s.stopFactor}</p> : null}
          {s.redFlags.length ? (
            <p className="callout tone-warn">Флаги: {s.redFlags.join(', ')}</p>
          ) : null}
          {s.axes.length ? (
            <details>
              <summary>
                <Icon name="right" /> По осям правил
              </summary>
              <div className="bars" style={{ marginTop: 12 }}>
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
                    <span className="muted small">{a.why}</span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
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
  const [order, setOrder] = useState<QueueOrder>(readOrder)
  const pick = (o: QueueOrder) => {
    setOrder(o)
    try {
      window.localStorage.setItem(ORDER_KEY, o)
    } catch {}
  }
  const list = useScreen<LeadQueue>(`/api/leads?order=${order}`)
  const one = useScreen<LeadView>(id ? `/api/leads/${encodeURIComponent(id)}` : null)
  return (
    <div className={`page${id ? ' has-detail' : ''}`}>
      <Head title="Заявки" />
      <div className={`split${id ? ' has-detail' : ''}`}>
        <div className="split-list">
          <Screen q={list}>
            {(q) => <Queue q={q} current={id} order={order} setOrder={pick} />}
          </Screen>
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
