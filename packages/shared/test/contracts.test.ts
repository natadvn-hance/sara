import { describe, expect, it } from 'vitest'
import {
  EventEnvelope,
  formatCallback,
  MindFrontmatter,
  newEventId,
  PROFI_TOOLS,
  parseCallback,
  SETTINGS,
  SorterOutput,
} from '../src/index'

const sampleLeadFound = {
  id: '0192f3c4-5b6a-7c8d-9e0f-112233445566',
  type: 'lead.found',
  v: 1,
  entity: { kind: 'lead', id: '95147898' },
  account_id: 'hance-marketing',
  actor: 'sara',
  occurred_at: '2026-10-22T10:00:00.000Z',
  causation_id: null,
  correlation_id: '0192f3c4-5b6a-7c8d-9e0f-112233445567',
  reason: null,
  payload: { title: 'Сайт для клиники' },
}

const validRecord = {
  id: 'price-basic',
  type: 'knowledge',
  scope: 'shared',
  status: 'confirmed',
  version: 1,
  sources: ['interview:2026-11-01'],
  valid_from: '2026-11-01',
  valid_to: null,
}

describe('contracts', () => {
  it('C1: envelope accepts a valid lead.found event', () => {
    expect(EventEnvelope.safeParse(sampleLeadFound).success).toBe(true)
  })

  it('C1: envelope rejects unknown type and missing correlation_id', () => {
    expect(EventEnvelope.safeParse({ ...sampleLeadFound, type: 'lead.unknown' }).success).toBe(
      false,
    )
    expect(EventEnvelope.safeParse({ ...sampleLeadFound, correlation_id: undefined }).success).toBe(
      false,
    )
  })

  it('C1: newEventId returns time-ordered uuid v7', () => {
    const a = newEventId()
    const b = newEventId()
    expect(a < b).toBe(true)
    expect(a[14]).toBe('7')
  })

  it('C5: callback round-trips and stays within 64 bytes', () => {
    const id = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
    const data = formatCallback(id, 'bid')
    expect(data).toBe(`t:${id}:bid`)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseCallback(data)).toEqual({ taskId: id, action: 'bid' })
    expect(parseCallback('t:x:fly')).toBeNull()
  })

  it('FR-LEAD-7: the «Разбор» action of a lead card is a task action and fits a callback', () => {
    const id = '0192f3c4-5b6a-7c8d-9e0f-112233445566'
    const data = formatCallback(id, 'razbor')
    expect(data).toBe(`t:${id}:razbor`)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseCallback(data)).toEqual({ taskId: id, action: 'razbor' })
  })

  it('C5: callback longer than 64 bytes is refused', () => {
    expect(() => formatCallback('x'.repeat(70), 'bid')).toThrow()
  })

  it('C2: submit_bid input requires idempotency_key and permit', () => {
    const input = PROFI_TOOLS['profi.submit_bid'].input
    expect(input.safeParse({ account_id: 'a', order_id: '1', text: 't' }).success).toBe(false)
    expect(
      input.safeParse({
        account_id: 'a',
        order_id: '1',
        text: 't',
        idempotency_key: 'bid:1',
        permit: 'p',
      }).success,
    ).toBe(true)
  })

  it('C3: sorter output limits reason length and verdict values', () => {
    expect(
      SorterOutput.safeParse({ verdict: 'yes', reason: 'x', tags: [], confidence: 1 }).success,
    ).toBe(false)
    expect(
      SorterOutput.safeParse({ verdict: 'fit', reason: 'x'.repeat(201), tags: [], confidence: 1 })
        .success,
    ).toBe(false)
  })

  it('C6: mind frontmatter rejects empty sources', () => {
    expect(MindFrontmatter.safeParse(validRecord).success).toBe(true)
    expect(MindFrontmatter.safeParse({ ...validRecord, sources: [] }).success).toBe(false)
  })

  it('C7: outbound bids are off by default', () => {
    expect(SETTINGS['outbound.bids'].default).toBe(false)
    expect(SETTINGS['reminder.decision_after_min'].default).toBe(30)
  })
})
