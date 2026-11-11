import { isTestOrder } from '@sara/shared'
import { forClient, type ProfiClient, ProfiError } from '../profi/client'

/**
 * The node's client that never takes a test order (docs/ops/test-leads.md): the core's own lock, before the live node
 * refuses one too. A test number reaching it means a bug, so it fails loudly and nothing moves on Profi.ru.
 */
export function guardLive(live: ProfiClient): ProfiClient {
  const refuse = (id: string) => {
    if (isTestOrder(id))
      throw new ProfiError('NOT_FOUND', `${id} is a test order: it never goes to the node`)
  }
  return {
    sessionHealth: (a) => live.sessionHealth(a),
    async getOrder(a, id) {
      refuse(id)
      return live.getOrder(a, id)
    },
    async submitBid(i) {
      refuse(i.order_id)
      return live.submitBid(i)
    },
    async readChat(a, c) {
      refuse(c)
      return live.readChat(a, c)
    },
    listChats: (a) => live.listChats(a),
    async sendMessage(i) {
      refuse(i.chat_id)
      return live.sendMessage(i)
    },
  }
}

/**
 * One Profi client for the whole core: a test order or its chat goes to the made-up Profi.ru inside the core, anything
 * else to the node behind its lock. The chat list is both: test chats are followed like live ones.
 */
export function routeTestOrders(live: ProfiClient, test: () => ProfiClient | null): ProfiClient {
  const node = guardLive(live)
  const made = (): ProfiClient => {
    const t = test()
    if (!t) throw new ProfiError('INTERNAL', 'тестовые заявки не запущены')
    return t
  }
  return {
    sessionHealth: (a) => node.sessionHealth(a),
    getOrder: async (a, id) => (isTestOrder(id) ? made() : node).getOrder(a, id),
    // A test chat gets the text a real client would: the node's client makes it so for a real one (11.11.2026).
    submitBid: async (i) =>
      isTestOrder(i.order_id)
        ? made().submitBid({ ...i, text: forClient(i.text) })
        : node.submitBid(i),
    readChat: async (a, c) => (isTestOrder(c) ? made() : node).readChat(a, c),
    sendMessage: async (i) =>
      isTestOrder(i.chat_id)
        ? made().sendMessage({ ...i, text: forClient(i.text, { asWritten: i.asWritten }) })
        : node.sendMessage(i),
    async listChats(a) {
      const live = await node.listChats(a)
      const t = test()
      const made = t ? await t.listChats(a).catch(() => ({ chats: [] })) : { chats: [] }
      return { chats: [...live.chats, ...made.chats] }
    },
  }
}
