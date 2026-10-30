import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/**
 * One page of a client's site, read safely from the server's own exit: http(s) only, public addresses only (checked
 * at the moment of connecting, so a name that turns local between the check and the call is refused too), every
 * redirect checked again, the default ports only, a time limit and a size limit, and no script ever run: the page
 * is only text to the core.
 */

export type FetchPolicy = {
  /** The addresses of a host name. */
  resolve(host: string): Promise<{ address: string; family: number }[]>
  /** Whether the core may connect to this address for this host. */
  allowAddress(ip: string, host: string): boolean
  allowPort(port: number): boolean
}

export type FetchLimits = {
  /** The whole page, redirects included. */
  timeoutMs: number
  /** The most bytes of HTML kept, after decompression; the rest of a bigger page is not read. */
  maxBytes: number
  maxRedirects: number
}

export const PAGE_LIMITS: FetchLimits = { timeoutMs: 8_000, maxBytes: 1_500_000, maxRedirects: 4 }

export type FetchError =
  | 'bad_url'
  | 'blocked'
  | 'dns'
  | 'timeout'
  | 'too_many_redirects'
  | 'not_html'
  | 'network'
  | `http_${number}`

export type Fetched =
  | { ok: true; url: string; html: string; truncated: boolean; bytes?: Buffer }
  | { ok: false; error: FetchError; url: string }

/** Private, local, shared, reserved and documentation ranges: never a client's public site (SSRF). */
const NOT_PUBLIC = (() => {
  const b = new BlockList()
  for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    b.addSubnet(net, bits, 'ipv4')
  for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const)
    b.addSubnet(net, bits, 'ipv6')
  return b
})()

/** An IPv4 address written inside an IPv6 one (::ffff:10.0.0.1, 64:ff9b::a00:1): judged as the IPv4 it holds. */
function embeddedV4(ip: string): string | null {
  const dotted = /(?:^::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (dotted?.[1]) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (!hex?.[1] || !hex[2]) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/**
 * A public unicast address: what a client's site lives on. An IPv6 address is first written in its short form (so
 * 0:0:0:0:0:ffff:7f00:1 is seen as ::ffff:7f00:1); the IPv4 inside a mapped or translated address is judged as IPv4.
 * (Node matches an IPv4 address against IPv6 ranges as its mapped form, so ::ffff:0:0/96 is not in the list.)
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return !NOT_PUBLIC.check(ip, 'ipv4')
  if (kind === 6) {
    let short = ip.toLowerCase()
    try {
      short = new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, '')
    } catch {
      return false
    }
    const v4 = embeddedV4(short)
    if (v4) return isPublicAddress(v4)
    return !NOT_PUBLIC.check(short, 'ipv6')
  }
  return false
}

export const PUBLIC_ONLY: FetchPolicy = {
  resolve: (host) => dnsLookup(host, { all: true, verbatim: true }),
  allowAddress: (ip) => isPublicAddress(ip),
  allowPort: (port) => port === 80 || port === 443,
}

const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)\b/i
/** What a document export answers with (a Google Doc as txt, a Sheet as csv). */
const TEXT_TYPE = /^text\/(?:plain|csv)\b/i
const USER_AGENT = 'Mozilla/5.0 (compatible; HanceSiteReader/1.0; +https://hance.pro)'

type Hop =
  | { kind: 'page'; res: IncomingMessage }
  | { kind: 'redirect'; to: string }
  | { kind: 'error'; error: FetchError }

/** The host without the brackets of an IPv6 literal. */
const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '')

/** Whether the URL may be asked at all: its scheme, credentials, port and a literal address. */
function urlProblem(u: URL, policy: FetchPolicy): FetchError | null {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bad_url'
  if (u.username || u.password) return 'bad_url'
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (!policy.allowPort(port)) return 'blocked'
  const host = bare(u.hostname)
  if (isIP(host)) return policy.allowAddress(host, host) ? null : 'blocked'
  // A single label («localhost», «postgres», «core») is a name of the local network, never a site.
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) return 'blocked'
  return null
}

/** One request, no redirect followed: the answer, where it points, or why it failed. */
function hop(
  u: URL,
  policy: FetchPolicy,
  signal: AbortSignal,
  asText: boolean,
  anyType = false,
): Promise<Hop> {
  return new Promise((resolve) => {
    let blocked = false
    let dnsFailed = false
    // Checked when the socket connects, for every address the name gives: no gap for the name to turn local.
    const lookup = (
      hostname: string,
      options: { all?: boolean },
      cb: (
        err: NodeJS.ErrnoException | null,
        address: string | { address: string; family: number }[],
        family?: number,
      ) => void,
    ) => {
      policy.resolve(hostname).then(
        (addrs) => {
          if (addrs.length === 0) {
            dnsFailed = true
            cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '')
            return
          }
          if (addrs.some((a) => !policy.allowAddress(a.address, hostname))) {
            blocked = true
            cb(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }), '')
            return
          }
          if (options.all) cb(null, addrs)
          else cb(null, addrs[0]?.address ?? '', addrs[0]?.family)
        },
        (e: NodeJS.ErrnoException) => {
          dnsFailed = true
          cb(e, '')
        },
      )
    }
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = request(
      u,
      {
        method: 'GET',
        agent: false,
        lookup: lookup as never,
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'ru,en;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          try {
            resolve({ kind: 'redirect', to: new URL(res.headers.location, u).toString() })
          } catch {
            resolve({ kind: 'error', error: 'bad_url' })
          }
          return
        }
        if (status >= 300 || status < 200) {
          res.resume()
          resolve({ kind: 'error', error: `http_${status}` })
          return
        }
        const type = res.headers['content-type']
        if (!anyType && type && !HTML_TYPE.test(type) && !(asText && TEXT_TYPE.test(type))) {
          res.resume()
          resolve({ kind: 'error', error: 'not_html' })
          return
        }
        resolve({ kind: 'page', res })
      },
    )
    req.on('error', () =>
      resolve({
        kind: 'error',
        error: signal.aborted ? 'timeout' : blocked ? 'blocked' : dnsFailed ? 'dns' : 'network',
      }),
    )
    req.end()
  })
}

/** The body, decompressed, up to `maxBytes`: a bigger page is cut, never read to its end. */
function readBody(
  res: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean } | null> {
  return new Promise((resolve) => {
    const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
    const unzip =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : null
    const body: Readable = unzip ? res.pipe(unzip) : res
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (out: { bytes: Buffer; truncated: boolean } | null) => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      res.destroy()
      unzip?.destroy()
      resolve(out)
    }
    const onAbort = () =>
      finish(size > 0 ? { bytes: Buffer.concat(chunks), truncated: true } : null)
    signal.addEventListener('abort', onAbort)
    body.on('data', (chunk: Buffer) => {
      if (done) return
      const room = maxBytes - size
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        size = maxBytes
        finish({ bytes: Buffer.concat(chunks), truncated: true })
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    body.on('end', () => finish({ bytes: Buffer.concat(chunks), truncated: false }))
    // A broken stream keeps what came: a cut page is still worth reading.
    body.on('error', () =>
      finish(size > 0 ? { bytes: Buffer.concat(chunks), truncated: true } : null),
    )
    res.on('error', () =>
      finish(size > 0 ? { bytes: Buffer.concat(chunks), truncated: true } : null),
    )
  })
}

/** The charset of the header, else of a meta tag at the page's start, else UTF-8. */
function decode(bytes: Buffer, contentType: string | undefined): string {
  const head = bytes.subarray(0, 4096).toString('latin1')
  const label =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8'
  try {
    return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/** One page by its address, following at most `maxRedirects` redirects, each checked as the first address was. */
export async function fetchPage(
  url: string,
  o: {
    policy?: FetchPolicy
    limits?: Partial<FetchLimits>
    asText?: boolean
    /** A file, not a page: any content type, the bytes returned as they came (a PDF, a DOCX). */
    raw?: boolean
    /** Only these hosts, the first and every redirect; any other is refused (the files of the order page). */
    hostOk?: (host: string) => boolean
  } = {},
): Promise<Fetched> {
  const policy = o.policy ?? PUBLIC_ONLY
  const limits = { ...PAGE_LIMITS, ...o.limits }
  const signal = AbortSignal.timeout(limits.timeoutMs)
  let current: URL
  try {
    current = new URL(url)
  } catch {
    return { ok: false, error: 'bad_url', url }
  }
  for (let hops = 0; hops <= limits.maxRedirects; hops++) {
    const problem = urlProblem(current, policy)
    if (problem) return { ok: false, error: problem, url: current.toString() }
    if (o.hostOk && !o.hostOk(current.hostname.toLowerCase()))
      return { ok: false, error: 'blocked', url: current.toString() }
    const h = await hop(current, policy, signal, o.asText === true, o.raw === true)
    if (h.kind === 'error') return { ok: false, error: h.error, url: current.toString() }
    if (h.kind === 'redirect') {
      current = new URL(h.to)
      continue
    }
    const body = await readBody(h.res, limits.maxBytes, signal)
    if (!body)
      return { ok: false, error: signal.aborted ? 'timeout' : 'network', url: current.toString() }
    if (o.raw)
      return {
        ok: true,
        url: current.toString(),
        html: '',
        truncated: body.truncated,
        bytes: body.bytes,
      }
    const html = decode(body.bytes, h.res.headers['content-type'])
    // A page without a type is taken only when it looks like HTML.
    if (
      !o.asText &&
      !h.res.headers['content-type'] &&
      !/<(?:!doctype\s+html|html|head|body)\b/i.test(html)
    )
      return { ok: false, error: 'not_html', url: current.toString() }
    return { ok: true, url: current.toString(), html, truncated: body.truncated }
  }
  return { ok: false, error: 'too_many_redirects', url: current.toString() }
}
