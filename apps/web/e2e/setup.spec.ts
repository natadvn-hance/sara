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
  await expect(page.getByText('Готово. Сара на связи.')).toBeVisible()

  await page.getByRole('link', { name: 'Состояние системы' }).click()
  await expect(page.getByRole('heading', { name: 'Состояние системы' })).toBeVisible()
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
