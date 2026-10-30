import type { Behaviour } from '@sara/profi-node/stand'
import type { TestLeads } from './testLeads'

/** Words after /test, and how the client of the new test order behaves. */
const BEHAVIOUR_WORDS: Record<string, Behaviour> = {
  отвечает: 'answers',
  цена: 'price',
  созвон: 'call',
  молчит: 'silent',
  уходит: 'leaves',
  сам: 'manual',
}

const HELP =
  'Команды: /test (копия реального заказа), /test выдуманный, /test цена, /test созвон, /test молчит, /test уходит, /test сам, /test день (пять заказов), /test стереть.'

/**
 * Boris's /test in the bot (docs/ops/test-leads.md): a test order into the live Sara, a day of them, or all of them
 * erased. The answer names the page where he writes for the client.
 */
export async function testCommand(t: TestLeads, args: string, publicUrl: string): Promise<string> {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const page = `${publicUrl.replace(/\/$/, '')}/api/test/`
  if (words[0] === 'стереть') {
    const n = await t.wipe()
    return `🧪 Стёрла тестовых заявок: ${n}. Их карточки в чате остаются, но кнопки больше ничего не делают.`
  }
  if (words[0] === 'день') {
    const a = await t.stand.api('POST', 'scenario', JSON.stringify({ name: 'full-day' }))
    const ids = (a.json as { orderIds?: string[] }).orderIds ?? []
    return `🧪 Пошли пять тестовых заявок, раз в минуту, первая ${ids[0] ?? ''}. Клиенты ведут себя по-разному. Страница: ${page}`
  }
  const sample = words.includes('выдуманный')
  const behaviour = words.map((w) => BEHAVIOUR_WORDS[w]).find(Boolean)
  if (words.some((w) => w !== 'выдуманный' && !BEHAVIOUR_WORDS[w])) return HELP
  const view = (await t.stand.api('GET', 'state', '')).json as { realCount: number }
  const from = sample || view.realCount === 0 ? 'sample' : 'real'
  const id = await t.stand.addOrder({ from, behaviour })
  const plan = t.stand.state.plans[id]
  return `🧪 Подкинула тестовую заявку ${id} (${from === 'real' ? 'копия реального заказа, имена заменены' : 'выдуманная'}), клиент: ${plan ? BEHAVIOUR_RU[plan.behaviour] : 'отвечает'}. Карточка придёт через минуту. Написать за клиента: ${page}`
}

const BEHAVIOUR_RU: Record<Behaviour, string> = {
  answers: 'отвечает сам',
  price: 'просит цену',
  call: 'просит созвон',
  silent: 'молчит',
  leaves: 'уйдёт к другому',
  script: 'по сценарию',
  manual: 'пишешь за него ты',
}
