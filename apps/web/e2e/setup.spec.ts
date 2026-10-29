import { expect, test } from '@playwright/test'

const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'

async function controlStart(chatId: number) {
  await fetch('http://127.0.0.1:18082/_control/start', {
    method: 'POST',
    body: JSON.stringify({ chatId }),
  })
}

test('FR-SET-1: wizard goes through password, telegram and claude and resumes after reload', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByLabel('Пароль').fill('длинныйпароль1')
  await page.getByRole('button', { name: 'Сохранить пароль' }).click()
  await expect(page.getByText('Скопируй токен из ответа')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Скопируй токен из ответа')).toBeVisible()

  await page.getByLabel('Токен бота').fill('abc')
  await page.getByRole('button', { name: 'Проверить токен' }).click()
  await expect(page.getByText(/@BotFather целиком/)).toBeVisible()

  await page.getByLabel('Токен бота').fill(FAKE_TOKEN)
  await page.getByRole('button', { name: 'Проверить токен' }).click()
  await expect(page.getByText('Бот @sara_dev_bot найден. Напиши ему /start.')).toBeVisible()
  await controlStart(111)
  await expect(page.getByText('claude setup-token')).toBeVisible({ timeout: 10_000 })

  await page.getByLabel('Токен Claude').fill('t')
  await page.getByRole('button', { name: 'Проверить Claude' }).click()
  await expect(page.getByText('Шаг 4. Профи.ру')).toBeVisible()
  await page.getByRole('button', { name: 'Сделать позже' }).click()
  await expect(page.getByText('Готово. Сара на связи.')).toBeVisible()

  await page.getByRole('link', { name: 'Состояние системы' }).click()
  await expect(page.getByRole('heading', { name: 'Состояние', exact: true })).toBeVisible()
  await expect(page.getByText('База данных')).toBeVisible()
})

test('FR-UI-3: wizard fits a 360 px screen without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/setup')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

const CONTROL = 'http://127.0.0.1:18083/_control'

async function tapOn(page: import('@playwright/test').Page, selector: string) {
  const box = (await (
    await fetch(`${CONTROL}/box?sel=${encodeURIComponent(selector)}`)
  ).json()) as {
    x: number
    y: number
  }
  const frame = page.getByRole('img', { name: 'Экран вкладки Профи.ру' })
  const b = await frame.boundingBox()
  if (!b) throw new Error('no frame')
  await page.mouse.click(b.x + box.x * b.width, b.y + box.y * b.height)
}

async function typeOnScreen(page: import('@playwright/test').Page, text: string) {
  await page.getByLabel('Набрать текст').fill(text)
  await page.getByRole('button', { name: 'Набрать' }).click()
}

test('FR-ACC-6: login on a 360 px phone screen by tapping and typing', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/login')
  await page.getByLabel('Пароль').fill('длинныйпароль1')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page).not.toHaveURL(/\/login/)
  await page.goto('/accounts')
  await page.getByRole('link', { name: 'Войти в Профи.ру' }).click()
  await expect(page.getByRole('img', { name: 'Экран вкладки Профи.ру' })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('Пароль и код из СМС никуда не сохраняются')).toBeVisible()
  await page.getByLabel('Скрывать набираемое').check()
  await expect(page.getByLabel('Набрать текст')).toHaveAttribute('type', 'password')
  await page.getByLabel('Скрывать набираемое').uncheck()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  const tab = async () =>
    (await (await fetch(`${CONTROL}/state`)).json()) as {
      url: string
      phone: string | null
      code: string | null
    }
  await tapOn(page, '#phone')
  await typeOnScreen(page, '+79000000001')
  await expect.poll(async () => (await tab()).phone).toBe('+79000000001')
  await tapOn(page, '#send-phone')
  const { code } = (await (await fetch(`${CONTROL}/code`)).json()) as { code: string }
  await tapOn(page, '#code')
  await typeOnScreen(page, code)
  await expect.poll(async () => (await tab()).code).toBe(code)
  await tapOn(page, '#send-code')
  await expect.poll(async () => (await tab()).url).toContain('/backoffice/a.php')
  await expect(page.getByText('Аккаунт активен')).toBeVisible({ timeout: 20_000 })
})
