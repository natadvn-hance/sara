import { expect, type Page, test } from '@playwright/test'

const PASSWORD = 'длинныйпароль1'
const ACCOUNT = 'hance-marketing'
const DIRECTION = `/accounts/${ACCOUNT}/direction`

/** The first test to run sets the password, a later one signs in with it (the specs share one database). */
async function signIn(page: Page) {
  const first = await page.request.post('/api/setup/password', { data: { password: PASSWORD } })
  if (first.status() === 409) {
    const login = await page.request.post('/api/login', { data: { password: PASSWORD } })
    expect(login.ok()).toBe(true)
  }
}

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('FR-ACC-2: the direction page shows the rules, the versions and rolls back', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/accounts')
  await page.getByRole('link', { name: 'Направление' }).click()
  await expect(page).toHaveURL(new RegExp(`${DIRECTION}$`))
  await expect(page.getByRole('heading', { name: 'Hance маркетинг' })).toBeVisible()

  const heading = page.getByRole('heading', { name: /^Правила v\d+$/ })
  await expect(heading).toBeVisible()
  const now = Number(/v(\d+)/.exec((await heading.textContent()) ?? '')?.[1])
  await expect(page.getByText('Порог: 56')).toBeVisible()
  await expect(page.getByText('Качество клиента')).toBeVisible()
  await expect(page.getByText('вес 30')).toBeVisible()
  await page.getByText(/^Стоп-факторы \(\d+\)$/).click()
  await expect(page.getByText('Настройка или ведение Яндекс.Директа')).toBeVisible()

  // v1 is in the list of versions, the active one has no rollback button.
  const list = page.getByRole('list', { name: 'Версии правил' })
  await expect(list.getByRole('listitem').filter({ hasText: `v${now}` })).toContainText('действует')
  await expect(
    list
      .getByRole('listitem')
      .filter({ hasText: `v${now}` })
      .getByRole('button'),
  ).toHaveCount(0)

  const v1 = list.getByRole('listitem').filter({ hasText: /^v1\b/ })
  await v1.getByRole('button', { name: 'Вернуть эту версию' }).click()
  await expect(page.getByText('Вернуть v1? Старые версии останутся.')).toBeVisible()
  await page.getByRole('button', { name: 'Отмена' }).click()
  await expect(page.getByRole('heading', { name: `Правила v${now}` })).toBeVisible()

  await v1.getByRole('button', { name: 'Вернуть эту версию' }).click()
  await page.getByRole('button', { name: 'Да, вернуть' }).click()
  await expect(page.getByRole('heading', { name: `Правила v${now + 1}` })).toBeVisible()
  await expect(list.getByRole('listitem').filter({ hasText: `v${now + 1}` })).toContainText(
    'откат к v1',
  )
  // History stays: the old versions are still listed.
  await expect(list.getByRole('listitem')).toHaveCount(now + 1)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`FR-UI-3: the direction page fits 360 px in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 360, height: 740 })
    await signIn(page)
    await page.goto(DIRECTION)
    await expect(page.getByRole('heading', { name: /^Правила v\d+$/ })).toBeVisible()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe(scheme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(250, 249, 247)')
  })
}

test('FR-UI-3: the direction page shows a loading state and an error with a retry', async ({
  page,
}) => {
  await signIn(page)
  let fail = true
  await page.route(`**/api/directions/${ACCOUNT}`, async (route) => {
    if (!fail) return route.continue()
    await new Promise((r) => setTimeout(r, 300))
    await route.fulfill({ status: 500, json: { error: 'x' } })
  })
  await page.goto(DIRECTION)
  await expect(page.getByText('Загружаю…')).toBeVisible()
  await expect(page.getByText('Не получилось загрузить. Попробуй ещё раз.')).toBeVisible()
  fail = false
  await page.getByRole('button', { name: 'Повторить' }).click()
  await expect(page.getByRole('heading', { name: /^Правила v\d+$/ })).toBeVisible()
})

test('FR-UI-3: an unknown account has an empty state, not a blank page', async ({ page }) => {
  await signIn(page)
  await page.goto('/accounts/nobody/direction')
  await expect(page.getByText('Такого аккаунта нет.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'К аккаунтам' })).toBeVisible()
})
