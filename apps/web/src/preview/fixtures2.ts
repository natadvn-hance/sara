import type {
  ClientList,
  ClientRow,
  ClientView,
  InboxItem,
  InboxView,
  JournalRow,
  JournalView,
  MeetingList,
  NoticeList,
  SearchView,
  TraceView,
} from '@sara/shared'
import { conv, convList, leadQueue } from './fixtures'

/** Made-up data for the new screens of pult v2 (no real client, no real order). */

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const inMin = (min: number) => new Date(now + min * 60_000).toISOString()

const act = (
  id: string,
  label: string,
  path: string,
  look: 'primary' | 'ghost' | 'danger' = 'ghost',
  needs: InboxItem['actions'][number]['needs'] = null,
) => ({
  id,
  label,
  look,
  needs,
  path,
})

const leadItem = (l: (typeof leadQueue.queue)[number], urgent = false): InboxItem => ({
  id: `task:t-${l.id}`,
  source: 'task',
  kind: 'lead_decision',
  title: 'Заявка ждёт решения',
  sub: `${l.city} · балл ${l.score} · цена отклика ${l.feeRub} ₽`,
  text: null,
  at: l.seenAt,
  urgent,
  entity: { kind: 'lead', id: l.id, title: l.title },
  link: `/leads/${l.id}`,
  actions: [
    act('bid', 'Откликнуться', `/api/leads/${l.id}/bid`, 'primary', 'fee'),
    act('skip', 'Закрыть заявку', `/api/leads/${l.id}/skip`, 'ghost', 'reason'),
  ],
  feeRub: l.feeRub,
  hold: null,
})

const veronika = conv('c-veronika')

export const inboxItems: InboxItem[] = [
  {
    id: 'task:t-urgent-1',
    source: 'task',
    kind: 'conv_draft',
    title: 'Клиент просит позвонить',
    sub: 'Арина, Маркетинг для салона красоты · ответить сейчас',
    text: 'Арина, добрый день! Да, давайте созвонимся. Мне удобно сегодня до 18:00 или завтра с 11:00, подскажите, когда вам удобнее?',
    at: ago(3),
    urgent: true,
    entity: { kind: 'client', id: 'c-arina', title: 'Арина · Маркетинг для салона красоты' },
    link: '/clients/c-arina',
    actions: [
      act('send', 'Отправить', '/api/tasks/t-urgent-1/send', 'primary'),
      act('take', 'Беру сам', '/api/tasks/t-urgent-1/take'),
      act('close', 'Закрыть', '/api/tasks/t-urgent-1/close', 'danger', 'confirm'),
    ],
    feeRub: null,
    hold: null,
  },
  ...leadQueue.queue.slice(0, 1).map((l) => leadItem(l)),
  {
    id: 'task:t-draft-veronika',
    source: 'task',
    kind: 'conv_draft',
    title: 'Черновик ответа клиенту',
    sub: 'Вероника спросила: «А сколько будет стоить и сколько времени займёт?»',
    text: veronika?.draft?.text ?? '',
    at: ago(2),
    urgent: false,
    entity: {
      kind: 'client',
      id: 'c-veronika',
      title: 'Вероника · Стратегия продвижения для студии керамики',
    },
    link: '/clients/c-veronika',
    actions: [
      act('send', 'Отправить', '/api/tasks/t-draft-veronika/send', 'primary'),
      act('take', 'Беру сам', '/api/tasks/t-draft-veronika/take'),
      act('close', 'Закрыть', '/api/tasks/t-draft-veronika/close', 'danger', 'confirm'),
    ],
    feeRub: null,
    hold: null,
  },
  ...leadQueue.queue.slice(1).map((l) => leadItem(l)),
  {
    id: 'question:q-why-1',
    source: 'question',
    kind: 'why_skip',
    title: 'Почему пропустил?',
    sub: '«SEO для интернет-магазина одежды»: это учит Сару отбирать лучше',
    text: null,
    at: ago(40),
    urgent: false,
    entity: { kind: 'lead', id: '95207110', title: 'SEO для интернет-магазина одежды' },
    link: '/leads/95207110',
    actions: [
      act('answer', 'Ответить', '/api/questions/q-why-1/answer', 'primary', 'text'),
      act('skip', 'Не важно', '/api/questions/q-why-1/skip'),
    ],
    feeRub: null,
    hold: null,
  },
  {
    id: 'task:t-rules-1',
    source: 'task',
    kind: 'rule_proposal',
    title: 'Поправка правил отбора',
    sub: 'v3 → v4: стоп-фактор «только ведение соцсетей без стратегии». На последних 40 заявках изменило бы 3 решения: 3 в твою сторону, 0 против.',
    text: null,
    at: ago(180),
    urgent: false,
    entity: { kind: 'account', id: 'hance-marketing', title: 'Правила отбора Hance маркетинг' },
    link: '/settings/rules/hance-marketing',
    actions: [
      act('apply', 'Применить', '/api/tasks/t-rules-1/apply', 'primary', 'confirm'),
      act('drop', 'Не надо', '/api/tasks/t-rules-1/drop'),
    ],
    feeRub: null,
    hold: null,
  },
  {
    id: 'task:t-reminder-pavel',
    source: 'task',
    kind: 'conv_reminder',
    title: 'Напоминание клиенту',
    sub: 'Павел молчит 3 дня после «подумаю»',
    text: 'Павел, добрый день! Возвращаюсь к нашему разговору про позиционирование студии. Если вопрос ещё актуален, могу показать, как это выглядело у похожей студии, 15 минут созвона.',
    at: ago(600),
    urgent: false,
    entity: { kind: 'client', id: 'c-pavel', title: 'Павел · Позиционирование студии дизайна' },
    link: '/clients/c-pavel',
    actions: [
      act('send', 'Отправить', '/api/tasks/t-reminder-pavel/send', 'primary'),
      act('skip', 'Не надо', '/api/tasks/t-reminder-pavel/skip'),
    ],
    feeRub: null,
    hold: null,
  },
]

export const inbox: InboxView = {
  items: inboxItems,
  counts: {
    leads: inboxItems.filter((i) => i.kind.startsWith('lead_') || i.kind === 'rule_proposal')
      .length,
    drafts: inboxItems.filter((i) => i.kind.startsWith('conv_')).length,
    questions: inboxItems.filter((i) => i.source === 'question').length,
    other: 0,
  },
}

export const notices: NoticeList = {
  unseen: 3,
  items: [
    {
      id: 'n1',
      kind: 'urgent',
      title: 'Клиент просит позвонить',
      body: 'Арина: «Можете набрать сейчас? Удобно обсудить голосом». Черновик ответа ждёт тебя.',
      link: '/clients/c-arina',
      state: 'new',
      at: ago(3),
      seenAt: null,
      doneAt: null,
      taskId: 't-urgent-1',
      questionId: null,
    },
    {
      id: 'n2',
      kind: 'lead',
      title: 'Новая заявка: Стратегия продвижения для студии керамики',
      body: 'Краснодар · балл 86 · отклик 240 ₽ · бюджет до 60 000 ₽',
      link: '/leads/95210417',
      state: 'new',
      at: ago(18),
      seenAt: null,
      doneAt: null,
      taskId: 't-95210417',
      questionId: null,
    },
    {
      id: 'n3',
      kind: 'draft',
      title: 'Черновик ответа: Вероника',
      body: 'Клиент спросил цену и срок. Сара предлагает вилку 40-60 тысяч и созвон.',
      link: '/clients/c-veronika',
      state: 'new',
      at: ago(2),
      seenAt: null,
      doneAt: null,
      taskId: 't-draft-veronika',
      questionId: null,
    },
    {
      id: 'n4',
      kind: 'client',
      title: 'Клиент написал: Арина',
      body: '«Давайте в четверг в 15:00, удобно?» Клиента ведёшь ты.',
      link: '/clients/c-arina',
      state: 'seen',
      at: ago(120),
      seenAt: ago(100),
      doneAt: null,
      taskId: null,
      questionId: null,
    },
    {
      id: 'n5',
      kind: 'meeting',
      title: 'Встреча назначена: Арина, чт 15:00',
      body: 'Созвон по маркетингу салона красоты. Напомню утром и за 30 минут.',
      link: '/meetings',
      state: 'seen',
      at: ago(110),
      seenAt: ago(100),
      doneAt: null,
      taskId: null,
      questionId: null,
    },
    {
      id: 'n6',
      kind: 'summary',
      title: 'Вечерняя сводка',
      body: 'Сегодня отсеяла 38 заявок, на грани 3. Откликов 2, ответили 1.',
      link: '/today',
      state: 'done',
      at: ago(900),
      seenAt: ago(880),
      doneAt: ago(880),
      taskId: null,
      questionId: null,
    },
    {
      id: 'n7',
      kind: 'system',
      title: 'Сессия Профи.ру снова живая',
      body: 'Сверяю, что пришло за время простоя.',
      link: '/health',
      state: 'done',
      at: ago(1500),
      seenAt: ago(1400),
      doneAt: ago(1400),
      taskId: null,
      questionId: null,
    },
  ],
}

const STAGE_OF: Record<string, ClientRow['stage']> = {
  'c-veronika': 'Переговоры',
  'c-arina': 'В работе',
  'c-pavel': 'Переговоры',
  'c-irina': 'Отвалился',
}

export const clientList: ClientList = {
  drafting: convList.drafting,
  rows: [
    ...convList.rows.map(
      (r): ClientRow => ({
        id: r.id,
        name: r.name,
        title: r.title,
        stage: STAGE_OF[r.id] ?? 'Отклик',
        owner: r.group === 'boris' ? 'boris' : 'sara',
        closed: r.group === 'closed',
        waits: r.group === 'waiting' || r.id === 'c-arina',
        last: r.last,
        lastAt: r.lastAt,
        lastSide: r.lastSide,
        amountRub: null,
      }),
    ),
    {
      id: 'c-dmitry',
      name: 'Дмитрий',
      title: 'Маркетолог для сети стоматологий, 3 клиники',
      stage: 'Отклик',
      owner: 'sara',
      closed: false,
      waits: false,
      last: 'Дмитрий, добрый день! Похоже, вопрос не в том, чтобы найти ещё один канал…',
      lastAt: ago(50),
      lastSide: 'us',
      amountRub: null,
    },
    {
      id: 'c-olga',
      name: 'Ольга',
      title: 'Стратегия для сети кофеен',
      stage: 'Закрыта',
      owner: 'boris',
      closed: false,
      waits: false,
      last: 'Договор подписали, спасибо!',
      lastAt: ago(4000),
      lastSide: 'client',
      amountRub: 120000,
    },
  ],
}

export const meetings: MeetingList = {
  rows: [
    {
      id: 'm-arina',
      clientId: 'c-arina',
      clientName: 'Арина',
      title: 'Созвон: маркетинг салона красоты',
      at: inMin(26 * 60),
      channel: 'телефон',
      note: 'Клиент хочет понять, что даст первый месяц',
      outcome: null,
      amountRub: null,
      source: 'deal',
    },
    {
      id: 'm-olga',
      clientId: 'c-olga',
      clientName: 'Ольга',
      title: 'Старт работы: сеть кофеен',
      at: inMin(3 * 24 * 60),
      channel: 'Zoom',
      note: null,
      outcome: null,
      amountRub: null,
      source: 'manual',
    },
    {
      id: 'm-pavel',
      clientId: 'c-pavel',
      clientName: 'Павел',
      title: 'Созвон обсуждается',
      at: null,
      channel: null,
      note: 'Павел пока не выбрал время',
      outcome: null,
      amountRub: null,
      source: 'deal',
    },
    {
      id: 'm-irina',
      clientId: 'c-irina',
      clientName: 'Ирина',
      title: 'Созвон: кондитерская',
      at: ago(3 * 24 * 60),
      channel: 'телефон',
      note: null,
      outcome: 'missed',
      amountRub: null,
      source: 'manual',
    },
  ],
}

export function client(id: string): ClientView | null {
  const row = clientList.rows.find((r) => r.id === id)
  if (!row) return null
  const base = conv(id)
  const tasks = inboxItems.filter((i) => i.entity?.kind === 'client' && i.entity.id === id)
  return {
    id,
    name: row.name,
    stage: row.stage,
    owner: row.owner,
    closed: row.closed,
    orderId: base?.orderId ?? null,
    orderTitle: row.title,
    chatUrl: 'https://profi.ru/backoffice/',
    note: id === 'c-olga' ? 'сеть из 4 кофеен, решает владелица' : null,
    instruction: id === 'c-arina' ? 'хочет созвон, предложи четверг' : null,
    service: id === 'c-olga' ? 'стратегия и ведение' : null,
    outcome:
      id === 'c-olga'
        ? { outcome: 'won', amountRub: 120000, reason: null, at: ago(4000) }
        : id === 'c-irina'
          ? { outcome: 'lost', amountRub: null, reason: 'выбрал другого', at: ago(5000) }
          : null,
    spentRub: id === 'c-dmitry' ? 310 : 240,
    messages: base?.messages ?? [
      {
        id: 'm1',
        side: 'us',
        author: 'Сара',
        text: row.last ?? '',
        at: row.lastAt ?? ago(60),
        approx: false,
        read: false,
      },
    ],
    tasks,
    meetings: meetings.rows.filter((m) => m.clientId === id),
    sendHold: null,
  }
}

const j = (
  id: string,
  type: string,
  text: string,
  min: number,
  actor = 'sara',
  entity: JournalRow['entity'] = null,
  reason: string | null = null,
): JournalRow => ({
  id,
  type,
  text,
  at: ago(min),
  actor,
  entity,
  reason,
  correlationId: 'corr-95210417',
})

const LEAD_REF = {
  kind: 'lead' as const,
  id: '95210417',
  title: 'Стратегия продвижения для студии керамики',
}

export const journal: JournalView = {
  next: null,
  types: [
    'lead.found',
    'lead.scored',
    'lead.drafted',
    'card.sent',
    'conv.message_heard',
    'conv.turn_drafted',
    'bid.sent',
    'setting.changed',
  ],
  items: [
    j('e1', 'conv.turn_drafted', 'Подготовила ответ: Вероника', 2, 'sara', {
      kind: 'client',
      id: 'c-veronika',
      title: 'Вероника',
    }),
    j('e2', 'conv.message_heard', 'Вероника: новое сообщение в чате', 4, 'client', {
      kind: 'client',
      id: 'c-veronika',
      title: 'Вероника',
    }),
    j(
      'e3',
      'card.sent',
      'Прислала тебе карточку «Стратегия продвижения для студии керамики»',
      17,
      'sara',
      LEAD_REF,
    ),
    j(
      'e4',
      'lead.drafted',
      'Написала отклик на «Стратегия продвижения для студии керамики»',
      17,
      'sara',
      LEAD_REF,
    ),
    j(
      'e5',
      'lead.scored',
      'Оценила «Стратегия продвижения для студии керамики»: балл 86',
      18,
      'sara',
      LEAD_REF,
    ),
    j(
      'e6',
      'lead.found',
      'Нашла заявку «Стратегия продвижения для студии керамики»',
      18,
      'sara',
      LEAD_REF,
    ),
    j('e7', 'setting.changed', 'Изменена настройка «Бюджет в день»', 3000, 'boris', {
      kind: 'setting',
      id: 'money.daily_budget_rub',
      title: 'Бюджет в день',
    }),
  ],
}

export const trace: TraceView = {
  correlationId: 'corr-95210417',
  entity: LEAD_REF,
  events: [...journal.items.filter((i) => i.entity?.kind === 'lead')].reverse(),
  calls: [
    {
      id: 'mc1',
      role: 'sorter',
      model: 'haiku',
      ok: true,
      ms: 2100,
      at: ago(18),
      errorClass: null,
    },
    {
      id: 'mc2',
      role: 'scorer',
      model: 'haiku',
      ok: true,
      ms: 6400,
      at: ago(18),
      errorClass: null,
    },
    {
      id: 'mc3',
      role: 'analyst',
      model: 'sonnet',
      ok: true,
      ms: 24800,
      at: ago(17),
      errorClass: null,
    },
  ],
}

export function search(q: string): SearchView {
  const needle = q.toLowerCase()
  const hits: SearchView['hits'] = []
  for (const l of leadQueue.queue)
    if (l.id.includes(needle) || l.title.toLowerCase().includes(needle))
      hits.push({
        kind: 'lead',
        id: l.id,
        title: l.title,
        sub: `${l.city} · балл ${l.score}`,
        link: `/leads/${l.id}`,
      })
  for (const c of clientList.rows)
    if (c.name.toLowerCase().includes(needle) || (c.title ?? '').toLowerCase().includes(needle))
      hits.push({ kind: 'client', id: c.id, title: c.name, sub: c.title, link: `/clients/${c.id}` })
  if ('цена'.includes(needle) || needle.includes('цен'))
    hits.push({
      kind: 'mind',
      id: 'K-014',
      title: 'Как говорим о цене',
      sub: 'знание · общее для Hance',
      link: '/mind/K-014',
    })
  return { q, hits }
}
