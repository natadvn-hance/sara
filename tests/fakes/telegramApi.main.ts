// Fake Telegram for Playwright: POST /_control/start {"chatId": 111} simulates /start. The ports come from the e2e
// config (apps/web/e2e/ports.ts), never from a default here: a fixed port is how two runs collided.
import { createServer } from 'node:http'
import { createFakeTelegram } from './telegramApi'

function portFrom(name: string): number {
  const port = Number(process.env[name])
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`${name} не задана: порты фальшивого Telegram даёт конфиг e2e пульта.`)
  return port
}

const port = portFrom('FAKE_TELEGRAM_PORT')
const controlPort = portFrom('FAKE_TELEGRAM_CONTROL_PORT')
const tg = await createFakeTelegram(port)
createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/_control/start') {
      tg.pushStart(Number(JSON.parse(body).chatId))
      return res.writeHead(200).end('ok')
    }
    if (req.url === '/_control/health') return res.writeHead(200).end('ok')
    // The buttons replaced on sent messages (a card decided in the pult), for the pult's browser tests.
    if (req.url === '/_control/markups')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(tg.markups))
    res.writeHead(404).end()
  })
}).listen(controlPort, '127.0.0.1')
console.log(`Фальшивый Telegram: ${tg.apiRoot}, управление на ${controlPort}`)
