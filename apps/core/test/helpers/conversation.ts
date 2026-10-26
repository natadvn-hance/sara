import type { ChatMessage, InterlocutorOutput } from '@sara/shared'
import type { CaseHit, MindHit, MindSearch } from '../../src/conversation/types'
import type { ProfiClient } from '../../src/profi/client'

/** A Profi client whose chat is an array the test changes between reads. */
export function stubProfi(messages: ChatMessage[]): ProfiClient & { chat: ChatMessage[] } {
  const unused = async (): Promise<never> => {
    throw new Error('not used here')
  }
  const p = {
    chat: messages,
    sessionHealth: unused,
    submitBid: unused,
    listChats: unused,
    getOrder: unused,
    sendMessage: unused,
    readChat: async () => ({ messages: [...p.chat] }),
  }
  return p
}

export function chatMsg(
  id: string,
  author: ChatMessage['author'],
  text: string,
  at: string,
  chatId = '95147898',
): ChatMessage {
  return { platform_message_id: id, chat_id: chatId, author, sent_at: at, text, read: true }
}

/** A full Interlocutor answer: a reply on the process with one fact. */
export function interlocutorAnswer(o: Partial<InterlocutorOutput> = {}): InterlocutorOutput {
  return {
    heard: { said: 'Спросила, как начинаем', behind: 'Хочет понять первый шаг' },
    question_type: 'u-process',
    topic: 'process',
    tone: 'neutral',
    move: 'reply',
    urgent: false,
    why: 'Порядок работы есть в разуме',
    text: 'Начинаем с короткого созвона, чтобы понять задачу. Удобно завтра?',
    fact_ids: ['k-process-start'],
    example_ids: [],
    missing: null,
    ...o,
  }
}

export const mindHit = (id: string, type: MindHit['type'], o: Partial<MindHit> = {}): MindHit => ({
  id,
  type,
  scope: 'shared',
  title: id,
  body: `Текст ${id}`,
  topic: null,
  tones: [],
  stages: [],
  exampleClient: null,
  exampleBoris: null,
  rank: 1,
  ...o,
})

/** An invented case of Hance, in the format the case search returns it. */
export const caseOf = (
  id: string,
  title: string,
  o: Partial<CaseHit> & { role?: string; work?: string; where?: string; period?: string } = {},
): CaseHit => {
  const {
    role = 'Под ключ, команда из двух человек.',
    work = 'Собрали сайт, настроили запись и рекламу.',
    where = 'Tilda, Яндекс Директ',
    period = '20 рабочих дней',
    ...rest
  } = o
  const summary = rest.summary ?? `Сделали для ${title} сайт и настроили рекламу.`
  const result = rest.result === undefined ? 'Заявок стало в полтора раза больше.' : rest.result
  const showRules = rest.showRules ?? ['Компанию можно называть.']
  return {
    ...mindHit(id, 'knowledge', {
      title,
      body: [
        `# ${title}`,
        summary,
        `## Что делали\n${work}`,
        `## Где\n${where}`,
        `## Роль и масштаб\n${role}`,
        ...(result ? [`## Результат\n${result}`] : []),
        `## Срок\n${period}`,
        `## Как показывать клиенту\n${showRules.map((r) => `- ${r}`).join('\n')}`,
      ].join('\n\n'),
    }),
    summary,
    result,
    showRules,
    nameOpen: true,
    numbersOpen: false,
    ...rest,
  }
}

/** Invented cases of the fake mind: the first fits a clinic, the others do not. */
export const INVENTED_CASES: CaseHit[] = [
  caseOf('k-case-01', 'Лиса-Клиник: онлайн-запись, Краснодар'),
  caseOf('k-case-02', 'Сеть кофеен: реклама, Сочи', {
    showRules: ['Компанию не называть: NDA.'],
    nameOpen: false,
  }),
  caseOf('k-case-03', 'Окна-Мастер: сайт и заявки, Москва', {
    result: '120 заявок за первый месяц.',
    showRules: ['Компанию можно называть.', 'Цифры из «Результата» можно называть как есть.'],
    numbersOpen: true,
  }),
  caseOf('k-case-04', 'Школа танцев: стратегия маркетинга, Казань'),
]

/** A small mind in memory: one understanding, one fact, two examples (one not Boris's), a stage procedure. */
export function fakeMind(): MindSearch {
  return {
    version: async () => 'mind-v1',
    cases: async (q) => INVENTED_CASES.filter((c) => !q.exclude?.includes(c.id)).slice(0, q.limit),
    search: async (q) => {
      if (q.types.includes('understanding')) return [mindHit('u-process', 'understanding')]
      if (q.types.includes('knowledge'))
        return [mindHit('k-process-start', 'knowledge', { body: 'Начинаем с созвона на 30 минут' })]
      if (q.types.includes('example'))
        return [
          mindHit('e-1', 'example', {
            exampleClient: 'Как начнём?',
            exampleBoris: 'Начнём с короткого созвона',
          }),
          mindHit('e-2', 'example', { exampleClient: 'Как начнём?', exampleBoris: null }),
        ]
      return []
    },
    byIds: async (ids) => ids.map((id) => mindHit(id, id.startsWith('s-') ? 'speech' : 'judgment')),
    byStage: async () => mindHit('j-stage-talking', 'judgment', { stages: ['talking'] }),
    bannedPhrases: async () => ['Рад помочь'],
  }
}
