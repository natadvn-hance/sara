import { expect, type Page, test } from '@playwright/test'
import { SESSION_STATE, signIn } from './session'

test.use({ storageState: SESSION_STATE })
test.beforeAll(async ({ playwright }) => signIn(playwright))

const SECTIONS: [string, RegExp][] = [
  ['Сегодня', /^Сегодня$/],
  ['Входящие', /^Входящие$/],
  ['Заявки', /^Заявки$/],
  ['Клиенты', /^Клиенты$/],
  ['Встречи', /^Встречи$/],
  ['Разум', /^Разум$/],
  ['Тренажёр', /^Тренажёр$/],
  ['Экзамены', /^Экзамены$/],
  ['Аналитика', /^Аналитика$/],
  ['Аккаунты', /^Аккаунты$/],
  ['Настройки', /^Настройки$/],
  ['Состояние', /^Состояние системы$/],
  ['Журнал', /^Журнал$/],
  ['Справка', /^Справка$/],
]

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/** The Mini App as Telegram opens it: launch data in the hash, Telegram's object, its script answered empty. */
async function asMiniApp(page: Page) {
  await page.route('https://telegram.org/**', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: '' }),
  )
  await page.addInitScript(() => {
    const calls: string[] = []
    ;(window as unknown as { tgCalls: string[] }).tgCalls = calls
    ;(window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        ready: () => calls.push('ready'),
        expand: () => calls.push('expand'),
        close: () => calls.push('close'),
        openLink: (u: string) => calls.push(`open:${u}`),
        BackButton: {
          show: () => calls.push('back:show'),
          hide: () => calls.push('back:hide'),
          onClick: () => calls.push('back:on'),
          offClick: () => calls.push('back:off'),
        },
      },
    }
  })
}
const LAUNCH = `#tgWebAppData=${encodeURIComponent('query_id=AA&user=%7B%22id%22%3A1%7D&auth_date=1&hash=ab')}`
const tgCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { tgCalls: string[] }).tgCalls)

test('FR-UI-1: every section opens from the menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const menu = page.getByRole('navigation', { name: 'Разделы' })
  for (const [title, heading] of SECTIONS) {
    await menu.getByRole('link', { name: title, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(menu.getByRole('link', { name: title, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
  }
})

test('FR-UI-3: the shell fits 360 px in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    for (const path of ['/', '/leads', '/clients', '/settings', '/accounts', '/health', '/journal']) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await overflowOf(page), `${colorScheme} ${path}`).toBeLessThanOrEqual(0)
    }
  }
})

test('FR-UI-1: settings list the other sections on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/settings')
  await expect(page.getByRole('navigation', { name: 'Разделы' })).toBeHidden()
  await page.getByRole('link', { name: 'Журнал' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Журнал' })).toBeVisible()
})

test('FR-UI-4: inside Telegram the shell shows four tabs and the back button', async ({ page }) => {
  await asMiniApp(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/leads/12${LAUNCH}`)
  const tabs = page.getByRole('navigation', { name: 'Вкладки' })
  await expect(tabs.getByRole('link')).toHaveText(['Сегодня', 'Заявки', 'Клиенты', 'Настройки'])
  // No side menu inside Telegram, even on a wide window (Telegram Desktop).
  await expect(page.getByRole('navigation', { name: 'Разделы' })).toBeHidden()
  await expect.poll(() => tgCalls(page)).toContain('back:show')
  await tabs.getByRole('link', { name: 'Сегодня' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Сегодня' })).toBeVisible()
  await expect.poll(() => tgCalls(page)).toContain('back:hide')
  expect(await tgCalls(page)).toContain('ready')
})

test.describe('without a session', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('FR-UI-4: T11 a 401 in the Mini App stops polling and asks to reopen', async ({ page }) => {
    await asMiniApp(page)
    await page.clock.install()
    let asked = 0
    page.on('request', (r) => {
      if (r.url().includes('/api/accounts')) asked++
    })
    await page.goto(`/accounts${LAUNCH}`)
    await expect(page.getByRole('heading', { name: 'Открой приложение заново' })).toBeVisible()
    await page.clock.fastForward(60_000)
    expect(asked).toBe(1)
    await page.getByRole('button', { name: 'Закрыть' }).click()
    await expect.poll(() => tgCalls(page)).toContain('close')
  })
})
