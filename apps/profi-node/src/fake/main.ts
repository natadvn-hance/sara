// Dev entry: fake Profi.ru on port 7070. POST /fake/orders emits a random sample order to the core.
import { createFakeProfi } from './fakeProfi'
import { sampleOrders } from './sampleOrders'

const port = Number(process.env.SARA_FAKE_PROFI_PORT ?? 7070)
const coreUrl = process.env.SARA_CORE_URL ?? 'http://127.0.0.1:3300'

let emit: ((o?: { order_id?: string }) => Promise<string>) | undefined
const fake = await createFakeProfi({
  port,
  coreEventsUrl: `${coreUrl}/internal/profi/events`,
  nodeToken: process.env.SARA_NODE_TOKEN ?? 'dev-node-token',
  permitSecret: process.env.SARA_PERMIT_SECRET ?? 'dev-permit-secret',
  extra: async (req, _body, res) => {
    if (req.method !== 'POST' || req.url !== '/fake/orders' || !emit) return false
    const orders = sampleOrders()
    const pick = orders[Math.floor(Math.random() * orders.length)]
    // seen_at is left out so the order is seen now, not at the sample's date.
    const { seen_at: _seenAt, ...order } = pick ?? {}
    const id = await emit({ ...order, order_id: `${Date.now()}` })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ eventId: id }))
    return true
  },
})
emit = fake.emitOrder
console.log(`Фальшивый Профи.ру: ${fake.url}`)
