import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../api/deps'
import { requireSession } from '../auth/session'
import { completeStep, postponeStep } from '../setup/progress'
import { type AccountView, syncAccount } from './accounts'

async function refresh(d: AppDeps): Promise<AccountView[]> {
  const views: AccountView[] = []
  for (const a of d.accounts ?? []) {
    const h = await d.profi.sessionHealth(a.id).catch(() => null)
    views.push(await syncAccount(d.db, a, h))
  }
  return views
}

export function registerAccountRoutes(app: FastifyInstance, d: AppDeps): void {
  app.register(async (scoped) => {
    scoped.addHook('preHandler', requireSession)

    scoped.get('/api/accounts', async () => ({ accounts: await refresh(d) }))

    // Wizard step 4: done when the first account's session is alive from its own IP (FR-SET-4).
    scoped.get('/api/setup/profi/status', async () => {
      const [first] = await refresh(d)
      const alive = first?.login_state === 'alive'
      const ipOk = first?.ip_ok ?? false
      if (alive && ipOk) await completeStep(d.db, 'profi')
      return { accountId: first?.id ?? null, alive, ipOk, balance_rub: first?.balance_rub ?? null }
    })

    scoped.post('/api/setup/profi/later', async () => {
      await postponeStep(d.db, 'profi')
      return { ok: true }
    })
  })
}
