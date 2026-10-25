import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'
import { prepareTestDatabase } from '../../core/test/globalSetup'
import { dbUrl } from './dbUrl'

/** Fresh database and data folder, so the wizard always starts from step 1. Runs before the core starts. */
export async function prepareDb() {
  await rm(resolve(import.meta.dirname, '../../../.sara/web-e2e'), { recursive: true, force: true })
  await prepareTestDatabase('sara_web')
  const client = new pg.Client({ connectionString: dbUrl('sara_web') })
  await client.connect()
  const t = await client.query("select tablename from pg_tables where schemaname = 'core'")
  if (t.rows.length)
    await client.query(`truncate ${t.rows.map((r) => `core."${r.tablename}"`).join(', ')} cascade`)
  await seedLeads(client)
  await client.end()
}

/** Scored leads for the pages that try rules on real orders (recompute, calibration), newest first. */
export const SEEDED_LEADS = 22

async function seedLeads(client: pg.Client) {
  for (let i = 1; i <= SEEDED_LEADS; i++) {
    const id = String(980000 + i)
    // Scores spread around the threshold of 56, so a sample of them has some near it and some far from it.
    const score = 30 + ((i * 7) % 60)
    await client.query(
      `insert into core.lead (id, account_id, title, category, city, text, client_name, budget_text,
         bid_price_rub, seen_at, status, correlation_id)
       values ($1, 'hance-marketing', $2, 'Маркетинг', 'Москва', $3, 'Ирина', $4, 120,
         now() - ($5 * interval '1 minute'), 'scored_out', gen_random_uuid())`,
      [
        id,
        `Заявка ${i}`,
        `Описание заявки ${i}: нужен маркетинг для небольшого бизнеса`,
        i % 3 === 0 ? 'до 50 000 ₽' : null,
        i,
      ],
    )
    await client.query(
      `insert into core.lead_score (id, lead_id, version, score, decision, stop_factor, red_flags, axes,
         reason, confidence, model, backtest)
       values (gen_random_uuid(), $1, 1, $2, $3, null, '[]', '[]', $4, 0.9, 'haiku', false)`,
      [id, score, score >= 56 ? 'show' : 'drop', `Причина оценки ${i}`],
    )
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await prepareDb()
