import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import pg from 'pg'
import { dbUrl } from './dbUrl'
import { PORTS, URLS } from './ports'

const PASSWORD = 'длинныйпароль1'
const LEAD = '990101'
const CONV = '0b6f6c1e-5a4b-4c1d-9e2f-0a1b2c3d4e5f'
const LEAD_TASK = '1d2c3b4a-0000-4000-8000-000000000101'
const DRAFT_TASK = '1d2c3b4a-0000-4000-8000-000000000102'
const NOTICE = '1d2c3b4a-0000-4000-8000-000000000103'

/**
 * The M7 screens against the real core: made-up rows go straight into the e2e database, the pult reads them through
 * the API, and its buttons reach the same functions as the Telegram buttons (bids and messages stay paused, so a
 * press spends and sends nothing). The rows are removed afterwards, so the other specs see the database as before.
 */
const STATE = join(tmpdir(), `sara-e2e-pult-m7-state-${PORTS.core}.json`)
test.use({ storageState: STATE })

async function sql(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: dbUrl('sara_web') })
  await client.connect()
  try {
    await client.query(text, values)
  } finally {
    await client.end()
  }
}

async function clean() {
  await sql('delete from core.notice where id = $1 or task_id = any($2::uuid[])', [
    NOTICE,
    [LEAD_TASK, DRAFT_TASK],
  ])
  await sql('delete from core.lead_label where lead_id = $1', [LEAD])
  await sql('delete from core.bid_hold where task_id = any($1::uuid[])', [[LEAD_TASK]])
  await sql('delete from core.task where id = any($1::uuid[])', [[LEAD_TASK, DRAFT_TASK]])
  await sql('delete from core.conv_turn where conversation_id = $1', [CONV])
  await sql('delete from core.chat_message where conversation_id = $1', [CONV])
  await sql('delete from core.meeting where conversation_id = $1', [CONV])
  await sql('delete from core.conversation where id = $1', [CONV])
  await sql('delete from core.lead_score where lead_id = $1', [LEAD])
  await sql('delete from core.lead where id = $1', [LEAD])
  await sql(`delete from core.setting where key = 'money.daily_bids'`)
  await sql(`delete from core.setting_history where key = 'money.daily_bids'`)
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({
    baseURL: URLS.web,
    storageState: { cookies: [], origins: [] },
  })
  const first = await api.post('/api/setup/password', { data: { password: PASSWORD } })
  if (first.status() === 409)
    expect((await api.post('/api/login', { data: { password: PASSWORD } })).ok()).toBe(true)
  await api.storageState({ path: STATE })
  await api.dispose()

  await clean()
  await sql(
    `insert into core.lead (id, account_id, title, category, city, text, client_name, budget_text, bid_price_rub,
       seen_at, status, correlation_id, draft_text, draft_price_rub, draft_analysis)
     values ($1, 'hance-marketing', 'Стратегия для студии керамики', 'Маркетинг', 'Краснодар',
       'Нужна стратегия продвижения на полгода.', 'Вероника', 'до 60 000 ₽', 240, now() - interval '20 minutes',
       'queued', gen_random_uuid(), 'Вероника, добрый день! Если я правильно понял, то...', 40000,
       '{"hidden_need":"поток записей, а не документ","risk":"мало денег на каналы","condition":"созвон"}')`,
    [LEAD],
  )
  await sql(
    `insert into core.lead_score (id, lead_id, version, score, decision, stop_factor, red_flags, axes, reason,
       confidence, model, backtest)
     values (gen_random_uuid(), $1, 1, 88, 'show', null, '[]', '[]', 'стратегия для малого бизнеса', 0.9, 'haiku', false)`,
    [LEAD],
  )
  // The card's number in Telegram, so a decision in the pult has a card to mark.
  await sql(
    `insert into core.task (id, kind, entity_kind, entity_id, telegram_message_id) values ($1, 'lead_decision', 'lead', $2, 4242)`,
    [LEAD_TASK, LEAD],
  )
  await sql(
    `insert into core.notice (id, kind, title, body, link, task_id) values ($1, 'lead', 'Заявка: Стратегия для студии керамики', 'Краснодар · отклик 240 ₽', $2, $3)`,
    [NOTICE, `/leads/${LEAD}`, LEAD_TASK],
  )
  await sql(
    `insert into core.conversation (id, account_id, chat_id, order_id, origin) values ($1, 'hance-marketing', 'e2e-chat', $2, 'sara')`,
    [CONV, LEAD],
  )
  await sql(
    `insert into core.chat_message (id, account_id, chat_id, order_id, platform_message_id, side, author, author_basis,
       text, sent_at, source, conversation_id)
     values (gen_random_uuid(), 'hance-marketing', 'e2e-chat', $1, 'e2e-m1', 'client', 'client', 'side',
       'Здравствуйте! Сколько стоит?', now() - interval '5 minutes', 'live', $2)`,
    [LEAD, CONV],
  )
  await sql(
    `insert into core.conv_turn (id, conversation_id, anchor_message_id, state, text, understanding)
     values ('e2e-turn', $1, 'e2e-m1', 'carded', 'Вероника, добрый день! Цена от 40 000 до 60 000 ₽.', '{"why":"клиент спросил цену"}')`,
    [CONV],
  )
  await sql(
    `insert into core.task (id, kind, entity_kind, entity_id) values ($1, 'conv_draft', 'conv_turn', 'e2e-turn')`,
    [DRAFT_TASK],
  )
})

test.afterAll(clean)

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('FR-UI-1: «Сегодня» shows what waits for Boris and leads to the lead and the client', async ({
  page,
}) => {
  await page.goto('/today')
  await expect(page.getByRole('heading', { name: /^Сегодня, / })).toBeVisible()
  await expect(page.getByText('1 заявка ждёт решения')).toBeVisible()
  await expect(page.getByText('Вероника: черновик ждёт «Отправить»')).toBeVisible()
  await page.getByText('1 заявка ждёт решения').click()
  await expect(page).toHaveURL(/\/leads$/)
  await expect(page.getByRole('link', { name: /Стратегия для студии керамики/ })).toBeVisible()
})

test('FR-UI-5, FR-UI-6: a lead shows its score, разбор and price range; «Откликнуться» is the Telegram press', async ({
  page,
}) => {
  await page.goto(`/leads/${LEAD}`)
  await expect(page.getByRole('heading', { name: 'Стратегия для студии керамики' })).toBeVisible()
  await expect(page.getByText('поток записей, а не документ')).toBeVisible()
  await expect(page.getByText(/от 40\s000\s₽ до 60\s000\s₽/)).toBeVisible()
  // Both numbers: the fit is today's score, the chance is still being worked out (Boris, 29.10.2026).
  const why = page.getByRole('region', { name: 'Почему так' })
  await expect(why.getByText('Насколько наше')).toBeVisible()
  await expect(why.getByText('Шанс дойти до денег')).toBeVisible()
  await expect(why.getByText('считается')).toBeVisible()
  // ST-M7-04: the bid waits ten seconds in the core, and «Отменить» stops it.
  await page.getByRole('button', { name: /Откликнуться за 240/ }).click()
  await expect(page.getByText(/Откликаюсь за 240\s₽ через 10 секунд/)).toBeVisible()
  await page.getByRole('button', { name: 'Отменить' }).click()
  await expect(page.getByText('Отменила, отклик не ушёл.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Откликнуться за 240/ })).toBeVisible()
})

test('FR-CONV-11: a draft goes only by «Отправить», the card press; in the shadow it says so', async ({
  page,
}) => {
  await page.goto('/clients')
  await page
    .getByRole('link', { name: /Вероника/ })
    .first()
    .click()
  await expect(
    page.getByRole('region', { name: 'Переписка' }).getByText('Здравствуйте! Сколько стоит?'),
  ).toBeVisible()
  await expect(page.getByText('Вероника, добрый день! Цена от 40 000 до 60 000 ₽.')).toBeVisible()
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('status')).toHaveText(/Режим тени/)
})

test('FR-OPS-1: a limit changes from the settings', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Меньше: Откликов в день' }).click()
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('status')).toHaveText('Сохранила.')
  await expect(page.getByLabel('Откликов в день', { exact: true })).toHaveValue('9')
  await expect(page.getByText('Тратит деньги на отклики')).toBeVisible()
})

test('FR-UI-1: analytics, the mind and the health open from the menu', async ({ page }) => {
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Итоги', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Сводка по месяцам' })).toBeVisible()
  await page.goto('/mind')
  await expect(page.getByRole('heading', { name: 'Разум', exact: true })).toBeVisible()
  await page.goto('/health')
  await expect(page.getByRole('heading', { name: 'Состояние', exact: true })).toBeVisible()
  await expect(page.getByText('Узел Профи.ру')).toBeVisible()
})

test('FR-UI-3: the pult fits a 360 px phone without horizontal scroll and has the tabs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 })
  for (const path of [
    '/inbox',
    '/today',
    `/leads/${LEAD}`,
    `/clients/${CONV}`,
    '/notices',
    '/journal',
    '/search?q=керамик',
    '/analytics',
    '/settings',
    '/health',
  ]) {
    await page.goto(path)
    await expect(page.getByRole('navigation', { name: 'Разделы' }).last()).toBeVisible()
    await page.waitForTimeout(300)
    expect(await overflowOf(page), path).toBeLessThanOrEqual(0)
  }
})

test('FR-NOTIF-1: the bell counts the new notices and opening them marks them seen', async ({
  page,
}) => {
  await page.goto('/today')
  // On a computer the bell is the menu's «Уведомления» with the count of the new ones.
  await expect(
    page.getByRole('navigation', { name: 'Сара' }).getByRole('link', { name: /^Уведомления \d+$/ }),
  ).toBeVisible()
  await page.goto('/notices')
  await expect(page.getByText('Заявка: Стратегия для студии керамики')).toBeVisible()
  await expect
    .poll(async () => {
      const client = new pg.Client({ connectionString: dbUrl('sara_web') })
      await client.connect()
      try {
        const r = await client.query('select seen_at from core.notice where id = $1', [NOTICE])
        return r.rows[0]?.seen_at ?? null
      } finally {
        await client.end()
      }
    })
    .not.toBeNull()
})

test('FR-UI-2: the search finds the order by its number and the section by its name', async ({
  page,
}) => {
  await page.goto(`/search?q=${LEAD}`)
  await expect(page.getByRole('link', { name: /Стратегия для студии керамики/ })).toBeVisible()
  await page.goto('/search?q=настройки')
  await expect(page.getByRole('link', { name: /Настройки/ }).first()).toBeVisible()
})

test('FR-UI-6, ST-M7-03: a lead is skipped from the Inbox in two presses with a reason; the Telegram card says «Решено в приложении»', async ({
  page,
  request,
}) => {
  await page.goto('/inbox')
  await expect(page.getByRole('heading', { name: /Входящие/ })).toBeVisible()
  const row = page.locator('.task', { hasText: 'Заявка ждёт решения' })
  await expect(row.getByRole('link', { name: /Стратегия для студии керамики/ })).toBeVisible()
  await expect(page.locator('.task', { hasText: 'Черновик ответа клиенту' })).toBeVisible()
  await row.getByRole('button', { name: 'Закрыть заявку' }).click()
  await row.getByRole('button', { name: 'не наш профиль' }).click()
  await expect(page.getByRole('status')).toHaveText('Заявка закрыта')
  await expect(row).toHaveCount(0)
  // The bell's notice of this lead is done now, from the task's state.
  await page.goto('/notices')
  await expect(page.getByText('Заявка: Стратегия для студии керамики')).toHaveCount(0)
})

test('FR-ANL-5, FR-MEET-4: a contract with its sum is written on the client and a call is added', async ({
  page,
}) => {
  await page.goto(`/clients/${CONV}`)
  await expect(page.getByRole('heading', { name: 'Вероника' })).toBeVisible()
  await page.getByRole('button', { name: 'Договор' }).click()
  await page.getByLabel('Сумма договора, ₽').fill('60000')
  await page.getByRole('button', { name: 'Записать договор' }).click()
  await expect(page.getByRole('status')).toHaveText('Записала договор.')
  await expect(page.getByText(/договор · 60\s000\s₽/)).toBeVisible()
  await page.goto('/meetings')
  await expect(page.getByRole('heading', { name: 'Встречи', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Добавить встречу' }).first().click()
  await page.getByLabel('С кем и о чём').fill('Созвон с Вероникой')
  await page.getByLabel('Когда').fill('2030-01-15T15:00')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('status')).toHaveText('Встречу записала.')
  await expect(page.getByText('Созвон с Вероникой')).toBeVisible()
  await sql(`delete from core.meeting where title = 'Созвон с Вероникой'`)
})

test('FR-OPS-1: «Тратит деньги» turns on only with the second press and off the same way', async ({
  page,
}) => {
  await page.goto('/settings')
  const sw = page.getByRole('button', { name: 'Тратит деньги на отклики: выключено' })
  await sw.click()
  await page.getByRole('button', { name: 'Нет' }).click()
  await expect(sw).toBeVisible()
  await sw.click()
  await page.getByRole('button', { name: 'Да, включить' }).click()
  await expect(page.getByRole('status')).toHaveText('Сохранила.')
  // Back to the pause the other specs expect.
  await page.getByRole('button', { name: 'Тратит деньги на отклики: включено' }).click()
  await page.getByRole('button', { name: 'Да, выключить' }).click()
  await expect(
    page.getByRole('button', { name: 'Тратит деньги на отклики: выключено' }),
  ).toBeVisible()
})

/** initData as Telegram signs it for the bot setup.spec bound (the fake's token, Boris is chat 111). */
function initDataFor(userId: number): string {
  const token = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'
  const fields: [string, string][] = [
    ['auth_date', String(Math.floor(Date.now() / 1000))],
    ['query_id', 'AAH-e2e'],
    ['user', JSON.stringify({ id: userId, first_name: 'Борис' })],
  ]
  const check = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const p = new URLSearchParams(fields)
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return p.toString()
}

test('FR-UI-4, ST-M7-02: the Mini App opens the pult without a password by Telegram\u2019s signature; a stranger does not', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await ctx.newPage()
  // Telegram's own script is not needed here: the pult signs in by the address alone.
  await page.route('https://telegram.org/**', (r) => r.abort())
  await page.goto(`/inbox#tgWebAppData=${encodeURIComponent(initDataFor(111))}&tgWebAppVersion=7.0`)
  await expect(page.getByRole('heading', { name: 'Входящие', exact: true })).toBeVisible()
  // Within the tab the signature is kept: the next page needs no address from Telegram.
  await page.goto('/leads')
  await expect(page.getByRole('heading', { name: 'Заявки', exact: true })).toBeVisible()
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const p2 = await other.newPage()
  await p2.route('https://telegram.org/**', (r) => r.abort())
  await p2.goto(`/inbox#tgWebAppData=${encodeURIComponent(initDataFor(999))}&tgWebAppVersion=7.0`)
  await expect(p2).toHaveURL(/\/login/)
  await other.close()
  await ctx.close()
})
