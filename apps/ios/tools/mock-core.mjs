// A stand-in for Sara's core on the Mac, for the iOS Simulator: the same addresses and answers as
// apps/core/src/talk/routes.ts, with Milena (macOS `say`) for the voices. Nothing leaves the Mac.
//
//   node apps/ios/tools/mock-core.mjs            # http://localhost:8787, test password «hance-test»
//   MOCK_NO_VOICE=1 node ...                     # /api/talk/speak answers 503: the phone's own voice
//
// The app points at it with the launch argument `-HanceServer http://localhost:8787`.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.PORT ?? 8787)
const PASSWORD = process.env.MOCK_PASSWORD ?? 'hance-test'
const DIR = join(tmpdir(), 'hance-mock-core')
const talks = new Map()
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(8)}s`, ...a)

const GREETING = { lora: 'Борь, я на связи.', sara: 'Да-да, Борь, я тут.' }

const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const body = (req) =>
  new Promise((done) => {
    const chunks = []
    let first = null
    req.on('data', (c) => {
      first ??= Date.now()
      chunks.push(c)
    })
    req.on('end', () => done({ buf: Buffer.concat(chunks), first, last: Date.now() }))
    req.on('error', () => done({ buf: Buffer.concat(chunks), first, last: Date.now(), broken: true }))
  })

const signedIn = (req) => /(?:^|;\s*)sara_session=owner/.test(req.headers.cookie ?? '')

/** «позови Сару», as agents.ts switchTo, in short. */
const callOf = (text, agent) => {
  const m = text.toLowerCase().match(/^(?:позови|дай|переключи на)\s+(сар|лор)\S*\s*(.*)$/u)
  if (!m) return null
  const to = m[1] === 'сар' ? 'sara' : 'lora'
  return to === agent ? null : { agent: to, rest: m[2] ?? '' }
}

async function talk(req, res, url) {
  let agent = url.searchParams.get('agent') === 'sara' ? 'sara' : 'lora'
  const type = String(req.headers['content-type'] ?? '')
  const got = await body(req)
  let text
  if (type.startsWith('audio/')) {
    const seconds = Math.max(0, (got.buf.length - 44) / 32000)
    await mkdir(DIR, { recursive: true })
    const file = join(DIR, `talk-${Date.now()}.wav`)
    await writeFile(file, got.buf)
    log(
      `voice ${agent}: ${got.buf.length} bytes, ${seconds.toFixed(1)} s, body over ${
        got.first ? got.last - got.first : 0
      } ms after the first byte, chunked=${req.headers['transfer-encoding'] === 'chunked'} -> ${file}`,
    )
    if (seconds < 0.3) return json(res, 200, { heard: null, talk: null, reply: { text: 'Не разобрала голосовое.', buttons: false } })
    text = process.env.MOCK_HEARD ?? `проверка связи, ${seconds.toFixed(1).replace('.', ',')} секунды`
  } else {
    try {
      text = JSON.parse(got.buf.toString() || '{}').text?.trim()
    } catch {}
    if (!text) return json(res, 400, { error: 'Не услышала слов. Скажи ещё раз.' })
    log(`text ${agent}: ${text}`)
  }
  const call = callOf(text, agent)
  if (call && !call.rest) {
    return json(res, 200, { heard: text, talk: null, switch: call.agent, reply: { text: GREETING[call.agent], buttons: false } })
  }
  if (call) agent = call.agent
  const id = randomUUID()
  const think = agent === 'lora' ? 1800 : 2600
  const answer = {
    text:
      agent === 'lora'
        ? `Борь, связь есть. Ты сказал: «${text}». Это тестовый сервер на Маке, не настоящая я. Если слышишь меня целиком, значит голос идёт кусками без пауз.`
        : `Да, Борь. Слышу: «${text}». Это проверка приложения на Маке, заявок здесь нет. Настоящие заявки я покажу на сервере.`,
    cards: agent === 'sara' ? 1 : 0,
  }
  talks.set(id, { ready: Date.now() + think, answer, wake: [] })
  setTimeout(() => {
    const t = talks.get(id)
    if (t) for (const w of t.wake.splice(0)) w()
  }, think)
  return json(res, 200, { heard: text, talk: id, ...(call ? { switch: agent } : {}), reply: null })
}

async function answer(res, id) {
  const t = talks.get(id)
  if (!t) return json(res, 404, { state: 'gone', error: 'Ответ потерялся.' })
  if (Date.now() < t.ready) await new Promise((done) => {
    const timer = setTimeout(done, 25_000)
    t.wake.push(() => {
      clearTimeout(timer)
      done()
    })
  })
  if (Date.now() < t.ready) return json(res, 200, { state: 'waiting' })
  log(`answer ${id.slice(0, 8)} given`)
  return json(res, 200, { state: 'done', ...t.answer })
}

async function speak(req, res) {
  const { text = '', agent = 'sara' } = JSON.parse((await body(req)).buf.toString() || '{}')
  if (process.env.MOCK_NO_VOICE === '1' || !text.trim()) return json(res, 503, { error: 'Голос сейчас недоступен, ответ только текстом.' })
  const started = Date.now()
  await mkdir(DIR, { recursive: true })
  const base = join(DIR, `speak-${randomUUID()}`)
  try {
    await run('say', ['-v', 'Milena', '-r', agent === 'lora' ? '185' : '175', '-o', `${base}.aiff`, text])
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.aiff`, '-ac', '1', '-b:a', '64k', `${base}.mp3`])
    const mp3 = await readFile(`${base}.mp3`)
    log(`speak ${agent} ${text.length} chars in ${Date.now() - started} ms`)
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' })
    res.end(mp3)
  } catch (e) {
    log(`speak failed: ${e}`)
    json(res, 503, { error: 'Голос сейчас недоступен, ответ только текстом.' })
  } finally {
    await rm(`${base}.aiff`, { force: true })
    await rm(`${base}.mp3`, { force: true })
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const path = url.pathname
  if (req.method === 'POST' && path === '/api/login') {
    const { password } = JSON.parse((await body(req)).buf.toString() || '{}')
    if (password !== PASSWORD) return json(res, 401, { error: 'Неверный пароль.' })
    log('login ok')
    return json(res, 200, { ok: true }, {
      'set-cookie': `sara_session=owner%3A${Date.now()}.mock; Max-Age=7776000; Path=/; HttpOnly; SameSite=Strict`,
    })
  }
  if (path.startsWith('/api/talk') && !signedIn(req)) return json(res, 401, { error: 'Нужно войти в пульт.' })
  if (req.method === 'POST' && path === '/api/talk') return talk(req, res, url)
  if (req.method === 'POST' && path === '/api/talk/speak') return speak(req, res)
  if (req.method === 'POST' && path === '/api/talk/warm') {
    log('warm')
    res.writeHead(204)
    return res.end()
  }
  if (req.method === 'GET' && path === '/api/talk/history') return json(res, 200, { lines: [] })
  const m = path.match(/^\/api\/talk\/([0-9a-f-]{36})$/)
  if (req.method === 'GET' && m) return answer(res, m[1])
  json(res, 404, { error: 'not found' })
}).listen(PORT, () => log(`mock core on http://localhost:${PORT}, password «${PASSWORD}»`))
