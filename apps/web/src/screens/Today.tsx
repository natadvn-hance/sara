import type { FeedItem, TodayView, WaitingItem } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { ago, count, dayLabel, hhmm, rub } from '../app/format'
import { Icon } from '../ui/icons'
import { A, Card, Dot, Empty, Head, Meter, Screen, Seg } from '../ui/kit'

/** «Сегодня» (M7 design 5.1): what Sara does now, what waits for Boris, money against the limits, her steps. */

const AREA_ICON: Record<FeedItem['area'], string> = {
  lead: 'leads',
  bid: 'send',
  conv: 'chat',
  mind: 'mind',
  money: 'wallet',
  system: 'health',
}
const WAIT_ICON: Record<WaitingItem['kind'], string> = {
  leads: 'leads',
  draft: 'send',
  question: 'bell',
  rules: 'target',
  task: 'check',
}

function Waiting({ t }: { t: TodayView }) {
  if (t.waiting.items.length === 0)
    return (
      <Empty title="Ничего не ждёт тебя">
        Новые заявки и черновики ответов появятся здесь сами.
      </Empty>
    )
  return (
    <div className="list">
      {t.waiting.items.map((w) => {
        const inner = (
          <>
            <span className={`score${w.kind === 'draft' ? ' is-high' : ''}`}>
              <Icon name={WAIT_ICON[w.kind]} />
            </span>
            <span className="row-main">
              <span className="row-title">{w.title}</span>
              <span className="row-sub">{w.sub ?? ago(w.at)}</span>
            </span>
            {w.link ? (
              <span className="row-end">
                <Icon name="right" />
              </span>
            ) : null}
          </>
        )
        return w.link ? (
          <A key={w.id} to={w.link} className="row">
            {inner}
          </A>
        ) : (
          <div key={w.id} className="row">
            {inner}
          </div>
        )
      })}
    </div>
  )
}

function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0)
    return (
      <Empty title="Пока тихо">
        Здесь будет каждый шаг Сары: заявки, отклики, ответы клиентам.
      </Empty>
    )
  return (
    <ol className="feed">
      {items.map((f) => (
        <li key={f.id}>
          <span className="feed-time mono">{hhmm(f.at)}</span>
          <span className={`feed-ic tone-${f.tone}`} aria-hidden="true">
            <Icon name={AREA_ICON[f.area]} />
          </span>
          <span>
            {f.link ? (
              <A to={f.link} className="link">
                {f.text}
              </A>
            ) : (
              f.text
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

function TodayBody({
  t,
  period,
  setPeriod,
}: {
  t: TodayView
  period: '7' | '30'
  setPeriod: (p: '7' | '30') => void
}) {
  const p = t.period
  const steps = [
    { label: 'нашла заявок', v: p.found },
    { label: 'подошли под правила', v: p.passed },
    { label: 'откликов', v: p.bids },
    { label: 'ответили', v: p.replied },
    { label: 'договоров', v: p.won },
  ]
  const top = Math.max(1, ...steps.map((s) => s.v))
  return (
    <div className="page">
      <Head
        eyebrow={dayLabel(t.now)}
        title="Сара"
        accent="на смене"
        lead={
          <A to="/health" className={`state tone-${t.state.tone}`}>
            <Dot tone={t.state.tone} live />
            <span>
              <strong style={{ fontWeight: 500 }}>{t.state.text}</strong>
              {t.state.detail ? <span className="muted"> · {t.state.detail}</span> : null}
            </span>
            <Icon name="right" />
          </A>
        }
      />

      <div className="grid grid-3">
        <Card title="Сейчас" icon="bolt" i={1}>
          <p className="h3" style={{ fontSize: 19 }}>
            {t.doing.text}
          </p>
          <p className="muted mono">
            {t.doing.at ? `последний шаг ${ago(t.doing.at)}` : 'шагов ещё не было'}
          </p>
        </Card>
        <Card title="Кошелёк" icon="wallet" i={2}>
          <div className="num">
            <b>
              {t.wallet.balanceRub === null ? 'нет' : rub(t.wallet.balanceRub).replace(/\s₽$/, '')}
            </b>
            <small>₽</small>
          </div>
          <p className="muted mono">обновлён {ago(t.wallet.at)}</p>
          {t.wallet.shortRub !== null ? (
            <p className="callout tone-warn">
              Нужно ещё {rub(t.wallet.shortRub)} на самый дешёвый отклик в очереди
            </p>
          ) : null}
        </Card>
        <Card title="Сегодня против лимитов" icon="target" i={3}>
          <Meter
            label="Откликов"
            value={t.day.bids}
            max={t.day.bidsCap}
            text={`${t.day.bids} из ${t.day.bidsCap}`}
          />
          <Meter
            label="Потрачено"
            value={t.day.spentRub}
            max={t.day.budgetRub}
            text={
              t.day.budgetRub === null
                ? `${rub(t.day.spentRub)}, бюджет без ограничения`
                : `${rub(t.day.spentRub)} из ${rub(t.day.budgetRub)}`
            }
          />
          <Meter
            label="Карточек заявок"
            value={t.day.cards}
            max={t.day.cardsCap}
            text={`${t.day.cards} из ${t.day.cardsCap}`}
          />
          <p className="muted" style={{ fontSize: 13 }}>
            {t.day.maxFeeRub === null
              ? 'Потолка за отклик нет.'
              : `Не дороже ${rub(t.day.maxFeeRub)} за отклик.`}{' '}
            <A to="/settings" className="link">
              Изменить
            </A>
          </p>
        </Card>
      </div>

      <div className="grid grid-21">
        <Card
          title="Ждёт тебя"
          icon="bell"
          i={4}
          end={
            <span className="mono muted">
              {count(t.waiting.items.length, ['дело', 'дела', 'дел'])}
            </span>
          }
        >
          <Waiting t={t} />
        </Card>
        <Card
          title="Итоги"
          icon="chart"
          i={5}
          end={
            <Seg
              label="Период"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '7', label: '7 дней' },
                { value: '30', label: '30 дней' },
              ]}
            />
          }
        >
          <div className="bars">
            {steps.map((s) => (
              <div className="bar" key={s.label}>
                <div className="bar-top">
                  <span className="text-2">{s.label}</span>
                  <span className="mono">{s.v}</span>
                </div>
                <div className="bar-track">
                  <span style={{ width: `${(s.v / top) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="muted">
            Потрачено на отклики за {p.days} дней: <span className="mono">{rub(p.spentRub)}</span>.{' '}
            <A to="/analytics" className="link">
              Все итоги
            </A>
          </p>
        </Card>
      </div>

      <Card title="Что Сара делала" icon="clock" i={6}>
        <Feed items={t.feed} />
      </Card>
    </div>
  )
}

export function TodayScreen() {
  const [period, setPeriod] = useState<'7' | '30'>('7')
  const q = useScreen<TodayView>(`/api/today?period=${period}`)
  return <Screen q={q}>{(t) => <TodayBody t={t} period={period} setPeriod={setPeriod} />}</Screen>
}
