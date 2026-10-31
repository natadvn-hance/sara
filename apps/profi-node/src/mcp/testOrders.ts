import { isTestOrder } from '@sara/shared'
import { ProfiToolError, type ProfiToolsImpl } from './server'

/**
 * The live node never works a test order (docs/ops/test-leads.md): such a number goes to the core's made-up Profi.ru,
 * and should one come here by mistake, the node refuses it before any tab moves. The second lock after the core's own.
 */
export function refuseTestOrders(tools: ProfiToolsImpl): ProfiToolsImpl {
  const refuse = (id: string) => {
    if (isTestOrder(id))
      throw new ProfiToolError('NOT_FOUND', `${id} is a test order, the live node never works it`)
  }
  return {
    ...tools,
    async getOrder(i) {
      refuse(i.order_id)
      return tools.getOrder(i)
    },
    async readChat(i) {
      refuse(i.chat_id)
      return tools.readChat(i)
    },
    async submitBid(i, signal) {
      refuse(i.order_id)
      return tools.submitBid(i, signal)
    },
    async sendMessage(i, signal) {
      refuse(i.chat_id)
      return tools.sendMessage(i, signal)
    },
  }
}
