import type { Page } from 'playwright'

export type ScreenInput =
  | { t: 'click'; x: number; y: number }
  | { t: 'scroll'; dy: number }
  | { t: 'key'; key: string }
  | { t: 'text'; text: string }

/** Streams the tab as JPEG frames over CDP (ADR-023). Returns the stop function. */
export async function startLiveScreen(
  page: Page,
  onFrame: (jpegBase64: string, w: number, h: number) => void,
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', (f) => {
    onFrame(f.data, f.metadata.deviceWidth, f.metadata.deviceHeight)
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 2 })
  // Screencast frames come only on repaints; a still page gets one picture right away.
  const vp = page.viewportSize() ?? { width: 1280, height: 800 }
  const shot = await cdp
    .send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
    .catch(() => null)
  if (shot) onFrame(shot.data, vp.width, vp.height)
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => {})
    await cdp.detach().catch(() => {})
  }
}

/** Boris's taps and keys on the live screen. Coordinates are fractions 0..1 of the frame. */
export async function applyInput(page: Page, i: ScreenInput): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 }
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  switch (i.t) {
    case 'click':
      return page.mouse.click(clamp(i.x) * vp.width, clamp(i.y) * vp.height)
    case 'scroll':
      return page.mouse.wheel(0, i.dy)
    case 'key':
      return page.keyboard.press(i.key)
    case 'text':
      // Typed like a person; never stored or logged (passwords and SMS codes pass here).
      return page.keyboard.type(i.text, { delay: 40 })
  }
}
