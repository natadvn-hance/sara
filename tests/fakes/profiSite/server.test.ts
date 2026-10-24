import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type ProfiSite, startProfiSite } from './server'

let site: ProfiSite
beforeEach(async () => {
  site = await startProfiSite()
})
afterEach(() => site.close())

async function login(): Promise<string> {
  await fetch(`${site.url}/login/phone`, {
    method: 'POST',
    body: JSON.stringify({ phone: '+79000000001' }),
  })
  const r = await fetch(`${site.url}/login/code`, {
    method: 'POST',
    body: JSON.stringify({ code: site.code }),
  })
  return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

describe('stand-in Profi.ru', () => {
  it('ADR-017: login by phone and code sets a session cookie', async () => {
    const cookie = await login()
    expect(cookie).toMatch(/^sess=/)
    const page = await fetch(`${site.url}/backoffice/a.php`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(page.status).toBe(200)
  })

  it('ADR-017: a new order is pushed over the event stream and listed in the feed response', async () => {
    const cookie = await login()
    const ws = new WebSocket(`${site.rtpUrl}/rtp`, { headers: { cookie } })
    const got = new Promise<string>((ok) => ws.on('message', (m) => ok(String(m))))
    await new Promise((r) => ws.on('open', r))
    const id = site.addOrder({ subject: 'Лендинг для курса' })
    expect(JSON.parse(await got)).toMatchObject({ type: 'order.new', order: { id } })
    const feed = (await (await fetch(`${site.url}/api/feed`, { headers: { cookie } })).json()) as {
      items: { id: string }[]
    }
    expect(feed.items.map((o: { id: string }) => o.id)).toContain(id)
    ws.close()
  })

  it('ADR-017: logout sends every page to the login page', async () => {
    const cookie = await login()
    site.logout()
    const page = await fetch(`${site.url}/backoffice/a.php`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/login')
  })

  it('FR-LEAD-5: the backoffice API answers getKlientInfo with the client of the order, in the live shape', async () => {
    const cookie = await login()
    const id = site.addOrder({
      klient: {
        name: 'Ирина',
        title: 'На Профи.ру с 7 сентября 2020',
        verified: true,
        positive: 3,
        negative: 1,
        tags: ['Перестала отвечать'],
      },
    })
    const ask = async (orderId: string) =>
      fetch(`${site.url}/backoffice/api/`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ method: 'getKlientInfo', orderId }),
      })
    const r = await ask(id)
    expect(await r.json()).toEqual({
      data: {
        name: 'Ирина',
        title: 'На Профи.ру с 7 сентября 2020',
        labels: [{ text: 'Номер подтверждён' }],
        reviews: { count: { positive: 3, negative: 1 }, list: [{ tags: ['Перестала отвечать'] }] },
      },
    })
    const none = site.addOrder({ klient: null })
    expect((await ask(none)).status).toBe(404)
  })

  it('FR-LEAD-1: a paged board answers the first page with nextCursor and the rest by cursor', async () => {
    const cookie = await login()
    for (let i = 0; i < 12; i++) site.addOrder()
    site.boardPageSize = 5
    const page = async (cursor?: string) =>
      (await (
        await fetch(`${site.url}/api/feed${cursor ? `?cursor=${cursor}` : ''}`, {
          headers: { cookie },
        })
      ).json()) as { items: { id: string }[]; nextCursor?: string | null }
    const a = await page()
    expect(a.items).toHaveLength(5)
    expect(typeof a.nextCursor).toBe('string')
    const b = await page(a.nextCursor ?? '')
    const c = await page(b.nextCursor ?? '')
    expect([b.items.length, c.items.length, c.nextCursor]).toEqual([5, 2, null])
    expect(new Set([...a.items, ...b.items, ...c.items].map((o) => o.id)).size).toBe(12)
    expect(site.feedRequests).toBe(3)
  })
})
