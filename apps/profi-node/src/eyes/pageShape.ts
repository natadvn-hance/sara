import type { Page } from 'playwright'

// What a page of the real site is built of, never what it says: the chats list and the chat pages are drawn without
// a JSON answer, so their readers are calibrated on these records (ST-M1-04, ADR-022). Numbers sit under «id» keys,
// where `pnpm profi:samples` renames them the same way throughout a sample.

/** One element: its tag, classes, data-* attributes and, for a short number or time shown alone, that badge. */
export type ShapeNode = {
  depth: number
  tag: string
  classes: string[]
  data: ({ attr: string; id: string } | { attr: string; value?: string })[]
  badge?: string
}

/** One chat bubble: its number, classes, the elements inside it and its HH:MM time. */
export type BubbleShape = { id: string; classes: string[]; parts: string[]; time: string | null }

export const BUBBLE = '[data-message-content-id]'

/** The page's elements in document order, the first `limit` that have a class, a data attribute or a badge. */
export function pageShape(page: Page, limit = 300): Promise<ShapeNode[]> {
  // A loop, not a named inner function: tsx (how the service runs) wraps those in a helper the page does not have.
  return page.evaluate((max) => {
    // An unread count or «12:30»: how a list marks news, and nothing personal.
    const BADGE = /^(\d{1,3}|\d{1,2}:\d{2})$/
    const out: ShapeNode[] = []
    const stack: [Element, number][] = [[document.body, 0]]
    while (out.length < max) {
      const next = stack.pop()
      if (!next) break
      const [el, depth] = next
      const tag = el.tagName.toLowerCase()
      if (['script', 'style', 'noscript', 'svg'].includes(tag)) continue
      const data = [...el.attributes]
        .filter((a) => a.name.startsWith('data-'))
        .map((a) =>
          /^\d{1,20}$/.test(a.value)
            ? { attr: a.name, id: a.value }
            : // A plain lowercase token («chat-item», «unread»); any other value (a name, a date) is left out.
              /^[a-z][a-z0-9_-]{0,30}$/.test(a.value)
              ? { attr: a.name, value: a.value }
              : { attr: a.name },
        )
      const leaf = el.children.length === 0 ? (el.textContent ?? '').trim() : ''
      const node: ShapeNode = { depth, tag, classes: [...el.classList], data }
      if (BADGE.test(leaf)) node.badge = leaf
      if (node.classes.length > 0 || data.length > 0 || node.badge) out.push(node)
      // Pushed last child first, so the page is read in document order.
      for (const c of [...el.children].reverse()) stack.push([c, depth + 1])
    }
    return out
  }, limit)
}

/** The bubbles of a chat page, without their text. */
export function bubbleShapes(page: Page): Promise<BubbleShape[]> {
  return page.locator(BUBBLE).evaluateAll((els) =>
    els.map((el) => {
      const parts = new Set<string>()
      let time: string | null = null
      for (const d of el.querySelectorAll('*')) {
        if (parts.size < 20) parts.add([d.tagName.toLowerCase(), ...d.classList].join('.'))
        const t = d.children.length === 0 ? (d.textContent ?? '').trim() : ''
        if (time === null && /^\d{1,2}:\d{2}$/.test(t)) time = t
      }
      return {
        id: el.getAttribute('data-message-content-id') ?? '',
        classes: [...el.classList],
        parts: [...parts],
        time,
      }
    }),
  )
}
