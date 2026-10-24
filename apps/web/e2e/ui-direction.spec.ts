import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const PASSWORD = 'длинныйпароль1'
const ACCOUNT = 'hance-marketing'
const DIRECTION = `/accounts/${ACCOUNT}/direction`

/**
 * One sign-in for the whole file, kept as a storage state: the core allows 5 logins a minute from one address,
 * and the pages are all behind the session. The first spec to run sets the password (the specs share a database).
 */
const STATE = join(tmpdir(), 'sara-e2e-pult-state.json')
test.use({ storageState: STATE })
test.beforeAll(async ({ playwright }) => {
  // An empty state of its own: the file `test.use` names does not exist before this hook has made it.
  const api = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:5174',
    storageState: { cookies: [], origins: [] },
  })
  const first = await api.post('/api/setup/password', { data: { password: PASSWORD } })
  if (first.status() === 409) {
    const login = await api.post('/api/login', { data: { password: PASSWORD } })
    expect(login.ok()).toBe(true)
  }
  // Claude answers through the fake CLI, but the gateway wants a token on file (the wizard's step 3 saves one).
  await api.post('/api/setup/claude', { data: { token: 't' } })
  await api.storageState({ path: STATE })
  await api.dispose()
})

const overflowOf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test('FR-ACC-2: the direction page shows the rules, the versions and rolls back', async ({
  page,
}) => {
  await page.goto('/accounts')
  await page.getByRole('link', { name: 'Направление' }).click()
  await expect(page).toHaveURL(new RegExp(`${DIRECTION}$`))
  await expect(page.getByRole('heading', { name: 'Hance маркетинг' })).toBeVisible()

  const heading = page.getByRole('heading', { name: /^Правила v\d+$/ })
  await expect(heading).toBeVisible()
  const now = Number(/v(\d+)/.exec((await heading.textContent()) ?? '')?.[1])
  // v1 is the old version to go back to; the app's own amendment makes the active one at least v2.
  expect(now).toBeGreaterThan(1)
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
  await expect(page.getByText(`Теперь действуют правила v${now + 1}`)).toBeVisible()
  // The rules themselves are v1's again, not only the number.
  await expect(page.getByText('Порог: 56')).toBeVisible()
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
  await page.goto('/accounts/nobody/direction')
  await expect(page.getByText('Такого аккаунта нет.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'К аккаунтам' })).toBeVisible()
})

const ONBOARDING = `${DIRECTION}/onboarding`
const resetOnboarding = (page: Page) =>
  page.request.post(`/api/directions/${ACCOUNT}/onboarding/cancel`)
const UNDERSTOOD = 'Вы делаете маркетинг для малого бизнеса: стратегия, сайты, воронки.'

/** Opens the wizard in edit mode and says step 1; stops where Claude's reading is shown. */
async function sayStepOne(page: Page, words = 'Мы делаем маркетинг для малого бизнеса') {
  await resetOnboarding(page)
  await page.goto(DIRECTION)
  await page.getByRole('link', { name: 'Изменить с Claude' }).click()
  await expect(page).toHaveURL(new RegExp(`${ONBOARDING}$`))
  await page.getByRole('button', { name: 'Править текущее направление' }).click()
  await expect(page.getByRole('heading', { name: 'Шаг 1. Чем занимаемся' })).toBeVisible()
  await page.getByLabel('Расскажи своими словами').fill(words)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByText('Я поняла так:')).toBeVisible()
}

test('FR-ACC-3: Boris says step 1, sees "Я поняла так" and presses "Да, правильно"', async ({
  page,
}) => {
  await sayStepOne(page)
  await expect(page.getByText('Шаг 1 из 8')).toBeVisible()
  await expect(page.getByText(UNDERSTOOD)).toBeVisible()
  await expect(page.getByText('Правильно понимаю?')).toBeVisible()
  await page.getByRole('button', { name: 'Да, правильно' }).click()
  await expect(page.getByRole('heading', { name: 'Шаг 2. Чего не берём' })).toBeVisible()
  await expect(page.getByText('Шаг 2 из 8')).toBeVisible()
})

test('FR-ACC-3: "Нет, поправить" asks what is wrong and shows the new understanding', async ({
  page,
}) => {
  await sayStepOne(page)
  await page.getByRole('button', { name: 'Нет, поправить' }).click()
  await page.getByLabel('Что не так?').fill('Не малого, а среднего бизнеса')
  await page.getByRole('button', { name: 'Переделать' }).click()
  await expect(page.getByText('Прошлые попытки (1)')).toBeVisible()
  await expect(page.getByText('Правильно понимаю?')).toBeVisible()
})

test('FR-ACC-3: reload returns to the same step with the saved text', async ({ page }) => {
  await sayStepOne(page, 'Текст, который не должен пропасть')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Шаг 1. Чем занимаемся' })).toBeVisible()
  await expect(page.getByLabel('Расскажи своими словами')).toHaveValue(
    'Текст, который не должен пропасть',
  )
  await expect(page.getByText(UNDERSTOOD)).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`FR-UI-3: the wizard fits 360 px in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 360, height: 740 })
    await resetOnboarding(page)
    await page.goto(ONBOARDING)
    await expect(page.getByRole('button', { name: 'Править текущее направление' })).toBeVisible()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Править текущее направление' }).click()
    await page.getByLabel('Расскажи своими словами').fill('Длинный текст '.repeat(40))
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.getByText('Я поняла так:')).toBeVisible()
    await page.getByText('Как это запишется').click()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe(scheme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(250, 249, 247)')
  })
}

test('FR-UI-3: a failed model call shows the reason and keeps the text in the field', async ({
  page,
}) => {
  await resetOnboarding(page)
  await page.route('**/onboarding/steps/1', (route) =>
    route.fulfill({
      status: 502,
      json: { error: 'Claude не ответил. Попробуй ещё раз.', reason: 'no_answer' },
    }),
  )
  await page.goto(ONBOARDING)
  await page.getByRole('button', { name: 'Править текущее направление' }).click()
  await page.getByLabel('Расскажи своими словами').fill('Мои слова')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('alert')).toHaveText('Claude не ответил. Попробуй ещё раз.')
  await expect(page.getByLabel('Расскажи своими словами')).toHaveValue('Мои слова')
})

test('FR-UI-3: a draft that does not read shows a message and can be cancelled', async ({
  page,
}) => {
  await page.route(`**/api/directions/${ACCOUNT}/onboarding`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            onboarding: {
              mode: 'edit',
              basedOn: 1,
              step: 1,
              steps: {},
              rules: null,
              changes: [],
              changed: false,
              broken: true,
            },
          },
        })
      : route.continue(),
  )
  await page.goto(ONBOARDING)
  await expect(page.getByRole('alert')).toContainText('Черновик не читается')
  await expect(page.getByRole('button', { name: 'Отменить настройку' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Отправить' })).toHaveCount(0)
})

const RECOMPUTE = `${DIRECTION}/recompute`
const RUN_ID = '11111111-1111-4111-8111-111111111111'
const RUNS = `**/api/directions/${ACCOUNT}/runs`
const AXES = [
  { id: 'client', score: 30, why: 'Мелкий клиент' },
  { id: 'system', score: 50, why: 'Задача не про систему' },
]
/** A finished run as the API tells it, with one lead the new rules would stop showing. */
const doneRun = {
  id: RUN_ID,
  kind: 'recompute',
  state: 'done',
  total: 2,
  done: 2,
  skipped: 0,
  stop_reason: null,
  result: {
    checked: 2,
    skipped: 0,
    changed: 1,
    toDrop: 1,
    toShow: 0,
    withBoris: 2,
    agreementBefore: 0.5,
    agreementAfter: 1,
    items: [
      {
        leadId: '1',
        title: 'Заявка про сайт',
        city: 'Москва',
        before: { score: 70, decision: 'show' },
        after: {
          score: 40,
          decision: 'drop',
          reason: 'Копеечный бюджет без признаков зрелости',
          stopFactor: null,
          redFlags: [],
          axes: AXES,
        },
        boris: 'no',
      },
    ],
  },
}
/** Stubs the run API: starting gives RUN_ID, reading gives `run`. */
async function stubRuns(page: Page, run: object) {
  await page.route(RUNS, (route) => route.fulfill({ status: 202, json: { id: RUN_ID } }))
  await page.route(`${RUNS}/${RUN_ID}`, (route) => route.fulfill({ json: run }))
}

test('FR-ACC-5: Boris starts a recompute, sees the progress and then the result', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto(RECOMPUTE)
  await page
    .getByLabel('Какие правила попробовать')
    .selectOption({ label: 'v1, правила старой Сары' })
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByText('Решения не изменились ни у одной заявки.')).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByText('Проверено заявок: 22')).toBeVisible()
})

test('FR-ACC-5: the progress shows "28 из 50" and the result lists the changed leads with "Почему так"', async ({
  page,
}) => {
  await page.route(RUNS, (route) => route.fulfill({ status: 202, json: { id: RUN_ID } }))
  let calls = 0
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({
      json:
        calls++ === 0
          ? { ...doneRun, state: 'running', total: 50, done: 28, result: null }
          : doneRun,
    }),
  )
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByRole('progressbar')).toBeVisible()
  await expect(page.getByText('28 из 50')).toBeVisible()
  await expect(page.getByText('Изменилось решение у 1 заявки из 2')).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByText('Заявка про сайт')).toBeVisible()
  await expect(page.getByText('было 70, показать')).toBeVisible()
  await expect(page.getByText('стало 40, отсеять')).toBeVisible()
  await expect(page.getByText('ты: не взял бы')).toBeVisible()
  await expect(page.getByText('Совпадение с твоими решениями: было 50%, стало 100%')).toBeVisible()
  await page.getByText('Почему так').click()
  await expect(page.getByText('Копеечный бюджет без признаков зрелости')).toBeVisible()
  await expect(page.getByText('Мелкий клиент')).toBeVisible()
})

test('FR-ACC-5: the Claude limit shows "Подожди, лимит Claude" and no endless spinner', async ({
  page,
}) => {
  await stubRuns(page, {
    ...doneRun,
    state: 'stopped',
    done: 1,
    stop_reason: 'limit',
    result: null,
  })
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByText('Подожди, лимит Claude кончился. Попробуй позже.')).toBeVisible()
  await expect(page.getByRole('progressbar')).toHaveCount(0)
})

test('FR-UI-3: the recompute screen says so when there are no leads or another check is running', async ({
  page,
}) => {
  await page.route(RUNS, (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'Заявок для проверки пока нет. Нужно, чтобы разбор заявок был включён.' },
    }),
  )
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByRole('alert')).toContainText('Заявок для проверки пока нет')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`FR-UI-3: the recompute result fits 360 px in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 360, height: 740 })
    await stubRuns(page, doneRun)
    await page.goto(RECOMPUTE)
    await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
    await expect(page.getByText('Заявка про сайт')).toBeVisible()
    await page.getByText('Почему так').click()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe(scheme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(250, 249, 247)')
  })
}

// Last: it changes the active rules, and the first test of this file looks at their threshold.
test('FR-ACC-3: three confirmed steps are saved as new rules, without calibration only with a reason', async ({
  page,
}) => {
  await sayStepOne(page)
  await page.getByRole('button', { name: 'Да, правильно' }).click()
  await expect(page.getByRole('heading', { name: 'Шаг 2. Чего не берём' })).toBeVisible()
  await page.getByLabel('Расскажи своими словами').fill('Не берём только Директ')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await page.getByRole('button', { name: 'Да, правильно' }).click()
  await expect(page.getByRole('heading', { name: 'Шаг 3. Идеальная заявка' })).toBeVisible()
  await page.getByLabel('Расскажи своими словами').fill('Лучшие заказы: понятная задача')
  await page.getByRole('button', { name: 'Отправить' }).click()
  await page.getByRole('button', { name: 'Да, правильно' }).click()
  await expect(page.getByText('Черновик правил готов')).toBeVisible()
  await expect(page.getByText('Порог: 56 → 55')).toBeVisible()
  const save = page.getByRole('button', { name: 'Сохранить без калибровки' })
  await expect(save).toBeDisabled()
  await page.getByLabel('Зачем сохраняешь без проверки?').fill('Проверю позже на заявках')
  await save.click()
  await expect(page.getByText(/^Правила сохранены: v\d+$/)).toBeVisible()
  await page.getByRole('link', { name: 'К направлению' }).click()
  await expect(page.getByText('Порог: 55')).toBeVisible()
})
