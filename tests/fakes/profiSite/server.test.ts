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
})
