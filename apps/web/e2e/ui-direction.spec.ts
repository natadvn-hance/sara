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

test('FR-ACC-5: a run that could not score anything is not shown as "nothing changed"', async ({
  page,
}) => {
  await stubRuns(page, {
    ...doneRun,
    state: 'failed',
    done: 2,
    stop_reason: 'nothing_scored',
    result: null,
  })
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByRole('alert')).toContainText('Не получилось оценить ни одной заявки')
  await expect(page.getByText('Решения не изменились')).toHaveCount(0)
})

test('FR-ACC-5: a done run with no scored lead says so too', async ({ page }) => {
  await stubRuns(page, {
    ...doneRun,
    result: { ...doneRun.result, checked: 0, skipped: 2, changed: 0, items: [] },
  })
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(page.getByText('Не получилось оценить ни одной заявки')).toBeVisible()
  await expect(page.getByText('Решения не изменились')).toHaveCount(0)
})

test('FR-ACC-5: no Claude token and a dead run each have their own words', async ({ page }) => {
  await stubRuns(page, { ...doneRun, state: 'stopped', stop_reason: 'not_connected', result: null })
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await expect(
    page.getByText('Claude не подключён: вставь токен в мастере настройки.'),
  ).toBeVisible()
  await page.unroute(`${RUNS}/${RUN_ID}`)
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({ json: { ...doneRun, state: 'failed', stop_reason: 'stale', result: null } }),
  )
  await page.reload()
  await expect(page.getByText('Проверка зависла и закрыта. Запусти заново.')).toBeVisible()
})

test('FR-ACC-5: a run id that does not exist is dropped with a plain message, and the button is free', async ({
  page,
}) => {
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({ status: 404, json: { error: 'Такой проверки нет.' } }),
  )
  await page.goto(`${RECOMPUTE}?run=${RUN_ID}`)
  await expect(page.getByText('Такой проверки нет.')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }),
  ).toBeEnabled()
  expect(page.url()).not.toContain('run=')
})

test('FR-ACC-5: the changed lead shows the axes by their names and the old result goes when other rules are chosen', async ({
  page,
}) => {
  await stubRuns(page, doneRun)
  await page.goto(RECOMPUTE)
  await page.getByRole('button', { name: 'Пересчитать на последних 50 заявках' }).click()
  await page.getByText('Почему так').click()
  await expect(page.getByText('Качество клиента: 30, Мелкий клиент')).toBeVisible()
  await page.getByLabel('Какие правила попробовать').selectOption({ index: 1 })
  await expect(page.getByText('Заявка про сайт')).toHaveCount(0)
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

const CALIBRATION = `${DIRECTION}/calibration`
const CAL_ITEMS = Array.from({ length: 20 }, (_, i) => ({
  leadId: `c${i + 1}`,
  title: `Заявка ${i + 1}`,
  city: 'Москва',
  budget: i % 2 === 0 ? 'до 50 000 ₽' : null,
  text: `Описание заявки ${i + 1}`,
  mark: null as string | null,
}))
const MISS = {
  leadId: 'c3',
  title: 'Сайт для клиники',
  city: 'Москва',
  text: 'Нужен сайт с записью онлайн',
  kind: 'sara_no_boris_yes',
  score: 41,
  reason: 'Бюджет не назван',
  axes: AXES,
  stopFactor: null,
  redFlags: [],
  note: null,
}
const calResult = {
  decisive: 20,
  unsure: 0,
  agreement: 0.7,
  reliable: true,
  passed: false,
  threshold: 56,
  misses: [
    MISS,
    { ...MISS, leadId: 'c4', title: 'Лишняя заявка', kind: 'sara_yes_boris_no', score: 66 },
  ],
  thresholdHint: { from: 56, to: 48, before: 0.7, after: 0.9 },
}
/** A calibration run as the API tells it. */
const calRun = (state: string, over: object = {}) => ({
  id: RUN_ID,
  kind: 'calibration',
  state,
  total: 20,
  done: 0,
  skipped: 0,
  stop_reason: null,
  result: null,
  calibration: { marked: 0, items: [], result: null, advice: null, stale: false },
  ...over,
})

test('FR-ACC-4: Boris marks 20 real leads one by one, sees no score, and then the agreement', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto(`${DIRECTION}`)
  await page.getByRole('link', { name: 'Проверить Сару на моих решениях' }).click()
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  for (let i = 1; i <= 20; i++) {
    await expect(page.getByText(`${i - 1} из 20`)).toBeVisible()
    await expect(page.getByText('Балл Сары')).toHaveCount(0)
    await page.getByRole('button', { name: 'Взяли бы' }).click()
  }
  await expect(page.getByText('Согласие: 100% (20 из 20)')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('Цель 85% достигнута')).toBeVisible()
})

test('FR-ACC-4: the keys 1, 2 and 3 mark and "Назад" lets him change a mark', async ({ page }) => {
  await page.route(RUNS, (route) => route.fulfill({ status: 201, json: { id: RUN_ID, total: 20 } }))
  const items = CAL_ITEMS.map((i) => ({ ...i }))
  let marks = 0
  await page.route(`${RUNS}/${RUN_ID}/marks`, (route) => {
    const body = route.request().postDataJSON() as { lead_id: string; mark: string }
    const it = items.find((x) => x.leadId === body.lead_id)
    if (it) {
      if (it.mark === null) marks++
      it.mark = body.mark
    }
    return route.fulfill({ json: { ok: true, marked: marks, total: 20, complete: false } })
  })
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({
      json: calRun('marking', {
        calibration: { marked: marks, items, result: null, advice: null, stale: false },
      }),
    }),
  )
  await page.goto(CALIBRATION)
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  await expect(page.getByRole('heading', { name: 'Заявка 1' })).toBeVisible()
  await page.keyboard.press('2')
  await expect(page.getByRole('heading', { name: 'Заявка 2' })).toBeVisible()
  await page.keyboard.press('3')
  await expect(page.getByRole('heading', { name: 'Заявка 3' })).toBeVisible()
  await page.getByRole('button', { name: 'Назад' }).click()
  await expect(page.getByRole('heading', { name: 'Заявка 2' })).toBeVisible()
  await expect(page.getByText('Ты уже отмечал эту заявку, ответ можно поменять.')).toBeVisible()
  await page.keyboard.press('1')
  expect(items.map((i) => i.mark).slice(0, 3)).toEqual(['no', 'yes', null])
})

test('FR-ACC-4: the result shows the misses with "Почему так", the threshold hint, a note and an advice', async ({
  page,
}) => {
  let applied = 0
  await page.route(RUNS, (route) => route.fulfill({ status: 201, json: { id: RUN_ID, total: 20 } }))
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({
      json: calRun('done', {
        done: 20,
        calibration: { marked: 20, items: [], result: calResult, advice: null, stale: false },
      }),
    }),
  )
  await page.route(`${RUNS}/${RUN_ID}/notes`, (route) => route.fulfill({ json: { ok: true } }))
  await page.route(`${RUNS}/${RUN_ID}/advice`, (route) =>
    route.fulfill({
      json: {
        advice: {
          summary: 'Порог ниже: 50 вместо 56',
          why: 'Ты брал такие заявки',
          lines: ['Порог: 56 → 50'],
        },
      },
    }),
  )
  await page.route(`${RUNS}/${RUN_ID}/apply`, (route) => {
    applied++
    return route.fulfill({ json: { id: RUN_ID } })
  })
  await page.goto(CALIBRATION)
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  await expect(page.getByText('Согласие: 70% (14 из 20)')).toBeVisible()
  await expect(page.getByText('Цель 85% не достигнута.')).toBeVisible()
  await expect(page.getByText('Порог 56 → 48: согласие было 70%, стало бы 90%.')).toBeVisible()
  await expect(page.getByText('Сара отсеяла, а ты взял бы')).toBeVisible()
  await expect(page.getByText('Сара показала бы, а ты нет')).toBeVisible()
  const first = page.getByRole('list', { name: 'Заявки, которые Сара отсеяла, а ты взял бы' })
  await first.getByText('Почему так').click()
  await expect(first.getByText('Бюджет не назван')).toBeVisible()
  await expect(first.getByText('Качество клиента: 30, Мелкий клиент')).toBeVisible()
  await first.getByLabel('Почему ты так решил? (необязательно)').fill('нормальный бюджет')
  await first.getByRole('button', { name: 'Записать причину' }).click()
  await expect(first.getByText('Записано')).toBeVisible()
  await page.getByRole('button', { name: 'Предложить поправку' }).click()
  await expect(page.getByText('Порог ниже: 50 вместо 56')).toBeVisible()
  await expect(page.getByText('Порог: 56 → 50')).toBeVisible()
  await page.getByRole('button', { name: 'Применить к черновику' }).last().click()
  await expect.poll(() => applied).toBe(1)
})

test('FR-ACC-4: "не знаю" makes the check unreliable, and a stale one offers to repeat', async ({
  page,
}) => {
  await page.route(RUNS, (route) => route.fulfill({ status: 201, json: { id: RUN_ID, total: 20 } }))
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({
      json: calRun('done', {
        done: 20,
        calibration: {
          marked: 20,
          items: [],
          result: {
            ...calResult,
            decisive: 12,
            unsure: 8,
            agreement: 1,
            reliable: false,
            misses: [],
            thresholdHint: null,
          },
          advice: null,
          stale: true,
        },
      }),
    }),
  )
  await page.goto(CALIBRATION)
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  await expect(page.getByText('Слишком много «не знаю»')).toBeVisible()
  await expect(page.getByText('Цель 85% достигнута')).toHaveCount(0)
  await expect(page.getByText('Правила изменились после этой проверки.')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Проверить заново на тех же заявках' }),
  ).toBeVisible()
})

test('FR-ACC-4: too few leads and the Claude limit say so in plain words', async ({ page }) => {
  await page.route(RUNS, (route) =>
    route.fulfill({ status: 409, json: { error: 'Заявок пока мало: 4, нужно хотя бы 10.' } }),
  )
  await page.goto(CALIBRATION)
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  await expect(page.getByRole('alert')).toHaveText('Заявок пока мало: 4, нужно хотя бы 10.')
  await page.unroute(RUNS)
  await page.route(RUNS, (route) => route.fulfill({ status: 201, json: { id: RUN_ID, total: 20 } }))
  await page.route(`${RUNS}/${RUN_ID}`, (route) =>
    route.fulfill({ json: calRun('stopped', { stop_reason: 'limit' }) }),
  )
  await page.getByRole('button', { name: 'Начать проверку' }).click()
  await expect(page.getByText('Подожди, лимит Claude кончился. Попробуй позже.')).toBeVisible()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`FR-UI-3: the calibration screens fit 360 px in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 360, height: 740 })
    await page.route(RUNS, (route) =>
      route.fulfill({ status: 201, json: { id: RUN_ID, total: 20 } }),
    )
    let state = 'marking'
    await page.route(`${RUNS}/${RUN_ID}`, (route) =>
      route.fulfill({
        json:
          state === 'marking'
            ? calRun('marking', {
                calibration: {
                  marked: 0,
                  items: CAL_ITEMS,
                  result: null,
                  advice: null,
                  stale: false,
                },
              })
            : calRun('done', {
                done: 20,
                calibration: {
                  marked: 20,
                  items: [],
                  result: calResult,
                  advice: null,
                  stale: false,
                },
              }),
      }),
    )
    await page.goto(CALIBRATION)
    await page.getByRole('button', { name: 'Начать проверку' }).click()
    await expect(page.getByRole('heading', { name: 'Заявка 1' })).toBeVisible()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    // The mark buttons are thumb-sized.
    for (const b of await page.getByRole('button', { name: /Взяли бы|Нет|Не знаю/ }).all())
      expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    state = 'done'
    // The run is in the address, so a reload goes straight back to it.
    await page.reload()
    await expect(page.getByText('Согласие: 70% (14 из 20)')).toBeVisible()
    await page.getByText('Почему так').first().click()
    expect(await overflowOf(page)).toBeLessThanOrEqual(0)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe(scheme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(250, 249, 247)')
  })
}

test('FR-ACC-3: step 4 shows the calibration of the draft and step 8 turns a new direction on or into the shadow', async ({
  page,
}) => {
  const view = (over: object) => ({
    onboarding: {
      mode: 'edit',
      basedOn: 1,
      step: 4,
      steps: {},
      rules: { about: 'x' },
      changes: ['Порог: 56 → 50'],
      changed: true,
      calibration: null,
      directionState: 'draft',
      ...over,
    },
  })
  const passed = {
    runId: RUN_ID,
    state: 'done',
    agreement: 0.9,
    decisive: 20,
    passed: true,
    reliable: true,
  }
  const current = view({ calibration: passed })
  await page.route(`**/api/directions/${ACCOUNT}/onboarding`, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: current }) : route.continue(),
  )
  let finished: unknown = null
  await page.route(`**/api/directions/${ACCOUNT}/onboarding/finish`, (route) => {
    finished = route.request().postDataJSON()
    return route.fulfill({ json: { version: 7 } })
  })
  await page.goto(ONBOARDING)
  await expect(page.getByRole('heading', { name: 'Шаг 4. Калибровка' })).toBeVisible()
  await expect(page.getByText('Согласие на этих правилах: 90%. Цель достигнута.')).toBeVisible()
  await page.getByRole('button', { name: 'К включению' }).click()
  await expect(
    page.getByText('Калибровка на этих правилах: согласие 90%, цель достигнута.'),
  ).toBeVisible()
  await expect(page.getByLabel('Зачем сохраняешь без проверки?')).toHaveCount(0)
  await page.getByRole('button', { name: 'Включить в тени' }).click()
  await expect(page.getByText('Правила сохранены: v7')).toBeVisible()
  expect(finished).toEqual({ state: 'shadow' })
})

test('FR-ACC-3: below the target step 8 saves only with a reason and says the agreement', async ({
  page,
}) => {
  const weak = {
    runId: RUN_ID,
    state: 'done',
    agreement: 0.8,
    decisive: 20,
    passed: false,
    reliable: true,
  }
  await page.route(`**/api/directions/${ACCOUNT}/onboarding`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            onboarding: {
              mode: 'edit',
              basedOn: 1,
              step: 4,
              steps: {},
              rules: { about: 'x' },
              changes: ['Порог: 56 → 50'],
              changed: true,
              calibration: weak,
              directionState: 'on',
            },
          },
        })
      : route.continue(),
  )
  await page.goto(ONBOARDING)
  await page.getByRole('button', { name: 'К включению' }).click()
  await expect(
    page.getByText('Калибровка на этих правилах: согласие 80%, цель 85% не достигнута.'),
  ).toBeVisible()
  const save = page.getByRole('button', { name: 'Сохранить всё равно (согласие 80%)' })
  await expect(save).toBeDisabled()
  await page.getByLabel('Зачем сохраняешь без проверки?').fill('Нужно срочно')
  await expect(save).toBeEnabled()
})

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
  await expect(page.getByRole('heading', { name: 'Шаг 4. Калибровка' })).toBeVisible()
  await expect(page.getByText('На этих правилах Сару ещё не проверяли.')).toBeVisible()
  await page.getByRole('button', { name: 'К включению' }).click()
  await expect(page.getByRole('heading', { name: 'Шаг 8. Включение' })).toBeVisible()
  await expect(page.getByText('Порог: 56 → 55')).toBeVisible()
  await expect(page.getByText('Калибровки на этих правилах ещё не было.')).toBeVisible()
  const save = page.getByRole('button', { name: 'Сохранить всё равно (без проверки)' })
  await expect(save).toBeDisabled()
  await page.getByLabel('Зачем сохраняешь без проверки?').fill('Проверю позже на заявках')
  await save.click()
  await expect(page.getByText(/^Правила сохранены: v\d+$/)).toBeVisible()
  await page.getByRole('link', { name: 'К направлению' }).click()
  await expect(page.getByText('Порог: 55')).toBeVisible()
})
