import { RULES_V1 } from '../../src/direction/v1'

/** Fake answers of the onboarding roles, valid against the contracts. */
export const ABOUT = {
  understood: 'Вы делаете маркетинг для малого бизнеса: стратегия, сайты, воронки.',
  about: 'Hance: системный маркетинг для малого и среднего бизнеса.',
  services: ['стратегия', 'сайты', 'воронки'],
  clients: ['малый бизнес'],
  budgets: ['от 50 000 ₽'],
}
export const STOPS = {
  understood: 'Не берёте узкий Директ и вакансии в штат; цену за копейки считаете красным флагом.',
  stop_factors: [
    { id: 'direct', text: 'Только Директ', exception: null, examples: ['настроить Директ'] },
  ],
  red_flags: [{ id: 'cheap', text: 'Ищут самого дешёвого', soft: false }],
}
export const IDEAL = {
  understood: 'Лучшие заказы: понятная задача, зрелый клиент, бюджет от 50 000 ₽.',
  axes: [
    { id: 'client', title: 'Клиент', weight: 60, how: 'Зрелый ли бизнес' },
    { id: 'task', title: 'Задача', weight: 40, how: 'Понятна ли задача' },
  ],
  threshold: 55,
  notes: ['Скромный бюджет у зрелого клиента не повод отсеивать'],
}
/** An about that is exactly the active rules' one, for «nothing changed». */
export const SAME_ABOUT = { ...ABOUT, about: RULES_V1.about }

/** Fake answers of the format and cases roles: three sample bodies (one per order given, in its order) and a library. */
export const FORMAT_ANSWER = {
  understood: 'Отклик в две части: понимание ситуации и один вопрос, до 400 знаков, спокойный тон.',
  reply_format: {
    parts: [
      { id: 'understanding', title: 'Понимание', hint: 'Про ситуацию клиента своими словами' },
      { id: 'question', title: 'Вопрос', hint: 'Один короткий вопрос' },
    ],
    max_chars: 400,
    tone: ['спокойно, без клише'],
    examples: [],
    max_cases: 2,
  },
  samples: [
    'Понимаю, для вас важно быстро начать запись.\n\nКогда хотите открыть запись онлайн?',
    'Похоже, сайт нужен без долгого запуска.\n\nЧто для вас главное в первый месяц?',
    'Задача ясна: нужен понятный первый шаг.\n\nКакой срок для вас критичен?',
  ],
}
export const CASE = {
  id: 'clinic_site',
  title: 'Сайт клиники',
  url: 'https://hance.example/cases/clinic',
  summary: 'Запись онлайн, плюс 40% обращений',
  tags: ['сайт', 'медицина'],
  show_when: 'Клиенту нужен сайт услуг с записью',
  never_when: null,
}
export const CASES_ANSWER = {
  understood: 'Один кейс: сайт клиники. Показывать, когда нужен сайт услуг с записью.',
  cases: [CASE],
}
