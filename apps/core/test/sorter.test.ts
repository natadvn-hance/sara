import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProfiOrder } from '@sara/shared'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createGateway } from '../src/gateway/gateway'
import { sortOrder } from '../src/leads/sorter'
import { createSecretStore } from '../src/secrets/store'
import { openTestDb, resetDb } from './helpers/db'

const ROOT = resolve(import.meta.dirname, '../../..')
const { db, close } = openTestDb()
afterAll(close)
let dir: string
beforeEach(async () => {
  await resetDb(db)
  dir = await mkdtemp(join(tmpdir(), 'sorter-'))
  await cp(join(ROOT, 'roles'), join(dir, 'roles'), { recursive: true })
})

describe('sorter', () => {
  it('FR-LEAD-2: sends order text without client name and parses verdict', async () => {
    const order = ProfiOrder.parse(
      JSON.parse(await readFile(join(ROOT, 'tests/fixtures/orders/90000001.json'), 'utf8')),
    )
    const secrets = createSecretStore(join(dir, 'data'))
    await secrets.set('claude_oauth_token', 'tok')
    const log = join(dir, 'calls.log')
    const gw = createGateway({
      db,
      secrets,
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      rolesDir: join(dir, 'roles'),
      dataDir: join(dir, 'data'),
      extraEnv: {
        FAKE_CLAUDE_ARGS_LOG: log,
        FAKE_CLAUDE_OUTPUT:
          '{"verdict":"fit","reason":"Сайт для клиники","tags":["сайт"],"confidence":0.9}',
      },
    })
    const r = await sortOrder(gw, order)
    expect(r).toMatchObject({ ok: true, output: { verdict: 'fit' } })
    const stdin = JSON.parse((await readFile(log, 'utf8')).trim()).stdin as string
    expect(stdin).toContain(order.title)
    expect(stdin).not.toContain(order.client_name)
  })

  it('NFR-PRIV-2: a name inside the order text never reaches the model, and the call says what was done', async () => {
    const order = ProfiOrder.parse({
      order_id: '90000101',
      title: 'Сайт',
      category: 'Создание сайтов',
      city: 'Краснодар',
      text: 'Меня зовут Ирина, нужен сайт. Ирина Петрова',
      client_name: 'Ирина Петрова',
      budget_text: null,
      bid_price_rub: 210,
      seen_at: '2026-10-22T10:00:00.000Z',
    })
    const secrets = createSecretStore(join(dir, 'data'))
    await secrets.set('claude_oauth_token', 'tok')
    const log = join(dir, 'calls.log')
    const gw = createGateway({
      db,
      secrets,
      claudeBin: join(ROOT, 'tests/fakes/fake-claude.mjs'),
      rolesDir: join(dir, 'roles'),
      dataDir: join(dir, 'data'),
      extraEnv: {
        FAKE_CLAUDE_ARGS_LOG: log,
        FAKE_CLAUDE_OUTPUT: '{"verdict":"fit","reason":"Сайт","tags":[],"confidence":0.9}',
      },
    })
    await sortOrder(gw, order)
    await sortOrder(gw, { ...order, client_name: 'Клиент 7' })
    const [named, unknown] = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).stdin as string)
    expect(named).not.toContain('Ирина')
    expect(named).not.toContain('Петрова')
    expect(named).toContain('[имя 1]')
    // The site gave no name: the text goes as it is, and the record does not claim the names were hidden.
    expect(unknown).toContain('Меня зовут Ирина')
    const rows = await db.execute<{ pseudonymized: boolean }>(
      sql`select pseudonymized from core.model_call order by started_at, id`,
    )
    expect(rows.rows.map((r) => r.pseudonymized)).toEqual([true, false])
  })
})
