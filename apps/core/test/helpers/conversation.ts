import type { ChatMessage } from '@sara/shared'
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
