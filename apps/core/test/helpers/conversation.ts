import type { ChatMessage, InterlocutorOutput } from '@sara/shared'
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
