import type { AnalyticsView } from '@sara/shared'
import { useState } from 'react'
import { useScreen } from '../app/data'
import { pct, rub, toCsv } from '../app/format'
import { A, Btn, Card, Empty, Head, Screen, Seg } from '../ui/kit'

/** «Итоги» (FR-ANL-5, FR-ANL-6): Boris's three tables in his own columns, with a download. */

const money = (v: number | null) => (v === null ? '' : rub(v))

function download(name: string, rows: (string | number | null)[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function Tables({ v }: { v: AnalyticsView }) {
  const top = Math.max(1, ...v.funnel.map((f) => f.count))
  const clientRows = (): (string | number | null)[][] => [
    [
      'Месяц',
      'Клиент',
      'Тип услуги',
      'Этап воронки',
      'Сумма сделки, ₽',
      'Расходы Профи.ру, ₽',
      'LTV клиента, ₽',
      'Заметка',
    ],
    ...v.clients.map((c) => [
      c.month,
      c.client,
      c.service,
      c.stage,
      c.dealRub,
      c.spendRub,
      c.ltvRub,
      c.note,
    ]),
  ]
  const monthRows = (): (string | number | null)[][] => [
    [
      'Месяц',
      'Откликов',
      'Закрытых сделок',
      'Отвалилось',
      'Конверсия, %',
      'Средний чек, ₽',
      'Выручка, ₽',
      'Расходы, ₽',
      'CAC, ₽',
    ],
    ...v.months.map((m) => [
      m.month,
      m.bids,
      m.won,
      m.lost,
      m.conversion,
      m.avgCheckRub,
      m.revenueRub,
      m.spendRub,
      m.cacRub,
    ]),
  ]
  return (
    <>
      <div className="grid grid-21">
        <Card
          title="Воронка"
          icon="chart"
          i={1}
          end={<span className="mono muted">% от откликов</span>}
        >
          <div className="bars">
            {v.funnel.map((f) => (
              <div className="bar" key={f.stage}>
                <div className="bar-top">
                  <span>{f.stage}</span>
                  <span className="mono">
                    {f.count} · {pct(f.share)}
                  </span>
                </div>
                <div className="bar-track">
                  <span
                    style={{
                      width: `${(f.count / top) * 100}%`,
                      ...(f.stage === 'Отвалился' ? { background: 'var(--muted)' } : {}),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Что пока не считается" icon="alert" i={2}>
          <ul className="grid" style={{ margin: 0, paddingLeft: 18, gap: 8 }}>
            {v.notes.map((n) => (
              <li key={n} className="text-2">
                {n}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="Сводка по месяцам"
        icon="clock"
        i={3}
        end={
          <Btn
            size="sm"
            icon="download"
            onClick={() => download(`sara-svodka-${v.year}.csv`, monthRows())}
          >
            Скачать
          </Btn>
        }
      >
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Месяц</th>
                <th className="n">Откликов</th>
                <th className="n">Закрытых</th>
                <th className="n">Отвалилось</th>
                <th className="n">Конверсия</th>
                <th className="n">Средний чек</th>
                <th className="n">Выручка</th>
                <th className="n">Расходы</th>
                <th className="n">CAC</th>
              </tr>
            </thead>
            <tbody>
              {v.months
                .filter((m) => m.bids > 0 || m.month === 'ИТОГО')
                .map((m) => (
                  <tr key={m.month} className={m.month === 'ИТОГО' ? 'total' : undefined}>
                    <td>{m.month}</td>
                    <td className="n">{m.bids}</td>
                    <td className="n">{m.won}</td>
                    <td className="n">{m.lost}</td>
                    <td className="n">{m.conversion === null ? '' : pct(m.conversion)}</td>
                    <td className="n">{money(m.avgCheckRub)}</td>
                    <td className="n">{money(m.revenueRub)}</td>
                    <td className="n">{money(m.spendRub)}</td>
                    <td className="n">{money(m.cacRub)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Лог клиентов"
        icon="user"
        i={4}
        end={
          <Btn
            size="sm"
            icon="download"
            onClick={() => download(`sara-klienty-${v.year}.csv`, clientRows())}
          >
            Скачать
          </Btn>
        }
      >
        {v.clients.length === 0 ? (
          <Empty title="Откликов за этот год нет">
            Клиент появится здесь после первого отклика.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Месяц</th>
                  <th>Клиент</th>
                  <th>Тип услуги</th>
                  <th>Этап</th>
                  <th className="n">Сумма сделки</th>
                  <th className="n">Расходы Профи.ру</th>
                  <th className="n">LTV</th>
                  <th>Заметка</th>
                </tr>
              </thead>
              <tbody>
                {v.clients.map((c) => (
                  <tr key={`${c.client}-${c.link}`}>
                    <td>{c.month}</td>
                    <td>
                      {c.link ? (
                        <A to={c.link} className="link">
                          {c.client}
                        </A>
                      ) : (
                        c.client
                      )}
                    </td>
                    <td>{c.service}</td>
                    <td>{c.stage}</td>
                    <td className="n">{money(c.dealRub)}</td>
                    <td className="n">{money(c.spendRub)}</td>
                    <td className="n">{money(c.ltvRub)}</td>
                    <td>{c.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

export function AnalyticsScreen() {
  const now = new Date().getFullYear()
  const [year, setYear] = useState(String(now))
  const q = useScreen<AnalyticsView>(`/api/analytics?year=${year}`, 60_000)
  return (
    <div className="page">
      <Head
        title="Итоги"
        lead="Пустая ячейка значит, что Сара этого ещё не знает."
        end={
          <Seg
            label="Год"
            value={year}
            onChange={setYear}
            options={[String(now - 1), String(now)].map((y) => ({ value: y, label: y }))}
          />
        }
      />
      <Screen q={q}>{(v) => <Tables v={v} />}</Screen>
    </div>
  )
}
