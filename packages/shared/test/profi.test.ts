import { describe, expect, it } from 'vitest'
import { ChatMessage, EVENT_TYPES, PROFI_EVENT_PAYLOADS, PROFI_TOOLS, SETTINGS } from '../src'

const msg = {
  platform_message_id: 'm1',
  chat_id: 'c1',
  author: 'client',
  sent_at: '2026-10-23T08:00:00.000Z',
  text: 'Добрый день',
  read: false,
}
const ref = {
  chat_id: 'c1',
  order_id: '95147898',
  platform_message_id: 'm1',
  sent_at: '2026-10-23T08:00:00.000Z',
  author: 'client',
}

describe('C2 for M1', () => {
  it('C2: read tools are listed with their schemas', () => {
    expect(Object.keys(PROFI_TOOLS).sort()).toEqual([
      'profi.get_order',
      'profi.list_chats',
      'profi.list_feed',
      'profi.read_chat',
      'profi.send_message',
      'profi.session_health',
      'profi.submit_bid',
    ])
  })

  it('FR-CONV-2: a message without a known author is refused', () => {
    expect(ChatMessage.safeParse(msg).success).toBe(true)
    expect(ChatMessage.safeParse({ ...msg, author: 'boris' }).success).toBe(false)
  })

  it('ADR-022: client_message payload carries no text', () => {
    const p = PROFI_EVENT_PAYLOADS['profi.client_message']
    expect(p.safeParse(ref).success).toBe(true)
    expect(p.safeParse({ ...ref, text: 'привет' }).success).toBe(false)
  })

  it('C2: every Profi event payload type is a known journal event type', () => {
    for (const t of Object.keys(PROFI_EVENT_PAYLOADS)) expect(EVENT_TYPES).toContain(t)
  })

  it('ST-M1-11: in shadow, leads are not sent as cards by default', () => {
    expect(SETTINGS['pipeline.leads'].default).toBe(false)
  })
})
