import type { SystemView } from '@sara/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api'
import { toast, useScreen } from '../app/data'
import { ago, hhmm, rub } from '../app/format'
import { A, Btn, Card, Dot, Head, Pill, Screen } from '../ui/kit'

/** «Здоровье» (FR-SET-5, M7): the node of Profi.ru, the session, the link, the backups and the Claude limit. */

const ICON: Record<string, string> = {
  db: 'db',
  node: 'server',
  telegram: 'bell',
  claude: 'mind',
  session: 'user',
  link: 'link',
  backup: 'shield',
  sheet: 'list',
}
const LOGIN: Record<string, string> = {
  alive: 'вход жив',
  dead: 'нужно войти',
  banned: 'профиль заблокирован',
  unknown: 'служба не отвечает',
}
const ROLE_RU: Record<string, string> = {
  scorer: 'Оценщик заявок',
  sorter: 'Сортировщик',
  analyst: 'Аналитик откликов',
  interlocutor: 'Собеседник',
  checker: 'Проверка ответа',
  probe: 'Пробный вызов',
  reminder: 'Напоминания',
  'rules-proposer': 'Поправки правил',
  examiner: 'Экзамен',
  teacher: 'Учитель',
  'lesson-maker': 'Уроки',
}

function Body({ v }: { v: SystemView }) {
  const bad = v.parts.filter((p) => p.tone === 'bad').length
  return (
    <>
      <p className={`state tone-${bad ? 'bad' : 'ok'} reveal`}>
        <Dot tone={bad ? 'bad' : 'ok'} live />
        {bad ? `Нужно внимание: ${bad} из ${v.parts.length}` : 'Всё работает'}
        {v.deploy ? (
          <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 12 }}>
            версия {v.deploy.version}
            {v.deploy.startedAt ? ` · запуск ${ago(v.deploy.startedAt)}` : ''}
          </span>
        ) : null}
      </p>
      <div className="grid grid-3">
        {v.parts.map((p, i) => (
          <Card
            key={p.id}
            title={p.title}
            icon={ICON[p.id] ?? 'health'}
            i={i + 1}
            end={<Dot tone={p.tone} live={p.tone !== 'ok'} />}
          >
            <p>{p.text}</p>
            {p.fix ? (
              <p className={`callout tone-${p.tone === 'bad' ? 'bad' : 'warn'}`}>{p.fix}</p>
            ) : null}
            {p.at ? <p className="muted mono">{ago(p.at)}</p> : null}
          </Card>
        ))}
      </div>
      <div className="grid grid-21">
        <Card
          title="Лимит Claude"
          icon="mind"
          end={
            <Pill tone={v.claude.limited ? 'warn' : 'ok'}>
              {v.claude.limited
                ? v.claude.until
                  ? `до ${hhmm(v.claude.until)}`
                  : 'кончился'
                : 'есть'}
            </Pill>
          }
        >
          {v.claude.roles.length === 0 ? (
            <p className="muted">За сутки вызовов не было.</p>
          ) : (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Роль, за сутки</th>
                    <th className="n">Вызовов</th>
                    <th className="n">Не прошло</th>
                    <th className="n">Минут</th>
                  </tr>
                </thead>
                <tbody>
                  {v.claude.roles.map((r) => (
                    <tr key={r.role}>
                      <td>{ROLE_RU[r.role] ?? r.role}</td>
                      <td className="n">{r.calls}</td>
                      <td className="n">{r.failed}</td>
                      <td className="n">{Math.round(r.ms / 60_000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Аккаунты" icon="user">
          <div className="list">
            {v.accounts.map((a) => (
              <A key={a.id} to={`/settings/rules/${encodeURIComponent(a.id)}`} className="row">
                <Dot tone={a.login === 'alive' ? (a.paused ? 'warn' : 'ok') : 'bad'} />
                <span className="row-main">
                  <span className="row-title">{a.title}</span>
                  <span className="row-sub">
                    {LOGIN[a.login] ?? a.login}
                    {a.paused ? ' · на паузе' : ''}
                  </span>
                </span>
                <span className="row-end mono">
                  {a.balanceRub === null ? '' : rub(a.balanceRub)}
                </span>
              </A>
            ))}
          </div>
        </Card>
      </div>
    </>
  )
}

/** «Проверить снова»: a probe call to Claude, then every check again. */
function Recheck() {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  return (
    <Btn
      icon="health"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await api('/api/health/claude', {}).catch(() =>
          toast('Проверка не прошла, попробуй ещё раз.'),
        )
        await client.invalidateQueries()
        setBusy(false)
      }}
    >
      {busy ? 'Проверяю…' : 'Проверить снова'}
    </Btn>
  )
}

export function HealthScreen() {
  const q = useScreen<SystemView>('/api/system')
  return (
    <div className="page">
      <Head title="Состояние" end={<Recheck />} />
      <Screen q={q}>{(v) => <Body v={v} />}</Screen>
    </div>
  )
}
