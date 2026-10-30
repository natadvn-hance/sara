import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FetchPolicy, fetchPage, isPublicAddress, PUBLIC_ONLY } from '../../src/site/fetch'

/** The made-up internet of the test: names that resolve to the test server (loopback) or to a private address. */
const NAMES: Record<string, string> = {
  'shop.example.com': '127.0.0.1',
  'internal.example.com': '10.0.0.5',
  'mixed.example.com': '127.0.0.1,10.0.0.5',
  'metadata.example.com': '169.254.169.254',
}
/** Loopback is the test server's own and only for its name; every other address is judged as the real policy judges it. */
const POLICY: FetchPolicy = {
  resolve: async (host) => {
    const found = NAMES[host]
    if (!found) throw Object.assign(new Error('nxdomain'), { code: 'ENOTFOUND' })
    return found.split(',').map((address) => ({ address, family: 4 }))
  },
  allowAddress: (ip, host) =>
    (ip === '127.0.0.1' && host === 'shop.example.com') || isPublicAddress(ip),
  allowPort: () => true,
}

let server: Server
let base = ''
const hits: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    hits.push(url)
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>Кофе</title></head><body><h1>Кофе дом</h1></body></html>',
      )
    } else if (url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    } else if (url === '/to-loopback-ip') {
      res.writeHead(302, {
        location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      })
      res.end()
    } else if (url === '/to-internal-name') {
      res.writeHead(301, { location: 'http://internal.example.com/' })
      res.end()
    } else if (url === '/to-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' })
      res.end()
    } else if (url === '/loop') {
      res.writeHead(302, { location: '/loop' })
      res.end()
    } else if (url === '/relative') {
      res.writeHead(302, { location: '/' })
      res.end()
    } else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' })
      const chunk = `<p>${'слово '.repeat(1000)}</p>`
      for (let i = 0; i < 400; i++) res.write(chunk)
      res.end('</body></html>')
    } else if (url === '/bomb') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.alloc(40_000_000, 'a')))
    } else if (url === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
      res.end(gzipSync('<html><body>сжатая страница</body></html>'))
    } else if (url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.write('<html><body>начало')
      // never ends
    } else if (url === '/silent') {
      // never answers
    } else if (url === '/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end('%PDF-1.4')
    } else if (url === '/cp1251') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1251' })
      res.end(Buffer.from([0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))
    } else {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('нет')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://shop.example.com:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

describe('the public-address rule', () => {
  it('FR-SITE-4: private, local, link-local and reserved addresses are not public', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
      '0:0:0:0:0:0:0:1',
      '64:ff9b::a00:1',
      'not an ip',
    ])
      expect(isPublicAddress(ip), ip).toBe(false)
  })

  it('FR-SITE-4: ordinary public addresses are public', () => {
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '2606:2800:220:1:248:1893:25c8:1946',
      '::ffff:8.8.8.8',
    ])
      expect(isPublicAddress(ip), ip).toBe(true)
  })
})

describe('the safe fetch, with the default policy', () => {
  it('FR-SITE-4: local names, literal local addresses, odd ports and other schemes are refused before any connection', async () => {
    const cases: [string, string][] = [
      ['http://localhost/', 'blocked'],
      ['http://127.0.0.1/', 'blocked'],
      ['http://127.0.0.1:7070/', 'blocked'],
      ['http://[::1]/', 'blocked'],
      ['http://[::ffff:127.0.0.1]/', 'blocked'],
      ['http://10.1.2.3/', 'blocked'],
      ['http://192.168.0.1/', 'blocked'],
      ['http://169.254.169.254/latest/meta-data/', 'blocked'],
      ['http://0.0.0.0/', 'blocked'],
      ['http://2130706433/', 'blocked'],
      ['http://0x7f.1/', 'blocked'],
      ['http://core/', 'blocked'],
      ['http://postgres:5432/', 'blocked'],
      ['http://printer.local/', 'blocked'],
      ['http://db.internal/', 'blocked'],
      ['https://example.com:8443/', 'blocked'],
      ['http://example.com:22/', 'blocked'],
      ['ftp://example.com/', 'bad_url'],
      ['file:///etc/passwd', 'bad_url'],
      ['https://user:pass@example.com/', 'bad_url'],
      ['not a url', 'bad_url'],
    ]
    for (const [url, error] of cases) {
      const r = await fetchPage(url)
      expect(r.ok, url).toBe(false)
      if (!r.ok) expect(r.error, url).toBe(error)
    }
  })

  it('FR-SITE-4: the default policy takes only ports 80 and 443', () => {
    expect(PUBLIC_ONLY.allowPort(80)).toBe(true)
    expect(PUBLIC_ONLY.allowPort(443)).toBe(true)
    expect(PUBLIC_ONLY.allowPort(8080)).toBe(false)
    expect(PUBLIC_ONLY.allowPort(6379)).toBe(false)
  })
})

describe('the safe fetch, over a made-up internet', () => {
  it('FR-SITE-4: an ordinary page is read', async () => {
    const r = await fetchPage(`${base}/`, { policy: POLICY })
    expect(r.ok && r.html).toContain('Кофе дом')
  })

  it('FR-SITE-4: a redirect to a local or private target is refused, every kind of it', async () => {
    for (const path of ['/to-metadata', '/to-loopback-ip', '/to-internal-name', '/to-file']) {
      const r = await fetchPage(`${base}${path}`, { policy: POLICY })
      expect(r.ok, path).toBe(false)
    }
    const loopback = await fetchPage(`${base}/to-loopback-ip`, { policy: POLICY })
    expect(!loopback.ok && loopback.error).toBe('blocked')
    const meta = await fetchPage(`${base}/to-metadata`, { policy: POLICY })
    expect(!meta.ok && meta.error).toBe('blocked')
    const internal = await fetchPage(`${base}/to-internal-name`, { policy: POLICY })
    expect(!internal.ok && internal.error).toBe('blocked')
    const file = await fetchPage(`${base}/to-file`, { policy: POLICY })
    expect(!file.ok && file.error).toBe('bad_url')
  })

  it('FR-SITE-4: a name that gives a private address, or one private among public ones, is refused', async () => {
    const port = new URL(base).port
    for (const host of ['internal.example.com', 'mixed.example.com', 'metadata.example.com']) {
      const r = await fetchPage(`http://${host}:${port}/`, { policy: POLICY })
      expect(!r.ok && r.error, host).toBe('blocked')
    }
    const r = await fetchPage(`http://nowhere.example.com:${port}/`, { policy: POLICY })
    expect(!r.ok && r.error).toBe('dns')
  })

  it('FR-SITE-4: a relative redirect is followed, a loop stops', async () => {
    const ok = await fetchPage(`${base}/relative`, { policy: POLICY })
    expect(ok.ok && ok.html).toContain('Кофе дом')
    const loop = await fetchPage(`${base}/loop`, { policy: POLICY, limits: { maxRedirects: 3 } })
    expect(!loop.ok && loop.error).toBe('too_many_redirects')
  })

  it('FR-SITE-5: a page bigger than the limit is cut, not read to its end', async () => {
    const r = await fetchPage(`${base}/big`, { policy: POLICY, limits: { maxBytes: 20_000 } })
    expect(r.ok && r.truncated).toBe(true)
    expect(r.ok && r.html.length).toBeLessThanOrEqual(20_000)
  })

  it('FR-SITE-5: a gzip bomb is cut at the limit after decompression', async () => {
    const r = await fetchPage(`${base}/bomb`, { policy: POLICY, limits: { maxBytes: 50_000 } })
    expect(r.ok && r.truncated).toBe(true)
    expect(r.ok && r.html.length).toBeLessThanOrEqual(50_000)
  })

  it('FR-SITE-5: a gzip page is unpacked', async () => {
    const r = await fetchPage(`${base}/gzip`, { policy: POLICY })
    expect(r.ok && r.html).toContain('сжатая страница')
  })

  it('FR-SITE-5: a server that never answers, or never ends, is given up at the time limit', async () => {
    const t0 = Date.now()
    const silent = await fetchPage(`${base}/silent`, { policy: POLICY, limits: { timeoutMs: 300 } })
    expect(!silent.ok && silent.error).toBe('timeout')
    // A page that began and stalled keeps the part that came.
    const slow = await fetchPage(`${base}/slow`, { policy: POLICY, limits: { timeoutMs: 300 } })
    expect(slow.ok && slow.html).toContain('начало')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('FR-SITE-5: a file that is not a page, and an error status, are no page', async () => {
    const pdf = await fetchPage(`${base}/pdf`, { policy: POLICY })
    expect(!pdf.ok && pdf.error).toBe('not_html')
    const missing = await fetchPage(`${base}/nothing`, { policy: POLICY })
    expect(!missing.ok && missing.error).toBe('http_404')
  })

  it('FR-SITE-5: the page is decoded by its charset', async () => {
    const r = await fetchPage(`${base}/cp1251`, { policy: POLICY })
    expect(r.ok && r.html).toContain('Привет')
  })
})
