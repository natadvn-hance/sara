import type { FastifyInstance, FastifyReply } from 'fastify'
import { hasSession, requireSession } from '../auth/session'
import type { TestLeads } from './testLeads'

/** Without the pult's login the page asks for its password, the same as the pult's. */
const LOGIN = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Тестовые заявки</title>
<body style="font: 16px system-ui; max-width: 420px; margin: 40px auto; padding: 0 16px">
<h1 style="font-size: 20px">🧪 Тестовые заявки</h1>
<p>Пароль тот же, что у пульта.</p>
<form id="f"><input id="p" type="password" autocomplete="current-password" style="font: inherit; padding: 6px; width: 100%">
<button style="font: inherit; margin-top: 8px; padding: 6px 12px">Войти</button></form><p id="e" style="color: #a3471f"></p>
<script>
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault()
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('p').value }) })
  if (r.ok) location.reload(); else document.getElementById('e').textContent = 'Пароль не подошёл'
}
</script>`

const html = (reply: FastifyReply, code: number, page: string) =>
  reply.code(code).type('text/html; charset=utf-8').send(page)

/**
 * The page of test orders and its API under the pult's address and login (docs/ops/test-leads.md): /api/test/ is the
 * page, /api/test/<what> its calls; «wipe» erases every test order.
 */
export function registerTestRoutes(app: FastifyInstance, d: { testLeads: () => TestLeads | null }) {
  app.get('/api/test', (_req, reply) => reply.redirect('/api/test/'))
  app.get('/api/test/', async (req, reply) => {
    if (!hasSession(req)) return html(reply, 401, LOGIN)
    const t = d.testLeads()
    if (!t) return html(reply, 503, 'Тестовые заявки ещё запускаются')
    const a = await t.stand.api('GET', '', '')
    return html(reply, a.status, a.html ?? '')
  })
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)
    const handle = async (
      req: { method: string; params: unknown; body: unknown },
      reply: FastifyReply,
    ) => {
      const t = d.testLeads()
      if (!t) return reply.code(503).send({ error: 'Тестовые заявки ещё запускаются' })
      const path = (req.params as { '*': string })['*'] ?? ''
      if (req.method === 'POST' && path === 'wipe') return { erased: await t.wipe() }
      const a = await t.stand.api(req.method, path, req.body ? JSON.stringify(req.body) : '')
      return reply.code(a.status).send(a.json ?? {})
    }
    scoped.get('/api/test/*', handle)
    scoped.post('/api/test/*', handle)
  })
}
