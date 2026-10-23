import type { Page } from 'playwright'
import type { ProfiSite } from '../../../../tests/fakes/profiSite/server'

/** Logs the tab in to the stand-in site the way Boris would. */
export async function loginStandIn(page: Page, site: ProfiSite): Promise<void> {
  await page.goto(`${site.url}/login`)
  await page.fill('#phone', '+79000000001')
  await page.click('#send-phone')
  await page.fill('#code', site.code)
  await page.click('#send-code')
  await page.waitForURL(/backoffice/)
}
