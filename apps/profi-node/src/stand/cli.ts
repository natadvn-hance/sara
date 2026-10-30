// Commands of the test stand inside its container (scripts/staging/server.sh calls them; docs/ops/staging.md):
//   import  reads JSON lines from stdin ({"lead": row} or {"persona": row}) and keeps them nobody's
//   order [sample|real][:n]   scenario <name|->   status
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { LeadRow, pseudonymize } from './pseudonymize'

const DATA = process.env.STAND_DATA_DIR ?? '/stand-data'
const API = `http://127.0.0.1:${process.env.STAND_PORT ?? 7070}/stand/api`

const LivePersona = z.object({
  id: z.string(),
  archetype: z.string(),
  niche: z.string(),
  task: z.string(),
  mood: z.string(),
  style: z.string(),
  questions: z.array(z.string()),
})

async function keep(file: string, rows: unknown[]): Promise<void> {
  await mkdir(DATA, { recursive: true })
  const tmp = join(DATA, `${file}.tmp`)
  await writeFile(tmp, JSON.stringify(rows))
  await rename(tmp, join(DATA, file))
}

async function stdinText(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = (await r.json()) as Record<string, unknown>
  if (!r.ok) throw new Error(String(j.error ?? r.status))
  return j
}

const [command, arg] = process.argv.slice(2)
if (command === 'import') {
  // Raw rows pass through memory only: what reaches the disk is already made up.
  const copies = []
  const personas = []
  let skipped = 0
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as { lead?: unknown; persona?: unknown }
    const lead = LeadRow.safeParse(row.lead)
    if (lead.success) copies.push(pseudonymize(lead.data))
    const persona = LivePersona.safeParse(row.persona)
    if (persona.success) personas.push(persona.data)
    if (!lead.success && !persona.success) skipped++
  }
  await keep('real-orders.json', copies)
  await keep('personas-live.json', personas)
  console.log(
    `Копий реальных заказов: ${copies.length}, персон тренажёра: ${personas.length}${skipped ? `, пропущено строк: ${skipped}` : ''}`,
  )
} else if (command === 'order') {
  const out = await api('orders', { from: arg ?? 'real' })
  console.log(`Заказ ${out.orderId} в ленте стенда`)
} else if (command === 'scenario') {
  const body = arg === '-' || !arg ? JSON.parse(await stdinText()) : { name: arg }
  const out = await api('scenario', body)
  const ids = out.orderIds as string[]
  console.log(
    `Сценарий «${out.title}»: сразу ${ids.length} заказ(а) ${ids.join(', ')}, остальные по таймеру`,
  )
} else if (command === 'status') {
  const s = await api('state')
  const orders = s.orders as { id: string; title: string; has_bid: boolean; messages: unknown[] }[]
  const usage = s.usage as { today: number; limit: number }
  console.log(`Кошелёк ${s.balance} ₽, модель-клиент сегодня ${usage.today} из ${usage.limit}`)
  console.log(`Копий реальных заказов: ${s.realCount}; заказов на стенде: ${orders.length}`)
  for (const o of orders.slice(0, 10))
    console.log(
      `  ${o.id} ${o.has_bid ? 'отклик есть' : 'без отклика'}, сообщений ${o.messages.length}: ${o.title}`,
    )
} else {
  console.log('Команды: import | order [sample|real][:n] | scenario <имя|-> | status')
  process.exit(1)
}
