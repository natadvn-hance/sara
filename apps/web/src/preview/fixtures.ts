import {
  type AnalyticsView,
  type ConvList,
  type ConvView,
  type FeedItem,
  type LeadQueue,
  type LeadView,
  type MindRecordView,
  type MindView,
  priceUpTo,
  type SettingsView,
  type SystemView,
  type TodayView,
} from '@sara/shared'

/**
 * Made-up data for the demo preview of the pult (no real client, no real order). The shapes are the core's own
 * contract, so the preview cannot drift from what the screens get from the API.
 */

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

type Lead = {
  id: string
  title: string
  city: string
  category: string
  score: number
  fee: number
  price: number
  seen: number
  client: string
  text: string
  budget: string | null
  need: string
  risk: string
  condition: string
  bid: string
  followUps?: string[]
}

const LEADS: Lead[] = [
  {
    id: '95210417',
    title: 'Стратегия продвижения для студии керамики',
    city: 'Краснодар',
    category: 'Маркетинговая стратегия',
    score: 86,
    fee: 240,
    price: 40000,
    seen: 18,
    client: 'Вероника',
    text: 'Небольшая студия керамики, мастер-классы и посуда ручной работы. Сейчас все продажи через знакомых и Instagram. Нужна стратегия продвижения на полгода: где искать клиентов, что говорить, сколько вкладывать.',
    budget: 'до 60 000 ₽',
    need: 'хочет стабильный поток записей на мастер-классы, а не документ со стратегией',
    risk: 'бюджет на сами каналы может оказаться меньше, чем на стратегию',
    condition: 'брать, если готова к созвону и к тому, что часть работы делает сама',
    bid: 'Вероника, добрый день! Если я правильно понял, то главное для студии сейчас не «стратегия на бумаге», а чтобы мастер-классы заполнялись без опоры на знакомых.\n\nМы в Hance начинаем с разбора, откуда уже приходят люди и почему они возвращаются, и только потом выбираем каналы. Предлагаю короткий созвон на 20 минут: покажу, как это выглядело у похожей студии, и скажу честно, какой бюджет на каналы нужен.',
    followUps: [
      'Из недавнего, студия, где тоже всё держалось на знакомых)\nhttps://example.com/keramika',
      'Сделаем спокойно и без лишних трат, начнём с того, что уже работает)',
    ],
  },
  {
    id: '95209981',
    title: 'Маркетолог для сети стоматологий, 3 клиники',
    city: 'Ростов-на-Дону',
    category: 'Маркетинг',
    score: 78,
    fee: 310,
    price: 90000,
    seen: 52,
    client: 'Дмитрий',
    text: 'Три клиники, есть сайт и реклама в Директе, но заявки дорожают. Нужен человек, который разберётся в цифрах и выстроит систему.',
    budget: 'обсуждается',
    need: 'хочет понять, куда утекают деньги на рекламу',
    risk: 'может ждать исполнителя рекламы, а не стратегию',
    condition: 'брать при доступе к аналитике и CRM',
    bid: 'Дмитрий, добрый день! Похоже, вопрос не в том, чтобы найти ещё один канал, а в том, чтобы увидеть, на каком шаге заявка становится дорогой. Начнём с аудита воронки по трём клиникам...',
  },
  {
    id: '95208733',
    title: 'Упаковка онлайн-школы английского',
    city: 'Москва',
    category: 'Маркетинг',
    score: 64,
    fee: 180,
    price: 30000,
    seen: 140,
    client: 'Ольга',
    text: 'Запускаем онлайн-школу для взрослых. Нужно позиционирование и тексты для лендинга.',
    budget: null,
    need: 'не понимает, чем отличается от сотни таких же школ',
    risk: 'запрос может свестись к текстам',
    condition: 'брать, если готова начать с позиционирования',
    bid: 'Ольга, добрый день! Если я правильно понял, то тексты для лендинга это последний шаг, а первый это ответ, почему взрослому выбрать именно вашу школу...',
  },
  {
    id: '95207120',
    title: 'Продвижение фитнес-студии в районе',
    city: 'Краснодар',
    category: 'Маркетинг',
    score: 58,
    fee: 150,
    price: 25000,
    seen: 290,
    client: 'Марк',
    text: 'Фитнес-студия на 40 человек в спальном районе. Хотим больше абонементов.',
    budget: 'до 30 000 ₽',
    need: 'хочет заполнить утренние и дневные часы',
    risk: 'маленький бюджет',
    condition: 'брать, если согласен на тест на месяц',
    bid: 'Марк, добрый день! Для студии в районе работают не охваты, а соседи...',
  },
]

const feed: FeedItem[] = [
  {
    id: 'f1',
    at: ago(2),
    area: 'conv',
    tone: 'wait',
    text: 'Подготовила ответ: Вероника',
    link: '/clients/c-veronika',
  },
  {
    id: 'f2',
    at: ago(4),
    area: 'conv',
    tone: 'wait',
    text: 'Вероника написал в чат',
    link: '/clients/c-veronika',
  },
  {
    id: 'f3',
    at: ago(18),
    area: 'lead',
    tone: 'wait',
    text: 'Прислала тебе карточку «Стратегия продвижения для студии керамики»',
    link: '/leads/95210417',
  },
  {
    id: 'f4',
    at: ago(19),
    area: 'lead',
    tone: 'ok',
    text: 'Написала отклик на «Стратегия продвижения для студии керамики»',
    link: '/leads/95210417',
  },
  {
    id: 'f5',
    at: ago(20),
    area: 'lead',
    tone: 'ok',
    text: 'Оценила «Стратегия продвижения для студии керамики»: балл 86',
    link: '/leads/95210417',
  },
  {
    id: 'f6',
    at: ago(47),
    area: 'bid',
    tone: 'ok',
    text: 'Откликнулась на «Маркетинг для салона красоты» за 180 ₽',
    link: '/leads/95206544',
  },
  {
    id: 'f7',
    at: ago(52),
    area: 'lead',
    tone: 'ok',
    text: 'Оценила «Маркетолог для сети стоматологий, 3 клиники»: балл 78',
    link: '/leads/95209981',
  },
  {
    id: 'f8',
    at: ago(75),
    area: 'lead',
    tone: 'ok',
    text: 'Оценила «Настроить таргет в VK за 5000»: балл 22, не наша',
    link: null,
  },
  {
    id: 'f9',
    at: ago(120),
    area: 'conv',
    tone: 'ok',
    text: 'Отправила твой текст: Арина',
    link: '/clients/c-arina',
  },
  { id: 'f10', at: ago(190), area: 'money', tone: 'ok', text: 'На кошельке 1 840 ₽', link: null },
  {
    id: 'f11',
    at: ago(260),
    area: 'mind',
    tone: 'wait',
    text: 'Предложила запись в разум, ждёт твоего «да»',
    link: '/mind',
  },
  {
    id: 'f12',
    at: ago(420),
    area: 'system',
    tone: 'ok',
    text: 'Сессия Профи.ру снова живая',
    link: '/health',
  },
]

export function today(period: number): TodayView {
  return {
    now: new Date(now).toISOString(),
    state: {
      tone: 'wait',
      text: 'Режим черновиков: клиентам пишу только после «Отправить»',
      detail: null,
    },
    doing: { text: 'Думаю над ответом: Вероника', at: ago(2) },
    waiting: {
      leads: LEADS.length,
      drafts: 1,
      questions: 1,
      items: [
        {
          id: 'leads',
          kind: 'leads',
          title: `${LEADS.length} заявки ждут решения`,
          sub: 'сверху «Стратегия продвижения для студии керамики»',
          at: ago(18),
          link: '/leads',
        },
        {
          id: 'd1',
          kind: 'draft',
          title: 'Вероника: черновик ждёт «Отправить»',
          sub: null,
          at: ago(2),
          link: '/clients/c-veronika',
        },
        {
          id: 'q1',
          kind: 'question',
          title: 'Почему пропустил заявку?',
          sub: '«SEO для салона», ответь в Telegram',
          at: ago(95),
          link: null,
        },
      ],
    },
    wallet: { balanceRub: 1840, at: ago(6), shortRub: null },
    day: {
      bids: 3,
      bidsCap: 10,
      spentRub: 610,
      budgetRub: 1500,
      maxFeeRub: 400,
      cards: 5,
      cardsCap: 10,
    },
    feed,
    period:
      period === 30
        ? { days: 30, found: 1240, passed: 96, bids: 41, replied: 17, won: 3, spentRub: 9120 }
        : { days: 7, found: 312, passed: 23, bids: 12, replied: 6, won: 1, spentRub: 2470 },
  }
}

export const leadQueue: LeadQueue = {
  queue: LEADS.map((l, i) => ({
    id: l.id,
    taskId: `t-${l.id}`,
    title: l.title,
    city: l.city,
    category: l.category,
    score: l.score,
    feeRub: l.fee,
    priceFromRub: l.price,
    seenAt: ago(l.seen),
    hasDraft: i < 3,
  })),
  older: 2,
  decided: [
    {
      id: '95206544',
      title: 'Маркетинг для салона красоты',
      decision: 'bid',
      at: ago(47),
      feeRub: 180,
    },
    { id: '95205002', title: 'SEO для салона', decision: 'skip', at: ago(96), feeRub: 120 },
    {
      id: '95204410',
      title: 'Бренд-платформа для кофейни',
      decision: 'closed',
      at: ago(300),
      feeRub: 220,
    },
  ],
  paused: null,
}

export function lead(id: string): LeadView | null {
  const l = LEADS.find((x) => x.id === id)
  if (!l) return null
  return {
    lead: {
      id: l.id,
      accountId: 'hance-marketing',
      title: l.title,
      city: l.city,
      category: l.category,
      text: l.text,
      budgetText: l.budget,
      clientName: l.client,
      client: {
        since: 'На Профи.ру с марта 2022',
        phone: true,
        reviews: 'отзывов от исполнителей: 4 хороших, 0 плохих',
      },
      seenAt: ago(l.seen),
      status: 'queued',
      feeRub: l.fee,
      url: `https://profi.ru/backoffice/n.php?o=${l.id}`,
    },
    score: {
      value: l.score,
      threshold: 56,
      rulesVersion: 4,
      reason:
        'Стратегия для малого бизнеса, клиент сам формулирует задачу через результат, а не через инструмент.',
      stopFactor: null,
      redFlags: l.score < 60 ? ['маленький бюджет'] : [],
      axes: [
        {
          title: 'Наш профиль: стратегия, а не исполнение',
          weight: 40,
          score: Math.min(100, l.score + 6),
          why: 'просят стратегию и систему',
        },
        {
          title: 'Деньги клиента',
          weight: 25,
          score: Math.max(20, l.score - 18),
          why: l.budget ? `бюджет ${l.budget}` : 'бюджет не назван',
        },
        {
          title: 'Ясность задачи',
          weight: 20,
          score: l.score - 4,
          why: 'понятно, чего хочет на выходе',
        },
        { title: 'Город и формат', weight: 15, score: 90, why: 'можно работать удалённо' },
      ],
    },
    analysis: {
      hiddenNeed: l.need,
      risk: l.risk,
      condition: l.condition,
      reading: [
        { label: 'Говорит прямо', text: 'нужна стратегия продвижения на полгода' },
        { label: 'Между строк', text: 'продажи держатся на одном человеке, системы нет' },
        { label: 'Чего хочет на самом деле', text: l.need },
        { label: 'Кто это', text: 'владелец небольшого дела, сам принимает решения' },
        { label: 'Риски', text: l.risk },
        { label: 'Зачем нанимает', text: 'чтобы перестать зависеть от сарафана' },
      ],
    },
    bid: {
      text: l.bid,
      priceFromRub: l.price,
      priceToRub: priceUpTo(l.price),
      limit: 500,
      followUps: l.followUps ?? [],
      followUpLimit: 500,
    },
    task: { id: `t-${l.id}`, open: true, resolution: null },
    obstacles: [],
  }
}

export const convList: ConvList = {
  drafting: 'Режим черновиков: клиенту уходит только то, что ты отправил кнопкой «Отправить».',
  rows: [
    {
      id: 'c-veronika',
      name: 'Вероника',
      title: 'Стратегия продвижения для студии керамики',
      group: 'waiting',
      last: 'А сколько будет стоить и сколько времени займёт?',
      lastAt: ago(4),
      lastSide: 'client',
    },
    {
      id: 'c-arina',
      name: 'Арина',
      title: 'Маркетинг для салона красоты',
      group: 'boris',
      last: 'Давайте в четверг в 15:00, удобно?',
      lastAt: ago(120),
      lastSide: 'us',
    },
    {
      id: 'c-pavel',
      name: 'Павел',
      title: 'Позиционирование студии дизайна',
      group: 'sara',
      last: 'Спасибо, подумаю и вернусь',
      lastAt: ago(1500),
      lastSide: 'client',
    },
    {
      id: 'c-irina',
      name: 'Ирина',
      title: 'Маркетинг для кондитерской',
      group: 'closed',
      last: 'Мы выбрали другого исполнителя',
      lastAt: ago(5000),
      lastSide: 'client',
    },
  ],
}

export function conv(id: string): ConvView | null {
  const row = convList.rows.find((r) => r.id === id)
  if (!row) return null
  const veronika = id === 'c-veronika'
  return {
    id,
    name: row.name,
    owner: row.group === 'boris' ? 'boris' : 'sara',
    closed: row.group === 'closed',
    orderId: veronika ? '95210417' : null,
    orderTitle: row.title,
    chatUrl: 'https://profi.ru/backoffice/',
    note: null,
    messages: veronika
      ? [
          {
            id: 'm1',
            side: 'us',
            author: 'я',
            text: LEADS[0]?.bid ?? '',
            at: ago(30),
            approx: false,
            read: true,
          },
          {
            id: 'm2',
            side: 'client',
            author: 'клиент',
            text: 'Здравствуйте! Да, звучит близко к тому, что нам нужно.',
            at: ago(6),
            approx: false,
            read: true,
          },
          {
            id: 'm3',
            side: 'client',
            author: 'клиент',
            text: 'А сколько будет стоить и сколько времени займёт?',
            at: ago(4),
            approx: false,
            read: true,
          },
        ]
      : [
          {
            id: 'm1',
            side: 'client',
            author: 'клиент',
            text: row.last ?? '',
            at: row.lastAt ?? ago(60),
            approx: false,
            read: true,
          },
        ],
    draft: veronika
      ? {
          taskId: 't-draft-veronika',
          kind: 'reply',
          text: 'Вероника, добрый день! Стоимость зависит от объёма: разбор и стратегия на полгода у нас от 40 000 до 60 000 ₽, это 2-3 недели работы. Точнее скажу после короткого созвона, 20 минут. Вам удобно завтра после обеда или в четверг утром?',
          why: 'Клиент спросил цену и срок. Цену называем вилкой по объёму и сразу ведём к созвону, как в записи «Как говорим о цене».',
          tone: 'спокойный',
          facts: [
            { id: 'K-014', title: 'Как говорим о цене' },
            { id: 'J-003', title: 'Созвон раньше КП' },
          ],
          at: ago(2),
        }
      : null,
    sendHold: null,
  }
}

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

export function analytics(year: number): AnalyticsView {
  const data: Record<string, [number, number, number, number]> = {
    Сентябрь: [14, 1, 4, 3120],
    Октябрь: [27, 2, 6, 6240],
  }
  const months: AnalyticsView['months'] = MONTHS.map((m) => {
    const [bids, won, lost, spend] =
      year === new Date(now).getFullYear() ? (data[m] ?? [0, 0, 0, 0]) : [0, 0, 0, 0]
    return {
      month: m,
      bids,
      won,
      lost,
      conversion: bids ? Math.round((won / bids) * 1000) / 10 : null,
      avgCheckRub: null,
      revenueRub: null,
      spendRub: spend,
      cacRub: won ? Math.round(spend / won) : null,
    }
  })
  const sum = (k: 'bids' | 'won' | 'lost' | 'spendRub') => months.reduce((a, m) => a + m[k], 0)
  const [bids, won, lost, spend] = [sum('bids'), sum('won'), sum('lost'), sum('spendRub')]
  months.push({
    month: 'ИТОГО',
    bids,
    won,
    lost,
    conversion: bids ? Math.round((won / bids) * 1000) / 10 : null,
    avgCheckRub: null,
    revenueRub: null,
    spendRub: spend,
    cacRub: won ? Math.round(spend / won) : null,
  })
  const c = (
    month: string,
    client: string,
    service: string,
    stage: AnalyticsView['clients'][number]['stage'],
    spend: number,
  ) => ({
    month,
    client,
    service,
    stage,
    dealRub: null,
    spendRub: spend,
    ltvRub: null,
    note: null,
    link: '/leads/95210417',
  })
  return {
    year,
    clients:
      year === new Date(now).getFullYear()
        ? [
            c('Сентябрь', 'Павел', 'Позиционирование', 'Переговоры', 220),
            c('Сентябрь', 'Ирина', 'Маркетинг', 'Отвалился', 180),
            c('Октябрь', 'Арина', 'Маркетинг', 'В работе', 180),
            c('Октябрь', 'Вероника', 'Маркетинговая стратегия', 'Переговоры', 240),
            c('Октябрь', 'Светлана', 'Маркетинг', 'Закрыта', 260),
            c('Октябрь', 'Игорь', 'Бренд-платформа', 'Отклик', 300),
          ]
        : [],
    funnel: [
      { stage: 'Отклик', count: 41, share: 100 },
      { stage: 'Переговоры', count: 17, share: 41.5 },
      { stage: 'В работе', count: 6, share: 14.6 },
      { stage: 'Закрыта', count: 3, share: 7.3 },
      { stage: 'Отвалился', count: 10, share: 24.4 },
    ],
    months,
    notes: [
      'Суммы договоров, выручка, средний чек и LTV появятся с итогами встреч (M6): Сара их пока не знает.',
      'Отклики старой Сары до 24.10 сюда пока не перенесены.',
      'Клиент сейчас это имя на аккаунте: два заказа одного человека с одним именем считаются одним клиентом.',
    ],
  }
}

const RECORDS = [
  {
    id: 'K-014',
    type: 'knowledge',
    scope: 'common',
    title: 'Как говорим о цене',
    topic: 'price',
    version: 3,
  },
  {
    id: 'K-021',
    type: 'knowledge',
    scope: 'common',
    title: 'Что входит в стратегию Hance',
    topic: null,
    version: 2,
  },
  {
    id: 'K-030',
    type: 'knowledge',
    scope: 'hance-marketing',
    title: 'Кейсы для малого бизнеса',
    topic: null,
    version: 1,
  },
  {
    id: 'U-002',
    type: 'understanding',
    scope: 'common',
    title: 'Клиент, который просит «просто тексты»',
    topic: null,
    version: 2,
  },
  {
    id: 'S-001',
    type: 'speech',
    scope: 'common',
    title: 'Приветствие и первая фраза',
    topic: null,
    version: 4,
  },
  {
    id: 'J-003',
    type: 'judgment',
    scope: 'common',
    title: 'Созвон раньше КП',
    topic: 'call',
    version: 1,
  },
  {
    id: 'E-011',
    type: 'example',
    scope: 'common',
    title: 'Ответ Бориса на «дорого»',
    topic: 'price',
    version: 1,
  },
]

export const mind: MindView = {
  mindVersion: '8c41f2a9d0',
  groups: [
    ['knowledge', 'Знание'],
    ['understanding', 'Понимание'],
    ['speech', 'Речь'],
    ['judgment', 'Суждение'],
    ['example', 'Образцы'],
  ].map(([type, title]) => ({
    type: type ?? '',
    title: title ?? '',
    records: RECORDS.filter((r) => r.type === type),
  })),
  proposals: [
    {
      id: 'p1',
      path: 'mind/knowledge/deadlines.md',
      kind: 'knowledge',
      source: 'lesson',
      state: 'new',
      action: 'create',
      at: ago(260),
      preview:
        'Сроки называем вместе с тем, от чего они зависят: доступы, ответы клиента, согласования.',
    },
    {
      id: 'p2',
      path: 'mind/speech/greeting.md',
      kind: 'speech',
      source: 'edit',
      state: 'written',
      action: 'update',
      at: ago(3000),
      preview: 'Без имени клиента всё равно здороваемся: «Добрый день!».',
    },
  ],
  gaps: [
    { text: 'Сколько стоит ведение соцсетей', topic: 'price', count: 3 },
    { text: 'Работаем ли по договору с ИП', topic: 'contract', count: 2 },
  ],
}

export function mindRecord(id: string): MindRecordView | null {
  const r = RECORDS.find((x) => x.id === id)
  if (!r) return null
  return {
    record: {
      ...r,
      body:
        r.id === 'K-014'
          ? 'Цену называем вилкой «от» и «до» по объёму, никогда одной цифрой и никогда «зависит от задачи» без цифр.\nСразу после цены предлагаем короткий созвон: на нём объём становится понятным, и вилка сужается.'
          : 'Текст записи разума. Его пишет Сара после твоего «да» на её предложение.',
      exampleClient: r.id === 'K-014' ? 'А сколько стоит?' : null,
      exampleBoris:
        r.id === 'K-014'
          ? 'Разбор и стратегия от 40 до 60 тысяч, точнее скажу после созвона на 20 минут.'
          : null,
      path: `mind/${r.type}/${r.id.toLowerCase()}.md`,
      tones: r.id === 'K-014' ? ['торг', 'сомнение'] : [],
      stages: [],
    },
    used: [
      { turnId: 'turn-1', conversationId: 'c-veronika', at: ago(2) },
      { turnId: 'turn-2', conversationId: 'c-arina', at: ago(2900) },
    ],
    proposals: [],
  }
}

export const settings: SettingsView = {
  groups: [
    {
      id: 'work',
      title: 'Работа',
      rows: [
        {
          key: 'outbound.bids',
          title: 'Тратит деньги на отклики',
          hint: 'Выключается и включается здесь, со вторым нажатием.',
          value: true,
          isDefault: false,
          edit: 'free',
          kind: 'flag',
          changedAt: ago(1500),
          changedBy: 'system',
        },
        {
          key: 'outbound.messages',
          title: 'Пишет клиентам',
          hint: 'Выключается и включается здесь, со вторым нажатием.',
          value: true,
          isDefault: false,
          edit: 'free',
          kind: 'flag',
          changedAt: ago(1500),
          changedBy: 'system',
        },
        {
          key: 'conv.autopilot',
          title: 'Автопилот разговоров',
          hint: 'Выключен: клиенту уходит только то, что ты отправил кнопкой «Отправить».',
          value: false,
          isDefault: true,
          edit: 'free',
          kind: 'flag',
          changedAt: null,
          changedBy: null,
        },
        {
          key: 'conv.reminders',
          title: 'Напоминает замолчавшим клиентам',
          hint: 'Пока выключены.',
          value: false,
          isDefault: false,
          edit: 'free',
          kind: 'flag',
          changedAt: ago(1400),
          changedBy: 'system',
        },
        {
          key: 'pipeline.leads',
          title: 'Карточки заявок',
          hint: null,
          value: true,
          isDefault: false,
          edit: 'locked',
          kind: 'flag',
          changedAt: ago(9000),
          changedBy: 'system',
        },
        {
          key: 'conv.v1_writes',
          title: 'Клиентам пишет старая Сара',
          hint: null,
          value: false,
          isDefault: false,
          edit: 'locked',
          kind: 'flag',
          changedAt: ago(4000),
          changedBy: 'system',
        },
      ],
    },
    {
      id: 'money',
      title: 'Деньги',
      rows: [
        {
          key: 'money.daily_bids',
          title: 'Откликов в день',
          hint: null,
          value: 10,
          isDefault: true,
          edit: 'free',
          kind: 'count',
          changedAt: null,
          changedBy: null,
        },
        {
          key: 'money.daily_budget_rub',
          title: 'Бюджет в день',
          hint: 'Пусто: без ограничения.',
          value: 1500,
          isDefault: false,
          edit: 'free',
          kind: 'rub',
          changedAt: ago(3000),
          changedBy: 'boris',
        },
        {
          key: 'money.max_fee_rub',
          title: 'Не дороже за отклик',
          hint: 'Пусто: без ограничения.',
          value: 400,
          isDefault: false,
          edit: 'free',
          kind: 'rub',
          changedAt: ago(3000),
          changedBy: 'boris',
        },
      ],
    },
    {
      id: 'cards',
      title: 'Уведомления',
      rows: [
        {
          key: 'cards.max_per_day',
          title: 'Карточек заявок в день',
          hint: null,
          value: 10,
          isDefault: true,
          edit: 'free',
          kind: 'count',
          changedAt: null,
          changedBy: null,
        },
        {
          key: 'conv.cards_per_day',
          title: 'Карточек разговоров в день',
          hint: null,
          value: 10,
          isDefault: true,
          edit: 'free',
          kind: 'count',
          changedAt: null,
          changedBy: null,
        },
        {
          key: 'notify.push',
          title: 'Push на телефон и компьютер',
          hint: null,
          value: {
            lead: true,
            draft: true,
            client: true,
            meeting: true,
            urgent: true,
            summary: false,
            system: false,
          },
          isDefault: true,
          edit: 'free',
          kind: 'other',
          changedAt: null,
          changedBy: null,
        },
        {
          key: 'cards.quiet_hours',
          title: 'Тихие часы',
          hint: 'По Москве: карточки и push приходят без звука, срочное звонит всегда.',
          value: { from: 23, to: 9 },
          isDefault: true,
          edit: 'free',
          kind: 'hours',
          changedAt: null,
          changedBy: null,
        },
      ],
    },
  ],
  directions: [
    {
      accountId: 'hance-marketing',
      title: 'Hance маркетинг',
      version: 4,
      threshold: 56,
      stops: [
        'Только исполнение: ведение соцсетей, таргет, дизайн без стратегии',
        'Бюджет меньше 15 000 ₽',
        'Сетевой маркетинг и сомнительные ниши',
      ],
      axes: [
        { title: 'Наш профиль: стратегия, а не исполнение', weight: 40 },
        { title: 'Деньги клиента', weight: 25 },
        { title: 'Ясность задачи', weight: 20 },
        { title: 'Город и формат', weight: 15 },
      ],
    },
  ],
  history: [
    {
      key: 'money.daily_budget_rub',
      title: 'Бюджет в день',
      value: 1500,
      by: 'boris',
      at: ago(3000),
    },
    {
      key: 'conv.reminders',
      title: 'Напоминает замолчавшим клиентам',
      value: false,
      by: 'system',
      at: ago(1400),
    },
  ],
}

export const system: SystemView = {
  parts: [
    { id: 'db', title: 'База данных', tone: 'ok', text: 'Работает', fix: null, at: null },
    {
      id: 'node',
      title: 'Узел Профи.ру',
      tone: 'ok',
      text: 'Отвечает, событий в очереди к ядру 0',
      fix: null,
      at: ago(0),
    },
    {
      id: 'telegram',
      title: 'Telegram',
      tone: 'ok',
      text: 'Бот @hance_sara_bot на связи',
      fix: null,
      at: null,
    },
    {
      id: 'claude',
      title: 'Claude',
      tone: 'ok',
      text: 'Пробный вызов прошёл за 2140 мс',
      fix: null,
      at: null,
    },
    {
      id: 'session',
      title: 'Сессия Профи.ру',
      tone: 'ok',
      text: 'Сессия жива, IP свой, в очереди к ядру 0',
      fix: null,
      at: null,
    },
    {
      id: 'link',
      title: 'Связь с Профи.ру',
      tone: 'ok',
      text: 'Связь есть, последний перерыв закончился',
      fix: null,
      at: ago(2600),
    },
    {
      id: 'backup',
      title: 'Резервные копии',
      tone: 'ok',
      text: 'Ночная копия есть, проверка восстановления проходила',
      fix: null,
      at: ago(560),
    },
  ],
  claude: {
    limited: false,
    until: null,
    roles: [
      { role: 'scorer', calls: 214, failed: 1, ms: 2_940_000 },
      { role: 'analyst', calls: 23, failed: 0, ms: 1_210_000 },
      { role: 'interlocutor', calls: 9, failed: 0, ms: 420_000 },
      { role: 'checker', calls: 9, failed: 0, ms: 160_000 },
      { role: 'probe', calls: 24, failed: 0, ms: 52_000 },
    ],
  },
  accounts: [
    {
      id: 'hance-marketing',
      title: 'Hance маркетинг',
      login: 'alive',
      paused: false,
      balanceRub: 1840,
    },
  ],
}

export const accounts = {
  accounts: [
    {
      id: 'hance-marketing',
      title: 'Hance маркетинг',
      login_state: 'alive',
      balance_rub: 1840,
      presence: true,
      egress_ip: '203.0.113.7',
      ip_ok: true,
    },
  ],
}
