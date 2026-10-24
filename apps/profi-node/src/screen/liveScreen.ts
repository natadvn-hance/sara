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
  // Chromium sends up to ~25 frames a second (about 1 MB/s): far too much for Boris's connection from
  // Russia, where the picture then froze. Only the newest frame is kept and sent at most every 350 ms.
  let latest: { data: string; w: number; h: number } | null = null
  let sent: string | null = null
  let sentAt = Date.now()
  cdp.on('Page.screencastFrame', (f) => {
    latest = { data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight }
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  const timer = setInterval(() => {
    // Unchanged pictures are resent every 2 s, so a picture skipped on a slow link is replaced soon.
    if (latest && (latest.data !== sent || Date.now() - sentAt >= 2000)) {
      sent = latest.data
      sentAt = Date.now()
      onFrame(latest.data, latest.w, latest.h)
    }
  }, 350)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, everyNthFrame: 3 })
  // Screencast frames come only on repaints; a still page gets one picture right away.
  const vp = page.viewportSize() ?? { width: 1280, height: 800 }
  const shot = await cdp
    .send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })
    .catch(() => null)
  if (shot) {
    latest ??= { data: shot.data, w: vp.width, h: vp.height }
    sent = shot.data
    sentAt = Date.now()
    onFrame(shot.data, vp.width, vp.height)
  }
  return async () => {
    clearInterval(timer)
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
