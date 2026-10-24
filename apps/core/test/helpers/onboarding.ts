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
