import type { Page } from 'playwright'
import { BUBBLE } from './pageShape'

// The message box of a chat page as old Sara found it (src/negotiator/openChat.js, checked live September-October
// 2026): the field is textarea[placeholder="Сообщение"], and its send button is the last button of the field's third
// ancestor div (it morphs between a microphone and a send icon with the text in the field). Sending uses these two
// (src/chat/sendTools.ts); the map below shows what the page really has, without pressing or typing anything.
export const CHAT_INPUT = 'textarea[placeholder="Сообщение"]'
export const CHAT_SEND_PATH = 'xpath=ancestor::div[3]//button[last()]'

/** The address of a chat page without the chat's number: a map says nothing about whose chat it was. */
export function anonymousChatUrl(url: string): string {
  const at = new URL(url)
  if (at.searchParams.has('id')) at.searchParams.set('id', '0')
  return at.toString()
}

export type ChatBox = { tag: string; classes: string[]; testid: string | null }
export type ChatButton = {
  /** Position among the buttons of the box, in page order. */
  index: number
  /** The last button among its siblings: what old Sara's path takes. */
  lastOfParent: boolean
  tag: string
  type: string | null
  aria: string | null
  testid: string | null
  classes: string[]
  /** The button's own short words; icons have none. */
  text: string
  /** Pictures inside (an icon button has one). */
  icons: number
  visible: boolean
  disabled: boolean
}
export type ChatField = {
  tag: 'input' | 'textarea' | 'editable'
  type: string | null
  name: string | null
  testid: string | null
  aria: string | null
  placeholder: string | null
  /** A file field: what it takes. */
  accept: string | null
  multiple: boolean
  maxLength: number | null
  visible: boolean
  disabled: boolean
  inBox: boolean
}
export type ChatAttachControl = {
  tag: string
  type: string | null
  testid: string | null
  aria: string | null
  classes: string[]
  accept: string | null
  inBox: boolean
}

/** What the chat page's message box is made of, for calibrating sending (M4). Never a message, never what is typed. */
export type ChatFormMap = {
  what: 'chat_form'
  /** Visible fields old Sara's selector finds: one is what sending needs. */
  oldInput: number
  /** Buttons old Sara's path takes from that field: one is what sending needs. */
  oldSend: number
  /** The field's ancestors, nearest first. */
  chain: ChatBox[]
  /** The third ancestor div of the field: the box old Sara took her buttons from. */
  box: ChatBox | null
  buttons: ChatButton[]
  fields: ChatField[]
  attachments: ChatAttachControl[]
  testids: string[]
}

/**
 * Maps the message box of the open chat page without touching it: no click, no key, no value of any field, and
 * nothing inside a message bubble (a bubble is the only place a client's words live). Null when the page has no field
 * to write in (not loaded yet, a closed chat): the caller tries again on the next chat.
 */
export async function readChatFormMap(page: Page): Promise<ChatFormMap | null> {
  return page
    .evaluate(
      ({ bubble, inputCss, sendPath }) => {
        // A long number (an order or chat number in a test id, a label or a class) says whose chat it was: it becomes 0.
        const scrub = (s: string) => s.replace(/\d{5,}/g, '0')
        const clip = (s: string | null | undefined, n: number) => {
          const t = scrub((s ?? '').replace(/\s+/g, ' ').trim())
          return t === '' ? null : t.slice(0, n)
        }
        const shown = (el: Element) =>
          el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          el.getBoundingClientRect().width > 0
        const attr = (el: Element, a: string) => clip(el.getAttribute(a), 80)
        const inBubble = (el: Element) => !!el.closest(bubble)
        const classesOf = (el: Element) => [...el.classList].slice(0, 8).map(scrub)
        const boxOf = (el: Element) => ({
          tag: el.tagName.toLowerCase(),
          classes: classesOf(el),
          testid: attr(el, 'data-testid'),
        })

        const FIELD = 'input, textarea, select, [contenteditable="true"], [role="textbox"]'
        const all = [...document.querySelectorAll(FIELD)].filter((el) => !inBubble(el))
        // A place to write: a textarea or an editable element (not a plain input, which may be a file or a checkbox).
        const writers = all.filter((el) => {
          const t = el.tagName.toLowerCase()
          return t !== 'input' && t !== 'select'
        })
        const old = [...document.querySelectorAll(inputCss)].filter((el) => shown(el))
        // The field sending would use: old Sara's, or else the first visible place to write.
        const field = old[0] ?? writers.find((el) => shown(el)) ?? writers[0] ?? null
        if (!field) return null

        const chain: ReturnType<typeof boxOf>[] = []
        for (let el = field.parentElement; el && chain.length < 6; el = el.parentElement)
          if (el !== document.body && el !== document.documentElement) chain.push(boxOf(el))
        // ancestor::div[3]: the third div going up from the field.
        let box: Element | null = null
        let divs = 0
        for (let el = field.parentElement; el; el = el.parentElement) {
          if (el.tagName === 'DIV' && ++divs === 3) {
            box = el
            break
          }
        }

        let oldSend = 0
        try {
          oldSend = old[0]
            ? document.evaluate(
                sendPath.replace(/^xpath=/, ''),
                old[0],
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
              ).snapshotLength
            : 0
        } catch {}

        const BUTTON = 'button, [role="button"], input[type="submit"], input[type="button"]'
        const buttons = box
          ? [...box.querySelectorAll(BUTTON)]
              .filter((el) => !inBubble(el))
              .slice(0, 20)
              .map((el, index) => {
                const sibs = el.parentElement
                  ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName)
                  : []
                return {
                  index,
                  lastOfParent: sibs.length > 0 && sibs[sibs.length - 1] === el,
                  tag: el.tagName.toLowerCase(),
                  type: attr(el, 'type'),
                  aria: attr(el, 'aria-label'),
                  testid: attr(el, 'data-testid'),
                  classes: classesOf(el),
                  text:
                    clip(
                      el.tagName === 'INPUT'
                        ? (el as HTMLInputElement).value
                        : (el as HTMLElement).innerText,
                      30,
                    ) ?? '',
                  icons: el.querySelectorAll('svg, img').length,
                  visible: shown(el),
                  disabled:
                    (el as HTMLButtonElement).disabled === true ||
                    el.getAttribute('aria-disabled') === 'true',
                }
              })
          : []

        const fields = all.slice(0, 30).map((el) => {
          const tag = el.tagName.toLowerCase()
          const f = el as HTMLInputElement
          const max = f.maxLength
          return {
            tag: (tag === 'input' || tag === 'textarea' ? tag : 'editable') as
              | 'input'
              | 'textarea'
              | 'editable',
            type: tag === 'input' ? f.type : attr(el, 'type'),
            name: attr(el, 'name'),
            testid: attr(el, 'data-testid'),
            aria: attr(el, 'aria-label'),
            placeholder: attr(el, 'placeholder'),
            accept: attr(el, 'accept'),
            multiple: tag === 'input' && f.multiple === true,
            maxLength: typeof max === 'number' && max > 0 ? max : null,
            visible: shown(el),
            disabled: f.disabled === true || el.getAttribute('aria-disabled') === 'true',
            inBox: !!box && box.contains(el),
          }
        })

        // What attaches a file: a file field anywhere outside the bubbles, or a control of the box that names it so.
        const WORDS = /(прикреп|вложен|файл|скреп|фото|attach|clip|upload|file|photo)/i
        const attachments = [...document.querySelectorAll(`${FIELD}, ${BUTTON}`)]
          .filter((el) => !inBubble(el))
          .filter((el) => {
            const inBox = !!box && box.contains(el)
            const named = [
              el.getAttribute('aria-label'),
              el.getAttribute('data-testid'),
              [...el.classList].join(' '),
            ].join(' ')
            return (
              (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') ||
              (inBox && WORDS.test(named))
            )
          })
          .slice(0, 10)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: attr(el, 'type'),
            testid: attr(el, 'data-testid'),
            aria: attr(el, 'aria-label'),
            classes: classesOf(el),
            accept: attr(el, 'accept'),
            inBox: !!box && box.contains(el),
          }))

        const testids = [
          ...new Set(
            [...document.querySelectorAll('[data-testid]')]
              .filter((el) => !inBubble(el))
              .map((el) => scrub(el.getAttribute('data-testid') ?? '')),
          ),
        ]
          .filter(Boolean)
          .slice(0, 100)

        return {
          what: 'chat_form' as const,
          oldInput: old.length,
          oldSend,
          chain,
          box: box ? boxOf(box) : null,
          buttons,
          fields,
          attachments,
          testids,
        }
      },
      { bubble: BUBBLE, inputCss: CHAT_INPUT, sendPath: CHAT_SEND_PATH },
    )
    .catch(() => null)
}
