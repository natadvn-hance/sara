import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const PASSWORD = 'длинныйпароль1'
const PAGE = '/meetings/availability'

// One sign-in for the file, as in ui-direction.spec.ts: the core allows 5 logins a minute from one address.
const STATE = join(tmpdir(), 'sara-e2e-availability-state.json')
test.use({ storageState: STATE })
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:5174',
    storageState: { cookies: [], origins: [] },
  })
  const first = await api.post('/api/setup/password', { data: { password: PASSWORD } })
  if (first.status() === 409) {
    const login = await api.post('/api/login', { data: { password: PASSWORD } })
    expect(login.ok()).toBe(true)
  }
  await api.storageState({ path: STATE })
  await api.dispose()
})

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('FR-MEET-1: Boris sets Friday 10:00-13:00 and sees the next free times', async ({ page }) => {
  await page.goto(PAGE)
  await expect(page.getByRole('heading', { name: 'Свободное время для созвонов' })).toBeVisible()
  const friday = page.getByRole('group', { name: 'Пятница' })
  await friday.getByLabel('до').fill('13:00')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('status')).toHaveText('Сохранила.')
  await expect(page.getByRole('list', { name: 'Ближайшие свободные' }).getByRole('listitem')).toHaveCount(3)

  await page.reload()
  await expect(page.getByRole('group', { name: 'Пятница' }).getByLabel('до')).toHaveValue('13:00')
})

test('FR-MEET-1: a window that ends before it starts is refused with a plain reason', async ({
  page,
}) => {
  await page.goto(PAGE)
  const monday = page.getByRole('group', { name: 'Понедельник' })
  await monday.getByLabel('с').fill('15:00')
  await monday.getByLabel('до').fill('11:00')
  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Проверь окна: начало раньше конца, окна дня не пересекаются.',
  )
})

for (const scheme of ['light', 'dark'] as const) {
  test(`FR-UI-3: the free time page fits 360 px in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto(PAGE)
    await expect(page.getByRole('heading', { name: 'Свободное время для созвонов' })).toBeVisible()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
  })
}

test('FR-UI-3: the free time page shows a loading and an error state', async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/meetings/availability', async (route) => {
    await held
    await route.fulfill({ status: 500, body: JSON.stringify({ error: 'нет' }) })
  })
  await page.goto(PAGE)
  await expect(page.getByText('Загружаю…')).toBeVisible()
  release()
  await expect(page.getByRole('alert')).toHaveText('Не получилось загрузить. Попробуй ещё раз.')
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible()
})
