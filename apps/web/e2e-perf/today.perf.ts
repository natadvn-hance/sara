import { expect, test } from '@playwright/test'
import { SESSION_STATE, signIn } from '../e2e/session'

test.use({ storageState: SESSION_STATE })
test.beforeAll(async ({ playwright }) => signIn(playwright))

test('NFR-PERF-2: Today shows its first screen within 2 seconds on a slow phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  // «Fast 4G»: 150 ms there and back, 1.6 Mbit/s down, 750 kbit/s up; the phone's processor 4 times slower.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 200_000,
    uploadThroughput: 93_750,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const times: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await page.goto('/', { waitUntil: 'commit' })
    await expect(page.getByRole('heading', { level: 1, name: 'Сегодня' })).toBeVisible({
      timeout: 10_000,
    })
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[1] ?? Number.POSITIVE_INFINITY
  console.log(`Сегодня на медленном телефоне: ${times.map((t) => Math.round(t)).join(', ')} мс`)
  expect(median).toBeLessThan(2000)
})
